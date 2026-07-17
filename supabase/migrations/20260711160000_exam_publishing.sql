-- ============================================================
-- SCHOOLIUM - EXAM MODULE PHASE 8 - exam_publishing
-- Result publishing + public (anonymous) access.
-- Design: docs/exam-module/ Steps 2,4,5,9 (Group F publishing).
-- Assumes: exam core..results applied.
-- ============================================================
-- Contents:
--   SECTION 1  result_publications table + RLS
--   SECTION 2  publishing RPCs (publish/schedule/unpublish/lock)
--   SECTION 3  lock hardening: reopen_marks + compute_exam_results
--              refuse once results are locked (CREATE OR REPLACE)
--   SECTION 4  public rate-limit helper + anon RPCs
--              (list_public_result_exams, check_result_public,
--               verify_report_card) + notification targets helper
--   SECTION 5  pg_cron: fire due scheduled publications
--   SECTION 6  PostgREST schema reload
-- Idempotent throughout. Pure ASCII.
-- ============================================================


-- ============================================================
-- SECTION 1: result_publications
-- ============================================================

CREATE TABLE IF NOT EXISTS public.result_publications (
  id              uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id       uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  exam_id         uuid        NOT NULL REFERENCES public.exams(id)   ON DELETE CASCADE,
  status          text        NOT NULL DEFAULT 'unpublished'
                              CHECK (status IN ('unpublished','scheduled','published','locked')),
  scheduled_for   timestamptz,
  published_at    timestamptz,
  published_by    uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  unpublished_at  timestamptz,
  unpublished_by  uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_result_publications UNIQUE (exam_id)
);

CREATE INDEX IF NOT EXISTS idx_result_pub_school ON public.result_publications(school_id, status);
CREATE INDEX IF NOT EXISTS idx_result_pub_due    ON public.result_publications(status, scheduled_for)
  WHERE status = 'scheduled';

DROP TRIGGER IF EXISTS trg_result_pub_updated_at ON public.result_publications;
CREATE TRIGGER trg_result_pub_updated_at
  BEFORE UPDATE ON public.result_publications
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

ALTER TABLE public.result_publications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "result_pub_school_read" ON public.result_publications;
CREATE POLICY "result_pub_school_read"
  ON public.result_publications FOR SELECT
  USING ( school_id = public.get_my_school_id() );
-- writes RPC-only


-- ============================================================
-- SECTION 2: PUBLISHING RPCs
-- ============================================================

-- INTERNAL: get-or-create the publication row, locked.
CREATE OR REPLACE FUNCTION public.ensure_result_publication(p_exam_id uuid, p_school uuid)
RETURNS public.result_publications
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_pub public.result_publications;
BEGIN
  SELECT * INTO v_pub FROM public.result_publications
  WHERE exam_id = p_exam_id FOR UPDATE;
  IF v_pub.id IS NULL THEN
    INSERT INTO public.result_publications (school_id, exam_id)
    VALUES (p_school, p_exam_id)
    RETURNING * INTO v_pub;
  END IF;
  RETURN v_pub;
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_result_publication(uuid, uuid) FROM PUBLIC;

