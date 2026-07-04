-- =============================================================================
-- Schoolium - Database Migration (addendum to chat16)
-- File:    chat16e_reversal_full_and_partial.sql
-- Session: Chat 16 - let a collector reverse the FULL receipt or a chosen
--          subset of lines, instead of only one line.
--
-- PROBLEM: reversals were single-line. A bulk receipt (one receipt_number, many
--          fee_payments rows) could only ever have ONE line reversed, so a
--          Rs.12,000 receipt of 4 lines showed a Rs.3,000 reversal.
--
-- SOLUTION: a reversal is now a GROUP of line requests submitted together.
--   - reversal_requests gets reversal_group_id (lines requested together share one).
--   - request_payment_reversals(ids[], reason) creates one request per selected
--     line under a new group id. Select all lines = full reversal; a subset =
--     partial reversal.
--   - approve_reversal_group(group_id) / reject_reversal_group(group_id) action
--     every pending line in the group at once, reusing the exact single-line
--     ledger logic (one counter-payment per line, each due restored).
--
-- Existing single-line requests are backfilled to their own one-line group, so
-- the queue treats old and new requests uniformly.
--
-- Pure ASCII. Idempotent. Run in Supabase after chat16 / 16b / 16c / 16d.
-- =============================================================================

-- 1. Group column + backfill + index -----------------------------------------
ALTER TABLE public.reversal_requests
  ADD COLUMN IF NOT EXISTS reversal_group_id uuid;

-- Existing rows become their own single-line group.
UPDATE public.reversal_requests
SET reversal_group_id = id
WHERE reversal_group_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_reversal_requests_group
  ON public.reversal_requests (reversal_group_id);

COMMENT ON COLUMN public.reversal_requests.reversal_group_id IS
  'Lines requested for reversal together share one group id. Full reversal = all '
  'lines of a receipt in one group; partial = a subset.';


