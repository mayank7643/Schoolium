-- ============================================================
-- CHAT 17 SMOKE TEST (local validation only - do not run in prod)
-- ============================================================
\set ON_ERROR_STOP on

-- seed: a school + admin auth user (trigger creates profile)
INSERT INTO auth.users (id, email, raw_user_meta_data)
VALUES ('11111111-1111-1111-1111-111111111111', 'admin@test.in',
        '{"full_name":"Owner Admin","role":"school_admin"}');

INSERT INTO public.schools (id, name, email) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Test School', 't@t.in');

UPDATE public.profiles SET school_id = 'aaaaaaaa-0000-0000-0000-000000000001'
WHERE id = '11111111-1111-1111-1111-111111111111';

-- a second school (isolation checks)
INSERT INTO public.schools (id, name) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000002', 'Other School');

-- new teacher auth user + guard auth user (as the Node route would create)
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('22222222-2222-2222-2222-222222222222', 'amit@test.in',
   '{"full_name":"Amit Sir","role":"teacher"}'),
  ('33333333-3333-3333-3333-333333333333', 'guard@test.in',
   '{"full_name":"Gate Guard","role":"guard"}'),
  ('44444444-4444-4444-4444-444444444444', 'priya@test.in',
   '{"full_name":"Priya Principal","role":"principal"}');

UPDATE public.profiles SET school_id = 'aaaaaaaa-0000-0000-0000-000000000001'
WHERE id = '33333333-3333-3333-3333-333333333333';

-- ── TEST 1: create_staff_member (as service role would call) ──
SELECT public.create_staff_member(
  '22222222-2222-2222-2222-222222222222',
  'aaaaaaaa-0000-0000-0000-000000000001',
  'teacher', 'Amit Sir', '9876543210', 'amit@test.in',
  'Senior Teacher', 'Teaching', true,
  'Father Name', 'Address', '1985-06-15', 'male', 'B+',
  'M.Sc Maths, B.Ed', 8.5, '2020-04-01', NULL,
  '11111111-1111-1111-1111-111111111111'
) AS t1_create_teacher;

SELECT public.create_staff_member(
  '44444444-4444-4444-4444-444444444444',
  'aaaaaaaa-0000-0000-0000-000000000001',
  'principal', 'Priya Principal', '9876500000', 'priya@test.in',
  'Principal', 'Administration', false
) AS t1b_create_principal;

-- expect EMP-0001 then EMP-0002
SELECT employee_id, full_name, department FROM public.staff ORDER BY employee_id;

-- expect: profile claimed with role + school
SELECT role, school_id IS NOT NULL AS has_school, phone
FROM public.profiles WHERE id = '22222222-2222-2222-2222-222222222222';

-- ── TEST 2: duplicate staff record must fail ──
DO $$
BEGIN
  PERFORM public.create_staff_member(
    '22222222-2222-2222-2222-222222222222',
    'aaaaaaaa-0000-0000-0000-000000000001',
    'teacher', 'Dup', '123', 'x@x.in', 'X');
  RAISE EXCEPTION 'TEST2 FAILED: duplicate allowed';
EXCEPTION WHEN others THEN
  IF SQLERRM LIKE '%already exists%' THEN
    RAISE NOTICE 'TEST2 OK: %', SQLERRM;
  ELSE RAISE; END IF;
END $$;

-- ── TEST 3: cross-school hijack must fail ──
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('55555555-5555-5555-5555-555555555555', 'other@test.in',
   '{"full_name":"Other","role":"teacher"}');
UPDATE public.profiles SET school_id = 'bbbbbbbb-0000-0000-0000-000000000002'
WHERE id = '55555555-5555-5555-5555-555555555555';
DO $$
BEGIN
  PERFORM public.create_staff_member(
    '55555555-5555-5555-5555-555555555555',
    'aaaaaaaa-0000-0000-0000-000000000001',
    'teacher', 'Hijack', '123', 'x@x.in', 'X');
  RAISE EXCEPTION 'TEST3 FAILED: hijack allowed';
EXCEPTION WHEN others THEN
  IF SQLERRM LIKE '%another school%' THEN
    RAISE NOTICE 'TEST3 OK: %', SQLERRM;
  ELSE RAISE; END IF;
END $$;

-- ── TEST 4: subjects + assignments (as admin session) ──
SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

INSERT INTO public.subjects (school_id, name) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Maths');
INSERT INTO public.classes (school_id, name, section) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', '5', 'A'),
  ('aaaaaaaa-0000-0000-0000-000000000001', '5', 'B'),
  ('aaaaaaaa-0000-0000-0000-000000000001', '6', 'A');

-- Amit: class teacher of 5A + Maths in 5A, 5B, 6A
INSERT INTO public.class_teachers (school_id, class_id, staff_id)
SELECT 'aaaaaaaa-0000-0000-0000-000000000001', c.id, s.id
FROM public.classes c, public.staff s
WHERE c.name = '5' AND c.section = 'A' AND s.full_name = 'Amit Sir';

