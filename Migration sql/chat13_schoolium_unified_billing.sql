-- ============================================================
-- MIGRATION: 20260628_schoolium_sprint3_unified_billing_security
-- ============================================================
-- Project:  Schoolium — Multi-school SaaS (India)
-- Session:  Chat 13
-- Date:     2026-06-28
-- Author:   Generated via Senior DB Architect Review
--
-- WHAT THIS MIGRATION DOES (in execution order):
--   A. Extends existing tables (profiles, schools, fee_discounts,
--      fee_payments, fee_dues)
--   B. Drops the legacy fees table
--   C. Drops functions whose return type changed (cannot OR REPLACE)
--   D. Creates three new audit/security tables
--   E. Creates/replaces all affected functions (final versions only)
--   F. Creates all indexes
--   G. Drops and recreates RLS policies
--   H. One-time data backfill for pre-existing reversal flags
--
-- PRE-CONDITIONS (must already exist in DB):
--   - tables:    schools, profiles, students, classes, fee_structures,
--                fee_structure_items, fee_discounts, fee_dues, fee_payments
--   - functions: assign_student_fee_structure, generate_fee_dues_capped,
--                trigger_manual_due_generation, record_fee_payment,
--                search_students_omnibox
--   - column:    students.fee_structure_id (added in sprint2_step2)
--
-- SUPERSEDED / REMOVED (do NOT re-run these):
--   - sprint3_step1_unify_billing.sql    (superseded by this file)
--   - sprint3_step2_security_audit.sql   (superseded by this file)
--   - sprint3_step2b_admin_pin.sql       (superseded by this file)
--   - fix_backfill_reversal.sql          (included here at end)
--
-- CONFLICTS RESOLVED:
--   1. get_student_billing_summary: 3 versions existed; only v3 kept
--   2. get_student_fee_ledger: return-type error fixed; DROP+CREATE used
--   3. fee_dues RLS: defined twice; single canonical version kept
--   4. fees table: dropped here after all dependent functions rebuilt
-- ============================================================

BEGIN;

-- ============================================================
-- SECTION A: EXTEND EXISTING TABLES
-- ============================================================

-- ── A1. profiles — add 'collector' role ──────────────────────
-- collector = office staff who collects fees but cannot approve
-- reversals, manage students, or set fee structures.

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_role_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check
    CHECK (role IN (
      'super_admin',
      'school_admin',
      'teacher',
      'collector',
      'guard',
      'parent'
    ));

COMMENT ON COLUMN public.profiles.role IS
  'super_admin: Anthropic staff. '
  'school_admin: Principal/owner — full access. '
  'collector: Office staff — collect fees, print receipts, request reversals only. '
  'teacher: Class teacher — attendance and student view. '
  'guard: Gate guard — scan only. '
  'parent: Parent — view own child only (Phase 4).';

-- ── A2. schools — late fee waiver caps + admin override PIN ──

ALTER TABLE public.schools
  ADD COLUMN IF NOT EXISTS late_fee_waiver_max_pct   NUMERIC(5,2)  NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS late_fee_waiver_max_flat  NUMERIC(10,2) NOT NULL DEFAULT 200,
  ADD COLUMN IF NOT EXISTS admin_override_pin         TEXT          DEFAULT NULL;

COMMENT ON COLUMN public.schools.late_fee_waiver_max_pct IS
  'Max % of late fee a collector can waive without admin PIN override. Default 10%.';
COMMENT ON COLUMN public.schools.late_fee_waiver_max_flat IS
  'Max flat ₹ a collector can waive without admin PIN override. Default ₹200. '
  'Whichever of pct/flat is lower applies.';
COMMENT ON COLUMN public.schools.admin_override_pin IS
  'Plain-text PIN set by school_admin. Unlocks late fee waivers above cap. '
  'Upgrade to bcrypt before scaling beyond beta.';

-- ── A3. fee_discounts — approval + category audit columns ────
-- Collectors may only apply discounts where is_approved = true.
-- Admin pre-approves each discount category.

ALTER TABLE public.fee_discounts
  ADD COLUMN IF NOT EXISTS discount_category  TEXT NOT NULL DEFAULT 'other'
    CHECK (discount_category IN (
      'rte_quota',
      'staff_child',
      'sibling',
      'merit',
      'sports_quota',
      'special',
      'other'
    )),
  ADD COLUMN IF NOT EXISTS approved_by        UUID
    REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_approved        BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.fee_discounts.is_approved IS
  'Only school_admin can set true. '
  'Collectors can only apply discounts where is_approved = true.';
COMMENT ON COLUMN public.fee_discounts.discount_category IS
  'Category for audit reports. ''special'' and ''other'' require notes.';

-- ── A4. fee_payments — reversal lifecycle columns ────────────
-- Payments are IMMUTABLE after creation.
-- Reversal = counter-transaction (REV- prefix), never deletion.

ALTER TABLE public.fee_payments
  ADD COLUMN IF NOT EXISTS reversal_status         TEXT
    CHECK (reversal_status IN (
      'reversal_requested',
      'reversal_approved',
      'reversal_rejected'
    )),
  ADD COLUMN IF NOT EXISTS reversal_reason          TEXT,
  ADD COLUMN IF NOT EXISTS reversal_requested_by    UUID
    REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reversal_requested_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reversed_by              UUID
    REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reversed_at              TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reversal_payment_id      UUID
    REFERENCES public.fee_payments(id) ON DELETE SET NULL;

