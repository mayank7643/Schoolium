-- =============================================================================
-- Schoolium - Database Migration
-- File:    20260702120000_fix_bulk_fee_payment_atomicity_and_receipt_sequence.sql
-- Session: Chat 15
-- Author:  Senior Supabase / PostgreSQL Architect review of Chat 15
--
-- Fixes, in order of dependency:
--   1. Duplicate function overloads on record_bulk_fee_payment (7-arg vs 8-arg)
--      causing "could not choose the best candidate function".
--   2. A single-column UNIQUE(receipt_number) constraint that made it
--      impossible for one collection session to share a receipt number across
--      multiple payment rows, causing "duplicate key value violates unique
--      constraint fee_payments_receipt_number_key" on every multi-due payment.
--   3. Non-atomic due creation (ghost/orphan manual dues left behind when a
--      payment failed after a due had already been committed separately).
--
-- This file supersedes and replaces ALL prior receipt-number generation
-- strategies for record_bulk_fee_payment (random-insert-and-retry, and the
-- earlier per-month-seeded sequence). Do not reintroduce either approach.
--
-- Idempotent: every statement below is safe to run more than once against a
-- database already on this version.
--
-- Pure ASCII only, per project rule. Run top to bottom.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. FUNCTIONS: remove the obsolete overload
-- -----------------------------------------------------------------------------
-- An earlier CREATE OR REPLACE added a new parameter (p_new_dues), which
-- Postgres treats as a NEW overload rather than a replacement of the original.
-- Both signatures existed at once, so PostgREST could not disambiguate calls
-- made with the original 7 arguments. Drop the obsolete 7-arg overload only;
-- the 8-arg overload is redefined in step 4 below.
DROP FUNCTION IF EXISTS public.record_bulk_fee_payment(
  uuid, uuid, jsonb, text, date, uuid, text
);


-- -----------------------------------------------------------------------------
-- 2. CONSTRAINTS: fix the uniqueness grain on fee_payments
-- -----------------------------------------------------------------------------
-- The previous UNIQUE(receipt_number) constraint is incompatible with bulk
-- payments, where multiple fee_payments rows (one per due) intentionally
-- share a single receipt_number. The correct grain is one row per
-- (receipt_number, fee_due_id): many lines may share a receipt, but the same
-- due can never be inserted twice under the same receipt. This also closes a
-- latent duplicate-receipt collision in approve_payment_reversal(), which
-- writes 'REV-' || original_receipt and would otherwise collide across
-- multiple reversed lines of one bulk receipt.
ALTER TABLE public.fee_payments
  DROP CONSTRAINT IF EXISTS fee_payments_receipt_number_key;

ALTER TABLE public.fee_payments
  DROP CONSTRAINT IF EXISTS fee_payments_receipt_due_uniq;

ALTER TABLE public.fee_payments
  ADD CONSTRAINT fee_payments_receipt_due_uniq
  UNIQUE (receipt_number, fee_due_id);


-- -----------------------------------------------------------------------------
-- 3. SEQUENCES: dedicated receipt-number generator
-- -----------------------------------------------------------------------------
-- Replaces all prior receipt-number strategies (random INSERT + retry on
-- unique_violation; and, before that, a per-month SEQUENCE seeded from
-- max(existing) at creation time, which only seeded once and could be
-- permanently wrong against stale state). A dedicated sequence is unique by
-- construction, concurrency-safe under SELECT ... FOR UPDATE contention, and
-- reads no table state at generation time.
--
-- Starts at 100000 so every new receipt number is 6 digits and can never
-- collide with legacy 4-digit RCP-YYMM-XXXX values already issued.
-- Note: this sequence is global and monotonic; the numeric suffix does not
-- reset each calendar month even though the receipt string still embeds
-- YYMM. Uniqueness and chronological ordering both still hold.
CREATE SEQUENCE IF NOT EXISTS public.fee_receipt_seq
  START WITH 100000
  INCREMENT BY 1
  NO CYCLE;


