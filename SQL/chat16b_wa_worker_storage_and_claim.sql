-- =============================================================================
-- Schoolium - Database Migration (addendum to chat16)
-- File:    chat16b_wa_worker_storage_and_claim.sql
-- Session: Chat 16 - support objects for the outbox worker (/api/wa/worker):
--   1. Private storage bucket 'fee-receipts' for the generated PDF receipts.
--   2. A read policy so a school_admin can later fetch their own school's PDFs
--      through an authenticated client (the worker itself uses the service role
--      and bypasses RLS; signed-URL downloads bypass RLS too).
--   3. claim_wa_outbox() - a concurrency-safe claim so overlapping worker runs
--      never process the same outbox row twice (FOR UPDATE SKIP LOCKED), and
--      rows stuck in 'processing' by a crashed run are reclaimed after 10 min.
--
-- Pure ASCII. Idempotent. Run in the Supabase SQL editor after chat16.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Storage bucket (private) for generated PDF receipts
-- -----------------------------------------------------------------------------
-- Path convention used by the worker: <school_id>/<receipt_number>.pdf
INSERT INTO storage.buckets (id, name, public)
VALUES ('fee-receipts', 'fee-receipts', false)
ON CONFLICT (id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 2. Admin read policy on the receipts bucket (scoped to their own school)
-- -----------------------------------------------------------------------------
-- The first path segment is the school_id. A school_admin may read objects whose
-- folder matches their school. Writes happen only via the service role (worker),
-- which bypasses RLS, so no INSERT/UPDATE policy is defined here on purpose.
DROP POLICY IF EXISTS "school_admin_read_fee_receipts" ON storage.objects;
CREATE POLICY "school_admin_read_fee_receipts"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'fee-receipts'
    AND (split_part(name, '/', 1))::uuid IN (
      SELECT p.school_id
      FROM public.profiles p
      WHERE p.id        = auth.uid()
        AND p.role      = 'school_admin'
        AND p.is_active = true
    )
  );

-- -----------------------------------------------------------------------------
-- 3. claim_wa_outbox() - atomic, concurrency-safe batch claim
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_wa_outbox(p_limit integer DEFAULT 25)
RETURNS SETOF public.wa_outbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  RETURN QUERY
  UPDATE public.wa_outbox o
  SET status = 'processing', updated_at = now()
  WHERE o.id IN (
    SELECT c.id
    FROM public.wa_outbox c
    WHERE
      -- ready and due
      (c.status = 'pending' AND c.next_attempt_at <= now())
      -- OR stuck in processing by a crashed run (reclaim after 10 minutes)
      OR (c.status = 'processing' AND c.updated_at < now() - interval '10 minutes')
    ORDER BY c.next_attempt_at
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  )
  RETURNING o.*;
END;
$function$;

REVOKE ALL   ON FUNCTION public.claim_wa_outbox(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_wa_outbox(integer) TO service_role;

NOTIFY pgrst, 'reload schema';

-- =============================================================================
-- VERIFY (optional)
-- =============================================================================
-- SELECT id, public FROM storage.buckets WHERE id = 'fee-receipts';
-- SELECT to_regprocedure('public.claim_wa_outbox(integer)');
-- SELECT * FROM public.claim_wa_outbox(5);   -- claims up to 5 pending rows
-- =============================================================================
