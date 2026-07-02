-- =============================================================================
-- Schoolium - Database Migration
-- File:    chat16_wa_fee_reminders_and_confirmation.sql
-- Session: Chat 16 - WhatsApp fee reminders (due + overdue) and on-payment
--          confirmation with PDF receipt.
--
-- WHAT THIS MIGRATION DOES (in dependency order):
--   1. schools: three new columns, all independent of wa_alerts_enabled:
--        - wa_fee_reminders_enabled        (due + overdue reminders)
--        - wa_payment_confirmation_enabled (on-payment WhatsApp + PDF receipt)
--        - fee_reminder_days_before        (how many days before due_date to
--                                           send the "due soon" reminder; def 3)
--   2. wa_message_log: widen the message_type CHECK to allow the new fee
--        message types; add ref_id (fee_due_id) and ref_text (receipt_number)
--        so fee messages dedup on the right grain; replace the single blanket
--        per-day UNIQUE with three PARTIAL unique indexes so attendance,
--        reminders, and confirmations each dedup correctly and independently.
--   3. wa_outbox: NEW table - the single queue every fee WhatsApp message flows
--        through. A Node worker (/api/wa/worker) drains it and does the Meta
--        send with retry + backoff, so no send ever blocks a payment or a page.
--   4. record_bulk_fee_payment: unchanged behaviour + one added, fully
--        exception-guarded step that enqueues a payment-confirmation row in the
--        SAME transaction. If enqueue fails for any reason the payment still
--        commits - a confirmation problem can NEVER roll back real money.
--   5. enqueue_fee_reminders(): the daily sweep. Finds dues that are 3 days from
--        due (per school setting) or overdue, respects the feature flag, opt-out,
--        and weekly-until-paid cadence, and enqueues outbox rows.
--   6. pg_cron: daily sweep at 09:00 IST (03:30 UTC) + worker ping every 2 min.
--
-- SUPERSEDES the scaffolded send-fee-reminder message_type scheme
-- ('fee_reminder_due_2025-06'), which violated the wa_message_log CHECK
-- constraint and could never have run. Do not reintroduce it.
--
-- Pure ASCII only, per project rule. Idempotent: safe to run top to bottom more
-- than once. Run in the Supabase SQL editor.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. SCHOOLS: independent feature flags for the fee WhatsApp features
-- -----------------------------------------------------------------------------
-- These are deliberately separate from wa_alerts_enabled (attendance). A school
-- can run attendance alerts without fee messages, or vice versa. Both default
-- FALSE, matching the project convention that every WA feature gate is opt-in.
ALTER TABLE public.schools
  ADD COLUMN IF NOT EXISTS wa_fee_reminders_enabled
    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS wa_payment_confirmation_enabled
    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS fee_reminder_days_before
    INTEGER NOT NULL DEFAULT 3;

-- Keep the "days before" setting sane (1..30).
ALTER TABLE public.schools
  DROP CONSTRAINT IF EXISTS schools_fee_reminder_days_before_check;

ALTER TABLE public.schools
  ADD CONSTRAINT schools_fee_reminder_days_before_check
  CHECK (fee_reminder_days_before BETWEEN 1 AND 30);

COMMENT ON COLUMN public.schools.wa_fee_reminders_enabled IS
  'Feature gate for WhatsApp fee reminders (due + overdue). '
  'Independent of wa_alerts_enabled (attendance). Default false.';
COMMENT ON COLUMN public.schools.wa_payment_confirmation_enabled IS
  'Feature gate for the on-payment WhatsApp confirmation with PDF receipt. '
  'Independent of wa_alerts_enabled and wa_fee_reminders_enabled. Default false.';
COMMENT ON COLUMN public.schools.fee_reminder_days_before IS
  'Days before a due_date to send the "due soon" reminder. Default 3.';


-- -----------------------------------------------------------------------------
-- 2. WA_MESSAGE_LOG: allow the new fee message types + correct dedup grain
-- -----------------------------------------------------------------------------
-- 2a. Widen the message_type CHECK. The old set only allowed attendance types
--     plus a legacy 'fee_reminder'. Add the three real fee types.
ALTER TABLE public.wa_message_log
  DROP CONSTRAINT IF EXISTS wa_message_log_message_type_check;

