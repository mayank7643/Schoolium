-- Exam module Phase 5 (exam_attendance) smoke tests.
-- Requires: shim + chat02 + chat17 + exam core..question papers + attendance.
-- Self-contained: rolls itself back.
\set ON_ERROR_STOP on
\set QUIET on
\pset format unaligned
\pset tuples_only on

BEGIN;

INSERT INTO schools (id, name, email, plan)
VALUES ('11111111-5555-1111-1111-111111111111', 'Att School', 'a@t.in', 'basic');

INSERT INTO auth.users (id) VALUES
  ('aaaaaaaa-5555-0000-0000-000000000001'),   -- admin
  ('aaaaaaaa-5555-0000-0000-000000000002');   -- invigilator (assigned teacher)
UPDATE profiles SET school_id = '11111111-5555-1111-1111-111111111111',
                    role = 'school_admin', full_name = 'Admin A'
WHERE id = 'aaaaaaaa-5555-0000-0000-000000000001';
UPDATE profiles SET school_id = '11111111-5555-1111-1111-111111111111',
                    role = 'teacher', full_name = 'Invigilator'
WHERE id = 'aaaaaaaa-5555-0000-0000-000000000002';

INSERT INTO classes (id, school_id, name, section) VALUES
  ('22222222-5555-0000-0000-000000000001', '11111111-5555-1111-1111-111111111111', '9', 'A');
INSERT INTO subjects (id, school_id, name) VALUES
  ('33333333-5555-0000-0000-000000000001', '11111111-5555-1111-1111-111111111111', 'Maths');
INSERT INTO students (id, school_id, class_id, full_name)
SELECT ('44444444-5555-0000-0000-0000000000' || lpad(g::text, 2, '0'))::uuid,
       '11111111-5555-1111-1111-111111111111',
       '22222222-5555-0000-0000-000000000001', 'Student ' || g
FROM generate_series(1, 4) g;

INSERT INTO staff (id, school_id, profile_id, employee_id, full_name, mobile, email, designation, is_teaching)
VALUES ('55555555-5555-0000-0000-000000000002', '11111111-5555-1111-1111-111111111111',
        'aaaaaaaa-5555-0000-0000-000000000002', 'EMP-0001', 'Invigilator', '9999999999', 'i@t.in', 'TGT', true);
INSERT INTO subject_assignments (school_id, staff_id, subject_id, class_id)
VALUES ('11111111-5555-1111-1111-111111111111', '55555555-5555-0000-0000-000000000002',
        '33333333-5555-0000-0000-000000000001', '22222222-5555-0000-0000-000000000001');

SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-5555-0000-0000-000000000001', false);
SELECT set_config('app.sid', create_academic_session('2026-27A', '2026-04-01', '2027-03-31')::text, false);
SELECT set_config('app.eid', create_exam(
  current_setting('app.sid')::uuid,
  (SELECT id FROM exam_types WHERE school_id = '11111111-5555-1111-1111-111111111111' AND name = 'Unit Test'),
  'UT-1A', NULL, NULL)::text, false);
SELECT set_exam_classes(current_setting('app.eid')::uuid,
  ARRAY['22222222-5555-0000-0000-000000000001'::uuid]);
-- schedule the paper in the past so scans are marked 'late'
SELECT upsert_exam_subjects(current_setting('app.eid')::uuid, jsonb_build_array(
  jsonb_build_object('class_id','22222222-5555-0000-0000-000000000001',
    'subject_id','33333333-5555-0000-0000-000000000001','pass_marks',33,
    'exam_date','2026-06-01','start_time','10:00','duration_minutes',120)));
SELECT set_config('app.esid',
  (SELECT id::text FROM exam_subjects WHERE exam_id = current_setting('app.eid')::uuid), false);
SELECT publish_exam(current_setting('app.eid')::uuid);
SELECT generate_admit_cards(current_setting('app.eid')::uuid);
SELECT start_exam(current_setting('app.eid')::uuid);

-- ---------- A1: QR scan marks late (paper date in the past) ----------
SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-5555-0000-0000-000000000002', false);
SELECT set_config('app.tok1',
  (SELECT ac.qr_token::text FROM admit_cards ac
   JOIN exam_enrollments ee ON ee.id = ac.enrollment_id
   WHERE ee.student_id = '44444444-5555-0000-0000-000000000001'), false);
