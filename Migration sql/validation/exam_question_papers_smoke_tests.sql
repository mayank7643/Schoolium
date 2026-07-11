-- Exam module Phase 4 (exam_question_papers) smoke tests.
-- Requires: shim + chat02 + chat17 + exam core/logistics/admit cards + QP.
-- Self-contained: rolls itself back.
\set ON_ERROR_STOP on
\set QUIET on
\pset format unaligned
\pset tuples_only on

BEGIN;

-- ---------- fixtures: exam + assigned teacher + outsider teacher ----------
INSERT INTO schools (id, name, email, plan)
VALUES ('11111111-4444-1111-1111-111111111111', 'QP School', 'q@t.in', 'basic');

INSERT INTO auth.users (id) VALUES
  ('aaaaaaaa-4444-0000-0000-000000000001'),   -- admin
  ('aaaaaaaa-4444-0000-0000-000000000002'),   -- maths teacher (assigned)
  ('aaaaaaaa-4444-0000-0000-000000000003');   -- other teacher (not assigned)
UPDATE profiles SET school_id = '11111111-4444-1111-1111-111111111111',
                    role = 'school_admin', full_name = 'Admin Q'
WHERE id = 'aaaaaaaa-4444-0000-0000-000000000001';
UPDATE profiles SET school_id = '11111111-4444-1111-1111-111111111111',
                    role = 'teacher', full_name = 'Maths Teacher'
WHERE id = 'aaaaaaaa-4444-0000-0000-000000000002';
UPDATE profiles SET school_id = '11111111-4444-1111-1111-111111111111',
                    role = 'teacher', full_name = 'Other Teacher'
WHERE id = 'aaaaaaaa-4444-0000-0000-000000000003';

INSERT INTO classes (id, school_id, name, section) VALUES
  ('22222222-4444-0000-0000-000000000001', '11111111-4444-1111-1111-111111111111', '8', 'A');
INSERT INTO subjects (id, school_id, name) VALUES
  ('33333333-4444-0000-0000-000000000001', '11111111-4444-1111-1111-111111111111', 'Maths'),
  ('33333333-4444-0000-0000-000000000002', '11111111-4444-1111-1111-111111111111', 'Science');
INSERT INTO students (id, school_id, class_id, full_name) VALUES
  ('44444444-4444-0000-0000-000000000001', '11111111-4444-1111-1111-111111111111',
   '22222222-4444-0000-0000-000000000001', 'Student One');

-- staff + assignment: maths teacher teaches Maths in 8-A
INSERT INTO staff (id, school_id, profile_id, employee_id, full_name, mobile, email, designation, is_teaching)
VALUES ('55555555-4444-0000-0000-000000000002', '11111111-4444-1111-1111-111111111111',
        'aaaaaaaa-4444-0000-0000-000000000002', 'EMP-0001', 'Maths Teacher', '9999999999', 'mt@t.in', 'TGT', true),
       ('55555555-4444-0000-0000-000000000003', '11111111-4444-1111-1111-111111111111',
        'aaaaaaaa-4444-0000-0000-000000000003', 'EMP-0002', 'Other Teacher', '9999999998', 'ot@t.in', 'TGT', true);
INSERT INTO subject_assignments (school_id, staff_id, subject_id, class_id)
VALUES ('11111111-4444-1111-1111-111111111111', '55555555-4444-0000-0000-000000000002',
        '33333333-4444-0000-0000-000000000001', '22222222-4444-0000-0000-000000000001');

SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-4444-0000-0000-000000000001', false);
SELECT set_config('app.sid', create_academic_session('2026-27Q', '2026-04-01', '2027-03-31')::text, false);
SELECT set_config('app.eid', create_exam(
  current_setting('app.sid')::uuid,
  (SELECT id FROM exam_types WHERE school_id = '11111111-4444-1111-1111-111111111111' AND name = 'Unit Test'),
  'UT-1Q', NULL, NULL)::text, false);
SELECT set_exam_classes(current_setting('app.eid')::uuid,
  ARRAY['22222222-4444-0000-0000-000000000001'::uuid]);
SELECT upsert_exam_subjects(current_setting('app.eid')::uuid, jsonb_build_array(
  jsonb_build_object('class_id','22222222-4444-0000-0000-000000000001',
    'subject_id','33333333-4444-0000-0000-000000000001','pass_marks',33,
    'exam_date','2026-09-25','start_time','10:00','duration_minutes',120)));
SELECT set_config('app.esid',
  (SELECT id::text FROM exam_subjects WHERE exam_id = current_setting('app.eid')::uuid), false);

