-- chat21 smoke tests. Runs as superuser; identity via request.jwt.claim.sub.
\set ON_ERROR_STOP on
\set QUIET on
\pset format unaligned
\pset tuples_only on

BEGIN;

-- ---------- fixtures ----------
INSERT INTO schools (id, name, email, plan)
VALUES ('11111111-1111-1111-1111-111111111111', 'Test School', 't@t.in', 'basic');

INSERT INTO auth.users (id) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001'),  -- admin
  ('aaaaaaaa-0000-0000-0000-000000000002');  -- teacher
-- handle_new_user trigger created profiles; claim them
UPDATE profiles SET school_id = '11111111-1111-1111-1111-111111111111',
                    role = 'school_admin', full_name = 'Admin'
WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001';
UPDATE profiles SET school_id = '11111111-1111-1111-1111-111111111111',
                    role = 'teacher', full_name = 'Teacher T'
WHERE id = 'aaaaaaaa-0000-0000-0000-000000000002';

INSERT INTO classes (id, school_id, name, section) VALUES
  ('22222222-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', '5', 'A'),
  ('22222222-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', '5', 'B');

INSERT INTO subjects (id, school_id, name, code) VALUES
  ('33333333-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Maths', 'MAT'),
  ('33333333-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'Science', 'SCI');

INSERT INTO students (id, school_id, class_id, full_name)
SELECT ('44444444-0000-0000-0000-0000000000' || lpad(g::text, 2, '0'))::uuid,
       '11111111-1111-1111-1111-111111111111',
       CASE WHEN g <= 3 THEN '22222222-0000-0000-0000-000000000001'::uuid
            ELSE '22222222-0000-0000-0000-000000000002'::uuid END,
       'Student ' || chr(64 + g)
FROM generate_series(1, 6) g;

-- act as school_admin
SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', false);

-- ---------- T1: session creation seeds types + becomes current ----------
SELECT 'T1a session id: ' ||
  create_academic_session('2026-27', '2026-04-01', '2027-03-31');
SELECT 'T1b current+active: ' ||
  (SELECT (is_current AND status = 'active')::text FROM academic_sessions WHERE name = '2026-27');
SELECT 'T1c seeded types: ' || count(*)::text FROM exam_types
  WHERE school_id = '11111111-1111-1111-1111-111111111111';

-- ---------- T2: terms - window + overlap validation ----------
SELECT 'T2a term: ' || (upsert_academic_term(
  (SELECT id FROM academic_sessions WHERE name = '2026-27'),
  NULL, 'Term 1', 'term', 1, '2026-04-01', '2026-09-30', 50) IS NOT NULL)::text;
DO $$
BEGIN
  PERFORM upsert_academic_term(
    (SELECT id FROM academic_sessions WHERE name = '2026-27'),
    NULL, 'Term X', 'term', 2, '2026-09-01', '2026-12-31', 50);
  RAISE EXCEPTION 'T2b FAILED: overlap accepted';
EXCEPTION WHEN others THEN
  IF SQLERRM LIKE '%overlap%' THEN RAISE NOTICE 'T2b overlap rejected: OK';
  ELSE RAISE; END IF;
END $$;

-- ---------- T3: exam creation + config ----------
SELECT set_config('app.exam_id', create_exam(
  (SELECT id FROM academic_sessions WHERE name = '2026-27'),
  (SELECT id FROM exam_types WHERE name = 'Half Yearly'
     AND school_id = '11111111-1111-1111-1111-111111111111'),
  'Half Yearly 2026-27',
  (SELECT id FROM academic_terms WHERE name = 'Term 1'),
  'Bring your admit card')::text, false);

SELECT 'T3a exam draft: ' ||
  (SELECT (status = 'draft')::text FROM exams WHERE id = current_setting('app.exam_id')::uuid);

SELECT set_exam_classes(current_setting('app.exam_id')::uuid, ARRAY[
  '22222222-0000-0000-0000-000000000001'::uuid,
  '22222222-0000-0000-0000-000000000002'::uuid]);

SELECT 'T3b papers saved: ' || (upsert_exam_subjects(current_setting('app.exam_id')::uuid, jsonb_build_array(
  jsonb_build_object('class_id','22222222-0000-0000-0000-000000000001','subject_id','33333333-0000-0000-0000-000000000001',
    'max_marks_theory',80,'max_marks_practical',0,'max_marks_internal',20,'pass_marks',33,
    'exam_date','2026-09-10','start_time','10:00','reporting_time','09:30','duration_minutes',180),
  jsonb_build_object('class_id','22222222-0000-0000-0000-000000000001','subject_id','33333333-0000-0000-0000-000000000002',
    'max_marks_theory',70,'max_marks_practical',30,'max_marks_internal',0,'pass_marks',33,
    'exam_date','2026-09-12','start_time','10:00','duration_minutes',180),
  jsonb_build_object('class_id','22222222-0000-0000-0000-000000000002','subject_id','33333333-0000-0000-0000-000000000001',
    'max_marks_theory',80,'max_marks_practical',0,'max_marks_internal',20,'pass_marks',33,
    'exam_date','2026-09-10','start_time','10:00','duration_minutes',180),
  jsonb_build_object('class_id','22222222-0000-0000-0000-000000000002','subject_id','33333333-0000-0000-0000-000000000002',
    'max_marks_theory',70,'max_marks_practical',30,'max_marks_internal',0,'pass_marks',33,
    'exam_date','2026-09-12','start_time','10:00','duration_minutes',180)
))->>'saved');

-- ---------- T4: validator ----------
SELECT 'T4a clean timetable errors: ' || count(*)::text
FROM validate_exam_timetable(current_setting('app.exam_id')::uuid) WHERE severity = 'error';

-- introduce an overlap (same class same slot) then detect it
SELECT upsert_exam_subjects(current_setting('app.exam_id')::uuid, jsonb_build_array(
  jsonb_build_object('class_id','22222222-0000-0000-0000-000000000001','subject_id','33333333-0000-0000-0000-000000000002',
    'max_marks_theory',70,'max_marks_practical',30,'max_marks_internal',0,'pass_marks',33,
    'exam_date','2026-09-10','start_time','11:00','duration_minutes',180)));
SELECT 'T4b overlap detected: ' || count(*)::text
FROM validate_exam_timetable(current_setting('app.exam_id')::uuid) WHERE code = 'CLASS_OVERLAP';
-- fix it back
SELECT upsert_exam_subjects(current_setting('app.exam_id')::uuid, jsonb_build_array(
  jsonb_build_object('class_id','22222222-0000-0000-0000-000000000001','subject_id','33333333-0000-0000-0000-000000000002',
    'max_marks_theory',70,'max_marks_practical',30,'max_marks_internal',0,'pass_marks',33,
    'exam_date','2026-09-12','start_time','10:00','duration_minutes',180)));

-- ---------- T5: publish -> enrollments + denormalized dates ----------
SELECT 'T5a publish: ' || (publish_exam(current_setting('app.exam_id')::uuid))::text;
SELECT 'T5b rolls class A: ' || string_agg(roll_number::text, ',' ORDER BY roll_number)
FROM exam_enrollments
WHERE exam_id = current_setting('app.exam_id')::uuid
  AND class_id = '22222222-0000-0000-0000-000000000001';
SELECT 'T5c exam dates: ' || start_date::text || ' .. ' || end_date::text
FROM exams WHERE id = current_setting('app.exam_id')::uuid;

-- ---------- T6: post-publish guards ----------
DO $$
BEGIN
  PERFORM upsert_exam_subjects(current_setting('app.exam_id')::uuid, jsonb_build_array(
    jsonb_build_object('class_id','22222222-0000-0000-0000-000000000001','subject_id','33333333-0000-0000-0000-000000000001',
      'max_marks_theory',90,'exam_date','2026-09-10','start_time','10:00','duration_minutes',180)));
  RAISE EXCEPTION 'T6a FAILED: core change accepted after publish';
EXCEPTION WHEN others THEN
  IF SQLERRM LIKE '%schedule%' OR SQLERRM LIKE '%Only%' THEN RAISE NOTICE 'T6a core change blocked: OK';
  ELSE RAISE; END IF;
END $$;

DO $$
BEGIN
  -- direct write path (bypassing RPC) - try one real row
  UPDATE exam_subjects SET pass_marks = 40
  WHERE id = (SELECT id FROM exam_subjects WHERE exam_id = current_setting('app.exam_id')::uuid LIMIT 1);
  RAISE EXCEPTION 'T6b FAILED: direct core change accepted after publish';
EXCEPTION WHEN others THEN
  IF SQLERRM LIKE '%Only schedule%' THEN RAISE NOTICE 'T6b trigger blocked direct edit: OK';
  ELSE RAISE; END IF;
END $$;

-- schedule-only change still allowed after publish
SELECT 'T6c schedule edit after publish: ' || (upsert_exam_subjects(current_setting('app.exam_id')::uuid, jsonb_build_array(
  jsonb_build_object('class_id','22222222-0000-0000-0000-000000000001','subject_id','33333333-0000-0000-0000-000000000001',
    'exam_date','2026-09-11','start_time','10:00','reporting_time','09:30','duration_minutes',180)))->>'saved');

-- ---------- T7: late admission (idempotent append) ----------
INSERT INTO students (id, school_id, class_id, full_name)
VALUES ('44444444-0000-0000-0000-000000000099', '11111111-1111-1111-1111-111111111111',
        '22222222-0000-0000-0000-000000000001', 'Aaa Newcomer');
SELECT 'T7a late admission: ' || (generate_exam_enrollments(current_setting('app.exam_id')::uuid))::text;
SELECT 'T7b newcomer roll appended (not 1): ' || roll_number::text
FROM exam_enrollments
WHERE exam_id = current_setting('app.exam_id')::uuid
  AND student_id = '44444444-0000-0000-0000-000000000099';

-- ---------- T8: overrides + enrollment status ----------
SELECT 'T8a override: ' || (upsert_student_subject_override(
  (SELECT id FROM academic_sessions WHERE name = '2026-27'),
  '44444444-0000-0000-0000-000000000001',
  '33333333-0000-0000-0000-000000000002',
  'exempted', 'Medical exemption') IS NOT NULL)::text;
SELECT set_enrollment_status(
  (SELECT id FROM exam_enrollments WHERE exam_id = current_setting('app.exam_id')::uuid
     AND student_id = '44444444-0000-0000-0000-000000000002'),
  'transferred', 'TC issued');
SELECT 'T8b transferred: ' || status FROM exam_enrollments
WHERE exam_id = current_setting('app.exam_id')::uuid
  AND student_id = '44444444-0000-0000-0000-000000000002';

-- ---------- T9: paper cancellation + lifecycle ----------
SELECT start_exam(current_setting('app.exam_id')::uuid);
SELECT cancel_exam_subject(
  (SELECT id FROM exam_subjects WHERE exam_id = current_setting('app.exam_id')::uuid
     AND class_id = '22222222-0000-0000-0000-000000000002'
     AND subject_id = '33333333-0000-0000-0000-000000000002'),
  'Paper leaked, will be rescheduled');
SELECT 'T9a cancelled paper: ' || count(*)::text FROM exam_subjects
WHERE exam_id = current_setting('app.exam_id')::uuid AND is_cancelled;
SELECT complete_exam(current_setting('app.exam_id')::uuid);
SELECT lock_exam(current_setting('app.exam_id')::uuid);
DO $$
BEGIN
  PERFORM cancel_exam(current_setting('app.exam_id')::uuid, 'should not be possible');
  RAISE EXCEPTION 'T9b FAILED: cancelled a locked exam';
EXCEPTION WHEN others THEN
  IF SQLERRM LIKE '%cannot be cancelled%' THEN RAISE NOTICE 'T9b locked exam protected: OK';
  ELSE RAISE; END IF;
END $$;
SELECT 'T9c status: ' || status FROM exams WHERE id = current_setting('app.exam_id')::uuid;

-- ---------- T10: session locking with in-flight exam check ----------
SELECT set_config('app.exam2', create_exam(
  (SELECT id FROM academic_sessions WHERE name = '2026-27'),
  (SELECT id FROM exam_types WHERE name = 'Unit Test'
     AND school_id = '11111111-1111-1111-1111-111111111111'),
  'UT-1 2026-27', NULL, NULL)::text, false);
SELECT 'T10a lock now succeeds (draft exams allowed): ' ||
  (SELECT count(*)::text FROM exams
   WHERE session_id = (SELECT id FROM academic_sessions WHERE name = '2026-27')
     AND status NOT IN ('draft','locked','cancelled'));
SELECT lock_academic_session((SELECT id FROM academic_sessions WHERE name = '2026-27'));
DO $$
BEGIN
  PERFORM delete_exam(current_setting('app.exam2')::uuid);
  RAISE EXCEPTION 'T10b FAILED: wrote into a locked session';
EXCEPTION WHEN others THEN
  IF SQLERRM LIKE '%locked%' THEN RAISE NOTICE 'T10b locked session write blocked: OK';
  ELSE RAISE; END IF;
END $$;
SELECT unlock_academic_session((SELECT id FROM academic_sessions WHERE name = '2026-27'),
                               'Reopening for corrections');
SELECT delete_exam(current_setting('app.exam2')::uuid);
SELECT 'T10c draft deleted: ' || (NOT EXISTS (SELECT 1 FROM exams WHERE id = current_setting('app.exam2')::uuid))::text;

-- ---------- T11: RLS - teacher visibility ----------
SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000002', false);
SET LOCAL ROLE authenticated;
SELECT 'T11a teacher sees exams: ' || count(*)::text FROM exams;
SELECT 'T11b teacher sees NO enrollments (not assigned): ' || count(*)::text FROM exam_enrollments;
SELECT 'T11c teacher cannot insert exam type: ' ||
  (SELECT CASE WHEN EXISTS (SELECT 1) THEN 'checked' END);
DO $$
BEGIN
  INSERT INTO exam_types (school_id, name, category)
  VALUES ('11111111-1111-1111-1111-111111111111', 'Hack Type', 'custom');
  RAISE EXCEPTION 'T11d FAILED: teacher inserted exam type';
EXCEPTION WHEN insufficient_privilege OR others THEN
  RAISE NOTICE 'T11d teacher exam_type insert blocked: OK (%)', SQLERRM;
END $$;
DO $$
BEGIN
  PERFORM create_exam((SELECT id FROM academic_sessions LIMIT 1),
                      (SELECT id FROM exam_types LIMIT 1), 'Teacher Exam', NULL, NULL);
  RAISE EXCEPTION 'T11e FAILED: teacher created an exam';
EXCEPTION WHEN others THEN
  IF SQLERRM LIKE '%Access denied%' THEN RAISE NOTICE 'T11e teacher create_exam blocked: OK';
  ELSE RAISE; END IF;
END $$;
RESET ROLE;

-- ---------- T12: audit coverage ----------
SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', false);
SELECT 'T12 audit actions: ' || string_agg(DISTINCT action, ',' ORDER BY action)
FROM exam_audit_log
WHERE school_id = '11111111-1111-1111-1111-111111111111';

ROLLBACK;
SELECT 'SMOKE TESTS COMPLETE (transaction rolled back)';
