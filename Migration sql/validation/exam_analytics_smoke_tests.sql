-- Exam module Phase 9 (exam_analytics) smoke tests.
-- Requires: shim + baseline patch + chat02 + chat17 + exam core..publishing + analytics.
\set ON_ERROR_STOP on
\set QUIET on
\pset format unaligned
\pset tuples_only on

BEGIN;

INSERT INTO schools (id, name, email, plan)
VALUES ('11111111-9999-1111-1111-111111111111', 'Analytics School', 'an@t.in', 'basic');
INSERT INTO auth.users (id) VALUES ('aaaaaaaa-9999-0000-0000-000000000001');
UPDATE profiles SET school_id='11111111-9999-1111-1111-111111111111', role='school_admin', full_name='Admin An'
WHERE id='aaaaaaaa-9999-0000-0000-000000000001';

INSERT INTO classes (id, school_id, name, section) VALUES
  ('22222222-9999-0000-0000-000000000001','11111111-9999-1111-1111-111111111111','10','A');
INSERT INTO subjects (id, school_id, name) VALUES
  ('33333333-9999-0000-0000-000000000001','11111111-9999-1111-1111-111111111111','Maths'),
  ('33333333-9999-0000-0000-000000000002','11111111-9999-1111-1111-111111111111','English');
INSERT INTO students (id, school_id, class_id, full_name)
SELECT ('44444444-9999-0000-0000-0000000000' || lpad(g::text,2,'0'))::uuid,
       '11111111-9999-1111-1111-111111111111','22222222-9999-0000-0000-000000000001','Student ' || g
FROM generate_series(1,4) g;
-- assigned teacher for teacher-performance
INSERT INTO staff (id, school_id, profile_id, employee_id, full_name, mobile, email, designation, is_teaching)
VALUES ('55555555-9999-0000-0000-000000000001','11111111-9999-1111-1111-111111111111','aaaaaaaa-9999-0000-0000-000000000001','E1','T One','9','t@t.in','TGT',true);
INSERT INTO subject_assignments (school_id, staff_id, subject_id, class_id) VALUES
  ('11111111-9999-1111-1111-111111111111','55555555-9999-0000-0000-000000000001','33333333-9999-0000-0000-000000000001','22222222-9999-0000-0000-000000000001'),
  ('11111111-9999-1111-1111-111111111111','55555555-9999-0000-0000-000000000001','33333333-9999-0000-0000-000000000002','22222222-9999-0000-0000-000000000001');

SELECT set_config('request.jwt.claim.sub','aaaaaaaa-9999-0000-0000-000000000001', false);
SELECT set_config('app.sid', create_academic_session('2026-27An','2026-04-01','2027-03-31')::text, false);
SELECT set_config('app.eid', create_exam(current_setting('app.sid')::uuid,
  (SELECT id FROM exam_types WHERE school_id='11111111-9999-1111-1111-111111111111' AND name='Annual'),
  'Annual', NULL, NULL)::text, false);
SELECT set_exam_classes(current_setting('app.eid')::uuid, ARRAY['22222222-9999-0000-0000-000000000001'::uuid]);
SELECT upsert_exam_subjects(current_setting('app.eid')::uuid, jsonb_build_array(
  jsonb_build_object('class_id','22222222-9999-0000-0000-000000000001','subject_id','33333333-9999-0000-0000-000000000001','max_marks_theory',100,'pass_marks',33,'exam_date','2026-06-01','start_time','10:00','duration_minutes',180),
  jsonb_build_object('class_id','22222222-9999-0000-0000-000000000001','subject_id','33333333-9999-0000-0000-000000000002','max_marks_theory',100,'pass_marks',33,'exam_date','2026-06-03','start_time','10:00','duration_minutes',180)));
