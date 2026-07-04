-- =============================================================================
-- Schoolium - CONSOLIDATED MIGRATION (Chat Session 16)
-- File: 20260704000000_chat16_fee_whatsapp_reversals_pin_and_summary.sql
--
-- Single, deduplicated, dependency-ordered migration for EVERY database change
-- discussed in Chat 16. Superseded / corrected / obsolete statements have been
-- removed (see the PR notes). Assumes all prior migrations (chat01..chat15)
-- already exist.
--
-- Contents:
--   1. Extensions (pgcrypto)
--   2. schools            - fee-WhatsApp feature flags
--   3. wa_message_log     - widened CHECK, ref columns, partial unique indexes
--   4. wa_outbox          - NEW queue table (+ indexes, trigger, RLS)
--   5. reversal_requests  - reversal_group_id (+ backfill + index)
--   6. fee_payments       - amount_paid CHECK allows REV- counter-transactions
--   7. storage            - fee-receipts bucket + admin read policy
--   8. Functions          - payments, outbox, reminders, PIN, reversals, summary
--   9. Cleanup            - drop obsolete overloads / superseded RPCs
--  10. pg_cron            - reminder sweep + outbox drain (edit placeholders)
--  11. NOTIFY pgrst
--
-- Pure ASCII. Idempotent. Multi-tenant: every function is SECURITY DEFINER,
-- verifies auth.uid() role + school, and is scoped by school_id.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. EXTENSIONS
-- -----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- crypt() / gen_salt() for the PIN


-- -----------------------------------------------------------------------------
-- 2. SCHOOLS - independent fee-WhatsApp feature flags (default OFF)
-- -----------------------------------------------------------------------------
ALTER TABLE public.schools
  ADD COLUMN IF NOT EXISTS wa_fee_reminders_enabled        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS wa_payment_confirmation_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS fee_reminder_days_before        INTEGER NOT NULL DEFAULT 3;

ALTER TABLE public.schools DROP CONSTRAINT IF EXISTS schools_fee_reminder_days_before_check;
ALTER TABLE public.schools ADD  CONSTRAINT schools_fee_reminder_days_before_check
  CHECK (fee_reminder_days_before BETWEEN 1 AND 30);

COMMENT ON COLUMN public.schools.wa_fee_reminders_enabled IS
  'Gate for WhatsApp fee reminders (due + overdue). Independent of wa_alerts_enabled.';
COMMENT ON COLUMN public.schools.wa_payment_confirmation_enabled IS
  'Gate for the on-payment WhatsApp confirmation with PDF receipt. Independent flag.';
COMMENT ON COLUMN public.schools.fee_reminder_days_before IS
  'Days before a due_date to send the "due soon" reminder. Default 3.';


-- -----------------------------------------------------------------------------
-- 3. WA_MESSAGE_LOG - allow new fee message types + correct dedup grain
-- -----------------------------------------------------------------------------
ALTER TABLE public.wa_message_log DROP CONSTRAINT IF EXISTS wa_message_log_message_type_check;
ALTER TABLE public.wa_message_log ADD  CONSTRAINT wa_message_log_message_type_check
  CHECK (message_type IN (
    'entry_alert', 'exit_alert', 'absence_alert',
    'fee_reminder',              -- legacy, kept for backward compatibility
    'fee_due_reminder', 'fee_overdue_reminder', 'fee_payment_confirmation'
  ));

ALTER TABLE public.wa_message_log
  ADD COLUMN IF NOT EXISTS ref_id   UUID NULL,   -- fee_due_id (reminders)
  ADD COLUMN IF NOT EXISTS ref_text TEXT NULL;   -- receipt_number (confirmations)

-- Replace the blanket per-day UNIQUE with three PARTIAL unique indexes.
ALTER TABLE public.wa_message_log DROP CONSTRAINT IF EXISTS wa_message_log_unique_per_day;

CREATE UNIQUE INDEX IF NOT EXISTS wa_log_uniq_attendance
  ON public.wa_message_log (school_id, student_id, log_date, message_type)
  WHERE message_type IN ('entry_alert', 'exit_alert', 'absence_alert', 'fee_reminder');