ALTER TABLE public.wa_message_log
  ADD CONSTRAINT wa_message_log_message_type_check
  CHECK (message_type IN (
    'entry_alert',
    'exit_alert',
    'absence_alert',
    'fee_reminder',              -- legacy value, kept for backward compatibility
    'fee_due_reminder',          -- new
    'fee_overdue_reminder',      -- new
    'fee_payment_confirmation'   -- new
  ));

-- 2b. Reference columns so fee messages dedup on the right thing:
--     - ref_id   = fee_due_id      (for reminders: one per due per type per day)
--     - ref_text = receipt_number  (for confirmations: exactly one per receipt)
ALTER TABLE public.wa_message_log
  ADD COLUMN IF NOT EXISTS ref_id   UUID NULL,
  ADD COLUMN IF NOT EXISTS ref_text TEXT NULL;

COMMENT ON COLUMN public.wa_message_log.ref_id IS
  'For fee reminders: the fee_due_id this reminder is about. NULL for others.';
COMMENT ON COLUMN public.wa_message_log.ref_text IS
  'For payment confirmations: the receipt_number. NULL for others.';

-- 2c. Replace the single blanket per-day UNIQUE with three PARTIAL unique
--     indexes so each message family dedups correctly and independently.
--     The old constraint keyed on (school_id, student_id, log_date, message_type)
--     would, for fee reminders, wrongly collapse two different dues due the same
--     day into one reminder. Partial indexes fix that.
ALTER TABLE public.wa_message_log
  DROP CONSTRAINT IF EXISTS wa_message_log_unique_per_day;

-- Attendance: one message per student per day per type (unchanged behaviour).
CREATE UNIQUE INDEX IF NOT EXISTS wa_log_uniq_attendance
  ON public.wa_message_log (school_id, student_id, log_date, message_type)
  WHERE message_type IN ('entry_alert', 'exit_alert', 'absence_alert', 'fee_reminder');

-- Fee reminders: one per due per type per day. The weekly-until-paid cadence for
-- overdue reminders is enforced in the sweep query (last sent >= 7 days ago),
-- NOT here - this index only prevents same-day duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS wa_log_uniq_fee_reminder
  ON public.wa_message_log (school_id, ref_id, message_type, log_date)
  WHERE message_type IN ('fee_due_reminder', 'fee_overdue_reminder');

-- Payment confirmations: exactly one per receipt, ever (no date component).
CREATE UNIQUE INDEX IF NOT EXISTS wa_log_uniq_fee_confirmation
  ON public.wa_message_log (school_id, ref_text)
  WHERE message_type = 'fee_payment_confirmation';


