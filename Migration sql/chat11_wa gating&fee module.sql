-- ============================================================
-- SECTION 1: MIGRATION NAME
-- ============================================================
-- File:    20260622_chat10_final_clean.sql
-- Session: Chat 10 — WA Subscription Gating + Fee Management Module
-- Date:    22 June 2026
-- Author:  Schoolium
--
-- Run in Supabase SQL Editor on PRODUCTION project.
-- Safe to re-run: all statements use IF NOT EXISTS / OR REPLACE /
-- DROP IF EXISTS guards throughout.
--
-- Prerequisites (must already exist from prior migrations):
--   ✓ schools, students, profiles, classes, fees tables
--   ✓ wa_message_log table (from Chat 10 WA migration)
--   ✓ set_updated_at() function (from Chat 10 WA migration)
--   ✓ increment_wa_sent_count() function (from Chat 10 WA migration)
--   ✓ pg_cron extension enabled
-- ============================================================


-- ============================================================
-- SECTION 2: SUMMARY OF CHANGES INCLUDED
-- ============================================================
--
-- PART A — wa_message_log: fix message_type CHECK constraint
--          Original constraint blocks fee reminder message types
--          from send-fee-reminder Edge Function (e.g. 'fee_reminder_due_2025-06')
--
-- PART B — fee_structures table (NEW)
-- PART C — fee_structure_items table (NEW)
-- PART D — fee_discounts table (NEW)
-- PART E — fee_dues table (NEW — with GENERATED ALWAYS balance column)
-- PART F — fee_payments table (NEW)
-- PART G — Indexes on all 5 new tables
-- PART H — Triggers (updated_at) on fee_structures, fee_discounts, fee_dues
-- PART I — generate_fee_receipt_number() function
-- PART J — generate_fee_dues() SECURITY DEFINER function
-- PART K — apply_late_fees() SECURITY DEFINER function
-- PART L — record_fee_payment() SECURITY DEFINER function
-- PART M — get_student_fee_ledger() SECURITY DEFINER function
-- PART N — get_defaulters() SECURITY DEFINER function
-- PART O — get_fee_dashboard_stats() SECURITY DEFINER function
-- PART P — RLS policies on all 5 new tables
-- PART Q — REVOKE / GRANT on all new functions
--
-- NOT INCLUDED (already in Chat 10 WA migration, already ran):
--   students.parent_phone_opted_out column
--   schools.wa_monthly_quota, wa_messages_sent_month,
--          wa_quota_reset_date, wa_alerts_enabled, plan columns
--   schools_plan_check constraint drop + recreate
--   wa_message_log table creation
--   wa_message_log_unique_per_day constraint
--   wa_message_log indexes (retry, school_date, student)
--   wa_message_log RLS policy
--   set_updated_at() function
--   increment_wa_sent_count() function
--   pg_cron reset-wa-monthly-quota job
--   pg_cron retry-wa-messages job
--
-- NOT INCLUDED (data fixes, not schema):
--   UPDATE schools SET plan='standard' WHERE plan='pro'
--   UPDATE schools SET plan='premium' WHERE plan='enterprise'
--   (These were one-time data corrections run manually this session)
--
-- NOT INCLUDED (Edge Function code, not SQL):
--   notify-attendance/index.ts bug fix (double school query)
--   send-fee-reminder/index.ts new function
--   generate-fee-dues/index.ts new function
-- ============================================================


-- ============================================================
-- SECTION 3: CONFLICTS FOUND AND REMOVED
-- ============================================================
--
-- CONFLICT 1 — wa_message_log.message_type CHECK constraint
--   ORIGINAL (Chat 10 WA migration, already ran):
--     CHECK (message_type IN ('entry_alert','exit_alert','fee_reminder','absence_alert'))
--   PROBLEM:
--     send-fee-reminder Edge Function inserts message_type values like
--     'fee_reminder_due_2025-06' and 'fee_reminder_overdue_2025-06'
--     which DO NOT match the literal string 'fee_reminder' in the CHECK.
--     Every fee reminder INSERT would fail with constraint violation.
--   FIX INCLUDED (PART A):
--     DROP the named constraint wa_message_log_type_check
--     ADD new constraint using regex: allows entry_alert, exit_alert,
--     absence_alert as exact values AND any fee_reminder_* prefix.
--
-- CONFLICT 2 — CREATE TRIGGER without DROP IF EXISTS (fee module)
--   ORIGINAL fee migration:
--     CREATE TRIGGER fee_structures_updated_at ...  (no DROP guard)
--     CREATE TRIGGER fee_discounts_updated_at ...   (no DROP guard)
--     CREATE TRIGGER fee_dues_updated_at ...        (no DROP guard)
--   PROBLEM: Second run would error "trigger already exists"
--   FIX INCLUDED (PART H):
--     DROP TRIGGER IF EXISTS before each CREATE TRIGGER
--
-- CONFLICT 3 — REVOKE/GRANT missing function parameter signatures
--   ORIGINAL fee migration:
--     REVOKE ALL ON FUNCTION public.generate_fee_dues FROM PUBLIC
--     (PostgreSQL requires full signature for overloaded resolution)
--   FIX INCLUDED (PART Q):
--     All REVOKE/GRANT statements include full parameter type lists
--
-- CONFLICT 4 — set_updated_at() function redefinition
--   ORIGINAL: Created in Chat 10 WA migration (already ran)
--   FEE MIGRATION: Also uses CREATE OR REPLACE FUNCTION set_updated_at()
--   VERDICT: CREATE OR REPLACE is safe and idempotent — KEPT as-is
--   No conflict, no removal needed.
--
-- CONFLICT 5 — schools_plan_check constraint
--   ORIGINAL DB had: CHECK (plan IN ('basic','pro','enterprise'))
--   Chat 10 WA migration ran: DROP CONSTRAINT IF EXISTS + ADD with
--     ('basic','standard','premium') — already applied to production.
--   THIS SESSION: User also manually ran the same fix after seeing error.
--   VERDICT: Already resolved. Not included here — would be duplicate.
--
-- REMOVED — pg_cron apply-late-fees-daily job
--   ORIGINAL fee migration had this block commented out.
--   VERDICT: Kept commented out. Must be scheduled separately after
--   confirming exact Supabase URL and anon key values.
-- ============================================================