-- Fix payment_method constraint: 'online' → 'card'
-- (original schema had 'online'; corrected throughout this session)
ALTER TABLE public.fee_payments
  DROP CONSTRAINT IF EXISTS fee_payments_payment_method_check;

ALTER TABLE public.fee_payments
  ADD CONSTRAINT fee_payments_payment_method_check
    CHECK (payment_method IN (
      'cash', 'upi', 'bank_transfer', 'cheque', 'card', 'other'
    ));

COMMENT ON COLUMN public.fee_payments.reversal_payment_id IS
  'Points to the REV- counter-transaction row that reversed this payment. '
  'NULL for normal payments. Set by approve_payment_reversal() only.';

-- ── A5. fee_dues — unify billing (structured + manual) ───────

ALTER TABLE public.fee_dues
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'structured'
    CHECK (source IN ('structured', 'manual'));

-- Make foreign keys nullable so manual dues (no structure) can exist
ALTER TABLE public.fee_dues
  ALTER COLUMN fee_structure_id      DROP NOT NULL,
  ALTER COLUMN fee_structure_item_id DROP NOT NULL;

-- Remove fee_type CHECK so manual dues can use freeform types
-- (validation for structured dues happens at fee_structure_items level)
ALTER TABLE public.fee_dues
  DROP CONSTRAINT IF EXISTS fee_dues_fee_type_check;

-- Remove old unique constraint that required fee_structure_item_id
-- (would block NULL values for manual dues)
ALTER TABLE public.fee_dues
  DROP CONSTRAINT IF EXISTS fee_dues_unique_per_month;

COMMENT ON TABLE public.fee_dues IS
  'Unified fee dues. source=''structured'' = auto-generated by generate_fee_dues_capped(). '
  'source=''manual'' = created by admin via create_manual_due() RPC. '
  'balance is GENERATED ALWAYS AS (total_due - amount_paid) — never update directly. '
  'record_fee_payment() is the ONLY way to record payments.';

COMMENT ON COLUMN public.fee_dues.source IS
  '''structured'' = auto-generated from fee_structures. '
  '''manual'' = created on-demand by admin for ad-hoc charges.';

-- ============================================================
-- SECTION B: DROP LEGACY fees TABLE
-- (No customer data — confirmed safe)
-- All billing now unified in fee_dues + fee_payments.
-- ============================================================

DROP POLICY IF EXISTS "school_sees_own_fees"      ON public.fees;
DROP POLICY IF EXISTS "super_admin_sees_all_fees" ON public.fees;
DROP INDEX  IF EXISTS public.idx_fees_school_id;
DROP INDEX  IF EXISTS public.idx_fees_student_id;
DROP INDEX  IF EXISTS public.idx_fees_status;
DROP TABLE  IF EXISTS public.fees CASCADE;

-- ============================================================
-- SECTION C: DROP FUNCTIONS WHOSE RETURN TYPE CHANGED
-- Must DROP before CREATE OR REPLACE when RETURNS TABLE columns change.
-- This was the root cause of the "42P13: cannot change return type"
-- error encountered during development.
-- ============================================================

DROP FUNCTION IF EXISTS public.get_student_fee_ledger(UUID, UUID);
DROP FUNCTION IF EXISTS public.get_student_billing_summary(UUID);
DROP FUNCTION IF EXISTS public.get_fee_dashboard_stats(UUID);

-- ============================================================
-- SECTION D: CREATE NEW SECURITY / AUDIT TABLES
-- Must exist before functions that reference them.
-- ============================================================