-- -----------------------------------------------------------------------------
-- 3. WA_OUTBOX: the single queue for all fee WhatsApp sends
-- -----------------------------------------------------------------------------
-- Rows are inserted by record_bulk_fee_payment (confirmations) and by
-- enqueue_fee_reminders (reminders). The Node worker at /api/wa/worker drains
-- rows where status='pending' and next_attempt_at <= now(), renders the PDF for
-- confirmations, calls Meta, then marks the row sent/failed. Backoff + a max
-- attempt cap keep a permanently-bad row from looping forever.
CREATE TABLE IF NOT EXISTS public.wa_outbox (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  school_id      UUID        NOT NULL
                             REFERENCES public.schools(id)  ON DELETE CASCADE,
  student_id     UUID        NOT NULL
                             REFERENCES public.students(id) ON DELETE CASCADE,

  -- What kind of message this row will become.
  kind           TEXT        NOT NULL
                             CHECK (kind IN (
                               'fee_due_reminder',
                               'fee_overdue_reminder',
                               'fee_payment_confirmation'
                             )),

  -- Reference to what the message is about (worker re-reads live data from these
  -- rather than trusting a stale snapshot):
  --   reminders     -> ref_id   = fee_due_id
  --   confirmations -> ref_text = receipt_number
  ref_id         UUID        NULL,
  ref_text       TEXT        NULL,

  -- Optional small hint payload (never the source of truth; worker re-queries).
  payload        JSONB       NOT NULL DEFAULT '{}'::jsonb,

  -- Queue state machine.
  status         TEXT        NOT NULL DEFAULT 'pending'
                             CHECK (status IN (
                               'pending',
                               'processing',
                               'sent',
                               'failed',
                               'skipped'
                             )),

  attempt_count  SMALLINT    NOT NULL DEFAULT 0,
  max_attempts   SMALLINT    NOT NULL DEFAULT 5,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error     TEXT        NULL,

  sent_at        TIMESTAMPTZ NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.wa_outbox IS
  'Single queue for all fee-related WhatsApp sends. Drained by the Node worker '
  '/api/wa/worker with retry + backoff. Confirmations are enqueued atomically '
  'inside record_bulk_fee_payment; reminders by enqueue_fee_reminders().';

-- Guard against duplicate confirmations at the queue level too (belt and
-- suspenders alongside the wa_message_log confirmation index): one pending/sent
-- confirmation per receipt.
CREATE UNIQUE INDEX IF NOT EXISTS wa_outbox_uniq_confirmation
  ON public.wa_outbox (school_id, ref_text)
  WHERE kind = 'fee_payment_confirmation';

-- Worker pickup index: cheaply find the next batch to process.
CREATE INDEX IF NOT EXISTS idx_wa_outbox_pickup
  ON public.wa_outbox (status, next_attempt_at)
  WHERE status IN ('pending', 'processing');

-- Admin visibility: a school's queue by recency.
CREATE INDEX IF NOT EXISTS idx_wa_outbox_school
  ON public.wa_outbox (school_id, created_at DESC);

-- updated_at trigger (set_updated_at already exists from the Chat 10 migration).
DROP TRIGGER IF EXISTS wa_outbox_updated_at ON public.wa_outbox;
CREATE TRIGGER wa_outbox_updated_at
  BEFORE UPDATE ON public.wa_outbox
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS: writes are service-role / SECURITY DEFINER only. School admins may read
-- their own school's queue (for a future "message status" admin view).
ALTER TABLE public.wa_outbox ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "school_admin_read_wa_outbox" ON public.wa_outbox;
CREATE POLICY "school_admin_read_wa_outbox"
  ON public.wa_outbox
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


-- -----------------------------------------------------------------------------
-- 4. RECORD_BULK_FEE_PAYMENT: same behaviour + atomic confirmation enqueue
-- -----------------------------------------------------------------------------
-- This is a true in-place REPLACE (identical 8-arg signature). Everything the
-- Chat 15 version did is preserved byte-for-byte. The ONLY addition is a single
-- enqueue step after the payment loop, wrapped in its own BEGIN/EXCEPTION block
-- so that ANY failure while enqueuing the confirmation is caught and swallowed
-- (RAISE WARNING) - it can never abort the payment transaction.
CREATE OR REPLACE FUNCTION public.record_bulk_fee_payment(
  p_school_id      uuid,
  p_student_id     uuid,
  p_payments       jsonb,
  p_payment_method text,
  p_paid_date      date,
  p_collected_by   uuid,
  p_notes          text  DEFAULT NULL,
  p_new_dues       jsonb DEFAULT '[]'::jsonb
)
RETURNS TABLE (payment_id uuid, receipt_number text, due_id uuid, amount_paid numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_role        text;
  v_receipt     text;
  v_item        jsonb;
  v_all_items   jsonb;
  v_due_id      uuid;
  v_pay         numeric(10,2);
  v_due         record;
  v_new_paid    numeric(10,2);
  v_new_status  text;
  v_payment_id  uuid;
  v_new_due_id  uuid;
  v_new_amount  numeric(10,2);
  v_pay_amount  numeric(10,2);
  v_conf_on     boolean;
  v_opted_out   boolean;
  v_has_phone   boolean;
BEGIN
  -- Caller must be an active admin or collector for this school.
  SELECT p.role INTO v_role
  FROM public.profiles p
  WHERE p.id        = auth.uid()
    AND p.school_id = p_school_id
    AND p.role      IN ('school_admin', 'collector')
    AND p.is_active = TRUE;

  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  -- Student must belong to this school and be active.
  IF NOT EXISTS (
    SELECT 1 FROM public.students
    WHERE id = p_student_id AND school_id = p_school_id AND is_active = TRUE
  ) THEN
    RAISE EXCEPTION 'Student not found or not active in this school';
  END IF;

  -- Begin with the payments against existing dues, then create any new manual
  -- dues in THIS transaction and append their payment instructions.
  v_all_items := COALESCE(p_payments, '[]'::jsonb);

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_new_dues)
  LOOP
    v_new_amount := (v_item->>'amount')::numeric(10,2);
    IF v_new_amount IS NULL OR v_new_amount <= 0 THEN
      RAISE EXCEPTION 'New due amount must be greater than zero';
    END IF;

    INSERT INTO public.fee_dues (
      school_id, student_id,
      fee_structure_id, fee_structure_item_id,
      source, fee_type, label,
      month, academic_year, due_date,
      base_amount, discount_amount, net_amount, late_fee_amount,
      total_due, amount_paid, status, notes
    ) VALUES (
      p_school_id, p_student_id,
      NULL, NULL,
      'manual',
      v_item->>'fee_type',
      v_item->>'label',
      v_item->>'month',
      v_item->>'academic_year',
      (v_item->>'due_date')::date,
      v_new_amount, 0, v_new_amount, 0,
      v_new_amount, 0, 'unpaid', p_notes
    )
    RETURNING id INTO v_new_due_id;

    v_pay_amount := COALESCE((v_item->>'pay_amount')::numeric(10,2), v_new_amount);
    IF v_pay_amount > 0 THEN
      v_all_items := v_all_items || jsonb_build_array(
        jsonb_build_object('due_id', v_new_due_id, 'amount', v_pay_amount)
      );
    END IF;
  END LOOP;

  IF jsonb_array_length(v_all_items) = 0 THEN
    RAISE EXCEPTION 'No payable items in this request';
  END IF;

  -- ONE receipt number for the whole session, unique by construction.
  v_receipt := 'RCP-' || to_char(now(), 'YYMM') || '-'
               || lpad(nextval('public.fee_receipt_seq')::text, 6, '0');

  -- One payment row per due, all sharing the single receipt number.
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_all_items)
  LOOP
    v_due_id := (v_item->>'due_id')::uuid;
    v_pay    := (v_item->>'amount')::numeric(10,2);

    IF v_pay IS NULL OR v_pay <= 0 THEN
      CONTINUE;
    END IF;

    SELECT * INTO v_due
    FROM public.fee_dues
    WHERE id         = v_due_id
      AND school_id  = p_school_id
      AND student_id = p_student_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Due % not found for this student', v_due_id;
    END IF;

    IF v_pay > v_due.balance THEN
      RAISE EXCEPTION 'Payment of % exceeds remaining balance % on due %',
        v_pay, v_due.balance, v_due_id;
    END IF;

    INSERT INTO public.fee_payments (
      school_id, student_id, fee_due_id,
      amount_paid, payment_method, receipt_number,
      paid_date, collected_by, notes
    ) VALUES (
      p_school_id, p_student_id, v_due_id,
      v_pay, p_payment_method, v_receipt,
      p_paid_date, p_collected_by, p_notes
    )
    RETURNING id INTO v_payment_id;

    v_new_paid := v_due.amount_paid + v_pay;
    v_new_status := CASE
      WHEN v_new_paid >= v_due.total_due THEN 'paid'
      WHEN v_new_paid >  0               THEN 'partial'
      ELSE                                    'unpaid'
    END;

    UPDATE public.fee_dues
    SET amount_paid = v_new_paid,
        status      = v_new_status,
        updated_at  = now()
    WHERE id = v_due_id;

    payment_id     := v_payment_id;
    receipt_number := v_receipt;
    due_id         := v_due_id;
    amount_paid    := v_pay;
    RETURN NEXT;
  END LOOP;

  -- ---------------------------------------------------------------------------
  -- CONFIRMATION ENQUEUE (best-effort, never blocks the payment)
  -- ---------------------------------------------------------------------------
  -- Enqueue exactly one payment-confirmation outbox row for this receipt IF the
  -- school has the feature on, the student has a phone, and the parent has not
  -- opted out. The whole block is exception-guarded: a confirmation problem must
  -- never roll back real money. The unique index wa_outbox_uniq_confirmation
  -- makes a duplicate enqueue a no-op (ON CONFLICT DO NOTHING).
  BEGIN
    SELECT s.wa_payment_confirmation_enabled INTO v_conf_on
    FROM public.schools s
    WHERE s.id = p_school_id;

    SELECT st.parent_phone_opted_out,
           (st.parent_phone IS NOT NULL AND btrim(st.parent_phone) <> '')
      INTO v_opted_out, v_has_phone
    FROM public.students st
    WHERE st.id = p_student_id;

    IF COALESCE(v_conf_on, false)
       AND COALESCE(v_has_phone, false)
       AND NOT COALESCE(v_opted_out, false)
    THEN
      INSERT INTO public.wa_outbox (
        school_id, student_id, kind, ref_text, payload, status, next_attempt_at
      ) VALUES (
        p_school_id, p_student_id, 'fee_payment_confirmation', v_receipt,
        jsonb_build_object('receipt_number', v_receipt, 'paid_date', p_paid_date),
        'pending', now()
      )
      ON CONFLICT DO NOTHING;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Swallow anything - payment integrity comes first.
    RAISE WARNING 'record_bulk_fee_payment: confirmation enqueue failed for receipt % : %',
      v_receipt, SQLERRM;
  END;

  RETURN;
