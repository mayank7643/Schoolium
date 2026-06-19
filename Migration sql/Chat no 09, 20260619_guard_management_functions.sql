-- ============================================================
-- MIGRATION: 20260619_guard_management_functions
-- Project:   Schoolium — Multi-tenant SaaS for Indian Schools
-- Date:      2026-06-19
-- Author:    Generated from chat session 09_schoolium
--
-- PURPOSE:
--   Enables school admins to list, activate/deactivate, and
--   delete guard accounts without touching profiles RLS policies.
--
-- PROBLEM SOLVED:
--   Supabase RLS on `profiles` allows users to read/write only
--   their OWN row. School admins managing guards (other users)
--   were blocked from all SELECT, UPDATE, and DELETE operations
--   on guard rows — even within their own school.
--
-- SOLUTION:
--   Three SECURITY DEFINER functions that bypass RLS internally
--   but enforce strict school_id ownership checks via auth.uid()
--   before executing any query. Cross-tenant access is
--   structurally impossible.
--
-- RLS IMPACT:
--   ZERO. No existing RLS policy is created, modified, or
--   dropped by this migration.
--
-- PREREQUISITES:
--   - profiles table exists with columns:
--       id UUID, school_id UUID, role TEXT, is_active BOOLEAN,
--       full_name TEXT, gate TEXT, created_at TIMESTAMPTZ
--   - profiles_role_check constraint already includes 'guard'
--   - auth schema available (Supabase default)
--
-- SAFE TO RE-RUN: Yes — DROP IF EXISTS + CREATE OR REPLACE
-- ============================================================


-- ── 1. get_school_guards ──────────────────────────────────────
-- Returns all guard profiles for a school.
-- Called by: attendance-page.tsx and guards-page.tsx
--            via supabase.rpc('get_school_guards', { p_school_id })
--
-- BUG FIXED IN THIS VERSION:
--   Original version used bare `id` in the IF NOT EXISTS check.
--   PostgreSQL raised ERROR 42702 "column reference id is
--   ambiguous" because RETURNS TABLE also declares a column
--   named `id`, creating a naming conflict in the function scope.
--   Fixed by fully qualifying all column references as profiles.X
-- ============================================================
DROP FUNCTION IF EXISTS get_school_guards(UUID);

