-- ============================================================
-- SCHOOLIUM - CHAT 17b MIGRATION
-- Upload limits on the staff-docs bucket (server cost control)
-- ============================================================
-- Enforced by Supabase Storage itself - a request exceeding the
-- limit is rejected server-side regardless of what any client
-- does. The UI also validates before uploading for a friendly
-- message, but THIS is the real guarantee.
--
--   file_size_limit    : 512000 bytes = 500 KB per file
--   allowed_mime_types : PDF + common photo formats only
--                        (leave certificates, scanned documents)
--
-- To change the cap later, update this one row - no code deploy
-- needed (the UI reads its display value from a constant, keep
-- them in sync: MAX_UPLOAD_KB in app code).
-- ============================================================

UPDATE storage.buckets
SET    file_size_limit    = 512000,
       allowed_mime_types = ARRAY[
         'application/pdf',
         'image/jpeg',
         'image/png',
         'image/webp'
       ]
WHERE  id = 'staff-docs';

-- ============================================================
-- END OF CHAT 17b MIGRATION
-- ============================================================