-- INTERNAL: preconditions shared by publish + schedule.
CREATE OR REPLACE FUNCTION public.assert_results_publishable(p_exam_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_stale  integer;
  v_cards  integer;
BEGIN
  SELECT status INTO v_status FROM public.exams WHERE id = p_exam_id;
  IF v_status NOT IN ('completed', 'locked') THEN
    RAISE EXCEPTION 'The exam must be completed before results can be published';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.exam_results WHERE exam_id = p_exam_id) THEN
    RAISE EXCEPTION 'Compute results before publishing';
  END IF;

  SELECT count(*) INTO v_stale FROM public.exam_results
  WHERE exam_id = p_exam_id AND NOT is_final;
  IF v_stale > 0 THEN
    RAISE EXCEPTION 'Results are stale (marks were reopened) - recompute before publishing';
  END IF;

  SELECT count(*) INTO v_cards FROM public.report_cards WHERE exam_id = p_exam_id;
  IF v_cards = 0 THEN
    RAISE EXCEPTION 'Generate report cards before publishing';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_results_publishable(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.publish_results(p_exam_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role   text;
  v_school uuid;
  v_pub    public.result_publications;
  v_count  integer;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_admin();
  PERFORM public.lock_exam_row(p_exam_id, v_school);  -- tenancy + existence
  PERFORM public.assert_results_publishable(p_exam_id);

  v_pub := public.ensure_result_publication(p_exam_id, v_school);
  IF v_pub.status = 'locked' THEN
    RAISE EXCEPTION 'Results are locked and cannot be republished';
  END IF;

  UPDATE public.result_publications
  SET status = 'published', published_at = now(), published_by = auth.uid(),
      scheduled_for = NULL
  WHERE id = v_pub.id;

  SELECT count(*) INTO v_count FROM public.report_cards WHERE exam_id = p_exam_id;

  PERFORM public.log_exam_audit(v_school, 'publication', p_exam_id, 'publish',
            NULL, jsonb_build_object('report_cards', v_count));

  RETURN jsonb_build_object('status', 'published', 'report_cards', v_count);
END;
$$;

REVOKE ALL ON FUNCTION public.publish_results(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.publish_results(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.schedule_results(p_exam_id uuid, p_when timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role   text;
  v_school uuid;
  v_pub    public.result_publications;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_admin();
  PERFORM public.lock_exam_row(p_exam_id, v_school);
  PERFORM public.assert_results_publishable(p_exam_id);

  IF p_when IS NULL OR p_when <= now() THEN
    RAISE EXCEPTION 'Schedule time must be in the future';
  END IF;

  v_pub := public.ensure_result_publication(p_exam_id, v_school);
  IF v_pub.status = 'locked' THEN
    RAISE EXCEPTION 'Results are locked';
  END IF;

  UPDATE public.result_publications
  SET status = 'scheduled', scheduled_for = p_when
  WHERE id = v_pub.id;

  PERFORM public.log_exam_audit(v_school, 'publication', p_exam_id, 'schedule',
            NULL, jsonb_build_object('scheduled_for', p_when));

  RETURN jsonb_build_object('status', 'scheduled', 'scheduled_for', p_when);
END;
$$;

REVOKE ALL ON FUNCTION public.schedule_results(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.schedule_results(uuid, timestamptz) TO authenticated;

CREATE OR REPLACE FUNCTION public.unpublish_results(p_exam_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role   text;
  v_school uuid;
  v_pub    public.result_publications;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_admin();

  SELECT * INTO v_pub FROM public.result_publications
  WHERE exam_id = p_exam_id AND school_id = v_school FOR UPDATE;
  IF v_pub.id IS NULL THEN
    RAISE EXCEPTION 'Nothing to unpublish';
  END IF;
  IF v_pub.status = 'locked' THEN
    RAISE EXCEPTION 'Results are locked and cannot be unpublished';
  END IF;
  IF v_pub.status NOT IN ('published', 'scheduled') THEN
    RAISE EXCEPTION 'Results are not published';
  END IF;

  UPDATE public.result_publications
  SET status = 'unpublished', unpublished_at = now(), unpublished_by = auth.uid(),
      scheduled_for = NULL
  WHERE id = v_pub.id;

  PERFORM public.log_exam_audit(v_school, 'publication', p_exam_id, 'unpublish');
  RETURN jsonb_build_object('status', 'unpublished');
END;
$$;

REVOKE ALL ON FUNCTION public.unpublish_results(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.unpublish_results(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.lock_results(p_exam_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role   text;
  v_school uuid;
  v_pub    public.result_publications;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_admin();

  SELECT * INTO v_pub FROM public.result_publications
  WHERE exam_id = p_exam_id AND school_id = v_school FOR UPDATE;
  IF v_pub.id IS NULL OR v_pub.status <> 'published' THEN
    RAISE EXCEPTION 'Only published results can be locked';
  END IF;

  UPDATE public.result_publications SET status = 'locked' WHERE id = v_pub.id;
  PERFORM public.log_exam_audit(v_school, 'publication', p_exam_id, 'lock');
  RETURN jsonb_build_object('status', 'locked');
END;
$$;

REVOKE ALL ON FUNCTION public.lock_results(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lock_results(uuid) TO authenticated;


-- ============================================================
-- SECTION 3: LOCK HARDENING - reopen/compute refuse when locked
-- ============================================================

-- reopen_marks: block if the exam's results are locked (terminal).
CREATE OR REPLACE FUNCTION public.reopen_marks(p_exam_subject_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role   text;
  v_school uuid;
  v_ctx    record;
  v_sub    public.marks_submissions;
  v_pubstat text;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_staff();
  IF v_role NOT IN ('school_admin','principal') THEN
    RAISE EXCEPTION 'Access denied: only a principal or admin can reopen marks';
  END IF;
  IF length(COALESCE(trim(p_reason), '')) < 10 THEN
    RAISE EXCEPTION 'A reason (at least 10 characters) is required to reopen marks';
  END IF;

  SELECT * INTO v_ctx FROM public.marks_paper_ctx(p_exam_subject_id, v_school);

  -- terminal lock: published results locked => no reopen
  SELECT status INTO v_pubstat FROM public.result_publications WHERE exam_id = v_ctx.o_exam_id;
  IF v_pubstat = 'locked' THEN
    RAISE EXCEPTION 'Results are locked for this exam - reopen is not possible';
  END IF;

  SELECT * INTO v_sub FROM public.marks_submissions
  WHERE exam_subject_id = p_exam_subject_id FOR UPDATE;
  IF v_sub.id IS NULL THEN
    RAISE EXCEPTION 'No marks to reopen';
  END IF;
  IF v_sub.status NOT IN ('submitted','verified','approved','frozen') THEN
    RAISE EXCEPTION 'Nothing to reopen (status: %)', v_sub.status;
  END IF;

  UPDATE public.marks_submissions
  SET status = 'pending', submitted_at = NULL, verified_by = NULL, verified_at = NULL,
      approved_by = NULL, approved_at = NULL, frozen_at = NULL
  WHERE id = v_sub.id;

  INSERT INTO public.marks_audit_log
    (school_id, exam_subject_id, action, changed_by, reason)
  VALUES (v_school, p_exam_subject_id, 'reopen', auth.uid(), trim(p_reason));

  UPDATE public.exam_results SET is_final = false WHERE exam_id = v_ctx.o_exam_id;

  RETURN jsonb_build_object('status', 'pending');
END;
$$;

-- compute_exam_results: block recompute when results are locked.
-- (Wrap the Phase 7 body with a pre-check via CREATE OR REPLACE.)
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
  v_pubstat  text;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_admin();
  v_exam := public.lock_exam_row(p_exam_id, v_school);

  IF v_exam.status NOT IN ('completed', 'locked') THEN
    RAISE EXCEPTION 'Results can only be computed for a completed or locked exam (current: %)', v_exam.status;
  END IF;

  SELECT status INTO v_pubstat FROM public.result_publications WHERE exam_id = p_exam_id;
  IF v_pubstat = 'locked' THEN
    RAISE EXCEPTION 'Results are locked - recompute is not allowed';
  END IF;

  SELECT count(*) INTO v_unfrozen
  FROM public.exam_subjects es
  LEFT JOIN public.marks_submissions ms ON ms.exam_subject_id = es.id
  WHERE es.exam_id = p_exam_id AND NOT es.is_cancelled
    AND (ms.status IS NULL OR ms.status <> 'frozen');
  IF v_unfrozen > 0 THEN
    RAISE EXCEPTION 'Cannot compute: % paper(s) are not frozen yet', v_unfrozen;
  END IF;

  v_scale := public.resolve_grade_scale(v_school, v_exam.session_id);
  DELETE FROM public.exam_results WHERE exam_id = p_exam_id;

  WITH lines AS (
    SELECT ee.id AS enrollment_id, ee.student_id, ee.class_id, ee.status AS enroll_status,
           es.id AS paper_id, es.pass_marks, es.total_max_marks, es.weightage_percent,
           me.total_marks, me.is_absent, me.is_exempted,
           EXISTS (
             SELECT 1 FROM public.student_subject_overrides sso
             WHERE sso.session_id = v_exam.session_id AND sso.student_id = ee.student_id
               AND sso.subject_id = es.subject_id AND sso.kind = 'exempted'
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
           COUNT(*) FILTER (WHERE NOT COALESCE(is_absent,false) AND COALESCE(total_marks,0) < pass_marks)
             + COUNT(*) FILTER (WHERE COALESCE(is_absent,false)) AS failed_subjects
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


-- ============================================================
-- SECTION 4: PUBLIC (ANON) ACCESS + RATE LIMITING
-- ============================================================

-- INTERNAL: sliding-window rate limit keyed on a salted IP hash.
-- Mirrors the chat19 auth_rate_limit pattern. Raises 'rate_limited'.
CREATE OR REPLACE FUNCTION public.exam_rate_limit(p_prefix text, p_max integer, p_window interval)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_ip     text;
  v_bucket text;
  v_count  integer;
BEGIN
  BEGIN
    v_ip := split_part(
      (nullif(current_setting('request.headers', true), '')::json ->> 'x-forwarded-for'),
      ',', 1);
  EXCEPTION WHEN others THEN
    v_ip := NULL;
  END;
  v_ip := coalesce(nullif(trim(v_ip), ''), 'unknown');
  v_bucket := p_prefix || ':' || md5(v_ip);

  DELETE FROM public.auth_rate_limit WHERE created_at < now() - interval '1 hour';

  SELECT count(*) INTO v_count FROM public.auth_rate_limit
  WHERE bucket = v_bucket AND created_at > now() - p_window;
  IF v_count >= p_max THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  INSERT INTO public.auth_rate_limit (bucket) VALUES (v_bucket);
END;
$$;

REVOKE ALL ON FUNCTION public.exam_rate_limit(text, integer, interval) FROM PUBLIC;

-- list_public_result_exams - published exams for the school picker.
CREATE OR REPLACE FUNCTION public.list_public_result_exams(p_school_id uuid)
RETURNS TABLE (exam_id uuid, exam_name text, session_name text)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
BEGIN
  PERFORM public.exam_rate_limit('result_list', 30, interval '1 minute');
  RETURN QUERY
  SELECT e.id, e.name, ses.name
  FROM public.result_publications rp
  JOIN public.exams e ON e.id = rp.exam_id
  JOIN public.academic_sessions ses ON ses.id = e.session_id
  WHERE rp.school_id = p_school_id AND rp.status = 'published'
  ORDER BY e.start_date DESC NULLS LAST, e.name;
END;
$$;

REVOKE ALL ON FUNCTION public.list_public_result_exams(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_public_result_exams(uuid) TO anon, authenticated;

-- check_result_public - 4-factor match; returns result only if the
-- exam is published. Rate-limited on failed attempts.
CREATE OR REPLACE FUNCTION public.check_result_public(
  p_school_id   uuid,
  p_exam_id     uuid,
  p_roll_number integer,
  p_dob         date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pubstat text;
  v_rc      record;
BEGIN
  PERFORM public.exam_rate_limit('result_check', 12, interval '10 minutes');

  SELECT status INTO v_pubstat FROM public.result_publications
  WHERE exam_id = p_exam_id AND school_id = p_school_id;
  IF v_pubstat <> 'published' THEN
    RETURN jsonb_build_object('found', false, 'reason', 'not_published');
  END IF;

  SELECT rc.snapshot INTO v_rc
  FROM public.report_cards rc
  JOIN public.exam_enrollments ee
    ON ee.exam_id = rc.exam_id AND ee.student_id = rc.student_id
  JOIN public.students s ON s.id = rc.student_id
  WHERE rc.exam_id = p_exam_id
    AND rc.school_id = p_school_id
    AND ee.roll_number = p_roll_number
    AND s.date_of_birth = p_dob
  LIMIT 1;

  IF v_rc.snapshot IS NULL THEN
    RETURN jsonb_build_object('found', false, 'reason', 'no_match');
  END IF;

  -- return the immutable snapshot (already free of phone/address/dob)
  RETURN jsonb_build_object('found', true, 'report', v_rc.snapshot);
END;
$$;

REVOKE ALL ON FUNCTION public.check_result_public(uuid, uuid, integer, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_result_public(uuid, uuid, integer, date) TO anon, authenticated;

-- verify_report_card - QR authenticity check (verdict, minimal data).
CREATE OR REPLACE FUNCTION public.verify_report_card(p_qr_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_rc      record;
  v_pubstat text;
  v_current integer;
BEGIN
  PERFORM public.exam_rate_limit('rc_verify', 20, interval '1 minute');

  SELECT rc.exam_id, rc.version, rc.generated_at, rc.snapshot
  INTO v_rc
  FROM public.report_cards rc
  WHERE rc.qr_token = p_qr_token;

  IF v_rc.exam_id IS NULL THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'not_found');
  END IF;

  SELECT status INTO v_pubstat FROM public.result_publications WHERE exam_id = v_rc.exam_id;
  IF v_pubstat NOT IN ('published', 'locked') THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'not_published');
  END IF;

  -- newest version for this student/exam (superseded reprints flagged)
  SELECT max(version) INTO v_current FROM public.report_cards
  WHERE exam_id = v_rc.exam_id
    AND student_id = (SELECT student_id FROM public.report_cards WHERE qr_token = p_qr_token);

  RETURN jsonb_build_object(
    'valid', true,
    'version_status', CASE WHEN v_rc.version < v_current THEN 'superseded' ELSE 'current' END,
    'student_name', v_rc.snapshot->'student'->>'full_name',
    'class', v_rc.snapshot->'student'->>'class',
    'exam_name', v_rc.snapshot->'exam'->>'name',
    'percentage', v_rc.snapshot->'result'->>'percentage',
    'result', v_rc.snapshot->'result'->>'status',
    'generated_at', v_rc.generated_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.verify_report_card(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_report_card(uuid) TO anon, authenticated;

-- get_result_notification_targets - parent contacts for a published
-- exam. Pipeline-agnostic: whatever messaging layer (alerts / wa) sends
-- them. Admin/principal only.
CREATE OR REPLACE FUNCTION public.get_result_notification_targets(p_exam_id uuid)
RETURNS TABLE (student_id uuid, student_name text, parent_phone text, class_label text, percentage numeric, result_status text)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_role   text;
  v_school uuid;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_admin();
  IF NOT EXISTS (SELECT 1 FROM public.exams e WHERE e.id = p_exam_id AND e.school_id = v_school) THEN
    RAISE EXCEPTION 'Exam not found';
  END IF;

  RETURN QUERY
  SELECT s.id, s.full_name, s.parent_phone,
         (c.name || COALESCE('-' || c.section, ''))::text,
         er.percentage, er.result_status
  FROM public.exam_results er
  JOIN public.students s ON s.id = er.student_id
  JOIN public.exam_enrollments ee ON ee.id = er.enrollment_id
  JOIN public.classes c ON c.id = ee.class_id
  WHERE er.exam_id = p_exam_id AND er.result_status <> 'withheld'
    AND COALESCE(s.parent_phone_opted_out, false) = false
    AND s.parent_phone IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.get_result_notification_targets(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_result_notification_targets(uuid) TO authenticated;


-- ============================================================
-- SECTION 5: pg_cron - fire due scheduled publications (every 5 min)
-- ============================================================

CREATE OR REPLACE FUNCTION public.fn_publish_due_results()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.result_publications
  SET status = 'published', published_at = now(), scheduled_for = NULL
  WHERE status = 'scheduled' AND scheduled_for <= now();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_publish_due_results() FROM PUBLIC;

DO $do$
BEGIN
  BEGIN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'publish-due-results';
  EXCEPTION WHEN others THEN NULL;
  END;
  BEGIN
    PERFORM cron.schedule('publish-due-results', '*/5 * * * *',
      $j$ SELECT public.fn_publish_due_results() $j$);
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'pg_cron unavailable - schedule publish-due-results manually (every 5 min)';
  END;
END;
$do$;


-- ============================================================
-- SECTION 6: PostgREST schema reload
-- ============================================================

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- END OF MIGRATION exam_publishing
-- ============================================================