CREATE UNIQUE INDEX IF NOT EXISTS wa_log_uniq_fee_reminder
  ON public.wa_message_log (school_id, ref_id, message_type, log_date)
  WHERE message_type IN ('fee_due_reminder', 'fee_overdue_reminder');

CREATE UNIQUE INDEX IF NOT EXISTS wa_log_uniq_fee_confirmation
  ON public.wa_message_log (school_id, ref_text)
  WHERE message_type = 'fee_payment_confirmation';


-- -----------------------------------------------------------------------------
-- 4. WA_OUTBOX - the single queue for all fee WhatsApp sends
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wa_outbox (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id       UUID        NOT NULL REFERENCES public.schools(id)  ON DELETE CASCADE,
  student_id      UUID        NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  kind            TEXT        NOT NULL CHECK (kind IN (
                                'fee_due_reminder', 'fee_overdue_reminder', 'fee_payment_confirmation')),
  ref_id          UUID        NULL,    -- fee_due_id (reminders)
  ref_text        TEXT        NULL,    -- receipt_number (confirmations)
  payload         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  status          TEXT        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','processing','sent','failed','skipped')),
  attempt_count   SMALLINT    NOT NULL DEFAULT 0,
  max_attempts    SMALLINT    NOT NULL DEFAULT 5,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error      TEXT        NULL,
  sent_at         TIMESTAMPTZ NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.wa_outbox IS
  'Single queue for all fee-related WhatsApp sends, drained by /api/wa/worker with retry+backoff.';

CREATE UNIQUE INDEX IF NOT EXISTS wa_outbox_uniq_confirmation
  ON public.wa_outbox (school_id, ref_text) WHERE kind = 'fee_payment_confirmation';
CREATE INDEX IF NOT EXISTS idx_wa_outbox_pickup
  ON public.wa_outbox (status, next_attempt_at) WHERE status IN ('pending', 'processing');
CREATE INDEX IF NOT EXISTS idx_wa_outbox_school
  ON public.wa_outbox (school_id, created_at DESC);

-- set_updated_at() already exists from the Chat 10 migration.
DROP TRIGGER IF EXISTS wa_outbox_updated_at ON public.wa_outbox;
CREATE TRIGGER wa_outbox_updated_at
  BEFORE UPDATE ON public.wa_outbox
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.wa_outbox ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "school_admin_read_wa_outbox" ON public.wa_outbox;
CREATE POLICY "school_admin_read_wa_outbox" ON public.wa_outbox
  FOR SELECT USING (
    school_id IN (
      SELECT profiles.school_id FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.role = 'school_admin' AND profiles.is_active = true
    )
  );


-- -----------------------------------------------------------------------------
-- 5. REVERSAL_REQUESTS - group id for full/partial reversals
-- -----------------------------------------------------------------------------
ALTER TABLE public.reversal_requests ADD COLUMN IF NOT EXISTS reversal_group_id uuid;
UPDATE public.reversal_requests SET reversal_group_id = id WHERE reversal_group_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_reversal_requests_group ON public.reversal_requests (reversal_group_id);
COMMENT ON COLUMN public.reversal_requests.reversal_group_id IS
  'Lines requested for reversal together share one group id. Full = all lines; partial = a subset.';


-- -----------------------------------------------------------------------------
-- 6. FEE_PAYMENTS - allow negative amount only for REV- counter-transactions
-- -----------------------------------------------------------------------------
ALTER TABLE public.fee_payments DROP CONSTRAINT IF EXISTS fee_payments_amount_paid_check;
ALTER TABLE public.fee_payments ADD  CONSTRAINT fee_payments_amount_paid_check
  CHECK (amount_paid > 0 OR (amount_paid < 0 AND receipt_number LIKE 'REV-%'));


-- -----------------------------------------------------------------------------
-- 7. STORAGE - private fee-receipts bucket + admin read policy
-- -----------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public)
VALUES ('fee-receipts', 'fee-receipts', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "school_admin_read_fee_receipts" ON storage.objects;
CREATE POLICY "school_admin_read_fee_receipts" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'fee-receipts'
    AND (split_part(name, '/', 1))::uuid IN (
      SELECT p.school_id FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'school_admin' AND p.is_active = true
    )
  );


-- =============================================================================
-- 8. FUNCTIONS
-- =============================================================================