END;
$function$;

REVOKE ALL ON FUNCTION public.record_bulk_fee_payment(
  uuid, uuid, jsonb, text, date, uuid, text, jsonb
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.record_bulk_fee_payment(
  uuid, uuid, jsonb, text, date, uuid, text, jsonb
) TO authenticated;


-- -----------------------------------------------------------------------------
-- 5. ENQUEUE_FEE_REMINDERS(): the daily sweep
-- -----------------------------------------------------------------------------
-- Called by pg_cron once a day. For every school with wa_fee_reminders_enabled,
-- it enqueues:
--   DUE SOON: dues whose due_date = today + school.fee_reminder_days_before,
--             not already reminded (guarded by the wa_message_log dedup + a
--             NOT EXISTS on an existing pending outbox row).
--   OVERDUE:  dues past due_date, weekly-until-paid - only if no overdue
--             reminder has been LOGGED for that due in the last 7 days.
-- Only active students with a phone and no opt-out, balance > 0, status
-- unpaid/partial. Returns the number of rows enqueued (handy for cron logs).
CREATE OR REPLACE FUNCTION public.enqueue_fee_reminders()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_enqueued integer := 0;
BEGIN
  -- DUE SOON --------------------------------------------------------------------
  WITH candidates AS (
    SELECT d.school_id, d.student_id, d.id AS due_id
    FROM public.fee_dues d
    JOIN public.schools  sc ON sc.id = d.school_id
    JOIN public.students st ON st.id = d.student_id
    WHERE sc.wa_fee_reminders_enabled = TRUE
      AND st.is_active = TRUE
      AND st.parent_phone IS NOT NULL
      AND btrim(st.parent_phone) <> ''
      AND st.parent_phone_opted_out = FALSE
      AND d.status IN ('unpaid', 'partial')
      AND d.balance > 0
      AND d.due_date = CURRENT_DATE + sc.fee_reminder_days_before
      -- not already logged as sent/pending today
      AND NOT EXISTS (
        SELECT 1 FROM public.wa_message_log l
        WHERE l.school_id    = d.school_id
          AND l.ref_id       = d.id
          AND l.message_type = 'fee_due_reminder'
          AND l.log_date     = CURRENT_DATE
      )
      -- not already queued and unprocessed
      AND NOT EXISTS (
        SELECT 1 FROM public.wa_outbox o
        WHERE o.school_id = d.school_id
          AND o.ref_id    = d.id
          AND o.kind      = 'fee_due_reminder'
          AND o.status IN ('pending', 'processing')
      )
  ),
  ins AS (
    INSERT INTO public.wa_outbox (school_id, student_id, kind, ref_id, status, next_attempt_at)
    SELECT school_id, student_id, 'fee_due_reminder', due_id, 'pending', now()
    FROM candidates
    RETURNING 1
  )
  SELECT v_enqueued + COALESCE(count(*), 0) INTO v_enqueued FROM ins;

  -- OVERDUE (weekly until paid) -------------------------------------------------
  WITH candidates AS (
    SELECT d.school_id, d.student_id, d.id AS due_id
    FROM public.fee_dues d
    JOIN public.schools  sc ON sc.id = d.school_id
    JOIN public.students st ON st.id = d.student_id
    WHERE sc.wa_fee_reminders_enabled = TRUE
      AND st.is_active = TRUE
      AND st.parent_phone IS NOT NULL
      AND btrim(st.parent_phone) <> ''
      AND st.parent_phone_opted_out = FALSE
      AND d.status IN ('unpaid', 'partial')
      AND d.balance > 0
      AND d.due_date < CURRENT_DATE
      -- weekly cadence: nothing sent for this due in the last 7 days
      AND NOT EXISTS (
        SELECT 1 FROM public.wa_message_log l
        WHERE l.school_id    = d.school_id
          AND l.ref_id       = d.id
          AND l.message_type = 'fee_overdue_reminder'
          AND l.log_date     > CURRENT_DATE - 7
      )
      -- not already queued and unprocessed
      AND NOT EXISTS (
        SELECT 1 FROM public.wa_outbox o
        WHERE o.school_id = d.school_id
          AND o.ref_id    = d.id
          AND o.kind      = 'fee_overdue_reminder'
          AND o.status IN ('pending', 'processing')
      )
  ),
  ins AS (
    INSERT INTO public.wa_outbox (school_id, student_id, kind, ref_id, status, next_attempt_at)
    SELECT school_id, student_id, 'fee_overdue_reminder', due_id, 'pending', now()
    FROM candidates
    RETURNING 1
  )
  SELECT v_enqueued + COALESCE(count(*), 0) INTO v_enqueued FROM ins;

  RETURN v_enqueued;
END;
$function$;

REVOKE ALL   ON FUNCTION public.enqueue_fee_reminders() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enqueue_fee_reminders() TO service_role;

COMMIT;


-- -----------------------------------------------------------------------------
-- 6. pg_cron jobs (run OUTSIDE the transaction above)
-- -----------------------------------------------------------------------------
-- Requires the pg_cron and pg_net extensions (already used by the Chat 10
-- retry job). Both jobs are idempotent by name.
--
-- IMPORTANT: replace the two placeholders before running:
--   YOUR_WORKER_URL   e.g. https://schoolium.vercel.app/api/wa/worker
--   YOUR_CRON_SECRET  the same value set as CRON_SECRET in Vercel env vars
--
-- The worker route validates the x-cron-secret header, so only these jobs (and
-- anyone holding the secret) can trigger a drain.

-- Job 1: daily reminder sweep at 03:30 UTC = 09:00 IST.
SELECT cron.unschedule('enqueue-fee-reminders') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'enqueue-fee-reminders'
);

