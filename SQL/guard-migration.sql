-- ============================================================
-- SCHOOLIUM — GUARD ROLE MIGRATION
-- Run this ONCE in Supabase SQL Editor
-- ============================================================

-- 1. Add gate assignment to profiles (which gate this guard manages)
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS gate TEXT DEFAULT 'Main Gate';

-- 2. RLS: Guards can only read students from their OWN school
--    Uses auth.uid() → profiles → school_id chain
--    Admins already have their own policy — this adds guards
CREATE POLICY "guards_read_own_school_students"
ON students
FOR SELECT
USING (
  school_id = (
    SELECT school_id FROM profiles
    WHERE id = auth.uid()
    AND role IN ('school_admin', 'guard')
    AND is_active = true
  )
);

-- 3. Guards can insert attendance only for their own school
--    The existing "public_scan_insert" policy is replaced
--    with this scoped one
DROP POLICY IF EXISTS "public_scan_insert" ON attendance;

CREATE POLICY "guards_insert_own_school_attendance"
ON attendance
FOR INSERT
WITH CHECK (
  school_id = (
    SELECT school_id FROM profiles
    WHERE id = auth.uid()
    AND role IN ('school_admin', 'guard')
    AND is_active = true
  )
);

-- 4. Guards can read attendance for their own school
--    (needed to show today's scan count on the scan page)
CREATE POLICY "guards_read_own_school_attendance"
ON attendance
FOR SELECT
USING (
  school_id = (
    SELECT school_id FROM profiles
    WHERE id = auth.uid()
    AND role IN ('school_admin', 'guard')
    AND is_active = true
  )
);

-- 5. Admins can manage (CRUD) profiles for their own school
--    Needed to create/deactivate guard accounts
DROP POLICY IF EXISTS "admin_manage_school_profiles" ON profiles;

CREATE POLICY "admin_manage_school_profiles"
ON profiles
FOR ALL
USING (
  school_id = (
    SELECT school_id FROM profiles p2
    WHERE p2.id = auth.uid()
    AND p2.role = 'school_admin'
  )
);

-- ============================================================
-- VERIFY
-- SELECT id, full_name, role, gate, is_active FROM profiles;
-- ============================================================
