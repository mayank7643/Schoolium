-- ===========================================================================
-- SCHOOLIUM - Chat Session 14
-- Migration: chat14_atomic_bulk_payment.sql
-- Generated: 2026-07-02
--
-- SCOPE: This file contains ONLY the net-new database changes introduced
--        in Chat Session 14. All prior schema, tables, RLS, indexes, and
--        functions from Chat Sessions 01-13 are assumed to already exist.
--
-- SAFE TO RUN ON: a database that has chat13_schoolium_unified_billing.sql
--                 and all prior migrations already applied.
--
-- RUN ORDER: Run this file once, in its entirety, in the Supabase SQL Editor
--            or via psql. Both statements are idempotent (CREATE OR REPLACE).
-- ===========================================================================


-- ===========================================================================
-- SECTION 1 - REPLACE record_bulk_fee_payment (FINAL / v5)
--
-- WHY THIS REPLACES ALL PRIOR VERSIONS:
--
--   v1  Rejected - missing actor_role (NOT NULL on fee_audit_trail),
--       tried to INSERT into delta (GENERATED ALWAYS column).
--
--   v2  Rejected - "column reference receipt_number is ambiguous":
--       the RETURNS TABLE output column shared the name receipt_number
--       with the real table column inside the uniqueness check subquery.
--
--   v3  Rejected - switched to a per-month SEQUENCE seeded from MAX()
--       of existing receipt numbers. Fragile by design: seeding only
--       runs at sequence-creation time, so a pre-existing sequence from
--       an earlier failed attempt was never re-seeded. Caused the same
--       duplicate-key error. Also had non-ASCII characters (em dashes,
--       box-drawing chars) in comments that corrupted copy-paste into
--       the Supabase editor ("syntax error at or near t3").
--
--   v4  Receipt logic correct (retry on real unique_violation confirmed
--       via pg_proc source inspection: has_retry_logic = true). BUT the
--       true root-cause bug was not in receipt generation at all - it was
--       non-atomic due creation. The collect page called create_manual_due()
--       as a separate, committed database call BEFORE attempting payment.
--       Any payment failure left the just-created due permanently behind
--       as an orphan. Retrying re-created it. Confirmed live: user cleared
--       all dues, reproduced from clean slate, duplicate appeared again
--       immediately, proving it was a current code bug, not leftover data.
--       Missing the p_new_dues parameter needed for the atomic fix.
--
--   v5  THIS VERSION. Adds p_new_dues JSONB parameter. New manual dues
--       are inserted INSIDE this function, in the same Postgres transaction
--       as the payment. If anything fails - including deep in the receipt
--       retry loop - Postgres rolls back everything this function did,
--       including any due it had just inserted. Ghost-due creation is now
--       structurally impossible. Confirmed deployed (user: "SQL runned").
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.record_bulk_fee_payment(
  p_school_id       UUID,
  p_student_id      UUID,
  p_payments        JSONB,                     -- [{due_id, amount}, ...] for EXISTING dues
  p_payment_method  TEXT,
  p_paid_date       DATE,
  p_collected_by    UUID,
  p_notes           TEXT    DEFAULT NULL,
  p_new_dues        JSONB   DEFAULT '[]'::JSONB -- [{fee_type, label, amount, due_date, month,
                                                --   academic_year, pay_amount}, ...]
                                                -- New manual dues created + paid atomically.
                                                -- pay_amount <= amount (supports partial collect).
                                                -- Omit pay_amount to collect the full amount.
)
RETURNS TABLE (
  payment_id      UUID,
  receipt_number  TEXT,
  due_id          UUID,
  amount_paid     NUMERIC(10,2)
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_receipt        TEXT;
  v_item           JSONB;
  v_due_id         UUID;
  v_amount         NUMERIC(10,2);
  v_due            RECORD;
  v_payment_id     UUID;
  v_new_paid       NUMERIC(10,2);
  v_new_status     TEXT;
  v_role           TEXT;
  v_first_due_id   UUID;
  v_first_amount   NUMERIC(10,2);
  v_attempt        INT;
  v_max_attempts   CONSTANT INT := 20;
  v_new_due_id     UUID;
  v_pay_amount     NUMERIC(10,2);
  v_all_items      JSONB;
BEGIN

  -- -----------------------------------------------------------------------
  -- AUTH: caller must be an active school_admin or collector for this school
  -- -----------------------------------------------------------------------
  SELECT p.role INTO v_role
  FROM public.profiles p
  WHERE p.id        = auth.uid()
    AND p.school_id = p_school_id
    AND p.role      IN ('school_admin', 'collector')
    AND p.is_active = TRUE;

  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  -- -----------------------------------------------------------------------
  -- VALIDATE: student belongs to this school and is active
  -- -----------------------------------------------------------------------
  IF NOT EXISTS (
    SELECT 1 FROM public.students
    WHERE id        = p_student_id
      AND school_id = p_school_id
      AND is_active = TRUE
  ) THEN
    RAISE EXCEPTION 'Student not found or not active in this school';
  END IF;

  -- -----------------------------------------------------------------------
  -- STEP 1: Create any new manual dues IN THIS TRANSACTION.
  --
  -- This is the fix for the ghost-due bug. Previously create_manual_due()
  -- was called from the client as a separate committed transaction before
  -- the payment RPC, so a payment failure left the due behind permanently.
  -- By creating dues here, any failure anywhere in this function causes
  -- Postgres to automatically roll back the due insertions as well.
  -- -----------------------------------------------------------------------
  v_all_items := p_payments;   -- start with the existing-dues array

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_new_dues)
  LOOP
    IF (v_item->>'amount')::NUMERIC(10,2) IS NULL
       OR (v_item->>'amount')::NUMERIC(10,2) <= 0 THEN
      RAISE EXCEPTION 'New due amount must be greater than zero';
    END IF;

    INSERT INTO public.fee_dues (
      school_id,      student_id,
      fee_structure_id,            -- NULL for manual dues
      fee_structure_item_id,       -- NULL for manual dues
      source,         fee_type,    label,
      month,          academic_year,
      due_date,
      base_amount,    discount_amount,
      net_amount,     late_fee_amount,
      total_due,      amount_paid,
      status,         notes
    ) VALUES (
      p_school_id,    p_student_id,
      NULL,           NULL,
      'manual',
      v_item->>'fee_type',
      v_item->>'label',
      v_item->>'month',
      v_item->>'academic_year',
      (v_item->>'due_date')::DATE,
      (v_item->>'amount')::NUMERIC(10,2),   -- base_amount
      0,                                    -- discount_amount
      (v_item->>'amount')::NUMERIC(10,2),   -- net_amount = base (no discount on manual)
      0,                                    -- late_fee_amount
      (v_item->>'amount')::NUMERIC(10,2),   -- total_due
      0,                                    -- amount_paid
      'unpaid',
      p_notes
    )
    RETURNING id INTO v_new_due_id;

    -- How much to collect now (defaults to the full amount if omitted)
    v_pay_amount := COALESCE(
      NULLIF(v_item->>'pay_amount', '')::NUMERIC(10,2),
      (v_item->>'amount')::NUMERIC(10,2)
    );

    IF v_pay_amount > 0 THEN
      -- Append this new due to the unified payment list
      v_all_items := v_all_items || jsonb_build_array(
        jsonb_build_object('due_id', v_new_due_id, 'amount', v_pay_amount)
      );
    END IF;
  END LOOP;

  -- -----------------------------------------------------------------------
  -- STEP 2: Identify the first payable item - used to claim the receipt.
  -- -----------------------------------------------------------------------
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_all_items)
  LOOP
    v_first_due_id := (v_item->>'due_id')::UUID;
    v_first_amount := (v_item->>'amount')::NUMERIC(10,2);
    IF v_first_amount > 0 THEN
      EXIT;   -- found first non-zero item
    END IF;
  END LOOP;

  IF v_first_due_id IS NULL THEN
    RAISE EXCEPTION 'No payable items in this request';
  END IF;

  -- Verify the first due belongs to this school and student
  SELECT * INTO v_due
  FROM public.fee_dues
  WHERE id         = v_first_due_id
    AND school_id  = p_school_id
    AND student_id = p_student_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fee due % not found or access denied', v_first_due_id;
  END IF;

  IF v_due.status = 'waived' THEN
    RAISE EXCEPTION 'Cannot collect payment on a waived due (due_id: %)', v_first_due_id;
  END IF;

  -- -----------------------------------------------------------------------
  -- STEP 3: Claim a receipt number by genuinely attempting INSERT,
  --         retrying ONLY when Postgres's own UNIQUE constraint fires.
  --
  -- This is structurally correct: no pre-check that could be stale,
  -- no sequence that seeds only once, no race window between check and
  -- insert. The random suffix space is 90,000 values per month-bucket;
  -- at any realistic school volume the first attempt will succeed.
  -- -----------------------------------------------------------------------
  v_attempt := 0;
  LOOP
    v_attempt := v_attempt + 1;

    v_receipt := 'RCP-' || TO_CHAR(NOW(), 'YYMM') || '-' ||
                 LPAD((FLOOR(RANDOM() * 90000) + 10000)::TEXT, 5, '0');

    BEGIN
      INSERT INTO public.fee_payments (
        school_id,      student_id,     fee_due_id,
        amount_paid,    payment_method, receipt_number,
        paid_date,      collected_by,   notes
      ) VALUES (
        p_school_id,    p_student_id,   v_first_due_id,
        v_first_amount, p_payment_method, v_receipt,
        p_paid_date,    p_collected_by, p_notes
      )
      RETURNING id INTO v_payment_id;

      EXIT;   -- INSERT succeeded: v_receipt is now proven unique

    EXCEPTION WHEN unique_violation THEN
      IF v_attempt >= v_max_attempts THEN
        RAISE EXCEPTION
          'Could not generate a unique receipt number after % attempts', v_max_attempts;
      END IF;
      -- loop again with a fresh random candidate
    END;
  END LOOP;

  -- Update the first due's balance
  v_new_paid   := v_due.amount_paid + v_first_amount;
  v_new_status := CASE
    WHEN v_new_paid >= v_due.total_due THEN 'paid'
    WHEN v_new_paid > 0               THEN 'partial'
    ELSE                                   'unpaid'
  END;

  UPDATE public.fee_dues
  SET amount_paid = v_new_paid,
      status      = v_new_status
  WHERE id = v_first_due_id;

  -- Audit trail - actor_role is required (NOT NULL); delta is GENERATED ALWAYS (omitted)
  INSERT INTO public.fee_audit_trail (
    school_id,      actor_id,       actor_role,     event_type,
    student_id,     fee_payment_id,
    original_value, submitted_value,
    notes
  ) VALUES (
    p_school_id,    p_collected_by, v_role,         'payment_collected',
    p_student_id,   v_payment_id,
    v_due.total_due, v_first_amount,
    p_notes
  );

  -- Yield the first row to the caller
  payment_id     := v_payment_id;
  receipt_number := v_receipt;
  due_id         := v_first_due_id;
  amount_paid    := v_first_amount;
  RETURN NEXT;

  -- -----------------------------------------------------------------------
  -- STEP 4: Process every remaining item using the CONFIRMED receipt.
  --         v_receipt is already proven unique; no retry needed here.
  -- -----------------------------------------------------------------------
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_all_items)
  LOOP
    v_due_id := (v_item->>'due_id')::UUID;
    v_amount  := (v_item->>'amount')::NUMERIC(10,2);

    -- Skip the item we already processed and any zero-amount items
    IF v_due_id = v_first_due_id OR v_amount <= 0 THEN
      CONTINUE;
    END IF;

    SELECT * INTO v_due
    FROM public.fee_dues
    WHERE id         = v_due_id
      AND school_id  = p_school_id
      AND student_id = p_student_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Fee due % not found or access denied', v_due_id;
    END IF;

    IF v_due.status = 'waived' THEN
      RAISE EXCEPTION 'Cannot collect payment on a waived due (due_id: %)', v_due_id;
    END IF;

    INSERT INTO public.fee_payments (
      school_id,    student_id,     fee_due_id,
      amount_paid,  payment_method, receipt_number,
      paid_date,    collected_by,   notes
    ) VALUES (
      p_school_id,  p_student_id,   v_due_id,
      v_amount,     p_payment_method, v_receipt,  -- same receipt number
      p_paid_date,  p_collected_by, p_notes
    )
    RETURNING id INTO v_payment_id;

    v_new_paid   := v_due.amount_paid + v_amount;
    v_new_status := CASE
      WHEN v_new_paid >= v_due.total_due THEN 'paid'
      WHEN v_new_paid > 0               THEN 'partial'
      ELSE                                   'unpaid'
    END;

    UPDATE public.fee_dues
    SET amount_paid = v_new_paid,
        status      = v_new_status
    WHERE id = v_due_id;

    INSERT INTO public.fee_audit_trail (
      school_id,      actor_id,       actor_role,     event_type,
      student_id,     fee_payment_id,
      original_value, submitted_value,
      notes
    ) VALUES (
      p_school_id,    p_collected_by, v_role,         'payment_collected',
      p_student_id,   v_payment_id,
      v_due.total_due, v_amount,
      p_notes
    );

    payment_id     := v_payment_id;
    receipt_number := v_receipt;
    due_id         := v_due_id;
    amount_paid    := v_amount;
    RETURN NEXT;
  END LOOP;

