-- Exam module Phase 7 (exam_results) smoke tests.
-- Requires: shim + chat02 + chat17 + exam core..marks + results.
-- Self-contained: rolls itself back.
\set ON_ERROR_STOP on
\set QUIET on
\pset format unaligned
\pset tuples_only on

BEGIN;

INSERT INTO schools (id, name, email, plan)
VALUES ('11111111-7777-1111-1111-111111111111', 'Results School', 'r@t.in', 'basic');

INSERT INTO auth.users (id) VALUES ('aaaaaaaa-7777-0000-0000-000000000001');
UPDATE profiles SET school_id='11111111-7777-1111-1111-111111111111', role='school_admin', full_name='Admin R'
WHERE id='aaaaaaaa-7777-0000-0000-000000000001';

INSERT INTO classes (id, school_id, name, section) VALUES
  ('22222222-7777-0000-0000-000000000001', '11111111-7777-1111-1111-111111111111', '12', 'A');
INSERT INTO subjects (id, school_id, name) VALUES
  ('33333333-7777-0000-0000-000000000001', '11111111-7777-1111-1111-111111111111', 'Maths'),
  ('33333333-7777-0000-0000-000000000002', '11111111-7777-1111-1111-111111111111', 'Physics');
INSERT INTO students (id, school_id, class_id, full_name)
SELECT ('44444444-7777-0000-0000-0000000000' || lpad(g::text,2,'0'))::uuid,
       '11111111-7777-1111-1111-111111111111', '22222222-7777-0000-0000-000000000001', 'Student ' || g
FROM generate_series(1,3) g;

SELECT set_config('request.jwt.claim.sub','aaaaaaaa-7777-0000-0000-000000000001', false);

-- ---------- R0: CBSE seed + band overlap prevention ----------
SELECT set_config('app.scale', seed_cbse_grade_scale('11111111-7777-1111-1111-111111111111')::text, false);
SELECT 'R0a cbse bands: ' || count(*)::text FROM grade_bands WHERE grade_scale_id = current_setting('app.scale')::uuid;
SELECT 'R0b grade for 95: ' || (SELECT grade_label FROM grade_for(current_setting('app.scale')::uuid, 95));
SELECT 'R0c grade for 30 is fail: ' || (SELECT is_fail::text FROM grade_for(current_setting('app.scale')::uuid, 30));
DO $$
BEGIN
  INSERT INTO grade_bands (school_id, grade_scale_id, min_percent, max_percent, grade_label)
  VALUES ('11111111-7777-1111-1111-111111111111', current_setting('app.scale')::uuid, 50, 60, 'X');
  RAISE EXCEPTION 'R0d FAILED: overlapping band accepted';
EXCEPTION WHEN others THEN
  IF SQLERRM LIKE '%ex_band_no_overlap%' OR SQLERRM LIKE '%exclusion%' THEN RAISE NOTICE 'R0d band overlap blocked: OK';
  ELSE RAISE; END IF;
END $$;

-- ---------- build a frozen exam (2 papers, 3 students) ----------
SELECT set_config('app.sid', create_academic_session('2026-27R','2026-04-01','2027-03-31')::text, false);
SELECT set_config('app.eid', create_exam(current_setting('app.sid')::uuid,
  (SELECT id FROM exam_types WHERE school_id='11111111-7777-1111-1111-111111111111' AND name='Annual'),
  'Annual', NULL, NULL)::text, false);
SELECT set_exam_classes(current_setting('app.eid')::uuid, ARRAY['22222222-7777-0000-0000-000000000001'::uuid]);
SELECT upsert_exam_subjects(current_setting('app.eid')::uuid, jsonb_build_array(
  jsonb_build_object('class_id','22222222-7777-0000-0000-000000000001','subject_id','33333333-7777-0000-0000-000000000001',
    'max_marks_theory',100,'max_marks_practical',0,'max_marks_internal',0,'pass_marks',33,
    'exam_date','2026-06-01','start_time','10:00','duration_minutes',180),
  jsonb_build_object('class_id','22222222-7777-0000-0000-000000000001','subject_id','33333333-7777-0000-0000-000000000002',
    'max_marks_theory',100,'max_marks_practical',0,'max_marks_internal',0,'pass_marks',33,
    'exam_date','2026-06-03','start_time','10:00','duration_minutes',180)));
SELECT publish_exam(current_setting('app.eid')::uuid);
SELECT start_exam(current_setting('app.eid')::uuid);

