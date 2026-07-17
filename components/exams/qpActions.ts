// FILE: components/exams/qpActions.ts
// Shared question-paper client actions (used by the admin board and
// the teacher workspace). Upload = register version via RPC, then put
// the PDF at the returned path; download = logged signed URL.

import { createClient } from '@/utils/supabase/client'
import type { RegisterQpUploadResult } from '@/types'

export const QP_MAX_BYTES = 10 * 1024 * 1024

export async function uploadQuestionPaper(
  examSubjectId: string,
  file: File,
  note?: string,
): Promise<{ ok: true; versionNo: number } | { ok: false; error: string }> {
  if (file.type !== 'application/pdf') return { ok: false, error: 'Only PDF files are allowed' }
  if (file.size > QP_MAX_BYTES) return { ok: false, error: 'File too large (max 10 MB)' }

  const supabase = createClient()
  const { data, error } = await supabase.rpc('register_question_paper_upload', {
    p_exam_subject_id: examSubjectId,
    p_file_size: file.size,
    p_note: note ?? null,
  })
  if (error) return { ok: false, error: error.message }

  const reg = data as RegisterQpUploadResult
  const { error: upErr } = await supabase.storage
    .from('question-papers')
    .upload(reg.file_path, file, { contentType: 'application/pdf', upsert: true })
  if (upErr) {
    return { ok: false, error: `Upload failed (${upErr.message}) - try again; a retry creates a fresh version` }
  }
  return { ok: true, versionNo: reg.version_no }
}

export async function downloadQuestionPaper(
  questionPaperId: string,
  versionId?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch('/api/exams/question-paper-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question_paper_id: questionPaperId, version_id: versionId ?? null }),
  })
  if (!res.ok) {
    const j = await res.json().catch(() => ({ error: 'Download failed' }))
    return { ok: false, error: j.error ?? 'Download failed' }
  }
  const { url } = await res.json()
  window.open(url, '_blank', 'noopener')
  return { ok: true }
}
