-- ============================================================
-- Sprint 3 — Step 3: Bulk fee payment RPC
-- Replaces sequential record_fee_payment() calls with a single
-- atomic operation that shares ONE receipt number across all dues
-- paid in the same collection session.
--
-- Run in Supabase SQL Editor.
-- ============================================================

-- ── Helper type (used only inside this function) ──────────────
-- We pass due payments as a JSON array:
--   [{ "due_id": "uuid", "amount": 500.00 }, ...]

CREATE OR REPLACE FUNCTION public.record_bulk_fee_payment(
  p_school_id       UUID,
  p_student_id      UUID,
  p_payments        JSONB,          -- array of {due_id, amount}
  p_payment_method  TEXT,
  p_paid_date       DATE,
  p_collected_by    UUID,
  p_notes           TEXT DEFAULT NULL
)
RETURNS TABLE (
  payment_id      UUID,
  receipt_number  TEXT,
  due_id          UUID,
  amount_paid     NUMERIC(10,2)
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_receipt       TEXT;
  v_exists        BOOLEAN;
  v_item          JSONB;
  v_due_id        UUID;
  v_amount        NUMERIC(10,2);
  v_due           RECORD;
  v_payment_id    UUID;
  v_new_paid      NUMERIC(10,2);
  v_new_status    TEXT;
BEGIN

  -- ── Verify caller is active admin or collector for this school ──
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id        = auth.uid()
      AND school_id = p_school_id
      AND role      IN ('school_admin', 'collector')
      AND is_active = TRUE
  ) THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  -- ── Generate ONE unique receipt number for the entire session ──
  LOOP
    v_receipt := 'RCP-' ||
      TO_CHAR(NOW(), 'YYMM') || '-' ||
      LPAD((FLOOR(RANDOM() * 9000) + 1000)::TEXT, 4, '0');

    SELECT EXISTS (
      SELECT 1 FROM public.fee_payments WHERE receipt_number = v_receipt
    ) INTO v_exists;

    EXIT WHEN NOT v_exists;
  END LOOP;

  -- ── Process each due in the array ─────────────────────────────
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_payments)
  LOOP
    v_due_id := (v_item->>'due_id')::UUID;
    v_amount  := (v_item->>'amount')::NUMERIC(10,2);

    IF v_amount <= 0 THEN
      CONTINUE;  -- skip zero-amount rows
    END IF;

    -- Verify due belongs to this school + student
    SELECT * INTO v_due
    FROM public.fee_dues
    WHERE id         = v_due_id
      AND school_id  = p_school_id
      AND student_id = p_student_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Fee due % not found or access denied', v_due_id;
    END IF;

    IF v_due.status = 'waived' THEN
      RAISE EXCEPTION 'Cannot collect payment on a waived due (due_id: %)', v_due_id;
    END IF;

    -- Insert payment row — same receipt number as all others in this session
    INSERT INTO public.fee_payments (
      school_id, student_id, fee_due_id,
      amount_paid, payment_method, receipt_number,
      paid_date, collected_by, notes
    ) VALUES (
      p_school_id, p_student_id, v_due_id,
      v_amount, p_payment_method, v_receipt,
      p_paid_date, p_collected_by, p_notes
    )
    RETURNING id INTO v_payment_id;

    -- Update due's amount_paid and status atomically
    v_new_paid   := v_due.amount_paid + v_amount;
    v_new_status := CASE
      WHEN v_new_paid >= v_due.total_due THEN 'paid'
      WHEN v_new_paid > 0               THEN 'partial'
      ELSE                                   'unpaid'
    END;

    UPDATE public.fee_dues
    SET amount_paid = v_new_paid,
        status      = v_new_status
    WHERE id = v_due_id;

    -- Write to audit trail
    INSERT INTO public.fee_audit_trail (
      school_id, student_id, fee_payment_id,
      event_type, actor_id,
      original_value, submitted_value,
      delta, notes
    ) VALUES (
      p_school_id, p_student_id, v_payment_id,
      'payment_collected', p_collected_by,
      v_due.total_due, v_amount,
      v_amount, p_notes
    );

    -- Yield this row to caller
    payment_id     := v_payment_id;
    receipt_number := v_receipt;
    due_id         := v_due_id;
    amount_paid    := v_amount;
    RETURN NEXT;
  END LOOP;

END;
$$;

-- Permissions
REVOKE ALL ON FUNCTION public.record_bulk_fee_payment(UUID,UUID,JSONB,TEXT,DATE,UUID,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_bulk_fee_payment(UUID,UUID,JSONB,TEXT,DATE,UUID,TEXT) TO authenticated;
