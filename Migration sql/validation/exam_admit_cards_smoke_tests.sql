-- Exam module Phase 3 (exam_admit_cards) smoke tests.
-- Requires: shim + chat02 + chat17 + exam core + logistics + admit cards.
-- Self-contained: rolls itself back.
\set ON_ERROR_STOP on
\set QUIET on
\pset format unaligned
\pset tuples_only on

BEGIN;

-- ---------- fixtures (published exam with 4 enrolled students) ----------
INSERT INTO schools (id, name, email, plan)
VALUES ('11111111-3333-1111-1111-111111111111', 'Cards School', 'c@t.in', 'basic');

INSERT INTO auth.users (id) VALUES
  ('aaaaaaaa-3333-0000-0000-000000000001'),   -- admin
  ('aaaaaaaa-3333-0000-0000-000000000002');   -- receptionist
UPDATE profiles SET school_id = '11111111-3333-1111-1111-111111111111',
                    role = 'school_admin', full_name = 'Admin C'
WHERE id = 'aaaaaaaa-3333-0000-0000-000000000001';
UPDATE profiles SET school_id = '11111111-3333-1111-1111-111111111111',
                    role = 'receptionist', full_name = 'Front Desk'
WHERE id = 'aaaaaaaa-3333-0000-0000-000000000002';

INSERT INTO classes (id, school_id, name, section) VALUES
  ('22222222-3333-0000-0000-000000000001', '11111111-3333-1111-1111-111111111111', '7', 'A');
INSERT INTO subjects (id, school_id, name) VALUES
  ('33333333-3333-0000-0000-000000000001', '11111111-3333-1111-1111-111111111111', 'Maths');
INSERT INTO students (id, school_id, class_id, full_name)
SELECT ('44444444-3333-0000-0000-0000000000' || lpad(g::text, 2, '0'))::uuid,
       '11111111-3333-1111-1111-111111111111',
       '22222222-3333-0000-0000-000000000001', 'Student ' || g
FROM generate_series(1, 4) g;

SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-3333-0000-0000-000000000001', false);
SELECT set_config('app.sid', create_academic_session('2026-27C', '2026-04-01', '2027-03-31')::text, false);
SELECT set_config('app.eid', create_exam(
  current_setting('app.sid')::uuid,
  (SELECT id FROM exam_types WHERE school_id = '11111111-3333-1111-1111-111111111111' AND name = 'Unit Test'),
  'UT-1', NULL, NULL)::text, false);
SELECT set_exam_classes(current_setting('app.eid')::uuid,
  ARRAY['22222222-3333-0000-0000-000000000001'::uuid]);
SELECT upsert_exam_subjects(current_setting('app.eid')::uuid, jsonb_build_array(
  jsonb_build_object('class_id','22222222-3333-0000-0000-000000000001',
    'subject_id','33333333-3333-0000-0000-000000000001','pass_marks',33,
    'exam_date','2026-09-21','start_time','10:00','duration_minutes',120)));
SELECT publish_exam(current_setting('app.eid')::uuid);

-- exempt one student: they must not receive a card
SELECT set_enrollment_status(
  (SELECT id FROM exam_enrollments WHERE exam_id = current_setting('app.eid')::uuid
     AND student_id = '44444444-3333-0000-0000-000000000004'),
  'exempted', 'whole-exam exemption');

-- ---------- C1: generate ----------
SELECT 'C1a generate: ' || generate_admit_cards(current_setting('app.eid')::uuid)::text;
SELECT 'C1b idempotent: ' || generate_admit_cards(current_setting('app.eid')::uuid)::text;
SELECT 'C1c exempted has no card: ' || count(*)::text
FROM admit_cards ac
JOIN exam_enrollments ee ON ee.id = ac.enrollment_id
WHERE ac.exam_id = current_setting('app.eid')::uuid
  AND ee.student_id = '44444444-3333-0000-0000-000000000004';

