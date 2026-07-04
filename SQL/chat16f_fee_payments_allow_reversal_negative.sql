-- =============================================================================
-- Schoolium - Database Migration (addendum to chat16)
-- File:    chat16f_fee_payments_allow_reversal_negative.sql
-- Session: Chat 16 - fix reversal approval failing the amount_paid check.
--
-- PROBLEM: fee_payments.amount_paid had CHECK (amount_paid > 0). A reversal
--          approval inserts a COUNTER-transaction with a negative amount (e.g.
--          -3000) whose receipt_number starts with 'REV-'. That negative row
--          violated the check, so approving ANY reversal errored with
--          "fee_payments_amount_paid_check". The reversal-approval path had
--          simply never been exercised before, so this stayed latent.
--
-- FIX:     replace the constraint so a NEGATIVE amount is allowed ONLY for a
--          reversal counter-transaction (receipt_number LIKE 'REV-%'). Real
--          payments must still be strictly positive. Zero remains disallowed.
--
-- No existing row is negative yet (no reversal ever approved), so adding this
-- constraint is safe. Pure ASCII. Idempotent.
-- =============================================================================

ALTER TABLE public.fee_payments
  DROP CONSTRAINT IF EXISTS fee_payments_amount_paid_check;

ALTER TABLE public.fee_payments
  ADD CONSTRAINT fee_payments_amount_paid_check
  CHECK (
    amount_paid > 0
    OR (amount_paid < 0 AND receipt_number LIKE 'REV-%')
  );

-- VERIFY:
-- Real payment stays positive-only; reversal counter row may be negative.
-- SELECT conname, pg_get_constraintdef(oid)
-- FROM pg_constraint
-- WHERE conrelid = 'public.fee_payments'::regclass
--   AND conname = 'fee_payments_amount_paid_check';
-- =============================================================================