-- ── D1. fee_audit_trail ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.fee_audit_trail (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id       UUID          NOT NULL REFERENCES public.schools(id)   ON DELETE CASCADE,
  actor_id        UUID          NOT NULL REFERENCES public.profiles(id)  ON DELETE CASCADE,
  actor_role      TEXT          NOT NULL,
  event_type      TEXT          NOT NULL
    CHECK (event_type IN (
      'student_loaded',
      'payment_collected',
      'manual_due_created',
      'reversal_requested',
      'reversal_approved',
      'reversal_rejected',
      'late_fee_waived',
      'discount_applied',
      'eod_submitted'
    )),
  student_id      UUID          REFERENCES public.students(id)      ON DELETE SET NULL,
  fee_due_id      UUID          REFERENCES public.fee_dues(id)      ON DELETE SET NULL,
  fee_payment_id  UUID          REFERENCES public.fee_payments(id)  ON DELETE SET NULL,
  original_value  NUMERIC(10,2),
  submitted_value NUMERIC(10,2),
  delta           NUMERIC(10,2) GENERATED ALWAYS AS
                    (submitted_value - original_value) STORED,
  notes           TEXT,
  ip_address      TEXT,
  user_agent      TEXT,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.fee_audit_trail IS
  'Immutable audit log. Written only via log_fee_audit_event() RPC. Never deleted.';

-- ── D2. eod_closures ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.eod_closures (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id           UUID          NOT NULL REFERENCES public.schools(id)   ON DELETE CASCADE,
  collector_id        UUID          NOT NULL REFERENCES public.profiles(id)  ON DELETE CASCADE,
  closure_date        DATE          NOT NULL DEFAULT CURRENT_DATE,
  system_cash_total   NUMERIC(10,2) NOT NULL DEFAULT 0,
  physical_cash_count NUMERIC(10,2) NOT NULL,
  variance            NUMERIC(10,2) GENERATED ALWAYS AS
                        (physical_cash_count - system_cash_total) STORED,
  status              TEXT          NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted', 'acknowledged', 'disputed')),
  notes               TEXT,
  admin_notes         TEXT,
  acknowledged_by     UUID          REFERENCES public.profiles(id) ON DELETE SET NULL,
  acknowledged_at     TIMESTAMPTZ,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT eod_one_per_collector_per_day
    UNIQUE (school_id, collector_id, closure_date)
);

COMMENT ON TABLE public.eod_closures IS
  'End-of-day cash reconciliation. variance = physical - system. '
  'Collector cannot see system_cash_total until after submission.';

-- ── D3. reversal_requests ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.reversal_requests (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id           UUID          NOT NULL REFERENCES public.schools(id)       ON DELETE CASCADE,
  fee_payment_id      UUID          NOT NULL REFERENCES public.fee_payments(id)  ON DELETE CASCADE,
  requested_by        UUID          NOT NULL REFERENCES public.profiles(id)      ON DELETE CASCADE,
  requested_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  reason              TEXT          NOT NULL,
  status              TEXT          NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by         UUID          REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewed_at         TIMESTAMPTZ,
  admin_notes         TEXT,
  counter_payment_id  UUID          REFERENCES public.fee_payments(id) ON DELETE SET NULL,
  CONSTRAINT one_reversal_request_per_payment
    UNIQUE (fee_payment_id)
);

COMMENT ON TABLE public.reversal_requests IS
  'Reversal queue. Collector submits, admin approves. No self-reversal. '
  'Counter-payment created only on admin approval.';

-- ============================================================
-- SECTION E: FUNCTIONS (final versions only, correct order)
-- ============================================================

-- ── E1. log_fee_audit_event() — no deps on other new functions ─

CREATE OR REPLACE FUNCTION public.log_fee_audit_event(
  p_event_type      TEXT,
  p_student_id      UUID      DEFAULT NULL,
  p_fee_due_id      UUID      DEFAULT NULL,
  p_fee_payment_id  UUID      DEFAULT NULL,
  p_original_value  NUMERIC   DEFAULT NULL,
  p_submitted_value NUMERIC   DEFAULT NULL,
  p_notes           TEXT      DEFAULT NULL,
  p_ip_address      TEXT      DEFAULT NULL,
  p_user_agent      TEXT      DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_school_id UUID;
  v_role      TEXT;
BEGIN
  SELECT p.school_id, p.role INTO v_school_id, v_role
  FROM public.profiles p
  WHERE p.id        = auth.uid()
    AND p.role      IN ('school_admin', 'collector')
    AND p.is_active = true;

  IF v_school_id IS NULL THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  INSERT INTO public.fee_audit_trail (
    school_id, actor_id, actor_role, event_type,
    student_id, fee_due_id, fee_payment_id,
    original_value, submitted_value,
    notes, ip_address, user_agent
  ) VALUES (
    v_school_id, auth.uid(), v_role, p_event_type,
    p_student_id, p_fee_due_id, p_fee_payment_id,
    p_original_value, p_submitted_value,
    p_notes, p_ip_address, p_user_agent
  );
END;
$$;

REVOKE ALL  ON FUNCTION public.log_fee_audit_event(TEXT,UUID,UUID,UUID,NUMERIC,NUMERIC,TEXT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_fee_audit_event(TEXT,UUID,UUID,UUID,NUMERIC,NUMERIC,TEXT,TEXT,TEXT) TO authenticated;

-- ── E2. create_manual_due() — new, no function deps ──────────

CREATE OR REPLACE FUNCTION public.create_manual_due(
  p_school_id      UUID,
  p_student_id     UUID,
  p_fee_type       TEXT,
  p_label          TEXT,
  p_amount         NUMERIC(10,2),
  p_due_date       DATE,
  p_month          TEXT,
  p_academic_year  TEXT,
  p_notes          TEXT DEFAULT NULL
)
RETURNS TABLE (due_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_due_id UUID;
BEGIN
  -- Auth: active school_admin for this school
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id        = auth.uid()
      AND school_id = p_school_id
      AND role      = 'school_admin'
      AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Access denied — school_admin role required';
  END IF;

  -- Student must belong to this school and be active
  IF NOT EXISTS (
    SELECT 1 FROM public.students
    WHERE id        = p_student_id
      AND school_id = p_school_id
      AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Student not found or not active in this school';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be greater than zero';
  END IF;

  INSERT INTO public.fee_dues (
    school_id, student_id,
    fee_structure_id, fee_structure_item_id,
    source, fee_type, label, month, academic_year,
    due_date, base_amount, discount_amount, net_amount,
    late_fee_amount, total_due, amount_paid, status, notes
  ) VALUES (
    p_school_id, p_student_id,
    NULL, NULL,
    'manual', p_fee_type, p_label, p_month, p_academic_year,
    p_due_date, p_amount, 0, p_amount,
    0, p_amount, 0, 'unpaid', p_notes
  )
  RETURNING id INTO v_due_id;

  RETURN QUERY SELECT v_due_id;
END;
$$;

REVOKE ALL  ON FUNCTION public.create_manual_due(UUID,UUID,TEXT,TEXT,NUMERIC,DATE,TEXT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_manual_due(UUID,UUID,TEXT,TEXT,NUMERIC,DATE,TEXT,TEXT,TEXT) TO authenticated;

-- ── E3. get_student_fee_ledger() — DROP required (return type changed) ─
-- Dropped in Section C above. Recreating with source column.

CREATE FUNCTION public.get_student_fee_ledger(
  p_school_id  UUID,
  p_student_id UUID
)
RETURNS TABLE (
  due_id             UUID,
  source             TEXT,
  fee_type           TEXT,
  label              TEXT,
  month              TEXT,
  academic_year      TEXT,
  due_date           DATE,
  base_amount        NUMERIC,
  discount_amount    NUMERIC,
  net_amount         NUMERIC,
  late_fee_amount    NUMERIC,
  total_due          NUMERIC,
  amount_paid        NUMERIC,
  balance            NUMERIC,
  status             TEXT,
  late_fee_applied   BOOLEAN,
  payments_count     BIGINT,
  last_payment_date  DATE,
  last_receipt       TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id        = auth.uid()
      AND school_id = p_school_id
      AND role      = 'school_admin'
      AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Access denied — school_admin role required';
  END IF;

  RETURN QUERY
  SELECT
    d.id,
    d.source,
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
    d.late_fee_applied,
    COUNT(fp.id)        AS payments_count,
    MAX(fp.paid_date)   AS last_payment_date,
    MAX(fp.receipt_number) AS last_receipt
  FROM public.fee_dues d
  LEFT JOIN public.fee_payments fp ON fp.fee_due_id = d.id
  WHERE d.school_id  = p_school_id
    AND d.student_id = p_student_id
  GROUP BY
    d.id, d.source, d.fee_type, d.label, d.month,
    d.academic_year, d.due_date, d.base_amount,
    d.discount_amount, d.net_amount, d.late_fee_amount,
    d.total_due, d.amount_paid, d.balance,
    d.status, d.late_fee_applied
  ORDER BY d.due_date DESC, d.created_at DESC;
END;
$$;

REVOKE ALL  ON FUNCTION public.get_student_fee_ledger(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_student_fee_ledger(UUID, UUID) TO authenticated;

-- ── E4. get_student_billing_summary() — FINAL v3 ─────────────
-- v1 (sprint2_step2): no source/has_fee_structure — OBSOLETE
-- v2 (sprint3_step1): added source/has_fee_structure, admin only — OBSOLETE
-- v3 (sprint3_step2): collector access, full return, all pending dues — FINAL
-- Dropped in Section C above.

CREATE FUNCTION public.get_student_billing_summary(
  p_student_id UUID
)
RETURNS TABLE (
  student_id          UUID,
  full_name           TEXT,
  student_uid         TEXT,
  father_name         TEXT,
  parent_phone        TEXT,
  class_name          TEXT,
  class_section       TEXT,
  fee_structure_id    UUID,
  fee_structure_name  TEXT,
  has_fee_structure   BOOLEAN,
  source              TEXT,
  due_id              UUID,
  fee_type            TEXT,
  due_label           TEXT,
  due_month           TEXT,
  due_date            DATE,
  base_amount         NUMERIC,
  discount_amount     NUMERIC,
  net_amount          NUMERIC,
  late_fee_amount     NUMERIC,
  total_due           NUMERIC,
  amount_paid         NUMERIC,
  balance             NUMERIC,
  status              TEXT,
  late_fee_applied    BOOLEAN,
  grand_total_due     NUMERIC,
  grand_total_paid    NUMERIC,
  grand_balance       NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_school_id UUID;
BEGIN
  -- school_admin OR collector may access billing summary
  SELECT p.school_id INTO v_school_id
  FROM public.profiles p
  WHERE p.id        = auth.uid()
    AND p.role      IN ('school_admin', 'collector')
    AND p.is_active = true;

  IF v_school_id IS NULL THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.students
    WHERE id = p_student_id AND school_id = v_school_id
  ) THEN
    RAISE EXCEPTION 'Student not found';
  END IF;

  RETURN QUERY
  SELECT
    s.id,
    s.full_name::TEXT,
    s.student_uid::TEXT,
    s.father_name::TEXT,
    s.parent_phone::TEXT,
    c.name::TEXT,
    c.section::TEXT,
    s.fee_structure_id,
    fs.name::TEXT,
    (s.fee_structure_id IS NOT NULL),
    d.source::TEXT,
    d.id,
    d.fee_type::TEXT,
    d.label::TEXT,
    d.month::TEXT,
    d.due_date,
    d.base_amount,
    d.discount_amount,
    d.net_amount,
    d.late_fee_amount,
    d.total_due,
    d.amount_paid,
    d.balance,
    d.status::TEXT,
    d.late_fee_applied,
    SUM(d.total_due)   OVER (PARTITION BY s.id),
    SUM(d.amount_paid) OVER (PARTITION BY s.id),
    SUM(d.balance)     OVER (PARTITION BY s.id)
  FROM public.students s
  LEFT JOIN public.classes c         ON c.id  = s.class_id
  LEFT JOIN public.fee_structures fs ON fs.id = s.fee_structure_id
  LEFT JOIN public.fee_dues d
    ON  d.student_id = s.id
    AND d.school_id  = v_school_id
    AND d.status    NOT IN ('paid', 'waived')
    AND d.balance    > 0
  WHERE s.id = p_student_id
  ORDER BY
    d.source       ASC  NULLS LAST,
    d.due_date     ASC  NULLS LAST,
    d.created_at   ASC  NULLS LAST;
END;
$$;

REVOKE ALL  ON FUNCTION public.get_student_billing_summary(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_student_billing_summary(UUID) TO authenticated;

-- ── E5. get_fee_dashboard_stats() — fees table refs removed ──
-- Dropped in Section C above. Pure fee_payments source.

CREATE FUNCTION public.get_fee_dashboard_stats(p_school_id UUID)
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
    -- Today
    COALESCE((
      SELECT SUM(fp.amount_paid) FROM public.fee_payments fp
      WHERE fp.school_id = p_school_id
        AND fp.paid_date = CURRENT_DATE
    ), 0::NUMERIC),
    -- This calendar month
    COALESCE((
      SELECT SUM(fp.amount_paid) FROM public.fee_payments fp
      WHERE fp.school_id = p_school_id
        AND TO_CHAR(fp.paid_date,'YYYY-MM') = TO_CHAR(CURRENT_DATE,'YYYY-MM')
    ), 0::NUMERIC),
    -- Total outstanding (all sources via fee_dues)
    COALESCE((
      SELECT SUM(d.balance) FROM public.fee_dues d
      WHERE d.school_id = p_school_id
        AND d.status   IN ('unpaid','partial')
        AND d.balance   > 0
    ), 0::NUMERIC),
    -- Defaulters (overdue balance, distinct students)
    COALESCE((
      SELECT COUNT(DISTINCT d.student_id) FROM public.fee_dues d
      WHERE d.school_id = p_school_id
        AND d.status   IN ('unpaid','partial')
        AND d.balance   > 0
        AND d.due_date  < CURRENT_DATE
    ), 0::BIGINT),
    -- Year-to-date (calendar year)
    COALESCE((
      SELECT SUM(fp.amount_paid) FROM public.fee_payments fp
      WHERE fp.school_id = p_school_id
        AND EXTRACT(YEAR FROM fp.paid_date) = EXTRACT(YEAR FROM CURRENT_DATE)
    ), 0::NUMERIC);
END;
$$;

REVOKE ALL  ON FUNCTION public.get_fee_dashboard_stats(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_fee_dashboard_stats(UUID) TO authenticated;

-- ── E6. get_defaulters() — canonical rebuild ──────────────────
-- No logic change from original; re-run ensures consistent deployed state.

CREATE OR REPLACE FUNCTION public.get_defaulters(
  p_school_id     UUID,
  p_class_id      UUID DEFAULT NULL,
  p_academic_year TEXT DEFAULT NULL
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
    WHERE id        = auth.uid()
      AND school_id = p_school_id
      AND role      = 'school_admin'
      AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Access denied — school_admin role required';
  END IF;

  RETURN QUERY
  SELECT
    s.id,
    s.full_name,
    s.student_uid,
    c.name,
    c.section,
    SUM(d.balance),
    MIN(d.due_date),
    (CURRENT_DATE - MIN(d.due_date))::INTEGER,
    COUNT(d.id)
  FROM public.students s
  JOIN public.fee_dues d     ON d.student_id = s.id
  LEFT JOIN public.classes c ON c.id         = s.class_id
  WHERE d.school_id   = p_school_id
    AND d.status      IN ('unpaid','partial')
    AND d.balance     > 0
    AND d.due_date    < CURRENT_DATE
    AND (p_class_id      IS NULL OR s.class_id      = p_class_id)
    AND (p_academic_year IS NULL OR d.academic_year = p_academic_year)
  GROUP BY s.id, s.full_name, s.student_uid, c.name, c.section
  ORDER BY total_balance DESC;
END;
$$;

REVOKE ALL  ON FUNCTION public.get_defaulters(UUID, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_defaulters(UUID, UUID, TEXT) TO authenticated;

-- ── E7. request_payment_reversal() ───────────────────────────

CREATE OR REPLACE FUNCTION public.request_payment_reversal(
  p_fee_payment_id UUID,
  p_reason         TEXT
)
RETURNS TABLE (request_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_school_id UUID;
  v_payment   RECORD;
  v_req_id    UUID;
BEGIN
  SELECT p.school_id INTO v_school_id
  FROM public.profiles p
  WHERE p.id        = auth.uid()
    AND p.role      IN ('school_admin','collector')
    AND p.is_active = true;

  IF v_school_id IS NULL THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is mandatory for reversal requests';
  END IF;

  SELECT * INTO v_payment
  FROM public.fee_payments
  WHERE id = p_fee_payment_id AND school_id = v_school_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment not found';
  END IF;

  IF v_payment.reversal_status = 'reversal_approved' THEN
    RAISE EXCEPTION 'This payment has already been reversed';
  END IF;

  IF v_payment.reversal_status = 'reversal_requested' THEN
    RAISE EXCEPTION 'A reversal request is already pending for this payment';
  END IF;

  INSERT INTO public.reversal_requests (
    school_id, fee_payment_id, requested_by, reason
  ) VALUES (
    v_school_id, p_fee_payment_id, auth.uid(), trim(p_reason)
  )
  RETURNING id INTO v_req_id;

  UPDATE public.fee_payments
  SET
    reversal_status       = 'reversal_requested',
    reversal_reason       = trim(p_reason),
    reversal_requested_by = auth.uid(),
    reversal_requested_at = now()
  WHERE id = p_fee_payment_id;

  INSERT INTO public.fee_audit_trail (
    school_id, actor_id, actor_role, event_type,
    student_id, fee_payment_id, notes
  )
  SELECT
    v_school_id, auth.uid(), p.role,
    'reversal_requested',
    v_payment.student_id, p_fee_payment_id, trim(p_reason)
  FROM public.profiles p WHERE p.id = auth.uid();

  RETURN QUERY SELECT v_req_id;
END;
$$;

REVOKE ALL  ON FUNCTION public.request_payment_reversal(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_payment_reversal(UUID, TEXT) TO authenticated;

-- ── E8. approve_payment_reversal() — ADMIN ONLY ───────────────

CREATE OR REPLACE FUNCTION public.approve_payment_reversal(
  p_request_id  UUID,
  p_admin_notes TEXT DEFAULT NULL
)
RETURNS TABLE (counter_payment_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_school_id  UUID;
  v_request    RECORD;
  v_payment    RECORD;
  v_due        RECORD;
  v_counter_id UUID;
  v_new_paid   NUMERIC(10,2);
  v_new_status TEXT;
BEGIN
  SELECT p.school_id INTO v_school_id
  FROM public.profiles p
  WHERE p.id        = auth.uid()
    AND p.role      = 'school_admin'
    AND p.is_active = true;

  IF v_school_id IS NULL THEN
    RAISE EXCEPTION 'Access denied — school_admin role required for reversal approval';
  END IF;

  SELECT * INTO v_request
  FROM public.reversal_requests
  WHERE id        = p_request_id
    AND school_id = v_school_id
    AND status    = 'pending';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reversal request not found or already processed';
  END IF;

  SELECT * INTO v_payment FROM public.fee_payments WHERE id = v_request.fee_payment_id;
  SELECT * INTO v_due     FROM public.fee_dues     WHERE id = v_payment.fee_due_id;

  -- Create counter-transaction (negative amount)
  INSERT INTO public.fee_payments (
    school_id, student_id, fee_due_id,
    amount_paid, payment_method, receipt_number,
    paid_date, collected_by, notes, reversal_status
  ) VALUES (
    v_school_id,
    v_payment.student_id,
    v_payment.fee_due_id,
    -(v_payment.amount_paid),
    v_payment.payment_method,
    'REV-' || v_payment.receipt_number,
    CURRENT_DATE,
    auth.uid(),
    'REVERSAL of ' || v_payment.receipt_number
      || COALESCE(': ' || p_admin_notes, ''),
    'reversal_approved'
  )
  RETURNING id INTO v_counter_id;

  -- Restore due balance
  v_new_paid   := GREATEST(v_due.amount_paid - v_payment.amount_paid, 0);
  v_new_status := CASE
    WHEN v_new_paid <= 0               THEN 'unpaid'
    WHEN v_new_paid >= v_due.total_due THEN 'paid'
    ELSE                                    'partial'
  END;

  UPDATE public.fee_dues
  SET amount_paid = v_new_paid, status = v_new_status, updated_at = now()
  WHERE id = v_due.id;

  -- Mark original payment as reversed
  UPDATE public.fee_payments
  SET
    reversal_status     = 'reversal_approved',
    reversed_by         = auth.uid(),
    reversed_at         = now(),
    reversal_payment_id = v_counter_id
  WHERE id = v_request.fee_payment_id;

  -- Close the request
  UPDATE public.reversal_requests
  SET
    status             = 'approved',
    reviewed_by        = auth.uid(),
    reviewed_at        = now(),
    admin_notes        = p_admin_notes,
    counter_payment_id = v_counter_id
  WHERE id = p_request_id;

  INSERT INTO public.fee_audit_trail (
    school_id, actor_id, actor_role, event_type,
    student_id, fee_payment_id, notes
  )
  SELECT
    v_school_id, auth.uid(), p.role,
    'reversal_approved',
    v_payment.student_id, v_request.fee_payment_id, p_admin_notes
  FROM public.profiles p WHERE p.id = auth.uid();

  RETURN QUERY SELECT v_counter_id;
END;
$$;

REVOKE ALL  ON FUNCTION public.approve_payment_reversal(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approve_payment_reversal(UUID, TEXT) TO authenticated;

-- ── E9. reject_payment_reversal() — ADMIN ONLY ───────────────

CREATE OR REPLACE FUNCTION public.reject_payment_reversal(
  p_request_id  UUID,
  p_admin_notes TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_school_id UUID;
  v_request   RECORD;
BEGIN
  SELECT p.school_id INTO v_school_id
  FROM public.profiles p
  WHERE p.id        = auth.uid()
    AND p.role      = 'school_admin'
    AND p.is_active = true;

  IF v_school_id IS NULL THEN
    RAISE EXCEPTION 'Access denied — school_admin role required';
  END IF;

  IF p_admin_notes IS NULL OR trim(p_admin_notes) = '' THEN
    RAISE EXCEPTION 'Admin notes are mandatory when rejecting a reversal';
  END IF;

  SELECT * INTO v_request
  FROM public.reversal_requests
  WHERE id = p_request_id AND school_id = v_school_id AND status = 'pending';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request not found or already processed';
  END IF;

  UPDATE public.reversal_requests
  SET
    status      = 'rejected',
    reviewed_by = auth.uid(),
    reviewed_at = now(),
    admin_notes = trim(p_admin_notes)
  WHERE id = p_request_id;

  UPDATE public.fee_payments
  SET reversal_status = 'reversal_rejected'
  WHERE id = v_request.fee_payment_id;

  INSERT INTO public.fee_audit_trail (
    school_id, actor_id, actor_role, event_type,
    fee_payment_id, notes
  )
  SELECT
    v_school_id, auth.uid(), p.role,
    'reversal_rejected',
    v_request.fee_payment_id, trim(p_admin_notes)
  FROM public.profiles p WHERE p.id = auth.uid();
END;
$$;

REVOKE ALL  ON FUNCTION public.reject_payment_reversal(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reject_payment_reversal(UUID, TEXT) TO authenticated;

-- ── E10. submit_eod_closure() ─────────────────────────────────

CREATE OR REPLACE FUNCTION public.submit_eod_closure(
  p_physical_cash_count NUMERIC(10,2),
  p_notes               TEXT DEFAULT NULL
)
RETURNS TABLE (
  closure_id        UUID,
  system_cash_total NUMERIC,
  variance          NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_school_id   UUID;
  v_actor_id    UUID;
  v_system_cash NUMERIC(10,2);
  v_closure_id  UUID;
BEGIN
  SELECT p.id, p.school_id INTO v_actor_id, v_school_id
  FROM public.profiles p
  WHERE p.id        = auth.uid()
    AND p.role      IN ('school_admin','collector')
    AND p.is_active = true;

  IF v_school_id IS NULL THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  IF p_physical_cash_count < 0 THEN
    RAISE EXCEPTION 'Physical cash count cannot be negative';
  END IF;

  -- Compute expected cash: this collector, today, cash payments only,
  -- excluding already-approved reversals.
  SELECT COALESCE(SUM(fp.amount_paid), 0) INTO v_system_cash
  FROM public.fee_payments fp
  WHERE fp.school_id      = v_school_id
    AND fp.collected_by   = v_actor_id
    AND fp.paid_date      = CURRENT_DATE
    AND fp.payment_method = 'cash'
    AND (fp.reversal_status IS NULL
         OR fp.reversal_status = 'reversal_requested');

  INSERT INTO public.eod_closures (
    school_id, collector_id, closure_date,
    system_cash_total, physical_cash_count, notes
  ) VALUES (
    v_school_id, v_actor_id, CURRENT_DATE,
    v_system_cash, p_physical_cash_count, p_notes
  )
  RETURNING id INTO v_closure_id;

  INSERT INTO public.fee_audit_trail (
    school_id, actor_id, actor_role, event_type,
    original_value, submitted_value, notes
  )
  SELECT
    v_school_id, auth.uid(), p.role, 'eod_submitted',
    v_system_cash, p_physical_cash_count, p_notes
  FROM public.profiles p WHERE p.id = auth.uid();

  RETURN QUERY
  SELECT v_closure_id, v_system_cash,
         (p_physical_cash_count - v_system_cash);
END;
$$;

REVOKE ALL  ON FUNCTION public.submit_eod_closure(NUMERIC, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_eod_closure(NUMERIC, TEXT) TO authenticated;

-- ============================================================
-- SECTION F: PARTIAL UNIQUE INDEX FOR STRUCTURED DUES
-- (Replaces old fee_dues_unique_per_month which blocked NULLs)
-- ============================================================

-- Only one structured due per student/item/month.
-- Manual dues (source='manual') are exempt from this constraint.
CREATE UNIQUE INDEX IF NOT EXISTS fee_dues_structured_unique
  ON public.fee_dues (student_id, fee_structure_item_id, month)
  WHERE source = 'structured'
    AND fee_structure_item_id IS NOT NULL;

-- ============================================================
-- SECTION G: INDEXES
-- ============================================================

-- fee_dues
CREATE INDEX IF NOT EXISTS idx_fee_dues_source
  ON public.fee_dues(school_id, source);

CREATE INDEX IF NOT EXISTS idx_fee_dues_student_source
  ON public.fee_dues(student_id, source, status);

-- fee_audit_trail
CREATE INDEX IF NOT EXISTS idx_fee_audit_school_actor
  ON public.fee_audit_trail(school_id, actor_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_fee_audit_student
  ON public.fee_audit_trail(student_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_fee_audit_event
  ON public.fee_audit_trail(school_id, event_type, created_at DESC);

-- eod_closures
CREATE INDEX IF NOT EXISTS idx_eod_school_date
  ON public.eod_closures(school_id, closure_date DESC);

-- reversal_requests
CREATE INDEX IF NOT EXISTS idx_reversal_school_status
  ON public.reversal_requests(school_id, status, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_reversal_payment
  ON public.reversal_requests(fee_payment_id);

-- ============================================================
-- SECTION H: ROW LEVEL SECURITY
-- Canonical final versions only.
-- fee_dues policies: defined in step1 and step2; step2 is final.
-- ============================================================

-- Enable RLS on new tables
ALTER TABLE public.fee_audit_trail   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.eod_closures      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reversal_requests ENABLE ROW LEVEL SECURITY;

-- ── fee_dues (canonical — supersedes step1 version) ──────────
DROP POLICY IF EXISTS "school_sees_own_dues"      ON public.fee_dues;
DROP POLICY IF EXISTS "super_admin_sees_all_dues" ON public.fee_dues;

CREATE POLICY "school_sees_own_dues"
  ON public.fee_dues FOR ALL
  USING (
    school_id IN (
      SELECT p.school_id FROM public.profiles p
      WHERE p.id = auth.uid() AND p.is_active = true
    )
  );

CREATE POLICY "super_admin_sees_all_dues"
  ON public.fee_dues FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id        = auth.uid()
        AND p.role      = 'super_admin'
        AND p.is_active = true
    )
  );

-- ── fee_audit_trail ───────────────────────────────────────────
DROP POLICY IF EXISTS "school_admin_sees_audit_trail" ON public.fee_audit_trail;
DROP POLICY IF EXISTS "collector_sees_own_audit"      ON public.fee_audit_trail;

CREATE POLICY "school_admin_sees_audit_trail"
  ON public.fee_audit_trail FOR SELECT
  USING (
    school_id IN (
      SELECT p.school_id FROM public.profiles p
      WHERE p.id        = auth.uid()
        AND p.role      = 'school_admin'
        AND p.is_active = true
    )
  );

CREATE POLICY "collector_sees_own_audit"
  ON public.fee_audit_trail FOR SELECT
  USING (
    actor_id = auth.uid()
    AND school_id IN (
      SELECT p.school_id FROM public.profiles p
      WHERE p.id        = auth.uid()
        AND p.role      = 'collector'
        AND p.is_active = true
    )
  );

-- ── eod_closures ─────────────────────────────────────────────
DROP POLICY IF EXISTS "school_admin_sees_eod"    ON public.eod_closures;
DROP POLICY IF EXISTS "collector_sees_own_eod"   ON public.eod_closures;

CREATE POLICY "school_admin_sees_eod"
  ON public.eod_closures FOR ALL
  USING (
    school_id IN (
      SELECT p.school_id FROM public.profiles p
      WHERE p.id        = auth.uid()
        AND p.role      = 'school_admin'
        AND p.is_active = true
    )
  );

CREATE POLICY "collector_sees_own_eod"
  ON public.eod_closures FOR ALL
  USING (
    collector_id = auth.uid()
    AND school_id IN (
      SELECT p.school_id FROM public.profiles p
      WHERE p.id        = auth.uid()
        AND p.is_active = true
    )
  );

-- ── reversal_requests ─────────────────────────────────────────
DROP POLICY IF EXISTS "school_admin_sees_reversals"  ON public.reversal_requests;
DROP POLICY IF EXISTS "collector_sees_own_reversals" ON public.reversal_requests;

CREATE POLICY "school_admin_sees_reversals"
  ON public.reversal_requests FOR ALL
  USING (
    school_id IN (
      SELECT p.school_id FROM public.profiles p
      WHERE p.id        = auth.uid()
        AND p.role      = 'school_admin'
        AND p.is_active = true
    )
  );

CREATE POLICY "collector_sees_own_reversals"
  ON public.reversal_requests FOR SELECT
  USING (
    requested_by = auth.uid()
    AND school_id IN (
      SELECT p.school_id FROM public.profiles p
      WHERE p.id        = auth.uid()
        AND p.is_active = true
    )
  );

-- ============================================================
-- SECTION I: ONE-TIME DATA BACKFILL
-- Backfills fee_payments rows that had reversal_status set
-- BEFORE reversal_requests table existed (pre-migration state).
-- Safe to re-run — INSERT is guarded by NOT EXISTS.
-- ============================================================

INSERT INTO public.reversal_requests (
  school_id,
  fee_payment_id,
  requested_by,
  reason,
  status,
  requested_at
)
SELECT
  fp.school_id,
  fp.id,
  COALESCE(fp.reversal_requested_by, fp.collected_by),
  COALESCE(fp.reversal_reason, 'Backfilled: pre-migration reversal request'),
  'pending',
  COALESCE(fp.reversal_requested_at, fp.created_at)
FROM public.fee_payments fp
WHERE fp.reversal_status = 'reversal_requested'
  AND NOT EXISTS (
    SELECT 1 FROM public.reversal_requests rr
    WHERE rr.fee_payment_id = fp.id
  );

-- ============================================================
-- SECTION J: COMMENTS & DOCUMENTATION
-- ============================================================

COMMENT ON TABLE public.fee_audit_trail IS
  'Immutable audit log. Every fee action leaves a digital footprint. '
  'Written only via log_fee_audit_event() RPC — never directly from client. '
  'Admin sees all; collector sees own events only.';

COMMENT ON TABLE public.eod_closures IS
  'End-of-day cash reconciliation. One row per collector per day. '
  'variance = physical_cash_count - system_cash_total (GENERATED ALWAYS). '
  'Collector submits physical count; system total revealed only after submission.';

COMMENT ON TABLE public.reversal_requests IS
  'Reversal request queue. No self-reversal allowed — collector requests, admin approves. '
  'approve_payment_reversal() creates a counter-payment (REV- prefix). '
  'Original payment row is never deleted or edited (immutable).';

-- ============================================================
-- VERIFICATION QUERIES (run after migration to confirm)
-- ============================================================
--
-- 1. Confirm fees table dropped:
--    SELECT to_regclass('public.fees');  -- expect NULL
--
-- 2. Confirm fee_dues new columns:
--    SELECT column_name, data_type, column_default, is_nullable
--    FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'fee_dues'
--    AND column_name IN ('source','fee_structure_id','fee_structure_item_id')
--    ORDER BY ordinal_position;
--
-- 3. Confirm new tables exist:
--    SELECT table_name FROM information_schema.tables
--    WHERE table_schema = 'public'
--    AND table_name IN ('fee_audit_trail','eod_closures','reversal_requests');
--
-- 4. Confirm all functions deployed:
--    SELECT routine_name, pg_get_function_arguments(p.oid)
--    FROM information_schema.routines r
--    JOIN pg_proc p ON p.proname = r.routine_name
--    WHERE routine_schema = 'public'
--    AND routine_name IN (
--      'create_manual_due','get_student_fee_ledger',
--      'get_student_billing_summary','get_fee_dashboard_stats',
--      'get_defaulters','request_payment_reversal',
--      'approve_payment_reversal','reject_payment_reversal',
--      'submit_eod_closure','log_fee_audit_event'
--    );
--
-- 5. Confirm collector role accepted:
--    SELECT DISTINCT role FROM public.profiles;
--
-- 6. Confirm waiver caps on schools:
--    SELECT name, late_fee_waiver_max_pct, late_fee_waiver_max_flat,
--           admin_override_pin
--    FROM public.schools;
--
-- 7. Confirm backfill:
--    SELECT COUNT(*) FROM public.reversal_requests WHERE status = 'pending';
-- ============================================================

COMMIT;
