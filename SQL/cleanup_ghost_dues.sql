-- =============================================================================
-- Cleanup of ghost / duplicate manual dues left behind by the old bug.
-- Run this AFTER fee_module_fix.sql and AFTER confirming a payment works.
-- Pure ASCII. Run STEP A first, eyeball the rows, then run STEP B.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- STEP A. PREVIEW ONLY (read-only). Shows manual dues that are duplicated for
-- the same student + label + amount. rn = 1 is the original (kept). rn >= 2 are
-- the extras. has_payment = true means money is attached -- those are NEVER
-- deleted, they only show up so you can see them.
-- -----------------------------------------------------------------------------
SELECT
  d.id,
  d.student_id,
  d.label,
  d.total_due,
  d.amount_paid,
  d.status,
  d.created_at,
  ROW_NUMBER() OVER (
    PARTITION BY d.student_id, d.label, d.total_due
    ORDER BY d.created_at
  ) AS rn,
  EXISTS (
    SELECT 1 FROM public.fee_payments p WHERE p.fee_due_id = d.id
  ) AS has_payment
FROM public.fee_dues d
WHERE d.source = 'manual'
ORDER BY d.student_id, d.label, d.total_due, d.created_at;


-- -----------------------------------------------------------------------------
-- STEP B. DELETE the duplicates only. Guards:
--   - source = 'manual'      (never touch structured/auto-generated dues)
--   - rn >= 2                (keep the earliest of each duplicate group)
--   - amount_paid = 0        (never touch a due that has money against it)
--   - status = 'unpaid'
--   - no fee_payments rows point at it
-- Run STEP A first and make sure the rows it would remove are the ghosts you
-- expect (Hgbb / Htyg / Exam pairs, Gfv / V. test rows) before running this.
-- -----------------------------------------------------------------------------
WITH ranked AS (
  SELECT
    d.id,
    ROW_NUMBER() OVER (
      PARTITION BY d.student_id, d.label, d.total_due
      ORDER BY d.created_at
    ) AS rn,
    EXISTS (
      SELECT 1 FROM public.fee_payments p WHERE p.fee_due_id = d.id
    ) AS has_payment
  FROM public.fee_dues d
  WHERE d.source = 'manual'
    AND d.amount_paid = 0
    AND d.status = 'unpaid'
)
DELETE FROM public.fee_dues
WHERE id IN (
  SELECT id FROM ranked
  WHERE rn >= 2
    AND has_payment = false
);
