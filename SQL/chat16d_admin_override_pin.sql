-- =============================================================================
-- Schoolium - Database Migration (addendum to chat16)
-- File:    chat16d_admin_override_pin.sql
-- Session: Chat 16 - secure the late-fee-waiver admin override PIN.
--
-- BEFORE: admin_override_pin was stored in PLAIN TEXT and the collect page
--         fetched it into the browser and compared it in JavaScript. Anyone who
--         could open the page (including collectors) could read the PIN.
--
-- AFTER:  the PIN is stored as a bcrypt hash (pgcrypto). It is SET via
--         set_admin_override_pin() (admin only) and CHECKED via
--         verify_admin_override_pin() which returns only true/false - the secret
--         never leaves the database.
--
-- Backward compatible: verify_admin_override_pin() detects a legacy plain-text
-- value (anything not starting with '$2') and compares it directly, so a school
-- that set a PIN the old way keeps working until it is re-set through the UI
-- (which stores a hash). Once all schools have re-set, the legacy branch can go.
--
-- Pure ASCII. Idempotent. Run in Supabase after chat16 / 16b / 16c.
-- NOTE: these two functions use "SET search_path = public, extensions" (instead
-- of just public) because pgcrypto's crypt()/gen_salt() live in the extensions
-- schema on Supabase. That is the only reason for the wider path.
-- =============================================================================

-- pgcrypto provides crypt() + gen_salt('bf'). No-op if already installed.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- set_admin_override_pin(p_pin) - admin only. Pass NULL/'' to clear the PIN.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_admin_override_pin(p_pin text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $function$
DECLARE
  v_school uuid;
BEGIN
  v_school := public.get_my_school_id();
  IF v_school IS NULL THEN
    RAISE EXCEPTION 'No school for caller';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid()
      AND school_id = v_school
      AND role = 'school_admin'
      AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  -- Clear the PIN.
  IF p_pin IS NULL OR btrim(p_pin) = '' THEN
    UPDATE public.schools SET admin_override_pin = NULL WHERE id = v_school;
    RETURN;
  END IF;

  -- Validate: 4 to 6 digits.
  IF btrim(p_pin) !~ '^[0-9]{4,6}$' THEN
    RAISE EXCEPTION 'PIN must be 4 to 6 digits';
  END IF;

  UPDATE public.schools
  SET admin_override_pin = crypt(btrim(p_pin), gen_salt('bf'))
  WHERE id = v_school;
END;
$function$;

REVOKE ALL   ON FUNCTION public.set_admin_override_pin(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_admin_override_pin(text) TO authenticated;

-- -----------------------------------------------------------------------------
-- verify_admin_override_pin(p_pin) - admin or collector. Returns true/false.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.verify_admin_override_pin(p_pin text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $function$
DECLARE
  v_school uuid;
  v_stored text;
BEGIN
  v_school := public.get_my_school_id();
  IF v_school IS NULL THEN
    RETURN false;
  END IF;

  -- Waivers are performed by admins and collectors.
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid()
      AND school_id = v_school
      AND role IN ('school_admin', 'collector')
      AND is_active = true
  ) THEN
    RETURN false;
  END IF;

  SELECT admin_override_pin INTO v_stored FROM public.schools WHERE id = v_school;

  IF v_stored IS NULL OR p_pin IS NULL OR btrim(p_pin) = '' THEN
    RETURN false;
  END IF;

  -- Hashed value (bcrypt starts with '$2') -> constant-time crypt compare.
  IF left(v_stored, 2) = '$2' THEN
    RETURN v_stored = crypt(btrim(p_pin), v_stored);
  END IF;

  -- Legacy plain-text value -> direct compare (until re-set through the UI).
  RETURN v_stored = btrim(p_pin);
END;
$function$;

REVOKE ALL   ON FUNCTION public.verify_admin_override_pin(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_admin_override_pin(text) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- VERIFY:
-- SELECT public.set_admin_override_pin('4821');       -- as an admin session
-- SELECT public.verify_admin_override_pin('4821');    -- -> true
-- SELECT public.verify_admin_override_pin('0000');    -- -> false
-- SELECT left(admin_override_pin, 4) FROM public.schools WHERE id = public.get_my_school_id();
--   -> should show '$2a$' or '$2b$' (a hash), never the digits.
-- =============================================================================
