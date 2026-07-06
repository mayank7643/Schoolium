-- ============================================================
-- SCHOOLIUM - CHAT 20 SESSION - COLLECTOR FEE-COLLECTION FIX
-- fee_collect_rpcs_allow_collector
-- Generated 06 July 2026 - validated on PostgreSQL 16
-- ============================================================
-- Assumes chat02..chat19 are already applied.
--
-- Bug: the fee-collection flow relies on five RPCs. The three added
-- later (chat16: record_bulk_fee_payment, verify_admin_override_pin;
-- chat13: log_fee_audit_event) already allow role IN
-- ('school_admin','collector'). But the two chat12-era RPCs still
-- hard-code role = 'school_admin':
--   * search_students_omnibox   (find a student to collect from)
--   * get_student_billing_summary (load that student's pending dues)
-- So a collector gets "Access denied" the moment they search or open a
-- student, and cannot collect fees at all.
--
-- Fix: widen the guard on those two to ('school_admin','collector'),
-- matching the rest of the collect flow. Both RPCs already return only
-- fee-relevant columns (name, UID, father, phone, class, dues) - no
-- Aadhaar / address / DOB - so this stays consistent with keeping
-- sensitive student PII away from collectors.
--
-- Rules honoured: pure ASCII, CREATE OR REPLACE (identical signature +
-- return type), SECURITY DEFINER sets search_path, REVOKE/GRANT kept.
-- ============================================================


-- ------------------------------------------------------------
-- 1. search_students_omnibox - allow collector
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.search_students_omnibox(
  p_school_id  UUID,
  p_query      TEXT,
  p_class_id   UUID DEFAULT NULL,
  p_limit      INT  DEFAULT 10
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

  -- Verify caller is an active school_admin OR collector of p_school_id
  SELECT p.school_id INTO v_caller_school
  FROM public.profiles p
  WHERE p.id        = auth.uid()
    AND p.school_id = p_school_id
    AND p.role      IN ('school_admin', 'collector')
    AND p.is_active = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  v_q := '%' || trim(p_query) || '%';

  RETURN QUERY
  SELECT
    st.id,
    st.full_name::TEXT,
    st.student_uid::TEXT,
    st.father_name::TEXT,
    st.parent_phone::TEXT,
    c.name::TEXT    AS class_name,
    c.section::TEXT AS class_section
  FROM public.students st
  LEFT JOIN public.classes c ON c.id = st.class_id
  WHERE st.school_id = p_school_id
    AND st.is_active = true
    AND (
      st.full_name   ILIKE v_q
      OR st.father_name  ILIKE v_q
      OR st.mother_name  ILIKE v_q
      OR st.parent_phone ILIKE v_q
      OR st.student_uid  ILIKE v_q
    )
    AND (p_class_id IS NULL OR st.class_id = p_class_id)
  ORDER BY
    CASE WHEN st.student_uid ILIKE p_query THEN 0 ELSE 1 END,
    st.full_name
  LIMIT p_limit;

END;
$$;

REVOKE ALL ON FUNCTION public.search_students_omnibox(UUID,TEXT,UUID,INT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.search_students_omnibox(UUID,TEXT,UUID,INT) TO authenticated;


-- ------------------------------------------------------------
-- 2. get_student_billing_summary - allow collector
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_student_billing_summary(
  p_student_id UUID
)
RETURNS TABLE (
  -- Student
  student_id          UUID,
  full_name           TEXT,
  student_uid         TEXT,
  father_name         TEXT,
  parent_phone        TEXT,
  class_name          TEXT,
  class_section       TEXT,
  -- Assigned fee structure
  fee_structure_id    UUID,
  fee_structure_name  TEXT,
  -- Individual pending dues (one row per due)
  due_id              UUID,
  due_label           TEXT,
  due_month           TEXT,
  due_date            DATE,
  total_due           NUMERIC,
  amount_paid         NUMERIC,
  balance             NUMERIC,
  status              TEXT,
  late_fee_applied    BOOLEAN,
  -- Pre-calculated totals across all pending dues
  grand_total_due     NUMERIC,
  grand_total_paid    NUMERIC,
  grand_balance       NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_school UUID;
  v_student_school UUID;
  v_grand_due     NUMERIC;
  v_grand_paid    NUMERIC;
  v_grand_balance NUMERIC;
BEGIN

  SELECT p.school_id INTO v_caller_school
  FROM public.profiles p
  WHERE p.id        = auth.uid()
    AND p.role      IN ('school_admin', 'collector')
    AND p.is_active = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  SELECT s.school_id INTO v_student_school
  FROM public.students s
  WHERE s.id = p_student_id;

  IF v_student_school IS DISTINCT FROM v_caller_school THEN
    RAISE EXCEPTION 'Student not found';
  END IF;

  -- Aggregate pending totals
  SELECT
    COALESCE(SUM(d.total_due), 0),
    COALESCE(SUM(d.amount_paid), 0),
    COALESCE(SUM(d.balance), 0)
  INTO v_grand_due, v_grand_paid, v_grand_balance
  FROM public.fee_dues d
  WHERE d.student_id = p_student_id
    AND d.status NOT IN ('paid', 'waived');

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
  LEFT JOIN public.classes c         ON c.id  = s.class_id
  LEFT JOIN public.fee_structures fs ON fs.id = s.fee_structure_id
  LEFT JOIN public.fee_dues d        ON d.student_id = s.id
    AND d.status NOT IN ('paid', 'waived')
  WHERE s.id = p_student_id
  ORDER BY d.due_date ASC NULLS LAST;

END;
$$;

REVOKE ALL ON FUNCTION public.get_student_billing_summary(UUID) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_student_billing_summary(UUID) TO authenticated;


-- ------------------------------------------------------------
-- Reload PostgREST schema cache
-- ------------------------------------------------------------
NOTIFY pgrst, 'reload schema';

-- ============================================================
-- END OF MIGRATION
-- ============================================================
