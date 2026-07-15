-- Exam module Phase 2 (exam_logistics) smoke tests.
-- Requires: shim + chat02 + chat17 + exam_sessions_core + exam_logistics.
-- Self-contained: rolls itself back.
\set ON_ERROR_STOP on
\set QUIET on
\pset format unaligned
\pset tuples_only on

BEGIN;

-- ---------- fixtures ----------
INSERT INTO schools (id, name, email, plan)
VALUES ('11111111-2222-1111-1111-111111111111', 'Logistics School', 'l@t.in', 'basic');

INSERT INTO auth.users (id) VALUES ('aaaaaaaa-2222-0000-0000-000000000001');
UPDATE profiles SET school_id = '11111111-2222-1111-1111-111111111111',
                    role = 'school_admin', full_name = 'Admin L'
WHERE id = 'aaaaaaaa-2222-0000-0000-000000000001';

INSERT INTO classes (id, school_id, name, section) VALUES
  ('22222222-2222-0000-0000-000000000001', '11111111-2222-1111-1111-111111111111', '6', 'A'),
  ('22222222-2222-0000-0000-000000000002', '11111111-2222-1111-1111-111111111111', '6', 'B');

INSERT INTO subjects (id, school_id, name) VALUES
  ('33333333-2222-0000-0000-000000000001', '11111111-2222-1111-1111-111111111111', 'English'),
  ('33333333-2222-0000-0000-000000000002', '11111111-2222-1111-1111-111111111111', 'Hindi'),
  ('33333333-2222-0000-0000-000000000003', '11111111-2222-1111-1111-111111111111', 'Maths');

INSERT INTO students (id, school_id, class_id, full_name)
SELECT ('44444444-2222-0000-0000-0000000000' || lpad(g::text, 2, '0'))::uuid,
       '11111111-2222-1111-1111-111111111111',
       CASE WHEN g <= 3 THEN '22222222-2222-0000-0000-000000000001'::uuid
            ELSE '22222222-2222-0000-0000-000000000002'::uuid END,
       'Student ' || g
FROM generate_series(1, 6) g;

INSERT INTO exam_rooms (id, school_id, name, capacity) VALUES
  ('55555555-2222-0000-0000-000000000001', '11111111-2222-1111-1111-111111111111', 'Hall A', 40),
  ('55555555-2222-0000-0000-000000000002', '11111111-2222-1111-1111-111111111111', 'Lab 1', 2);

SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-2222-0000-0000-000000000001', false);

SELECT set_config('app.session_id',
  create_academic_session('2026-27L', '2026-04-01', '2027-03-31')::text, false);

-- holiday inside the window (Tue 08 Sep 2026); Sunday is 13 Sep 2026
INSERT INTO holidays (school_id, session_id, holiday_date, name)
VALUES ('11111111-2222-1111-1111-111111111111',
        current_setting('app.session_id')::uuid, '2026-09-08', 'Onam');

SELECT set_config('app.exam_id', create_exam(
  current_setting('app.session_id')::uuid,
  (SELECT id FROM exam_types WHERE school_id = '11111111-2222-1111-1111-111111111111' AND name = 'Quarterly'),
  'Quarterly 2026-27', NULL, NULL)::text, false);

SELECT set_exam_classes(current_setting('app.exam_id')::uuid, ARRAY[
  '22222222-2222-0000-0000-000000000001'::uuid,
  '22222222-2222-0000-0000-000000000002'::uuid]);

-- 3 subjects x 2 classes, no dates yet
SELECT upsert_exam_subjects(current_setting('app.exam_id')::uuid, (
  SELECT jsonb_agg(jsonb_build_object('class_id', c, 'subject_id', s, 'pass_marks', 33))
  FROM unnest(ARRAY['22222222-2222-0000-0000-000000000001',
                    '22222222-2222-0000-0000-000000000002']) c,
       unnest(ARRAY['33333333-2222-0000-0000-000000000001',
                    '33333333-2222-0000-0000-000000000002',
                    '33333333-2222-0000-0000-000000000003']) s
));

-- ---------- L1: auto-generate skips Sunday + holiday ----------
SELECT 'L1a result: ' || auto_generate_timetable(
  current_setting('app.exam_id')::uuid,
  '2026-09-07', '2026-09-19')::text;

SELECT 'L1b on holiday/sunday: ' || count(*)::text
FROM exam_subjects
WHERE exam_id = current_setting('app.exam_id')::uuid
  AND (exam_date = '2026-09-08' OR extract(dow FROM exam_date) = 0);

