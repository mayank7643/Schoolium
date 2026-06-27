-- ============================================================
-- SCHOOLIUM — Sprint 3 Step 2
-- SECURITY, AUDIT TRAIL & REVERSAL SYSTEM
-- File: sprint3_step2_security_audit.sql
-- Run AFTER sprint3_step1_unify_billing.sql
-- ============================================================
--
-- WHAT THIS DOES:
--
-- PART A — roles: add 'collector' role (school office staff)
--           Collector can collect fees but cannot approve reversals,
--           create fee structures, or manage students.
--
-- PART B — schools table: add late_fee_waiver_cap columns
--           max a collector can waive without admin override
--
-- PART C — fee_discounts: add approved_by, discount_category columns
--           Every discount must be pre-approved by an admin.
--           Collectors can only SELECT from approved discounts.
--
-- PART D — fee_payments: add reversal columns
--           reversal_status, reversal_reason, reversal_requested_by,
--           reversal_requested_at, reversed_by, reversed_at
--           Payments are IMMUTABLE — only counter-transaction reversal.
--
-- PART E — fee_audit_trail table (NEW)
--           Every action on the collect page leaves a footprint.
--
-- PART F — eod_closures table (NEW)
--           Collector EOD cash count vs system computed count.
--
-- PART G — reversal_requests table (NEW)
--           Pending reversals awaiting admin approval.
--           (Separate from fee_payments for clean audit separation)
--
-- PART H — get_student_billing_summary() REBUILD
--           Returns structured path vs manual path clearly separated.
--           Includes discount breakdown per line item.
--           Includes source column, late_fee details, previous dues.
--
-- PART I — request_payment_reversal() RPC (collector/admin requests)
-- PART J — approve_payment_reversal() RPC (admin only finalises)
-- PART K — submit_eod_closure() RPC
-- PART L — log_fee_audit_event() RPC (called from client on key actions)
-- PART M — Indexes + RLS on new tables
-- ============================================================