CREATE OR REPLACE FUNCTION get_school_guards(p_school_id UUID)
RETURNS TABLE (
  id         UUID,
  full_name  TEXT,
  gate       TEXT,
  is_active  BOOLEAN,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Security gate:
  -- Caller must be an active school_admin for THIS specific school.
  -- auth.uid() is resolved server-side from the JWT — cannot be
  -- spoofed by the client.
  -- All columns table-qualified (profiles.X) to avoid ambiguity
  -- with the RETURNS TABLE column declarations above.
  IF NOT EXISTS (
    SELECT 1
    FROM   profiles
    WHERE  profiles.id        = auth.uid()
    AND    profiles.school_id = p_school_id
    AND    profiles.role      = 'school_admin'
    AND    profiles.is_active = true
  ) THEN
    RAISE EXCEPTION 'Forbidden: caller is not an active school_admin for this school';
  END IF;

  -- SECURITY DEFINER bypasses RLS here, but the check above
  -- guarantees the caller owns this school_id.
  -- Results scoped to this school only — zero cross-tenant risk.
  RETURN QUERY
    SELECT
      p.id,
      p.full_name,
      p.gate,
      p.is_active,
      p.created_at
    FROM   profiles p
    WHERE  p.school_id = p_school_id
    AND    p.role      = 'guard'
    ORDER  BY p.created_at DESC;
END;
$$;

-- Deny unauthenticated (anon) callers; allow authenticated users.
-- The internal check still blocks non-admins.
REVOKE ALL     ON FUNCTION get_school_guards(UUID) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION get_school_guards(UUID) TO authenticated;


-- ── 2. update_guard ───────────────────────────────────────────
-- Toggles is_active on a guard profile.
-- Called by: guards-page.tsx Active/Inactive toggle button
--            via supabase.rpc('update_guard', { p_guard_id,
--                                               p_school_id,
--                                               p_is_active })
--
-- Deactivating a guard blocks them on their next page load
-- (middleware checks is_active on every request).
-- ============================================================
DROP FUNCTION IF EXISTS update_guard(UUID, UUID, BOOLEAN);

CREATE OR REPLACE FUNCTION update_guard(
  p_guard_id  UUID,
  p_school_id UUID,
  p_is_active BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Gate 1: Caller must be an active school_admin for this school.
  IF NOT EXISTS (
    SELECT 1
    FROM   profiles
    WHERE  profiles.id        = auth.uid()
    AND    profiles.school_id = p_school_id
    AND    profiles.role      = 'school_admin'
    AND    profiles.is_active = true
  ) THEN
    RAISE EXCEPTION 'Forbidden: caller is not an active school_admin for this school';
  END IF;

  -- Gate 2: Target guard must belong to the same school.
  -- Prevents School A admin from deactivating School B's guard
  -- by passing a foreign guard_id with their own school_id.
  IF NOT EXISTS (
    SELECT 1
    FROM   profiles
    WHERE  profiles.id        = p_guard_id
    AND    profiles.school_id = p_school_id
    AND    profiles.role      = 'guard'
  ) THEN
    RAISE EXCEPTION 'Forbidden: guard does not belong to this school';
  END IF;

  -- Both gates passed — safe to update.
  UPDATE profiles
  SET    is_active  = p_is_active
  WHERE  profiles.id        = p_guard_id
  AND    profiles.school_id = p_school_id;
END;
$$;

REVOKE ALL     ON FUNCTION update_guard(UUID, UUID, BOOLEAN) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION update_guard(UUID, UUID, BOOLEAN) TO authenticated;


-- ── 3. delete_guard ───────────────────────────────────────────
-- Deletes a guard's profile row from the profiles table.
-- Called by: guards-page.tsx delete button
--            via supabase.rpc('delete_guard', { p_guard_id,
--                                               p_school_id })
--
-- NOTE: This removes the profiles row only. The corresponding
-- auth.users row is orphaned (intentional — agreed in session).
-- The guard cannot log in because middleware requires a profiles
-- row with a valid role. auth.users cleanup can be done manually
-- via Supabase Dashboard → Authentication → Users.
-- ============================================================
DROP FUNCTION IF EXISTS delete_guard(UUID, UUID);

CREATE OR REPLACE FUNCTION delete_guard(
  p_guard_id  UUID,
  p_school_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Gate 1: Caller must be an active school_admin for this school.
  IF NOT EXISTS (
    SELECT 1
    FROM   profiles
    WHERE  profiles.id        = auth.uid()
    AND    profiles.school_id = p_school_id
    AND    profiles.role      = 'school_admin'
    AND    profiles.is_active = true
  ) THEN
    RAISE EXCEPTION 'Forbidden: caller is not an active school_admin for this school';
  END IF;

  -- Gate 2: Target guard must belong to the same school.
  IF NOT EXISTS (
    SELECT 1
    FROM   profiles
    WHERE  profiles.id        = p_guard_id
    AND    profiles.school_id = p_school_id
    AND    profiles.role      = 'guard'
  ) THEN
    RAISE EXCEPTION 'Forbidden: guard does not belong to this school';
  END IF;

  -- Both gates passed — safe to delete.
  DELETE FROM profiles
  WHERE  profiles.id        = p_guard_id
  AND    profiles.school_id = p_school_id;
END;
$$;

REVOKE ALL     ON FUNCTION delete_guard(UUID, UUID) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION delete_guard(UUID, UUID) TO authenticated;


-- ============================================================
-- VERIFICATION QUERIES
-- Run these after applying the migration to confirm success.
--
-- 1. Confirm all three functions exist with SECURITY DEFINER:
--    SELECT routine_name, security_type
--    FROM   information_schema.routines
--    WHERE  routine_name IN (
--             'get_school_guards', 'update_guard', 'delete_guard'
--           )
--    ORDER  BY routine_name;
--    → Expect 3 rows, all security_type = 'DEFINER'
--
-- 2. Confirm no RLS policies were changed:
--    SELECT policyname, cmd, qual
--    FROM   pg_policies
--    WHERE  tablename = 'profiles'
--    ORDER  BY policyname;
--    → Should match exactly what existed before this migration
--
-- 3. Smoke test as admin (replace UUIDs with real values):
--    SELECT * FROM get_school_guards('your-school-uuid');
--    → Should return guard rows
--
--    SELECT update_guard('guard-uuid', 'school-uuid', false);
--    → Should return void, guard deactivated
--
--    SELECT delete_guard('guard-uuid', 'school-uuid');
--    → Should return void, guard profile deleted
-- ============================================================
