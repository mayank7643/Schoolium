-- ============================================================
-- SCHOOLIUM - CHAT 21 SESSION - ALERTS BYOG FOUNDATION
-- chat21_alerts_byog_foundation
-- Generated 09 July 2026 - validated on PostgreSQL 16
-- ============================================================
-- Implements the DB layer of the "Schoolium Alerts" blueprint
-- (docs/schoolium-alerts-blueprint.md): QR gate-attendance capture
-- plus a BYOG (Bring Your Own Gateway) message orchestration engine
-- that sends alerts through the school's own WhatsApp / DLT SMS /
-- email credentials.
--
-- Assumes chat02..chat20 are already applied.
--
-- Pipeline implemented here (blueprint section 2):
--
--   gate scan --+
--   cutoff cron +--> events --> guards --> message_outbox
--   composer  --+                             |
--                                             v
--                            worker (claim batch, SKIP LOCKED)
--                                   |               ^
--                            credential vault       |
--                                   |               |
--                                   v               |
--                          school's gateway --> webhooks --> ledger
--
-- Invariants (blueprint sections 2 and 14):
--   1. Nothing sends a message directly. Capture code emits events.
--      Only the worker sends.
--   2. Guards run BEFORE the outbox insert, in the same transaction
--      (opt-out -> dedupe -> quiet hours -> rate limit -> spend cap).
--   3. The worker never holds business logic: claim row, decrypt
--      credential (Node side), call adapter, write status.
--   4. occurred_at is the ORIGINAL scan time, never the sync time.
--   5. Credential plaintext never touches Postgres. The vault stores
--      AES-256-GCM ciphertext only; the key lives in the worker env.
-- ============================================================


-- ============================================================
-- SECTION 0: SUMMARY OF CHANGES
-- ============================================================
--
-- REUSED (existing tables, extended in place):
--   schools     -> + alerts_enabled, alerts_timezone, absent_cutoff_time,
--                    checkout_alerts_enabled, quiet_hours_start/end,
--                    stale_alert_minutes
--   students    -> + external_ref (backfilled from student_uid where
--                    unambiguous), class_label (backfilled from classes)
--   profiles    -> role CHECK gains 'operator' (existing roles kept)
--   attendance  -> new AFTER INSERT trigger emits student.checked_in /
--                    student.checked_out events (occurred_at = scan_time)
--   classes     -> read-only source for the class_label backfill
--
-- LEFT UNTOUCHED (legacy WhatsApp/fee pipeline keeps working):
--   wa_message_log, wa_outbox, all fee_* tables, all wa_* school
--   columns and quota crons. The new pipeline is gated behind
--   schools.alerts_enabled which defaults to FALSE, so nothing
--   changes behaviour for existing schools until it is flipped.
--
-- NEW TABLES:
--   guardians, student_guardians, contact_methods      (directory)
--   events                                             (append-only spine)
--   message_templates, channel_templates               (two template layers)
--   message_outbox                                     (send queue + ledger)
--   rate_card, spend_guard, channel_rate_limits        (money guards)
--   school_channels                                    (credential vault)
--   absent_runs                                        (cutoff idempotency)
--   alert_notifications                                (ops surface)
--   import_batches, import_rows                        (CSV staging)
--
-- NEW FUNCTIONS:
--   normalize_phone_e164        - +91 phone normaliser (imports/backfill)
--   alerts_quiet_release        - quiet-hours release timestamp
--   alerts_render_vars          - var_map x context -> positional vars
--   alerts_message_cost         - rate_card lookup incl GST
--   alerts_enqueue_for_event    - THE guard chain + outbox fan-out
--   handle_attendance_alert_event - attendance trigger fn
--   claim_outbox_batch          - worker claim, FOR UPDATE SKIP LOCKED
--   complete_outbox_send        - worker result + backoff/dead-letter
--   apply_delivery_status       - webhook ledger updates
--   set_channel_health          - vault health + low-balance alerts
--   run_absent_cutoff           - absent-at-cutoff emitter (pg_cron)
--   publish_notice              - composer RPC (auth checked)
--   estimate_notice_send        - composer confirm screen numbers
--   send_test_message           - onboarding "the moment" RPC
--   seed_default_message_templates - per-school starter templates
--   get_notice_delivery_stats   - "Delivered to 412. Read by 388."
--
-- Rules honoured: pure ASCII, idempotent, SECURITY DEFINER sets
-- search_path + REVOKE ALL FROM PUBLIC + explicit GRANT, every
-- table alias qualified, RLS on every tenant table.
-- ============================================================


-- ============================================================
-- SECTION 1: EXTENSIONS
-- pgcrypto: digest() for idempotency keys. Already enabled on
-- Supabase (extensions schema); IF NOT EXISTS makes this a no-op.
-- Functions that call digest() set search_path = public, extensions
-- so they resolve it on both Supabase and vanilla Postgres.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- ============================================================
-- SECTION 2: profiles - add 'operator' role
-- Blueprint collapses new-product roles to super_admin /
-- school_admin / operator / guard. Existing roles are kept
-- byte-for-byte so no production row can violate the constraint.
-- ============================================================

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_role_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check
    CHECK (role IN (
      'super_admin',
      'school_admin',
      'operator',
      'principal',
      'teacher',
      'collector',
      'receptionist',
      'staff',
      'guard',
      'parent'
    ));

COMMENT ON COLUMN public.profiles.role IS
  'super_admin: platform staff. '
  'school_admin: owner - full access. '
  'operator: front desk - sends notices, manages directory (alerts product). '
  'principal: full academic access. '
  'teacher: assigned classes and subjects. '
  'collector: fee collection (accountant). '
  'receptionist: admissions and student management. '
  'staff: generic non-teaching staff. '
  'guard: gate scan only. '
  'parent: reserved.';


-- ============================================================
-- SECTION 3: schools - alerts settings
-- alerts_enabled is the master gate for the NEW pipeline and
-- defaults to FALSE: applying this migration changes nothing for
-- any existing school until the flag is flipped per school.
-- ============================================================

ALTER TABLE public.schools
  ADD COLUMN IF NOT EXISTS alerts_enabled          boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS alerts_timezone         text    NOT NULL DEFAULT 'Asia/Kolkata',
  ADD COLUMN IF NOT EXISTS absent_cutoff_time      time,
  ADD COLUMN IF NOT EXISTS checkout_alerts_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS quiet_hours_start       time    NOT NULL DEFAULT '21:00',
  ADD COLUMN IF NOT EXISTS quiet_hours_end         time    NOT NULL DEFAULT '06:30',
  ADD COLUMN IF NOT EXISTS stale_alert_minutes     integer;

COMMENT ON COLUMN public.schools.alerts_enabled IS
  'Master gate for the BYOG alerts pipeline (events -> outbox -> worker). '
  'Independent of the legacy wa_alerts_enabled flag.';
COMMENT ON COLUMN public.schools.absent_cutoff_time IS
  'Local time after which unscanned active students trigger '
  'student.absent_at_cutoff. NULL disables absence alerts.';
COMMENT ON COLUMN public.schools.checkout_alerts_enabled IS
  'Check-in only (false, default - halves the messaging bill) or '
  'check-in + check-out (true).';
COMMENT ON COLUMN public.schools.stale_alert_minutes IS
  'If set, suppress check-in/out alerts whose scan is older than this '
  'many minutes when the offline queue finally syncs. NULL = always send.';


-- ============================================================
-- SECTION 4: students - external_ref + class_label
-- external_ref: the school ERP''s student id, the CSV upsert key.
-- Backfilled from student_uid only where that value is unambiguous
-- within the school. class_label: free text ("5-A"), deliberately
-- NOT a FK - the blueprint models classes as a filter string only.
-- ============================================================

ALTER TABLE public.students
  ADD COLUMN IF NOT EXISTS external_ref text,
  ADD COLUMN IF NOT EXISTS class_label  text;

CREATE UNIQUE INDEX IF NOT EXISTS students_school_external_ref_uniq
  ON public.students (school_id, external_ref)
  WHERE external_ref IS NOT NULL;

COMMENT ON COLUMN public.students.external_ref IS
  'The school''s own student id (from their ERP / register). '
  'CSV import upserts on (school_id, external_ref). Never shown as ours.';
COMMENT ON COLUMN public.students.class_label IS
  'Free-text class filter, e.g. "5-A". Deliberately not a classes FK.';

-- Backfill external_ref from student_uid where a) the column exists
-- (it was added by the pre-repo 002 migration) and b) the value is
-- unique within the school. Ambiguous duplicates stay NULL for the
-- school to fix via CSV import.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name   = 'students'
      AND c.column_name  = 'student_uid'
  ) THEN
    UPDATE public.students s
    SET    external_ref = s.student_uid
    WHERE  s.external_ref IS NULL
      AND  s.student_uid IS NOT NULL
      AND  btrim(s.student_uid) <> ''
      AND  NOT EXISTS (
             SELECT 1 FROM public.students s2
             WHERE  s2.school_id   = s.school_id
               AND  s2.id         <> s.id
               AND  s2.student_uid = s.student_uid
           );
  END IF;
END $$;

-- Backfill class_label from the joined classes row ("5" + "A" -> "5-A").
UPDATE public.students s
SET    class_label = btrim(c.name || COALESCE('-' || NULLIF(btrim(c.section), ''), ''))
FROM   public.classes c
WHERE  c.id = s.class_id
  AND  s.class_label IS NULL;


