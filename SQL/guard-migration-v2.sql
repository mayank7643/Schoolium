-- ============================================================
-- SCHOOLIUM — GUARD ROLE MIGRATION v2 (SAFE)
-- Run this ONCE in Supabase SQL Editor → SQL Editor tab
--
-- WHAT THIS DOES:
--   1. Adds 'gate' column to profiles (if not already there)
--   2. Adds RLS policy so guards can read students (own school only)
--   3. Adds RLS policy so guards can insert attendance (own school only)
--   4. Adds RLS policy so guards can read attendance (own school only)
--
-- WHAT THIS DOES NOT TOUCH:
--   ✗ Does NOT drop or replace any policy on the profiles table
--   ✗ Does NOT touch profiles RLS at all
--   ✗ Does NOT touch schools table
--
-- WHY v1 BROKE: guard-migration.sql dropped and recreated the
-- "admin_manage_school_profiles" policy on profiles FOR ALL.
-- The new policy used a correlated subquery (profiles p2 WHERE p2.id = auth.uid())
-- which caused infinite recursion in RLS — middleware got NULL back
-- when fetching the admin profile, treated admin as deactivated, locked out.
--
-- The fix: NEVER touch the profiles table policy here.
-- profiles RLS was already correct before v1 ran.
-- ============================================================


-- ──────────────────────────────────────────────────────────────
-- STEP 1: Add gate column to profiles
-- (Safe — IF NOT EXISTS means it's a no-op if already added)
-- ──────────────────────────────────────────────────────────────
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS gate TEXT DEFAULT 'Main Gate';


-- ──────────────────────────────────────────────────────────────
-- STEP 2: Guards can SELECT students from their own school
--
-- Policy chain: auth.uid() → profiles.school_id (where role IN
-- ('school_admin','guard') AND is_active=true) → students.school_id
--
-- SAFE because: it uses a SELECT on profiles (no recursion),
-- and only applies to the students table, not profiles.
--
-- Drop first in case a partial run left a broken copy
-- ──────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "guards_read_own_school_students" ON students;

CREATE POLICY "guards_read_own_school_students"
ON students
FOR SELECT
USING (
  school_id = (
    SELECT school_id
    FROM   profiles
    WHERE  id      = auth.uid()
    AND    role    IN ('school_admin', 'guard')
    AND    is_active = true
  )
);


-- ──────────────────────────────────────────────────────────────
-- STEP 3: Guards can INSERT attendance for their own school
--
-- Replaces the old "public_scan_insert" WITH CHECK (true) policy
-- which was completely open — any unauthenticated user could insert.
-- Now only authenticated guards/admins of the right school can insert.
-- ──────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "public_scan_insert"              ON attendance;
DROP POLICY IF EXISTS "guards_insert_own_school_attendance" ON attendance;

CREATE POLICY "guards_insert_own_school_attendance"
ON attendance
FOR INSERT
WITH CHECK (
  school_id = (
    SELECT school_id
    FROM   profiles
    WHERE  id      = auth.uid()
    AND    role    IN ('school_admin', 'guard')
    AND    is_active = true
  )
);


-- ──────────────────────────────────────────────────────────────
-- STEP 4: Guards can SELECT attendance for their own school
--
-- Needed so the scan page can show today's count and check
-- if a student was already scanned (real-time sync fallback).
-- The existing "school_own_attendance" policy already covers admins;
-- this extends the same read right to guards.
-- ──────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "guards_read_own_school_attendance" ON attendance;

CREATE POLICY "guards_read_own_school_attendance"
ON attendance
FOR SELECT
USING (
  school_id = (
    SELECT school_id
    FROM   profiles
    WHERE  id      = auth.uid()
    AND    role    IN ('school_admin', 'guard')
    AND    is_active = true
  )
);


-- ============================================================
-- VERIFY — run these selects after migration to confirm:
--
-- 1. Confirm gate column exists:
--    SELECT id, full_name, role, gate, is_active FROM profiles LIMIT 10;
--
-- 2. Confirm policies exist on students:
--    SELECT policyname, cmd FROM pg_policies
--    WHERE tablename = 'students' ORDER BY policyname;
--
-- 3. Confirm policies exist on attendance:
--    SELECT policyname, cmd FROM pg_policies
--    WHERE tablename = 'attendance' ORDER BY policyname;
--
-- 4. Confirm profiles policies are UNCHANGED (no admin lockout):
--    SELECT policyname, cmd FROM pg_policies
--    WHERE tablename = 'profiles' ORDER BY policyname;
-- ============================================================
