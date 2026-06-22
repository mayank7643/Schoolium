-- ============================================================
-- SCHOOLIUM — WHATSAPP SETUP MIGRATION
-- FILE: SQL/20260620_whatsapp_setup.sql
--
-- Run ONCE in Supabase Dashboard → SQL Editor.
-- Safe to re-run (IF NOT EXISTS + DROP IF EXISTS throughout).
--
-- What this migration does:
--   1. Adds parent_phone_opted_out to students
--   2. Adds WA quota + usage tracking to schools
--   3. Creates wa_message_log table (dedup + audit trail)
--   4. Indexes + RLS policies
-- ============================================================


-- ── 1. STUDENTS — opt-out flag ───────────────────────────────────────────────
-- When a parent replies STOP to a WhatsApp message, Meta's webhook fires.
-- Our webhook handler sets this to true. We check it before every send.

ALTER TABLE public.students
  ADD COLUMN IF NOT EXISTS parent_phone_opted_out BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.students.parent_phone_opted_out IS
  'Set to true when parent replies STOP to WhatsApp. Never send to opted-out numbers — Meta will suspend the WA Business account.';


-- ── 2. SCHOOLS — monthly quota + usage counter ───────────────────────────────
-- wa_monthly_quota: hard cap on messages per school per calendar month.
--   Default 500 — generous for a 200-student school (entry + exit = 400/day max
--   but not every student scans every day). Adjust per school as needed.
--
-- wa_messages_sent_this_month: reset to 0 on the 1st of each month via pg_cron.
--   Edge Function increments this atomically after every successful send.
--   If it reaches wa_monthly_quota → log quota_exceeded → skip send.
--
-- wa_quota_reset_date: tracks when the counter was last reset.
--   Lets us catch missed resets (e.g. pg_cron outage).

ALTER TABLE public.schools
  ADD COLUMN IF NOT EXISTS wa_monthly_quota         INTEGER NOT NULL DEFAULT 500,
  ADD COLUMN IF NOT EXISTS wa_messages_sent_month   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS wa_quota_reset_date      DATE    NOT NULL DEFAULT DATE_TRUNC('month', NOW())::DATE;

COMMENT ON COLUMN public.schools.wa_monthly_quota IS
  'Max WhatsApp messages this school can send per calendar month. Default 500.';
COMMENT ON COLUMN public.schools.wa_messages_sent_month IS
  'Running count of WA messages sent this month. Reset to 0 on 1st of month by pg_cron.';
COMMENT ON COLUMN public.schools.wa_quota_reset_date IS
  'Date the monthly counter was last reset. Used to detect missed resets.';


-- ── 3. WA_MESSAGE_LOG — the dedup + audit table ──────────────────────────────
-- Every attempted send gets a row here BEFORE the Meta API call.
-- The UNIQUE constraint on (school_id, student_id, log_date, message_type)
-- is the primary guard against duplicate messages.
--
-- Flow:
--   INSERT row (status=pending)  ← if conflict → already sent → skip
--   → call Meta API
--   → UPDATE row (status=sent|failed)
--
-- attempt_count tracks retries. pg_cron retry job picks up
-- rows where status='failed' AND attempt_count < 3.
-- next_retry_at uses exponential backoff: 30s → 2min → 5min.

CREATE TABLE IF NOT EXISTS public.wa_message_log (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Who / what
  school_id        UUID        NOT NULL REFERENCES public.schools(id)   ON DELETE CASCADE,
  student_id       UUID        NOT NULL REFERENCES public.students(id)  ON DELETE CASCADE,
  parent_phone     TEXT        NOT NULL,  -- snapshot at send time (phone may change later)
  message_type     TEXT        NOT NULL
                               CHECK (message_type IN (
                                 'entry_alert',
                                 'exit_alert',
                                 'fee_reminder',
                                 'absence_alert'   -- reserved for future use
                               )),
  template_name    TEXT        NOT NULL,  -- e.g. 'student_entry_alert'

  -- Date (DATE not TIMESTAMPTZ — dedup key is per calendar day)
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

  -- Meta API response
  meta_message_id  TEXT        NULL,      -- message ID from Meta on success
  error_message    TEXT        NULL,      -- full error string on failure

  -- Retry tracking
  attempt_count    SMALLINT    NOT NULL DEFAULT 0,
  next_retry_at    TIMESTAMPTZ NULL,      -- set by Edge Function on failure

  -- Timestamps
  sent_at          TIMESTAMPTZ NULL,      -- when Meta API call succeeded
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.wa_message_log IS
  'Audit log for every WhatsApp message attempt. UNIQUE constraint prevents duplicate sends. Retry job reads failed rows where attempt_count < 3.';


-- ── 4. THE KEY DEDUP CONSTRAINT ──────────────────────────────────────────────
-- One message per student per day per message_type, per school.
-- student_entry_alert + student_exit_alert = max 2 messages/student/day.
-- If Edge Function is called twice (network retry, Realtime double-fire) →
-- second INSERT hits this constraint → returns conflict → no API call made.

ALTER TABLE public.wa_message_log
  DROP CONSTRAINT IF EXISTS wa_message_log_unique_per_day;

ALTER TABLE public.wa_message_log
  ADD CONSTRAINT wa_message_log_unique_per_day
  UNIQUE (school_id, student_id, log_date, message_type);


-- ── 5. updated_at auto-update trigger ────────────────────────────────────────

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


-- ── 6. INDEXES ────────────────────────────────────────────────────────────────

-- Retry job: find failed rows cheaply
CREATE INDEX IF NOT EXISTS idx_wa_log_retry
  ON public.wa_message_log (status, attempt_count, next_retry_at)
  WHERE status = 'failed';

-- Admin dashboard: all logs for a school by date
CREATE INDEX IF NOT EXISTS idx_wa_log_school_date
  ON public.wa_message_log (school_id, log_date DESC);

-- Student profile: message history per student
CREATE INDEX IF NOT EXISTS idx_wa_log_student
  ON public.wa_message_log (student_id, log_date DESC);


-- ── 7. ROW LEVEL SECURITY ─────────────────────────────────────────────────────
-- Edge Function uses service role → bypasses RLS entirely.
-- School admins can SELECT their own school's logs only.
-- No client-side INSERT/UPDATE/DELETE — all writes via Edge Function.

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
