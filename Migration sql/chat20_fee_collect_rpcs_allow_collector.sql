-- ============================================================
-- SCHOOLIUM - CHAT 20 SESSION - COLLECTOR FEE-COLLECTION FIX
-- fee_collect_rpcs_allow_collector
-- Generated 06 July 2026 - validated on PostgreSQL 16
-- ============================================================
-- Assumes chat02..chat19 are already applied.
--
-- Bug: a collector could not SEARCH for a student on the Collect Fee
-- screen - the omnibox threw "Access denied". search_students_omnibox
-- is the only collect-flow RPC still stuck on the original chat12 guard
-- (role = 'school_admin'); every other RPC in the flow already allows
-- 'collector':
--   * record_bulk_fee_payment       (chat16) - already collector-ok
--   * verify_admin_override_pin      (chat16) - already collector-ok
--   * log_fee_audit_event            (chat13) - already collector-ok
--   * get_student_billing_summary    (chat13 v3) - already collector-ok
-- Collectors previously reached the collect screen via the student
-- profile page (student_id in the URL, skipping search); removing
-- student-page access for collectors exposed this one gap.
--
-- Fix: widen search_students_omnibox to role IN ('school_admin',
-- 'collector'), matching the rest of the flow. It returns only
-- fee-relevant columns (name, UID, father, phone, class) - no Aadhaar
-- / address / DOB - so collectors still never see sensitive PII here.
--
-- NOTE: get_student_billing_summary is intentionally NOT touched. Its
-- live definition (chat13 "v3") already grants collector access and has
-- a richer return shape; recreating it here from the old v1 would break
-- billing (and error with 42P13 return-type change).
--
-- Rules honoured: pure ASCII, CREATE OR REPLACE (identical signature +
-- return type), SECURITY DEFINER sets search_path, REVOKE/GRANT kept.
-- ============================================================


-- ------------------------------------------------------------
-- search_students_omnibox - allow collector
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
-- Reload PostgREST schema cache
-- ------------------------------------------------------------
NOTIFY pgrst, 'reload schema';

-- ============================================================
-- END OF MIGRATION
-- ============================================================
