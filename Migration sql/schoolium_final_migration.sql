-- ============================================================
-- SCHOOLIUM — FINAL CLEAN MIGRATION
-- Migration Name: 003_attendance_and_guard_roles
-- Generated: 2026-06-13
-- Assumes: 001_initial_schema and 002_student_uid_and_fees
--          already applied (from previous session handoff)
-- Safe to run on production — all statements are idempotent
-- ============================================================


-- ============================================================
-- SECTION 1: ATTENDANCE TABLE
-- Status: Already in production. Included here with
--         IF NOT EXISTS for documentation completeness.
--         Re-running is fully safe.
-- ============================================================

CREATE TABLE IF NOT EXISTS attendance (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id  UUID        NOT NULL REFERENCES schools(id)  ON DELETE CASCADE,
  student_id UUID        NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  scan_date  DATE        NOT NULL DEFAULT CURRENT_DATE,
  scan_time  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  gate       TEXT        NOT NULL DEFAULT 'Main Gate',
  guard_id   TEXT,       -- auth.uid() of the guard who scanned; nullable for legacy rows
  exam_id    UUID,       -- nullable FK reserved for future exam-day attendance (same table)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  attendance              IS 'One row per student per school day. Duplicates silently rejected by unique index.';
COMMENT ON COLUMN attendance.guard_id     IS 'Stores auth.uid() of scanning guard. Nullable to support legacy rows from pre-auth era.';
COMMENT ON COLUMN attendance.exam_id      IS 'Nullable. When set, links this attendance record to a specific exam. Normal attendance has exam_id = NULL.';


-- ============================================================
-- SECTION 2: ATTENDANCE INDEXES
-- Status: Already in production. IF NOT EXISTS makes safe.
-- ============================================================

-- Duplicate-prevention constraint — the core safety guarantee.
-- INSERT ... ON CONFLICT (school_id, student_id, scan_date) DO NOTHING
-- Two guards scanning same student simultaneously → first wins, second silently ignored.
CREATE UNIQUE INDEX IF NOT EXISTS attendance_unique_per_day
  ON attendance (school_id, student_id, scan_date);

-- Used by: dashboard "today's attendance" count query
CREATE INDEX IF NOT EXISTS idx_attendance_school_date
  ON attendance (school_id, scan_date);

-- Used by: student profile attendance history panel
CREATE INDEX IF NOT EXISTS idx_attendance_student
  ON attendance (school_id, student_id);

-- Used by: consecutive-absence detection (future WhatsApp alert feature)
CREATE INDEX IF NOT EXISTS idx_attendance_date_desc
  ON attendance (school_id, scan_date DESC);


-- ============================================================
-- SECTION 3: ENABLE RLS ON ATTENDANCE
-- Status: Already enabled. ALTER is idempotent — safe to re-run.
-- ============================================================

ALTER TABLE attendance ENABLE ROW LEVEL SECURITY;


-- ============================================================
-- SECTION 4: PROFILES TABLE — GATE COLUMN
-- Status: Column was added during guard-migration.sql run.
--         Emergency revert only removed POLICIES, not columns.
--         IF NOT EXISTS makes this idempotent either way.
-- ============================================================

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS gate TEXT DEFAULT 'Main Gate';

COMMENT ON COLUMN profiles.gate IS 'Gate assignment for guard role: Main Gate / Side Gate / Back Gate. NULL for non-guard profiles.';


-- ============================================================
-- SECTION 5: ATTENDANCE RLS POLICIES
--
-- HISTORY OF CHANGES (read before modifying):
--
-- v1 "school_own_attendance" FOR ALL — KEPT (admin full access)
-- v1 "public_scan_insert" FOR INSERT WITH CHECK(true) — REPLACED
--    Reason: scan page now requires login; unauthenticated insert
--    is no longer needed and is a security risk.
--
-- OBSOLETE (do not recreate):
--   "public_scan_insert" WITH CHECK(true) — too permissive
--   "public_read_students_for_scan" USING(true) — exposed all schools
--   "admin_manage_school_profiles" FOR ALL — locked admins out
-- ============================================================

-- Keep existing admin policy — already in production, leave untouched.
-- "school_own_attendance" FOR ALL USING (school_id IN (SELECT school_id FROM profiles WHERE id = auth.uid()))
-- DO NOT recreate — would fail with duplicate policy name.

-- Drop the overly-permissive public insert policy that was in v1.
-- The scan page now requires guard login, so this is no longer needed.
DROP POLICY IF EXISTS "public_scan_insert" ON attendance;

-- Guards (and admins) can INSERT attendance — strictly own school only.
-- auth.uid() → profiles.school_id chain prevents cross-school writes.
-- is_active check means deactivated guards are blocked at DB level too.
DROP POLICY IF EXISTS "guards_insert_own_school_attendance" ON attendance;
CREATE POLICY "guards_insert_own_school_attendance"
  ON attendance
  FOR INSERT
  WITH CHECK (
    school_id = (
      SELECT school_id
      FROM   profiles
      WHERE  id        = auth.uid()
        AND  role      IN ('school_admin', 'guard')
        AND  is_active = true
    )
  );

-- Guards (and admins) can SELECT attendance — strictly own school only.
-- Needed so the scan page shows today's scan count to the guard.
DROP POLICY IF EXISTS "guards_read_own_school_attendance" ON attendance;
CREATE POLICY "guards_read_own_school_attendance"
  ON attendance
  FOR SELECT
  USING (
    school_id = (
      SELECT school_id
      FROM   profiles
      WHERE  id        = auth.uid()
        AND  role      IN ('school_admin', 'guard')
        AND  is_active = true
    )
  );


-- ============================================================
-- SECTION 6: STUDENTS RLS POLICIES
--
-- HISTORY OF CHANGES:
--   "public_read_students_for_scan" USING(true) — CREATED then
--   immediately REVERTED after it exposed all schools' students.
--   NEVER recreate that policy.
--
--   "guards_read_own_school_students" — created in guard-migration,
--   reverted via emergency-revert, now recreated correctly here.
--
-- NOTE: We do NOT recreate or modify the existing admin policy
--   on students. We only ADD a new guard-specific policy.
--   Profiles RLS is left completely untouched (that was the
--   root cause of the admin lockout in the failed migration).
-- ============================================================

-- Guards can SELECT students — strictly own school only.
-- RLS-level school isolation: a guard from School A is
-- physically incapable of reading School B's student rows.
DROP POLICY IF EXISTS "guards_read_own_school_students" ON students;
CREATE POLICY "guards_read_own_school_students"
  ON students
  FOR SELECT
  USING (
    school_id = (
      SELECT school_id
      FROM   profiles
      WHERE  id        = auth.uid()
        AND  role      IN ('school_admin', 'guard')
        AND  is_active = true
    )
  );


-- ============================================================
-- SECTION 7: VERIFICATION QUERIES
-- Run these after migration to confirm everything is correct.
-- ============================================================

-- 1. Confirm attendance table and columns exist
-- SELECT column_name, data_type, is_nullable
-- FROM information_schema.columns
-- WHERE table_name = 'attendance'
-- ORDER BY ordinal_position;

-- 2. Confirm gate column added to profiles
-- SELECT column_name, data_type, column_default
-- FROM information_schema.columns
-- WHERE table_name = 'profiles' AND column_name = 'gate';

-- 3. Confirm all indexes exist
-- SELECT indexname, indexdef
-- FROM pg_indexes
-- WHERE tablename = 'attendance';

-- 4. Confirm RLS policies — should see exactly these on attendance:
--   school_own_attendance          (FOR ALL  — admin)
--   guards_insert_own_school_attendance (FOR INSERT — guard + admin)
--   guards_read_own_school_attendance   (FOR SELECT — guard + admin)
-- SELECT policyname, cmd, qual
-- FROM pg_policies
-- WHERE tablename = 'attendance';

-- 5. Confirm student policy added — should see guards_read_own_school_students
-- SELECT policyname, cmd
-- FROM pg_policies
-- WHERE tablename = 'students';

-- 6. Quick sanity check — confirm no public_scan_insert remains
-- SELECT COUNT(*) FROM pg_policies
-- WHERE tablename = 'attendance' AND policyname = 'public_scan_insert';
-- Expected result: 0

-- ============================================================
-- END OF MIGRATION 003_attendance_and_guard_roles
-- ============================================================
