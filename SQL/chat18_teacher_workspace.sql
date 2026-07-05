-- ============================================================
-- SCHOOLIUM - CHAT 18 MIGRATION
-- Teacher Workspace (chat17 Module 9)
-- ============================================================
-- Contents:
--   1. class_attendance  - CLASSROOM roll-call attendance marked by
--                          the class teacher (or admin/principal).
--                          Completely separate from the gate-scan
--                          table 'attendance' (guard QR entry/exit)
--                          and from 'staff_attendance'.
--   2. helper            - is_class_teacher_of(class_id)
--   3. RLS               - admin/principal all; class teachers read
--                          their classes. Writes only via the RPC.
--   4. RPCs              - mark_class_attendance (class teacher or
--                          admin/principal, 7-day window),
--                          get_class_fee_summary (READ-ONLY per-
--                          student dues for the class teacher)
--   5. NOTIFY pgrst
--
-- Rules honoured: pure ASCII, CREATE OR REPLACE, SECURITY DEFINER
-- with SET search_path + role/school verification + REVOKE/GRANT,
-- school_id isolation, profiles RLS untouched.
-- ============================================================


-- ============================================================
-- SECTION 1: class_attendance
-- One row per student per day. A student is in exactly one class,
-- so UNIQUE(student_id, attendance_date); class_id is recorded for
-- reporting and RLS scoping.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.class_attendance (
  id               uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id        uuid        NOT NULL REFERENCES public.schools(id)  ON DELETE CASCADE,
  class_id         uuid        NOT NULL REFERENCES public.classes(id)  ON DELETE CASCADE,
  student_id       uuid        NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  attendance_date  date        NOT NULL,
  status           text        NOT NULL CHECK (status IN ('present','absent','late')),
  source           text        NOT NULL DEFAULT 'teacher' CHECK (source IN ('teacher','admin')),
  marked_by        uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_class_attendance_day UNIQUE (student_id, attendance_date)
);

COMMENT ON TABLE public.class_attendance IS
  'Classroom roll call marked by the class teacher. The gate-scan '
  'table (attendance) records QR entry/exit; the marking UI shows '
  'gate scans as a hint but the two are independent records.';

CREATE INDEX IF NOT EXISTS idx_class_att_school_date ON public.class_attendance(school_id, attendance_date);
CREATE INDEX IF NOT EXISTS idx_class_att_class_date  ON public.class_attendance(class_id, attendance_date);
CREATE INDEX IF NOT EXISTS idx_class_att_student     ON public.class_attendance(student_id);

DROP TRIGGER IF EXISTS trg_class_att_updated_at ON public.class_attendance;
CREATE TRIGGER trg_class_att_updated_at
  BEFORE UPDATE ON public.class_attendance
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();


-- ============================================================
-- SECTION 2: HELPER - is the caller a class teacher of this class?
-- ============================================================

CREATE OR REPLACE FUNCTION public.is_class_teacher_of(p_class_id uuid)
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
  );
$$;

