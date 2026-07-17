-- Exam module Phase 8 (exam_publishing) smoke tests.
-- Requires: shim + baseline patch + chat02 + chat17 + exam core..results + publishing.
-- Self-contained: rolls itself back.
\set ON_ERROR_STOP on
\set QUIET on
\pset format unaligned
\pset tuples_only on

BEGIN;

INSERT INTO schools (id, name, email, plan)
VALUES ('11111111-8888-1111-1111-111111111111', 'Publish School', 'p@t.in', 'basic');
INSERT INTO auth.users (id) VALUES ('aaaaaaaa-8888-0000-0000-000000000001');
UPDATE profiles SET school_id='11111111-8888-1111-1111-111111111111', role='school_admin', full_name='Admin P'
WHERE id='aaaaaaaa-8888-0000-0000-000000000001';

INSERT INTO classes (id, school_id, name, section) VALUES
  ('22222222-8888-0000-0000-000000000001', '11111111-8888-1111-1111-111111111111', '10', 'A');
INSERT INTO subjects (id, school_id, name) VALUES
  ('33333333-8888-0000-0000-000000000001', '11111111-8888-1111-1111-111111111111', 'Maths');
-- students with DOB for the public check
INSERT INTO students (id, school_id, class_id, full_name, date_of_birth, parent_phone) VALUES
  ('44444444-8888-0000-0000-000000000001','11111111-8888-1111-1111-111111111111','22222222-8888-0000-0000-000000000001','Asha','2010-05-15','+919000000001'),
  ('44444444-8888-0000-0000-000000000002','11111111-8888-1111-1111-111111111111','22222222-8888-0000-0000-000000000001','Bina','2010-07-20','+919000000002');

SELECT set_config('request.jwt.claim.sub','aaaaaaaa-8888-0000-0000-000000000001', false);
SELECT set_config('app.sid', create_academic_session('2026-27P','2026-04-01','2027-03-31')::text, false);
SELECT set_config('app.eid', create_exam(current_setting('app.sid')::uuid,
  (SELECT id FROM exam_types WHERE school_id='11111111-8888-1111-1111-111111111111' AND name='Annual'),
  'Annual', NULL, NULL)::text, false);
SELECT set_exam_classes(current_setting('app.eid')::uuid, ARRAY['22222222-8888-0000-0000-000000000001'::uuid]);
SELECT upsert_exam_subjects(current_setting('app.eid')::uuid, jsonb_build_array(
  jsonb_build_object('class_id','22222222-8888-0000-0000-000000000001','subject_id','33333333-8888-0000-0000-000000000001',
    'max_marks_theory',100,'pass_marks',33,'exam_date','2026-06-01','start_time','10:00','duration_minutes',180)));
SELECT set_config('app.p1',(SELECT id::text FROM exam_subjects WHERE exam_id=current_setting('app.eid')::uuid), false);
SELECT publish_exam(current_setting('app.eid')::uuid);
SELECT start_exam(current_setting('app.eid')::uuid);
SELECT save_marks_bulk(current_setting('app.p1')::uuid, jsonb_build_array(
  jsonb_build_object('student_id','44444444-8888-0000-0000-000000000001','theory',88),
  jsonb_build_object('student_id','44444444-8888-0000-0000-000000000002','theory',72)));
SELECT submit_marks(current_setting('app.p1')::uuid);
SELECT verify_marks(current_setting('app.p1')::uuid);
SELECT approve_marks(current_setting('app.p1')::uuid);
SELECT freeze_marks(current_setting('app.p1')::uuid);
SELECT complete_exam(current_setting('app.eid')::uuid);

-- ---------- P1: publish blocked before compute / report cards ----------
DO $$
BEGIN
  PERFORM publish_results(current_setting('app.eid')::uuid);
  RAISE EXCEPTION 'P1 FAILED: published without computing';
EXCEPTION WHEN others THEN
  IF SQLERRM LIKE '%Compute results%' THEN RAISE NOTICE 'P1 publish-before-compute blocked: OK';
  ELSE RAISE; END IF;
END $$;

SELECT compute_exam_results(current_setting('app.eid')::uuid);
DO $$
BEGIN
  PERFORM publish_results(current_setting('app.eid')::uuid);
  RAISE EXCEPTION 'P1b FAILED: published without report cards';
EXCEPTION WHEN others THEN
  IF SQLERRM LIKE '%report cards%' THEN RAISE NOTICE 'P1b publish-before-cards blocked: OK';
  ELSE RAISE; END IF;
