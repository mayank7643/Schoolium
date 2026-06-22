-- ============================================================
-- SECTION 1: MIGRATION NAME
-- ============================================================
-- File: SQL/20260622_whatsapp_system_final.sql
-- Session: Chat 10 — WhatsApp Alert System
-- Generated: 22 June 2026
-- Author: Schoolium
--
-- Paste into a new Claude session to continue seamlessly.
-- ============================================================


-- ============================================================
-- SECTION 2: SUMMARY OF CHANGES INCLUDED
-- ============================================================
--
-- 1. students         → ADD COLUMN parent_phone_opted_out
-- 2. schools          → ADD COLUMN wa_monthly_quota
--                     → ADD COLUMN wa_messages_sent_month
--                     → ADD COLUMN wa_quota_reset_date
--                     → ADD COLUMN wa_alerts_enabled (feature gate)
--                     → ADD COLUMN plan (subscription tier)
-- 3. wa_message_log   → NEW TABLE (dedup + audit trail)
--                     → UNIQUE CONSTRAINT (school_id, student_id, log_date, message_type)
--                     → INDEXES (retry, school+date, student)
--                     → RLS POLICY (school_admin read own school only)
--                     → TRIGGER (updated_at auto-update)
-- 4. set_updated_at() → NEW FUNCTION (trigger helper)
-- 5. increment_wa_sent_count() → NEW SECURITY DEFINER FUNCTION
-- 6. pg_cron          → reset-wa-monthly-quota (00:00 IST, 1st of month)
-- 7. pg_cron          → retry-wa-messages (every 5 minutes)
--
-- ============================================================


-- ============================================================
-- SECTION 3: CONFLICTS FOUND AND REMOVED
-- ============================================================
--
-- REMOVED: whatsapp_notifications_log (early draft table)
--   → Superseded by wa_message_log with richer schema
--   → wa_message_log adds: attempt_count, next_retry_at,
--     template_name, updated_at, richer status enum
--   → Already confirmed wa_message_log is what was run on production
--
-- REMOVED: Early notify-attendance/index.ts freeform text version
--   → Superseded by template message version
--   → Not SQL — documented here for completeness only
--
-- REMOVED: pg_cron block from original whatsapp_setup.sql
--   → User ran migration without pg_cron block (extension not yet enabled)
--   → pg_cron was enabled separately; jobs added separately
--   → Both cron jobs included here in correct final form
--
-- REMOVED: Duplicate wa_monthly_quota column attempt
--   → ADD COLUMN IF NOT EXISTS used throughout — safe to re-run
--
-- KEPT: set_updated_at() as CREATE OR REPLACE
--   → Generic trigger function; safe even if already exists
--   → Scoped only to wa_message_log trigger in this migration
--
-- ============================================================


-- ============================================================
-- SECTION 4: POTENTIAL RISKS
-- ============================================================
--
-- RISK 1: pg_cron jobs are idempotent by job name but will ERROR
--   if the job name already exists. The SELECT cron.unschedule()
--   guards below handle this safely.
--
-- RISK 2: increment_wa_sent_count() is SECURITY DEFINER.
--   search_path = public is set to prevent hijacking.
--   REVOKE ALL FROM PUBLIC + GRANT TO service_role enforced.
--
-- RISK 3: wa_alerts_enabled defaults to FALSE.
--   No school gets WhatsApp alerts until explicitly enabled.
--   This is intentional — feature gate for paid plans.
--
-- RISK 4: plan CHECK constraint uses fixed enum values.
--   Adding new plan tiers requires ALTER TABLE ... DROP CONSTRAINT
--   then re-add. Document before adding new plans.
--
-- RISK 5: set_updated_at() function may already exist from
--   other migrations. CREATE OR REPLACE is safe — no data loss.
--
-- ============================================================