SELECT 'L1c max papers per class-day: ' || max(n)::text
FROM (SELECT count(*) n FROM exam_subjects
      WHERE exam_id = current_setting('app.exam_id')::uuid
      GROUP BY class_id, exam_date) x;

SELECT 'L1d defaults applied: ' ||
  (SELECT bool_and(start_time = '10:00' AND duration_minutes = 180 AND reporting_time = '09:30')::text
   FROM exam_subjects WHERE exam_id = current_setting('app.exam_id')::uuid);

SELECT 'L1e class 6-A dates: ' || string_agg(exam_date::text, ',' ORDER BY exam_date)
FROM exam_subjects
WHERE exam_id = current_setting('app.exam_id')::uuid
  AND class_id = '22222222-2222-0000-0000-000000000001';

-- ---------- L2: idempotent without overwrite ----------
SELECT 'L2 rerun: ' || auto_generate_timetable(
  current_setting('app.exam_id')::uuid, '2026-09-07', '2026-09-19')::text;

-- ---------- L3: gap days with overwrite ----------
SELECT 'L3a gap rerun: ' || (auto_generate_timetable(
  current_setting('app.exam_id')::uuid, '2026-09-07', '2026-09-30',
  p_gap_days := 1, p_overwrite := true))::text;
SELECT 'L3b min spacing days: ' || min(diff)::text
FROM (
  SELECT exam_date - lag(exam_date) OVER (PARTITION BY class_id ORDER BY exam_date) AS diff
  FROM exam_subjects WHERE exam_id = current_setting('app.exam_id')::uuid
) d WHERE diff IS NOT NULL;

-- ---------- L4: HOLIDAY_CLASH detected ----------
UPDATE exam_subjects SET exam_date = '2026-09-08'
WHERE id = (SELECT id FROM exam_subjects
            WHERE exam_id = current_setting('app.exam_id')::uuid
            ORDER BY exam_date LIMIT 1);
SELECT 'L4 holiday clash: ' || count(*)::text
FROM validate_exam_timetable(current_setting('app.exam_id')::uuid)
WHERE code = 'HOLIDAY_CLASH' AND severity = 'error';
-- regenerate cleanly
SELECT auto_generate_timetable(current_setting('app.exam_id')::uuid,
  '2026-09-07', '2026-09-30', p_overwrite := true);

-- ---------- L5: publish + ROOM_OVERFLOW ----------
SELECT 'L5a publish: ' || (publish_exam(current_setting('app.exam_id')::uuid))::text;
-- Lab 1 (capacity 2) hosts a 3-student class paper
UPDATE exam_subjects SET room_id = '55555555-2222-0000-0000-000000000002'
WHERE exam_id = current_setting('app.exam_id')::uuid
  AND class_id = '22222222-2222-0000-0000-000000000001'
  AND subject_id = '33333333-2222-0000-0000-000000000003';
SELECT 'L5b overflow: ' || count(*)::text
FROM validate_exam_timetable(current_setting('app.exam_id')::uuid)
WHERE code = 'ROOM_OVERFLOW' AND severity = 'warning';

-- ---------- L6: ROOM_DOUBLE_BOOKED (two classes, same room+slot) ----------
UPDATE exam_subjects es SET room_id = '55555555-2222-0000-0000-000000000001',
  exam_date = '2026-09-21', start_time = '10:00', duration_minutes = 180
WHERE es.exam_id = current_setting('app.exam_id')::uuid
  AND es.subject_id = '33333333-2222-0000-0000-000000000001';
SELECT 'L6 double booked rows: ' || count(*)::text
FROM validate_exam_timetable(current_setting('app.exam_id')::uuid)
WHERE code = 'ROOM_DOUBLE_BOOKED' AND severity = 'warning';

-- ---------- L7: unusable window raises ----------
DO $$
BEGIN
  PERFORM auto_generate_timetable(current_setting('app.exam_id')::uuid,
    '2026-09-13', '2026-09-13');  -- lone Sunday
  RAISE EXCEPTION 'L7 FAILED: empty window accepted';
EXCEPTION WHEN others THEN
  IF SQLERRM LIKE '%No usable days%' THEN RAISE NOTICE 'L7 empty window rejected: OK';
  ELSE RAISE; END IF;
END $$;

ROLLBACK;
SELECT 'LOGISTICS SMOKE TESTS COMPLETE (rolled back)';