REVOKE ALL ON FUNCTION public.is_class_teacher_of(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.is_class_teacher_of(uuid) TO authenticated;


-- ============================================================
-- SECTION 3: RLS
-- ============================================================

ALTER TABLE public.class_attendance ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "class_att_admin_principal_all" ON public.class_attendance;
CREATE POLICY "class_att_admin_principal_all"
  ON public.class_attendance FOR ALL
  USING (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin', 'principal')
  )
  WITH CHECK (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin', 'principal')
  );

DROP POLICY IF EXISTS "class_att_class_teacher_read" ON public.class_attendance;
CREATE POLICY "class_att_class_teacher_read"
  ON public.class_attendance FOR SELECT
  USING (
    school_id = public.get_my_school_id()
    AND public.is_class_teacher_of(class_id)
  );

-- Teacher writes go exclusively through mark_class_attendance()
-- (SECURITY DEFINER) - no direct write policy on purpose.


-- ============================================================
-- SECTION 4: RPCs
-- ============================================================

-- ------------------------------------------------------------
-- mark_class_attendance - class teacher of the class, or admin/
-- principal. Date window: today back to 7 days (IST). p_rows:
-- [{"student_id":"...","status":"present"}, ...]
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mark_class_attendance(
  p_class_id uuid,
  p_date     date,
  p_rows     jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_school uuid;
  v_caller_role   text;
  v_class_school  uuid;
  v_today         date;
  v_source        text;
  v_row           jsonb;
  v_student_id    uuid;
  v_status        text;
  v_count         integer := 0;
BEGIN
  SELECT school_id, role INTO v_caller_school, v_caller_role
  FROM public.profiles
  WHERE id = auth.uid() AND is_active = true;

  IF v_caller_role IS NULL THEN
    RAISE EXCEPTION 'not authorised';
  END IF;

  IF v_caller_role IN ('school_admin', 'principal') THEN
    v_source := 'admin';
  ELSIF v_caller_role = 'teacher' AND public.is_class_teacher_of(p_class_id) THEN
    v_source := 'teacher';
  ELSE
    RAISE EXCEPTION 'only the class teacher or an admin can mark this class';
  END IF;

  SELECT school_id INTO v_class_school FROM public.classes WHERE id = p_class_id;
  IF v_class_school IS NULL OR v_class_school <> v_caller_school THEN
    RAISE EXCEPTION 'class not found';
  END IF;

  v_today := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  IF p_date IS NULL OR p_date > v_today THEN
    RAISE EXCEPTION 'cannot mark attendance for a future date';
  END IF;
  IF p_date < v_today - 7 THEN
    RAISE EXCEPTION 'cannot mark attendance more than 7 days back';
  END IF;

  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'no rows supplied';
  END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows)
  LOOP
    v_student_id := (v_row->>'student_id')::uuid;
    v_status     := v_row->>'status';

    IF v_status NOT IN ('present','absent','late') THEN
      RAISE EXCEPTION 'invalid status % for student %', v_status, v_student_id;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.students st
                   WHERE st.id = v_student_id
                     AND st.class_id = p_class_id
                     AND st.school_id = v_caller_school
                     AND st.is_active = true) THEN
      RAISE EXCEPTION 'student % is not an active member of this class', v_student_id;
    END IF;

    INSERT INTO public.class_attendance (
      school_id, class_id, student_id, attendance_date,
      status, source, marked_by
    ) VALUES (
      v_caller_school, p_class_id, v_student_id, p_date,
      v_status, v_source, auth.uid()
    )
    ON CONFLICT (student_id, attendance_date)
    DO UPDATE SET
      status     = EXCLUDED.status,
      class_id   = EXCLUDED.class_id,
      source     = EXCLUDED.source,
      marked_by  = auth.uid(),
      updated_at = now();

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_class_attendance(uuid,date,jsonb) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.mark_class_attendance(uuid,date,jsonb) TO authenticated;

-- ------------------------------------------------------------
-- get_class_fee_summary - READ-ONLY per-student dues for a class.
-- Callable by the CLASS TEACHER of that class (view + due list, no
-- collection) or admin/principal. Deliberately an RPC so teacher
-- access does not depend on the fee tables' RLS.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_class_fee_summary(p_class_id uuid)
RETURNS TABLE (
  student_id    uuid,
  full_name     text,
  total_due     numeric,
  total_paid    numeric,
  balance       numeric,
  overdue_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_caller_school uuid;
  v_caller_role   text;
  v_class_school  uuid;
BEGIN
  SELECT p.school_id, p.role INTO v_caller_school, v_caller_role
  FROM public.profiles p
  WHERE p.id = auth.uid() AND p.is_active = true;

  IF v_caller_role IS NULL THEN
    RAISE EXCEPTION 'not authorised';
  END IF;

  IF v_caller_role NOT IN ('school_admin', 'principal')
     AND NOT (v_caller_role = 'teacher' AND public.is_class_teacher_of(p_class_id)) THEN
    RAISE EXCEPTION 'only the class teacher or an admin can view this';
  END IF;

  SELECT c.school_id INTO v_class_school FROM public.classes c WHERE c.id = p_class_id;
  IF v_class_school IS NULL OR v_class_school <> v_caller_school THEN
    RAISE EXCEPTION 'class not found';
  END IF;

  RETURN QUERY
  SELECT
    st.id,
    st.full_name,
    COALESCE(SUM(fd.total_due), 0)::numeric,
    COALESCE(SUM(fd.amount_paid), 0)::numeric,
    COALESCE(SUM(fd.balance), 0)::numeric,
    (COUNT(*) FILTER (WHERE fd.balance > 0 AND fd.due_date < current_date))::integer
  FROM public.students st
  LEFT JOIN public.fee_dues fd ON fd.student_id = st.id
  WHERE st.class_id = p_class_id
    AND st.school_id = v_caller_school
    AND st.is_active = true
  GROUP BY st.id, st.full_name
  ORDER BY st.full_name;
END;
$$;

REVOKE ALL ON FUNCTION public.get_class_fee_summary(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_class_fee_summary(uuid) TO authenticated;


-- ============================================================
-- SECTION 5: RELOAD POSTGREST SCHEMA CACHE
-- ============================================================

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- END OF CHAT 18 MIGRATION
-- ============================================================