END $$;
SELECT generate_report_cards(current_setting('app.eid')::uuid);

-- ---------- P2: publish ----------
SELECT 'P2 publish: ' || (publish_results(current_setting('app.eid')::uuid)->>'status');

-- ---------- P3: public access ----------
RESET ROLE;
SET LOCAL ROLE anon;
SELECT 'P3a public exam list: ' || count(*)::text
FROM list_public_result_exams('11111111-8888-1111-1111-111111111111');
SELECT 'P3b correct roll+dob: ' ||
  (check_result_public('11111111-8888-1111-1111-111111111111', current_setting('app.eid')::uuid, 1, '2010-05-15')->>'found');
SELECT 'P3c wrong dob: ' ||
  (check_result_public('11111111-8888-1111-1111-111111111111', current_setting('app.eid')::uuid, 1, '2000-01-01')->>'reason');
SELECT 'P3d snapshot has no phone: ' ||
  (NOT ((check_result_public('11111111-8888-1111-1111-111111111111', current_setting('app.eid')::uuid, 1, '2010-05-15')->'report')::text LIKE '%919000000001%'))::text;
RESET ROLE;

-- ---------- P4: QR verify (anon) ----------
SELECT set_config('app.tok',
  (SELECT qr_token::text FROM report_cards WHERE exam_id=current_setting('app.eid')::uuid AND student_id='44444444-8888-0000-0000-000000000001'), false);
SET LOCAL ROLE anon;
SELECT 'P4a verify valid+current: ' ||
  (verify_report_card(current_setting('app.tok')::uuid)->>'valid') || '/' ||
  (verify_report_card(current_setting('app.tok')::uuid)->>'version_status');
SELECT 'P4b verify unknown: ' ||
  (verify_report_card('00000000-0000-0000-0000-0000000000aa')->>'reason');
RESET ROLE;

-- ---------- P5: unpublish hides public access ----------
SELECT set_config('request.jwt.claim.sub','aaaaaaaa-8888-0000-0000-000000000001', false);
SELECT unpublish_results(current_setting('app.eid')::uuid);
SET LOCAL ROLE anon;
SELECT 'P5 after unpublish, check says: ' ||
  (check_result_public('11111111-8888-1111-1111-111111111111', current_setting('app.eid')::uuid, 1, '2010-05-15')->>'reason');
RESET ROLE;

-- ---------- P6: lock is terminal; blocks reopen + unpublish ----------
SELECT set_config('request.jwt.claim.sub','aaaaaaaa-8888-0000-0000-000000000001', false);
SELECT publish_results(current_setting('app.eid')::uuid);
SELECT lock_results(current_setting('app.eid')::uuid);
DO $$
BEGIN
  PERFORM unpublish_results(current_setting('app.eid')::uuid);
  RAISE EXCEPTION 'P6a FAILED: unpublished locked results';
EXCEPTION WHEN others THEN
  IF SQLERRM LIKE '%locked%' THEN RAISE NOTICE 'P6a locked unpublish blocked: OK';
  ELSE RAISE; END IF;
END $$;
DO $$
BEGIN
  PERFORM reopen_marks(current_setting('app.p1')::uuid, 'Trying to reopen after lock');
  RAISE EXCEPTION 'P6b FAILED: reopened after results locked';
EXCEPTION WHEN others THEN
  IF SQLERRM LIKE '%locked%' THEN RAISE NOTICE 'P6b locked reopen blocked: OK';
  ELSE RAISE; END IF;
END $$;

-- ---------- P7: scheduled publish + cron fire ----------
-- unlock path doesn't exist (terminal); use a fresh publication via a
-- second exam would be heavy - instead test the cron function directly
-- by inserting a due scheduled row on this school.
UPDATE result_publications SET status='scheduled', scheduled_for = now() - interval '1 minute'
WHERE exam_id=current_setting('app.eid')::uuid;
SELECT 'P7 cron published due: ' || fn_publish_due_results()::text;
SELECT 'P7b status now: ' || status FROM result_publications WHERE exam_id=current_setting('app.eid')::uuid;

-- ---------- P8: notification targets (opt-out respected) ----------
UPDATE students SET parent_phone_opted_out = true WHERE id='44444444-8888-0000-0000-000000000002';
SELECT 'P8 notify targets (1 opted out): ' || count(*)::text
FROM get_result_notification_targets(current_setting('app.eid')::uuid);

ROLLBACK;
SELECT 'EXAM PUBLISHING SMOKE TESTS COMPLETE (rolled back)';
