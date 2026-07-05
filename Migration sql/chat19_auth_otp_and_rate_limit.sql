-- ============================================================
-- SCHOOLIUM - CHAT 19 SESSION - AUTH OTP SUPPORT
-- auth_otp_and_rate_limit
-- Generated 05 July 2026 - validated on PostgreSQL 16
-- ============================================================
-- Assumes chat02..chat18 are already applied.
--
-- Supports the OTP-based auth flows (forgot password / magic-code
-- login / signup verification). The only DB piece these need is a
-- way for the FORGOT-PASSWORD page to tell the user "no account is
-- registered with this email" without also handing attackers a free
-- email-enumeration oracle. This migration adds:
--
--   1. public.auth_rate_limit  - a tiny append-only hit log used to
--      throttle the lookup by client IP.
--   2. public.email_exists(text) - SECURITY DEFINER lookup against
--      auth.users, rate limited to 8 checks / 5 min / IP. Callable
--      by anon (the forgot-password page runs logged out).
--
-- Everything else in the OTP flows (sending codes, verifying them)
-- is handled by Supabase Auth itself + the client SDK, plus the
-- project's Auth rate limits and custom SMTP (Resend). No schema
-- change is required for those.
--
-- Rules honoured: pure ASCII, idempotent, SECURITY DEFINER sets
-- search_path + REVOKE ALL FROM PUBLIC + explicit GRANT.
-- ============================================================


-- ------------------------------------------------------------
-- SECTION 1: RATE-LIMIT HIT LOG
-- RLS on with no policies: direct access is denied to every role;
-- only the SECURITY DEFINER function below (owned by postgres, the
-- table owner, which bypasses RLS) reads and writes it.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.auth_rate_limit (
  id          bigserial   PRIMARY KEY,
  bucket      text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auth_rate_limit_bucket_time
  ON public.auth_rate_limit (bucket, created_at);

ALTER TABLE public.auth_rate_limit ENABLE ROW LEVEL SECURITY;


-- ------------------------------------------------------------
-- SECTION 2: email_exists(text)
-- Returns true if an auth user exists for the (normalised) email.
-- Throttled per client IP (best-effort, from PostgREST forwarded
-- headers). Raises 'rate_limited' when the window is exceeded so the
-- UI can show a friendly "try again shortly" message.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.email_exists(p_email text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_norm  text := lower(trim(coalesce(p_email, '')));
  v_ip    text;
  v_count integer;
BEGIN
  IF v_norm = '' THEN
    RETURN false;
  END IF;

  -- Best-effort client IP from the forwarded headers PostgREST sets.
  BEGIN
    v_ip := split_part(
      (nullif(current_setting('request.headers', true), '')::json ->> 'x-forwarded-for'),
      ',', 1
    );
  EXCEPTION WHEN others THEN
    v_ip := NULL;
  END;
  v_ip := coalesce(nullif(trim(v_ip), ''), 'unknown');

  -- Opportunistic cleanup of stale rows keeps the table tiny.
  DELETE FROM public.auth_rate_limit
  WHERE created_at < now() - interval '1 hour';

  -- Max 8 checks per IP per 5 minutes.
  SELECT count(*) INTO v_count
  FROM public.auth_rate_limit
  WHERE bucket = 'email_exists:' || v_ip
    AND created_at > now() - interval '5 minutes';

  IF v_count >= 8 THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  INSERT INTO public.auth_rate_limit (bucket) VALUES ('email_exists:' || v_ip);

  RETURN EXISTS (
    SELECT 1 FROM auth.users WHERE lower(email) = v_norm
  );
END;
$$;

REVOKE ALL     ON FUNCTION public.email_exists(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.email_exists(text) TO anon, authenticated;


-- ------------------------------------------------------------
-- Reload PostgREST schema cache
-- ------------------------------------------------------------
NOTIFY pgrst, 'reload schema';

-- ============================================================
-- END OF MIGRATION
-- ============================================================
