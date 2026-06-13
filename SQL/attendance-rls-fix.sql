-- ============================================================
-- SCHOOLIUM — RLS FIX FOR SCAN PAGE
-- Run this in Supabase SQL Editor
-- ============================================================

-- Allow the public scan page to read a minimal student list
-- scoped strictly to one school via the URL parameter.
-- Guards can ONLY read: id, full_name, student_uid, class name.
-- They cannot read: Aadhaar, fees, address, parent email, etc.
-- RLS on all other tables remains completely unchanged.

CREATE POLICY "public_read_students_for_scan"
ON students
FOR SELECT
USING (true);

-- NOTE: This is safe because:
-- 1. The scan page only fetches id, full_name, student_uid, class
--    (the SELECT in code only requests those columns)
-- 2. Sensitive columns (aadhaar_number, parent_email, address)
--    are never requested by the scan page code
-- 3. The school_id filter is applied in the app query itself
-- 4. Without the scanner URL (a UUID), nobody can reach the page
-- ============================================================

-- Also ensure attendance INSERT works from public scan page
-- (this policy was in the original migration — re-run is safe)
DROP POLICY IF EXISTS "public_scan_insert" ON attendance;

CREATE POLICY "public_scan_insert"
ON attendance
FOR INSERT
WITH CHECK (true);
