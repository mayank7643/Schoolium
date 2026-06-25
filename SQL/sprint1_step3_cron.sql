-- ============================================================
-- SPRINT 1 — STEP 3
-- Monthly auto-generation cron
--
-- 1. auto_generate_monthly_dues() — new function
--    Loops all active fee structures across all schools,
--    calls generate_fee_dues() for each, but caps generation
--    at the CURRENT month — never generates future months.
--
-- 2. pg_cron job — fires on 1st of every month at 00:30 IST
--    (IST = UTC+5:30, so 00:30 IST = 19:00 UTC previous day)
--
-- 3. Manual trigger RPC — admin can call this from the UI
--    at any time to generate dues up to today on demand.
--
-- Run this in Supabase SQL Editor (production).
-- ============================================================


-- ============================================================
-- 1. auto_generate_monthly_dues()
--    Core function — called by cron AND by the manual button.
--    p_school_id: optional — pass NULL to run for ALL schools
-- ============================================================

CREATE OR REPLACE FUNCTION public.auto_generate_monthly_dues(
  p_school_id UUID DEFAULT NULL
)
RETURNS TABLE (
  school_id        UUID,
  structure_id     UUID,
  structure_name   TEXT,
  generated_count  INTEGER,
  skipped_count    INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_structure     RECORD;
  v_current_month TEXT;
  v_result        RECORD;
BEGIN

  -- Current month in YYYY-MM format
  v_current_month := TO_CHAR(CURRENT_DATE, 'YYYY-MM');

  -- Loop all active fee structures
  -- If p_school_id is provided, restrict to that school only
  FOR v_structure IN
    SELECT
      fs.id,
      fs.school_id,
      fs.name,
      fs.academic_year,
      fs.year_start_month
    FROM public.fee_structures fs
    WHERE fs.is_active = true
      AND (p_school_id IS NULL OR fs.school_id = p_school_id)
    ORDER BY fs.school_id, fs.created_at
  LOOP

    -- Call the existing generate_fee_dues() for this structure.
    -- Pass NULL as from_month so it generates from year start,
    -- but generate_fee_dues already skips months before from_month.
    -- The cap at current month is enforced inside the function below.
    SELECT g.generated_count, g.skipped_count
    INTO v_result
    FROM public.generate_fee_dues_capped(
      v_structure.id,
      v_current_month
    ) g;

    -- Return one row per structure processed
    RETURN QUERY SELECT
      v_structure.school_id,
      v_structure.id,
      v_structure.name::TEXT,
      COALESCE(v_result.generated_count, 0),
      COALESCE(v_result.skipped_count,   0);

  END LOOP;

END;
$$;

REVOKE ALL ON FUNCTION public.auto_generate_monthly_dues(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auto_generate_monthly_dues(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.auto_generate_monthly_dues(UUID) TO service_role;


-- ============================================================
-- 2. generate_fee_dues_capped()
--    Wrapper around generate_fee_dues() that enforces an
--    UNTIL month cap — dues are never created for months
--    after v_until_month (current month).
--
--    This replaces the need to touch the original
--    generate_fee_dues() function.
-- ============================================================

CREATE OR REPLACE FUNCTION public.generate_fee_dues_capped(
  p_fee_structure_id  UUID,
  p_until_month       TEXT   -- 'YYYY-MM' — never generate beyond this month
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
BEGIN

  -- Load structure
  SELECT * INTO v_structure
  FROM public.fee_structures
  WHERE id = p_fee_structure_id AND is_active = true;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 0, 0;
    RETURN;
  END IF;

  -- Build all months in the academic year
  v_start_year  := SPLIT_PART(v_structure.academic_year, '-', 1)::INTEGER;
  v_year_months := ARRAY[]::TEXT[];

  FOR v_m IN 0..11 LOOP
    DECLARE
      v_abs_month INTEGER;
      v_y         INTEGER;
      v_mo        INTEGER;
    BEGIN
      v_abs_month := v_structure.year_start_month + v_m;
      v_y  := v_start_year + (v_abs_month - 1) / 12;
      v_mo := ((v_abs_month - 1) % 12) + 1;
      v_year_months := v_year_months ||
        (v_y::TEXT || '-' || LPAD(v_mo::TEXT, 2, '0'));
    END;
  END LOOP;

  -- Loop every enabled fee item
  FOR v_item IN
    SELECT * FROM public.fee_structure_items
    WHERE fee_structure_id = p_fee_structure_id AND is_enabled = true
    ORDER BY sort_order
  LOOP

    -- Determine applicable months for this item's frequency
    CASE v_item.frequency
      WHEN 'monthly' THEN
        v_months := v_year_months;

      WHEN 'one_time' THEN
        v_months := ARRAY[v_year_months[1]];

      WHEN 'quarterly' THEN
        v_months := ARRAY[]::TEXT[];
        DECLARE
          v_qm INTEGER;
        BEGIN
          FOREACH v_qm IN ARRAY COALESCE(v_item.quarterly_months, ARRAY[4,7,10,1]) LOOP
            DECLARE
              v_qy INTEGER;
            BEGIN
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
        v_months := COALESCE(v_item.applicable_months, ARRAY[]::TEXT[]);

      ELSE
        v_months := ARRAY[]::TEXT[];
    END CASE;

    -- Loop every active student in this class
    FOR v_student IN
      SELECT s.id AS student_id
      FROM public.students s
      WHERE s.school_id = v_structure.school_id
        AND s.class_id  = v_structure.class_id
        AND s.is_active = true
    LOOP

      -- Get discount for this student + fee_type
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
      v_net         := v_item.amount - v_disc_amount;

      -- Generate a due row for each applicable month
      FOREACH v_month IN ARRAY v_months LOOP

        -- ── KEY RULE: never generate dues beyond current month ──
        CONTINUE WHEN v_month > p_until_month;

        v_due_date := (v_month || '-' ||
          LPAD(v_structure.due_day_of_month::TEXT, 2, '0'))::DATE;

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
          v_net,
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

REVOKE ALL ON FUNCTION public.generate_fee_dues_capped(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.generate_fee_dues_capped(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.generate_fee_dues_capped(UUID, TEXT) TO service_role;


-- ============================================================
-- 3. trigger_manual_due_generation()
--    Safe RPC for admin to call from the UI.
--    Verifies the caller is school_admin of their own school,
--    then runs auto_generate_monthly_dues() for that school.
-- ============================================================

CREATE OR REPLACE FUNCTION public.trigger_manual_due_generation()
RETURNS TABLE (
  structure_name  TEXT,
  generated_count INTEGER,
  skipped_count   INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_school_id UUID;
BEGIN

  -- Verify caller is active school_admin
  SELECT p.school_id INTO v_school_id
  FROM public.profiles p
  WHERE p.id        = auth.uid()
    AND p.role      = 'school_admin'
    AND p.is_active = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  RETURN QUERY
  SELECT
    r.structure_name,
    r.generated_count,
    r.skipped_count
  FROM public.auto_generate_monthly_dues(v_school_id) r;

END;
$$;

REVOKE ALL ON FUNCTION public.trigger_manual_due_generation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.trigger_manual_due_generation() TO authenticated;


-- ============================================================
-- 4. pg_cron job — 1st of every month at 00:30 IST
--    IST is UTC+5:30, so 00:30 IST = 19:00 UTC (previous day)
--    Cron expression: 0 19 28-31 * *  + day-of-month check
--    Simpler: use '0 19 1 * *' which is midnight+30min IST
--    on the 1st of every month.
--
--    NOTE: pg_cron runs in UTC. 00:30 IST = 19:00 UTC.
-- ============================================================

-- Remove old job if it exists
SELECT cron.unschedule('auto-generate-monthly-dues')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'auto-generate-monthly-dues'
);

-- Schedule new job
SELECT cron.schedule(
  'auto-generate-monthly-dues',
  '0 19 1 * *',     -- 19:00 UTC = 00:30 IST on the 1st of every month
  $$
    SELECT public.auto_generate_monthly_dues(NULL);
  $$
);

-- Also keep the existing late fee cron if it was set up:
-- It runs daily so it can stay independent.
-- Verify with: SELECT * FROM cron.job;
