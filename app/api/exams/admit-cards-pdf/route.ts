// FILE: app/api/exams/admit-cards-pdf/route.ts
// Renders admit cards as an A4 PDF (1/2/3/4-up). Auth is the caller's
// own session - RLS scopes every read (admins, principals, teachers of
// the class and receptionists can print; see admit_cards policies).
// After a successful render the print is recorded via
// record_admit_card_print (permission-checked in the DB).

import { createClient } from '@/utils/supabase/server'
import QRCode from 'qrcode'
import { renderAdmitCardsPdfBuffer, AdmitCardData, AdmitCardsDoc } from '@/app/lib/admitCardPdf'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const MAX_CARDS = 500
const LAYOUTS = ['single', 'two_per_a4', 'three_per_a4', 'four_per_a4'] as const
type Layout = (typeof LAYOUTS)[number]

interface Body {
  exam_id?: string
  class_id?: string | null
  student_ids?: string[] | null
  layout?: Layout
}

function bad(message: string, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status, headers: { 'Content-Type': 'application/json' },
  })
}

function fmtDate(d: string): string {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

function fmtTime(t: string | null): string {
  if (!t) return '-'
  const [h, m] = t.split(':').map(Number)
  const hr = h % 12 === 0 ? 12 : h % 12
  return `${hr}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return bad('Not authenticated', 401)

  let body: Body
  try { body = await req.json() } catch { return bad('Invalid request body') }
  if (!body.exam_id) return bad('exam_id is required')
  const layout: Layout = LAYOUTS.includes(body.layout as Layout) ? (body.layout as Layout) : 'single'

  // Exam + session + school branding (all RLS-scoped)
  const { data: exam, error: examErr } = await supabase
    .from('exams')
    .select('id, name, start_date, end_date, general_instructions, academic_sessions(name), schools(name, address, logo_url)')
    .eq('id', body.exam_id)
    .single()
  if (examErr || !exam) return bad('Exam not found', 404)

  // Live admit cards joined to enrollment + student + class
  let cardsQuery = supabase
    .from('admit_cards')
    .select(`id, qr_token,
      exam_enrollments!inner(id, roll_number, seat_number, class_id, student_id, status,
        students(full_name, student_uid, photo_url),
        classes(name, section))`)
    .eq('exam_id', body.exam_id)
    .eq('is_revoked', false)
  if (body.class_id) cardsQuery = cardsQuery.eq('exam_enrollments.class_id', body.class_id)
  if (body.student_ids && body.student_ids.length > 0) {
    cardsQuery = cardsQuery.in('exam_enrollments.student_id', body.student_ids)
  }
  const { data: cards, error: cardsErr } = await cardsQuery
  if (cardsErr) return bad(cardsErr.message)
  if (!cards || cards.length === 0) return bad('No admit cards found - generate them first', 404)
  if (cards.length > MAX_CARDS) {
    return bad(`Too many cards in one request (${cards.length}). Print class by class (max ${MAX_CARDS}).`)
  }

  // Timetable per class (for the schedule table)
  const { data: papers } = await supabase
    .from('exam_subjects')
    .select('class_id, exam_date, start_time, is_cancelled, subjects(name), exam_rooms(name)')
    .eq('exam_id', body.exam_id)
    .order('exam_date')

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const scheduleFor = (classId: string) =>
    ((papers ?? []) as any[])
      .filter(p => p.class_id === classId && !p.is_cancelled && p.exam_date)
      .map(p => ({
        date: fmtDate(p.exam_date),
        time: fmtTime(p.start_time),
        subject: p.subjects?.name ?? '-',
        room: p.exam_rooms?.name ?? '',
      }))

  const verifyBase = `${new URL(req.url).origin}/verify/admit-card`
  const cardData: AdmitCardData[] = await Promise.all(
    (cards as any[]).map(async c => {
      const ee = c.exam_enrollments
      return {
        studentName: ee?.students?.full_name ?? '-',
        studentUid: ee?.students?.student_uid ?? '',
        classLabel: ee?.classes ? `${ee.classes.name}${ee.classes.section ? '-' + ee.classes.section : ''}` : '-',
        rollNumber: ee?.roll_number ?? 0,
        seatNumber: ee?.seat_number ?? '',
        photoUrl: ee?.students?.photo_url ?? null,
        qrDataUrl: await QRCode.toDataURL(`${verifyBase}/${c.qr_token}`, { margin: 0, width: 160 }),
        schedule: scheduleFor(ee?.class_id),
      }
    })
  )
  // stable print order: class then roll
  cardData.sort((a, b) => a.classLabel.localeCompare(b.classLabel) || a.rollNumber - b.rollNumber)

  const ex = exam as any
  const doc: AdmitCardsDoc = {
    schoolName: ex.schools?.name ?? 'School',
    schoolAddress: ex.schools?.address ?? '',
    logoUrl: ex.schools?.logo_url ?? null,
    examName: ex.name,
    sessionName: ex.academic_sessions?.name ?? '',
    examWindow: ex.start_date ? `${fmtDate(ex.start_date)} - ${fmtDate(ex.end_date)}` : 'See schedule',
    reportingNote: 'Report at the reporting time printed for each paper.',
    instructions: ex.general_instructions ?? '',
    layout,
    cards: cardData,
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const buffer = await renderAdmitCardsPdfBuffer(doc)

  // record the print (DB checks the admit_cards.print permission)
  await supabase.rpc('record_admit_card_print', {
    p_admit_card_ids: (cards as Array<{ id: string }>).map(c => c.id),
  })

  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="admit-cards-${ex.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.pdf"`,
    },
  })
}
