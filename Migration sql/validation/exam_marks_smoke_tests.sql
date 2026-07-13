-- Exam module Phase 6 (exam_marks) smoke tests.
-- Requires: shim + chat02 + chat17 + exam core..attendance + marks.
-- Self-contained: rolls itself back.
\set ON_ERROR_STOP on
\set QUIET on
\pset format unaligned
\pset tuples_only on

BEGIN;

INSERT INTO schools (id, name, email, plan)
VALUES ('11111111-6666-1111-1111-111111111111', 'Marks School', 'm@t.in', 'basic');

INSERT INTO auth.users (id) VALUES
  ('aaaaaaaa-6666-0000-0000-000000000001'),   -- admin/principal actions
  ('aaaaaaaa-6666-0000-0000-000000000002'),   -- subject teacher
  ('aaaaaaaa-6666-0000-0000-000000000003'),   -- class teacher
  ('aaaaaaaa-6666-0000-0000-000000000004');   -- principal
UPDATE profiles SET school_id='11111111-6666-1111-1111-111111111111', role='school_admin', full_name='Admin M' WHERE id='aaaaaaaa-6666-0000-0000-000000000001';
UPDATE profiles SET school_id='11111111-6666-1111-1111-111111111111', role='teacher', full_name='Subject T' WHERE id='aaaaaaaa-6666-0000-0000-000000000002';
UPDATE profiles SET school_id='11111111-6666-1111-1111-111111111111', role='teacher', full_name='Class T' WHERE id='aaaaaaaa-6666-0000-0000-000000000003';
UPDATE profiles SET school_id='11111111-6666-1111-1111-111111111111', role='principal', full_name='Principal' WHERE id='aaaaaaaa-6666-0000-0000-000000000004';

INSERT INTO classes (id, school_id, name, section) VALUES
  ('22222222-6666-0000-0000-000000000001', '11111111-6666-1111-1111-111111111111', '10', 'A');
INSERT INTO subjects (id, school_id, name) VALUES
  ('33333333-6666-0000-0000-000000000001', '11111111-6666-1111-1111-111111111111', 'Maths');
INSERT INTO students (id, school_id, class_id, full_name)
SELECT ('44444444-6666-0000-0000-0000000000' || lpad(g::text,2,'0'))::uuid,
       '11111111-6666-1111-1111-111111111111', '22222222-6666-0000-0000-000000000001', 'Student ' || g
FROM generate_series(1,3) g;

INSERT INTO staff (id, school_id, profile_id, employee_id, full_name, mobile, email, designation, is_teaching) VALUES
  ('55555555-6666-0000-0000-000000000002','11111111-6666-1111-1111-111111111111','aaaaaaaa-6666-0000-0000-000000000002','E1','Subject T','9','s@t.in','TGT',true),
  ('55555555-6666-0000-0000-000000000003','11111111-6666-1111-1111-111111111111','aaaaaaaa-6666-0000-0000-000000000003','E2','Class T','8','c@t.in','TGT',true);
INSERT INTO subject_assignments (school_id, staff_id, subject_id, class_id) VALUES
  ('11111111-6666-1111-1111-111111111111','55555555-6666-0000-0000-000000000002','33333333-6666-0000-0000-000000000001','22222222-6666-0000-0000-000000000001');
INSERT INTO class_teachers (school_id, class_id, staff_id) VALUES
  ('11111111-6666-1111-1111-111111111111','22222222-6666-0000-0000-000000000001','55555555-6666-0000-0000-000000000003');

SELECT set_config('request.jwt.claim.sub','aaaaaaaa-6666-0000-0000-000000000001', false);
SELECT set_config('app.sid', create_academic_session('2026-27M','2026-04-01','2027-03-31')::text, false);
SELECT set_config('app.eid', create_exam(current_setting('app.sid')::uuid,
  (SELECT id FROM exam_types WHERE school_id='11111111-6666-1111-1111-111111111111' AND name='Half Yearly'),
  'HY', NULL, NULL)::text, false);
