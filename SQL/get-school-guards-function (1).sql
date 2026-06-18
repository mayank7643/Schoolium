-- ============================================================
-- SCHOOLIUM — get_school_guards SECURITY DEFINER FUNCTION
-- Run this ONCE in Supabase SQL Editor
--
-- PROBLEM SOLVED:
--   Admins need to list guards (other profiles rows) from the
--   client. RLS on profiles only allows users to read their OWN
--   row — so a direct .from('profiles').eq('role','guard') query
--   returns 0 rows even though guards exist.
--
-- WHY NOT OPEN RLS:
--   This is a multi-tenant SaaS. Relaxing profiles RLS would let
--   any school_admin potentially read profiles from other schools.
--   That is unacceptable.
--
-- SOLUTION — SECURITY DEFINER function:
--   The function runs with the DB owner's privileges (bypasses
--   RLS) but ONLY after verifying the caller is a school_admin
--   for the exact school they are requesting. Cross-tenant access
--   is structurally impossible:
--     - Caller passes p_school_id
--     - Function checks auth.uid() is school_admin of THAT school
--     - If not → RAISE EXCEPTION, nothing returned
--     - If yes → returns only guards for that school
--
-- NO RLS POLICIES ARE CHANGED BY THIS MIGRATION.
-- ============================================================


-- ── Drop if exists (safe to re-run) ──────────────────────────
DROP FUNCTION IF EXISTS get_school_guards(UUID);


-- ── Create the function ───────────────────────────────────────
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
SET search_path = public        -- prevents search_path hijacking
AS $$
BEGIN
  -- ── Security gate ─────────────────────────────────────────
  -- Caller must be an active school_admin for THIS school.
  -- auth.uid() is set by Supabase from the JWT — cannot be
  -- spoofed by the client.
  IF NOT EXISTS (
    SELECT 1
    FROM   profiles
    WHERE  profiles.id        = auth.uid()     -- table-qualified: avoids ambiguity with RETURNS TABLE id column
    AND    profiles.school_id = p_school_id
    AND    profiles.role      = 'school_admin'
    AND    profiles.is_active = true
  ) THEN
    RAISE EXCEPTION 'Forbidden: caller is not an active school_admin for this school';
  END IF;

  -- ── Return guards for this school only ────────────────────
  -- SECURITY DEFINER bypasses RLS here, but we already verified
  -- the caller owns this school_id above — zero cross-tenant risk.
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


-- ── Lock down execute permissions ─────────────────────────────
-- PUBLIC (includes anon) cannot call this function.
-- Only authenticated users can — and the internal check ensures
-- only the right school_admin gets data.
REVOKE ALL    ON FUNCTION get_school_guards(UUID) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION get_school_guards(UUID) TO authenticated;


-- ============================================================
-- VERIFY — run these after migration:
--
-- 1. Confirm function exists:
--    SELECT routine_name, security_type
--    FROM information_schema.routines
--    WHERE routine_name = 'get_school_guards';
--    → should show security_type = 'DEFINER'
--
-- 2. Test as your admin user (replace the UUID):
--    SELECT * FROM get_school_guards('your-school-uuid-here');
--    → should return your guards
--
-- 3. Confirm profiles RLS is UNCHANGED:
--    SELECT policyname, cmd FROM pg_policies
--    WHERE tablename = 'profiles'
--    ORDER BY policyname;
--    → no new policies, existing ones intact
-- ============================================================