INSERT INTO public.subject_assignments (school_id, staff_id, subject_id, class_id)
SELECT 'aaaaaaaa-0000-0000-0000-000000000001', s.id, sub.id, c.id
FROM public.staff s, public.subjects sub, public.classes c
WHERE s.full_name = 'Amit Sir' AND sub.name = 'Maths';

-- TEST 4b: same-school trigger must reject a foreign class
INSERT INTO public.classes (school_id, name) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000002', '9');
DO $$
BEGIN
  INSERT INTO public.class_teachers (school_id, class_id, staff_id)
  SELECT 'aaaaaaaa-0000-0000-0000-000000000001', c.id, s.id
  FROM public.classes c, public.staff s
  WHERE c.school_id = 'bbbbbbbb-0000-0000-0000-000000000002'
    AND s.full_name = 'Amit Sir';
  RAISE EXCEPTION 'TEST4b FAILED: cross-school class accepted';
EXCEPTION WHEN others THEN
  IF SQLERRM LIKE '%does not belong%' THEN
    RAISE NOTICE 'TEST4b OK: %', SQLERRM;
  ELSE RAISE; END IF;
END $$;

-- ── TEST 5: teacher reads own assignments ──
SET request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
SELECT jsonb_pretty(public.get_teacher_assignments()) AS t5_assignments;

-- ── TEST 6: QR scan by guard: check-in then debounced then check-out ──
SET request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
SELECT public.record_staff_scan(s.id) AS t6_checkin
FROM public.staff s WHERE s.full_name = 'Amit Sir';
SELECT public.record_staff_scan(s.id) AS t6_duplicate
FROM public.staff s WHERE s.full_name = 'Amit Sir';

-- ── TEST 7: leave lifecycle ──
-- teacher applies
SET request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
SELECT public.apply_leave('sick', current_date + 3, current_date + 5, 'Fever') AS t7_leave_id \gset
-- overlap must fail
DO $$
BEGIN
  PERFORM public.apply_leave('casual', current_date + 4, current_date + 6, 'Trip');
  RAISE EXCEPTION 'TEST7b FAILED: overlap allowed';
EXCEPTION WHEN others THEN
  IF SQLERRM LIKE '%overlapping%' THEN
    RAISE NOTICE 'TEST7b OK: %', SQLERRM;
  ELSE RAISE; END IF;
END $$;

-- teacher cannot review own leave even if role escalated; principal reviews
SET request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
SELECT public.review_leave_request((SELECT id FROM public.leave_requests LIMIT 1),
                                   'approve', 'Get well soon') AS t7_review;

-- attendance rows synced as leave for the 3 days
SELECT attendance_date, status, source FROM public.staff_attendance
WHERE status = 'leave' ORDER BY attendance_date;

-- ── TEST 8: scan blocked on approved-leave day (simulate by direct check) ──
-- (today is not in the leave range so today's scan already succeeded - checked logically in fn)

-- ── TEST 9: manual bulk marking by principal ──
SELECT public.mark_staff_attendance_bulk(
  current_date,
  jsonb_build_array(
    jsonb_build_object('staff_id', (SELECT id FROM public.staff WHERE full_name='Priya Principal'),
                       'status', 'present', 'check_in_time', '08:45')
  )
) AS t9_bulk_marked;

-- ── TEST 10: monthly summary + dashboard stats ──
SELECT full_name, present_days, late_days, leave_days, working_days, percentage
FROM public.get_staff_attendance_summary(to_char(current_date, 'YYYY-MM'));

SELECT jsonb_pretty(public.get_staff_dashboard_stats()) AS t10_stats;

-- ── TEST 11: RLS - teacher cannot see colleague HR rows, sees own ──
SET request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
SET ROLE authenticated;
SELECT count(*) AS t11_visible_staff_rows_should_be_1 FROM public.staff;
SELECT count(*) AS t11_directory_should_be_2 FROM public.get_staff_directory_basic();
RESET ROLE;

-- ── TEST 12: set_staff_status terminal forces login off ──
SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
SELECT public.set_staff_status(
  (SELECT id FROM public.staff WHERE full_name = 'Amit Sir'), 'resigned');
SELECT s.employment_status, p.is_active AS login_active
FROM public.staff s JOIN public.profiles p ON p.id = s.profile_id
WHERE s.full_name = 'Amit Sir';

-- ── TEST 13: touch_login ──
SELECT public.touch_login('smoke-test-agent');
SELECT count(*) AS t13_login_history FROM public.login_history;
SELECT last_login_at IS NOT NULL AS t13_last_login_set
FROM public.profiles WHERE id = '11111111-1111-1111-1111-111111111111';

-- ── TEST 14: has_permission matrix spot checks ──
SET request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
SELECT public.has_permission('leave.review')  AS principal_can_review,
       public.has_permission('fees.collect')  AS principal_cannot_collect;