-- 8.1 record_bulk_fee_payment -------------------------------------------------
-- Drop the obsolete 7-arg overload, then REPLACE the 8-arg version in place.
-- Adds ONE exception-guarded confirmation enqueue (never rolls back a payment).
DROP FUNCTION IF EXISTS public.record_bulk_fee_payment(uuid, uuid, jsonb, text, date, uuid, text);

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
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
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
  SELECT p.role INTO v_role
  FROM public.profiles p
  WHERE p.id = auth.uid() AND p.school_id = p_school_id
    AND p.role IN ('school_admin', 'collector') AND p.is_active = TRUE;
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.students
    WHERE id = p_student_id AND school_id = p_school_id AND is_active = TRUE
  ) THEN
    RAISE EXCEPTION 'Student not found or not active in this school';
  END IF;

  v_all_items := COALESCE(p_payments, '[]'::jsonb);

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_new_dues)
  LOOP
    v_new_amount := (v_item->>'amount')::numeric(10,2);
    IF v_new_amount IS NULL OR v_new_amount <= 0 THEN
      RAISE EXCEPTION 'New due amount must be greater than zero';
    END IF;

    INSERT INTO public.fee_dues (
      school_id, student_id, fee_structure_id, fee_structure_item_id,
      source, fee_type, label, month, academic_year, due_date,
      base_amount, discount_amount, net_amount, late_fee_amount,
      total_due, amount_paid, status, notes
    ) VALUES (
      p_school_id, p_student_id, NULL, NULL,
      'manual', v_item->>'fee_type', v_item->>'label',
      v_item->>'month', v_item->>'academic_year', (v_item->>'due_date')::date,
      v_new_amount, 0, v_new_amount, 0, v_new_amount, 0, 'unpaid', p_notes
    )
    RETURNING id INTO v_new_due_id;

    v_pay_amount := COALESCE((v_item->>'pay_amount')::numeric(10,2), v_new_amount);
    IF v_pay_amount > 0 THEN
      v_all_items := v_all_items || jsonb_build_array(
        jsonb_build_object('due_id', v_new_due_id, 'amount', v_pay_amount));
    END IF;
  END LOOP;

  IF jsonb_array_length(v_all_items) = 0 THEN
    RAISE EXCEPTION 'No payable items in this request';
  END IF;

  v_receipt := 'RCP-' || to_char(now(), 'YYMM') || '-'
               || lpad(nextval('public.fee_receipt_seq')::text, 6, '0');

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_all_items)
  LOOP
    v_due_id := (v_item->>'due_id')::uuid;
    v_pay    := (v_item->>'amount')::numeric(10,2);
    IF v_pay IS NULL OR v_pay <= 0 THEN CONTINUE; END IF;

    SELECT * INTO v_due FROM public.fee_dues
    WHERE id = v_due_id AND school_id = p_school_id AND student_id = p_student_id
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Due % not found for this student', v_due_id; END IF;
    IF v_pay > v_due.balance THEN
      RAISE EXCEPTION 'Payment of % exceeds remaining balance % on due %', v_pay, v_due.balance, v_due_id;
    END IF;

    INSERT INTO public.fee_payments (
      school_id, student_id, fee_due_id, amount_paid, payment_method,
      receipt_number, paid_date, collected_by, notes
    ) VALUES (
      p_school_id, p_student_id, v_due_id, v_pay, p_payment_method,
      v_receipt, p_paid_date, p_collected_by, p_notes
    )
    RETURNING id INTO v_payment_id;

    v_new_paid := v_due.amount_paid + v_pay;
    v_new_status := CASE
      WHEN v_new_paid >= v_due.total_due THEN 'paid'
      WHEN v_new_paid >  0               THEN 'partial'
      ELSE                                    'unpaid'
    END;

    UPDATE public.fee_dues
    SET amount_paid = v_new_paid, status = v_new_status, updated_at = now()
    WHERE id = v_due_id;

    payment_id := v_payment_id; receipt_number := v_receipt;
    due_id := v_due_id; amount_paid := v_pay;
    RETURN NEXT;
  END LOOP;

  -- Best-effort confirmation enqueue (never blocks the payment).
  BEGIN
    SELECT s.wa_payment_confirmation_enabled INTO v_conf_on
    FROM public.schools s WHERE s.id = p_school_id;

    SELECT st.parent_phone_opted_out,
           (st.parent_phone IS NOT NULL AND btrim(st.parent_phone) <> '')
      INTO v_opted_out, v_has_phone
    FROM public.students st WHERE st.id = p_student_id;

    IF COALESCE(v_conf_on, false) AND COALESCE(v_has_phone, false)
       AND NOT COALESCE(v_opted_out, false) THEN
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
    RAISE WARNING 'record_bulk_fee_payment: confirmation enqueue failed for receipt % : %', v_receipt, SQLERRM;
  END;

  RETURN;
