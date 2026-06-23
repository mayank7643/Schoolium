-- ============================================================
-- SCHOOLIUM FEE MODULE — PART 1 of 3
-- TABLES + INDEXES + TRIGGERS
-- Run this first. Wait for "Success" before running Part 2.
-- Safe: creates new tables only, touches nothing existing.
-- ============================================================

-- ============================================================
-- SCHOOLIUM — FEE MANAGEMENT MODULE
-- File: 20260622_fee_management_module.sql
-- Branch: preview
-- Run ONCE in Supabase SQL Editor on PREVIEW project only
-- Production stays untouched until module is complete
-- ============================================================
--
-- TABLES CREATED:
--   1. fee_structures      — fee template per class, school controls everything
--   2. fee_structure_items — individual fee line items per structure (flexible)
--   3. fee_discounts       — per-student discounts / scholarships
--   4. fee_dues            — auto-generated monthly dues per student
--   5. fee_payments        — actual payments against dues (supports partial)
--
-- EXISTING TABLES:
--   fees                   — UNTOUCHED. Manual billing stays fully intact.
--
-- ============================================================


-- ============================================================
-- TABLE 1: fee_structures
-- One per class per academic year. School admin controls
-- everything — which fees are monthly, which are one-time,
-- whether late fee applies, how much, grace period.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.fee_structures (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id             UUID        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  class_id              UUID        REFERENCES public.classes(id) ON DELETE SET NULL,
  name                  TEXT        NOT NULL,                        -- e.g. "Class 8 - 2025-26"
  academic_year         TEXT        NOT NULL,                        -- e.g. "2025-26"
  year_start_month      INTEGER     NOT NULL DEFAULT 4,              -- 4 = April (school can change)
  year_end_month        INTEGER     NOT NULL DEFAULT 3,              -- 3 = March next year

  -- Late fee config — entirely optional, school decides
  late_fee_enabled      BOOLEAN     NOT NULL DEFAULT false,
  late_fee_type         TEXT        CHECK (late_fee_type IN ('fixed', 'percentage')),
  late_fee_value        NUMERIC(10,2) DEFAULT 0,                     -- ₹ amount or % value
  late_fee_grace_days   INTEGER     DEFAULT 10,                      -- days after due before late fee kicks in

  -- Due date config
  due_day_of_month      INTEGER     NOT NULL DEFAULT 10              -- dues generated with due date = 10th of month
                        CHECK (due_day_of_month BETWEEN 1 AND 28),

  is_active             BOOLEAN     NOT NULL DEFAULT true,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- TABLE 2: fee_structure_items
-- Individual fee line items inside a structure.
-- School admin controls: amount, frequency (monthly/one-time/custom),
-- which months it applies to, and whether it's enabled.
-- This is the key to full admin control.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.fee_structure_items (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id             UUID        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  fee_structure_id      UUID        NOT NULL REFERENCES public.fee_structures(id) ON DELETE CASCADE,

  -- Fee definition
  fee_type              TEXT        NOT NULL,                        -- 'tuition','admission','exam','transport','hostel','custom'
  label                 TEXT        NOT NULL,                        -- e.g. "Tuition Fee", "Lab Fee", "Sports Fee"
  amount                NUMERIC(10,2) NOT NULL CHECK (amount >= 0),

  -- Frequency — school admin decides per line item
  frequency             TEXT        NOT NULL DEFAULT 'monthly'
                        CHECK (frequency IN ('monthly', 'one_time', 'quarterly', 'custom')),

  -- For 'custom' frequency: which months (YYYY-MM array)
  -- e.g. ['2025-06', '2025-10', '2026-01'] for term fees
  applicable_months     TEXT[],

  -- For 'quarterly': which months of year (1-12)
  -- e.g. [4,7,10,1] for April, July, October, January
  quarterly_months      INTEGER[],

  is_enabled            BOOLEAN     NOT NULL DEFAULT true,
  sort_order            INTEGER     NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- TABLE 3: fee_discounts
-- Per-student discounts and scholarships.
-- Can apply to all fees or a specific fee_type.
-- Can be percentage or fixed amount.
-- Can have validity period.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.fee_discounts (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id             UUID        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  student_id            UUID        NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,

  label                 TEXT        NOT NULL,                        -- e.g. "Merit Scholarship", "Sibling Discount"
  discount_type         TEXT        NOT NULL
                        CHECK (discount_type IN ('percentage', 'fixed')),
  value                 NUMERIC(10,2) NOT NULL CHECK (value > 0),   -- % or ₹

  -- Which fee types this applies to — NULL means ALL fee types
  applies_to_fee_type   TEXT,                                        -- NULL = all, or 'tuition','transport' etc.

  -- Optional validity window
  valid_from            DATE,
  valid_until           DATE,

  is_active             BOOLEAN     NOT NULL DEFAULT true,
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- TABLE 4: fee_dues
-- Auto-generated dues — one row per student per fee item per month.
-- Generated by generate_fee_dues() function below.
-- Staff never creates these manually — they are auto-generated.
-- Late fee is computed and stored here when applied.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.fee_dues (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id             UUID        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  student_id            UUID        NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  fee_structure_id      UUID        NOT NULL REFERENCES public.fee_structures(id) ON DELETE CASCADE,
  fee_structure_item_id UUID        NOT NULL REFERENCES public.fee_structure_items(id) ON DELETE CASCADE,

  fee_type              TEXT        NOT NULL,
  label                 TEXT        NOT NULL,                        -- copied from item at generation time
  month                 TEXT        NOT NULL,                        -- 'YYYY-MM' e.g. '2025-06'
  academic_year         TEXT        NOT NULL,                        -- '2025-26'
  due_date              DATE        NOT NULL,

  -- Amounts
  base_amount           NUMERIC(10,2) NOT NULL,                      -- from fee_structure_item
  discount_amount       NUMERIC(10,2) NOT NULL DEFAULT 0,            -- computed from fee_discounts
  net_amount            NUMERIC(10,2) NOT NULL,                      -- base - discount
  late_fee_amount       NUMERIC(10,2) NOT NULL DEFAULT 0,            -- applied when overdue
  total_due             NUMERIC(10,2) NOT NULL,                      -- net + late_fee (computed at generation, refreshed on late fee apply)

  -- Payment tracking
  amount_paid           NUMERIC(10,2) NOT NULL DEFAULT 0,            -- sum of fee_payments.amount_paid
  balance               NUMERIC(10,2) GENERATED ALWAYS AS (total_due - amount_paid) STORED,

  status                TEXT        NOT NULL DEFAULT 'unpaid'
                        CHECK (status IN ('unpaid', 'partial', 'paid', 'waived')),

  late_fee_applied      BOOLEAN     NOT NULL DEFAULT false,
  waiver_reason         TEXT,                                        -- if waived, why
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Dedup guard: one due per student per item per month
  UNIQUE (student_id, fee_structure_item_id, month)
);

-- ============================================================
-- TABLE 5: fee_payments
-- Actual money collected. Many payments can exist per due
-- (supports partial payment, advance, multiple installments).
-- This is what generates receipts.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.fee_payments (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id             UUID        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  student_id            UUID        NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  fee_due_id            UUID        NOT NULL REFERENCES public.fee_dues(id) ON DELETE CASCADE,

  amount_paid           NUMERIC(10,2) NOT NULL CHECK (amount_paid > 0),
  payment_method        TEXT        NOT NULL DEFAULT 'cash'
                        CHECK (payment_method IN ('cash', 'upi', 'bank_transfer', 'online', 'cheque', 'other')),
  receipt_number        TEXT        UNIQUE,
  paid_date             DATE        NOT NULL DEFAULT CURRENT_DATE,
  collected_by          UUID        REFERENCES public.profiles(id) ON DELETE SET NULL,  -- which staff collected
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ============================================================
-- INDEXES — performance for common queries
-- ============================================================

-- fee_structures
CREATE INDEX IF NOT EXISTS idx_fee_structures_school       ON public.fee_structures(school_id);
CREATE INDEX IF NOT EXISTS idx_fee_structures_class        ON public.fee_structures(class_id);
CREATE INDEX IF NOT EXISTS idx_fee_structures_school_year  ON public.fee_structures(school_id, academic_year);

-- fee_structure_items
CREATE INDEX IF NOT EXISTS idx_fee_items_structure         ON public.fee_structure_items(fee_structure_id);
CREATE INDEX IF NOT EXISTS idx_fee_items_school            ON public.fee_structure_items(school_id);

-- fee_discounts
CREATE INDEX IF NOT EXISTS idx_fee_discounts_student       ON public.fee_discounts(student_id);
CREATE INDEX IF NOT EXISTS idx_fee_discounts_school        ON public.fee_discounts(school_id);

-- fee_dues
CREATE INDEX IF NOT EXISTS idx_fee_dues_student            ON public.fee_dues(student_id);
CREATE INDEX IF NOT EXISTS idx_fee_dues_school             ON public.fee_dues(school_id);
CREATE INDEX IF NOT EXISTS idx_fee_dues_school_month       ON public.fee_dues(school_id, month);
CREATE INDEX IF NOT EXISTS idx_fee_dues_status             ON public.fee_dues(school_id, status);
CREATE INDEX IF NOT EXISTS idx_fee_dues_structure          ON public.fee_dues(fee_structure_id);
-- Defaulter query index: unpaid dues with due_date in past
CREATE INDEX IF NOT EXISTS idx_fee_dues_defaulters         ON public.fee_dues(school_id, status, due_date)
  WHERE status IN ('unpaid', 'partial');

-- fee_payments
CREATE INDEX IF NOT EXISTS idx_fee_payments_due            ON public.fee_payments(fee_due_id);
CREATE INDEX IF NOT EXISTS idx_fee_payments_student        ON public.fee_payments(student_id);
CREATE INDEX IF NOT EXISTS idx_fee_payments_school         ON public.fee_payments(school_id);
CREATE INDEX IF NOT EXISTS idx_fee_payments_date           ON public.fee_payments(school_id, paid_date);


-- ============================================================
-- TRIGGERS — updated_at auto-maintenance
-- ============================================================

-- Reuse set_updated_at() function already created in WA migration.
-- If running fresh, create it here:
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER fee_structures_updated_at
  BEFORE UPDATE ON public.fee_structures
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER fee_discounts_updated_at
  BEFORE UPDATE ON public.fee_discounts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER fee_dues_updated_at
  BEFORE UPDATE ON public.fee_dues
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
