-- =============================================================================
-- Schoolium - Database Migration (addendum to chat16)
-- File:    chat16c_enqueue_fee_reminders_for.sql
-- Session: Chat 16 - manual "send reminder now" enqueue for the defaulters page.
--
-- enqueue_fee_reminders_for(student_ids, type) verifies the caller is an active
-- school_admin of their own school, then enqueues one reminder outbox row per
-- student for that student's earliest unpaid/partial due, using the SAME guards
-- as the daily sweep (no duplicate pending row, none already logged today).
-- Returns the ids of the rows it created so the caller can ask the worker to
-- process them immediately.
--
-- Pure ASCII. Idempotent. Run in Supabase after chat16 + chat16b.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.enqueue_fee_reminders_for(
  p_student_ids uuid[],
  p_type        text
)
RETURNS TABLE (outbox_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_school uuid;
  v_kind   text;
BEGIN
  v_school := public.get_my_school_id();
  IF v_school IS NULL THEN
    RAISE EXCEPTION 'No school for caller';
  END IF;

  -- Caller must be an active admin of this school.
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid()
      AND school_id = v_school
      AND role = 'school_admin'
      AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  IF p_type NOT IN ('due', 'overdue') THEN
    RAISE EXCEPTION 'Invalid reminder type';
  END IF;
  v_kind := CASE WHEN p_type = 'due' THEN 'fee_due_reminder' ELSE 'fee_overdue_reminder' END;

  -- Feature must be on.
  IF NOT EXISTS (
    SELECT 1 FROM public.schools
    WHERE id = v_school AND wa_fee_reminders_enabled = true
  ) THEN
    RAISE EXCEPTION 'feature_off';
  END IF;

  RETURN QUERY
  WITH picked AS (
    SELECT
      s.id AS student_id,
      (
        SELECT d.id
        FROM public.fee_dues d
        WHERE d.student_id = s.id
          AND d.school_id  = v_school
          AND d.status IN ('unpaid', 'partial')
          AND d.balance > 0
        ORDER BY d.due_date ASC, d.created_at ASC
        LIMIT 1
      ) AS due_id
    FROM public.students s
    WHERE s.id = ANY(p_student_ids)
      AND s.school_id = v_school
      AND s.is_active = true
      AND s.parent_phone IS NOT NULL
      AND btrim(s.parent_phone) <> ''
      AND s.parent_phone_opted_out = false
  ),
  ins AS (
    INSERT INTO public.wa_outbox (school_id, student_id, kind, ref_id, status, next_attempt_at)
    SELECT v_school, p.student_id, v_kind, p.due_id, 'pending', now()
    FROM picked p
    WHERE p.due_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.wa_outbox o
        WHERE o.school_id = v_school
          AND o.ref_id    = p.due_id
          AND o.kind      = v_kind
          AND o.status IN ('pending', 'processing')
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.wa_message_log l
        WHERE l.school_id    = v_school
          AND l.ref_id       = p.due_id
          AND l.message_type = v_kind
          AND l.log_date     = CURRENT_DATE
      )
    RETURNING id
  )
  SELECT id FROM ins;
END;
$function$;

REVOKE ALL   ON FUNCTION public.enqueue_fee_reminders_for(uuid[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enqueue_fee_reminders_for(uuid[], text) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- VERIFY:
-- SELECT to_regprocedure('public.enqueue_fee_reminders_for(uuid[], text)');
-- =============================================================================