-- ============================================================
-- SECTION 5: FINAL PRODUCTION-READY SQL MIGRATION
-- ============================================================
-- Prerequisites:
--   ✓ pg_cron extension enabled (Dashboard → Database → Extensions)
--   ✓ All previous Schoolium migrations already applied
--   ✓ schools, students, profiles tables exist
--
-- Safe to re-run: all statements use IF NOT EXISTS / OR REPLACE
-- ============================================================


-- ── PART A: students table ───────────────────────────────────────────────────
-- Opt-out flag — set to true when parent replies STOP to WhatsApp.
-- Edge Function checks this before every send.
-- Meta will suspend the WA Business account if opted-out numbers are messaged.

ALTER TABLE public.students
  ADD COLUMN IF NOT EXISTS parent_phone_opted_out BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.students.parent_phone_opted_out IS
  'Set to true when parent replies STOP to WhatsApp. '
  'Never send to opted-out numbers — Meta will suspend the WA Business account.';


-- ── PART B: schools table ────────────────────────────────────────────────────
-- Monthly quota system — prevents runaway API bills.
-- wa_alerts_enabled — feature gate for paid plans (default OFF).
-- plan — subscription tier for future Razorpay integration.

ALTER TABLE public.schools
  ADD COLUMN IF NOT EXISTS wa_monthly_quota
    INTEGER NOT NULL DEFAULT 500,
  ADD COLUMN IF NOT EXISTS wa_messages_sent_month
    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS wa_quota_reset_date
    DATE NOT NULL DEFAULT DATE_TRUNC('month', NOW())::DATE,
  ADD COLUMN IF NOT EXISTS wa_alerts_enabled
    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS plan
    TEXT NOT NULL DEFAULT 'basic';

-- Plan constraint — drop first to allow re-run
ALTER TABLE public.schools
  DROP CONSTRAINT IF EXISTS schools_plan_check;

ALTER TABLE public.schools
  ADD CONSTRAINT schools_plan_check
  CHECK (plan IN ('basic', 'standard', 'premium'));

COMMENT ON COLUMN public.schools.wa_monthly_quota IS
  'Max WhatsApp messages this school can send per calendar month. Default 500.';
COMMENT ON COLUMN public.schools.wa_messages_sent_month IS
  'Running count of WA messages sent this month. '
  'Reset to 0 on 1st of each month by pg_cron job reset-wa-monthly-quota.';
COMMENT ON COLUMN public.schools.wa_quota_reset_date IS
  'Date the monthly counter was last reset. Used to detect missed pg_cron resets.';
COMMENT ON COLUMN public.schools.wa_alerts_enabled IS
  'Feature gate — set to true only for schools on a paid plan that includes WA alerts.';
COMMENT ON COLUMN public.schools.plan IS
  'Subscription tier: basic (default) | standard | premium. '
  'Controls which features are available. Will be automated via Razorpay in future.';


-- ── PART C: wa_message_log table ─────────────────────────────────────────────
-- Central audit log for every WhatsApp message attempt.
-- The UNIQUE constraint is the primary dedup guard — INSERT before API call,
-- conflict = already sent today = skip entirely.
-- Retry job reads rows where status=failed AND attempt_count < 3.

