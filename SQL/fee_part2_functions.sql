-- ============================================================
-- SCHOOLIUM FEE MODULE — PART 2 of 3
-- FUNCTIONS (automation engine)
-- Run AFTER Part 1 succeeds.
-- Safe: creates functions only, no data touched.
-- ============================================================



-- ============================================================
-- FUNCTION: generate_receipt_number()
-- Generates a unique receipt number for fee_payments.
-- Format: RCP-YYMM-XXXX (e.g. RCP-2606-4821)
-- ============================================================

CREATE OR REPLACE FUNCTION public.generate_fee_receipt_number()
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  v_receipt TEXT;
  v_exists  BOOLEAN;
BEGIN
  LOOP
    v_receipt := 'RCP-' ||
      TO_CHAR(NOW(), 'YYMM') || '-' ||
      LPAD((FLOOR(RANDOM() * 9000) + 1000)::TEXT, 4, '0');

    SELECT EXISTS (
      SELECT 1 FROM public.fee_payments WHERE receipt_number = v_receipt
    ) INTO v_exists;

    EXIT WHEN NOT v_exists;
  END LOOP;

  RETURN v_receipt;
END;
$$;


-- ============================================================
-- FUNCTION: generate_fee_dues(p_fee_structure_id, p_from_month)
-- Core automation engine.
-- Called when:
--   a) A fee structure is saved/activated
--   b) A new student is added to a class that has a structure
--   c) Admin manually triggers regeneration
--
-- Generates fee_dues rows for all active students in the class
-- for all applicable months based on each item's frequency.
--
-- p_from_month: 'YYYY-MM' — only generate dues from this month
-- forward. Prevents backdating for new students.
--
-- Uses INSERT ... ON CONFLICT DO NOTHING for idempotency —
-- safe to call multiple times without creating duplicates.
-- ============================================================