SELECT 'A1a scan ok+late: ' ||
  ((record_exam_attendance_scan(current_setting('app.tok1')::uuid, current_setting('app.esid')::uuid))->>'ok')
  || '/' ||
  ((record_exam_attendance_scan(current_setting('app.tok1')::uuid, current_setting('app.esid')::uuid))->>'status_set');
SELECT 'A1b payload has name: ' ||
  ((record_exam_attendance_scan(current_setting('app.tok1')::uuid, current_setting('app.esid')::uuid))->>'student_name');

-- ---------- A2: unknown / wrong-exam token ----------
SELECT 'A2a unknown token: ' ||
  ((record_exam_attendance_scan('00000000-0000-0000-0000-0000000000aa', current_setting('app.esid')::uuid))->>'reason');

-- ---------- A3: manual bulk (present, absent, medical) ----------
SELECT set_config('app.a3', mark_exam_attendance_bulk(current_setting('app.esid')::uuid, jsonb_build_array(
    jsonb_build_object('student_id','44444444-5555-0000-0000-000000000002','status','present'),
    jsonb_build_object('student_id','44444444-5555-0000-0000-000000000003','status','absent'),
    jsonb_build_object('student_id','44444444-5555-0000-0000-000000000004','status','medical','remarks','fever')
  ))::text, false);
SELECT 'A3a bulk saved: ' || (current_setting('app.a3')::jsonb->>'saved');

-- ---------- A4: manual absent is NOT downgraded by a later stray QR ----------
SELECT set_config('app.tok3',
  (SELECT ac.qr_token::text FROM admit_cards ac
   JOIN exam_enrollments ee ON ee.id = ac.enrollment_id
   WHERE ee.student_id = '44444444-5555-0000-0000-000000000003'), false);
SELECT record_exam_attendance_scan(current_setting('app.tok3')::uuid, current_setting('app.esid')::uuid);
SELECT 'A4 manual absent preserved: ' || status
FROM exam_attendance
WHERE exam_subject_id = current_setting('app.esid')::uuid
  AND student_id = '44444444-5555-0000-0000-000000000003';

-- ---------- A5: report ----------
SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-5555-0000-0000-000000000001', false);
SELECT 'A5 report (enr/present/late/absent/medical/unmarked): '
  || enrolled || '/' || present || '/' || late || '/' || absent || '/' || medical || '/' || unmarked
FROM get_exam_attendance_report(current_setting('app.eid')::uuid);

-- ---------- A6: integrity - cannot mark a non-enrolled student ----------
INSERT INTO students (id, school_id, class_id, full_name) VALUES
  ('44444444-5555-0000-0000-0000000000ff', '11111111-5555-1111-1111-111111111111',
   '22222222-5555-0000-0000-000000000001', 'Not Enrolled');
DO $$
BEGIN
  PERFORM mark_exam_attendance_bulk(current_setting('app.esid')::uuid, jsonb_build_array(
    jsonb_build_object('student_id','44444444-5555-0000-0000-0000000000ff','status','present')));
  RAISE EXCEPTION 'A6 FAILED: marked a non-enrolled student';
EXCEPTION WHEN others THEN
  IF SQLERRM LIKE '%not enrolled%' THEN RAISE NOTICE 'A6 non-enrolled blocked: OK';
  ELSE RAISE; END IF;
END $$;

-- ---------- A7: unrelated teacher cannot mark ----------
INSERT INTO auth.users (id) VALUES ('aaaaaaaa-5555-0000-0000-000000000009');
UPDATE profiles SET school_id = '11111111-5555-1111-1111-111111111111',
                    role = 'teacher', full_name = 'Outsider'
WHERE id = 'aaaaaaaa-5555-0000-0000-000000000009';
SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-5555-0000-0000-000000000009', false);
DO $$
BEGIN
  PERFORM mark_exam_attendance_bulk(current_setting('app.esid')::uuid, jsonb_build_array(
    jsonb_build_object('student_id','44444444-5555-0000-0000-000000000001','status','present')));
  RAISE EXCEPTION 'A7 FAILED: outsider marked attendance';
EXCEPTION WHEN others THEN
  IF SQLERRM LIKE '%Access denied%' THEN RAISE NOTICE 'A7 outsider blocked: OK';
  ELSE RAISE; END IF;
END $$;

ROLLBACK;
SELECT 'EXAM ATTENDANCE SMOKE TESTS COMPLETE (rolled back)';