END;
$$;

-- Permissions
REVOKE ALL   ON FUNCTION public.record_bulk_fee_payment(UUID,UUID,JSONB,TEXT,DATE,UUID,TEXT,JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_bulk_fee_payment(UUID,UUID,JSONB,TEXT,DATE,UUID,TEXT,JSONB) TO authenticated;


-- ===========================================================================
-- SECTION 2 - REPLACE record_fee_payment (legacy single-due safety wrapper)
--
-- record_fee_payment() was defined in fee_part2_functions.sql (pre-Chat 14).
-- The collect page no longer calls it directly (all paths now go through
-- record_bulk_fee_payment), but it still exists in the database and could be
-- called by stale clients, scripts, or the Supabase dashboard.
--
-- The original implementation used the old generate_fee_receipt_number()
-- helper (RANDOM() + collision-loop), which has the same structural weakness
-- as the discarded v1-v3 approaches above: it generates and checks separately
-- (check-then-insert race window) without catching Postgres's own constraint.
--
-- This wrapper replaces the body so any stale call goes through the same
-- atomic, retry-on-real-conflict path as the bulk version.
--
-- No signature change - DROP is not needed; CREATE OR REPLACE handles it.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.record_fee_payment(
  p_school_id       UUID,
  p_student_id      UUID,
  p_fee_due_id      UUID,
  p_amount_paid     NUMERIC(10,2),
  p_payment_method  TEXT,
  p_paid_date       DATE,
  p_collected_by    UUID,
  p_notes           TEXT DEFAULT NULL
)
RETURNS TABLE (payment_id UUID, receipt_number TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Delegate entirely to the atomic bulk function.
  -- Creates no new dues (p_new_dues defaults to empty array).
  RETURN QUERY
  SELECT b.payment_id, b.receipt_number
  FROM public.record_bulk_fee_payment(
    p_school_id,
    p_student_id,
    jsonb_build_array(
      jsonb_build_object('due_id', p_fee_due_id, 'amount', p_amount_paid)
    ),
    p_payment_method,
    p_paid_date,
    p_collected_by,
    p_notes
    -- p_new_dues omitted: defaults to '[]'
  ) b;
END;
$$;

-- Permissions (unchanged from original; replicated for completeness)
REVOKE ALL    ON FUNCTION public.record_fee_payment(UUID,UUID,UUID,NUMERIC,TEXT,DATE,UUID,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_fee_payment(UUID,UUID,UUID,NUMERIC,TEXT,DATE,UUID,TEXT) TO authenticated;


-- ===========================================================================
-- END OF MIGRATION - chat14_atomic_bulk_payment.sql
--
-- POST-DEPLOY CHECKLIST:
--
-- 1. Run in Supabase SQL Editor (not psql) to get clear per-statement errors.
-- 2. After running, execute:
--      NOTIFY pgrst, 'reload schema';
--    to force PostgREST to pick up the new function signatures immediately.
-- 3. Deploy the updated fee-collect-page.tsx which:
--      a. Removes the separate create_manual_due() loop for additional fees.
--      b. Builds a p_new_dues array from the "Additional fees" UI rows.
--      c. Passes p_new_dues into record_bulk_fee_payment() alongside the
--         existing current-month + arrear due IDs in p_payments.
-- 4. Before testing: delete orphaned ghost dues left by earlier failed
--    attempts. Use ROW_NUMBER() OVER (PARTITION BY student_id, label,
--    total_due ORDER BY created_at) to identify duplicates (row_num > 1)
--    and DELETE only those rows from fee_dues.
-- 5. Smoke test: add an additional fee on the collect page, submit, confirm
--    (a) exactly one fee_dues row created, (b) exactly one receipt_number
--    shared across all line items, (c) a forced failure leaves zero trace.
-- ===========================================================================
