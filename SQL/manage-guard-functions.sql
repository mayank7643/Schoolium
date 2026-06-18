-- ============================================================
-- SCHOOLIUM — manage_guard SECURITY DEFINER FUNCTIONS
-- Run this ONCE in Supabase SQL Editor
--
-- PROBLEM SOLVED:
--   Admin cannot UPDATE or DELETE guard profile rows directly
--   because profiles RLS only allows users to modify their OWN
--   row. School admins managing guards (other users) are blocked.
--
-- WHY NOT OPEN RLS:
--   Relaxing profiles UPDATE/DELETE RLS is the same risk as
--   SELECT — a school_admin could modify profiles from other
--   schools. Unacceptable for a multi-tenant SaaS.
--
-- SOLUTION — Two SECURITY DEFINER functions:
--   update_guard(p_guard_id, p_school_id, p_is_active)
--   delete_guard(p_guard_id, p_school_id)
--
--   Both verify the caller is an active school_admin for the
--   given school AND that the target guard belongs to that same
--   school before doing anything. Cross-tenant modification is
--   structurally impossible.
--
-- NO RLS POLICIES ARE CHANGED BY THIS MIGRATION.
-- ============================================================


-- ── Drop if exists (safe to re-run) ──────────────────────────
DROP FUNCTION IF EXISTS update_guard(UUID, UUID, BOOLEAN);
DROP FUNCTION IF EXISTS delete_guard(UUID, UUID);


-- ── update_guard: toggle is_active ───────────────────────────
-- Called by the Active/Inactive toggle button on guards page.
-- p_guard_id   — the guard's profile id
-- p_school_id  — the school the admin is managing
-- p_is_active  — the NEW value to set
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
  -- ── Security gate ─────────────────────────────────────────
  -- Caller must be an active school_admin for THIS school.
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

  -- ── Verify target guard belongs to same school ────────────
  -- Prevents admin from School A deactivating a guard at School B
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

  -- ── Safe to update ────────────────────────────────────────
  UPDATE profiles
  SET    is_active = p_is_active
  WHERE  profiles.id        = p_guard_id
  AND    profiles.school_id = p_school_id;
END;
$$;


-- ── delete_guard: remove guard account ───────────────────────
-- Called by the delete button on guards page.
-- Removes the profile row — auth.users row stays but is
-- effectively orphaned (middleware will block login).
-- p_guard_id   — the guard's profile id
-- p_school_id  — the school the admin is managing
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
  -- ── Security gate ─────────────────────────────────────────
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

  -- ── Verify target guard belongs to same school ────────────
  IF NOT EXISTS (
    SELECT 1
    FROM   profiles
    WHERE  profiles.id        = p_guard_id
    AND    profiles.school_id = p_school_id
    AND    profiles.role      = 'guard'
  ) THEN
    RAISE EXCEPTION 'Forbidden: guard does not belong to this school';
  END IF;

  -- ── Safe to delete ────────────────────────────────────────
  DELETE FROM profiles
  WHERE  profiles.id        = p_guard_id
  AND    profiles.school_id = p_school_id;
END;
$$;


-- ── Lock down execute permissions ─────────────────────────────
REVOKE ALL     ON FUNCTION update_guard(UUID, UUID, BOOLEAN) FROM PUBLIC;
REVOKE ALL     ON FUNCTION delete_guard(UUID, UUID)          FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION update_guard(UUID, UUID, BOOLEAN) TO authenticated;
GRANT  EXECUTE ON FUNCTION delete_guard(UUID, UUID)          TO authenticated;


-- ============================================================
-- VERIFY — run after migration:
--
-- 1. Confirm both functions exist:
--    SELECT routine_name, security_type
--    FROM information_schema.routines
--    WHERE routine_name IN ('update_guard', 'delete_guard');
--    → should show 2 rows, both security_type = 'DEFINER'
--
-- 2. Test toggle (replace UUIDs):
--    SELECT update_guard('guard-uuid', 'school-uuid', false);
--    → guard should now be inactive
--
-- 3. Confirm profiles RLS unchanged:
--    SELECT policyname, cmd FROM pg_policies
--    WHERE tablename = 'profiles' ORDER BY policyname;
-- ============================================================