SELECT set_exam_classes(current_setting('app.eid')::uuid, ARRAY['22222222-6666-0000-0000-000000000001'::uuid]);
SELECT upsert_exam_subjects(current_setting('app.eid')::uuid, jsonb_build_array(
  jsonb_build_object('class_id','22222222-6666-0000-0000-000000000001','subject_id','33333333-6666-0000-0000-000000000001',
    'max_marks_theory',80,'max_marks_practical',0,'max_marks_internal',20,'pass_marks',33,
    'exam_date','2026-06-01','start_time','10:00','duration_minutes',180)));
SELECT set_config('app.esid',(SELECT id::text FROM exam_subjects WHERE exam_id=current_setting('app.eid')::uuid), false);
SELECT publish_exam(current_setting('app.eid')::uuid);
SELECT start_exam(current_setting('app.eid')::uuid);

-- ---------- M1: teacher saves marks (autosave, partial reject) ----------
SELECT set_config('request.jwt.claim.sub','aaaaaaaa-6666-0000-0000-000000000002', false);
SELECT set_config('app.m1', save_marks_bulk(current_setting('app.esid')::uuid, jsonb_build_array(
  jsonb_build_object('student_id','44444444-6666-0000-000000000001'::text,'theory',70,'internal',18),
  jsonb_build_object('student_id','44444444-6666-0000-0000-000000000002','theory',999,'internal',10),
  jsonb_build_object('student_id','44444444-6666-0000-0000-000000000003','is_absent',true)
))::text, false);
-- note: first row has a deliberately malformed uuid to test rejection path is resilient
SELECT 'M1a saved: ' || (current_setting('app.m1')::jsonb->>'saved')
  || ' rejected: ' || jsonb_array_length((current_setting('app.m1')::jsonb)->'rejected');

-- fix: proper save for all three
SELECT save_marks_bulk(current_setting('app.esid')::uuid, jsonb_build_array(
  jsonb_build_object('student_id','44444444-6666-0000-0000-000000000001','theory',70,'internal',18),
  jsonb_build_object('student_id','44444444-6666-0000-0000-000000000002','theory',40,'internal',10),
  jsonb_build_object('student_id','44444444-6666-0000-0000-000000000003','is_absent',true)));
SELECT 'M1b total computed: ' || total_marks::text FROM marks_entries
WHERE exam_subject_id=current_setting('app.esid')::uuid AND student_id='44444444-6666-0000-0000-000000000001';

-- ---------- M2: over-max rejected by trigger ----------
SELECT set_config('app.m2', save_marks_bulk(current_setting('app.esid')::uuid, jsonb_build_array(
  jsonb_build_object('student_id','44444444-6666-0000-0000-000000000001','theory',85,'internal',18)
))::text, false);
SELECT 'M2 over-max rejected: ' ||
  (((current_setting('app.m2')::jsonb)->'rejected'->0->>'reason') LIKE '%exceeds max%')::text;

-- ---------- M3: submit (completeness + attendance cross-check) ----------
SELECT 'M3a submit: ' || (submit_marks(current_setting('app.esid')::uuid)->>'status');
-- now locked: teacher edit blocked
DO $$
BEGIN
  PERFORM save_marks_bulk(current_setting('app.esid')::uuid, jsonb_build_array(
    jsonb_build_object('student_id','44444444-6666-0000-0000-000000000001','theory',60,'internal',18)));
  RAISE EXCEPTION 'M3b FAILED: edited after submit';
EXCEPTION WHEN others THEN
  IF SQLERRM LIKE '%locked%' THEN RAISE NOTICE 'M3b edit-after-submit blocked: OK';
  ELSE RAISE; END IF;
END $$;

