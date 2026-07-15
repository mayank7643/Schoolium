-- ============================================================
-- SCHOOLIUM - EXAM MODULE PHASE 5 - exam_attendance
-- Design: docs/exam-module/ Steps 2-4 (Group D). Separate from the
-- gate-scan table (attendance) and class roll-call (class_attendance).
-- Assumes: exam core + logistics + admit cards + question papers.
-- ============================================================
-- Contents:
--   SECTION 1  exam_attendance table + RLS
--   SECTION 2  RPCs: record_exam_attendance_scan (QR at the room),
--              mark_exam_attendance_bulk (manual roll),
--              get_exam_attendance_report
--   SECTION 3  PostgREST schema reload
-- Idempotent throughout. Pure ASCII.
-- ============================================================


-- ============================================================
-- SECTION 1: exam_attendance
-- One row per (paper, student). present | absent | medical | late.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.exam_attendance (
  id               uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id        uuid        NOT NULL REFERENCES public.schools(id)        ON DELETE CASCADE,
  exam_subject_id  uuid        NOT NULL REFERENCES public.exam_subjects(id)  ON DELETE CASCADE,
  student_id       uuid        NOT NULL REFERENCES public.students(id)       ON DELETE CASCADE,
  status           text        NOT NULL CHECK (status IN ('present','absent','medical','late')),
  source           text        NOT NULL DEFAULT 'manual' CHECK (source IN ('qr','manual')),
  remarks          text,
  marked_by        uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  marked_at        timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_exam_attendance UNIQUE (exam_subject_id, student_id)
);

COMMENT ON TABLE public.exam_attendance IS
  'Exam-room attendance per paper. Separate from gate scans (attendance) '
  'and class roll call (class_attendance). Cross-checked at marks submission '
  '(Phase 6): absent/medical here => marks_entries.is_absent must be true.';

CREATE INDEX IF NOT EXISTS idx_exam_att_school   ON public.exam_attendance(school_id);
CREATE INDEX IF NOT EXISTS idx_exam_att_paper    ON public.exam_attendance(exam_subject_id);
CREATE INDEX IF NOT EXISTS idx_exam_att_student  ON public.exam_attendance(student_id);

DROP TRIGGER IF EXISTS trg_exam_att_updated_at ON public.exam_attendance;
CREATE TRIGGER trg_exam_att_updated_at
  BEFORE UPDATE ON public.exam_attendance
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

-- same-school + enrollment integrity
CREATE OR REPLACE FUNCTION public.tg_ck_exam_att_school()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.exam_subjects es
                 WHERE es.id = NEW.exam_subject_id AND es.school_id = NEW.school_id) THEN
    RAISE EXCEPTION 'paper does not belong to this school';
  END IF;
  -- the student must be enrolled in this paper's exam and class
  IF NOT EXISTS (
    SELECT 1
    FROM public.exam_subjects es
    JOIN public.exam_enrollments ee
      ON ee.exam_id = es.exam_id AND ee.student_id = NEW.student_id AND ee.class_id = es.class_id
    WHERE es.id = NEW.exam_subject_id
  ) THEN
    RAISE EXCEPTION 'student is not enrolled in this paper''s class';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ck_exam_att_school ON public.exam_attendance;
CREATE TRIGGER trg_ck_exam_att_school
  BEFORE INSERT OR UPDATE ON public.exam_attendance
  FOR EACH ROW EXECUTE FUNCTION public.tg_ck_exam_att_school();

ALTER TABLE public.exam_attendance ENABLE ROW LEVEL SECURITY;

-- read: admin/principal, or teacher connected to the paper's class
DROP POLICY IF EXISTS "exam_att_scoped_read" ON public.exam_attendance;
CREATE POLICY "exam_att_scoped_read"
  ON public.exam_attendance FOR SELECT
  USING (
    school_id = public.get_my_school_id()
    AND (
      public.get_my_role() IN ('school_admin', 'principal')
      OR EXISTS (
        SELECT 1 FROM public.exam_subjects es
        WHERE es.id = exam_subject_id
          AND ( public.teaches_subject_in_class(es.subject_id, es.class_id)
                OR public.teaches_in_class(es.class_id)
                OR public.is_class_teacher_of(es.class_id) )
      )
    )
  );
-- writes are RPC-only (no write policies)


-- ============================================================
-- SECTION 2: RPCs
-- ============================================================

-- ------------------------------------------------------------
-- exam_att_can_mark - INTERNAL: may the caller mark this paper?
-- admin/principal, the assigned subject teacher, a teacher of the
-- class, or the class teacher (any of them can invigilate).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.exam_att_can_mark(p_exam_subject_id uuid, p_school uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.exam_subjects es
    WHERE es.id = p_exam_subject_id
      AND es.school_id = p_school
      AND (
        public.get_my_role() IN ('school_admin', 'principal')
        OR public.teaches_subject_in_class(es.subject_id, es.class_id)
        OR public.teaches_in_class(es.class_id)
        OR public.is_class_teacher_of(es.class_id)
      )
  );