-- marks: S1 high, S2 mid, S3 fails physics
SELECT set_config('app.p1',(SELECT id::text FROM exam_subjects WHERE exam_id=current_setting('app.eid')::uuid AND subject_id='33333333-7777-0000-0000-000000000001'), false);
SELECT set_config('app.p2',(SELECT id::text FROM exam_subjects WHERE exam_id=current_setting('app.eid')::uuid AND subject_id='33333333-7777-0000-0000-000000000002'), false);
SELECT save_marks_bulk(current_setting('app.p1')::uuid, jsonb_build_array(
  jsonb_build_object('student_id','44444444-7777-0000-0000-000000000001','theory',95),
  jsonb_build_object('student_id','44444444-7777-0000-0000-000000000002','theory',60),
  jsonb_build_object('student_id','44444444-7777-0000-0000-000000000003','theory',70)));
SELECT save_marks_bulk(current_setting('app.p2')::uuid, jsonb_build_array(
  jsonb_build_object('student_id','44444444-7777-0000-0000-000000000001','theory',89),
  jsonb_build_object('student_id','44444444-7777-0000-0000-000000000002','theory',55),
  jsonb_build_object('student_id','44444444-7777-0000-0000-000000000003','theory',20)));
SELECT submit_marks(current_setting('app.p1')::uuid);
SELECT submit_marks(current_setting('app.p2')::uuid);
SELECT verify_marks(current_setting('app.p1')::uuid); SELECT verify_marks(current_setting('app.p2')::uuid);
SELECT approve_marks(current_setting('app.p1')::uuid); SELECT approve_marks(current_setting('app.p2')::uuid);
SELECT freeze_marks(current_setting('app.p1')::uuid); SELECT freeze_marks(current_setting('app.p2')::uuid);
SELECT complete_exam(current_setting('app.eid')::uuid);

-- ---------- R1: compute blocked if a paper isn't frozen ----------
-- (all frozen here, so compute should succeed)
SELECT 'R1 compute: ' || compute_exam_results(current_setting('app.eid')::uuid)::text;

-- ---------- R2: results correctness ----------
SELECT 'R2a S1 pct/grade/rank: ' || percentage || '/' || grade_label || '/' || rank_in_class
FROM exam_results WHERE exam_id=current_setting('app.eid')::uuid AND student_id='44444444-7777-0000-0000-000000000001';
SELECT 'R2b S3 status (fail physics): ' || result_status || ' failed=' || subjects_failed
FROM exam_results WHERE exam_id=current_setting('app.eid')::uuid AND student_id='44444444-7777-0000-0000-000000000003';
SELECT 'R2c ranks distinct: ' || string_agg(rank_in_class::text, ',' ORDER BY rank_in_class)
FROM exam_results WHERE exam_id=current_setting('app.eid')::uuid AND result_status='pass';

-- ---------- R3: class summary ----------
SELECT 'R3 summary avg/pass%: ' || average_pct || '/' || pass_pct || ' topper=' || topper_name
FROM get_class_result_summary(current_setting('app.eid')::uuid);

-- ---------- R4: report cards (immutable snapshot) ----------
SELECT 'R4a generate: ' || (generate_report_cards(current_setting('app.eid')::uuid)->>'generated');
SELECT 'R4b snapshot pct for S1: ' ||
  (snapshot->'result'->>'percentage')
FROM report_cards WHERE exam_id=current_setting('app.eid')::uuid AND student_id='44444444-7777-0000-0000-000000000001';
SELECT 'R4c version after regen: ' ||
  (SELECT version::text FROM (SELECT generate_report_cards(current_setting('app.eid')::uuid)) g,
   report_cards WHERE exam_id=current_setting('app.eid')::uuid AND student_id='44444444-7777-0000-0000-000000000001');

-- ---------- R5: remarks merge into snapshot ----------
SELECT set_report_card_remarks(
  (SELECT id FROM report_cards WHERE exam_id=current_setting('app.eid')::uuid AND student_id='44444444-7777-0000-0000-000000000001'),
  'Excellent work, keep it up');
SELECT 'R5 remarks in snapshot: ' ||
  (snapshot->>'remarks')
FROM report_cards WHERE exam_id=current_setting('app.eid')::uuid AND student_id='44444444-7777-0000-0000-000000000001';

-- ---------- R6: reopen invalidates results (Phase 6 hook now live) ----------
SELECT reopen_marks(current_setting('app.p1')::uuid, 'Re-mark Student 3 answer sheet');
SELECT 'R6 results now stale: ' || (bool_and(NOT is_final))::text
FROM exam_results WHERE exam_id=current_setting('app.eid')::uuid;

ROLLBACK;
SELECT 'EXAM RESULTS SMOKE TESTS COMPLETE (rolled back)';