-- ---------- M4: verify (class teacher) then approve+freeze (principal) ----------
SELECT set_config('request.jwt.claim.sub','aaaaaaaa-6666-0000-0000-000000000003', false);
SELECT 'M4a verify (CT): ' || (verify_marks(current_setting('app.esid')::uuid)->>'status');
-- subject teacher cannot approve
SELECT set_config('request.jwt.claim.sub','aaaaaaaa-6666-0000-0000-000000000002', false);
DO $$
BEGIN
  PERFORM approve_marks(current_setting('app.esid')::uuid);
  RAISE EXCEPTION 'M4b FAILED: teacher approved';
EXCEPTION WHEN others THEN
  IF SQLERRM LIKE '%Access denied%' THEN RAISE NOTICE 'M4b teacher approve blocked: OK';
  ELSE RAISE; END IF;
END $$;
SELECT set_config('request.jwt.claim.sub','aaaaaaaa-6666-0000-0000-000000000004', false);
SELECT 'M4c approve (PR): ' || (approve_marks(current_setting('app.esid')::uuid)->>'status');
SELECT 'M4d freeze (PR): ' || (freeze_marks(current_setting('app.esid')::uuid)->>'status');

-- ---------- M5: frozen edit blocked even by admin direct write ----------
SELECT set_config('request.jwt.claim.sub','aaaaaaaa-6666-0000-0000-000000000001', false);
DO $$
BEGIN
  UPDATE marks_entries SET theory_marks = 10
  WHERE exam_subject_id=current_setting('app.esid')::uuid
    AND student_id='44444444-6666-0000-0000-000000000001';
  RAISE EXCEPTION 'M5 FAILED: frozen marks edited directly';
EXCEPTION WHEN others THEN
  IF SQLERRM LIKE '%locked%' THEN RAISE NOTICE 'M5 frozen direct-edit blocked: OK';
  ELSE RAISE; END IF;
END $$;

-- ---------- M6: reopen (PR) unlocks; teacher edits again ----------
SELECT 'M6a reopen: ' || (reopen_marks(current_setting('app.esid')::uuid, 'Correction needed for Student 1')->>'status');
SELECT set_config('request.jwt.claim.sub','aaaaaaaa-6666-0000-0000-000000000002', false);
SELECT save_marks_bulk(current_setting('app.esid')::uuid, jsonb_build_array(
  jsonb_build_object('student_id','44444444-6666-0000-0000-000000000001','theory',75,'internal',18)));
SELECT 'M6b re-edit total: ' || total_marks::text FROM marks_entries
WHERE exam_subject_id=current_setting('app.esid')::uuid AND student_id='44444444-6666-0000-0000-000000000001';

-- ---------- M7: reject flow ----------
SELECT submit_marks(current_setting('app.esid')::uuid);
SELECT set_config('request.jwt.claim.sub','aaaaaaaa-6666-0000-0000-000000000004', false);
SELECT 'M7a reject: ' || (reject_marks(current_setting('app.esid')::uuid, 'Recheck Student 2 theory')->>'status');
SELECT set_config('request.jwt.claim.sub','aaaaaaaa-6666-0000-0000-000000000002', false);
SELECT save_marks_bulk(current_setting('app.esid')::uuid, jsonb_build_array(
  jsonb_build_object('student_id','44444444-6666-0000-0000-000000000002','theory',45,'internal',12)));
SELECT 'M7b re-submit after reject: ' || (submit_marks(current_setting('app.esid')::uuid)->>'status');

-- ---------- M8: board + grid + audit ----------
SELECT set_config('request.jwt.claim.sub','aaaaaaaa-6666-0000-0000-000000000001', false);
SELECT 'M8a board: ' || status || ' ' || entered || '/' || enrolled
FROM get_marks_board(current_setting('app.eid')::uuid);
SELECT 'M8b grid rows: ' || jsonb_array_length((get_marks_grid(current_setting('app.esid')::uuid))->'rows');
SELECT 'M8c audit actions: ' || string_agg(DISTINCT action, ',' ORDER BY action)
FROM marks_audit_log WHERE school_id='11111111-6666-1111-1111-111111111111';

ROLLBACK;
SELECT 'EXAM MARKS SMOKE TESTS COMPLETE (rolled back)';