CREATE TABLE IF NOT EXISTS public.wa_message_log (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Tenant isolation
  school_id        UUID        NOT NULL
                               REFERENCES public.schools(id)  ON DELETE CASCADE,
  student_id       UUID        NOT NULL
                               REFERENCES public.students(id) ON DELETE CASCADE,

  -- Message identity
  parent_phone     TEXT        NOT NULL,   -- snapshot at send time
  message_type     TEXT        NOT NULL
                               CHECK (message_type IN (
                                 'entry_alert',
                                 'exit_alert',
                                 'fee_reminder',
                                 'absence_alert'    -- reserved for future use
                               )),
  template_name    TEXT        NOT NULL,   -- e.g. 'student_entry_alert'

  -- Dedup key uses DATE not TIMESTAMPTZ — one message per student per day
  log_date         DATE        NOT NULL DEFAULT CURRENT_DATE,

  -- State machine: pending → sent | failed | quota_exceeded | opted_out_skip
  status           TEXT        NOT NULL DEFAULT 'pending'
                               CHECK (status IN (
                                 'pending',
                                 'sent',
                                 'failed',
                                 'quota_exceeded',
                                 'opted_out_skip'
                               )),

  -- Meta API response fields
  meta_message_id  TEXT        NULL,       -- message ID returned by Meta on success
  error_message    TEXT        NULL,       -- full error string on failure (for debugging)

  -- Retry tracking (exponential backoff: 30s → 2min → 5min)
  attempt_count    SMALLINT    NOT NULL DEFAULT 0,
  next_retry_at    TIMESTAMPTZ NULL,       -- null = no retry scheduled

  -- Timestamps
  sent_at          TIMESTAMPTZ NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.wa_message_log IS
  'Audit log for every WhatsApp message attempt. '
  'UNIQUE constraint on (school_id, student_id, log_date, message_type) '
  'prevents duplicate sends. Retry job reads failed rows where attempt_count < 3.';


-- ── PART D: dedup UNIQUE constraint ──────────────────────────────────────────
-- One message per student per day per type per school.
-- Entry + Exit = max 2 messages per student per day.
-- Second INSERT for same student+day+type → conflict → skip → no API call.

ALTER TABLE public.wa_message_log
  DROP CONSTRAINT IF EXISTS wa_message_log_unique_per_day;

ALTER TABLE public.wa_message_log
  ADD CONSTRAINT wa_message_log_unique_per_day
  UNIQUE (school_id, student_id, log_date, message_type);


-- ── PART E: updated_at trigger ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS wa_message_log_updated_at ON public.wa_message_log;

CREATE TRIGGER wa_message_log_updated_at
  BEFORE UPDATE ON public.wa_message_log
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ── PART F: indexes ───────────────────────────────────────────────────────────

-- Retry job: cheaply find failed rows due for retry
CREATE INDEX IF NOT EXISTS idx_wa_log_retry
  ON public.wa_message_log (status, attempt_count, next_retry_at)
  WHERE status = 'failed';

-- Admin dashboard: school's message history by date
CREATE INDEX IF NOT EXISTS idx_wa_log_school_date
  ON public.wa_message_log (school_id, log_date DESC);

-- Student profile: per-student message history
CREATE INDEX IF NOT EXISTS idx_wa_log_student
  ON public.wa_message_log (student_id, log_date DESC);


-- ── PART G: Row Level Security ────────────────────────────────────────────────
-- Edge Functions use SERVICE_ROLE_KEY → bypass RLS entirely.
-- School admins can SELECT logs for their own school only.
-- No client-side INSERT / UPDATE / DELETE — all writes via Edge Functions.

ALTER TABLE public.wa_message_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "school_admin_read_wa_logs" ON public.wa_message_log;

CREATE POLICY "school_admin_read_wa_logs"
  ON public.wa_message_log
  FOR SELECT
  USING (
    school_id IN (
      SELECT profiles.school_id
      FROM   public.profiles
      WHERE  profiles.id        = auth.uid()
        AND  profiles.role      = 'school_admin'
        AND  profiles.is_active = true
    )
  );


-- ── PART H: increment_wa_sent_count() function ───────────────────────────────
-- Atomic counter — prevents race conditions when two scans fire simultaneously.
-- Called by notify-attendance Edge Function after every successful send.
-- SECURITY DEFINER so service role can call it; blocked from public.

CREATE OR REPLACE FUNCTION public.increment_wa_sent_count(p_school_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.schools
  SET wa_messages_sent_month = wa_messages_sent_month + 1
  WHERE id = p_school_id;
END;
$$;

REVOKE ALL   ON FUNCTION public.increment_wa_sent_count(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.increment_wa_sent_count(UUID) TO service_role;


-- ── PART I: pg_cron jobs ──────────────────────────────────────────────────────
-- Requires pg_cron extension enabled in Dashboard → Database → Extensions.
-- Both jobs are idempotent by name — unschedule first to avoid duplicate errors.

-- Job 1: Reset monthly WA quota counter
-- Runs at 18:30 UTC (= 00:00 IST) on days 28-31.
-- WHERE clause ensures it only resets on the actual last day of the month.
SELECT cron.unschedule('reset-wa-monthly-quota') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'reset-wa-monthly-quota'
);

SELECT cron.schedule(
  'reset-wa-monthly-quota',
  '30 18 28-31 * *',
  $$
    UPDATE public.schools
    SET
      wa_messages_sent_month = 0,
      wa_quota_reset_date    = DATE_TRUNC('month', NOW() + INTERVAL '1 day')::DATE
    WHERE
      (NOW() + INTERVAL '1 day')::DATE
        = DATE_TRUNC('month', NOW() + INTERVAL '1 day')::DATE
      AND is_active = true;
  $$
);

-- Job 2: Retry failed WhatsApp messages every 5 minutes.
-- Calls retry-wa-messages Edge Function which picks up failed rows
-- where attempt_count < 3 and next_retry_at <= now().
-- REPLACE YOUR_SUPABASE_URL and YOUR_ANON_KEY before running.
SELECT cron.unschedule('retry-wa-messages') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'retry-wa-messages'
);

SELECT cron.schedule(
  'retry-wa-messages',
  '*/5 * * * *',
  $$
    SELECT net.http_post(
      url     := 'YOUR_SUPABASE_URL/functions/v1/retry-wa-messages',
      headers := '{"Content-Type":"application/json","Authorization":"Bearer YOUR_ANON_KEY"}'::jsonb,
      body    := '{}'::jsonb
    );
  $$
);


-- ── PART J: verify ────────────────────────────────────────────────────────────
-- Run these after applying to confirm everything landed correctly.

-- 1. New columns on students:
-- SELECT column_name, data_type, column_default
-- FROM information_schema.columns
-- WHERE table_name = 'students'
--   AND column_name = 'parent_phone_opted_out';

-- 2. New columns on schools:
-- SELECT column_name, data_type, column_default
-- FROM information_schema.columns
-- WHERE table_name = 'schools'
--   AND column_name IN (
--     'wa_monthly_quota', 'wa_messages_sent_month',
--     'wa_quota_reset_date', 'wa_alerts_enabled', 'plan'
--   );

-- 3. wa_message_log constraints:
-- SELECT constraint_name, constraint_type
-- FROM information_schema.table_constraints
-- WHERE table_name = 'wa_message_log';

-- 4. Indexes:
-- SELECT indexname FROM pg_indexes
-- WHERE tablename = 'wa_message_log';

-- 5. Functions:
-- SELECT routine_name FROM information_schema.routines
-- WHERE routine_name IN ('increment_wa_sent_count', 'set_updated_at');

-- 6. pg_cron jobs:
-- SELECT jobname, schedule FROM cron.job
-- WHERE jobname IN ('reset-wa-monthly-quota', 'retry-wa-messages');

-- ============================================================
-- END OF MIGRATION
-- Schoolium Chat 10 — WhatsApp Alert System
-- 22 June 2026
--
-- Edge Functions deployed separately (not SQL):
--   supabase/functions/notify-attendance/index.ts   ✓ deployed
--   supabase/functions/retry-wa-messages/index.ts   ✓ deployed
--
-- Scan page updated:
--   app/scan/[school_id]/page.tsx                   ✓ deployed
--
-- WhatsApp templates approved by Meta:
--   student_entry_alert  (Utility, English)         ✓ Active
--   student_exit_alert   (Utility, English)         ✓ Active
--
-- Pending (next session):
--   wa_alerts_enabled feature gate — wire into Edge Functions
-- ============================================================
