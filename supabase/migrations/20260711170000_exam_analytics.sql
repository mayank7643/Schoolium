-- ============================================================
-- SCHOOLIUM - EXAM MODULE PHASE 9 - exam_analytics
-- Reporting + analytics read RPCs (charts + tabular report PDFs).
-- Design: docs/exam-module/ Step 4 RPC catalog (Phase 9).
-- Assumes: exam core..publishing applied. Read-only; no new tables.
-- ============================================================
-- Contents:
--   grade distribution, topper list, subject performance, fail list,
--   grade-distribution, teacher performance, school performance
--   dashboard, student progress trend.
-- All SECURITY DEFINER STABLE, permission-scoped, school-isolated.
-- Idempotent (CREATE OR REPLACE). Pure ASCII.
-- ============================================================


-- ------------------------------------------------------------
-- get_grade_distribution(exam_id, class_id?) - count per grade band
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_grade_distribution(p_exam_id uuid, p_class_id uuid DEFAULT NULL)
RETURNS TABLE (grade_label text, sort_min numeric, student_count integer)
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public
AS $$
DECLARE v_role text; v_school uuid;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_staff();
  IF NOT EXISTS (SELECT 1 FROM public.exams e WHERE e.id = p_exam_id AND e.school_id = v_school) THEN
    RAISE EXCEPTION 'Exam not found';
  END IF;

  RETURN QUERY
  SELECT gb.grade_label, gb.min_percent, count(er.id)::integer
  FROM public.exam_results er
  JOIN public.exam_enrollments ee ON ee.id = er.enrollment_id
  JOIN public.grade_bands gb ON gb.grade_scale_id = er.grade_scale_id
   AND er.percentage >= gb.min_percent AND er.percentage <= gb.max_percent
  WHERE er.exam_id = p_exam_id AND er.result_status IN ('pass','fail')
    AND (p_class_id IS NULL OR ee.class_id = p_class_id)
  GROUP BY gb.grade_label, gb.min_percent
  ORDER BY gb.min_percent DESC;
