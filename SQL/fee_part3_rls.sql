-- ============================================================
-- SCHOOLIUM FEE MODULE — PART 3 of 3
-- QUERY FUNCTIONS + RLS POLICIES + PERMISSIONS
-- Run AFTER Part 2 succeeds.
-- pg_cron block at the bottom is COMMENTED OUT — skip for now.
-- ============================================================


-- ============================================================
-- FUNCTION: get_student_fee_ledger(p_school_id, p_student_id)
-- Returns complete fee ledger for a student.
-- Used on student profile and ledger page.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_student_fee_ledger(
  p_school_id  UUID,
  p_student_id UUID
)
RETURNS TABLE (
  due_id              UUID,
  fee_type            TEXT,
  label               TEXT,
  month               TEXT,
  academic_year       TEXT,
  due_date            DATE,
  base_amount         NUMERIC,
  discount_amount     NUMERIC,
  net_amount          NUMERIC,
  late_fee_amount     NUMERIC,
  total_due           NUMERIC,
  amount_paid         NUMERIC,
  balance             NUMERIC,
  status              TEXT,
  payments_count      BIGINT,
  last_payment_date   DATE,
  last_receipt        TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Verify caller belongs to this school
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND school_id = p_school_id AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  RETURN QUERY
  SELECT
    d.id,
    d.fee_type,
    d.label,
    d.month,
    d.academic_year,
    d.due_date,
    d.base_amount,
    d.discount_amount,
    d.net_amount,
    d.late_fee_amount,
    d.total_due,
    d.amount_paid,
    d.balance,
    d.status,
    COUNT(p.id)                     AS payments_count,
    MAX(p.paid_date)                AS last_payment_date,
    MAX(p.receipt_number)           AS last_receipt
  FROM public.fee_dues d
  LEFT JOIN public.fee_payments p ON p.fee_due_id = d.id
  WHERE d.school_id  = p_school_id
    AND d.student_id = p_student_id
  GROUP BY d.id
  ORDER BY d.month DESC, d.fee_type;
END;
$$;


-- ============================================================
-- FUNCTION: get_defaulters(p_school_id, p_class_id, p_academic_year)
-- Returns all students with unpaid/partial dues.
-- p_class_id and p_academic_year are optional filters.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_defaulters(
  p_school_id     UUID,
  p_class_id      UUID    DEFAULT NULL,
  p_academic_year TEXT    DEFAULT NULL
)
RETURNS TABLE (
  student_id      UUID,
  full_name       TEXT,
  student_uid     TEXT,
  class_name      TEXT,
  class_section   TEXT,
  total_balance   NUMERIC,
  oldest_due_date DATE,
  days_overdue    INTEGER,
  dues_count      BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND school_id = p_school_id
      AND role = 'school_admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  RETURN QUERY
  SELECT
    s.id,
    s.full_name,
    s.student_uid,
    c.name,
    c.section,
    SUM(d.balance)                        AS total_balance,
    MIN(d.due_date)                       AS oldest_due_date,
    (CURRENT_DATE - MIN(d.due_date))      AS days_overdue,
    COUNT(d.id)                           AS dues_count
  FROM public.students s
  JOIN public.fee_dues d  ON d.student_id = s.id
  LEFT JOIN public.classes c ON c.id = s.class_id
  WHERE d.school_id   = p_school_id
    AND d.status      IN ('unpaid', 'partial')
    AND d.balance     > 0
    AND (p_class_id      IS NULL OR s.class_id      = p_class_id)
    AND (p_academic_year IS NULL OR d.academic_year = p_academic_year)
  GROUP BY s.id, s.full_name, s.student_uid, c.name, c.section
  ORDER BY total_balance DESC;
END;
$$;


-- ============================================================
-- FUNCTION: get_fee_dashboard_stats(p_school_id)
-- Returns today's collection, monthly collection,
-- total pending, defaulter count. Used on dashboard.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_fee_dashboard_stats(p_school_id UUID)
RETURNS TABLE (
  today_collection    NUMERIC,
  month_collection    NUMERIC,
  total_pending       NUMERIC,
  defaulters_count    BIGINT,
  total_collected_ytd NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    -- Today's collection
    COALESCE((
      SELECT SUM(p.amount_paid)
      FROM public.fee_payments p
      WHERE p.school_id = p_school_id
        AND p.paid_date = CURRENT_DATE
    ), 0),

    -- This month's collection
    COALESCE((
      SELECT SUM(p.amount_paid)
      FROM public.fee_payments p
      WHERE p.school_id = p_school_id
        AND TO_CHAR(p.paid_date, 'YYYY-MM') = TO_CHAR(CURRENT_DATE, 'YYYY-MM')
    ), 0),

    -- Total pending balance
    COALESCE((
      SELECT SUM(d.balance)
      FROM public.fee_dues d
      WHERE d.school_id = p_school_id
        AND d.status IN ('unpaid', 'partial')
        AND d.balance > 0
    ), 0),

    -- Defaulters count (students with any overdue balance)
    COALESCE((
      SELECT COUNT(DISTINCT d.student_id)
      FROM public.fee_dues d
      WHERE d.school_id = p_school_id
        AND d.status    IN ('unpaid', 'partial')
        AND d.due_date  < CURRENT_DATE
        AND d.balance   > 0
    ), 0),

    -- Total collected year to date
    COALESCE((
      SELECT SUM(p.amount_paid)
      FROM public.fee_payments p
      WHERE p.school_id = p_school_id
        AND EXTRACT(YEAR FROM p.paid_date) = EXTRACT(YEAR FROM CURRENT_DATE)
    ), 0);
END;
$$;


-- ============================================================
-- RLS — Row Level Security
-- Pattern matches existing Schoolium policies exactly.
-- school_admin: full access to their school's data.
-- guard/teacher: no access to fee data.
-- ============================================================

ALTER TABLE public.fee_structures      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fee_structure_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fee_discounts       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fee_dues            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fee_payments        ENABLE ROW LEVEL SECURITY;

-- Helper: is the current user an active school_admin for this school?
-- Used in every policy below via inline subquery (matching existing pattern).

-- fee_structures
DROP POLICY IF EXISTS "school_admin_fee_structures" ON public.fee_structures;
CREATE POLICY "school_admin_fee_structures"
  ON public.fee_structures FOR ALL
  USING (
    school_id IN (
      SELECT school_id FROM public.profiles
      WHERE id = auth.uid() AND role = 'school_admin' AND is_active = true
    )
  );

-- fee_structure_items
DROP POLICY IF EXISTS "school_admin_fee_structure_items" ON public.fee_structure_items;
CREATE POLICY "school_admin_fee_structure_items"
  ON public.fee_structure_items FOR ALL
  USING (
    school_id IN (
      SELECT school_id FROM public.profiles
      WHERE id = auth.uid() AND role = 'school_admin' AND is_active = true
    )
  );

-- fee_discounts
DROP POLICY IF EXISTS "school_admin_fee_discounts" ON public.fee_discounts;
CREATE POLICY "school_admin_fee_discounts"
  ON public.fee_discounts FOR ALL
  USING (
    school_id IN (
      SELECT school_id FROM public.profiles
      WHERE id = auth.uid() AND role = 'school_admin' AND is_active = true
    )
  );

-- fee_dues
DROP POLICY IF EXISTS "school_admin_fee_dues" ON public.fee_dues;
CREATE POLICY "school_admin_fee_dues"
  ON public.fee_dues FOR ALL
  USING (
    school_id IN (
      SELECT school_id FROM public.profiles
      WHERE id = auth.uid() AND role = 'school_admin' AND is_active = true
    )
  );

-- fee_payments
DROP POLICY IF EXISTS "school_admin_fee_payments" ON public.fee_payments;
CREATE POLICY "school_admin_fee_payments"
  ON public.fee_payments FOR ALL
  USING (
    school_id IN (
      SELECT school_id FROM public.profiles
      WHERE id = auth.uid() AND role = 'school_admin' AND is_active = true
    )
  );


-- ============================================================
-- PERMISSIONS on SECURITY DEFINER functions
-- ============================================================

REVOKE ALL ON FUNCTION public.generate_fee_dues         FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_late_fees           FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_fee_payment        FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_student_fee_ledger    FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_defaulters            FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_fee_dashboard_stats   FROM PUBLIC;
REVOKE ALL ON FUNCTION public.generate_fee_receipt_number FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.generate_fee_dues         TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_late_fees           TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_fee_payment        TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_student_fee_ledger    TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_defaulters            TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_fee_dashboard_stats   TO authenticated;
GRANT EXECUTE ON FUNCTION public.generate_fee_receipt_number TO authenticated;


-- ============================================================
-- pg_cron: Daily late fee job
-- Runs at 01:00 IST (19:30 UTC previous day) every day.
-- Applies late fees to all schools.
-- Safe to re-run — skips already-applied dues.
-- ============================================================
-- NOTE: Replace YOUR_SUPABASE_URL and YOUR_SUPABASE_ANON_KEY
-- with real values from Dashboard → Settings → API
-- Run this block SEPARATELY after confirming pg_cron is enabled.
-- ============================================================

-- SELECT cron.unschedule('apply-late-fees-daily') WHERE EXISTS (
--   SELECT 1 FROM cron.job WHERE jobname = 'apply-late-fees-daily'
-- );
--
-- SELECT cron.schedule(
--   'apply-late-fees-daily',
--   '30 19 * * *',   -- 01:00 IST = 19:30 UTC
--   $$
--     SELECT public.apply_late_fees(id) FROM public.schools WHERE is_active = true;
--   $$
-- );


-- ============================================================
-- DONE.
-- Tables: fee_structures, fee_structure_items, fee_discounts,
--         fee_dues, fee_payments
-- Functions: generate_fee_dues, apply_late_fees,
--            record_fee_payment, get_student_fee_ledger,
--            get_defaulters, get_fee_dashboard_stats
-- Existing 'fees' table: UNTOUCHED. Manual billing intact.
-- ============================================================