-- ============================================================
-- PART A: ADD 'collector' ROLE
-- Collector = office staff who collects fees but is NOT an admin.
-- They cannot: manage students, approve reversals, set structures,
--              create fee types, view full financial reports.
-- They can:    search students, collect fees, print receipts,
--              request reversals (not approve), submit EOD.
-- ============================================================

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_role_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check
    CHECK (role IN (
      'super_admin',
      'school_admin',
      'teacher',
      'collector',   -- NEW: office staff fee collector
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


-- ============================================================
-- PART B: SCHOOLS TABLE — late fee waiver cap for collectors
-- Admin sets the maximum a collector can waive without override.
-- ============================================================

ALTER TABLE public.schools
  ADD COLUMN IF NOT EXISTS late_fee_waiver_max_pct   NUMERIC(5,2) NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS late_fee_waiver_max_flat   NUMERIC(10,2) NOT NULL DEFAULT 200;

COMMENT ON COLUMN public.schools.late_fee_waiver_max_pct IS
  'Maximum % of late fee a collector can waive without admin override. Default 10%.';
COMMENT ON COLUMN public.schools.late_fee_waiver_max_flat IS
  'Maximum flat ₹ amount a collector can waive without admin override. Default ₹200. '
  'Whichever is lower applies.';


-- ============================================================
-- PART C: fee_discounts — add audit columns
-- Every discount must be admin-approved before it can be applied.
-- Collectors can only apply pre-approved discounts.
-- ============================================================

ALTER TABLE public.fee_discounts
  ADD COLUMN IF NOT EXISTS discount_category  TEXT NOT NULL DEFAULT 'other'
    CHECK (discount_category IN (
      'rte_quota',       -- Right to Education government quota
      'staff_child',     -- Teacher/staff ward discount
      'sibling',         -- Second/third child in same school
      'merit',           -- Academic merit scholarship
      'sports_quota',    -- Sports achievement
      'special',         -- Principal ad-hoc one-time
      'other'            -- Catch-all (requires mandatory notes)
    )),
  ADD COLUMN IF NOT EXISTS approved_by        UUID
    REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_approved        BOOLEAN NOT NULL DEFAULT false;

-- Only approved discounts are visible to collectors
COMMENT ON COLUMN public.fee_discounts.is_approved IS
  'Only school_admin can set this to true. '
  'Collectors can only apply discounts where is_approved = true.';

COMMENT ON COLUMN public.fee_discounts.discount_category IS
  'Category for audit reports. ''special'' and ''other'' require notes.';


-- ============================================================
-- PART D: fee_payments — add reversal columns
-- Payments are IMMUTABLE after creation.
-- Reversal = counter-transaction, not deletion.
-- ============================================================

ALTER TABLE public.fee_payments
  ADD COLUMN IF NOT EXISTS reversal_status         TEXT
    CHECK (reversal_status IN ('reversal_requested', 'reversal_approved', 'reversal_rejected')),
  ADD COLUMN IF NOT EXISTS reversal_reason          TEXT,
  ADD COLUMN IF NOT EXISTS reversal_requested_by    UUID
    REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reversal_requested_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reversed_by              UUID
    REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reversed_at              TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reversal_payment_id      UUID
    REFERENCES public.fee_payments(id) ON DELETE SET NULL;

-- NULL reversal_status = normal active payment (default)
-- 'reversal_requested' = collector flagged, admin must approve
-- 'reversal_approved'  = admin approved, counter-payment exists
-- 'reversal_rejected'  = admin rejected request

COMMENT ON COLUMN public.fee_payments.reversal_payment_id IS
  'Points to the counter-transaction payment row that reversed this one. '
  'NULL for normal payments. Set by approve_payment_reversal().';

-- Fix payment_method check — 'card' was added in Sprint 1 but original had 'online'
-- Align once and for all
ALTER TABLE public.fee_payments
  DROP CONSTRAINT IF EXISTS fee_payments_payment_method_check;

ALTER TABLE public.fee_payments
  ADD CONSTRAINT fee_payments_payment_method_check
    CHECK (payment_method IN (
      'cash', 'upi', 'bank_transfer', 'cheque', 'card', 'other'
    ));


-- ============================================================
-- PART E: fee_audit_trail TABLE
-- Every significant action on the collect page.
-- Written by log_fee_audit_event() RPC — never from client directly.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.fee_audit_trail (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id       UUID          NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  actor_id        UUID          NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  actor_role      TEXT          NOT NULL,

  -- What happened
  event_type      TEXT          NOT NULL
    CHECK (event_type IN (
      'student_loaded',        -- collector opened a student's billing screen
      'payment_collected',     -- successful fee_payment recorded
      'manual_due_created',    -- admin created a manual due
      'reversal_requested',    -- collector requested reversal
      'reversal_approved',     -- admin approved reversal
      'reversal_rejected',     -- admin rejected reversal
      'late_fee_waived',       -- collector waived a late fee (within cap)
      'discount_applied',      -- discount applied during collection
      'eod_submitted'          -- collector submitted EOD closure
    )),

  -- References
  student_id      UUID          REFERENCES public.students(id) ON DELETE SET NULL,
  fee_due_id      UUID          REFERENCES public.fee_dues(id) ON DELETE SET NULL,
  fee_payment_id  UUID          REFERENCES public.fee_payments(id) ON DELETE SET NULL,

  -- Original vs submitted values (for change audit)
  original_value  NUMERIC(10,2),   -- system-computed value before collector touched it
  submitted_value NUMERIC(10,2),   -- what collector actually submitted
  delta           NUMERIC(10,2) GENERATED ALWAYS AS (submitted_value - original_value) STORED,

  -- Context
  notes           TEXT,            -- mandatory for reversals, waivers, special discounts
  ip_address      TEXT,
  user_agent      TEXT,

  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.fee_audit_trail IS
  'Immutable audit log. Every fee action leaves a footprint. '
  'Never deleted. Written only via log_fee_audit_event() RPC. '
  'Admin can see full trail; collectors can only see their own.';


-- ============================================================
-- PART F: eod_closures TABLE
-- Collector submits physical cash count at end of shift.
-- System computes expected from fee_payments.
-- Variance is auto-calculated and admin is notified.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.eod_closures (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id           UUID          NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  collector_id        UUID          NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,

  closure_date        DATE          NOT NULL DEFAULT CURRENT_DATE,

  -- What system says was collected in cash today by this collector
  system_cash_total   NUMERIC(10,2) NOT NULL DEFAULT 0,

  -- What collector physically counted in their drawer
  physical_cash_count NUMERIC(10,2) NOT NULL,

  -- Computed: physical - system (negative = shortage, positive = excess)
  variance            NUMERIC(10,2) GENERATED ALWAYS AS
                        (physical_cash_count - system_cash_total) STORED,

  -- Status
  status              TEXT          NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted', 'acknowledged', 'disputed')),

  notes               TEXT,         -- collector notes
  admin_notes         TEXT,         -- admin response
  acknowledged_by     UUID          REFERENCES public.profiles(id) ON DELETE SET NULL,
  acknowledged_at     TIMESTAMPTZ,

  created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),

  -- One closure per collector per day
  CONSTRAINT eod_one_per_collector_per_day
    UNIQUE (school_id, collector_id, closure_date)
);

COMMENT ON TABLE public.eod_closures IS
  'End-of-day cash reconciliation. Collector submits physical cash count. '
  'Variance = physical_cash_count - system_cash_total. '
  'Negative variance triggers admin notification. '
  'Collector cannot see system_cash_total until after they submit.';


-- ============================================================
-- PART G: reversal_requests TABLE
-- Clean separation: request lifecycle separate from payment row.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.reversal_requests (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id         UUID          NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  fee_payment_id    UUID          NOT NULL REFERENCES public.fee_payments(id) ON DELETE CASCADE,
  requested_by      UUID          NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  requested_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),

  reason            TEXT          NOT NULL,  -- mandatory always
  status            TEXT          NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),

  reviewed_by       UUID          REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewed_at       TIMESTAMPTZ,
  admin_notes       TEXT,

  -- If approved: the counter-payment id that reverses the original
  counter_payment_id UUID         REFERENCES public.fee_payments(id) ON DELETE SET NULL,

  CONSTRAINT one_reversal_request_per_payment
    UNIQUE (fee_payment_id)
);