$$;

REVOKE ALL ON FUNCTION public.exam_att_can_mark(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.exam_att_can_mark(uuid, uuid) TO authenticated;

-- ------------------------------------------------------------
-- record_exam_attendance_scan - QR at the exam room.
-- Resolves the admit-card token, confirms the student sits THIS
-- paper, upserts present/late (late if now > start_time), returns
-- the student payload for visual verification.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_exam_attendance_scan(
  p_qr_token        uuid,
  p_exam_subject_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role     text;
  v_school   uuid;
  v_paper    record;
  v_card     record;
  v_status   text;
  v_now      timestamptz := now();
  v_warnings text[] := ARRAY[]::text[];
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_staff();

  IF NOT public.exam_att_can_mark(p_exam_subject_id, v_school) THEN
    RAISE EXCEPTION 'Access denied: you cannot mark attendance for this paper';
  END IF;

  SELECT es.id, es.exam_id, es.class_id, es.subject_id, es.exam_date, es.start_time,
         es.is_cancelled, e.status AS exam_status, sub.name AS subject_name
  INTO v_paper
  FROM public.exam_subjects es
  JOIN public.exams e   ON e.id = es.exam_id
  JOIN public.subjects sub ON sub.id = es.subject_id
  WHERE es.id = p_exam_subject_id AND es.school_id = v_school;

  IF v_paper.id IS NULL THEN
    RAISE EXCEPTION 'Paper not found';
  END IF;
  IF v_paper.is_cancelled THEN
    RAISE EXCEPTION 'This paper is cancelled';
  END IF;
  IF v_paper.exam_status NOT IN ('published', 'ongoing') THEN
    RAISE EXCEPTION 'Attendance can only be marked for a published or ongoing exam';
  END IF;

  -- resolve the admit-card token to an enrollment in this school
  SELECT ac.is_revoked, ee.exam_id, ee.student_id, ee.class_id, ee.roll_number,
         ee.seat_number, ee.status AS enroll_status,
         s.full_name, s.photo_url, c.name AS class_name, c.section
  INTO v_card
  FROM public.admit_cards ac
  JOIN public.exam_enrollments ee ON ee.id = ac.enrollment_id
  JOIN public.students s ON s.id = ee.student_id
  JOIN public.classes  c ON c.id = ee.class_id
  WHERE ac.qr_token = p_qr_token AND ac.school_id = v_school;

  IF v_card.student_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unknown_card');
  END IF;
  IF v_card.is_revoked THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'revoked_card');
  END IF;
  IF v_card.exam_id <> v_paper.exam_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'wrong_exam');
  END IF;
  IF v_card.class_id <> v_paper.class_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'wrong_class',
      'student_name', v_card.full_name,
      'class_label', v_card.class_name || COALESCE('-' || v_card.section, ''));
  END IF;
  IF v_card.enroll_status <> 'enrolled' THEN
    v_warnings := array_append(v_warnings, 'Enrollment status: ' || v_card.enroll_status);
  END IF;

  -- late if the paper has started
  v_status := 'present';
  IF v_paper.exam_date IS NOT NULL AND v_paper.start_time IS NOT NULL
     AND v_now > (v_paper.exam_date + v_paper.start_time) AT TIME ZONE 'Asia/Kolkata' THEN
    v_status := 'late';
  END IF;

  INSERT INTO public.exam_attendance
    (school_id, exam_subject_id, student_id, status, source, marked_by, marked_at)
  VALUES
    (v_school, p_exam_subject_id, v_card.student_id, v_status, 'qr', auth.uid(), v_now)
  ON CONFLICT (exam_subject_id, student_id) DO UPDATE
    SET status = CASE
                   -- never silently downgrade a manual absent/medical to present on a stray scan
                   WHEN public.exam_attendance.status IN ('absent','medical')
                        AND public.exam_attendance.source = 'manual'
                   THEN public.exam_attendance.status
                   ELSE EXCLUDED.status
                 END,
        source = 'qr', marked_by = auth.uid(), marked_at = v_now
  RETURNING status INTO v_status;

  -- surface the case where a prior manual absent/medical was kept
  IF v_status IN ('absent', 'medical') THEN
    v_warnings := array_append(v_warnings,
      'Kept existing ' || v_status || ' status (marked manually) - change it on the roll if the student is present');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'status_set', v_status,
    'student_name', v_card.full_name,
    'photo_url', v_card.photo_url,
    'roll_number', v_card.roll_number,
    'seat_number', v_card.seat_number,
    'class_label', v_card.class_name || COALESCE('-' || v_card.section, ''),
    'subject_name', v_paper.subject_name,
    'warnings', to_jsonb(v_warnings)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_exam_attendance_scan(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_exam_attendance_scan(uuid, uuid) TO authenticated;

-- ------------------------------------------------------------
-- mark_exam_attendance_bulk - manual roll / corrections.
-- Rows: [{ student_id, status, remarks? }]. Upserts.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mark_exam_attendance_bulk(
  p_exam_subject_id uuid,
  p_rows            jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role   text;
  v_school uuid;
  v_paper  record;
  v_row    jsonb;
  v_status text;
  v_saved  integer := 0;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_staff();

  IF NOT public.exam_att_can_mark(p_exam_subject_id, v_school) THEN
    RAISE EXCEPTION 'Access denied: you cannot mark attendance for this paper';
  END IF;

  SELECT es.id, es.is_cancelled, e.status AS exam_status
  INTO v_paper
  FROM public.exam_subjects es
  JOIN public.exams e ON e.id = es.exam_id
  WHERE es.id = p_exam_subject_id AND es.school_id = v_school;

  IF v_paper.id IS NULL THEN
    RAISE EXCEPTION 'Paper not found';
  END IF;
  IF v_paper.is_cancelled THEN
    RAISE EXCEPTION 'This paper is cancelled';
  END IF;
  IF v_paper.exam_status NOT IN ('published', 'ongoing', 'completed') THEN
    RAISE EXCEPTION 'Attendance is closed for a % exam', v_paper.exam_status;
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'No rows supplied';
  END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows)
  LOOP
    v_status := v_row->>'status';
    IF v_status NOT IN ('present','absent','medical','late') THEN
      RAISE EXCEPTION 'Invalid status: %', v_status;
    END IF;

    INSERT INTO public.exam_attendance
      (school_id, exam_subject_id, student_id, status, source, remarks, marked_by, marked_at)
    VALUES
      (v_school, p_exam_subject_id, (v_row->>'student_id')::uuid, v_status, 'manual',
       v_row->>'remarks', auth.uid(), now())
    ON CONFLICT (exam_subject_id, student_id) DO UPDATE
      SET status = EXCLUDED.status, source = 'manual',
          remarks = EXCLUDED.remarks, marked_by = auth.uid(), marked_at = now();

    v_saved := v_saved + 1;
  END LOOP;

  RETURN jsonb_build_object('saved', v_saved);
END;
$$;

REVOKE ALL ON FUNCTION public.mark_exam_attendance_bulk(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_exam_attendance_bulk(uuid, jsonb) TO authenticated;

-- ------------------------------------------------------------
-- get_exam_attendance_report - per paper: counts + unmarked.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_exam_attendance_report(p_exam_id uuid)
RETURNS TABLE (
  exam_subject_id uuid,
  class_label     text,
  subject_name    text,
  exam_date       date,
  enrolled        integer,
  present         integer,
  late            integer,
  absent          integer,
  medical         integer,
  unmarked        integer
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_role   text;
  v_school uuid;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_staff();

  IF NOT EXISTS (SELECT 1 FROM public.exams e
                 WHERE e.id = p_exam_id AND e.school_id = v_school) THEN
    RAISE EXCEPTION 'Exam not found';
  END IF;

  RETURN QUERY
  SELECT
    es.id,
    (c.name || COALESCE('-' || c.section, ''))::text,
    sub.name,
    es.exam_date,
    enr.n::integer,
    COALESCE(a.present, 0)::integer,
    COALESCE(a.late, 0)::integer,
    COALESCE(a.absent, 0)::integer,
    COALESCE(a.medical, 0)::integer,
    (enr.n - COALESCE(a.present,0) - COALESCE(a.late,0)
           - COALESCE(a.absent,0) - COALESCE(a.medical,0))::integer
  FROM public.exam_subjects es
  JOIN public.classes  c   ON c.id = es.class_id
  JOIN public.subjects sub ON sub.id = es.subject_id
  JOIN LATERAL (
    SELECT count(*) AS n
    FROM public.exam_enrollments ee
    WHERE ee.exam_id = es.exam_id AND ee.class_id = es.class_id
      AND ee.status = 'enrolled'
  ) enr ON true
  LEFT JOIN LATERAL (
    SELECT
      count(*) FILTER (WHERE ea.status = 'present') AS present,
      count(*) FILTER (WHERE ea.status = 'late')    AS late,
      count(*) FILTER (WHERE ea.status = 'absent')  AS absent,
      count(*) FILTER (WHERE ea.status = 'medical') AS medical
    FROM public.exam_attendance ea
    WHERE ea.exam_subject_id = es.id
  ) a ON true
  WHERE es.exam_id = p_exam_id AND NOT es.is_cancelled
  ORDER BY c.name, c.section, es.exam_date, sub.name;
END;
$$;

REVOKE ALL ON FUNCTION public.get_exam_attendance_report(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_exam_attendance_report(uuid) TO authenticated;


-- ============================================================
-- SECTION 3: PostgREST schema reload
-- ============================================================

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- END OF MIGRATION exam_attendance
-- ============================================================
