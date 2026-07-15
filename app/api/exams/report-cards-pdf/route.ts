// FILE: app/api/exams/report-cards-pdf/route.ts
// Report-card PDF (single student or class batch), rendered from the
// immutable report_cards.snapshot. Caller session + RLS scope reads
// (admins/principal all; class teachers their class). Embeds the QR of
// qr_token pointing at the public verification page (Phase 8).

import { createClient } from '@/utils/supabase/server'
import QRCode from 'qrcode'
import { renderReportCardsBatchBuffer, ReportCardDoc } from '@/app/lib/reportCardPdf'
import type { ReportCardSnapshot } from '@/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const MAX_CARDS = 300

function bad(message: string, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status, headers: { 'Content-Type': 'application/json' },
  })
}

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return bad('Not authenticated', 401)

  let body: { exam_id?: string; student_id?: string; class_id?: string }
  try { body = await req.json() } catch { return bad('Invalid request body') }
  if (!body.exam_id) return bad('exam_id is required')

  // students!inner join lets us filter a class; RLS still scopes rows.
  let query = supabase
    .from('report_cards')
    .select('qr_token, snapshot, student_id, students!inner(class_id)')
    .eq('exam_id', body.exam_id)
  if (body.student_id) query = query.eq('student_id', body.student_id)
  if (body.class_id) query = query.eq('students.class_id', body.class_id)

  const { data: rows, error } = await query
  if (error) return bad(error.message)
  if (!rows || rows.length === 0) return bad('No report cards found - generate them first', 404)
  if (rows.length > MAX_CARDS) return bad(`Too many cards (${rows.length}). Print class by class (max ${MAX_CARDS}).`)

  const origin = new URL(req.url).origin
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const docs: ReportCardDoc[] = await Promise.all((rows as any[]).map(async row => {
    const snap = row.snapshot as ReportCardSnapshot
    return {
      snapshot: snap,
      qrDataUrl: await QRCode.toDataURL(`${origin}/verify/report-card/${row.qr_token}`, { margin: 0, width: 150 }),
      verifyNote: 'Scan to verify authenticity',
    }
  }))
  /* eslint-enable @typescript-eslint/no-explicit-any */

  docs.sort((a, b) => a.snapshot.student.roll_number - b.snapshot.student.roll_number)

  const buffer = await renderReportCardsBatchBuffer(docs)
  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="report-cards.pdf"',
    },
  })
}
