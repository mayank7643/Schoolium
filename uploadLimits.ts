// FILE: app/lib/uploadLimits.ts
//
// Client-side upload validation constants (chat17 Module 6).
// MUST stay in sync with the staff-docs bucket configuration set in
// chat17b_staff_docs_upload_limit.sql:
//   file_size_limit    = 512000 bytes  -> MAX_UPLOAD_KB = 500
//   allowed_mime_types = pdf/jpeg/png/webp
// The bucket enforces the real limit server-side; these constants
// exist so the UI can reject early with a friendly message instead
// of a failed network request.

export const MAX_UPLOAD_KB = 500

export const ALLOWED_UPLOAD_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
]

export const ALLOWED_UPLOAD_LABEL = 'PDF, JPG, PNG or WebP'

export const UPLOAD_ACCEPT_ATTR = '.pdf,.jpg,.jpeg,.png,.webp'

// Returns an error message, or null if the file is acceptable.
export function validateUpload(file: File): string | null {
  if (!ALLOWED_UPLOAD_TYPES.includes(file.type)) {
    return `Only ${ALLOWED_UPLOAD_LABEL} files are allowed`
  }
  if (file.size > MAX_UPLOAD_KB * 1024) {
    return `File is ${Math.round(file.size / 1024)} KB - the limit is ${MAX_UPLOAD_KB} KB. Compress or take a smaller photo.`
  }
  return null
}