SELECT publish_exam(current_setting('app.eid')::uuid);
SELECT start_exam(current_setting('app.eid')::uuid);
SELECT set_config('app.p1',(SELECT id::text FROM exam_subjects WHERE exam_id=current_setting('app.eid')::uuid AND subject_id='33333333-9999-0000-0000-000000000001'), false);
SELECT set_config('app.p2',(SELECT id::text FROM exam_subjects WHERE exam_id=current_setting('app.eid')::uuid AND subject_id='33333333-9999-0000-0000-000000000002'), false);
-- S1 95, S2 82, S3 55, S4 fails maths(20)
SELECT save_marks_bulk(current_setting('app.p1')::uuid, jsonb_build_array(
  jsonb_build_object('student_id','44444444-9999-0000-0000-000000000001','theory',95),
  jsonb_build_object('student_id','44444444-9999-0000-0000-000000000002','theory',82),
  jsonb_build_object('student_id','44444444-9999-0000-0000-000000000003','theory',55),
  jsonb_build_object('student_id','44444444-9999-0000-0000-000000000004','theory',20)));
SELECT save_marks_bulk(current_setting('app.p2')::uuid, jsonb_build_array(
  jsonb_build_object('student_id','44444444-9999-0000-0000-000000000001','theory',90),
  jsonb_build_object('student_id','44444444-9999-0000-0000-000000000002','theory',78),
  jsonb_build_object('student_id','44444444-9999-0000-0000-000000000003','theory',60),
  jsonb_build_object('student_id','44444444-9999-0000-0000-000000000004','theory',50)));
SELECT submit_marks(current_setting('app.p1')::uuid); SELECT submit_marks(current_setting('app.p2')::uuid);
SELECT verify_marks(current_setting('app.p1')::uuid); SELECT verify_marks(current_setting('app.p2')::uuid);
SELECT approve_marks(current_setting('app.p1')::uuid); SELECT approve_marks(current_setting('app.p2')::uuid);
SELECT freeze_marks(current_setting('app.p1')::uuid); SELECT freeze_marks(current_setting('app.p2')::uuid);
SELECT complete_exam(current_setting('app.eid')::uuid);
SELECT compute_exam_results(current_setting('app.eid')::uuid);

-- ---------- AN1: grade distribution ----------
SELECT 'AN1 grade dist: ' || string_agg(grade_label || '=' || student_count, ',' ORDER BY sort_min DESC)
FROM get_grade_distribution(current_setting('app.eid')::uuid);

-- ---------- AN2: topper list ----------
SELECT 'AN2 topper: ' || student_name || ' ' || percentage || '%'
FROM get_topper_list(current_setting('app.eid')::uuid, NULL, 1);

-- ---------- AN3: subject performance ----------
SELECT 'AN3 subj perf: ' || string_agg(subject_name || ' avg=' || average_pct || ' pass=' || pass_pct, '; ' ORDER BY subject_name)
FROM get_subject_performance(current_setting('app.eid')::uuid);

-- ---------- AN4: fail list (S4 fails maths) ----------
SELECT 'AN4 fail list: ' || count(*)::text || ' (' || string_agg(student_name, ',') || ')'
FROM get_fail_list(current_setting('app.eid')::uuid);

-- ---------- AN5: teacher performance ----------
SELECT 'AN5 teacher perf rows: ' || count(*)::text || ' first avg=' || min(average_pct)::text
FROM get_teacher_performance(current_setting('app.sid')::uuid);

-- ---------- AN6: school performance (per exam) ----------
SELECT 'AN6 school perf: ' || exam_name || ' avg=' || average_pct || ' pass=' || pass_pct
FROM get_school_performance(current_setting('app.sid')::uuid);

-- ---------- AN7: student progress ----------
SELECT 'AN7 student progress rows: ' || count(*)::text
FROM get_student_progress('44444444-9999-0000-0000-000000000001', current_setting('app.sid')::uuid);

ROLLBACK;
SELECT 'EXAM ANALYTICS SMOKE TESTS COMPLETE (rolled back)';
