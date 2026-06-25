-- ============================================================
-- SPRINT 1 — STEP 1
-- 1. record_fee_payment() — add amount validation
-- 2. search_students_omnibox() — universal student search RPC
-- Run this on Supabase SQL Editor (production)
-- ============================================================


-- ============================================================
-- 1. record_fee_payment() — REPLACE with validation guards
-- Validates: amount > 0, amount <= remaining balance
-- So nobody can send manipulated values from browser console
-- ============================================================

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
DECLARE
  v_receipt          TEXT;
  v_payment_id       UUID;
  v_due              RECORD;
  v_remaining        NUMERIC(10,2);
  v_new_paid         NUMERIC(10,2);
  v_new_status       TEXT;
BEGIN

  -- ── VALIDATION GUARD 1: amount must be positive ──────────
  IF p_amount_paid IS NULL OR p_amount_paid <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be greater than zero';
  END IF;

  -- ── VALIDATION GUARD 2: due must belong to this school + student ──
  SELECT * INTO v_due
  FROM public.fee_dues
  WHERE id         = p_fee_due_id
    AND school_id  = p_school_id
    AND student_id = p_student_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fee due not found or access denied';
  END IF;

  IF v_due.status = 'waived' THEN
    RAISE EXCEPTION 'Cannot collect payment on a waived due';
  END IF;

  IF v_due.status = 'paid' THEN
    RAISE EXCEPTION 'This due is already fully paid';
  END IF;

  -- ── VALIDATION GUARD 3: amount must not exceed remaining balance ──
  v_remaining := v_due.total_due - v_due.amount_paid;

  IF p_amount_paid > v_remaining THEN
    RAISE EXCEPTION 'Amount paid (%) exceeds remaining balance (%)',
      p_amount_paid, v_remaining;
  END IF;

  -- ── VALIDATION GUARD 4: payment method must be valid ──
  IF p_payment_method NOT IN ('cash', 'upi', 'cheque', 'bank_transfer', 'card', 'other') THEN
    RAISE EXCEPTION 'Invalid payment method: %', p_payment_method;
  END IF;

  -- ── VALIDATION GUARD 5: collected_by must be school admin of this school ──
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id        = p_collected_by
      AND school_id = p_school_id
      AND role      = 'school_admin'
      AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Collector is not an active admin of this school';
  END IF;

  -- ── Generate unique receipt number ────────────────────────
  v_receipt := public.generate_fee_receipt_number();

  -- ── Insert payment record ─────────────────────────────────
  INSERT INTO public.fee_payments (
    school_id, student_id, fee_due_id,
    amount_paid, payment_method, receipt_number,
    paid_date, collected_by, notes
  ) VALUES (
    p_school_id, p_student_id, p_fee_due_id,
    p_amount_paid, p_payment_method, v_receipt,
    p_paid_date, p_collected_by, p_notes
  )
  RETURNING id INTO v_payment_id;

  -- ── Update due's amount_paid and status atomically ────────
  v_new_paid := v_due.amount_paid + p_amount_paid;
  v_new_status := CASE
    WHEN v_new_paid >= v_due.total_due THEN 'paid'
    WHEN v_new_paid > 0               THEN 'partial'
    ELSE                                   'unpaid'
  END;

  UPDATE public.fee_dues
  SET
    amount_paid = v_new_paid,
    status      = v_new_status,
    updated_at  = now()
  WHERE id = p_fee_due_id;

  RETURN QUERY SELECT v_payment_id, v_receipt;
END;
$$;

-- Revoke public access, grant only to authenticated users
REVOKE ALL ON FUNCTION public.record_fee_payment(UUID,UUID,UUID,NUMERIC,TEXT,DATE,UUID,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_fee_payment(UUID,UUID,UUID,NUMERIC,TEXT,DATE,UUID,TEXT) TO authenticated;


-- ============================================================
-- 2. search_students_omnibox()
-- Universal search: name, father name, phone, student_uid, class
-- Used by the /collect page omnibox
-- ============================================================

CREATE OR REPLACE FUNCTION public.search_students_omnibox(
  p_school_id   UUID,
  p_query       TEXT,
  p_class_id    UUID    DEFAULT NULL,
  p_limit       INT     DEFAULT 10
)
RETURNS TABLE (
  id            UUID,
  full_name     TEXT,
  student_uid   TEXT,
  father_name   TEXT,
  parent_phone  TEXT,
  class_name    TEXT,
  class_section TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_school UUID;
  v_q             TEXT;
BEGIN

  -- Verify caller is an active admin of p_school_id
  SELECT s.school_id INTO v_caller_school
  FROM public.profiles s
  WHERE s.id        = auth.uid()
    AND s.school_id = p_school_id
    AND s.role      = 'school_admin'
    AND s.is_active = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  -- Sanitise query
  v_q := '%' || trim(p_query) || '%';

  RETURN QUERY
  SELECT
    st.id,
    st.full_name::TEXT,
    st.student_uid::TEXT,
    st.father_name::TEXT,
    st.parent_phone::TEXT,
    c.name::TEXT        AS class_name,
    c.section::TEXT     AS class_section
  FROM public.students st
  LEFT JOIN public.classes c ON c.id = st.class_id
  WHERE
    st.school_id = p_school_id
    AND st.is_active = true
    -- match on any of: name, father name, phone, uid
    AND (
      st.full_name    ILIKE v_q
      OR st.father_name   ILIKE v_q
      OR st.parent_phone  ILIKE v_q
      OR st.student_uid   ILIKE v_q
      OR st.mother_name   ILIKE v_q
    )
    -- optional class filter
    AND (p_class_id IS NULL OR st.class_id = p_class_id)
  ORDER BY
    -- exact uid match first, then alphabetical
    CASE WHEN st.student_uid ILIKE p_query THEN 0 ELSE 1 END,
    st.full_name
  LIMIT p_limit;

END;
$$;

-- Permissions
REVOKE ALL ON FUNCTION public.search_students_omnibox(UUID,TEXT,UUID,INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_students_omnibox(UUID,TEXT,UUID,INT) TO authenticated;