-- ============================================================
-- SECTION 5: phone normaliser
-- Used by the guardian backfill below and by CSV import staging.
-- "98765 43210" / "098765-43210" / "919876543210" -> +919876543210
-- Returns NULL when the input cannot be a plausible E.164 number.
-- ============================================================

CREATE OR REPLACE FUNCTION public.normalize_phone_e164(
  p_raw        text,
  p_default_cc text DEFAULT '91'
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v text;
BEGIN
  v := regexp_replace(COALESCE(p_raw, ''), '[^0-9+]', '', 'g');
  IF v = '' OR v = '+' THEN
    RETURN NULL;
  END IF;

  IF left(v, 1) = '+' THEN
    v := '+' || regexp_replace(substr(v, 2), '[^0-9]', '', 'g');
  ELSE
    v := regexp_replace(v, '^0+', '');
    IF length(v) = 10 THEN
      v := '+' || p_default_cc || v;
    ELSIF length(v) = 10 + length(p_default_cc)
      AND left(v, length(p_default_cc)) = p_default_cc THEN
      v := '+' || v;
    ELSE
      v := '+' || v;
    END IF;
  END IF;

  IF v ~ '^\+[1-9][0-9]{7,14}$' THEN
    RETURN v;
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.normalize_phone_e164(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.normalize_phone_e164(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.normalize_phone_e164(text, text) TO service_role;


-- ============================================================
-- SECTION 6: DIRECTORY - guardians / student_guardians /
--            contact_methods
-- Imported via CSV, never authoritative (the school's ERP is).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.guardians (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id  uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  full_name  text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_guardians_school ON public.guardians (school_id);

CREATE TABLE IF NOT EXISTS public.student_guardians (
  student_id  uuid    NOT NULL REFERENCES public.students(id)  ON DELETE CASCADE,
  guardian_id uuid    NOT NULL REFERENCES public.guardians(id) ON DELETE CASCADE,
  relation    text,
  is_primary  boolean NOT NULL DEFAULT false,
  PRIMARY KEY (student_id, guardian_id)
);

CREATE INDEX IF NOT EXISTS idx_student_guardians_guardian
  ON public.student_guardians (guardian_id);

CREATE TABLE IF NOT EXISTS public.contact_methods (
  id          uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  guardian_id uuid    NOT NULL REFERENCES public.guardians(id) ON DELETE CASCADE,
  channel     text    NOT NULL CHECK (channel IN ('sms', 'whatsapp', 'email')),
  value       text    NOT NULL,             -- E.164 for phones: +919876543210
  opted_out   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (guardian_id, channel, value)
);

CREATE INDEX IF NOT EXISTS idx_contact_methods_guardian
  ON public.contact_methods (guardian_id);

COMMENT ON COLUMN public.contact_methods.opted_out IS
  'Consent guard #1. Set true on inbound STOP (SMS) or Meta opt-out '
  'signal (WhatsApp). Opted-out methods are skipped before enqueue.';

-- Backfill: existing students carry parent_name/parent_phone/parent_email
-- inline. Create one guardian per distinct normalised phone per school
-- (siblings share a guardian), link students, and copy the legacy
-- parent_phone_opted_out flag onto the phone contact methods.
-- Idempotent: students already linked are skipped.
DO $$
DECLARE
  r     record;
  v_gid uuid;
BEGIN
  FOR r IN
    SELECT s.id        AS student_id,
           s.school_id AS school_id,
           COALESCE(NULLIF(btrim(s.parent_name), ''),
                    'Guardian of ' || s.full_name)          AS gname,
           public.normalize_phone_e164(s.parent_phone)      AS phone,
           NULLIF(btrim(COALESCE(s.parent_email, '')), '')  AS email,
           COALESCE(s.parent_phone_opted_out, false)        AS opted
    FROM   public.students s
    WHERE  NOT EXISTS (
             SELECT 1 FROM public.student_guardians sg
             WHERE  sg.student_id = s.id
           )
      AND  (public.normalize_phone_e164(s.parent_phone) IS NOT NULL
            OR NULLIF(btrim(COALESCE(s.parent_email, '')), '') IS NOT NULL)
    ORDER BY s.school_id, s.created_at
  LOOP
    v_gid := NULL;

    -- Reuse a guardian in the same school already holding this phone.
    IF r.phone IS NOT NULL THEN
      SELECT g.id INTO v_gid
      FROM   public.guardians g
      JOIN   public.contact_methods cm ON cm.guardian_id = g.id
      WHERE  g.school_id = r.school_id
        AND  cm.value    = r.phone
      LIMIT  1;
    END IF;

    IF v_gid IS NULL THEN
      INSERT INTO public.guardians (school_id, full_name)
      VALUES (r.school_id, r.gname)
      RETURNING id INTO v_gid;
    END IF;

    INSERT INTO public.student_guardians (student_id, guardian_id, relation, is_primary)
    VALUES (r.student_id, v_gid, 'parent', true)
    ON CONFLICT (student_id, guardian_id) DO NOTHING;

    IF r.phone IS NOT NULL THEN
      INSERT INTO public.contact_methods (guardian_id, channel, value, opted_out)
      VALUES (v_gid, 'whatsapp', r.phone, r.opted),
             (v_gid, 'sms',      r.phone, r.opted)
      ON CONFLICT (guardian_id, channel, value) DO NOTHING;
    END IF;

    IF r.email IS NOT NULL THEN
      INSERT INTO public.contact_methods (guardian_id, channel, value, opted_out)
      VALUES (v_gid, 'email', lower(r.email), false)
      ON CONFLICT (guardian_id, channel, value) DO NOTHING;
    END IF;
  END LOOP;
END $$;


-- ============================================================
-- SECTION 7: EVENTS (append-only spine)
-- dedup_key is the first line of defence: an offline device that
-- syncs the same scan twice inserts once. No CHECK on type - the
-- chat11 message_type constraint taught us that lesson.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.events (
  id          bigserial   PRIMARY KEY,
  school_id   uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  type        text        NOT NULL,   -- student.checked_in | student.checked_out
                                      -- student.absent_at_cutoff | notice.published
  subject_id  uuid,                   -- student_id, or NULL for notices
  occurred_at timestamptz NOT NULL,   -- ORIGINAL scan time, never sync time
  payload     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  dedup_key   text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, dedup_key)
);

CREATE INDEX IF NOT EXISTS idx_events_school_occurred
  ON public.events (school_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_school_type
  ON public.events (school_id, type, occurred_at DESC);

COMMENT ON TABLE public.events IS
  'Append-only. Capture code (scan trigger, cutoff cron, composer) emits '
  'events; only alerts_enqueue_for_event turns them into outbox rows. '
  'dedup_key for a check-in is checkin:{student_id}:{yyyy-mm-dd}.';


-- ============================================================
-- SECTION 8: TEMPLATES - two layers, never conflated
-- message_templates is what humans read; channel_templates is the
-- APPROVED provider artifact (DLT template id / Meta template name)
-- plus var_map, the positional-variable glue.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.message_templates (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id  uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  key        text        NOT NULL,   -- 'checkin' | 'checkout' | 'absent' | 'notice*'
  body       text        NOT NULL,   -- "{{child}} entered {{school}} at {{time}}."
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, key)
);

CREATE TABLE IF NOT EXISTS public.channel_templates (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id            uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  message_template_id  uuid        NOT NULL REFERENCES public.message_templates(id) ON DELETE CASCADE,
  channel              text        NOT NULL CHECK (channel IN ('sms', 'whatsapp', 'email')),
  category             text        NOT NULL CHECK (category IN ('utility', 'marketing', 'service', 'transactional')),
  provider_template_id text,       -- DLT template id / Meta template name
  header               text,       -- DLT sender header, 6 chars
  language             text        DEFAULT 'en',
  var_map              jsonb       NOT NULL,   -- {"1":"child","2":"school","3":"time"}
  approval_status      text        NOT NULL DEFAULT 'draft'
                                   CHECK (approval_status IN
                                     ('draft', 'submitted', 'approved', 'rejected', 'paused')),
  approved_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, message_template_id, channel)
);

DROP TRIGGER IF EXISTS channel_templates_updated_at ON public.channel_templates;
CREATE TRIGGER channel_templates_updated_at
  BEFORE UPDATE ON public.channel_templates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON COLUMN public.channel_templates.category IS
  'Where the money is: whatsapp/utility is ~7.5x cheaper than marketing. '
  'Set at template creation, priced at enqueue via rate_card.';
COMMENT ON COLUMN public.channel_templates.var_map IS
  'Positional provider variable -> semantic context name. Context names: '
  'child, child_first, school, class, time, date, plus event payload vars.';


-- ============================================================
-- SECTION 9: OUTBOX (send queue + delivery ledger)
-- unique(school_id, idempotency_key) is the two lines of SQL that
-- one day save a customer Rs 40,000 when a worker crashes mid-batch.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.message_outbox (
  id                  bigserial   PRIMARY KEY,
  school_id           uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  event_id            bigint      REFERENCES public.events(id) ON DELETE SET NULL,
  channel_template_id uuid        NOT NULL REFERENCES public.channel_templates(id),
  channel             text        NOT NULL CHECK (channel IN ('sms', 'whatsapp', 'email')),
  recipient           text        NOT NULL,   -- E.164 or email
  vars                jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status              text        NOT NULL DEFAULT 'queued'
                                  CHECK (status IN
                                    ('queued', 'sending', 'sent', 'delivered',
                                     'read', 'failed', 'dead')),
  attempts            integer     NOT NULL DEFAULT 0,
  next_attempt_at     timestamptz NOT NULL DEFAULT now(),
  provider_message_id text,
  error_code          text,
  error_message       text,
  cost_estimate_paise integer     NOT NULL DEFAULT 0,
  idempotency_key     text        NOT NULL,
  triggered_by        text        NOT NULL DEFAULT 'system',  -- scan|cutoff|composer|test|system
  sent_by_user_id     uuid,                                   -- audit: who spent the money
  sent_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_message_outbox_pickup
  ON public.message_outbox (status, next_attempt_at)
  WHERE status IN ('queued', 'failed');
CREATE INDEX IF NOT EXISTS idx_message_outbox_school_created
  ON public.message_outbox (school_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_outbox_event
  ON public.message_outbox (event_id);
CREATE INDEX IF NOT EXISTS idx_message_outbox_provider_msg
  ON public.message_outbox (school_id, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

DROP TRIGGER IF EXISTS message_outbox_updated_at ON public.message_outbox;
CREATE TRIGGER message_outbox_updated_at
  BEFORE UPDATE ON public.message_outbox
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON COLUMN public.message_outbox.idempotency_key IS
  'sha256(event_id:recipient:channel_template_id). The unique constraint '
  'makes retries and guardian dedupe (one notice per guardian) free.';


-- ============================================================
-- SECTION 10: MONEY GUARDS - rate_card / spend_guard /
--             channel_rate_limits
-- ============================================================

CREATE TABLE IF NOT EXISTS public.rate_card (
  channel        text    NOT NULL,
  category       text    NOT NULL,
  paise          integer NOT NULL,
  gst_pct        numeric NOT NULL DEFAULT 18,
  effective_from date    NOT NULL,
  PRIMARY KEY (channel, category, effective_from)
);

COMMENT ON TABLE public.rate_card IS
  'Global price list used for cost estimates. VERIFY against current '
  'Meta/DLT rates before quoting - they change quarterly.';

-- Seed (indicative Jan-2026 India rates; keep effective_from rows,
-- never update in place - add a newer effective_from instead).
INSERT INTO public.rate_card (channel, category, paise, gst_pct, effective_from)
VALUES
  ('whatsapp', 'utility',        12, 18, DATE '2026-01-01'),
  ('whatsapp', 'marketing',      86, 18, DATE '2026-01-01'),
  ('whatsapp', 'service',         0, 18, DATE '2026-01-01'),
  ('sms',      'transactional',  20, 18, DATE '2026-01-01'),
  ('sms',      'service',        20, 18, DATE '2026-01-01'),
  ('email',    'transactional',   0, 18, DATE '2026-01-01'),
  ('email',    'service',         0, 18, DATE '2026-01-01')
ON CONFLICT (channel, category, effective_from) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.spend_guard (
  school_id         uuid    PRIMARY KEY REFERENCES public.schools(id) ON DELETE CASCADE,
  daily_cap_paise   integer NOT NULL DEFAULT 500000,   -- Rs 5,000/day. Default it LOW.
  spent_today_paise integer NOT NULL DEFAULT 0,
  spent_date        date    NOT NULL DEFAULT CURRENT_DATE
);

COMMENT ON TABLE public.spend_guard IS
  'Checked (and reserved) in the SAME transaction as the outbox insert. '
  'A school that legitimately needs more will call; a bug will not.';

-- Every existing school gets a guard row at the default cap.
INSERT INTO public.spend_guard (school_id)
SELECT s.id FROM public.schools s
ON CONFLICT (school_id) DO NOTHING;

-- Token bucket per (school_id, channel). Protects the school's Meta
-- quality rating during the morning burst. When the bucket runs dry
-- the enqueue does NOT drop messages - it pushes next_attempt_at
-- forward so sends smooth out at refill_per_sec.
CREATE TABLE IF NOT EXISTS public.channel_rate_limits (
  school_id      uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  channel        text        NOT NULL CHECK (channel IN ('sms', 'whatsapp', 'email')),
  capacity       numeric     NOT NULL DEFAULT 300,
  refill_per_sec numeric     NOT NULL DEFAULT 2,
  tokens         numeric     NOT NULL DEFAULT 300,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (school_id, channel)
);


-- ============================================================
-- SECTION 11: CREDENTIAL VAULT - school_channels
-- The single most dangerous object in the system. Holds bearer
-- credentials that spend other people's money.
--   - AES-256-GCM ciphertext only; the key lives in the worker's
--     environment variable, NEVER in Postgres.
--   - REVOKE from anon + authenticated AND RLS-enabled with zero
--     policies: unreachable through PostgREST twice over.
--   - The UI gets secret_fingerprint last-6 and health. Nothing else.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.school_channels (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id          uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  channel            text        NOT NULL CHECK (channel IN ('sms', 'whatsapp', 'email')),
  provider           text        NOT NULL,   -- meta_cloud | msg91 | gupshup | generic_http | smtp | fake
  config             jsonb       NOT NULL DEFAULT '{}'::jsonb,  -- NON-secret: waba_id, phone_number_id, base_url
  secret_ciphertext  bytea       NOT NULL,
  secret_iv          bytea       NOT NULL,
  secret_tag         bytea       NOT NULL,
  secret_fingerprint text        NOT NULL,   -- sha256 of plaintext, change detection only
  health             text        NOT NULL DEFAULT 'unverified'
                                 CHECK (health IN
                                   ('unverified', 'ok', 'auth_failed', 'low_balance', 'suspended')),
  last_verified_at   timestamptz,
  balance_hint_paise integer,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, channel, provider)
);

DROP TRIGGER IF EXISTS school_channels_updated_at ON public.school_channels;
CREATE TRIGGER school_channels_updated_at
  BEFORE UPDATE ON public.school_channels
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

REVOKE ALL ON public.school_channels FROM anon, authenticated;
-- service_role only. Never reachable through PostgREST.


-- ============================================================
-- SECTION 12: absent_runs + alert_notifications
-- ============================================================

-- Absent-at-cutoff idempotency: one run per school per local day.
CREATE TABLE IF NOT EXISTS public.absent_runs (
  school_id     uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  run_date      date        NOT NULL,
  emitted_count integer     NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (school_id, run_date)
);

-- Ops surface: spend cap hits, stale suppressions, enqueue errors,
-- channel health flips. The dashboard red-banner feed.
CREATE TABLE IF NOT EXISTS public.alert_notifications (
  id         bigserial   PRIMARY KEY,
  school_id  uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  kind       text        NOT NULL,   -- spend_cap_hit | stale_suppressed | enqueue_error
                                     -- channel_unhealthy | low_balance | absent_skipped_no_scans
  severity   text        NOT NULL DEFAULT 'warning'
                         CHECK (severity IN ('info', 'warning', 'error')),
  message    text        NOT NULL,
  context    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  dedup_key  text,                   -- e.g. spend_cap:{school}:{date} - once per day
  is_read    boolean     NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, dedup_key)
);

CREATE INDEX IF NOT EXISTS idx_alert_notifications_school
  ON public.alert_notifications (school_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_notifications_unread
  ON public.alert_notifications (school_id)
  WHERE is_read = false;


-- ============================================================
-- SECTION 13: CSV IMPORT STAGING
-- upload -> parse -> stage -> DIFF PREVIEW -> confirm -> upsert.
-- The diff preview is not a nicety: without it a re-upload with a
-- changed id column silently duplicates 2,000 students.
-- Removed students become is_active = false. NEVER hard delete.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.import_batches (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  uploaded_by uuid        REFERENCES public.profiles(id),
  filename    text,
  status      text        NOT NULL DEFAULT 'uploaded'
                          CHECK (status IN ('uploaded', 'validated', 'applied', 'discarded')),
  summary     jsonb       NOT NULL DEFAULT '{}'::jsonb,  -- {"new":32,"removed":4,"changed":7}
  created_at  timestamptz NOT NULL DEFAULT now(),
  applied_at  timestamptz
);

CREATE TABLE IF NOT EXISTS public.import_rows (
  id                bigserial PRIMARY KEY,
  batch_id          uuid      NOT NULL REFERENCES public.import_batches(id) ON DELETE CASCADE,
  row_number        integer   NOT NULL,
  external_ref      text,
  student_name      text,
  class_label       text,
  guardian_name     text,
  guardian_phone    text,     -- normalised E.164 (normalize_phone_e164)
  guardian_email    text,
  guardian2_phone   text,
  raw               jsonb     NOT NULL DEFAULT '{}'::jsonb,
  validation_errors text[]    NOT NULL DEFAULT '{}',
  action            text      CHECK (action IN ('new', 'update', 'unchanged', 'remove', 'invalid')),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_import_rows_batch
  ON public.import_rows (batch_id);


-- ============================================================
-- SECTION 14: PIPELINE HELPERS
-- ============================================================

-- Quiet hours: returns p_ts unchanged when outside the window,
-- otherwise the next window end (default 06:30 local). Handles the
-- overnight wrap (21:00 -> 06:30) and same-day windows.
CREATE OR REPLACE FUNCTION public.alerts_quiet_release(
  p_ts    timestamptz,
  p_tz    text,
  p_start time,
  p_end   time
)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_local timestamp := p_ts AT TIME ZONE p_tz;
  v_time  time      := v_local::time;
  v_rel   timestamp;
BEGIN
  IF p_start IS NULL OR p_end IS NULL OR p_start = p_end THEN
    RETURN p_ts;
  END IF;

  IF p_start > p_end THEN            -- overnight window, e.g. 21:00 -> 06:30
    IF v_time >= p_start THEN
      v_rel := (v_local::date + 1) + p_end;
    ELSIF v_time < p_end THEN
      v_rel := v_local::date + p_end;
    ELSE
      RETURN p_ts;
    END IF;
  ELSE                               -- same-day window
    IF v_time >= p_start AND v_time < p_end THEN
      v_rel := v_local::date + p_end;
    ELSE
      RETURN p_ts;
    END IF;
  END IF;

  RETURN v_rel AT TIME ZONE p_tz;
END;
$$;

REVOKE ALL ON FUNCTION public.alerts_quiet_release(timestamptz, text, time, time) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.alerts_quiet_release(timestamptz, text, time, time) TO service_role;

-- var_map {"1":"child","2":"school"} x context {"child":"Aayush",...}
-- -> {"1":"Aayush","2":"Sunrise Public School"}. Missing names -> ''.
CREATE OR REPLACE FUNCTION public.alerts_render_vars(
  p_var_map jsonb,
  p_context jsonb
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(
    jsonb_object_agg(k.key, COALESCE(p_context ->> (p_var_map ->> k.key), '')),
    '{}'::jsonb
  )
  FROM jsonb_object_keys(COALESCE(p_var_map, '{}'::jsonb)) AS k(key);
$$;

REVOKE ALL ON FUNCTION public.alerts_render_vars(jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.alerts_render_vars(jsonb, jsonb) TO service_role;

-- Latest applicable rate incl GST, rounded to whole paise. 0 if unpriced.
CREATE OR REPLACE FUNCTION public.alerts_message_cost(
  p_channel  text,
  p_category text
)
RETURNS integer
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE((
    SELECT round(rc.paise * (1 + rc.gst_pct / 100.0))::integer
    FROM   public.rate_card rc
    WHERE  rc.channel        = p_channel
      AND  rc.category       = p_category
      AND  rc.effective_from <= CURRENT_DATE
    ORDER BY rc.effective_from DESC
    LIMIT  1
  ), 0);
$$;

REVOKE ALL ON FUNCTION public.alerts_message_cost(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.alerts_message_cost(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.alerts_message_cost(text, text) TO service_role;


-- ============================================================
-- SECTION 15: THE GUARD CHAIN - alerts_enqueue_for_event
-- Runs entirely inside the caller's transaction (the attendance
-- insert, the cutoff cron, or publish_notice), so the guards and
-- the outbox insert commit or roll back together. Guard order
-- (blueprint section 4): consent -> dedupe -> quiet hours ->
-- rate limit -> spend cap (last, because it fails loudly).
-- ============================================================

CREATE OR REPLACE FUNCTION public.alerts_enqueue_for_event(p_event_id bigint)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_ev           public.events%ROWTYPE;
  v_school       public.schools%ROWTYPE;
  v_mt           public.message_templates%ROWTYPE;
  v_ct           public.channel_templates%ROWTYPE;
  v_key          text;
  v_tz           text;
  v_local_date   date;
  v_class_filter text;
  v_channels     text[];
  v_cap          integer;
  v_spent        integer;
  v_cost         integer;
  v_tokens       numeric;
  v_refill       numeric;
  v_rate_delay   interval;
  v_next         timestamptz;
  v_ctx          jsonb;
  v_vars         jsonb;
  v_idem         text;
  v_count        integer := 0;
  r              record;
BEGIN
  SELECT ev.* INTO v_ev FROM public.events ev WHERE ev.id = p_event_id;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  SELECT s.* INTO v_school FROM public.schools s WHERE s.id = v_ev.school_id;
  IF NOT FOUND OR NOT v_school.alerts_enabled THEN
    RETURN 0;
  END IF;

  v_tz         := COALESCE(v_school.alerts_timezone, 'Asia/Kolkata');
  v_local_date := (now() AT TIME ZONE v_tz)::date;

  v_key := CASE v_ev.type
             WHEN 'student.checked_in'       THEN 'checkin'
             WHEN 'student.checked_out'      THEN 'checkout'
             WHEN 'student.absent_at_cutoff' THEN 'absent'
             WHEN 'notice.published'         THEN 'notice'
             ELSE NULL
           END;
  IF v_key IS NULL THEN
    RETURN 0;
  END IF;

  IF v_key = 'checkout' AND NOT v_school.checkout_alerts_enabled THEN
    RETURN 0;
  END IF;

  -- Stale suppression: a scan that queued offline at 08:02 and syncs
  -- at 09:47 still renders "entered at 8:02 AM" - but if the school
  -- opted in, suppress alerts that would arrive uselessly late.
  IF v_key IN ('checkin', 'checkout')
     AND v_school.stale_alert_minutes IS NOT NULL
     AND now() - v_ev.occurred_at > make_interval(mins => v_school.stale_alert_minutes) THEN
    INSERT INTO public.alert_notifications (school_id, kind, severity, message, context)
    VALUES (v_ev.school_id, 'stale_suppressed', 'info',
            'Alert suppressed: scan synced more than '
              || v_school.stale_alert_minutes || ' minutes after it happened.',
            jsonb_build_object('event_id', v_ev.id, 'occurred_at', v_ev.occurred_at));
    RETURN 0;
  END IF;

  -- Template resolution. Notices carry their template id in the
  -- payload (any key); attendance events map to fixed keys.
  IF v_ev.type = 'notice.published' THEN
    SELECT mt.* INTO v_mt
    FROM   public.message_templates mt
    WHERE  mt.id        = NULLIF(v_ev.payload ->> 'message_template_id', '')::uuid
      AND  mt.school_id = v_ev.school_id;
  ELSE
    SELECT mt.* INTO v_mt
    FROM   public.message_templates mt
    WHERE  mt.school_id = v_ev.school_id
      AND  mt.key       = v_key;
  END IF;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  -- Approved channels in send-priority order (WA first: read rates).
  SELECT array_agg(sub.channel ORDER BY sub.prio)
  INTO   v_channels
  FROM (
    SELECT ct.channel,
           CASE ct.channel WHEN 'whatsapp' THEN 1 WHEN 'sms' THEN 2 ELSE 3 END AS prio
    FROM   public.channel_templates ct
    WHERE  ct.message_template_id = v_mt.id
      AND  ct.approval_status     = 'approved'
  ) sub;
  IF v_channels IS NULL THEN
    RETURN 0;
  END IF;

  v_class_filter := NULLIF(v_ev.payload ->> 'class_label', '');

  -- Spend guard: lock the row for the whole enqueue so two
  -- concurrent events cannot both slip under the cap.
  INSERT INTO public.spend_guard (school_id) VALUES (v_ev.school_id)
  ON CONFLICT (school_id) DO NOTHING;

  SELECT sg.daily_cap_paise,
         CASE WHEN sg.spent_date = v_local_date THEN sg.spent_today_paise ELSE 0 END
  INTO   v_cap, v_spent
  FROM   public.spend_guard sg
  WHERE  sg.school_id = v_ev.school_id
  FOR UPDATE;

  -- Candidates: one row per guardian (guard #2, guardian dedupe -
  -- a guardian with three children gets ONE notice), best contact
  -- method on the highest-priority approved channel, opted-out
  -- methods excluded (guard #1, consent).
  FOR r IN
    SELECT cand.guardian_id,
           cand.student_id,
           cand.student_name,
           cand.class_label,
           pick.channel,
           pick.value AS recipient
    FROM (
      SELECT DISTINCT ON (sg2.guardian_id)
             sg2.guardian_id,
             st.id        AS student_id,
             st.full_name AS student_name,
             st.class_label
      FROM   public.students st
      JOIN   public.student_guardians sg2 ON sg2.student_id = st.id
      WHERE  st.school_id = v_ev.school_id
        AND  st.is_active = true
        AND  (
               (v_ev.subject_id IS NOT NULL AND st.id = v_ev.subject_id)
            OR (v_ev.subject_id IS NULL
                AND (v_class_filter IS NULL OR st.class_label = v_class_filter))
             )
      ORDER BY sg2.guardian_id, st.full_name, st.id
    ) cand
    JOIN LATERAL (
      SELECT cm.channel, cm.value
      FROM   public.contact_methods cm
      WHERE  cm.guardian_id = cand.guardian_id
        AND  cm.opted_out   = false
        AND  cm.channel     = ANY (v_channels)
      ORDER BY array_position(v_channels, cm.channel), cm.created_at, cm.id
      LIMIT  1
    ) pick ON true
    ORDER BY pick.channel, cand.guardian_id
  LOOP
    SELECT ct.* INTO v_ct
    FROM   public.channel_templates ct
    WHERE  ct.message_template_id = v_mt.id
      AND  ct.channel             = r.channel
      AND  ct.approval_status     = 'approved';
    CONTINUE WHEN NOT FOUND;

    v_cost := public.alerts_message_cost(r.channel, v_ct.category);

    -- Guard #5, spend cap: checked before the insert, same txn.
    IF v_spent + v_cost > v_cap THEN
      INSERT INTO public.alert_notifications
             (school_id, kind, severity, message, context, dedup_key)
      VALUES (v_ev.school_id, 'spend_cap_hit', 'error',
              'Daily spend cap reached. Messages are NOT being sent. '
                || 'Raise the cap in settings if this is legitimate.',
              jsonb_build_object('event_id', v_ev.id,
                                 'cap_paise', v_cap, 'spent_paise', v_spent),
              'spend_cap:' || v_ev.school_id::text || ':' || v_local_date::text)
      ON CONFLICT (school_id, dedup_key) DO NOTHING;
      EXIT;
    END IF;

    -- Guard #4, token bucket per (school, channel): never drops,
    -- spreads. Refill on read, allow negative = queued backlog.
    INSERT INTO public.channel_rate_limits (school_id, channel)
    VALUES (v_ev.school_id, r.channel)
    ON CONFLICT (school_id, channel) DO NOTHING;

    UPDATE public.channel_rate_limits crl
    SET    tokens = LEAST(
             crl.capacity,
             crl.tokens + EXTRACT(EPOCH FROM (now() - crl.updated_at)) * crl.refill_per_sec
           ) - 1,
           updated_at = now()
    WHERE  crl.school_id = v_ev.school_id
      AND  crl.channel   = r.channel
    RETURNING crl.tokens, crl.refill_per_sec INTO v_tokens, v_refill;

    IF v_tokens < 0 THEN
      v_rate_delay := make_interval(secs => ((-v_tokens) / v_refill)::double precision);
    ELSE
      v_rate_delay := interval '0';
    END IF;

    -- Guard #3, quiet hours (21:00-06:30 local by default): queue
    -- for morning rather than buzz a parent at midnight.
    v_next := GREATEST(
      now() + v_rate_delay,
      public.alerts_quiet_release(now(), v_tz,
                                  v_school.quiet_hours_start, v_school.quiet_hours_end)
    );

    -- Render positional vars from occurred_at (NEVER now()).
    v_ctx := jsonb_build_object(
               'child',       r.student_name,
               'child_first', split_part(COALESCE(r.student_name, ''), ' ', 1),
               'school',      v_school.name,
               'class',       COALESCE(r.class_label, ''),
               'time',        to_char(v_ev.occurred_at AT TIME ZONE v_tz, 'HH12:MI AM'),
               'date',        to_char(v_ev.occurred_at AT TIME ZONE v_tz, 'DD Mon YYYY')
             ) || COALESCE(v_ev.payload -> 'vars', '{}'::jsonb);
    v_vars := public.alerts_render_vars(v_ct.var_map, v_ctx);

    -- Guard #2, dedupe: the unique constraint does the work.
    v_idem := encode(digest(v_ev.id::text || ':' || r.recipient || ':' || v_ct.id::text,
                            'sha256'), 'hex');

    INSERT INTO public.message_outbox
           (school_id, event_id, channel_template_id, channel, recipient, vars,
            next_attempt_at, cost_estimate_paise, idempotency_key,
            triggered_by, sent_by_user_id)
    VALUES (v_ev.school_id, v_ev.id, v_ct.id, r.channel, r.recipient, v_vars,
            v_next, v_cost, v_idem,
            COALESCE(v_ev.payload ->> 'triggered_by', 'system'),
            NULLIF(v_ev.payload ->> 'published_by', '')::uuid)
    ON CONFLICT (school_id, idempotency_key) DO NOTHING;

    IF FOUND THEN
      v_count := v_count + 1;
      v_spent := v_spent + v_cost;
    END IF;
  END LOOP;

  UPDATE public.spend_guard sg
  SET    spent_today_paise = v_spent,
         spent_date        = v_local_date
  WHERE  sg.school_id = v_ev.school_id;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.alerts_enqueue_for_event(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.alerts_enqueue_for_event(bigint) TO service_role;


-- ============================================================
-- SECTION 16: GATE SCAN -> EVENT (attendance trigger)
-- The existing offline scan flow keeps inserting into attendance
-- exactly as today. This AFTER INSERT trigger emits the event with
-- occurred_at = scan_time (the ORIGINAL scan moment, preserved by
-- the offline queue) and enqueues in the same transaction.
-- Any pipeline error is swallowed into alert_notifications -
-- alerts must never break the gate scan.
-- ============================================================

CREATE OR REPLACE FUNCTION public.handle_attendance_alert_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_enabled  boolean;
  v_event_id bigint;
  v_type     text;
  v_dedup    text;
BEGIN
  SELECT s.alerts_enabled INTO v_enabled
  FROM   public.schools s
  WHERE  s.id = NEW.school_id;

  IF NOT COALESCE(v_enabled, false) THEN
    RETURN NEW;
  END IF;

  -- Exam-day attendance (exam_id set) is not a gate event.
  IF NEW.exam_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF COALESCE(NEW.entry_type, 'entry') = 'exit' THEN
    v_type  := 'student.checked_out';
    v_dedup := 'checkout:' || NEW.student_id::text || ':'
                 || to_char(NEW.scan_date, 'YYYY-MM-DD');
  ELSE
    v_type  := 'student.checked_in';
    v_dedup := 'checkin:' || NEW.student_id::text || ':'
                 || to_char(NEW.scan_date, 'YYYY-MM-DD');
  END IF;

  BEGIN
    INSERT INTO public.events (school_id, type, subject_id, occurred_at, payload, dedup_key)
    VALUES (NEW.school_id, v_type, NEW.student_id,
            COALESCE(NEW.scan_time, now()),
            jsonb_build_object('attendance_id', NEW.id,
                               'gate',          NEW.gate,
                               'triggered_by',  'scan'),
            v_dedup)
    ON CONFLICT (school_id, dedup_key) DO NOTHING
    RETURNING id INTO v_event_id;

    IF v_event_id IS NOT NULL THEN
      PERFORM public.alerts_enqueue_for_event(v_event_id);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      INSERT INTO public.alert_notifications (school_id, kind, severity, message, context)
      VALUES (NEW.school_id, 'enqueue_error', 'error', left(SQLERRM, 500),
              jsonb_build_object('attendance_id', NEW.id));
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS attendance_emit_alert_event ON public.attendance;
CREATE TRIGGER attendance_emit_alert_event
  AFTER INSERT ON public.attendance
  FOR EACH ROW EXECUTE FUNCTION public.handle_attendance_alert_event();


-- ============================================================
-- SECTION 17: WORKER FUNCTIONS
-- pg_cron -> pg_net POST /api/worker (bearer secret) -> the route
-- loops ~50s: claim_outbox_batch -> decrypt credential (Node) ->
-- adapter.send -> complete_outbox_send. FOR UPDATE SKIP LOCKED is
-- the entire concurrency story: two workers never double-send.
-- ============================================================

CREATE OR REPLACE FUNCTION public.claim_outbox_batch(p_limit integer DEFAULT 100)
RETURNS SETOF public.message_outbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT mo.id
    FROM   public.message_outbox mo
    WHERE  mo.status IN ('queued', 'failed')
      AND  mo.next_attempt_at <= now()
    ORDER BY mo.next_attempt_at
    LIMIT  GREATEST(COALESCE(p_limit, 100), 1)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.message_outbox m
  SET    status = 'sending'
  FROM   picked p
  WHERE  m.id = p.id
  RETURNING m.*;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_outbox_batch(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_outbox_batch(integer) TO service_role;

-- Worker writes the send result. Backoff: 2^attempts * 30s with
-- 0.8-1.2 jitter; 6 attempts -> dead. Permanent 4xx ("template
-- rejected", "auth failed") -> dead immediately (p_permanent).
CREATE OR REPLACE FUNCTION public.complete_outbox_send(
  p_id                  bigint,
  p_status              text,      -- 'sent' | 'failed'
  p_provider_message_id text    DEFAULT NULL,
  p_error_code          text    DEFAULT NULL,
  p_error_message       text    DEFAULT NULL,
  p_permanent           boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_attempts integer;
BEGIN
  IF p_status NOT IN ('sent', 'failed') THEN
    RAISE EXCEPTION 'invalid_status';
  END IF;

  IF p_status = 'sent' THEN
    UPDATE public.message_outbox mo
    SET    status              = 'sent',
           provider_message_id = p_provider_message_id,
           sent_at             = now(),
           error_code          = NULL,
           error_message       = NULL
    WHERE  mo.id = p_id;
    RETURN;
  END IF;

  SELECT mo.attempts + 1 INTO v_attempts
  FROM   public.message_outbox mo
  WHERE  mo.id = p_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF p_permanent OR v_attempts >= 6 THEN
    UPDATE public.message_outbox mo
    SET    status        = 'dead',
           attempts      = v_attempts,
           error_code    = p_error_code,
           error_message = left(p_error_message, 1000)
    WHERE  mo.id = p_id;
  ELSE
    UPDATE public.message_outbox mo
    SET    status          = 'failed',
           attempts        = v_attempts,
           error_code      = p_error_code,
           error_message   = left(p_error_message, 1000),
           next_attempt_at = now()
                               + (power(2, v_attempts) * interval '30 seconds')
                               * (0.8 + random() * 0.4)
    WHERE  mo.id = p_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_outbox_send(bigint, text, text, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_outbox_send(bigint, text, text, text, text, boolean) TO service_role;

-- Delivery webhooks (POST /api/webhooks/:provider/:school_id,
-- signature verified in the route) land here. Forward-only:
-- sent -> delivered -> read; failed allowed from sent/delivered.
CREATE OR REPLACE FUNCTION public.apply_delivery_status(
  p_school_id           uuid,
  p_provider_message_id text,
  p_status              text,      -- 'delivered' | 'read' | 'failed'
  p_error_code          text DEFAULT NULL,
  p_error_message       text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_status NOT IN ('delivered', 'read', 'failed') THEN
    RAISE EXCEPTION 'invalid_status';
  END IF;

  UPDATE public.message_outbox mo
  SET    status        = p_status,
         error_code    = COALESCE(p_error_code, mo.error_code),
         error_message = COALESCE(left(p_error_message, 1000), mo.error_message)
  WHERE  mo.school_id           = p_school_id
    AND  mo.provider_message_id = p_provider_message_id
    AND  (
          (p_status = 'delivered' AND mo.status = 'sent')
       OR (p_status = 'read'      AND mo.status IN ('sent', 'delivered'))
       OR (p_status = 'failed'    AND mo.status IN ('sent', 'delivered'))
         );

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_delivery_status(uuid, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_delivery_status(uuid, text, text, text, text) TO service_role;

-- Worker verify/balance pass writes channel health. Unhealthy
-- transitions surface in alert_notifications with the gateway's
-- own error string verbatim - the school's conversation is then
-- with Meta/the DLT operator, not with us.
CREATE OR REPLACE FUNCTION public.set_channel_health(
  p_school_channel_id  uuid,
  p_health             text,
  p_balance_hint_paise integer DEFAULT NULL,
  p_detail             text    DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sc public.school_channels%ROWTYPE;
BEGIN
  IF p_health NOT IN ('unverified', 'ok', 'auth_failed', 'low_balance', 'suspended') THEN
    RAISE EXCEPTION 'invalid_health';
  END IF;

  UPDATE public.school_channels sc
  SET    health             = p_health,
         last_verified_at   = now(),
         balance_hint_paise = COALESCE(p_balance_hint_paise, sc.balance_hint_paise)
  WHERE  sc.id = p_school_channel_id
  RETURNING sc.* INTO v_sc;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF p_health IN ('auth_failed', 'low_balance', 'suspended') THEN
    INSERT INTO public.alert_notifications
           (school_id, kind, severity, message, context, dedup_key)
    VALUES (v_sc.school_id,
            CASE WHEN p_health = 'low_balance' THEN 'low_balance'
                 ELSE 'channel_unhealthy' END,
            'error',
            COALESCE(p_detail, 'Channel ' || v_sc.channel || ' (' || v_sc.provider
              || ') reported health: ' || p_health),
            jsonb_build_object('school_channel_id', v_sc.id, 'health', p_health),
            'health:' || v_sc.id::text || ':' || p_health || ':'
              || to_char(now(), 'YYYY-MM-DD'))
    ON CONFLICT (school_id, dedup_key) DO NOTHING;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.set_channel_health(uuid, text, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_channel_health(uuid, text, integer, text) TO service_role;


-- ============================================================
-- SECTION 18: ABSENT-AT-CUTOFF
-- The highest-value message in the product. Idempotent by
-- absent_runs (once per school per local day). Safety valve: if
-- NOBODY scanned in yet (holiday / scanner down), skip and notify
-- instead of telling 2,000 parents their child is missing; the
-- 5-minute cron retries until scans appear or the window ends.
-- ============================================================

CREATE OR REPLACE FUNCTION public.run_absent_cutoff()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_s         record;
  v_st        record;
  v_tz        text;
  v_local     timestamp;
  v_date      date;
  v_present   integer;
  v_event_id  bigint;
  v_emitted   integer;
  v_processed integer := 0;
BEGIN
  FOR v_s IN
    SELECT s.*
    FROM   public.schools s
    WHERE  s.alerts_enabled = true
      AND  s.is_active = true
      AND  s.absent_cutoff_time IS NOT NULL
  LOOP
    v_tz    := COALESCE(v_s.alerts_timezone, 'Asia/Kolkata');
    v_local := now() AT TIME ZONE v_tz;
    v_date  := v_local::date;

    CONTINUE WHEN v_local::time < v_s.absent_cutoff_time;
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM public.absent_runs ar
      WHERE  ar.school_id = v_s.id AND ar.run_date = v_date
    );

    SELECT count(*)::integer INTO v_present
    FROM   public.attendance a
    WHERE  a.school_id = v_s.id
      AND  a.scan_date = v_date;

    IF v_present = 0 THEN
      INSERT INTO public.alert_notifications
             (school_id, kind, severity, message, context, dedup_key)
      VALUES (v_s.id, 'absent_skipped_no_scans', 'warning',
              'Absence run skipped: no gate scans recorded today. '
                || 'Holiday, or is the scanner down?',
              jsonb_build_object('run_date', v_date),
              'absent_skip:' || v_s.id::text || ':' || v_date::text)
      ON CONFLICT (school_id, dedup_key) DO NOTHING;
      CONTINUE;
    END IF;

    INSERT INTO public.absent_runs (school_id, run_date)
    VALUES (v_s.id, v_date)
    ON CONFLICT (school_id, run_date) DO NOTHING;
    CONTINUE WHEN NOT FOUND;

    v_emitted := 0;

    FOR v_st IN
      SELECT st.id
      FROM   public.students st
      WHERE  st.school_id = v_s.id
        AND  st.is_active = true
        AND  NOT EXISTS (
               SELECT 1 FROM public.attendance a
               WHERE  a.school_id  = v_s.id
                 AND  a.student_id = st.id
                 AND  a.scan_date  = v_date
             )
    LOOP
      v_event_id := NULL;

      INSERT INTO public.events (school_id, type, subject_id, occurred_at, payload, dedup_key)
      VALUES (v_s.id, 'student.absent_at_cutoff', v_st.id,
              (v_date + v_s.absent_cutoff_time) AT TIME ZONE v_tz,
              jsonb_build_object('triggered_by', 'cutoff', 'run_date', v_date),
              'absent:' || v_st.id::text || ':' || v_date::text)
      ON CONFLICT (school_id, dedup_key) DO NOTHING
      RETURNING id INTO v_event_id;

      IF v_event_id IS NOT NULL THEN
        PERFORM public.alerts_enqueue_for_event(v_event_id);
        v_emitted := v_emitted + 1;
      END IF;
    END LOOP;

    UPDATE public.absent_runs ar
    SET    emitted_count = v_emitted
    WHERE  ar.school_id = v_s.id AND ar.run_date = v_date;

    v_processed := v_processed + 1;
  END LOOP;

  RETURN v_processed;
END;
$$;

REVOKE ALL ON FUNCTION public.run_absent_cutoff() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.run_absent_cutoff() TO service_role;


-- ============================================================
-- SECTION 19: COMPOSER + ONBOARDING RPCs
-- Schools cannot free-type messages: they pick an approved
-- channel_template and fill variables. TRAI and Meta do not
-- permit arbitrary content - that constraint is the product.
-- ============================================================

-- Publish an announcement. Emits notice.published and enqueues in
-- the same transaction. Guardian dedupe is handled by the enqueue
-- candidate query (one message per guardian, not per student).
CREATE OR REPLACE FUNCTION public.publish_notice(
  p_message_template_id uuid,
  p_vars                jsonb DEFAULT '{}'::jsonb,
  p_class_label         text  DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_role      text;
  v_mt        public.message_templates%ROWTYPE;
  v_enabled   boolean;
  v_notice_id uuid;
  v_event_id  bigint;
  v_queued    integer;
BEGIN
  v_role := public.get_my_role();
  IF v_role IS NULL OR v_role NOT IN ('super_admin', 'school_admin', 'operator') THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT mt.* INTO v_mt
  FROM   public.message_templates mt
  WHERE  mt.id = p_message_template_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'template_not_found';
  END IF;

  IF v_role <> 'super_admin' AND v_mt.school_id IS DISTINCT FROM public.get_my_school_id() THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT s.alerts_enabled INTO v_enabled
  FROM   public.schools s WHERE s.id = v_mt.school_id;
  IF NOT COALESCE(v_enabled, false) THEN
    RAISE EXCEPTION 'alerts_disabled';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.channel_templates ct
    WHERE  ct.message_template_id = v_mt.id
      AND  ct.approval_status     = 'approved'
  ) THEN
    RAISE EXCEPTION 'no_approved_channel_template';
  END IF;

  v_notice_id := gen_random_uuid();

  INSERT INTO public.events (school_id, type, subject_id, occurred_at, payload, dedup_key)
  VALUES (v_mt.school_id, 'notice.published', NULL, now(),
          jsonb_build_object(
            'message_template_id', v_mt.id,
            'notice_id',           v_notice_id,
            'vars',                COALESCE(p_vars, '{}'::jsonb),
            'class_label',         p_class_label,
            'published_by',        auth.uid(),
            'triggered_by',        'composer'
          ),
          'notice:' || v_notice_id::text)
  RETURNING id INTO v_event_id;

  v_queued := public.alerts_enqueue_for_event(v_event_id);

  RETURN jsonb_build_object(
    'event_id',  v_event_id,
    'notice_id', v_notice_id,
    'queued',    v_queued
  );
END;
$$;

REVOKE ALL ON FUNCTION public.publish_notice(uuid, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.publish_notice(uuid, jsonb, text) TO authenticated;

-- Composer confirm screen: recipient count + estimated cost incl
-- GST, BEFORE the send button goes live. Mirrors the enqueue
-- candidate query - keep the two in sync when either changes.
CREATE OR REPLACE FUNCTION public.estimate_notice_send(
  p_message_template_id uuid,
  p_class_label         text DEFAULT NULL
)
RETURNS TABLE (recipient_count integer, est_cost_paise bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  v_role     text;
  v_mt       public.message_templates%ROWTYPE;
  v_channels text[];
BEGIN
  v_role := public.get_my_role();
  IF v_role IS NULL OR v_role NOT IN ('super_admin', 'school_admin', 'operator') THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT mt.* INTO v_mt
  FROM   public.message_templates mt
  WHERE  mt.id = p_message_template_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'template_not_found';
  END IF;
  IF v_role <> 'super_admin' AND v_mt.school_id IS DISTINCT FROM public.get_my_school_id() THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT array_agg(sub.channel ORDER BY sub.prio)
  INTO   v_channels
  FROM (
    SELECT ct.channel,
           CASE ct.channel WHEN 'whatsapp' THEN 1 WHEN 'sms' THEN 2 ELSE 3 END AS prio
    FROM   public.channel_templates ct
    WHERE  ct.message_template_id = v_mt.id
      AND  ct.approval_status     = 'approved'
  ) sub;

  IF v_channels IS NULL THEN
    RETURN QUERY SELECT 0, 0::bigint;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT count(*)::integer,
         COALESCE(sum(public.alerts_message_cost(pick.channel, pick.category)), 0)::bigint
  FROM (
    SELECT DISTINCT ON (sg2.guardian_id) sg2.guardian_id
    FROM   public.students st
    JOIN   public.student_guardians sg2 ON sg2.student_id = st.id
    WHERE  st.school_id = v_mt.school_id
      AND  st.is_active = true
      AND  (p_class_label IS NULL OR st.class_label = p_class_label)
    ORDER BY sg2.guardian_id
  ) cand
  JOIN LATERAL (
    SELECT cm.channel, ct2.category
    FROM   public.contact_methods cm
    JOIN   public.channel_templates ct2
           ON  ct2.message_template_id = v_mt.id
           AND ct2.channel             = cm.channel
           AND ct2.approval_status     = 'approved'
    WHERE  cm.guardian_id = cand.guardian_id
      AND  cm.opted_out   = false
      AND  cm.channel     = ANY (v_channels)
    ORDER BY array_position(v_channels, cm.channel), cm.created_at, cm.id
    LIMIT  1
  ) pick ON true;
END;
$$;

REVOKE ALL ON FUNCTION public.estimate_notice_send(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.estimate_notice_send(uuid, text) TO authenticated;

-- Onboarding step 4, THE MOMENT: "[Send test message to my phone]".
-- Bypasses consent/dedupe guards (it is the admin's own number) but
-- still books the cost against the spend guard.
CREATE OR REPLACE FUNCTION public.send_test_message(
  p_channel_template_id uuid,
  p_recipient           text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_role   text;
  v_ct     public.channel_templates%ROWTYPE;
  v_school public.schools%ROWTYPE;
  v_tz     text;
  v_cost   integer;
  v_ctx    jsonb;
  v_id     bigint;
BEGIN
  v_role := public.get_my_role();
  IF v_role IS NULL OR v_role NOT IN ('super_admin', 'school_admin', 'operator') THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT ct.* INTO v_ct
  FROM   public.channel_templates ct
  WHERE  ct.id = p_channel_template_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'template_not_found';
  END IF;
  IF v_role <> 'super_admin' AND v_ct.school_id IS DISTINCT FROM public.get_my_school_id() THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;
  IF v_ct.approval_status <> 'approved' THEN
    RAISE EXCEPTION 'template_not_approved';
  END IF;

  SELECT s.* INTO v_school FROM public.schools s WHERE s.id = v_ct.school_id;
  v_tz   := COALESCE(v_school.alerts_timezone, 'Asia/Kolkata');
  v_cost := public.alerts_message_cost(v_ct.channel, v_ct.category);

  UPDATE public.spend_guard sg
  SET    spent_today_paise = CASE WHEN sg.spent_date = (now() AT TIME ZONE v_tz)::date
                                  THEN sg.spent_today_paise ELSE 0 END + v_cost,
         spent_date        = (now() AT TIME ZONE v_tz)::date
  WHERE  sg.school_id = v_ct.school_id;

  v_ctx := jsonb_build_object(
             'child',       'Test Student',
             'child_first', 'Test',
             'school',      v_school.name,
             'class',       '5-A',
             'time',        to_char(now() AT TIME ZONE v_tz, 'HH12:MI AM'),
             'date',        to_char(now() AT TIME ZONE v_tz, 'DD Mon YYYY'),
             'message',     'This is a test message from Schoolium Alerts.'
           );

  INSERT INTO public.message_outbox
         (school_id, channel_template_id, channel, recipient, vars,
          cost_estimate_paise, idempotency_key, triggered_by, sent_by_user_id)
  VALUES (v_ct.school_id, v_ct.id, v_ct.channel, p_recipient,
          public.alerts_render_vars(v_ct.var_map, v_ctx),
          v_cost,
          'test:' || gen_random_uuid()::text,
          'test', auth.uid())
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.send_test_message(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.send_test_message(uuid, text) TO authenticated;

-- Starter human-layer templates for a new school. Channel templates
-- (the approved artifacts) are created by the setup wizard per
-- provider - these are only the human-facing bodies.
CREATE OR REPLACE FUNCTION public.seed_default_message_templates(p_school_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role  text;
  v_count integer;
BEGIN
  v_role := public.get_my_role();
  IF v_role IS NULL
     OR (v_role <> 'super_admin'
         AND (v_role <> 'school_admin' OR p_school_id IS DISTINCT FROM public.get_my_school_id())) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  INSERT INTO public.message_templates (school_id, key, body)
  VALUES
    (p_school_id, 'checkin',  '{{child}} entered {{school}} at {{time}}.'),
    (p_school_id, 'checkout', '{{child}} left {{school}} at {{time}}.'),
    (p_school_id, 'absent',   '{{child}} was not marked present at {{school}} by {{time}} today. Please contact the school office if this is unexpected.'),
    (p_school_id, 'notice',   '{{school}}: {{message}}')
  ON CONFLICT (school_id, key) DO NOTHING;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.seed_default_message_templates(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.seed_default_message_templates(uuid) TO authenticated;

-- "Delivered to 412 parents. Read by 388." - the entire sales demo.
CREATE OR REPLACE FUNCTION public.get_notice_delivery_stats(p_event_id bigint)
RETURNS TABLE (
  n_total     bigint,
  n_queued    bigint,
  n_sent      bigint,
  n_delivered bigint,
  n_read      bigint,
  n_failed    bigint,
  n_dead      bigint,
  cost_paise  bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  v_school uuid;
  v_role   text;
BEGIN
  v_role := public.get_my_role();
  IF v_role IS NULL OR v_role NOT IN ('super_admin', 'school_admin', 'operator', 'principal') THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT ev.school_id INTO v_school
  FROM   public.events ev
  WHERE  ev.id = p_event_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'event_not_found';
  END IF;

  IF v_role <> 'super_admin'
     AND v_school IS DISTINCT FROM public.get_my_school_id() THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  RETURN QUERY
  SELECT count(*),
         count(*) FILTER (WHERE mo.status IN ('queued', 'sending')),
         count(*) FILTER (WHERE mo.status = 'sent'),
         count(*) FILTER (WHERE mo.status = 'delivered'),
         count(*) FILTER (WHERE mo.status = 'read'),
         count(*) FILTER (WHERE mo.status = 'failed'),
         count(*) FILTER (WHERE mo.status = 'dead'),
         COALESCE(sum(mo.cost_estimate_paise), 0)::bigint
  FROM   public.message_outbox mo
  WHERE  mo.event_id = p_event_id;
END;
$$;

REVOKE ALL ON FUNCTION public.get_notice_delivery_stats(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_notice_delivery_stats(bigint) TO authenticated;


-- ============================================================
-- SECTION 20: ROW LEVEL SECURITY
-- Every tenant table scoped by school_id via get_my_school_id()
-- (chat02) and get_my_role() (chat17). Writes to pipeline tables
-- happen only through SECURITY DEFINER functions / service role.
-- ============================================================

ALTER TABLE public.guardians           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.student_guardians   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contact_methods     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_templates   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_templates   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_outbox      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rate_card           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.spend_guard         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.school_channels     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.absent_runs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alert_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_batches      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_rows         ENABLE ROW LEVEL SECURITY;

-- Directory: admins + operators + receptionists manage, own school only.
DROP POLICY IF EXISTS "staff_manage_guardians" ON public.guardians;
CREATE POLICY "staff_manage_guardians"
  ON public.guardians FOR ALL
  USING (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin', 'operator', 'receptionist')
  )
  WITH CHECK (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin', 'operator', 'receptionist')
  );

DROP POLICY IF EXISTS "staff_manage_student_guardians" ON public.student_guardians;
CREATE POLICY "staff_manage_student_guardians"
  ON public.student_guardians FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.guardians g
      WHERE  g.id = student_guardians.guardian_id
        AND  g.school_id = public.get_my_school_id()
    )
    AND public.get_my_role() IN ('school_admin', 'operator', 'receptionist')
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.guardians g
      WHERE  g.id = student_guardians.guardian_id
        AND  g.school_id = public.get_my_school_id()
    )
    AND public.get_my_role() IN ('school_admin', 'operator', 'receptionist')
  );

DROP POLICY IF EXISTS "staff_manage_contact_methods" ON public.contact_methods;
CREATE POLICY "staff_manage_contact_methods"
  ON public.contact_methods FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.guardians g
      WHERE  g.id = contact_methods.guardian_id
        AND  g.school_id = public.get_my_school_id()
    )
    AND public.get_my_role() IN ('school_admin', 'operator', 'receptionist')
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.guardians g
      WHERE  g.id = contact_methods.guardian_id
        AND  g.school_id = public.get_my_school_id()
    )
    AND public.get_my_role() IN ('school_admin', 'operator', 'receptionist')
  );

-- Events: read-only for school staff; all writes via definer fns.
DROP POLICY IF EXISTS "staff_read_events" ON public.events;
CREATE POLICY "staff_read_events"
  ON public.events FOR SELECT
  USING (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin', 'operator', 'principal')
  );

-- Templates: admins manage; operators/principals read.
DROP POLICY IF EXISTS "admin_manage_message_templates" ON public.message_templates;
CREATE POLICY "admin_manage_message_templates"
  ON public.message_templates FOR ALL
  USING (school_id = public.get_my_school_id()
         AND public.get_my_role() = 'school_admin')
  WITH CHECK (school_id = public.get_my_school_id()
              AND public.get_my_role() = 'school_admin');

DROP POLICY IF EXISTS "staff_read_message_templates" ON public.message_templates;
CREATE POLICY "staff_read_message_templates"
  ON public.message_templates FOR SELECT
  USING (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin', 'operator', 'principal')
  );

DROP POLICY IF EXISTS "admin_manage_channel_templates" ON public.channel_templates;
CREATE POLICY "admin_manage_channel_templates"
  ON public.channel_templates FOR ALL
  USING (school_id = public.get_my_school_id()
         AND public.get_my_role() = 'school_admin')
  WITH CHECK (school_id = public.get_my_school_id()
              AND public.get_my_role() = 'school_admin');

DROP POLICY IF EXISTS "staff_read_channel_templates" ON public.channel_templates;
CREATE POLICY "staff_read_channel_templates"
  ON public.channel_templates FOR SELECT
  USING (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin', 'operator', 'principal')
  );

-- Outbox: the delivery ledger screen. Read-only; writes via worker.
DROP POLICY IF EXISTS "staff_read_message_outbox" ON public.message_outbox;
CREATE POLICY "staff_read_message_outbox"
  ON public.message_outbox FOR SELECT
  USING (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin', 'operator', 'principal')
  );

-- Rate card: global read (composer cost preview); no client writes.
DROP POLICY IF EXISTS "authenticated_read_rate_card" ON public.rate_card;
CREATE POLICY "authenticated_read_rate_card"
  ON public.rate_card FOR SELECT
  TO authenticated
  USING (true);

-- Spend guard: school admin sees own cap and burn; no client writes.
DROP POLICY IF EXISTS "admin_read_spend_guard" ON public.spend_guard;
CREATE POLICY "admin_read_spend_guard"
  ON public.spend_guard FOR SELECT
  USING (school_id = public.get_my_school_id()
         AND public.get_my_role() = 'school_admin');

-- channel_rate_limits, school_channels: RLS on, zero policies.
-- Deny-by-default for anon/authenticated; service role only.

-- Absent runs: staff read.
DROP POLICY IF EXISTS "staff_read_absent_runs" ON public.absent_runs;
CREATE POLICY "staff_read_absent_runs"
  ON public.absent_runs FOR SELECT
  USING (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin', 'operator', 'principal')
  );

-- Notifications: admin reads + marks read.
DROP POLICY IF EXISTS "admin_read_alert_notifications" ON public.alert_notifications;
CREATE POLICY "admin_read_alert_notifications"
  ON public.alert_notifications FOR SELECT
  USING (school_id = public.get_my_school_id()
         AND public.get_my_role() IN ('school_admin', 'operator'));

DROP POLICY IF EXISTS "admin_update_alert_notifications" ON public.alert_notifications;
CREATE POLICY "admin_update_alert_notifications"
  ON public.alert_notifications FOR UPDATE
  USING (school_id = public.get_my_school_id()
         AND public.get_my_role() IN ('school_admin', 'operator'))
  WITH CHECK (school_id = public.get_my_school_id()
              AND public.get_my_role() IN ('school_admin', 'operator'));

-- Import staging: admins + operators manage own school's batches.
DROP POLICY IF EXISTS "staff_manage_import_batches" ON public.import_batches;
CREATE POLICY "staff_manage_import_batches"
  ON public.import_batches FOR ALL
  USING (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin', 'operator')
  )
  WITH CHECK (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin', 'operator')
  );

DROP POLICY IF EXISTS "staff_manage_import_rows" ON public.import_rows;
CREATE POLICY "staff_manage_import_rows"
  ON public.import_rows FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.import_batches ib
      WHERE  ib.id = import_rows.batch_id
        AND  ib.school_id = public.get_my_school_id()
    )
    AND public.get_my_role() IN ('school_admin', 'operator')
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.import_batches ib
      WHERE  ib.id = import_rows.batch_id
        AND  ib.school_id = public.get_my_school_id()
    )
    AND public.get_my_role() IN ('school_admin', 'operator')
  );


-- ============================================================
-- SECTION 21: pg_cron JOBS
-- Guarded so the migration also applies cleanly on plain Postgres
-- (local validation harness) where pg_cron is absent.
-- ============================================================

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN

    -- Absent-at-cutoff sweep: every 5 min, 02:00-05:55 UTC
    -- (07:30-11:25 IST) - run_absent_cutoff() is per-school gated
    -- and idempotent, so the wide window is safe.
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'alerts-absent-cutoff') THEN
      PERFORM cron.unschedule('alerts-absent-cutoff');
    END IF;
    PERFORM cron.schedule(
      'alerts-absent-cutoff',
      '*/5 2-5 * * *',
      'SELECT public.run_absent_cutoff();'
    );

    -- Retention (blueprint section 12): message bodies purged after
    -- 12 months (ledger rows kept), events after 24. Monthly.
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'alerts-retention-purge') THEN
      PERFORM cron.unschedule('alerts-retention-purge');
    END IF;
    PERFORM cron.schedule(
      'alerts-retention-purge',
      '30 20 1 * *',
      'UPDATE public.message_outbox SET vars = ''{}''::jsonb, recipient = left(recipient, 5) || ''***'' '
        || 'WHERE created_at < now() - interval ''12 months'' AND vars <> ''{}''::jsonb; '
        || 'DELETE FROM public.events WHERE created_at < now() - interval ''24 months'';'
    );

  END IF;
END
$cron$;

-- The worker tick is scheduled AFTER /api/worker is deployed, since
-- it needs the deployment URL and bearer secret. Run manually then:
--
-- SELECT cron.schedule(
--   'alerts-worker-tick',
--   '* * * * *',
--   $$
--     SELECT net.http_post(
--       url     := 'YOUR_DEPLOYMENT_URL/api/worker',
--       headers := '{"Content-Type":"application/json","Authorization":"Bearer YOUR_WORKER_SECRET"}'::jsonb,
--       body    := '{}'::jsonb
--     );
--   $$
-- );
--
-- The route loops for ~50s polling claim_outbox_batch every 5s
-- during 07:00-10:00 IST (sub-10s latency through the morning
-- burst) and exits after one batch outside that window.


-- ============================================================
-- SECTION 22: RELOAD POSTGREST SCHEMA CACHE
-- ============================================================

NOTIFY pgrst, 'reload schema';


-- ============================================================
-- SECTION 23: VERIFICATION QUERIES (run after applying)
-- ============================================================

-- 1. New tables present:
 SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name IN
('guardians','student_guardians','contact_methods','events',
'message_templates','channel_templates','message_outbox',
'rate_card','spend_guard','channel_rate_limits','school_channels',
'absent_runs','alert_notifications','import_batches','import_rows');

-- 2. schools alert columns:
SELECT column_name FROM information_schema.columns
 WHERE table_name = 'schools' AND column_name IN
 ('alerts_enabled','alerts_timezone','absent_cutoff_time',
 'checkout_alerts_enabled','quiet_hours_start','quiet_hours_end',
  'stale_alert_minutes');

-- 3. Vault is unreachable from client roles (expect zero rows):
 SELECT grantee, privilege_type FROM information_schema.role_table_grants
 WHERE table_name = 'school_channels' AND grantee IN ('anon','authenticated');

-- 4. Outbox idempotency constraint:
 SELECT conname FROM pg_constraint
 WHERE conrelid = 'public.message_outbox'::regclass AND contype = 'u';

-- 5. Attendance trigger installed:
 SELECT tgname FROM pg_trigger
 WHERE tgrelid = 'public.attendance'::regclass AND tgname = 'attendance_emit_alert_event';

-- 6. pg_cron jobs:
SELECT jobname, schedule FROM cron.job
WHERE jobname IN ('alerts-absent-cutoff','alerts-retention-purge');

-- ============================================================
-- END OF MIGRATION chat21_alerts_byog_foundation
-- ============================================================