-- 2. request_payment_reversals(ids[], reason) -> group id --------------------
CREATE OR REPLACE FUNCTION public.request_payment_reversals(
  p_fee_payment_ids uuid[],
  p_reason          text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_school uuid;
  v_group  uuid := gen_random_uuid();
  v_pay    record;
  v_count  integer := 0;
BEGIN
  SELECT p.school_id INTO v_school
  FROM public.profiles p
  WHERE p.id = auth.uid()
    AND p.role IN ('school_admin', 'collector')
    AND p.is_active = true;
  IF v_school IS NULL THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is mandatory for reversal requests';
  END IF;

  IF p_fee_payment_ids IS NULL OR array_length(p_fee_payment_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'No payments selected';
  END IF;

  -- Only genuine, not-yet-reversed lines of THIS school (skip REV- counters,
  -- skip lines already requested or approved; allow re-request of rejected).
  FOR v_pay IN
    SELECT fp.*
    FROM public.fee_payments fp
    WHERE fp.id = ANY(p_fee_payment_ids)
      AND fp.school_id = v_school
      AND COALESCE(fp.receipt_number, '') NOT LIKE 'REV-%'
      AND (fp.reversal_status IS NULL OR fp.reversal_status = 'reversal_rejected')
  LOOP
    INSERT INTO public.reversal_requests (
      school_id, fee_payment_id, requested_by, reason, reversal_group_id
    ) VALUES (
      v_school, v_pay.id, auth.uid(), btrim(p_reason), v_group
    )
    ON CONFLICT (fee_payment_id) DO UPDATE SET
      status             = 'pending',
      reason             = EXCLUDED.reason,
      requested_by       = EXCLUDED.requested_by,
      requested_at       = now(),
      reviewed_by        = NULL,
      reviewed_at        = NULL,
      admin_notes        = NULL,
      counter_payment_id = NULL,
      reversal_group_id  = EXCLUDED.reversal_group_id;

    UPDATE public.fee_payments
    SET reversal_status       = 'reversal_requested',
        reversal_reason       = btrim(p_reason),
        reversal_requested_by = auth.uid(),
        reversal_requested_at = now()
    WHERE id = v_pay.id;

    INSERT INTO public.fee_audit_trail (
      school_id, actor_id, actor_role, event_type, student_id, fee_payment_id, notes
    )
    SELECT v_school, auth.uid(), p.role, 'reversal_requested', v_pay.student_id, v_pay.id, btrim(p_reason)
    FROM public.profiles p WHERE p.id = auth.uid();

    v_count := v_count + 1;
  END LOOP;

  IF v_count = 0 THEN
    RAISE EXCEPTION 'No eligible payments to reverse (already requested or reversed)';
  END IF;

  RETURN v_group;
END;
$function$;

REVOKE ALL   ON FUNCTION public.request_payment_reversals(uuid[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_payment_reversals(uuid[], text) TO authenticated;


-- 3. approve_reversal_group(group_id, notes) -> count reversed ----------------
CREATE OR REPLACE FUNCTION public.approve_reversal_group(
  p_group_id    uuid,
  p_admin_notes text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_school     uuid;
  v_req        record;
  v_payment    record;
  v_due        record;
  v_counter_id uuid;
  v_new_paid   numeric(10,2);
  v_new_status text;
  v_count      integer := 0;
BEGIN
  SELECT p.school_id INTO v_school
  FROM public.profiles p
  WHERE p.id = auth.uid() AND p.role = 'school_admin' AND p.is_active = true;
  IF v_school IS NULL THEN
    RAISE EXCEPTION 'Access denied - school_admin role required for reversal approval';
  END IF;

  FOR v_req IN
    SELECT * FROM public.reversal_requests
    WHERE reversal_group_id = p_group_id AND school_id = v_school AND status = 'pending'
  LOOP
    SELECT * INTO v_payment FROM public.fee_payments WHERE id = v_req.fee_payment_id;
    SELECT * INTO v_due     FROM public.fee_dues     WHERE id = v_payment.fee_due_id;

    INSERT INTO public.fee_payments (
      school_id, student_id, fee_due_id,
      amount_paid, payment_method, receipt_number,
      paid_date, collected_by, notes, reversal_status
    ) VALUES (
      v_school, v_payment.student_id, v_payment.fee_due_id,
      -(v_payment.amount_paid), v_payment.payment_method,
      'REV-' || v_payment.receipt_number,
      CURRENT_DATE, auth.uid(),
      'REVERSAL of ' || v_payment.receipt_number || COALESCE(': ' || p_admin_notes, ''),
      'reversal_approved'
    )
    RETURNING id INTO v_counter_id;

    v_new_paid := GREATEST(v_due.amount_paid - v_payment.amount_paid, 0);
    v_new_status := CASE
      WHEN v_new_paid <= 0               THEN 'unpaid'
      WHEN v_new_paid >= v_due.total_due THEN 'paid'
      ELSE                                    'partial'
    END;

    UPDATE public.fee_dues
    SET amount_paid = v_new_paid, status = v_new_status, updated_at = now()
    WHERE id = v_due.id;

    UPDATE public.fee_payments
    SET reversal_status = 'reversal_approved', reversed_by = auth.uid(),
        reversed_at = now(), reversal_payment_id = v_counter_id
    WHERE id = v_req.fee_payment_id;

    UPDATE public.reversal_requests
    SET status = 'approved', reviewed_by = auth.uid(), reviewed_at = now(),
        admin_notes = p_admin_notes, counter_payment_id = v_counter_id
    WHERE id = v_req.id;

    INSERT INTO public.fee_audit_trail (
      school_id, actor_id, actor_role, event_type, student_id, fee_payment_id, notes
    )
    SELECT v_school, auth.uid(), p.role, 'reversal_approved', v_payment.student_id, v_req.fee_payment_id, p_admin_notes
    FROM public.profiles p WHERE p.id = auth.uid();

    v_count := v_count + 1;
  END LOOP;

  IF v_count = 0 THEN
    RAISE EXCEPTION 'No pending requests in this group';
  END IF;

  RETURN v_count;
END;
$function$;

REVOKE ALL   ON FUNCTION public.approve_reversal_group(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approve_reversal_group(uuid, text) TO authenticated;


-- 4. reject_reversal_group(group_id, notes) -> count rejected -----------------
CREATE OR REPLACE FUNCTION public.reject_reversal_group(
  p_group_id    uuid,
  p_admin_notes text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_school uuid;
  v_req    record;
  v_count  integer := 0;
BEGIN
  SELECT p.school_id INTO v_school
  FROM public.profiles p
  WHERE p.id = auth.uid() AND p.role = 'school_admin' AND p.is_active = true;
  IF v_school IS NULL THEN
    RAISE EXCEPTION 'Access denied - school_admin role required';
  END IF;

  IF p_admin_notes IS NULL OR btrim(p_admin_notes) = '' THEN
    RAISE EXCEPTION 'Admin notes are mandatory when rejecting a reversal';
  END IF;

  FOR v_req IN
    SELECT * FROM public.reversal_requests
    WHERE reversal_group_id = p_group_id AND school_id = v_school AND status = 'pending'
  LOOP
    UPDATE public.reversal_requests
    SET status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now(), admin_notes = btrim(p_admin_notes)
    WHERE id = v_req.id;

    UPDATE public.fee_payments
    SET reversal_status = 'reversal_rejected'
    WHERE id = v_req.fee_payment_id;

    INSERT INTO public.fee_audit_trail (
      school_id, actor_id, actor_role, event_type, fee_payment_id, notes
    )
    SELECT v_school, auth.uid(), p.role, 'reversal_rejected', v_req.fee_payment_id, btrim(p_admin_notes)
    FROM public.profiles p WHERE p.id = auth.uid();

    v_count := v_count + 1;
  END LOOP;

  IF v_count = 0 THEN
    RAISE EXCEPTION 'No pending requests in this group';
  END IF;

  RETURN v_count;
END;
$function$;

REVOKE ALL   ON FUNCTION public.reject_reversal_group(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reject_reversal_group(uuid, text) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- VERIFY:
-- SELECT id, reversal_group_id, status FROM public.reversal_requests ORDER BY requested_at DESC LIMIT 5;
-- SELECT to_regprocedure('public.request_payment_reversals(uuid[], text)');
-- SELECT to_regprocedure('public.approve_reversal_group(uuid, text)');
-- SELECT to_regprocedure('public.reject_reversal_group(uuid, text)');
-- =============================================================================