CREATE OR REPLACE FUNCTION public.generate_fee_dues(
  p_fee_structure_id  UUID,
  p_from_month        TEXT DEFAULT NULL    -- 'YYYY-MM', NULL = generate all year
)
RETURNS TABLE (generated_count INTEGER, skipped_count INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_structure       RECORD;
  v_item            RECORD;
  v_student         RECORD;
  v_discount        RECORD;
  v_month           TEXT;
  v_due_date        DATE;
  v_base            NUMERIC(10,2);
  v_disc_amount     NUMERIC(10,2);
  v_net             NUMERIC(10,2);
  v_months          TEXT[];
  v_year_months     TEXT[];
  v_start_year      INTEGER;
  v_m               INTEGER;
  v_generated       INTEGER := 0;
  v_skipped         INTEGER := 0;
  v_from_month      TEXT;
  v_conflict        BOOLEAN;
BEGIN

  -- Load the fee structure
  SELECT * INTO v_structure
  FROM public.fee_structures
  WHERE id = p_fee_structure_id AND is_active = true;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 0, 0;
    RETURN;
  END IF;

  -- Build all months in the academic year
  -- e.g. year_start_month=4 (April), academic_year='2025-26' → April 2025 to March 2026
  v_start_year := SPLIT_PART(v_structure.academic_year, '-', 1)::INTEGER;
  v_year_months := ARRAY[]::TEXT[];

  FOR v_m IN 0..11 LOOP
    DECLARE
      v_abs_month INTEGER;
      v_y INTEGER;
      v_mo INTEGER;
    BEGIN
      v_abs_month := v_structure.year_start_month + v_m;
      v_y  := v_start_year + (v_abs_month - 1) / 12;
      v_mo := ((v_abs_month - 1) % 12) + 1;
      v_year_months := v_year_months ||
        (v_y::TEXT || '-' || LPAD(v_mo::TEXT, 2, '0'));
    END;
  END LOOP;

  -- Determine from_month filter
  v_from_month := COALESCE(p_from_month, v_year_months[1]);

  -- Loop over every active fee item in this structure
  FOR v_item IN
    SELECT * FROM public.fee_structure_items
    WHERE fee_structure_id = p_fee_structure_id AND is_enabled = true
    ORDER BY sort_order
  LOOP

    -- Determine which months this item applies to
    CASE v_item.frequency
      WHEN 'monthly' THEN
        v_months := v_year_months;

      WHEN 'one_time' THEN
        -- First month of the year only
        v_months := ARRAY[v_year_months[1]];

      WHEN 'quarterly' THEN
        -- Build months from quarterly_months config
        v_months := ARRAY[]::TEXT[];
        DECLARE
          v_qm INTEGER;
        BEGIN
          FOREACH v_qm IN ARRAY COALESCE(v_item.quarterly_months, ARRAY[4,7,10,1]) LOOP
            DECLARE
              v_qy INTEGER;
            BEGIN
              -- Determine year for this month
              IF v_qm >= v_structure.year_start_month THEN
                v_qy := v_start_year;
              ELSE
                v_qy := v_start_year + 1;
              END IF;
              v_months := v_months ||
                (v_qy::TEXT || '-' || LPAD(v_qm::TEXT, 2, '0'));
            END;
          END LOOP;
        END;

      WHEN 'custom' THEN
        -- Use explicit months set by admin
        v_months := COALESCE(v_item.applicable_months, ARRAY[]::TEXT[]);

      ELSE
        v_months := ARRAY[]::TEXT[];
    END CASE;

    -- Loop over every active student in this class
    FOR v_student IN
      SELECT s.id AS student_id
      FROM public.students s
      WHERE s.school_id  = v_structure.school_id
        AND s.class_id   = v_structure.class_id
        AND s.is_active  = true
    LOOP

      -- Get applicable discount for this student + fee_type (most recent active one)
      SELECT COALESCE(
        CASE d.discount_type
          WHEN 'percentage' THEN ROUND(v_item.amount * d.value / 100, 2)
          WHEN 'fixed'      THEN LEAST(d.value, v_item.amount)
        END, 0
      ) INTO v_disc_amount
      FROM public.fee_discounts d
      WHERE d.student_id  = v_student.student_id
        AND d.school_id   = v_structure.school_id
        AND d.is_active   = true
        AND (d.applies_to_fee_type IS NULL OR d.applies_to_fee_type = v_item.fee_type)
        AND (d.valid_from  IS NULL OR d.valid_from  <= CURRENT_DATE)
        AND (d.valid_until IS NULL OR d.valid_until >= CURRENT_DATE)
      ORDER BY d.created_at DESC
      LIMIT 1;

      v_disc_amount := COALESCE(v_disc_amount, 0);
      v_net := v_item.amount - v_disc_amount;

      -- Generate a due row for each applicable month
      FOREACH v_month IN ARRAY v_months LOOP

        -- Skip months before p_from_month
        CONTINUE WHEN v_month < v_from_month;

        -- Compute due_date: due_day_of_month of that month
        v_due_date := (v_month || '-' || LPAD(v_structure.due_day_of_month::TEXT, 2, '0'))::DATE;

        -- INSERT with ON CONFLICT DO NOTHING — idempotent
        INSERT INTO public.fee_dues (
          school_id, student_id, fee_structure_id, fee_structure_item_id,
          fee_type, label, month, academic_year, due_date,
          base_amount, discount_amount, net_amount, total_due, status
        ) VALUES (
          v_structure.school_id,
          v_student.student_id,
          p_fee_structure_id,
          v_item.id,
          v_item.fee_type,
          v_item.label,
          v_month,
          v_structure.academic_year,
          v_due_date,
          v_item.amount,
          v_disc_amount,
          v_net,
          v_net,       -- total_due starts as net (late fee added later if applicable)
          'unpaid'
        )
        ON CONFLICT (student_id, fee_structure_item_id, month) DO NOTHING;

        IF FOUND THEN
          v_generated := v_generated + 1;
        ELSE
          v_skipped := v_skipped + 1;
        END IF;

      END LOOP; -- months

    END LOOP; -- students

  END LOOP; -- items

  RETURN QUERY SELECT v_generated, v_skipped;
END;
$$;


-- ============================================================
-- FUNCTION: apply_late_fees(p_school_id)
-- Called by pg_cron daily at 01:00 IST.
-- Finds all unpaid/partial dues past their grace period
-- and applies late fees if the structure has it enabled.
-- Safe to call multiple times — skips already-applied rows.
-- ============================================================

CREATE OR REPLACE FUNCTION public.apply_late_fees(p_school_id UUID)
RETURNS INTEGER   -- returns count of dues updated
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_due       RECORD;
  v_structure RECORD;
  v_late_fee  NUMERIC(10,2);
  v_count     INTEGER := 0;
BEGIN

  FOR v_due IN
    SELECT d.*
    FROM public.fee_dues d
    WHERE d.school_id        = p_school_id
      AND d.status           IN ('unpaid', 'partial')
      AND d.late_fee_applied = false
      AND d.due_date         < CURRENT_DATE   -- past due date
  LOOP

    -- Load structure to check if late fee is enabled
    SELECT * INTO v_structure
    FROM public.fee_structures
    WHERE id = v_due.fee_structure_id;

    CONTINUE WHEN NOT FOUND;
    CONTINUE WHEN NOT v_structure.late_fee_enabled;

    -- Check grace period
    CONTINUE WHEN (CURRENT_DATE - v_due.due_date) <= v_structure.late_fee_grace_days;

    -- Calculate late fee
    v_late_fee := CASE v_structure.late_fee_type
      WHEN 'fixed'      THEN v_structure.late_fee_value
      WHEN 'percentage' THEN ROUND(v_due.net_amount * v_structure.late_fee_value / 100, 2)
      ELSE 0
    END;

    IF v_late_fee > 0 THEN
      UPDATE public.fee_dues
      SET
        late_fee_amount  = v_late_fee,
        total_due        = net_amount + v_late_fee,
        late_fee_applied = true,
        updated_at       = now()
      WHERE id = v_due.id;

      v_count := v_count + 1;
    END IF;

  END LOOP;

  RETURN v_count;
END;
$$;


-- ============================================================
-- FUNCTION: record_fee_payment(...)
-- Called from the UI when staff collects a payment.
-- Handles full, partial, and advance payments.
-- Updates fee_dues.amount_paid and status atomically.
-- Returns the new fee_payment id and receipt number.
-- ============================================================

CREATE OR REPLACE FUNCTION public.record_fee_payment(
  p_school_id       UUID,
  p_student_id      UUID,
  p_fee_due_id      UUID,
  p_amount_paid     NUMERIC(10,2),
  p_payment_method  TEXT,
  p_paid_date       DATE,
  p_collected_by    UUID,
  p_notes           TEXT DEFAULT NULL
)
RETURNS TABLE (payment_id UUID, receipt_number TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_receipt     TEXT;
  v_payment_id  UUID;
  v_due         RECORD;
  v_new_paid    NUMERIC(10,2);
  v_new_status  TEXT;
BEGIN

  -- Verify due belongs to this school + student
  SELECT * INTO v_due
  FROM public.fee_dues
  WHERE id         = p_fee_due_id
    AND school_id  = p_school_id
    AND student_id = p_student_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fee due not found or access denied';
  END IF;

  IF v_due.status = 'waived' THEN
    RAISE EXCEPTION 'Cannot collect payment on a waived due';
  END IF;

  -- Generate unique receipt number
  v_receipt := public.generate_fee_receipt_number();

  -- Insert payment record
  INSERT INTO public.fee_payments (
    school_id, student_id, fee_due_id,
    amount_paid, payment_method, receipt_number,
    paid_date, collected_by, notes
  ) VALUES (
    p_school_id, p_student_id, p_fee_due_id,
    p_amount_paid, p_payment_method, v_receipt,
    p_paid_date, p_collected_by, p_notes
  )
  RETURNING id INTO v_payment_id;

  -- Update due's amount_paid and status
  v_new_paid := v_due.amount_paid + p_amount_paid;
  v_new_status := CASE
    WHEN v_new_paid >= v_due.total_due THEN 'paid'
    WHEN v_new_paid > 0               THEN 'partial'
    ELSE                                   'unpaid'
  END;

  UPDATE public.fee_dues
  SET
    amount_paid = v_new_paid,
    status      = v_new_status,
    updated_at  = now()
  WHERE id = p_fee_due_id;

  RETURN QUERY SELECT v_payment_id, v_receipt;
END;
$$;

