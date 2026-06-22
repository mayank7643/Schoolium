-- FILE: SQL/20260620_wa_increment_function.sql
-- Atomic counter increment for school's monthly WA message count.
-- Called by notify-attendance Edge Function after every successful send.
-- Using a function prevents race conditions when two scans fire simultaneously.
--
-- Run in Supabase Dashboard → SQL Editor BEFORE deploying the Edge Function.

CREATE OR REPLACE FUNCTION public.increment_wa_sent_count(p_school_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.schools
  SET wa_messages_sent_month = wa_messages_sent_month + 1
  WHERE id = p_school_id;
END;
$$;

-- Only the service role (Edge Function) should call this — not clients
REVOKE ALL ON FUNCTION public.increment_wa_sent_count(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.increment_wa_sent_count(UUID) TO service_role;

-- Verify
-- SELECT routine_name FROM information_schema.routines
-- WHERE routine_name = 'increment_wa_sent_count';
