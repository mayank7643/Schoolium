-- ============================================================
-- SCHOOLIUM — ATTENDANCE ENTRY TYPE MIGRATION
-- Run this ONCE in Supabase SQL Editor
--
-- WHAT THIS DOES:
--   1. Adds entry_type column ('entry' | 'exit') to attendance
--   2. Drops old unique constraint (school_id, student_id, scan_date)
--   3. Replaces with   (school_id, student_id, scan_date, entry_type)
--      → allows one entry row + one exit row per student per day
--      → still blocks duplicate entry scans and duplicate exit scans
-- ============================================================


-- STEP 1: Add entry_type column
-- Default 'entry' so all existing rows are correctly classified
ALTER TABLE attendance
  ADD COLUMN IF NOT EXISTS entry_type TEXT NOT NULL DEFAULT 'entry'
  CHECK (entry_type IN ('entry', 'exit'));


-- STEP 2: Drop the old unique constraint
-- (school_id, student_id, scan_date) was one scan per student per day — too strict
DROP INDEX IF EXISTS attendance_unique_per_day;


-- STEP 3: New unique constraint allows entry + exit on same day
-- but still prevents duplicate entry scans or duplicate exit scans
CREATE UNIQUE INDEX IF NOT EXISTS attendance_unique_per_day_and_type
  ON attendance (school_id, student_id, scan_date, entry_type);


-- ============================================================
-- VERIFY — run after migration:
--
-- 1. Confirm column exists with correct check constraint:
--    SELECT column_name, column_default, is_nullable
--    FROM information_schema.columns
--    WHERE table_name = 'attendance' AND column_name = 'entry_type';
--
-- 2. Confirm new unique index:
--    SELECT indexname, indexdef FROM pg_indexes
--    WHERE tablename = 'attendance';
--
-- 3. Confirm old index is gone:
--    -- attendance_unique_per_day should NOT appear above
-- ============================================================
