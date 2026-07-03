-- =============================================================================
-- Schoolium - Database Migration (addendum to chat16)
-- File:    chat16g_get_fee_summary.sql
-- Session: Chat 16 - fee summary feature.
--
-- get_fee_summary(class_name, section) returns one row per active student with
-- their LIVE outstanding dues (count + amount), computed straight from fee_dues
-- (status unpaid/partial, balance > 0). Because the monthly pg_cron job writes
-- the current month's dues into fee_dues, this automatically includes the
-- current month - no manual step. Filter by grade name, grade+section, or pass
-- both NULL for the whole school. Admin or collector only.
--
-- Pure ASCII. Idempotent. Run in Supabase.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_fee_summary(
  p_class_name text DEFAULT NULL,
  p_section    text DEFAULT NULL
)
RETURNS TABLE (
  student_id   uuid,
  student_uid  text,
  full_name    text,
  father_name  text,
  parent_phone text,
  class_name   text,
  section      text,
  due_count    integer,
  outstanding  numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_school uuid;
BEGIN
  SELECT p.school_id INTO v_school
  FROM public.profiles p
  WHERE p.id = auth.uid()
    AND p.role IN ('school_admin', 'collector')
    AND p.is_active = true;
  IF v_school IS NULL THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  RETURN QUERY
  SELECT
    s.id,
    s.student_uid,
    s.full_name,
    s.father_name,
    s.parent_phone,
    c.name,
    c.section,
    COALESCE(d.due_count, 0)::integer,
    COALESCE(d.outstanding, 0)::numeric
  FROM public.students s
  LEFT JOIN public.classes c ON c.id = s.class_id
  LEFT JOIN LATERAL (
    SELECT count(*) AS due_count, sum(fd.balance) AS outstanding
    FROM public.fee_dues fd
    WHERE fd.student_id = s.id
      AND fd.status IN ('unpaid', 'partial')
      AND fd.balance > 0
  ) d ON true
  WHERE s.school_id = v_school
    AND s.is_active = true
    AND (p_class_name IS NULL OR c.name    = p_class_name)
    AND (p_section    IS NULL OR c.section = p_section)
  ORDER BY c.name NULLS LAST, c.section NULLS LAST, s.full_name;
END;
$function$;

REVOKE ALL   ON FUNCTION public.get_fee_summary(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_fee_summary(text, text) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- VERIFY:
-- SELECT * FROM public.get_fee_summary(NULL, NULL);   -- whole school
-- SELECT * FROM public.get_fee_summary('5', NULL);    -- grade 5, all sections
-- SELECT * FROM public.get_fee_summary('5', 'A');     -- grade 5 section A
-- =============================================================================