END;
$function$;

REVOKE ALL   ON FUNCTION public.record_bulk_fee_payment(uuid, uuid, jsonb, text, date, uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_bulk_fee_payment(uuid, uuid, jsonb, text, date, uuid, text, jsonb) TO authenticated;


-- 8.2 claim_wa_outbox ---------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_wa_outbox(p_limit integer DEFAULT 25)
RETURNS SETOF public.wa_outbox
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
BEGIN
  RETURN QUERY
  UPDATE public.wa_outbox o
  SET status = 'processing', updated_at = now()
  WHERE o.id IN (
    SELECT c.id FROM public.wa_outbox c
    WHERE (c.status = 'pending' AND c.next_attempt_at <= now())
       OR (c.status = 'processing' AND c.updated_at < now() - interval '10 minutes')
    ORDER BY c.next_attempt_at
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  )
  RETURNING o.*;
END;
$function$;

REVOKE ALL   ON FUNCTION public.claim_wa_outbox(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_wa_outbox(integer) TO service_role;


-- 8.3 enqueue_fee_reminders (daily sweep) -------------------------------------
CREATE OR REPLACE FUNCTION public.enqueue_fee_reminders()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
DECLARE
  v_enqueued integer := 0;
BEGIN
  WITH candidates AS (
    SELECT d.school_id, d.student_id, d.id AS due_id
    FROM public.fee_dues d
    JOIN public.schools  sc ON sc.id = d.school_id
    JOIN public.students st ON st.id = d.student_id
    WHERE sc.wa_fee_reminders_enabled = TRUE
      AND st.is_active = TRUE
      AND st.parent_phone IS NOT NULL AND btrim(st.parent_phone) <> ''
      AND st.parent_phone_opted_out = FALSE
      AND d.status IN ('unpaid', 'partial') AND d.balance > 0
      AND d.due_date = CURRENT_DATE + sc.fee_reminder_days_before
      AND NOT EXISTS (
        SELECT 1 FROM public.wa_message_log l
        WHERE l.school_id = d.school_id AND l.ref_id = d.id
          AND l.message_type = 'fee_due_reminder' AND l.log_date = CURRENT_DATE)
      AND NOT EXISTS (
        SELECT 1 FROM public.wa_outbox o
        WHERE o.school_id = d.school_id AND o.ref_id = d.id
          AND o.kind = 'fee_due_reminder' AND o.status IN ('pending', 'processing'))
  ),
  ins AS (
    INSERT INTO public.wa_outbox (school_id, student_id, kind, ref_id, status, next_attempt_at)
    SELECT school_id, student_id, 'fee_due_reminder', due_id, 'pending', now() FROM candidates
    RETURNING 1
  )
  SELECT v_enqueued + COALESCE(count(*), 0) INTO v_enqueued FROM ins;

  WITH candidates AS (
    SELECT d.school_id, d.student_id, d.id AS due_id
    FROM public.fee_dues d
    JOIN public.schools  sc ON sc.id = d.school_id
    JOIN public.students st ON st.id = d.student_id
    WHERE sc.wa_fee_reminders_enabled = TRUE
      AND st.is_active = TRUE
      AND st.parent_phone IS NOT NULL AND btrim(st.parent_phone) <> ''
      AND st.parent_phone_opted_out = FALSE
      AND d.status IN ('unpaid', 'partial') AND d.balance > 0
      AND d.due_date < CURRENT_DATE
      AND NOT EXISTS (
        SELECT 1 FROM public.wa_message_log l
        WHERE l.school_id = d.school_id AND l.ref_id = d.id
          AND l.message_type = 'fee_overdue_reminder' AND l.log_date > CURRENT_DATE - 7)
      AND NOT EXISTS (
        SELECT 1 FROM public.wa_outbox o
        WHERE o.school_id = d.school_id AND o.ref_id = d.id
          AND o.kind = 'fee_overdue_reminder' AND o.status IN ('pending', 'processing'))
  ),
  ins AS (
    INSERT INTO public.wa_outbox (school_id, student_id, kind, ref_id, status, next_attempt_at)
    SELECT school_id, student_id, 'fee_overdue_reminder', due_id, 'pending', now() FROM candidates
    RETURNING 1
  )
  SELECT v_enqueued + COALESCE(count(*), 0) INTO v_enqueued FROM ins;

  RETURN v_enqueued;
END;
$function$;

REVOKE ALL   ON FUNCTION public.enqueue_fee_reminders() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enqueue_fee_reminders() TO service_role;


-- 8.4 enqueue_fee_reminders_for (manual "send now") ---------------------------
CREATE OR REPLACE FUNCTION public.enqueue_fee_reminders_for(
  p_student_ids uuid[],
  p_type        text
)
RETURNS TABLE (outbox_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
DECLARE
  v_school uuid;
  v_kind   text;
BEGIN
  v_school := public.get_my_school_id();
  IF v_school IS NULL THEN RAISE EXCEPTION 'No school for caller'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND school_id = v_school AND role = 'school_admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  IF p_type NOT IN ('due', 'overdue') THEN RAISE EXCEPTION 'Invalid reminder type'; END IF;
  v_kind := CASE WHEN p_type = 'due' THEN 'fee_due_reminder' ELSE 'fee_overdue_reminder' END;

  IF NOT EXISTS (SELECT 1 FROM public.schools WHERE id = v_school AND wa_fee_reminders_enabled = true) THEN
    RAISE EXCEPTION 'feature_off';
  END IF;

  RETURN QUERY
  WITH picked AS (
    SELECT s.id AS student_id,
      (SELECT d.id FROM public.fee_dues d
       WHERE d.student_id = s.id AND d.school_id = v_school
         AND d.status IN ('unpaid', 'partial') AND d.balance > 0
       ORDER BY d.due_date ASC, d.created_at ASC LIMIT 1) AS due_id
    FROM public.students s
    WHERE s.id = ANY(p_student_ids) AND s.school_id = v_school AND s.is_active = true
      AND s.parent_phone IS NOT NULL AND btrim(s.parent_phone) <> ''
      AND s.parent_phone_opted_out = false
  ),
  ins AS (
    INSERT INTO public.wa_outbox (school_id, student_id, kind, ref_id, status, next_attempt_at)
    SELECT v_school, p.student_id, v_kind, p.due_id, 'pending', now()
    FROM picked p
    WHERE p.due_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.wa_outbox o
        WHERE o.school_id = v_school AND o.ref_id = p.due_id
          AND o.kind = v_kind AND o.status IN ('pending', 'processing'))
      AND NOT EXISTS (
        SELECT 1 FROM public.wa_message_log l
        WHERE l.school_id = v_school AND l.ref_id = p.due_id
          AND l.message_type = v_kind AND l.log_date = CURRENT_DATE)
    RETURNING id
  )
  SELECT id FROM ins;
END;
$function$;

REVOKE ALL   ON FUNCTION public.enqueue_fee_reminders_for(uuid[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enqueue_fee_reminders_for(uuid[], text) TO authenticated;


-- 8.5 Admin override PIN (bcrypt via pgcrypto) --------------------------------
-- NOTE: search_path includes extensions because pgcrypto lives there on Supabase.
CREATE OR REPLACE FUNCTION public.set_admin_override_pin(p_pin text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $function$
DECLARE
  v_school uuid;
BEGIN
  v_school := public.get_my_school_id();
  IF v_school IS NULL THEN RAISE EXCEPTION 'No school for caller'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND school_id = v_school AND role = 'school_admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  IF p_pin IS NULL OR btrim(p_pin) = '' THEN
    UPDATE public.schools SET admin_override_pin = NULL WHERE id = v_school;
    RETURN;
  END IF;

  IF btrim(p_pin) !~ '^[0-9]{4,6}$' THEN RAISE EXCEPTION 'PIN must be 4 to 6 digits'; END IF;

  UPDATE public.schools SET admin_override_pin = crypt(btrim(p_pin), gen_salt('bf')) WHERE id = v_school;
END;
$function$;

CREATE OR REPLACE FUNCTION public.verify_admin_override_pin(p_pin text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $function$
DECLARE
  v_school uuid;
  v_stored text;
BEGIN
  v_school := public.get_my_school_id();
  IF v_school IS NULL THEN RETURN false; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND school_id = v_school
      AND role IN ('school_admin', 'collector') AND is_active = true
  ) THEN
    RETURN false;
  END IF;

  SELECT admin_override_pin INTO v_stored FROM public.schools WHERE id = v_school;
  IF v_stored IS NULL OR p_pin IS NULL OR btrim(p_pin) = '' THEN RETURN false; END IF;

  IF left(v_stored, 2) = '$2' THEN            -- bcrypt hash
    RETURN v_stored = crypt(btrim(p_pin), v_stored);
  END IF;
  RETURN v_stored = btrim(p_pin);             -- legacy plaintext fallback
END;
$function$;

REVOKE ALL   ON FUNCTION public.set_admin_override_pin(text)    FROM PUBLIC;
REVOKE ALL   ON FUNCTION public.verify_admin_override_pin(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_admin_override_pin(text)    TO authenticated;
GRANT EXECUTE ON FUNCTION public.verify_admin_override_pin(text) TO authenticated;


-- 8.6 Full/partial reversals (group RPCs) -------------------------------------
CREATE OR REPLACE FUNCTION public.request_payment_reversals(
  p_fee_payment_ids uuid[],
  p_reason          text
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
DECLARE
  v_school uuid;
  v_group  uuid := gen_random_uuid();
  v_pay    record;
  v_count  integer := 0;
BEGIN
  SELECT p.school_id INTO v_school FROM public.profiles p
  WHERE p.id = auth.uid() AND p.role IN ('school_admin', 'collector') AND p.is_active = true;
  IF v_school IS NULL THEN RAISE EXCEPTION 'Access denied'; END IF;

  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is mandatory for reversal requests';
  END IF;
  IF p_fee_payment_ids IS NULL OR array_length(p_fee_payment_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'No payments selected';
  END IF;

  FOR v_pay IN
    SELECT fp.* FROM public.fee_payments fp
    WHERE fp.id = ANY(p_fee_payment_ids) AND fp.school_id = v_school
      AND COALESCE(fp.receipt_number, '') NOT LIKE 'REV-%'
      AND (fp.reversal_status IS NULL OR fp.reversal_status = 'reversal_rejected')
  LOOP
    INSERT INTO public.reversal_requests (school_id, fee_payment_id, requested_by, reason, reversal_group_id)
    VALUES (v_school, v_pay.id, auth.uid(), btrim(p_reason), v_group)
    ON CONFLICT (fee_payment_id) DO UPDATE SET
      status = 'pending', reason = EXCLUDED.reason, requested_by = EXCLUDED.requested_by,
      requested_at = now(), reviewed_by = NULL, reviewed_at = NULL,
      admin_notes = NULL, counter_payment_id = NULL, reversal_group_id = EXCLUDED.reversal_group_id;

    UPDATE public.fee_payments
    SET reversal_status = 'reversal_requested', reversal_reason = btrim(p_reason),
        reversal_requested_by = auth.uid(), reversal_requested_at = now()
    WHERE id = v_pay.id;

    INSERT INTO public.fee_audit_trail (school_id, actor_id, actor_role, event_type, student_id, fee_payment_id, notes)
    SELECT v_school, auth.uid(), p.role, 'reversal_requested', v_pay.student_id, v_pay.id, btrim(p_reason)
    FROM public.profiles p WHERE p.id = auth.uid();

    v_count := v_count + 1;
  END LOOP;

  IF v_count = 0 THEN
    RAISE EXCEPTION 'No eligible payments to reverse (already requested or reversed)';
  END IF;
  RETURN v_group;
END;
$function$;

CREATE OR REPLACE FUNCTION public.approve_reversal_group(
  p_group_id    uuid,
  p_admin_notes text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
DECLARE
  v_school     uuid;
  v_req        record;
  v_payment    record;
  v_due        record;
  v_counter_id uuid;
  v_new_paid   numeric(10,2);
  v_new_status text;
  v_count      integer := 0;
BEGIN
  SELECT p.school_id INTO v_school FROM public.profiles p
  WHERE p.id = auth.uid() AND p.role = 'school_admin' AND p.is_active = true;
  IF v_school IS NULL THEN
    RAISE EXCEPTION 'Access denied - school_admin role required for reversal approval';
  END IF;

  FOR v_req IN
    SELECT * FROM public.reversal_requests
    WHERE reversal_group_id = p_group_id AND school_id = v_school AND status = 'pending'
  LOOP
    SELECT * INTO v_payment FROM public.fee_payments WHERE id = v_req.fee_payment_id;
    SELECT * INTO v_due     FROM public.fee_dues     WHERE id = v_payment.fee_due_id;

    INSERT INTO public.fee_payments (
      school_id, student_id, fee_due_id, amount_paid, payment_method,
      receipt_number, paid_date, collected_by, notes, reversal_status
    ) VALUES (
      v_school, v_payment.student_id, v_payment.fee_due_id,
      -(v_payment.amount_paid), v_payment.payment_method,
      'REV-' || v_payment.receipt_number, CURRENT_DATE, auth.uid(),
      'REVERSAL of ' || v_payment.receipt_number || COALESCE(': ' || p_admin_notes, ''),
      'reversal_approved'
    )
    RETURNING id INTO v_counter_id;

    v_new_paid := GREATEST(v_due.amount_paid - v_payment.amount_paid, 0);
    v_new_status := CASE
      WHEN v_new_paid <= 0               THEN 'unpaid'
      WHEN v_new_paid >= v_due.total_due THEN 'paid'
      ELSE                                    'partial'
    END;

    UPDATE public.fee_dues SET amount_paid = v_new_paid, status = v_new_status, updated_at = now()
    WHERE id = v_due.id;

    UPDATE public.fee_payments
    SET reversal_status = 'reversal_approved', reversed_by = auth.uid(),
        reversed_at = now(), reversal_payment_id = v_counter_id
    WHERE id = v_req.fee_payment_id;

    UPDATE public.reversal_requests
    SET status = 'approved', reviewed_by = auth.uid(), reviewed_at = now(),
        admin_notes = p_admin_notes, counter_payment_id = v_counter_id
    WHERE id = v_req.id;

    INSERT INTO public.fee_audit_trail (school_id, actor_id, actor_role, event_type, student_id, fee_payment_id, notes)
    SELECT v_school, auth.uid(), p.role, 'reversal_approved', v_payment.student_id, v_req.fee_payment_id, p_admin_notes
    FROM public.profiles p WHERE p.id = auth.uid();

    v_count := v_count + 1;
  END LOOP;

  IF v_count = 0 THEN RAISE EXCEPTION 'No pending requests in this group'; END IF;
  RETURN v_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.reject_reversal_group(
  p_group_id    uuid,
  p_admin_notes text
)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
DECLARE
  v_school uuid;
  v_req    record;
  v_count  integer := 0;
BEGIN
  SELECT p.school_id INTO v_school FROM public.profiles p
  WHERE p.id = auth.uid() AND p.role = 'school_admin' AND p.is_active = true;
  IF v_school IS NULL THEN RAISE EXCEPTION 'Access denied - school_admin role required'; END IF;

  IF p_admin_notes IS NULL OR btrim(p_admin_notes) = '' THEN
    RAISE EXCEPTION 'Admin notes are mandatory when rejecting a reversal';
  END IF;

  FOR v_req IN
    SELECT * FROM public.reversal_requests
    WHERE reversal_group_id = p_group_id AND school_id = v_school AND status = 'pending'
  LOOP
    UPDATE public.reversal_requests
    SET status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now(), admin_notes = btrim(p_admin_notes)
    WHERE id = v_req.id;

    UPDATE public.fee_payments SET reversal_status = 'reversal_rejected' WHERE id = v_req.fee_payment_id;

    INSERT INTO public.fee_audit_trail (school_id, actor_id, actor_role, event_type, fee_payment_id, notes)
    SELECT v_school, auth.uid(), p.role, 'reversal_rejected', v_req.fee_payment_id, btrim(p_admin_notes)
    FROM public.profiles p WHERE p.id = auth.uid();

    v_count := v_count + 1;
  END LOOP;

  IF v_count = 0 THEN RAISE EXCEPTION 'No pending requests in this group'; END IF;
  RETURN v_count;
END;
$function$;

REVOKE ALL   ON FUNCTION public.request_payment_reversals(uuid[], text) FROM PUBLIC;
REVOKE ALL   ON FUNCTION public.approve_reversal_group(uuid, text)      FROM PUBLIC;
REVOKE ALL   ON FUNCTION public.reject_reversal_group(uuid, text)       FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_payment_reversals(uuid[], text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_reversal_group(uuid, text)      TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject_reversal_group(uuid, text)       TO authenticated;


-- 8.7 get_fee_summary ---------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_fee_summary(
  p_class_name text DEFAULT NULL,
  p_section    text DEFAULT NULL
)
RETURNS TABLE (
  student_id uuid, student_uid text, full_name text, father_name text,
  parent_phone text, class_name text, section text, due_count integer, outstanding numeric
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
DECLARE
  v_school uuid;
BEGIN
  SELECT p.school_id INTO v_school FROM public.profiles p
  WHERE p.id = auth.uid() AND p.role IN ('school_admin', 'collector') AND p.is_active = true;
  IF v_school IS NULL THEN RAISE EXCEPTION 'Access denied'; END IF;

  RETURN QUERY
  SELECT s.id, s.student_uid, s.full_name, s.father_name, s.parent_phone,
         c.name, c.section,
         COALESCE(d.due_count, 0)::integer, COALESCE(d.outstanding, 0)::numeric
  FROM public.students s
  LEFT JOIN public.classes c ON c.id = s.class_id
  LEFT JOIN LATERAL (
    SELECT count(*) AS due_count, sum(fd.balance) AS outstanding
    FROM public.fee_dues fd
    WHERE fd.student_id = s.id AND fd.status IN ('unpaid', 'partial') AND fd.balance > 0
  ) d ON true
  WHERE s.school_id = v_school AND s.is_active = true
    AND (p_class_name IS NULL OR c.name    = p_class_name)
    AND (p_section    IS NULL OR c.section = p_section)
  ORDER BY c.name NULLS LAST, c.section NULLS LAST, s.full_name;
END;
$function$;

REVOKE ALL   ON FUNCTION public.get_fee_summary(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_fee_summary(text, text) TO authenticated;


-- -----------------------------------------------------------------------------
-- 9. CLEANUP - drop obsolete single-line reversal RPCs (superseded by 8.6)
--    Skip this block only if external scripts still call these.
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.request_payment_reversal(uuid, text);
DROP FUNCTION IF EXISTS public.approve_payment_reversal(uuid);
DROP FUNCTION IF EXISTS public.reject_payment_reversal(uuid, text);

COMMIT;


-- =============================================================================
-- 10. pg_cron JOBS  (run AFTER the transaction; EDIT THE TWO PLACEHOLDERS)
--     Requires pg_cron + pg_net (already used by the Chat 10 retry job).
--       YOUR_WORKER_URL  -> https://<your-domain>/api/wa/worker
--       YOUR_CRON_SECRET -> the same value set as CRON_SECRET in Vercel
-- =============================================================================
SELECT cron.unschedule('enqueue-fee-reminders')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'enqueue-fee-reminders');

SELECT cron.schedule('enqueue-fee-reminders', '30 3 * * *',   -- 03:30 UTC = 09:00 IST
  $$ SELECT public.enqueue_fee_reminders(); $$);

SELECT cron.unschedule('drain-wa-outbox')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'drain-wa-outbox');

SELECT cron.schedule('drain-wa-outbox', '*/2 * * * *',
  $$
    SELECT net.http_post(
      url     := 'YOUR_WORKER_URL',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', 'YOUR_CRON_SECRET'),
      body    := '{}'::jsonb
    );
  $$);


-- -----------------------------------------------------------------------------
-- 11. Reload PostgREST schema cache
-- -----------------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';

-- =============================================================================
-- END - Schoolium Chat 16 consolidated migration
-- =============================================================================