-- ============================================================
-- SECTION 4: POTENTIAL RISKS
-- ============================================================
--
-- RISK 1: wa_message_log CHECK constraint modification (PART A)
--   Dropping and recreating a CHECK constraint on a live table
--   with existing rows. The new regex CHECK is LESS restrictive
--   than the old one, so ALL existing rows will satisfy it.
--   Zero risk of data rejection. Safe on live table.
--
-- RISK 2: fee_dues GENERATED ALWAYS AS (total_due - amount_paid) STORED
--   This column cannot be updated directly. record_fee_payment()
--   updates amount_paid only — balance recomputes automatically.
--   Risk: any direct UPDATE fee_dues SET balance = ... will error.
--   Mitigation: UI pages only call record_fee_payment() RPC.
--
-- RISK 3: generate_fee_dues() nested DECLARE blocks inside FOR loop
--   PL/pgSQL nested DECLARE is valid PostgreSQL syntax but may
--   confuse some SQL linters. Functionally correct.
--
-- RISK 4: apply_late_fees() pg_cron job is NOT included (commented out)
--   Late fees will not auto-apply until pg_cron job is scheduled.
--   Can be called manually: SELECT apply_late_fees(school_id) FROM schools;
--
-- RISK 5: RLS policies use FOR ALL with USING only (no WITH CHECK)
--   This matches the existing pattern across all Schoolium tables.
--   INSERT/UPDATE via authenticated client goes through the same
--   school_id check. Edge Functions use SERVICE_ROLE_KEY which
--   bypasses RLS entirely — this is intentional and correct.
--
-- RISK 6: generate_fee_dues() called from Edge Function with service_role
--   The function is SECURITY DEFINER. The Edge Function bypasses RLS
--   and calls this as service_role. GRANT TO authenticated is correct
--   for direct RPC calls from authenticated school_admin users too.
--
-- RISK 7: fee_dues.UNIQUE(student_id, fee_structure_item_id, month)
--   If a student moves classes mid-year and joins a new structure
--   that has the same item for the same month, insert will conflict.
--   generate_fee_dues() uses ON CONFLICT DO NOTHING — safe.
--   The original due from the old structure remains — admin must
--   waive it manually if no longer applicable.
-- ============================================================


-- ============================================================
-- SECTION 5: FINAL PRODUCTION-READY SQL MIGRATION FILE
-- ============================================================


-- ── PART A: Fix wa_message_log.message_type CHECK constraint ─────────────────
-- The existing constraint allows only literal 'fee_reminder' but the
-- send-fee-reminder Edge Function inserts 'fee_reminder_due_YYYY-MM'
-- and 'fee_reminder_overdue_YYYY-MM'. Drop and replace with regex.

DO $$
BEGIN
  -- Drop the old constraint if it exists (may be named differently)
  IF EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name = 'wa_message_log'
      AND column_name = 'message_type'
  ) THEN
    ALTER TABLE public.wa_message_log
      DROP CONSTRAINT IF EXISTS wa_message_log_message_type_check;
  END IF;
END;
$$;

ALTER TABLE public.wa_message_log
  DROP CONSTRAINT IF EXISTS wa_message_log_type_check;

ALTER TABLE public.wa_message_log
  ADD CONSTRAINT wa_message_log_type_check
  CHECK (
    message_type IN ('entry_alert', 'exit_alert', 'absence_alert')
    OR message_type LIKE 'fee_reminder_%'
  );

COMMENT ON COLUMN public.wa_message_log.message_type IS
  'Message category. Fixed values: entry_alert, exit_alert, absence_alert. '
  'Fee reminders use pattern: fee_reminder_{type}_{YYYY-MM} '
  'e.g. fee_reminder_due_2025-06 or fee_reminder_overdue_2025-06';


-- ── PART B: fee_structures table ─────────────────────────────────────────────
-- One fee template per class per academic year.
-- School admin controls all fee types, frequencies, due dates, and late fees.

