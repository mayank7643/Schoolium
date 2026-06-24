-- ============================================================
-- SCHOOLIUM — BATCH 2 MIGRATION
-- Run this ONCE in Supabase SQL Editor
-- ============================================================

-- 1. Add new columns to students table
ALTER TABLE students
  ADD COLUMN IF NOT EXISTS student_uid TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS father_name TEXT,
  ADD COLUMN IF NOT EXISTS mother_name TEXT;

-- 2. Create a counter table for safe sequential IDs (one row per school per year)
CREATE TABLE IF NOT EXISTS student_id_counters (
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  year      SMALLINT NOT NULL,
  counter   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (school_id, year)
);

-- 3. Atomic function that generates the next student ID — race-condition safe
CREATE OR REPLACE FUNCTION generate_student_uid(p_school_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  v_year      SMALLINT;
  v_counter   INTEGER;
  v_prefix    TEXT;
  v_school    TEXT;
BEGIN
  -- Get current year (2-digit)
  v_year := EXTRACT(YEAR FROM NOW())::SMALLINT;

  -- Get school name prefix (first 2 uppercase letters, letters only)
  SELECT UPPER(REGEXP_REPLACE(SUBSTRING(name, 1, 10), '[^A-Za-z]', '', 'g'))
  INTO v_school
  FROM schools
  WHERE id = p_school_id;

  v_prefix := SUBSTRING(v_school, 1, 2);
  IF LENGTH(v_prefix) < 2 THEN
    v_prefix := RPAD(v_prefix, 2, 'X');
  END IF;

  -- Lock + upsert counter atomically (prevents race conditions)
  INSERT INTO student_id_counters (school_id, year, counter)
  VALUES (p_school_id, v_year, 1)
  ON CONFLICT (school_id, year)
  DO UPDATE SET counter = student_id_counters.counter + 1
  RETURNING counter INTO v_counter;

  -- Format: GN-26-0001
  RETURN v_prefix || '-' || LPAD((v_year % 100)::TEXT, 2, '0') || '-' || LPAD(v_counter::TEXT, 4, '0');
END;
$$;

-- 4. Enable RLS on counter table
ALTER TABLE student_id_counters ENABLE ROW LEVEL SECURITY;

-- Allow school admins to use the counter for their school only
CREATE POLICY "school_own_counter" ON student_id_counters
  FOR ALL USING (
    school_id IN (
      SELECT school_id FROM profiles WHERE id = auth.uid()
    )
  );

-- ============================================================
-- DONE. The function generate_student_uid(school_id) is now
-- ready to call from your app via supabase.rpc()
-- ============================================================
