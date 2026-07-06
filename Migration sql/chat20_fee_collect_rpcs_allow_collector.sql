-- ============================================================
-- SCHOOLIUM - CHAT 20 SESSION - COLLECTOR FEE-MODULE FIX
-- fee_collect_rpcs_allow_collector
-- Generated 06 July 2026 - validated on PostgreSQL 16
-- ============================================================
-- Assumes chat02..chat19 are already applied.
--
-- Three collector-facing fee surfaces were still stuck on the original
-- 'school_admin'-only guard, while the rest of the fee module had been
-- widened to include 'collector' in later chats:
--
--   * search_students_omnibox  (chat12) - collector could not SEARCH a
--       student on the Collect Fee screen ("Access denied").
--   * get_defaulters           (chat13) - collector got an empty
--       Defaulters list (the RPC denied them, the UI showed "No
--       defaulters").
--   * fee_payments RLS         (chat11) - the "school_admin_fee_payments"
--       FOR ALL policy was admin-only, so the "Recent payments" list
--       (a direct SELECT on fee_payments) was empty for collectors even
--       though the aggregate stats (SECURITY DEFINER RPC) showed totals.
--
-- Already collector-enabled, left untouched here:
--   record_bulk_fee_payment, verify_admin_override_pin (chat16),
--   log_fee_audit_event (chat13), get_student_billing_summary (chat13
--   v3), get_fee_summary (chat16), submit_eod_closure (chat13),
--   get_fee_dashboard_stats (chat13, no role gate). fee_dues read is
--   already open to any active school member (chat13).
--
-- Fix: widen the two RPC guards to role IN ('school_admin','collector')
-- and add a collector SELECT policy on fee_payments (reads only -
-- writes stay via the SECURITY DEFINER record_bulk_fee_payment RPC).
-- All of these return only fee-relevant columns - no Aadhaar / address
-- / DOB - so collectors still never see sensitive student PII.
--
-- Rules honoured: pure ASCII, CREATE OR REPLACE (identical signature +
-- return type - no DROP needed), DROP POLICY IF EXISTS + CREATE,
-- SECURITY DEFINER sets search_path, REVOKE/GRANT kept.
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
-- 2. get_defaulters - allow collector
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_defaulters(
  p_school_id     UUID,
  p_class_id      UUID DEFAULT NULL,
  p_academic_year TEXT DEFAULT NULL
)
RETURNS TABLE (
  student_id      UUID,
  full_name       TEXT,
  student_uid     TEXT,
  class_name      TEXT,
  class_section   TEXT,
  total_balance   NUMERIC,
  oldest_due_date DATE,
  days_overdue    INTEGER,
  dues_count      BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id        = auth.uid()
      AND school_id = p_school_id
      AND role      IN ('school_admin', 'collector')
      AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  RETURN QUERY
  SELECT
    s.id,
    s.full_name,
    s.student_uid,
    c.name,
    c.section,
    SUM(d.balance),
    MIN(d.due_date),
    (CURRENT_DATE - MIN(d.due_date))::INTEGER,
    COUNT(d.id)
  FROM public.students s
  JOIN public.fee_dues d     ON d.student_id = s.id
  LEFT JOIN public.classes c ON c.id         = s.class_id
  WHERE d.school_id   = p_school_id
    AND d.status      IN ('unpaid','partial')
    AND d.balance     > 0
    AND d.due_date    < CURRENT_DATE
    AND (p_class_id      IS NULL OR s.class_id      = p_class_id)
    AND (p_academic_year IS NULL OR d.academic_year = p_academic_year)
  GROUP BY s.id, s.full_name, s.student_uid, c.name, c.section
  ORDER BY total_balance DESC;
END;
$$;

REVOKE ALL  ON FUNCTION public.get_defaulters(UUID, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_defaulters(UUID, UUID, TEXT) TO authenticated;


-- ------------------------------------------------------------
-- 3. fee_payments - let collectors READ their school's payments
-- (the "Recent payments" list). Writes still flow only through the
-- SECURITY DEFINER record_bulk_fee_payment RPC, so no write policy is
-- added. The existing "school_admin_fee_payments" FOR ALL policy is
-- left in place for admins; permissive policies are OR-ed.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "collector_reads_fee_payments" ON public.fee_payments;
CREATE POLICY "collector_reads_fee_payments"
  ON public.fee_payments
  FOR SELECT
  USING (
    school_id IN (
      SELECT p.school_id FROM public.profiles p
      WHERE p.id        = auth.uid()
        AND p.role      = 'collector'
        AND p.is_active = true
    )
  );


-- ------------------------------------------------------------
-- Reload PostgREST schema cache
-- ------------------------------------------------------------
NOTIFY pgrst, 'reload schema';

-- ============================================================
-- END OF MIGRATION
-- ============================================================
