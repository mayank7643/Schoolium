-- ============================================================
-- SCHOOLIUM - EXAM MODULE PHASE 7 - exam_results
-- Grade scales, result computation, report cards (internal build).
-- Publishing + public access arrive in Phase 8.
-- Design: docs/exam-module/ Steps 2,4,8 (Group F).
-- Assumes: exam core..marks applied.
-- ============================================================
-- Contents:
--   SECTION 1  extensions (btree_gist for band exclusion)
--   SECTION 2  grade_scales, grade_bands (+ seed CBSE), grade_for()
--   SECTION 3  exam_results, report_cards, ai_report_analyses
--   SECTION 4  RLS
--   SECTION 5  RPCs: seed_cbse_grade_scale, upsert_grade_scale,
--              compute_exam_results, generate_report_cards,
--              set_report_card_remarks, get_class_result_summary,
--              get_student_result
--   SECTION 6  PostgREST schema reload
-- Idempotent throughout. Pure ASCII.
-- ============================================================


-- ============================================================
-- SECTION 1: EXTENSIONS
-- ============================================================
CREATE EXTENSION IF NOT EXISTS btree_gist;


-- ============================================================
-- SECTION 2: GRADE SCALES
-- ============================================================

CREATE TABLE IF NOT EXISTS public.grade_scales (
  id          uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id   uuid        NOT NULL REFERENCES public.schools(id)           ON DELETE CASCADE,
  session_id  uuid        REFERENCES public.academic_sessions(id)          ON DELETE SET NULL,
  name        text        NOT NULL,
  is_default  boolean     NOT NULL DEFAULT false,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_grade_scales_name UNIQUE (school_id, name)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_grade_scales_default
  ON public.grade_scales (school_id) WHERE is_default;

CREATE TABLE IF NOT EXISTS public.grade_bands (
  id             uuid         PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id      uuid         NOT NULL REFERENCES public.schools(id)      ON DELETE CASCADE,
  grade_scale_id uuid         NOT NULL REFERENCES public.grade_scales(id) ON DELETE CASCADE,
  min_percent    numeric(5,2) NOT NULL CHECK (min_percent >= 0  AND min_percent <= 100),
  max_percent    numeric(5,2) NOT NULL CHECK (max_percent >= 0  AND max_percent <= 100),
  grade_label    text         NOT NULL,
  grade_point    numeric(4,2),
  is_fail        boolean      NOT NULL DEFAULT false,
  description    text,
  CONSTRAINT ck_band_range CHECK (max_percent >= min_percent),
  -- no two bands of one scale may overlap (DB-enforced)
  CONSTRAINT ex_band_no_overlap EXCLUDE USING gist (
    grade_scale_id WITH =,
    numrange(min_percent, max_percent, '[]') WITH &&
  )
);

CREATE INDEX IF NOT EXISTS idx_grade_scales_school ON public.grade_scales(school_id);
CREATE INDEX IF NOT EXISTS idx_grade_bands_scale   ON public.grade_bands(grade_scale_id);

-- grade_for: resolve a percentage to a band of a scale
CREATE OR REPLACE FUNCTION public.grade_for(p_scale_id uuid, p_percent numeric)
RETURNS TABLE (grade_label text, grade_point numeric, is_fail boolean)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT gb.grade_label, gb.grade_point, gb.is_fail
  FROM public.grade_bands gb
  WHERE gb.grade_scale_id = p_scale_id
    AND p_percent >= gb.min_percent AND p_percent <= gb.max_percent
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.grade_for(uuid, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.grade_for(uuid, numeric) TO authenticated;


-- ============================================================
-- SECTION 3: RESULTS + REPORT CARDS + AI ANALYSES
-- ============================================================

CREATE TABLE IF NOT EXISTS public.exam_results (
  id                 uuid         PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id          uuid         NOT NULL REFERENCES public.schools(id)          ON DELETE CASCADE,
  exam_id            uuid         NOT NULL REFERENCES public.exams(id)            ON DELETE CASCADE,
  student_id         uuid         NOT NULL REFERENCES public.students(id)         ON DELETE CASCADE,
  enrollment_id      uuid         NOT NULL REFERENCES public.exam_enrollments(id) ON DELETE CASCADE,
  grade_scale_id     uuid         REFERENCES public.grade_scales(id)              ON DELETE RESTRICT,
  total_max          numeric(8,2) NOT NULL DEFAULT 0,
  total_obtained     numeric(8,2) NOT NULL DEFAULT 0,
  percentage         numeric(5,2) NOT NULL DEFAULT 0,
  grade_label        text,
  grade_point        numeric(4,2),
  subjects_failed    integer      NOT NULL DEFAULT 0,
  result_status      text         NOT NULL DEFAULT 'pass'
                                  CHECK (result_status IN ('pass','fail','withheld','absent')),
  rank_in_class      integer,
  attendance_percent numeric(5,2),
  is_final           boolean      NOT NULL DEFAULT true,
  computed_by        uuid         REFERENCES public.profiles(id) ON DELETE SET NULL,
  computed_at        timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT uq_exam_results UNIQUE (exam_id, student_id)
);

COMMENT ON COLUMN public.exam_results.is_final IS
  'reopen_marks (Phase 6) sets this false to force a recompute before re-publish.';

CREATE TABLE IF NOT EXISTS public.report_cards (
  id                   uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id            uuid        NOT NULL REFERENCES public.schools(id)           ON DELETE CASCADE,
  session_id           uuid        NOT NULL REFERENCES public.academic_sessions(id) ON DELETE RESTRICT,
  exam_id              uuid        REFERENCES public.exams(id)                      ON DELETE RESTRICT,
  term_id              uuid        REFERENCES public.academic_terms(id)             ON DELETE RESTRICT,
  student_id           uuid        NOT NULL REFERENCES public.students(id)          ON DELETE CASCADE,
  snapshot             jsonb       NOT NULL,
  class_teacher_remarks text,
  qr_token             uuid        NOT NULL UNIQUE DEFAULT uuid_generate_v4(),
  version              integer     NOT NULL DEFAULT 1,
  generated_by         uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  generated_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.report_cards IS
  'Immutable snapshot (jsonb) of the report card at generation time. '
  'Regeneration bumps version. exam_id RESTRICT: an exam with report '
  'cards cannot be deleted.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_report_cards_exam
  ON public.report_cards (student_id, exam_id) WHERE exam_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.ai_report_analyses (
  id             uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id      uuid        NOT NULL REFERENCES public.schools(id)  ON DELETE CASCADE,
  exam_id        uuid        NOT NULL REFERENCES public.exams(id)    ON DELETE CASCADE,
  student_id     uuid        NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  report_card_id uuid        REFERENCES public.report_cards(id)      ON DELETE SET NULL,
  provider       text,
  model          text,
  prompt_version text        NOT NULL DEFAULT 'v1',
  analysis       jsonb,
  input_tokens   integer,
  output_tokens  integer,
  status         text        NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending','completed','failed')),
  generated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_ai_analyses UNIQUE (exam_id, student_id, prompt_version)
);

CREATE INDEX IF NOT EXISTS idx_exam_results_exam    ON public.exam_results(exam_id, rank_in_class);
CREATE INDEX IF NOT EXISTS idx_exam_results_school  ON public.exam_results(school_id);
CREATE INDEX IF NOT EXISTS idx_exam_results_student ON public.exam_results(student_id);
CREATE INDEX IF NOT EXISTS idx_report_cards_school  ON public.report_cards(school_id);
CREATE INDEX IF NOT EXISTS idx_report_cards_exam    ON public.report_cards(exam_id);
CREATE INDEX IF NOT EXISTS idx_report_cards_student ON public.report_cards(student_id);
CREATE INDEX IF NOT EXISTS idx_ai_analyses_student  ON public.ai_report_analyses(student_id);


-- ============================================================
-- SECTION 4: RLS
-- ============================================================

ALTER TABLE public.grade_scales        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.grade_bands         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exam_results        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.report_cards        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_report_analyses  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "grade_scales_read" ON public.grade_scales;
CREATE POLICY "grade_scales_read" ON public.grade_scales FOR SELECT
  USING ( school_id = public.get_my_school_id() );
DROP POLICY IF EXISTS "grade_scales_admin_write" ON public.grade_scales;
CREATE POLICY "grade_scales_admin_write" ON public.grade_scales FOR ALL
  USING ( school_id = public.get_my_school_id() AND public.get_my_role() IN ('school_admin','principal') )
  WITH CHECK ( school_id = public.get_my_school_id() AND public.get_my_role() IN ('school_admin','principal') );

DROP POLICY IF EXISTS "grade_bands_read" ON public.grade_bands;
CREATE POLICY "grade_bands_read" ON public.grade_bands FOR SELECT
  USING ( school_id = public.get_my_school_id() );
DROP POLICY IF EXISTS "grade_bands_admin_write" ON public.grade_bands;
CREATE POLICY "grade_bands_admin_write" ON public.grade_bands FOR ALL
  USING ( school_id = public.get_my_school_id() AND public.get_my_role() IN ('school_admin','principal') )
  WITH CHECK ( school_id = public.get_my_school_id() AND public.get_my_role() IN ('school_admin','principal') );

-- results/report cards: admin/principal + class teacher of the class;
-- publishing (Phase 8) adds the public/parent surface. Writes RPC-only.
DROP POLICY IF EXISTS "exam_results_scoped_read" ON public.exam_results;
CREATE POLICY "exam_results_scoped_read" ON public.exam_results FOR SELECT
  USING (
    school_id = public.get_my_school_id()
    AND (
      public.get_my_role() IN ('school_admin','principal')
      OR EXISTS (
        SELECT 1 FROM public.exam_enrollments ee
        WHERE ee.id = enrollment_id
          AND ( public.is_class_teacher_of(ee.class_id) OR public.teaches_in_class(ee.class_id) )
      )
    )
  );

DROP POLICY IF EXISTS "report_cards_scoped_read" ON public.report_cards;
CREATE POLICY "report_cards_scoped_read" ON public.report_cards FOR SELECT
  USING (
    school_id = public.get_my_school_id()
    AND (
      public.get_my_role() IN ('school_admin','principal')
      OR EXISTS (
        SELECT 1 FROM public.students s
        WHERE s.id = student_id AND public.is_class_teacher_of(s.class_id)
      )
    )
  );

DROP POLICY IF EXISTS "ai_analyses_scoped_read" ON public.ai_report_analyses;
CREATE POLICY "ai_analyses_scoped_read" ON public.ai_report_analyses FOR SELECT
  USING (
    school_id = public.get_my_school_id()
    AND (
      public.get_my_role() IN ('school_admin','principal')
      OR EXISTS (
        SELECT 1 FROM public.students s
        WHERE s.id = student_id AND public.is_class_teacher_of(s.class_id)
      )
    )
  );


-- ============================================================
-- SECTION 5: RPCs
-- ============================================================

-- ------------------------------------------------------------
-- seed_cbse_grade_scale - CBSE 8-point default. Idempotent per school.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.seed_cbse_grade_scale(p_school_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_scale uuid;
BEGIN
  SELECT id INTO v_scale FROM public.grade_scales
  WHERE school_id = p_school_id AND name = 'CBSE (default)';

  IF v_scale IS NOT NULL THEN
    RETURN v_scale;
  END IF;

  INSERT INTO public.grade_scales (school_id, name, is_default, is_active)
  VALUES (p_school_id, 'CBSE (default)',
          NOT EXISTS (SELECT 1 FROM public.grade_scales WHERE school_id = p_school_id AND is_default),
          true)
  RETURNING id INTO v_scale;

  INSERT INTO public.grade_bands (school_id, grade_scale_id, min_percent, max_percent, grade_label, grade_point, is_fail)
  VALUES
    (p_school_id, v_scale, 91, 100, 'A1', 10.0, false),
    (p_school_id, v_scale, 81, 90.99, 'A2', 9.0, false),
    (p_school_id, v_scale, 71, 80.99, 'B1', 8.0, false),
    (p_school_id, v_scale, 61, 70.99, 'B2', 7.0, false),
    (p_school_id, v_scale, 51, 60.99, 'C1', 6.0, false),
    (p_school_id, v_scale, 41, 50.99, 'C2', 5.0, false),
    (p_school_id, v_scale, 33, 40.99, 'D',  4.0, false),
    (p_school_id, v_scale, 0,  32.99, 'E',  NULL, true);

  RETURN v_scale;
END;
$$;

REVOKE ALL ON FUNCTION public.seed_cbse_grade_scale(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.seed_cbse_grade_scale(uuid) TO authenticated;

-- ------------------------------------------------------------
-- ensure_grade_scale - INTERNAL: pick the scale for an exam
-- (session-specific default, else school default, else seed CBSE).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_grade_scale(p_school uuid, p_session uuid)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_scale uuid;
BEGIN
  SELECT id INTO v_scale FROM public.grade_scales
  WHERE school_id = p_school AND session_id = p_session AND is_active
  ORDER BY is_default DESC LIMIT 1;
  IF v_scale IS NOT NULL THEN RETURN v_scale; END IF;

  SELECT id INTO v_scale FROM public.grade_scales
  WHERE school_id = p_school AND is_default AND is_active LIMIT 1;
  IF v_scale IS NOT NULL THEN RETURN v_scale; END IF;

  RETURN public.seed_cbse_grade_scale(p_school);
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_grade_scale(uuid, uuid) FROM PUBLIC;

-- ------------------------------------------------------------
-- compute_exam_results - requires all live papers frozen.
-- Weightage-aware within the exam; exempt subjects excluded;
-- dense-rank per class; attendance % from class_attendance over
-- the session. Re-runnable. withdrawn/transferred -> withheld.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.compute_exam_results(p_exam_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role     text;
  v_school   uuid;
  v_exam     public.exams;
  v_unfrozen integer;
  v_scale    uuid;
  v_computed integer;
  v_withheld integer;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_admin();
  v_exam := public.lock_exam_row(p_exam_id, v_school);

  IF v_exam.status NOT IN ('completed', 'locked') THEN
    RAISE EXCEPTION 'Results can only be computed for a completed or locked exam (current: %)', v_exam.status;
  END IF;

  -- every live paper must be frozen
  SELECT count(*) INTO v_unfrozen
  FROM public.exam_subjects es
  LEFT JOIN public.marks_submissions ms ON ms.exam_subject_id = es.id
  WHERE es.exam_id = p_exam_id AND NOT es.is_cancelled
    AND (ms.status IS NULL OR ms.status <> 'frozen');
  IF v_unfrozen > 0 THEN
    RAISE EXCEPTION 'Cannot compute: % paper(s) are not frozen yet', v_unfrozen;
  END IF;

  v_scale := public.resolve_grade_scale(v_school, v_exam.session_id);

  -- fresh recompute
  DELETE FROM public.exam_results WHERE exam_id = p_exam_id;

  -- per-student aggregation over their class's non-cancelled papers,
  -- excluding subjects the student is exempt from (session or per-mark)
  WITH lines AS (
    SELECT ee.id AS enrollment_id, ee.student_id, ee.class_id, ee.status AS enroll_status,
           es.id AS paper_id, es.pass_marks, es.total_max_marks, es.weightage_percent,
           me.total_marks, me.is_absent, me.is_exempted,
           EXISTS (
             SELECT 1 FROM public.student_subject_overrides sso
             WHERE sso.session_id = v_exam.session_id
               AND sso.student_id = ee.student_id
               AND sso.subject_id = es.subject_id
               AND sso.kind = 'exempted'
           ) AS session_exempt
    FROM public.exam_enrollments ee
    JOIN public.exam_subjects es
      ON es.exam_id = ee.exam_id AND es.class_id = ee.class_id AND NOT es.is_cancelled
    LEFT JOIN public.marks_entries me
      ON me.exam_subject_id = es.id AND me.student_id = ee.student_id
    WHERE ee.exam_id = p_exam_id
  ),
  counted AS (
    SELECT * FROM lines WHERE NOT session_exempt AND NOT COALESCE(is_exempted, false)
  ),
  agg AS (
    SELECT enrollment_id, student_id, class_id, enroll_status,
           COALESCE(SUM(total_max_marks), 0) AS total_max,
           COALESCE(SUM(COALESCE(total_marks, 0)), 0) AS total_obtained,
           COUNT(*) FILTER (WHERE COALESCE(is_absent,false)) AS absent_papers,
           COUNT(*) AS paper_count,
           COUNT(*) FILTER (
             WHERE NOT COALESCE(is_absent,false)
               AND COALESCE(total_marks, 0) < pass_marks
           ) + COUNT(*) FILTER (WHERE COALESCE(is_absent,false)) AS failed_subjects
    FROM counted
    GROUP BY enrollment_id, student_id, class_id, enroll_status
  ),
  scored AS (
    SELECT a.*,
      CASE WHEN a.total_max > 0 THEN round(a.total_obtained / a.total_max * 100, 2) ELSE 0 END AS pct,
      CASE
        WHEN a.enroll_status IN ('withdrawn','transferred') THEN 'withheld'
        WHEN a.paper_count > 0 AND a.absent_papers = a.paper_count THEN 'absent'
        WHEN a.failed_subjects > 0 THEN 'fail'
        ELSE 'pass'
      END AS status
    FROM agg a
  ),
  ranked AS (
    SELECT s.*,
      CASE WHEN s.status IN ('pass','fail')
           THEN dense_rank() OVER (PARTITION BY s.class_id
                  ORDER BY (CASE WHEN s.status IN ('pass','fail') THEN s.pct END) DESC NULLS LAST)
           END AS rnk
    FROM scored s
  )
  INSERT INTO public.exam_results
    (school_id, exam_id, student_id, enrollment_id, grade_scale_id,
     total_max, total_obtained, percentage, grade_label, grade_point,
     subjects_failed, result_status, rank_in_class, attendance_percent,
     is_final, computed_by, computed_at)
  SELECT v_school, p_exam_id, r.student_id, r.enrollment_id, v_scale,
         r.total_max, r.total_obtained, r.pct,
         CASE WHEN r.status IN ('pass','fail') THEN (SELECT grade_label FROM public.grade_for(v_scale, r.pct)) END,
         CASE WHEN r.status IN ('pass','fail') THEN (SELECT grade_point FROM public.grade_for(v_scale, r.pct)) END,
         r.failed_subjects, r.status,
         CASE WHEN r.status IN ('pass','fail') THEN r.rnk END,
         (
           SELECT round(100.0 * count(*) FILTER (WHERE ca.status IN ('present','late'))
                        / NULLIF(count(*), 0), 2)
           FROM public.class_attendance ca
           JOIN public.academic_sessions ses ON ses.id = v_exam.session_id
           WHERE ca.student_id = r.student_id
             AND ca.attendance_date BETWEEN ses.start_date AND ses.end_date
         ),
         true, auth.uid(), now()
  FROM ranked r;

  GET DIAGNOSTICS v_computed = ROW_COUNT;
  SELECT count(*) INTO v_withheld FROM public.exam_results
  WHERE exam_id = p_exam_id AND result_status = 'withheld';

  PERFORM public.log_exam_audit(v_school, 'result', p_exam_id, 'compute',
            NULL, jsonb_build_object('computed', v_computed, 'withheld', v_withheld));

  RETURN jsonb_build_object('computed', v_computed, 'withheld', v_withheld);
END;
$$;

REVOKE ALL ON FUNCTION public.compute_exam_results(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.compute_exam_results(uuid) TO authenticated;

-- ------------------------------------------------------------
-- generate_report_cards - build immutable jsonb snapshots from the
-- computed results + marks. Re-run bumps version. Excludes withheld.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.generate_report_cards(p_exam_id uuid, p_class_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role      text;
  v_school    uuid;
  v_exam      public.exams;
  v_generated integer := 0;
  v_rec       record;
  v_snapshot  jsonb;
  v_subjects  jsonb;
  v_existing  uuid;
  v_school_row record;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_admin();
  v_exam := public.lock_exam_row(p_exam_id, v_school);

  IF v_exam.status NOT IN ('completed','locked') THEN
    RAISE EXCEPTION 'Report cards need a completed or locked exam';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.exam_results WHERE exam_id = p_exam_id AND is_final) THEN
    RAISE EXCEPTION 'Compute results first (or recompute after a reopen)';
  END IF;

  SELECT name, address, logo_url INTO v_school_row FROM public.schools WHERE id = v_school;

  FOR v_rec IN
    SELECT er.*, s.full_name, s.student_uid, s.photo_url, s.date_of_birth,
           ee.roll_number, c.name AS class_name, c.section
    FROM public.exam_results er
    JOIN public.students s ON s.id = er.student_id
    JOIN public.exam_enrollments ee ON ee.id = er.enrollment_id
    JOIN public.classes c ON c.id = ee.class_id
    WHERE er.exam_id = p_exam_id
      AND er.result_status <> 'withheld'
      AND (p_class_id IS NULL OR ee.class_id = p_class_id)
  LOOP
    -- per-subject lines for this student
    SELECT jsonb_agg(jsonb_build_object(
             'subject', sub.name,
             'max', es.total_max_marks,
             'theory', me.theory_marks, 'practical', me.practical_marks,
             'internal', me.internal_marks, 'grace', me.grace_marks,
             'total', me.total_marks, 'pass_marks', es.pass_marks,
             'is_absent', COALESCE(me.is_absent,false),
             'grade', (SELECT grade_label FROM public.grade_for(v_rec.grade_scale_id,
                        CASE WHEN es.total_max_marks > 0 THEN COALESCE(me.total_marks,0)/es.total_max_marks*100 ELSE 0 END))
           ) ORDER BY sub.name)
    INTO v_subjects
    FROM public.exam_subjects es
    JOIN public.subjects sub ON sub.id = es.subject_id
    LEFT JOIN public.marks_entries me ON me.exam_subject_id = es.id AND me.student_id = v_rec.student_id
    WHERE es.exam_id = p_exam_id AND es.class_id = (SELECT class_id FROM public.exam_enrollments WHERE id = v_rec.enrollment_id)
      AND NOT es.is_cancelled
      AND NOT EXISTS (
        SELECT 1 FROM public.student_subject_overrides sso
        WHERE sso.session_id = v_exam.session_id AND sso.student_id = v_rec.student_id
          AND sso.subject_id = es.subject_id AND sso.kind = 'exempted');

    v_snapshot := jsonb_build_object(
      'school', jsonb_build_object('name', v_school_row.name, 'address', v_school_row.address, 'logo_url', v_school_row.logo_url),
      'exam', jsonb_build_object('name', v_exam.name),
      'student', jsonb_build_object(
        'full_name', v_rec.full_name, 'student_uid', v_rec.student_uid,
        'photo_url', v_rec.photo_url, 'roll_number', v_rec.roll_number,
        'class', v_rec.class_name || COALESCE('-' || v_rec.section, '')),
      'result', jsonb_build_object(
        'total_max', v_rec.total_max, 'total_obtained', v_rec.total_obtained,
        'percentage', v_rec.percentage, 'grade', v_rec.grade_label, 'cgpa', v_rec.grade_point,
        'status', v_rec.result_status, 'rank', v_rec.rank_in_class,
        'attendance_percent', v_rec.attendance_percent, 'subjects_failed', v_rec.subjects_failed),
      'subjects', COALESCE(v_subjects, '[]'::jsonb)
    );

    SELECT id INTO v_existing FROM public.report_cards
    WHERE exam_id = p_exam_id AND student_id = v_rec.student_id;

    IF v_existing IS NULL THEN
      INSERT INTO public.report_cards
        (school_id, session_id, exam_id, term_id, student_id, snapshot, generated_by)
      VALUES (v_school, v_exam.session_id, p_exam_id, v_exam.term_id, v_rec.student_id, v_snapshot, auth.uid());
    ELSE
      UPDATE public.report_cards
      SET snapshot = v_snapshot, version = version + 1, generated_by = auth.uid(), generated_at = now()
      WHERE id = v_existing;
    END IF;

    v_generated := v_generated + 1;
  END LOOP;

  PERFORM public.log_exam_audit(v_school, 'result', p_exam_id, 'generate_report_cards',
            NULL, jsonb_build_object('generated', v_generated));

  RETURN jsonb_build_object('generated', v_generated);
END;
$$;

REVOKE ALL ON FUNCTION public.generate_report_cards(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.generate_report_cards(uuid, uuid) TO authenticated;

-- ------------------------------------------------------------
-- set_report_card_remarks - class teacher / admin adds remarks
-- (merged into the snapshot too, so the PDF and QR page match).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_report_card_remarks(p_report_card_id uuid, p_remarks text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role   text;
  v_school uuid;
  v_class  uuid;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_staff();

  SELECT s.class_id INTO v_class
  FROM public.report_cards rc
  JOIN public.students s ON s.id = rc.student_id
  WHERE rc.id = p_report_card_id AND rc.school_id = v_school;

  IF v_class IS NULL THEN
    RAISE EXCEPTION 'Report card not found';
  END IF;
  IF NOT (v_role IN ('school_admin','principal') OR public.is_class_teacher_of(v_class)) THEN
    RAISE EXCEPTION 'Access denied: only the class teacher or admin can add remarks';
  END IF;

  UPDATE public.report_cards
  SET class_teacher_remarks = p_remarks,
      snapshot = jsonb_set(snapshot, '{remarks}', to_jsonb(p_remarks))
  WHERE id = p_report_card_id;
END;
$$;

REVOKE ALL ON FUNCTION public.set_report_card_remarks(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_report_card_remarks(uuid, text) TO authenticated;

-- ------------------------------------------------------------
-- get_class_result_summary - per class: avg %, pass %, topper
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_class_result_summary(p_exam_id uuid)
RETURNS TABLE (
  class_id      uuid,
  class_label   text,
  students      integer,
  average_pct   numeric,
  pass_count    integer,
  fail_count    integer,
  pass_pct      numeric,
  topper_name   text,
  topper_pct    numeric
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
  IF NOT EXISTS (SELECT 1 FROM public.exams e WHERE e.id = p_exam_id AND e.school_id = v_school) THEN
    RAISE EXCEPTION 'Exam not found';
  END IF;

  RETURN QUERY
  WITH r AS (
    SELECT er.*, ee.class_id, s.full_name
    FROM public.exam_results er
    JOIN public.exam_enrollments ee ON ee.id = er.enrollment_id
    JOIN public.students s ON s.id = er.student_id
    WHERE er.exam_id = p_exam_id AND er.result_status IN ('pass','fail')
  )
  SELECT c.id,
         (c.name || COALESCE('-' || c.section, ''))::text,
         count(*)::integer,
         round(avg(r.percentage), 2),
         count(*) FILTER (WHERE r.result_status = 'pass')::integer,
         count(*) FILTER (WHERE r.result_status = 'fail')::integer,
         round(100.0 * count(*) FILTER (WHERE r.result_status = 'pass') / NULLIF(count(*),0), 2),
         (SELECT r2.full_name FROM r r2 WHERE r2.class_id = c.id ORDER BY r2.percentage DESC LIMIT 1),
         (SELECT max(r2.percentage) FROM r r2 WHERE r2.class_id = c.id)
  FROM r
  JOIN public.classes c ON c.id = r.class_id
  GROUP BY c.id, c.name, c.section
  ORDER BY c.name, c.section;
END;
$$;

REVOKE ALL ON FUNCTION public.get_class_result_summary(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_class_result_summary(uuid) TO authenticated;


-- ============================================================
-- SECTION 6: PostgREST schema reload
-- ============================================================

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- END OF MIGRATION exam_results
-- ============================================================
