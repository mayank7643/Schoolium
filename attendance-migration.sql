-- ============================================================
-- SCHOOLIUM — ATTENDANCE MODULE MIGRATION
-- Run this ONCE in Supabase SQL Editor
-- ============================================================

-- 1. Create attendance table
CREATE TABLE IF NOT EXISTS attendance (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id    UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id   UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  scan_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  scan_time    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  gate         TEXT NOT NULL DEFAULT 'Main Gate',
  guard_id     TEXT,         -- guard's user id or name (nullable — no login required)
  exam_id      UUID,         -- nullable FK for future exam-day attendance
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Unique constraint — bulletproof duplicate prevention across all guards/devices
--    INSERT ... ON CONFLICT DO NOTHING means second scan is silently ignored
CREATE UNIQUE INDEX IF NOT EXISTS attendance_unique_per_day
  ON attendance (school_id, student_id, scan_date);

-- 3. Performance indexes
--    Used by: today's attendance dashboard card
CREATE INDEX IF NOT EXISTS idx_attendance_school_date
  ON attendance (school_id, scan_date);

--    Used by: student profile attendance history
CREATE INDEX IF NOT EXISTS idx_attendance_student
  ON attendance (school_id, student_id);

--    Used by: consecutive absence detection
CREATE INDEX IF NOT EXISTS idx_attendance_date_desc
  ON attendance (school_id, scan_date DESC);

-- 4. Enable Row Level Security
ALTER TABLE attendance ENABLE ROW LEVEL SECURITY;

-- 5. RLS policy — school admins can read/write their own school's attendance
CREATE POLICY "school_own_attendance" ON attendance
  FOR ALL USING (
    school_id IN (
      SELECT school_id FROM profiles WHERE id = auth.uid()
    )
  );

-- 6. Public insert policy for the guard scan page (no login required)
--    Guards can only INSERT — they cannot read or delete
CREATE POLICY "public_scan_insert" ON attendance
  FOR INSERT WITH CHECK (true);

-- ============================================================
-- VERIFY — run this after migration to confirm table exists
-- SELECT COUNT(*) FROM attendance;
-- ============================================================