SELECT cron.schedule(
  'enqueue-fee-reminders',
  '30 3 * * *',
  $$ SELECT public.enqueue_fee_reminders(); $$
);

-- Job 2: drain the outbox every 2 minutes (reminders + confirmations).
SELECT cron.unschedule('drain-wa-outbox') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'drain-wa-outbox'
);

SELECT cron.schedule(
  'drain-wa-outbox',
  '*/2 * * * *',
  $$
    SELECT net.http_post(
      url     := 'YOUR_WORKER_URL',
      headers := jsonb_build_object(
                   'Content-Type',  'application/json',
                   'x-cron-secret', 'YOUR_CRON_SECRET'
                 ),
      body    := '{}'::jsonb
    );
  $$
);


-- -----------------------------------------------------------------------------
-- 7. Force PostgREST to see the replaced/added functions immediately
-- -----------------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';


-- =============================================================================
-- VERIFY (optional - run after applying)
-- =============================================================================
-- New school columns:
-- SELECT column_name FROM information_schema.columns
-- WHERE table_name='schools'
--   AND column_name IN ('wa_fee_reminders_enabled','wa_payment_confirmation_enabled','fee_reminder_days_before');
--
-- wa_message_log new indexes:
-- SELECT indexname FROM pg_indexes WHERE tablename='wa_message_log'
--   AND indexname LIKE 'wa_log_uniq%';
--
-- wa_outbox exists:
-- SELECT to_regclass('public.wa_outbox');
--
-- Functions present:
-- SELECT routine_name FROM information_schema.routines
-- WHERE routine_name IN ('record_bulk_fee_payment','enqueue_fee_reminders');
--
-- Cron jobs:
-- SELECT jobname, schedule FROM cron.job
-- WHERE jobname IN ('enqueue-fee-reminders','drain-wa-outbox');
--
-- Dry-run the sweep (returns count enqueued, safe to run anytime):
-- SELECT public.enqueue_fee_reminders();
-- =============================================================================
-- END OF MIGRATION - Schoolium Chat 16
-- =============================================================================