COMMENT ON TABLE public.reversal_requests IS
  'Reversal request queue. Collector submits, admin approves. '
  'No self-reversal. Counter-payment is created only on admin approval. '
  'One request per payment — cannot request reversal of an already-reversed payment.';


-- ============================================================
-- PART H: REBUILD get_student_billing_summary()
-- Returns clearly separated structured path vs manual path.
-- Includes: discount_amount, late_fee_amount, source, fee_type.
-- Grand totals: structured pending + manual pending combined.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_student_billing_summary(
  p_student_id UUID
)
RETURNS TABLE (
  -- Student info
  student_id          UUID,
  full_name           TEXT,
  student_uid         TEXT,
  father_name         TEXT,
  parent_phone        TEXT,
  class_name          TEXT,
  class_section       TEXT,
  -- Fee structure (NULL if not assigned)
  fee_structure_id    UUID,
  fee_structure_name  TEXT,
  has_fee_structure   BOOLEAN,
  -- Due info (one row per pending due)
  source              TEXT,     -- 'structured' | 'manual'
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
  -- Grand totals (window aggregates across all pending dues)
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

  -- Caller must be school_admin OR collector for this school
  SELECT p.school_id INTO v_school_id
  FROM public.profiles p
  WHERE p.id        = auth.uid()
    AND p.role      IN ('school_admin', 'collector')
    AND p.is_active = true;

  IF v_school_id IS NULL THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  -- Verify student belongs to this school
  IF NOT EXISTS (
    SELECT 1 FROM public.students
    WHERE id = p_student_id AND school_id = v_school_id
  ) THEN
    RAISE EXCEPTION 'Student not found';
  END IF;

  RETURN QUERY
  SELECT
    s.id                                              AS student_id,
    s.full_name::TEXT,
    s.student_uid::TEXT,
    s.father_name::TEXT,
    s.parent_phone::TEXT,
    c.name::TEXT                                      AS class_name,
    c.section::TEXT                                   AS class_section,
    s.fee_structure_id,
    fs.name::TEXT                                     AS fee_structure_name,
    (s.fee_structure_id IS NOT NULL)                  AS has_fee_structure,
    d.source::TEXT,
    d.id                                              AS due_id,
    d.fee_type::TEXT,
    d.label::TEXT                                     AS due_label,
    d.month::TEXT                                     AS due_month,
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
    -- Window aggregates — grand totals across ALL pending dues for this student
    SUM(d.total_due)   OVER (PARTITION BY s.id)      AS grand_total_due,
    SUM(d.amount_paid) OVER (PARTITION BY s.id)      AS grand_total_paid,
    SUM(d.balance)     OVER (PARTITION BY s.id)      AS grand_balance
  FROM public.students s
  LEFT JOIN public.classes c          ON c.id  = s.class_id
  LEFT JOIN public.fee_structures fs  ON fs.id = s.fee_structure_id
  LEFT JOIN public.fee_dues d
    ON  d.student_id = s.id
    AND d.school_id  = v_school_id
    AND d.status     NOT IN ('paid', 'waived')
    AND d.balance    > 0
  WHERE s.id = p_student_id
  ORDER BY
    d.source ASC NULLS LAST,    -- 'manual' before 'structured' alphabetically — flip if needed
    d.due_date ASC NULLS LAST,
    d.created_at ASC NULLS LAST;

END;
$$;

REVOKE ALL ON FUNCTION public.get_student_billing_summary(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_student_billing_summary(UUID) TO authenticated;


-- ============================================================
-- PART I: request_payment_reversal()
-- Collector or admin requests reversal of a payment.
-- Creates a reversal_requests row. Does NOT touch fee_payments yet.
-- ============================================================

CREATE OR REPLACE FUNCTION public.request_payment_reversal(
  p_fee_payment_id  UUID,
  p_reason          TEXT
)
RETURNS TABLE (request_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_school_id  UUID;
  v_payment    RECORD;
  v_request_id UUID;
BEGIN

  -- Caller must be school_admin or collector
  SELECT p.school_id INTO v_school_id
  FROM public.profiles p
  WHERE p.id        = auth.uid()
    AND p.role      IN ('school_admin', 'collector')
    AND p.is_active = true;

  IF v_school_id IS NULL THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  -- Mandatory reason
  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is mandatory for reversal requests';
  END IF;

  -- Load and verify payment belongs to this school
  SELECT * INTO v_payment
  FROM public.fee_payments
  WHERE id        = p_fee_payment_id
    AND school_id = v_school_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment not found';
  END IF;

  -- Cannot request reversal of an already-reversed payment
  IF v_payment.reversal_status = 'reversal_approved' THEN
    RAISE EXCEPTION 'This payment has already been reversed';
  END IF;

  IF v_payment.reversal_status = 'reversal_requested' THEN
    RAISE EXCEPTION 'A reversal request is already pending for this payment';
  END IF;

  -- Create reversal request
  INSERT INTO public.reversal_requests (
    school_id, fee_payment_id, requested_by, reason
  ) VALUES (
    v_school_id, p_fee_payment_id, auth.uid(), trim(p_reason)
  )
  RETURNING id INTO v_request_id;

  -- Mark payment as reversal requested
  UPDATE public.fee_payments
  SET
    reversal_status       = 'reversal_requested',
    reversal_reason       = trim(p_reason),
    reversal_requested_by = auth.uid(),
    reversal_requested_at = now()
  WHERE id = p_fee_payment_id;

  -- Audit log
  INSERT INTO public.fee_audit_trail (
    school_id, actor_id, actor_role, event_type,
    student_id, fee_payment_id, notes
  )
  SELECT
    v_school_id,
    auth.uid(),
    p.role,
    'reversal_requested',
    v_payment.student_id,
    p_fee_payment_id,
    trim(p_reason)
  FROM public.profiles p WHERE p.id = auth.uid();

  RETURN QUERY SELECT v_request_id;

END;
$$;

REVOKE ALL ON FUNCTION public.request_payment_reversal(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_payment_reversal(UUID, TEXT) TO authenticated;


-- ============================================================
-- PART J: approve_payment_reversal()
-- ADMIN ONLY. Creates a counter-payment that zeroes the original.
-- The original payment row is NEVER modified (immutable).
-- The due's amount_paid is decremented, balance restored.
-- ============================================================

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
  v_school_id     UUID;
  v_request       RECORD;
  v_payment       RECORD;
  v_due           RECORD;
  v_counter_id    UUID;
  v_new_paid      NUMERIC(10,2);
  v_new_status    TEXT;
BEGIN

  -- ADMIN ONLY
  SELECT p.school_id INTO v_school_id
  FROM public.profiles p
  WHERE p.id        = auth.uid()
    AND p.role      = 'school_admin'
    AND p.is_active = true;

  IF v_school_id IS NULL THEN
    RAISE EXCEPTION 'Access denied — school_admin role required for reversal approval';
  END IF;

  -- Load request
  SELECT * INTO v_request
  FROM public.reversal_requests
  WHERE id        = p_request_id
    AND school_id = v_school_id
    AND status    = 'pending';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reversal request not found or already processed';
  END IF;

  -- Load original payment
  SELECT * INTO v_payment
  FROM public.fee_payments
  WHERE id = v_request.fee_payment_id;

  -- Load due
  SELECT * INTO v_due
  FROM public.fee_dues
  WHERE id = v_payment.fee_due_id;

  -- Create counter-payment (negative amount reverses the original)
  INSERT INTO public.fee_payments (
    school_id, student_id, fee_due_id,
    amount_paid, payment_method, receipt_number,
    paid_date, collected_by, notes,
    reversal_status
  ) VALUES (
    v_school_id,
    v_payment.student_id,
    v_payment.fee_due_id,
    -(v_payment.amount_paid),      -- negative amount = reversal
    v_payment.payment_method,
    'REV-' || v_payment.receipt_number,
    CURRENT_DATE,
    auth.uid(),
    'REVERSAL of ' || v_payment.receipt_number || COALESCE(': ' || p_admin_notes, ''),
    'reversal_approved'
  )
  RETURNING id INTO v_counter_id;

  -- Decrement due's amount_paid and recompute status
  v_new_paid := v_due.amount_paid - v_payment.amount_paid;
  v_new_paid := GREATEST(v_new_paid, 0);  -- floor at 0

  v_new_status := CASE
    WHEN v_new_paid <= 0                THEN 'unpaid'
    WHEN v_new_paid >= v_due.total_due  THEN 'paid'
    ELSE                                     'partial'
  END;

  UPDATE public.fee_dues
  SET
    amount_paid = v_new_paid,
    status      = v_new_status,
    updated_at  = now()
  WHERE id = v_due.id;

  -- Mark original payment as reversed, link counter-payment
  UPDATE public.fee_payments
  SET
    reversal_status    = 'reversal_approved',
    reversed_by        = auth.uid(),
    reversed_at        = now(),
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

  -- Audit log
  INSERT INTO public.fee_audit_trail (
    school_id, actor_id, actor_role, event_type,
    student_id, fee_payment_id, notes
  )
  SELECT
    v_school_id, auth.uid(), p.role, 'reversal_approved',
    v_payment.student_id, v_request.fee_payment_id,
    p_admin_notes
  FROM public.profiles p WHERE p.id = auth.uid();

  RETURN QUERY SELECT v_counter_id;

END;
$$;

REVOKE ALL ON FUNCTION public.approve_payment_reversal(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approve_payment_reversal(UUID, TEXT) TO authenticated;


-- ============================================================
-- PART K: reject_payment_reversal() — admin rejects
-- ============================================================

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

  -- ADMIN ONLY
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

  -- Close request as rejected
  UPDATE public.reversal_requests
  SET
    status      = 'rejected',
    reviewed_by = auth.uid(),
    reviewed_at = now(),
    admin_notes = trim(p_admin_notes)
  WHERE id = p_request_id;

  -- Clear reversal_requested flag on original payment
  UPDATE public.fee_payments
  SET
    reversal_status = 'reversal_rejected'
  WHERE id = v_request.fee_payment_id;

  -- Audit
  INSERT INTO public.fee_audit_trail (
    school_id, actor_id, actor_role, event_type,
    fee_payment_id, notes
  )
  SELECT
    v_school_id, auth.uid(), p.role, 'reversal_rejected',
    v_request.fee_payment_id, trim(p_admin_notes)
  FROM public.profiles p WHERE p.id = auth.uid();

END;
$$;

REVOKE ALL ON FUNCTION public.reject_payment_reversal(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reject_payment_reversal(UUID, TEXT) TO authenticated;


-- ============================================================
-- PART L: submit_eod_closure()
-- Collector submits physical cash count.
-- System computes expected cash from fee_payments (cash only, today).
-- Variance auto-calculated. Admin notified separately (via WA/email).
-- ============================================================

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
  v_school_id        UUID;
  v_actor_id         UUID;
  v_system_cash      NUMERIC(10,2);
  v_closure_id       UUID;
BEGIN

  -- Collector or admin
  SELECT p.id, p.school_id INTO v_actor_id, v_school_id
  FROM public.profiles p
  WHERE p.id        = auth.uid()
    AND p.role      IN ('school_admin', 'collector')
    AND p.is_active = true;

  IF v_school_id IS NULL THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  IF p_physical_cash_count < 0 THEN
    RAISE EXCEPTION 'Physical cash count cannot be negative';
  END IF;

  -- Compute system expected: all cash payments today by this collector
  SELECT COALESCE(SUM(fp.amount_paid), 0) INTO v_system_cash
  FROM public.fee_payments fp
  WHERE fp.school_id     = v_school_id
    AND fp.collected_by  = v_actor_id
    AND fp.paid_date     = CURRENT_DATE
    AND fp.payment_method = 'cash'
    AND (fp.reversal_status IS NULL OR fp.reversal_status = 'reversal_requested');
    -- Exclude already-reversed payments from expected cash

  -- Insert EOD closure
  INSERT INTO public.eod_closures (
    school_id, collector_id, closure_date,
    system_cash_total, physical_cash_count, notes
  ) VALUES (
    v_school_id, v_actor_id, CURRENT_DATE,
    v_system_cash, p_physical_cash_count, p_notes
  )
  RETURNING id INTO v_closure_id;

  -- Audit log
  INSERT INTO public.fee_audit_trail (
    school_id, actor_id, actor_role, event_type,
    original_value, submitted_value, notes
  )
  SELECT
    v_school_id, auth.uid(), p.role, 'eod_submitted',
    v_system_cash, p_physical_cash_count, p_notes
  FROM public.profiles p WHERE p.id = auth.uid();

  RETURN QUERY
  SELECT v_closure_id, v_system_cash, (p_physical_cash_count - v_system_cash);

END;
$$;

REVOKE ALL ON FUNCTION public.submit_eod_closure(NUMERIC, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_eod_closure(NUMERIC, TEXT) TO authenticated;


-- ============================================================
-- PART M: log_fee_audit_event() — client calls this on key UI actions
-- e.g. student_loaded, late_fee_waived, discount_applied
-- ============================================================

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

REVOKE ALL ON FUNCTION public.log_fee_audit_event(TEXT, UUID, UUID, UUID, NUMERIC, NUMERIC, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_fee_audit_event(TEXT, UUID, UUID, UUID, NUMERIC, NUMERIC, TEXT, TEXT, TEXT) TO authenticated;


-- ============================================================
-- PART N: INDEXES on new tables
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_fee_audit_school_actor
  ON public.fee_audit_trail(school_id, actor_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_fee_audit_student
  ON public.fee_audit_trail(student_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_fee_audit_event
  ON public.fee_audit_trail(school_id, event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_eod_school_date
  ON public.eod_closures(school_id, closure_date DESC);

CREATE INDEX IF NOT EXISTS idx_reversal_school_status
  ON public.reversal_requests(school_id, status, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_reversal_payment
  ON public.reversal_requests(fee_payment_id);


-- ============================================================
-- PART O: RLS on new tables
-- ============================================================

ALTER TABLE public.fee_audit_trail    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.eod_closures       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reversal_requests  ENABLE ROW LEVEL SECURITY;

-- fee_audit_trail: admin sees all for school; collector sees only their own
DROP POLICY IF EXISTS "school_admin_sees_audit_trail" ON public.fee_audit_trail;
CREATE POLICY "school_admin_sees_audit_trail"
  ON public.fee_audit_trail FOR SELECT
  USING (
    school_id IN (
      SELECT p.school_id FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'school_admin' AND p.is_active = true
    )
  );

DROP POLICY IF EXISTS "collector_sees_own_audit" ON public.fee_audit_trail;
CREATE POLICY "collector_sees_own_audit"
  ON public.fee_audit_trail FOR SELECT
  USING (
    actor_id = auth.uid()
    AND school_id IN (
      SELECT p.school_id FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'collector' AND p.is_active = true
    )
  );

-- eod_closures: admin sees all; collector sees own
DROP POLICY IF EXISTS "school_admin_sees_eod" ON public.eod_closures;
CREATE POLICY "school_admin_sees_eod"
  ON public.eod_closures FOR ALL
  USING (
    school_id IN (
      SELECT p.school_id FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'school_admin' AND p.is_active = true
    )
  );

DROP POLICY IF EXISTS "collector_sees_own_eod" ON public.eod_closures;
CREATE POLICY "collector_sees_own_eod"
  ON public.eod_closures FOR ALL
  USING (
    collector_id = auth.uid()
    AND school_id IN (
      SELECT p.school_id FROM public.profiles p
      WHERE p.id = auth.uid() AND p.is_active = true
    )
  );

-- reversal_requests: admin sees all; collector sees own requests
DROP POLICY IF EXISTS "school_admin_sees_reversals" ON public.reversal_requests;
CREATE POLICY "school_admin_sees_reversals"
  ON public.reversal_requests FOR ALL
  USING (
    school_id IN (
      SELECT p.school_id FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'school_admin' AND p.is_active = true
    )
  );

DROP POLICY IF EXISTS "collector_sees_own_reversals" ON public.reversal_requests;
CREATE POLICY "collector_sees_own_reversals"
  ON public.reversal_requests FOR SELECT
  USING (
    requested_by = auth.uid()
    AND school_id IN (
      SELECT p.school_id FROM public.profiles p
      WHERE p.id = auth.uid() AND p.is_active = true
    )
  );


-- ============================================================
-- VERIFICATION QUERIES
-- ============================================================
--
-- 1. Confirm new role accepted:
--    SELECT DISTINCT role FROM public.profiles;
--
-- 2. Confirm fee_payments reversal columns:
--    SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'fee_payments'
--    AND column_name LIKE 'reversal%';
--
-- 3. Confirm new tables:
--    SELECT table_name FROM information_schema.tables
--    WHERE table_schema = 'public'
--    AND table_name IN (
--      'fee_audit_trail', 'eod_closures', 'reversal_requests'
--    );
--
-- 4. Confirm new RPCs:
--    SELECT routine_name FROM information_schema.routines
--    WHERE routine_schema = 'public'
--    AND routine_name IN (
--      'request_payment_reversal',
--      'approve_payment_reversal',
--      'reject_payment_reversal',
--      'submit_eod_closure',
--      'log_fee_audit_event',
--      'get_student_billing_summary'
--    );
--
-- 5. Test waiver cap is set on schools:
--    SELECT name, late_fee_waiver_max_pct, late_fee_waiver_max_flat
--    FROM public.schools;
-- ============================================================