END;
$$;
REVOKE ALL ON FUNCTION public.get_grade_distribution(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_grade_distribution(uuid, uuid) TO authenticated;

-- ------------------------------------------------------------
-- get_topper_list(exam_id, class_id?, limit)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_topper_list(p_exam_id uuid, p_class_id uuid DEFAULT NULL, p_limit integer DEFAULT 10)
RETURNS TABLE (rank_in_class integer, student_name text, class_label text, percentage numeric, grade_label text)
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public
AS $$
DECLARE v_role text; v_school uuid;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_staff();
  IF NOT EXISTS (SELECT 1 FROM public.exams e WHERE e.id = p_exam_id AND e.school_id = v_school) THEN
    RAISE EXCEPTION 'Exam not found';
  END IF;

  RETURN QUERY
  SELECT er.rank_in_class, s.full_name,
         (c.name || COALESCE('-' || c.section, ''))::text,
         er.percentage, er.grade_label
  FROM public.exam_results er
  JOIN public.students s ON s.id = er.student_id
  JOIN public.exam_enrollments ee ON ee.id = er.enrollment_id
  JOIN public.classes c ON c.id = ee.class_id
  WHERE er.exam_id = p_exam_id AND er.result_status = 'pass'
    AND (p_class_id IS NULL OR ee.class_id = p_class_id)
  ORDER BY er.percentage DESC
  LIMIT GREATEST(COALESCE(p_limit, 10), 1);
END;
$$;
REVOKE ALL ON FUNCTION public.get_topper_list(uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_topper_list(uuid, uuid, integer) TO authenticated;

-- ------------------------------------------------------------
-- get_subject_performance(exam_id, class_id?)
-- avg %, pass %, highest, lowest per subject (across marks_entries)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_subject_performance(p_exam_id uuid, p_class_id uuid DEFAULT NULL)
RETURNS TABLE (
  subject_name text, students integer, average_pct numeric,
  pass_pct numeric, highest numeric, lowest numeric
)
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public
AS $$
DECLARE v_role text; v_school uuid;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_staff();
  IF NOT EXISTS (SELECT 1 FROM public.exams e WHERE e.id = p_exam_id AND e.school_id = v_school) THEN
    RAISE EXCEPTION 'Exam not found';
  END IF;

  RETURN QUERY
  WITH m AS (
    SELECT sub.name AS subject_name, es.pass_marks, es.total_max_marks,
           me.total_marks,
           CASE WHEN es.total_max_marks > 0 THEN me.total_marks / es.total_max_marks * 100 ELSE 0 END AS pct,
           (NOT COALESCE(me.is_absent,false) AND COALESCE(me.total_marks,0) >= es.pass_marks) AS passed
    FROM public.exam_subjects es
    JOIN public.subjects sub ON sub.id = es.subject_id
    JOIN public.marks_entries me ON me.exam_subject_id = es.id
    WHERE es.exam_id = p_exam_id AND NOT es.is_cancelled
      AND NOT COALESCE(me.is_absent,false) AND NOT COALESCE(me.is_exempted,false)
      AND (p_class_id IS NULL OR es.class_id = p_class_id)
  )
  SELECT m.subject_name, count(*)::integer,
         round(avg(m.pct), 2),
         round(100.0 * count(*) FILTER (WHERE m.passed) / NULLIF(count(*),0), 2),
         round(max(m.pct), 2), round(min(m.pct), 2)
  FROM m
  GROUP BY m.subject_name
  ORDER BY m.subject_name;
END;
$$;
REVOKE ALL ON FUNCTION public.get_subject_performance(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_subject_performance(uuid, uuid) TO authenticated;

-- ------------------------------------------------------------
-- get_fail_list(exam_id, class_id?)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_fail_list(p_exam_id uuid, p_class_id uuid DEFAULT NULL)
RETURNS TABLE (
  student_name text, class_label text, roll_number integer,
  percentage numeric, subjects_failed integer
)
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public
AS $$
DECLARE v_role text; v_school uuid;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_staff();
  IF NOT EXISTS (SELECT 1 FROM public.exams e WHERE e.id = p_exam_id AND e.school_id = v_school) THEN
    RAISE EXCEPTION 'Exam not found';
  END IF;

  RETURN QUERY
  SELECT s.full_name, (c.name || COALESCE('-' || c.section, ''))::text,
         ee.roll_number, er.percentage, er.subjects_failed
  FROM public.exam_results er
  JOIN public.students s ON s.id = er.student_id
  JOIN public.exam_enrollments ee ON ee.id = er.enrollment_id
  JOIN public.classes c ON c.id = ee.class_id
  WHERE er.exam_id = p_exam_id AND er.result_status = 'fail'
    AND (p_class_id IS NULL OR ee.class_id = p_class_id)
  ORDER BY c.name, c.section, ee.roll_number;
END;
$$;
REVOKE ALL ON FUNCTION public.get_fail_list(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_fail_list(uuid, uuid) TO authenticated;

-- ------------------------------------------------------------
-- get_teacher_performance(session_id) - avg subject result per
-- assigned subject teacher across the session (admin/principal only,
-- framed as subject outcomes).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_teacher_performance(p_session_id uuid)
RETURNS TABLE (
  staff_id uuid, teacher_name text, subject_name text, class_label text,
  papers integer, students integer, average_pct numeric, pass_pct numeric
)
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public
AS $$
DECLARE v_role text; v_school uuid;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_admin();
  IF NOT EXISTS (SELECT 1 FROM public.academic_sessions ses WHERE ses.id = p_session_id AND ses.school_id = v_school) THEN
    RAISE EXCEPTION 'Session not found';
  END IF;

  RETURN QUERY
  WITH m AS (
    SELECT sa.staff_id, st.full_name AS teacher_name, sub.name AS subject_name,
           (c.name || COALESCE('-' || c.section, ''))::text AS class_label,
           es.id AS paper_id, es.pass_marks, es.total_max_marks,
           me.total_marks,
           CASE WHEN es.total_max_marks > 0 THEN me.total_marks / es.total_max_marks * 100 ELSE 0 END AS pct,
           (NOT COALESCE(me.is_absent,false) AND COALESCE(me.total_marks,0) >= es.pass_marks) AS passed
    FROM public.exams e
    JOIN public.exam_subjects es ON es.exam_id = e.id AND NOT es.is_cancelled
    JOIN public.subjects sub ON sub.id = es.subject_id
    JOIN public.classes c ON c.id = es.class_id
    JOIN public.subject_assignments sa
      ON sa.subject_id = es.subject_id AND sa.class_id = es.class_id
    JOIN public.staff st ON st.id = sa.staff_id
    JOIN public.marks_entries me ON me.exam_subject_id = es.id
    WHERE e.session_id = p_session_id
      AND NOT COALESCE(me.is_absent,false) AND NOT COALESCE(me.is_exempted,false)
  )
  SELECT m.staff_id, m.teacher_name, m.subject_name, m.class_label,
         count(DISTINCT m.paper_id)::integer, count(*)::integer,
         round(avg(m.pct), 2),
         round(100.0 * count(*) FILTER (WHERE m.passed) / NULLIF(count(*),0), 2)
  FROM m
  GROUP BY m.staff_id, m.teacher_name, m.subject_name, m.class_label
  ORDER BY m.teacher_name, m.subject_name;
END;
$$;
REVOKE ALL ON FUNCTION public.get_teacher_performance(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_teacher_performance(uuid) TO authenticated;

-- ------------------------------------------------------------
-- get_school_performance(session_id) - per-exam KPIs for comparison
-- (one row per exam that has computed results).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_school_performance(p_session_id uuid)
RETURNS TABLE (
  exam_id uuid, exam_name text, start_date date,
  students integer, average_pct numeric, pass_pct numeric
)
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public
AS $$
DECLARE v_role text; v_school uuid;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_staff();
  IF NOT EXISTS (SELECT 1 FROM public.academic_sessions ses WHERE ses.id = p_session_id AND ses.school_id = v_school) THEN
    RAISE EXCEPTION 'Session not found';
  END IF;

  RETURN QUERY
  SELECT e.id, e.name, e.start_date,
         count(er.id)::integer,
         round(avg(er.percentage), 2),
         round(100.0 * count(*) FILTER (WHERE er.result_status = 'pass') / NULLIF(count(*),0), 2)
  FROM public.exams e
  JOIN public.exam_results er ON er.exam_id = e.id AND er.result_status IN ('pass','fail')
  WHERE e.session_id = p_session_id
  GROUP BY e.id, e.name, e.start_date
  ORDER BY e.start_date NULLS LAST, e.name;
END;
$$;
REVOKE ALL ON FUNCTION public.get_school_performance(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_school_performance(uuid) TO authenticated;

-- ------------------------------------------------------------
-- get_student_progress(student_id, session_id) - exam-over-exam
-- percentage trend for one student.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_student_progress(p_student_id uuid, p_session_id uuid)
RETURNS TABLE (
  exam_id uuid, exam_name text, start_date date,
  percentage numeric, grade_label text, rank_in_class integer, result_status text
)
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public
AS $$
DECLARE v_role text; v_school uuid; v_class uuid;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_staff();

  SELECT class_id INTO v_class FROM public.students
  WHERE id = p_student_id AND school_id = v_school;
  IF v_class IS NULL THEN
    RAISE EXCEPTION 'Student not found';
  END IF;
  -- teachers may only see students of their classes
  IF NOT (v_role IN ('school_admin','principal')
          OR public.is_class_teacher_of(v_class) OR public.teaches_in_class(v_class)) THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  RETURN QUERY
  SELECT e.id, e.name, e.start_date, er.percentage, er.grade_label,
         er.rank_in_class, er.result_status
  FROM public.exam_results er
  JOIN public.exams e ON e.id = er.exam_id
  WHERE er.student_id = p_student_id AND e.session_id = p_session_id
  ORDER BY e.start_date NULLS LAST, e.name;
END;
$$;
REVOKE ALL ON FUNCTION public.get_student_progress(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_student_progress(uuid, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- END OF MIGRATION exam_analytics
-- ============================================================