-- ---------- Q1: assigned teacher registers v1 + v2 ----------
SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-4444-0000-0000-000000000002', false);
SELECT 'Q1a v1: ' || ((register_question_paper_upload(current_setting('app.esid')::uuid, 12345, 'first draft'))->>'version_no');
SELECT 'Q1b v2: ' || ((register_question_paper_upload(current_setting('app.esid')::uuid, 23456, 'typo fixed'))->>'version_no');
SELECT 'Q1c current is v2: ' || v.version_no::text
FROM question_papers qp JOIN question_paper_versions v ON v.id = qp.current_version_id
WHERE qp.exam_subject_id = current_setting('app.esid')::uuid;
SELECT 'Q1d path convention: ' ||
  (SELECT (v.file_path LIKE '11111111-4444-1111-1111-111111111111/%/v2.pdf')::text
   FROM question_papers qp JOIN question_paper_versions v ON v.id = qp.current_version_id
   WHERE qp.exam_subject_id = current_setting('app.esid')::uuid);

-- ---------- Q2: outsider teacher blocked (upload + download) ----------
SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-4444-0000-0000-000000000003', false);
DO $$
BEGIN
  PERFORM register_question_paper_upload(current_setting('app.esid')::uuid);
  RAISE EXCEPTION 'Q2a FAILED: unassigned teacher uploaded';
EXCEPTION WHEN others THEN
  IF SQLERRM LIKE '%not assigned%' THEN RAISE NOTICE 'Q2a unassigned upload blocked: OK';
  ELSE RAISE; END IF;
END $$;
DO $$
BEGIN
  PERFORM authorize_question_paper_access(
    (SELECT id FROM question_papers WHERE exam_subject_id = current_setting('app.esid')::uuid));
  RAISE EXCEPTION 'Q2b FAILED: unassigned teacher downloaded';
EXCEPTION WHEN others THEN
  IF SQLERRM LIKE '%not assigned%' THEN RAISE NOTICE 'Q2b unassigned download blocked: OK';
  ELSE RAISE; END IF;
END $$;
-- and RLS hides the rows entirely
SET LOCAL ROLE authenticated;
SELECT 'Q2c outsider sees papers: ' || count(*)::text FROM question_papers;
RESET ROLE;

-- ---------- Q3: download gate logs BEFORE returning the path ----------
SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-4444-0000-0000-000000000002', false);
SELECT 'Q3a path returned: ' ||
  (authorize_question_paper_access(
    (SELECT id FROM question_papers WHERE exam_subject_id = current_setting('app.esid')::uuid))
   LIKE '%.pdf')::text;
SELECT 'Q3b log trail: ' || string_agg(action, ',' ORDER BY created_at)
FROM question_paper_access_logs
WHERE school_id = '11111111-4444-1111-1111-111111111111';

-- teacher cannot read the access logs (RLS)
SET LOCAL ROLE authenticated;
SELECT 'Q3c teacher sees logs: ' || count(*)::text FROM question_paper_access_logs;
RESET ROLE;

-- ---------- Q4: final lock blocks uploads; admin unlock reopens ----------
SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-4444-0000-0000-000000000001', false);
SELECT lock_question_paper(
  (SELECT id FROM question_papers WHERE exam_subject_id = current_setting('app.esid')::uuid));
SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-4444-0000-0000-000000000002', false);
DO $$
BEGIN
  PERFORM register_question_paper_upload(current_setting('app.esid')::uuid);
  RAISE EXCEPTION 'Q4a FAILED: uploaded to a final paper';
EXCEPTION WHEN others THEN
  IF SQLERRM LIKE '%locked (final)%' THEN RAISE NOTICE 'Q4a final blocks upload: OK';
  ELSE RAISE; END IF;
END $$;
SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-4444-0000-0000-000000000001', false);
SELECT unlock_question_paper(
  (SELECT id FROM question_papers WHERE exam_subject_id = current_setting('app.esid')::uuid),
  'Board changed the syllabus');
SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-4444-0000-0000-000000000002', false);
SELECT 'Q4b upload after unlock: v' ||
  ((register_question_paper_upload(current_setting('app.esid')::uuid))->>'version_no');

-- ---------- Q5: full action trail ----------
SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-4444-0000-0000-000000000001', false);
SELECT 'Q5 actions: ' || string_agg(action, ',' ORDER BY created_at)
FROM question_paper_access_logs
WHERE school_id = '11111111-4444-1111-1111-111111111111';

ROLLBACK;
SELECT 'QUESTION PAPER SMOKE TESTS COMPLETE (rolled back)';
