-- ============================================================
-- SCHOOLIUM - CHAT 18 SESSION - RESTRICT STUDENT ROSTER
-- restrict_student_roster_to_class_teacher
-- Generated 05 July 2026 - validated on PostgreSQL 16
-- ============================================================
-- Assumes chat02..chat17 are already applied.
--
-- Before: chat17 PART 3 replaced the blanket students FOR ALL
-- policy with "students_school_read", which let a teacher read the
-- students of ANY class they teach - class teacher OR subject
-- teacher - via public.teaches_in_class(class_id).
--
-- Change: a teacher may now read only the students of classes they
-- are the CLASS TEACHER of. Subject-only teachers no longer see the
-- roster. Office roles (school_admin/principal/receptionist/
-- collector/guard) keep whole-school read. Insert/update/delete
-- policies are unchanged (office roles only).
--
-- Rules honoured: pure ASCII, DROP POLICY IF EXISTS + CREATE,
-- school_id isolation preserved, idempotent, uses the existing
-- SECURITY DEFINER helper public.is_class_teacher_of(uuid).
-- ============================================================


-- ------------------------------------------------------------
-- STUDENTS - read scope: office roles school-wide, teachers only
-- for classes they are the class teacher of.
-- ------------------------------------------------------------

DROP POLICY IF EXISTS "students_school_read" ON public.students;
CREATE POLICY "students_school_read"
  ON public.students FOR SELECT
  USING (
    school_id = public.get_my_school_id()
    AND (
      public.get_my_role() IN ('school_admin','principal','receptionist','collector','guard')
      OR public.is_class_teacher_of(class_id)
    )
  );


-- ------------------------------------------------------------
-- Reload PostgREST schema cache
-- ------------------------------------------------------------
NOTIFY pgrst, 'reload schema';

-- ============================================================
-- END OF MIGRATION
-- ============================================================
