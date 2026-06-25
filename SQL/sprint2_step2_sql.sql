-- ============================================================
-- SPRINT 2 — STEP 2
-- Link students to their default fee structure
--
-- 1. Add fee_structure_id column to students table
-- 2. assign_student_fee_structure() RPC — admin assigns/removes
-- 3. get_student_fee_summary() RPC — used by billing screen
--    Returns student + their pending dues + total payable
--
-- Run in Supabase SQL Editor (production)
-- ============================================================


-- ============================================================
-- 1. Add fee_structure_id to students
-- ============================================================

ALTER TABLE public.students
  ADD COLUMN IF NOT EXISTS fee_structure_id UUID
    REFERENCES public.fee_structures(id)
    ON DELETE SET NULL;

-- Index for fast lookup
CREATE INDEX IF NOT EXISTS idx_students_fee_structure
  ON public.students(fee_structure_id)
  WHERE fee_structure_id IS NOT NULL;


-- ============================================================
-- 2. assign_student_fee_structure()
--    Admin assigns or removes a fee structure for a student.
--    Pass p_fee_structure_id = NULL to unassign.
-- ============================================================

CREATE OR REPLACE FUNCTION public.assign_student_fee_structure(
  p_student_id       UUID,
  p_fee_structure_id UUID   -- NULL to unassign
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_school_id UUID;
BEGIN

  -- Verify caller is active school_admin
  SELECT school_id INTO v_school_id
  FROM public.profiles
  WHERE id        = auth.uid()
    AND role      = 'school_admin'
    AND is_active = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  -- Verify student belongs to this school
  IF NOT EXISTS (
    SELECT 1 FROM public.students
    WHERE id = p_student_id AND school_id = v_school_id
  ) THEN
    RAISE EXCEPTION 'Student not found';
  END IF;

  -- Verify fee structure belongs to this school (if assigning)
  IF p_fee_structure_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.fee_structures
      WHERE id = p_fee_structure_id AND school_id = v_school_id AND is_active = true
    ) THEN
      RAISE EXCEPTION 'Fee structure not found or inactive';
    END IF;
  END IF;

  -- Assign or unassign
  UPDATE public.students
  SET
    fee_structure_id = p_fee_structure_id,
    updated_at       = NOW()
  WHERE id = p_student_id;

END;
$$;

REVOKE ALL ON FUNCTION public.assign_student_fee_structure(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assign_student_fee_structure(UUID, UUID) TO authenticated;


-- ============================================================
-- 3. get_student_billing_summary()
--    Called by the collect page when admin selects a student.
--    Returns:
--      - student info
--      - their assigned fee structure name
--      - all pending/partial dues with balances
--      - grand total payable
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_student_billing_summary(
  p_student_id UUID
)
RETURNS TABLE (
  -- Student info
  student_id       UUID,
  full_name        TEXT,
  student_uid      TEXT,
  father_name      TEXT,
  parent_phone     TEXT,
  class_name       TEXT,
  class_section    TEXT,
  -- Fee structure
  fee_structure_id   UUID,
  fee_structure_name TEXT,
  -- Due summary
  due_id           UUID,
  due_label        TEXT,
  due_month        TEXT,
  due_date         DATE,
  total_due        NUMERIC,
  amount_paid      NUMERIC,
  balance          NUMERIC,
  status           TEXT,
  late_fee_applied BOOLEAN,
  -- Totals
  grand_total_due  NUMERIC,
  grand_total_paid NUMERIC,
  grand_balance    NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_school_id       UUID;
  v_caller_school   UUID;
  v_grand_due       NUMERIC;
  v_grand_paid      NUMERIC;
  v_grand_balance   NUMERIC;
BEGIN

  -- Verify caller is active school_admin and get their school
  SELECT p.school_id INTO v_caller_school
  FROM public.profiles p
  WHERE p.id        = auth.uid()
    AND p.role      = 'school_admin'
    AND p.is_active = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  -- Verify student belongs to caller's school
  SELECT s.school_id INTO v_school_id
  FROM public.students s
  WHERE s.id = p_student_id;

  IF v_school_id != v_caller_school THEN
    RAISE EXCEPTION 'Student not found';
  END IF;

  -- Pre-calculate grand totals for pending dues
  SELECT
    COALESCE(SUM(d.total_due), 0),
    COALESCE(SUM(d.amount_paid), 0),
    COALESCE(SUM(d.balance), 0)
  INTO v_grand_due, v_grand_paid, v_grand_balance
  FROM public.fee_dues d
  WHERE d.student_id = p_student_id
    AND d.status NOT IN ('paid', 'waived');

  -- Return rows: one per pending due
  RETURN QUERY
  SELECT
    s.id,
    s.full_name::TEXT,
    s.student_uid::TEXT,
    s.father_name::TEXT,
    s.parent_phone::TEXT,
    c.name::TEXT,
    c.section::TEXT,
    fs.id,
    fs.name::TEXT,
    d.id,
    d.label::TEXT,
    d.month::TEXT,
    d.due_date,
    d.total_due,
    d.amount_paid,
    d.balance,
    d.status::TEXT,
    d.late_fee_applied,
    v_grand_due,
    v_grand_paid,
    v_grand_balance
  FROM public.students s
  LEFT JOIN public.classes c        ON c.id  = s.class_id
  LEFT JOIN public.fee_structures fs ON fs.id = s.fee_structure_id
  LEFT JOIN public.fee_dues d       ON d.student_id = s.id
    AND d.status NOT IN ('paid', 'waived')
  WHERE s.id = p_student_id
  ORDER BY d.due_date ASC NULLS LAST;

END;
$$;

REVOKE ALL ON FUNCTION public.get_student_billing_summary(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_student_billing_summary(UUID) TO authenticated;
