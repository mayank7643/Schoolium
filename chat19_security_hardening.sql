-- ============================================================
-- SCHOOLIUM - CHAT 19 MIGRATION
-- SECURITY HARDENING (RLS) - fixes reported vulnerability
-- ============================================================
-- Problem: chat02 created school-wide FOR ALL policies, so ANY
-- school member (teacher, collector, generic staff) could INSERT/
-- UPDATE/DELETE students and classes via the API, and ANY member
-- could UPDATE the schools row (override PIN, waiver caps - the
-- privilege escalation deferred in chat16 task 4).
--
-- New model (matches the permission spec):
--   students SELECT : admin, principal, receptionist, collector,
--                     guard (scan cache), and teachers ONLY for
--                     classes they teach (class teacher or subject)
--   students WRITE  : admin, principal, receptionist only
--   classes  SELECT : whole school (unchanged)
--   classes  WRITE  : admin, principal only
--   schools  UPDATE : school_admin only
--
-- SECURITY DEFINER functions (fees, scans, staff RPCs) bypass RLS
-- and are unaffected. Existing super_admin policies untouched.
-- ============================================================


-- ============================================================
-- SECTION 1: HELPER - does the caller teach this class?
-- (class teacher OR subject teacher; used for student read scope)
-- ============================================================

CREATE OR REPLACE FUNCTION public.teaches_in_class(p_class_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.class_teachers ct
    JOIN public.staff s ON s.id = ct.staff_id
    WHERE ct.class_id = p_class_id
      AND s.profile_id = auth.uid()
      AND s.employment_status IN ('active','probation','on_leave')
  )
  OR EXISTS (
    SELECT 1
    FROM public.subject_assignments sa
    JOIN public.staff s ON s.id = sa.staff_id
    WHERE sa.class_id = p_class_id
      AND s.profile_id = auth.uid()
      AND s.employment_status IN ('active','probation','on_leave')
  );
$$;

REVOKE ALL ON FUNCTION public.teaches_in_class(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.teaches_in_class(uuid) TO authenticated;


-- ============================================================
-- SECTION 2: STUDENTS - replace the blanket FOR ALL policy
-- ============================================================

DROP POLICY IF EXISTS "school_sees_own_students" ON public.students;

-- Read: office roles + guards see the whole school; teachers see
-- only students of classes they teach.
DROP POLICY IF EXISTS "students_school_read" ON public.students;
CREATE POLICY "students_school_read"
  ON public.students FOR SELECT
  USING (
    school_id = public.get_my_school_id()
    AND (
      public.get_my_role() IN ('school_admin','principal','receptionist','collector','guard')
      OR public.teaches_in_class(class_id)
    )
  );

-- Writes: student management roles only (per permission spec:
-- receptionist = admissions and student management).
DROP POLICY IF EXISTS "students_office_insert" ON public.students;
CREATE POLICY "students_office_insert"
  ON public.students FOR INSERT
  WITH CHECK (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin','principal','receptionist')
  );

DROP POLICY IF EXISTS "students_office_update" ON public.students;
CREATE POLICY "students_office_update"
  ON public.students FOR UPDATE
  USING (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin','principal','receptionist')
  )
  WITH CHECK (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin','principal','receptionist')
  );

DROP POLICY IF EXISTS "students_office_delete" ON public.students;
CREATE POLICY "students_office_delete"
  ON public.students FOR DELETE
  USING (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin','principal','receptionist')
  );


-- ============================================================
-- SECTION 3: CLASSES - reads stay school-wide, writes tightened
-- ============================================================

DROP POLICY IF EXISTS "school_sees_own_classes" ON public.classes;

DROP POLICY IF EXISTS "classes_school_read" ON public.classes;
CREATE POLICY "classes_school_read"
  ON public.classes FOR SELECT
  USING ( school_id = public.get_my_school_id() );

DROP POLICY IF EXISTS "classes_admin_insert" ON public.classes;
CREATE POLICY "classes_admin_insert"
  ON public.classes FOR INSERT
  WITH CHECK (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin','principal')
  );

DROP POLICY IF EXISTS "classes_admin_update" ON public.classes;
CREATE POLICY "classes_admin_update"
  ON public.classes FOR UPDATE
  USING (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin','principal')
  )
  WITH CHECK (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin','principal')
  );

DROP POLICY IF EXISTS "classes_admin_delete" ON public.classes;
CREATE POLICY "classes_admin_delete"
  ON public.classes FOR DELETE
  USING (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin','principal')
  );


-- ============================================================
-- SECTION 4: SCHOOLS - close the chat16-deferred UPDATE hole
-- (any member could update the schools row, including override
-- PIN column and waiver caps)
-- ============================================================

DROP POLICY IF EXISTS "users_update_own_school" ON public.schools;

DROP POLICY IF EXISTS "schools_admin_update" ON public.schools;
CREATE POLICY "schools_admin_update"
  ON public.schools FOR UPDATE
  USING (
    id = public.get_my_school_id()
    AND public.get_my_role() = 'school_admin'
  )
  WITH CHECK (
    id = public.get_my_school_id()
    AND public.get_my_role() = 'school_admin'
  );


-- ============================================================
-- SECTION 5: RELOAD POSTGREST SCHEMA CACHE
-- ============================================================

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- END OF CHAT 19 MIGRATION
-- ============================================================