-- ---------- C2: verify (valid / revoked / not found) ----------
SELECT set_config('app.token',
  (SELECT qr_token::text FROM admit_cards ac
   JOIN exam_enrollments ee ON ee.id = ac.enrollment_id
   WHERE ac.exam_id = current_setting('app.eid')::uuid
     AND ee.student_id = '44444444-3333-0000-0000-000000000001'), false);
SELECT 'C2a verify valid: ' ||
  ((verify_admit_card(current_setting('app.token')::uuid))->>'valid')
  || '/' || ((verify_admit_card(current_setting('app.token')::uuid))->>'roll_number');
SELECT 'C2b verify unknown: ' ||
  ((verify_admit_card('00000000-0000-0000-0000-00000000dead'))->>'reason');

-- ---------- C3: print recording (receptionist has the permission) ----------
SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-3333-0000-0000-000000000002', false);
SELECT 'C3a receptionist prints: ' || record_admit_card_print(
  ARRAY[(SELECT ac.id FROM admit_cards ac
         JOIN exam_enrollments ee ON ee.id = ac.enrollment_id
         WHERE ac.exam_id = current_setting('app.eid')::uuid
           AND ee.student_id = '44444444-3333-0000-0000-000000000001')])::text;
SELECT 'C3b print count: ' || print_count::text
FROM admit_cards ac
JOIN exam_enrollments ee ON ee.id = ac.enrollment_id
WHERE ee.student_id = '44444444-3333-0000-0000-000000000001';

-- receptionist can read enrollments (front desk) but cannot generate
SET LOCAL ROLE authenticated;
SELECT 'C3c receptionist sees enrollments: ' || count(*)::text FROM exam_enrollments;
RESET ROLE;
DO $$
BEGIN
  PERFORM generate_admit_cards(current_setting('app.eid')::uuid);
  RAISE EXCEPTION 'C3d FAILED: receptionist generated cards';
EXCEPTION WHEN others THEN
  IF SQLERRM LIKE '%Access denied%' THEN RAISE NOTICE 'C3d receptionist generate blocked: OK';
  ELSE RAISE; END IF;
END $$;

-- ---------- C4: unpublish refused after printing ----------
SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-3333-0000-0000-000000000001', false);
DO $$
BEGIN
  PERFORM unpublish_exam(current_setting('app.eid')::uuid);
  RAISE EXCEPTION 'C4 FAILED: unpublished despite printed cards';
EXCEPTION WHEN others THEN
  IF SQLERRM LIKE '%already printed%' THEN RAISE NOTICE 'C4 unpublish blocked after print: OK';
  ELSE RAISE; END IF;
END $$;

-- ---------- C5: revoke frees the slot; verify says not_found; regen mints new token ----------
SELECT revoke_admit_card(
  (SELECT ac.id FROM admit_cards ac
   JOIN exam_enrollments ee ON ee.id = ac.enrollment_id
   WHERE ee.student_id = '44444444-3333-0000-0000-000000000001'),
  'Photo was wrong');
SELECT 'C5a old token now: ' ||
  ((verify_admit_card(current_setting('app.token')::uuid))->>'reason');
SELECT 'C5b regenerate: ' || (generate_admit_cards(current_setting('app.eid')::uuid))::text;
SELECT 'C5c new token differs: ' ||
  ((SELECT qr_token::text FROM admit_cards ac
    JOIN exam_enrollments ee ON ee.id = ac.enrollment_id
    WHERE ee.student_id = '44444444-3333-0000-0000-000000000001')
   IS DISTINCT FROM current_setting('app.token'))::text;

-- ---------- C6: cancel_exam revokes all live cards ----------
SELECT cancel_exam(current_setting('app.eid')::uuid, 'Flood - exam abandoned');
SELECT 'C6 live cards after cancel: ' || count(*)::text
FROM admit_cards WHERE exam_id = current_setting('app.eid')::uuid AND NOT is_revoked;

ROLLBACK;
SELECT 'ADMIT CARD SMOKE TESTS COMPLETE (rolled back)';