-- -----------------------------------------------------------------------------
-- 4. FUNCTIONS: atomic record_bulk_fee_payment (final version)
-- -----------------------------------------------------------------------------
-- Same 8-argument signature as the version this replaces, so this is a true
-- in-place REPLACE, not a new overload. This is the ONLY entry point for
-- recording fee payments and/or creating manual dues.
--
-- Behavior:
--   - Verifies the caller is an active school_admin or collector for the
--     target school (tenant isolation), and that the student belongs to and
--     is active in that same school.
--   - Creates any NEW manual dues (p_new_dues) INSIDE this transaction, then
--     appends their pay instructions to the existing p_payments list. If
--     anything later in the function fails, Postgres rolls back everything,
--     including any due just inserted -- making orphan/ghost dues structurally
--     impossible rather than merely rare.
--   - Claims exactly ONE receipt number for the whole call via
--     nextval(fee_receipt_seq).
--   - Inserts one fee_payments row per due, all sharing that single receipt
--     number, row-locking each due with FOR UPDATE before applying it.
--   - Updates only fee_dues.amount_paid and .status -- balance is a
--     GENERATED ALWAYS column and must never be written directly.
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

  RETURN;
END;
$function$;


-- -----------------------------------------------------------------------------
-- 5. GRANTS: lock down the replaced function
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.record_bulk_fee_payment(
  uuid, uuid, jsonb, text, date, uuid, text, jsonb
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.record_bulk_fee_payment(
  uuid, uuid, jsonb, text, date, uuid, text, jsonb
) TO authenticated;

COMMIT;


-- -----------------------------------------------------------------------------
-- 6. SCHEMA CACHE: force PostgREST to see the replaced function immediately
-- -----------------------------------------------------------------------------
-- Not part of the transaction above by design -- NOTIFY should fire after the
-- DDL is committed, not inside it.
NOTIFY pgrst, 'reload schema';


-- =============================================================================
-- APPENDIX (OPTIONAL - MANUAL USE ONLY)
-- =============================================================================
-- The block below is DATA CLEANUP (DML), not schema migration, and is NOT
-- confirmed as executed anywhere in this chat session. It is destructive
-- (DELETE) and is intentionally kept OUT of the transactional migration above.
--
-- DO NOT wire this block into an automated migration pipeline or CI/CD.
-- Run STEP A by itself first, visually confirm the rows returned are the
-- expected orphaned/duplicate manual dues, and only then run STEP B.
-- =============================================================================

-- ---- STEP A: PREVIEW ONLY (read-only) --------------------------------------
-- rn = 1 is the original (kept). rn >= 2 are the extras that STEP B targets.
-- has_payment = true means money is attached to that due -- those rows are
-- never deleted; they only appear here so you can see them.
--
-- SELECT
--   d.id,
--   d.student_id,
--   d.label,
--   d.total_due,
--   d.amount_paid,
--   d.status,
--   d.created_at,
--   ROW_NUMBER() OVER (
--     PARTITION BY d.student_id, d.label, d.total_due
--     ORDER BY d.created_at
--   ) AS rn,
--   EXISTS (
--     SELECT 1 FROM public.fee_payments p WHERE p.fee_due_id = d.id
--   ) AS has_payment
-- FROM public.fee_dues d
-- WHERE d.source = 'manual'
-- ORDER BY d.student_id, d.label, d.total_due, d.created_at;

-- ---- STEP B: GUARDED DELETE (run only after reviewing STEP A) --------------
-- Guards: source = 'manual' only; rn >= 2 only (keeps the earliest of each
-- group); amount_paid = 0 and status = 'unpaid' only; never a due with a
-- fee_payments row attached.
--
-- WITH ranked AS (
--   SELECT
--     d.id,
--     ROW_NUMBER() OVER (
--       PARTITION BY d.student_id, d.label, d.total_due
--       ORDER BY d.created_at
--     ) AS rn,
--     EXISTS (
--       SELECT 1 FROM public.fee_payments p WHERE p.fee_due_id = d.id
--     ) AS has_payment
--   FROM public.fee_dues d
--   WHERE d.source = 'manual'
--     AND d.amount_paid = 0
--     AND d.status = 'unpaid'
-- )
-- DELETE FROM public.fee_dues
-- WHERE id IN (
--   SELECT id FROM ranked
--   WHERE rn >= 2
--     AND has_payment = false
-- );
