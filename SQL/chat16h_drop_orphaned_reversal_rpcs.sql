-- =============================================================================
-- Schoolium - OPTIONAL cleanup (dead-code)
-- File:    chat16h_drop_orphaned_reversal_rpcs.sql
-- Session: Chat 16 - dead-code cleanup.
--
-- These single-line reversal RPCs are SUPERSEDED by the group versions
-- (request_payment_reversals / approve_reversal_group / reject_reversal_group)
-- and are no longer called by the app. Dropping them is safe but OPTIONAL - they
-- are harmless if left in place. Run this ONLY if you want a clean surface.
--
-- Safe to run: the app calls none of these. If you have external scripts that
-- do, keep them. Pure ASCII. Idempotent.
-- =============================================================================

DROP FUNCTION IF EXISTS public.request_payment_reversal(uuid, text);
DROP FUNCTION IF EXISTS public.approve_payment_reversal(uuid);
DROP FUNCTION IF EXISTS public.reject_payment_reversal(uuid, text);

NOTIFY pgrst, 'reload schema';

-- VERIFY (each should return NULL after running):
-- SELECT to_regprocedure('public.request_payment_reversal(uuid, text)');
-- SELECT to_regprocedure('public.approve_payment_reversal(uuid)');
-- SELECT to_regprocedure('public.reject_payment_reversal(uuid, text)');
-- =============================================================================