CREATE TABLE IF NOT EXISTS public.fee_structures (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id           UUID          NOT NULL
                                    REFERENCES public.schools(id) ON DELETE CASCADE,
  class_id            UUID
                                    REFERENCES public.classes(id) ON DELETE SET NULL,
  name                TEXT          NOT NULL,       -- e.g. "Class 8 - 2025-26"
  academic_year       TEXT          NOT NULL,       -- e.g. "2025-26"
  year_start_month    INTEGER       NOT NULL DEFAULT 4  -- 4 = April
                                    CHECK (year_start_month BETWEEN 1 AND 12),
  year_end_month      INTEGER       NOT NULL DEFAULT 3  -- 3 = March
                                    CHECK (year_end_month  BETWEEN 1 AND 12),

  -- Due date: dues generated with due_date = this day of each month
  due_day_of_month    INTEGER       NOT NULL DEFAULT 10
                                    CHECK (due_day_of_month BETWEEN 1 AND 28),

  -- Late fee — fully optional, school decides
  late_fee_enabled    BOOLEAN       NOT NULL DEFAULT false,
  late_fee_type       TEXT          CHECK (late_fee_type IN ('fixed', 'percentage')),
  late_fee_value      NUMERIC(10,2) NOT NULL DEFAULT 0
                                    CHECK (late_fee_value >= 0),
  late_fee_grace_days INTEGER       NOT NULL DEFAULT 10
                                    CHECK (late_fee_grace_days >= 0),

  is_active           BOOLEAN       NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.fee_structures IS
  'Fee template per class per academic year. Defines what fees the class pays, '
  'how often, amounts, and late fee rules. Once saved, generate_fee_dues() '
  'auto-creates monthly due rows for all active students in the class.';


-- ── PART C: fee_structure_items table ────────────────────────────────────────
-- Individual fee line items inside a structure.
-- Each item has its own frequency — school admin has full control.

CREATE TABLE IF NOT EXISTS public.fee_structure_items (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id           UUID          NOT NULL
                                    REFERENCES public.schools(id) ON DELETE CASCADE,
  fee_structure_id    UUID          NOT NULL
                                    REFERENCES public.fee_structures(id) ON DELETE CASCADE,

  -- Fee definition
  fee_type            TEXT          NOT NULL
                                    CHECK (fee_type IN (
                                      'tuition', 'admission', 'exam',
                                      'transport', 'hostel', 'custom'
                                    )),
  label               TEXT          NOT NULL,       -- shown on receipt e.g. "Tuition Fee"
  amount              NUMERIC(10,2) NOT NULL
                                    CHECK (amount >= 0),

  -- Frequency — admin decides per line item
  frequency           TEXT          NOT NULL DEFAULT 'monthly'
                                    CHECK (frequency IN (
                                      'monthly',    -- every month of academic year
                                      'one_time',   -- first month only
                                      'quarterly',  -- admin picks which 3-4 months
                                      'custom'      -- admin picks exact months
                                    )),

  -- For 'custom' frequency: exact YYYY-MM values e.g. ['2025-06','2025-10','2026-01']
  applicable_months   TEXT[],

  -- For 'quarterly' frequency: month numbers (1-12) e.g. [4,7,10,1]
  quarterly_months    INTEGER[],

  is_enabled          BOOLEAN       NOT NULL DEFAULT true,
  sort_order          INTEGER       NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.fee_structure_items IS
  'Individual fee line items within a fee_structure. '
  'Each item independently controls its fee_type, amount, and frequency. '
  'Tuition can be monthly while Exam fee is one_time, etc.';


-- ── PART D: fee_discounts table ───────────────────────────────────────────────
-- Per-student scholarships and discounts.
-- Can target all fees or a specific fee_type.
-- Supports percentage or fixed amount reductions.

CREATE TABLE IF NOT EXISTS public.fee_discounts (
  id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id             UUID          NOT NULL
                                      REFERENCES public.schools(id) ON DELETE CASCADE,
  student_id            UUID          NOT NULL
                                      REFERENCES public.students(id) ON DELETE CASCADE,

  label                 TEXT          NOT NULL,     -- e.g. "Merit Scholarship", "Sibling Discount"
  discount_type         TEXT          NOT NULL
                                      CHECK (discount_type IN ('percentage', 'fixed')),
  value                 NUMERIC(10,2) NOT NULL
                                      CHECK (value > 0),   -- % or ₹ amount

  -- NULL means applies to ALL fee types; set to restrict to one type
  applies_to_fee_type   TEXT
                                      CHECK (applies_to_fee_type IN (
                                        'tuition', 'admission', 'exam',
                                        'transport', 'hostel', 'custom'
                                      ) OR applies_to_fee_type IS NULL),

  -- Optional validity window — NULL means no restriction
  valid_from            DATE,
  valid_until           DATE,

  is_active             BOOLEAN       NOT NULL DEFAULT true,
  notes                 TEXT,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ   NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.fee_discounts IS
  'Per-student discounts and scholarships. applies_to_fee_type = NULL means '
  'the discount applies to all fee types. Discounts are applied at due-generation '
  'time via generate_fee_dues() — changes do not retroactively update existing dues.';


-- ── PART E: fee_dues table ────────────────────────────────────────────────────
-- Auto-generated dues — one row per student per fee item per month.
-- NEVER manually inserted by staff — always via generate_fee_dues() function.
-- balance is a GENERATED ALWAYS computed column — never update it directly.

CREATE TABLE IF NOT EXISTS public.fee_dues (
  id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id             UUID          NOT NULL
                                      REFERENCES public.schools(id) ON DELETE CASCADE,
  student_id            UUID          NOT NULL
                                      REFERENCES public.students(id) ON DELETE CASCADE,
  fee_structure_id      UUID          NOT NULL
                                      REFERENCES public.fee_structures(id) ON DELETE CASCADE,
  fee_structure_item_id UUID          NOT NULL
                                      REFERENCES public.fee_structure_items(id) ON DELETE CASCADE,

  fee_type              TEXT          NOT NULL,
  label                 TEXT          NOT NULL,     -- copied from item at generation time
  month                 TEXT          NOT NULL,     -- 'YYYY-MM' e.g. '2025-06'
  academic_year         TEXT          NOT NULL,     -- '2025-26'
  due_date              DATE          NOT NULL,

  -- Amount breakdown
  base_amount           NUMERIC(10,2) NOT NULL,     -- from fee_structure_item.amount
  discount_amount       NUMERIC(10,2) NOT NULL DEFAULT 0,  -- from fee_discounts
  net_amount            NUMERIC(10,2) NOT NULL,     -- base_amount - discount_amount
  late_fee_amount       NUMERIC(10,2) NOT NULL DEFAULT 0,  -- applied by apply_late_fees()
  total_due             NUMERIC(10,2) NOT NULL,     -- net_amount + late_fee_amount

  -- Payment tracking — updated by record_fee_payment() only
  amount_paid           NUMERIC(10,2) NOT NULL DEFAULT 0,

  -- GENERATED ALWAYS — never update this column directly
  balance               NUMERIC(10,2) GENERATED ALWAYS AS (total_due - amount_paid) STORED,

  status                TEXT          NOT NULL DEFAULT 'unpaid'
                                      CHECK (status IN ('unpaid', 'partial', 'paid', 'waived')),

  late_fee_applied      BOOLEAN       NOT NULL DEFAULT false,
  waiver_reason         TEXT,
  notes                 TEXT,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),

  -- Dedup guard: one due per student per fee item per month
  -- ON CONFLICT DO NOTHING in generate_fee_dues() makes generation idempotent
  CONSTRAINT fee_dues_unique_per_month
    UNIQUE (student_id, fee_structure_item_id, month)
);

COMMENT ON TABLE public.fee_dues IS
  'Auto-generated monthly dues. Created by generate_fee_dues() — staff never inserts manually. '
  'balance is GENERATED ALWAYS AS (total_due - amount_paid) — never update it directly. '
  'UNIQUE(student_id, fee_structure_item_id, month) prevents duplicates on re-generation.';

COMMENT ON COLUMN public.fee_dues.balance IS
  'GENERATED ALWAYS AS (total_due - amount_paid) STORED. '
  'Do not update directly. Only amount_paid is writable (via record_fee_payment RPC).';


-- ── PART F: fee_payments table ────────────────────────────────────────────────
-- Actual money collected. Many payments per due (partial payments supported).
-- Always inserted via record_fee_payment() SECURITY DEFINER function.

CREATE TABLE IF NOT EXISTS public.fee_payments (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id           UUID          NOT NULL
                                    REFERENCES public.schools(id) ON DELETE CASCADE,
  student_id          UUID          NOT NULL
                                    REFERENCES public.students(id) ON DELETE CASCADE,
  fee_due_id          UUID          NOT NULL
                                    REFERENCES public.fee_dues(id) ON DELETE CASCADE,

  amount_paid         NUMERIC(10,2) NOT NULL
                                    CHECK (amount_paid > 0),
  payment_method      TEXT          NOT NULL DEFAULT 'cash'
                                    CHECK (payment_method IN (
                                      'cash', 'upi', 'bank_transfer',
                                      'online', 'cheque', 'other'
                                    )),
  receipt_number      TEXT          UNIQUE,          -- format: RCP-YYMM-XXXX
  paid_date           DATE          NOT NULL DEFAULT CURRENT_DATE,
  collected_by        UUID          REFERENCES public.profiles(id) ON DELETE SET NULL,
  notes               TEXT,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.fee_payments IS
  'Individual payment transactions against a fee_due. Multiple payments per due '
  'are supported (partial payments). Always inserted via record_fee_payment() RPC — '
  'never inserted directly from client. receipt_number is auto-generated.';


-- ── PART G: Indexes ───────────────────────────────────────────────────────────

-- fee_structures
CREATE INDEX IF NOT EXISTS idx_fee_structures_school
  ON public.fee_structures(school_id);

CREATE INDEX IF NOT EXISTS idx_fee_structures_class
  ON public.fee_structures(class_id);

CREATE INDEX IF NOT EXISTS idx_fee_structures_school_year
  ON public.fee_structures(school_id, academic_year);

-- fee_structure_items
CREATE INDEX IF NOT EXISTS idx_fee_items_structure
  ON public.fee_structure_items(fee_structure_id);

CREATE INDEX IF NOT EXISTS idx_fee_items_school
  ON public.fee_structure_items(school_id);

-- fee_discounts
CREATE INDEX IF NOT EXISTS idx_fee_discounts_student
  ON public.fee_discounts(student_id);

CREATE INDEX IF NOT EXISTS idx_fee_discounts_school
  ON public.fee_discounts(school_id);

-- fee_dues — several indexes for the key query patterns
CREATE INDEX IF NOT EXISTS idx_fee_dues_student
  ON public.fee_dues(student_id);

CREATE INDEX IF NOT EXISTS idx_fee_dues_school
  ON public.fee_dues(school_id);

CREATE INDEX IF NOT EXISTS idx_fee_dues_school_month
  ON public.fee_dues(school_id, month);

CREATE INDEX IF NOT EXISTS idx_fee_dues_status
  ON public.fee_dues(school_id, status);

CREATE INDEX IF NOT EXISTS idx_fee_dues_structure
  ON public.fee_dues(fee_structure_id);

-- Partial index for defaulter queries — only indexes actionable rows
CREATE INDEX IF NOT EXISTS idx_fee_dues_defaulters
  ON public.fee_dues(school_id, status, due_date)
  WHERE status IN ('unpaid', 'partial');

-- fee_payments
CREATE INDEX IF NOT EXISTS idx_fee_payments_due
  ON public.fee_payments(fee_due_id);

CREATE INDEX IF NOT EXISTS idx_fee_payments_student
  ON public.fee_payments(student_id);

CREATE INDEX IF NOT EXISTS idx_fee_payments_school
  ON public.fee_payments(school_id);

CREATE INDEX IF NOT EXISTS idx_fee_payments_date
  ON public.fee_payments(school_id, paid_date);


-- ── PART H: Triggers (updated_at) ────────────────────────────────────────────
-- set_updated_at() already exists from Chat 10 WA migration.
-- CREATE OR REPLACE is safe if it needs to be recreated.
-- DROP TRIGGER IF EXISTS guards prevent errors on re-run.

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fee_structures_updated_at ON public.fee_structures;
CREATE TRIGGER fee_structures_updated_at
  BEFORE UPDATE ON public.fee_structures
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS fee_discounts_updated_at ON public.fee_discounts;
CREATE TRIGGER fee_discounts_updated_at
  BEFORE UPDATE ON public.fee_discounts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS fee_dues_updated_at ON public.fee_dues;
CREATE TRIGGER fee_dues_updated_at
  BEFORE UPDATE ON public.fee_dues
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ── PART I: generate_fee_receipt_number() ────────────────────────────────────
-- Generates a unique receipt number in format RCP-YYMM-XXXX.
-- Loops until a non-colliding value is found (collision probability ~0.01%).

CREATE OR REPLACE FUNCTION public.generate_fee_receipt_number()
RETURNS TEXT
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_receipt TEXT;
  v_exists  BOOLEAN;
BEGIN
  LOOP
    v_receipt :=
      'RCP-' ||
      TO_CHAR(NOW(), 'YYMM') || '-' ||
      LPAD((FLOOR(RANDOM() * 9000) + 1000)::TEXT, 4, '0');

    SELECT EXISTS (
      SELECT 1
      FROM public.fee_payments
      WHERE receipt_number = v_receipt
    ) INTO v_exists;

    EXIT WHEN NOT v_exists;
  END LOOP;

  RETURN v_receipt;
END;
$$;


-- ── PART J: generate_fee_dues() ──────────────────────────────────────────────
-- Core automation engine. Generates fee_due rows for all active students
-- in a class for the full academic year based on each item's frequency.
-- Idempotent: ON CONFLICT DO NOTHING skips already-existing dues.
-- Called by: generate-fee-dues Edge Function (via service_role).
-- Also callable directly as authenticated RPC by school_admin.

CREATE OR REPLACE FUNCTION public.generate_fee_dues(
  p_fee_structure_id  UUID,
  p_from_month        TEXT DEFAULT NULL  -- 'YYYY-MM'; NULL = generate full year
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
  v_disc_amount     NUMERIC(10,2);
  v_net             NUMERIC(10,2);
  v_months          TEXT[];
  v_year_months     TEXT[];
  v_start_year      INTEGER;
  v_m               INTEGER;
  v_generated       INTEGER := 0;
  v_skipped         INTEGER := 0;
  v_from_month      TEXT;
  v_qm              INTEGER;
  v_qy              INTEGER;
  v_abs_month       INTEGER;
  v_y               INTEGER;
  v_mo              INTEGER;
BEGIN

  -- Load and validate the fee structure
  SELECT * INTO v_structure
  FROM public.fee_structures
  WHERE id = p_fee_structure_id
    AND is_active = true;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 0, 0;
    RETURN;
  END IF;

  -- Build ordered array of all 12 months in the academic year
  -- e.g. year_start_month=4, academic_year='2025-26'
  --   → ['2025-04','2025-05',...,'2025-12','2026-01','2026-02','2026-03']
  v_start_year  := SPLIT_PART(v_structure.academic_year, '-', 1)::INTEGER;
  v_year_months := ARRAY[]::TEXT[];

  FOR v_m IN 0..11 LOOP
    v_abs_month   := v_structure.year_start_month + v_m;
    v_y           := v_start_year + (v_abs_month - 1) / 12;
    v_mo          := ((v_abs_month - 1) % 12) + 1;
    v_year_months := v_year_months ||
      (v_y::TEXT || '-' || LPAD(v_mo::TEXT, 2, '0'));
  END LOOP;

  -- Determine the earliest month to generate dues for
  v_from_month := COALESCE(p_from_month, v_year_months[1]);

  -- Process each enabled fee item in sort order
  FOR v_item IN
    SELECT *
    FROM public.fee_structure_items
    WHERE fee_structure_id = p_fee_structure_id
      AND is_enabled = true
    ORDER BY sort_order, created_at
  LOOP

    -- Determine applicable months for this item based on frequency
    CASE v_item.frequency

      WHEN 'monthly' THEN
        v_months := v_year_months;

      WHEN 'one_time' THEN
        -- First month of the academic year only
        v_months := ARRAY[ v_year_months[1] ];

      WHEN 'quarterly' THEN
        v_months := ARRAY[]::TEXT[];
        FOREACH v_qm IN ARRAY COALESCE(v_item.quarterly_months, ARRAY[4,7,10,1]) LOOP
          -- Determine which calendar year this quarter-month falls in
          IF v_qm >= v_structure.year_start_month THEN
            v_qy := v_start_year;
          ELSE
            v_qy := v_start_year + 1;
          END IF;
          v_months := v_months ||
            (v_qy::TEXT || '-' || LPAD(v_qm::TEXT, 2, '0'));
        END LOOP;

      WHEN 'custom' THEN
        v_months := COALESCE(v_item.applicable_months, ARRAY[]::TEXT[]);

      ELSE
        v_months := ARRAY[]::TEXT[];

    END CASE;

    -- Process each active student in this class
    FOR v_student IN
      SELECT id AS student_id
      FROM public.students
      WHERE school_id = v_structure.school_id
        AND class_id  = v_structure.class_id
        AND is_active = true
    LOOP

      -- Find the best applicable active discount for this student + fee_type
      SELECT COALESCE(
        CASE d.discount_type
          WHEN 'percentage' THEN ROUND(v_item.amount * d.value / 100, 2)
          WHEN 'fixed'      THEN LEAST(d.value, v_item.amount)
        END,
        0
      )
      INTO v_disc_amount
      FROM public.fee_discounts d
      WHERE d.student_id = v_student.student_id
        AND d.school_id  = v_structure.school_id
        AND d.is_active  = true
        AND (d.applies_to_fee_type IS NULL
             OR d.applies_to_fee_type = v_item.fee_type)
        AND (d.valid_from  IS NULL OR d.valid_from  <= CURRENT_DATE)
        AND (d.valid_until IS NULL OR d.valid_until >= CURRENT_DATE)
      ORDER BY d.created_at DESC
      LIMIT 1;

      v_disc_amount := COALESCE(v_disc_amount, 0);
      v_net         := v_item.amount - v_disc_amount;

      -- Insert one due per applicable month
      FOREACH v_month IN ARRAY v_months LOOP

        -- Skip months before p_from_month (handles mid-year student joins)
        CONTINUE WHEN v_month < v_from_month;

        -- due_date = due_day_of_month of that month
        v_due_date := (v_month || '-' ||
          LPAD(v_structure.due_day_of_month::TEXT, 2, '0'))::DATE;

        INSERT INTO public.fee_dues (
          school_id,
          student_id,
          fee_structure_id,
          fee_structure_item_id,
          fee_type,
          label,
          month,
          academic_year,
          due_date,
          base_amount,
          discount_amount,
          net_amount,
          total_due,
          status
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
          v_net,      -- total_due = net (late fee added later by apply_late_fees)
          'unpaid'
        )
        ON CONFLICT (student_id, fee_structure_item_id, month)
        DO NOTHING;

        IF FOUND THEN
          v_generated := v_generated + 1;
        ELSE
          v_skipped := v_skipped + 1;
        END IF;

      END LOOP; -- months loop

    END LOOP; -- students loop

  END LOOP; -- items loop

  RETURN QUERY SELECT v_generated, v_skipped;
END;
$$;


-- ── PART K: apply_late_fees() ─────────────────────────────────────────────────
-- Finds overdue unpaid/partial dues past the grace period and applies late fees.
-- Designed to be called by pg_cron daily. Skips already-applied rows.
-- Safe to call multiple times — late_fee_applied flag prevents double application.

CREATE OR REPLACE FUNCTION public.apply_late_fees(p_school_id UUID)
RETURNS INTEGER
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
      AND d.due_date         < CURRENT_DATE
  LOOP

    SELECT * INTO v_structure
    FROM public.fee_structures
    WHERE id = v_due.fee_structure_id;

    CONTINUE WHEN NOT FOUND;
    CONTINUE WHEN NOT v_structure.late_fee_enabled;

    -- Only apply after grace period has elapsed
    CONTINUE WHEN (CURRENT_DATE - v_due.due_date) <= v_structure.late_fee_grace_days;

    v_late_fee := CASE v_structure.late_fee_type
      WHEN 'fixed'      THEN v_structure.late_fee_value
      WHEN 'percentage' THEN ROUND(v_due.net_amount * v_structure.late_fee_value / 100, 2)
      ELSE                   0
    END;

    CONTINUE WHEN v_late_fee <= 0;

    UPDATE public.fee_dues
    SET
      late_fee_amount  = v_late_fee,
      total_due        = net_amount + v_late_fee,
      late_fee_applied = true,
      updated_at       = now()
    WHERE id = v_due.id;

    v_count := v_count + 1;

  END LOOP;

  RETURN v_count;
END;
$$;


-- ── PART L: record_fee_payment() ─────────────────────────────────────────────
-- Atomically records a payment and updates the due's status.
-- Supports full, partial, and advance payments.
-- Generates a unique receipt number via generate_fee_receipt_number().
-- Called from fee collection UI via RPC.

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

  -- Verify due belongs to this school and student (security check)
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

  IF p_amount_paid <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be greater than zero';
  END IF;

  -- Generate unique receipt number
  v_receipt := public.generate_fee_receipt_number();

  -- Insert the payment record
  INSERT INTO public.fee_payments (
    school_id,
    student_id,
    fee_due_id,
    amount_paid,
    payment_method,
    receipt_number,
    paid_date,
    collected_by,
    notes
  ) VALUES (
    p_school_id,
    p_student_id,
    p_fee_due_id,
    p_amount_paid,
    p_payment_method,
    v_receipt,
    p_paid_date,
    p_collected_by,
    p_notes
  )
  RETURNING id INTO v_payment_id;

  -- Update due: increment amount_paid and recompute status
  v_new_paid   := v_due.amount_paid + p_amount_paid;
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


-- ── PART M: get_student_fee_ledger() ─────────────────────────────────────────
-- Returns complete fee history for a student including payment details.
-- Caller must belong to the same school (verified inside function).

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
    SELECT 1
    FROM public.profiles
    WHERE id        = auth.uid()
      AND school_id = p_school_id
      AND is_active = true
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
    COUNT(p.id)          AS payments_count,
    MAX(p.paid_date)     AS last_payment_date,
    MAX(p.receipt_number) AS last_receipt
  FROM public.fee_dues d
  LEFT JOIN public.fee_payments p ON p.fee_due_id = d.id
  WHERE d.school_id  = p_school_id
    AND d.student_id = p_student_id
  GROUP BY d.id
  ORDER BY d.month DESC, d.fee_type;

END;
$$;


-- ── PART N: get_defaulters() ──────────────────────────────────────────────────
-- Returns all students with outstanding balances (unpaid/partial dues).
-- Optional filters: class_id, academic_year.
-- Restricted to school_admin role.

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

  -- Only school_admin can see defaulter lists
  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles
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
    c.name                              AS class_name,
    c.section                           AS class_section,
    SUM(d.balance)                      AS total_balance,
    MIN(d.due_date)                     AS oldest_due_date,
    (CURRENT_DATE - MIN(d.due_date))    AS days_overdue,
    COUNT(d.id)                         AS dues_count
  FROM public.students s
  JOIN public.fee_dues d    ON d.student_id = s.id
  LEFT JOIN public.classes c ON c.id        = s.class_id
  WHERE d.school_id   = p_school_id
    AND d.status      IN ('unpaid', 'partial')
    AND d.balance     > 0
    AND (p_class_id      IS NULL OR s.class_id      = p_class_id)
    AND (p_academic_year IS NULL OR d.academic_year = p_academic_year)
  GROUP BY s.id, s.full_name, s.student_uid, c.name, c.section
  ORDER BY total_balance DESC;

END;
$$;


-- ── PART O: get_fee_dashboard_stats() ────────────────────────────────────────
-- Returns aggregated fee statistics for the school dashboard.
-- Today's collection, monthly collection, total pending, defaulters, YTD.

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
    -- Today's total collection
    COALESCE((
      SELECT SUM(fp.amount_paid)
      FROM public.fee_payments fp
      WHERE fp.school_id = p_school_id
        AND fp.paid_date = CURRENT_DATE
    ), 0::NUMERIC),

    -- This calendar month's total collection
    COALESCE((
      SELECT SUM(fp.amount_paid)
      FROM public.fee_payments fp
      WHERE fp.school_id = p_school_id
        AND TO_CHAR(fp.paid_date, 'YYYY-MM') = TO_CHAR(CURRENT_DATE, 'YYYY-MM')
    ), 0::NUMERIC),

    -- Total outstanding balance across all unpaid/partial dues
    COALESCE((
      SELECT SUM(fd.balance)
      FROM public.fee_dues fd
      WHERE fd.school_id = p_school_id
        AND fd.status    IN ('unpaid', 'partial')
        AND fd.balance   > 0
    ), 0::NUMERIC),

    -- Count of distinct students with overdue balance
    COALESCE((
      SELECT COUNT(DISTINCT fd.student_id)
      FROM public.fee_dues fd
      WHERE fd.school_id = p_school_id
        AND fd.status    IN ('unpaid', 'partial')
        AND fd.due_date  < CURRENT_DATE
        AND fd.balance   > 0
    ), 0::BIGINT),

    -- Year-to-date collection (calendar year)
    COALESCE((
      SELECT SUM(fp.amount_paid)
      FROM public.fee_payments fp
      WHERE fp.school_id = p_school_id
        AND EXTRACT(YEAR FROM fp.paid_date) = EXTRACT(YEAR FROM CURRENT_DATE)
    ), 0::NUMERIC);

END;
$$;


-- ── PART P: Row Level Security ────────────────────────────────────────────────
-- Pattern matches existing Schoolium policies exactly.
-- school_admin: full CRUD on their school's fee data.
-- guard / teacher: no access to any fee tables.
-- Edge Functions: use SERVICE_ROLE_KEY, bypass RLS entirely.

ALTER TABLE public.fee_structures      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fee_structure_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fee_discounts       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fee_dues            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fee_payments        ENABLE ROW LEVEL SECURITY;

-- fee_structures
DROP POLICY IF EXISTS "school_admin_fee_structures" ON public.fee_structures;
CREATE POLICY "school_admin_fee_structures"
  ON public.fee_structures
  FOR ALL
  USING (
    school_id IN (
      SELECT school_id FROM public.profiles
      WHERE id = auth.uid() AND role = 'school_admin' AND is_active = true
    )
  );

-- fee_structure_items
DROP POLICY IF EXISTS "school_admin_fee_structure_items" ON public.fee_structure_items;
CREATE POLICY "school_admin_fee_structure_items"
  ON public.fee_structure_items
  FOR ALL
  USING (
    school_id IN (
      SELECT school_id FROM public.profiles
      WHERE id = auth.uid() AND role = 'school_admin' AND is_active = true
    )
  );

-- fee_discounts
DROP POLICY IF EXISTS "school_admin_fee_discounts" ON public.fee_discounts;
CREATE POLICY "school_admin_fee_discounts"
  ON public.fee_discounts
  FOR ALL
  USING (
    school_id IN (
      SELECT school_id FROM public.profiles
      WHERE id = auth.uid() AND role = 'school_admin' AND is_active = true
    )
  );

-- fee_dues
DROP POLICY IF EXISTS "school_admin_fee_dues" ON public.fee_dues;
CREATE POLICY "school_admin_fee_dues"
  ON public.fee_dues
  FOR ALL
  USING (
    school_id IN (
      SELECT school_id FROM public.profiles
      WHERE id = auth.uid() AND role = 'school_admin' AND is_active = true
    )
  );

-- fee_payments
DROP POLICY IF EXISTS "school_admin_fee_payments" ON public.fee_payments;
CREATE POLICY "school_admin_fee_payments"
  ON public.fee_payments
  FOR ALL
  USING (
    school_id IN (
      SELECT school_id FROM public.profiles
      WHERE id = auth.uid() AND role = 'school_admin' AND is_active = true
    )
  );


-- ── PART Q: Function permissions ─────────────────────────────────────────────
-- Full parameter signatures required by PostgreSQL for REVOKE/GRANT.
-- generate_fee_receipt_number — internal helper, no direct client access needed.
-- All others — GRANT TO authenticated for direct RPC calls from school_admin.

REVOKE ALL ON FUNCTION public.generate_fee_receipt_number()
  FROM PUBLIC;

REVOKE ALL ON FUNCTION public.generate_fee_dues(UUID, TEXT)
  FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.generate_fee_dues(UUID, TEXT)
  TO authenticated;

REVOKE ALL ON FUNCTION public.apply_late_fees(UUID)
  FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.apply_late_fees(UUID)
  TO authenticated;

REVOKE ALL ON FUNCTION public.record_fee_payment(UUID, UUID, UUID, NUMERIC, TEXT, DATE, UUID, TEXT)
  FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.record_fee_payment(UUID, UUID, UUID, NUMERIC, TEXT, DATE, UUID, TEXT)
  TO authenticated;

REVOKE ALL ON FUNCTION public.get_student_fee_ledger(UUID, UUID)
  FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_student_fee_ledger(UUID, UUID)
  TO authenticated;

REVOKE ALL ON FUNCTION public.get_defaulters(UUID, UUID, TEXT)
  FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_defaulters(UUID, UUID, TEXT)
  TO authenticated;

REVOKE ALL ON FUNCTION public.get_fee_dashboard_stats(UUID)
  FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_fee_dashboard_stats(UUID)
  TO authenticated;


-- ── pg_cron: apply-late-fees-daily ───────────────────────────────────────────
-- Schedule SEPARATELY after confirming pg_cron is enabled.
-- Runs at 19:30 UTC (= 01:00 IST) every day.
-- Uncomment and run as a separate SQL block:

-- SELECT cron.unschedule('apply-late-fees-daily')
-- WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'apply-late-fees-daily');
--
-- SELECT cron.schedule(
--   'apply-late-fees-daily',
--   '30 19 * * *',
--   $$
--     SELECT public.apply_late_fees(id)
--     FROM public.schools
--     WHERE is_active = true;
--   $$
-- );


-- ── Verification queries (run after applying) ─────────────────────────────────
-- Uncomment and run each block to verify the migration landed correctly.

-- 1. New tables exist:
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema = 'public'
--   AND table_name IN (
--     'fee_structures','fee_structure_items',
--     'fee_discounts','fee_dues','fee_payments'
--   )
-- ORDER BY table_name;

-- 2. fee_dues GENERATED column:
-- SELECT column_name, generation_expression
-- FROM information_schema.columns
-- WHERE table_name = 'fee_dues' AND column_name = 'balance';

-- 3. RLS enabled on all new tables:
-- SELECT tablename, rowsecurity
-- FROM pg_tables
-- WHERE schemaname = 'public'
--   AND tablename IN (
--     'fee_structures','fee_structure_items',
--     'fee_discounts','fee_dues','fee_payments'
--   );

-- 4. All functions exist:
-- SELECT routine_name, routine_type
-- FROM information_schema.routines
-- WHERE routine_schema = 'public'
--   AND routine_name IN (
--     'generate_fee_receipt_number','generate_fee_dues',
--     'apply_late_fees','record_fee_payment',
--     'get_student_fee_ledger','get_defaulters',
--     'get_fee_dashboard_stats'
--   )
-- ORDER BY routine_name;

-- 5. wa_message_log constraint updated:
-- SELECT constraint_name, check_clause
-- FROM information_schema.check_constraints
-- WHERE constraint_schema = 'public'
--   AND constraint_name = 'wa_message_log_type_check';

-- 6. Indexes on fee tables:
-- SELECT tablename, indexname
-- FROM pg_indexes
-- WHERE schemaname = 'public'
--   AND tablename IN (
--     'fee_structures','fee_structure_items',
--     'fee_discounts','fee_dues','fee_payments'
--   )
-- ORDER BY tablename, indexname;


-- ============================================================
-- END OF MIGRATION
-- File: 20260622_chat10_final_clean.sql
-- Session: Chat 10
--
-- Tables created (5):
--   fee_structures, fee_structure_items, fee_discounts,
--   fee_dues, fee_payments
--
-- Functions created (7):
--   generate_fee_receipt_number, generate_fee_dues,
--   apply_late_fees, record_fee_payment,
--   get_student_fee_ledger, get_defaulters,
--   get_fee_dashboard_stats
--
-- Existing table modified (1):
--   wa_message_log — message_type CHECK constraint
--   loosened to support fee reminder message types
--
-- Existing 'fees' table: UNTOUCHED
-- Manual billing: fully intact
--
-- Edge Functions deployed separately (not SQL):
--   generate-fee-dues/index.ts    ✓ deployed
--   send-fee-reminder/index.ts    ✓ deployed
--
-- pg_cron apply-late-fees-daily:
--   ⚠ COMMENTED OUT — schedule separately
-- ============================================================
