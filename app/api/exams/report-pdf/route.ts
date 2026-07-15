// FILE: app/api/exams/report-pdf/route.ts
// Tabular exam-report PDFs. Calls the matching analytics RPC (caller
// session, RLS-scoped) and renders via examReportPdf. One route, six
// report types.

import { createClient } from '@/utils/supabase/server'
import { renderExamReportPdfBuffer, ExamReportColumn, ExamReportDoc } from '@/app/lib/examReportPdf'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

type ReportType =
  | 'class_result' | 'subject_performance' | 'topper_list'
  | 'fail_list' | 'grade_distribution' | 'exam_attendance'

function bad(message: string, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status, headers: { 'Content-Type': 'application/json' },
  })
}

const num = (v: unknown) => (v === null || v === undefined ? '—' : String(v))

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return bad('Not authenticated', 401)

  let body: { report?: ReportType; exam_id?: string; class_id?: string | null }
  try { body = await req.json() } catch { return bad('Invalid request body') }
  if (!body.report || !body.exam_id) return bad('report and exam_id are required')

  const [{ data: exam }, { data: prof }] = await Promise.all([
    supabase.from('exams').select('name, academic_sessions(name)').eq('id', body.exam_id).single(),
    supabase.from('profiles').select('schools(name)').eq('id', user.id).single(),
  ])
  if (!exam) return bad('Exam not found', 404)
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const schoolName = ((prof as any)?.schools?.name as string) ?? 'School'
  const examName = (exam as any).name as string

  let columns: ExamReportColumn[] = []
  let rows: Record<string, string>[] = []
  let title = ''
  let summary: { label: string; value: string }[] = []
  const args = { p_exam_id: body.exam_id, p_class_id: body.class_id ?? null }

  if (body.report === 'class_result') {
    const { data, error } = await supabase.rpc('get_class_result_summary', { p_exam_id: body.exam_id })
    if (error) return bad(error.message)
    title = 'Class Result Summary'
    columns = [
      { key: 'class_label', label: 'Class', width: 22 },
      { key: 'students', label: 'Students', width: 14, align: 'center' },
      { key: 'average_pct', label: 'Avg %', width: 14, align: 'center' },
      { key: 'pass_pct', label: 'Pass %', width: 14, align: 'center' },
      { key: 'topper_name', label: 'Topper', width: 24 },
      { key: 'topper_pct', label: 'Top %', width: 12, align: 'center' },
    ]
    rows = ((data ?? []) as any[]).map(r => ({
      class_label: r.class_label, students: num(r.students),
      average_pct: `${num(r.average_pct)}`, pass_pct: `${num(r.pass_pct)}`,
      topper_name: r.topper_name ?? '—', topper_pct: num(r.topper_pct),
    }))
  } else if (body.report === 'subject_performance') {
    const { data, error } = await supabase.rpc('get_subject_performance', args)
    if (error) return bad(error.message)
    title = 'Subject Performance'
    columns = [
      { key: 'subject_name', label: 'Subject', width: 30 },
      { key: 'students', label: 'Students', width: 14, align: 'center' },
      { key: 'average_pct', label: 'Avg %', width: 14, align: 'center' },
      { key: 'pass_pct', label: 'Pass %', width: 14, align: 'center' },
      { key: 'highest', label: 'High', width: 14, align: 'center' },
      { key: 'lowest', label: 'Low', width: 14, align: 'center' },
    ]
    rows = ((data ?? []) as any[]).map(r => ({
      subject_name: r.subject_name, students: num(r.students),
      average_pct: num(r.average_pct), pass_pct: num(r.pass_pct),
      highest: num(r.highest), lowest: num(r.lowest),
    }))
  } else if (body.report === 'topper_list') {
    const { data, error } = await supabase.rpc('get_topper_list', { ...args, p_limit: 25 })
    if (error) return bad(error.message)
    title = 'Topper List'
    columns = [
      { key: 'idx', label: '#', width: 8, align: 'center' },
      { key: 'student_name', label: 'Student', width: 38 },
      { key: 'class_label', label: 'Class', width: 20 },
      { key: 'percentage', label: 'Percentage', width: 20, align: 'center' },
      { key: 'grade_label', label: 'Grade', width: 14, align: 'center' },
    ]
    rows = ((data ?? []) as any[]).map((r, i) => ({
      idx: String(i + 1), student_name: r.student_name, class_label: r.class_label,
      percentage: `${num(r.percentage)}%`, grade_label: r.grade_label ?? '—',
    }))
  } else if (body.report === 'fail_list') {
    const { data, error } = await supabase.rpc('get_fail_list', args)
    if (error) return bad(error.message)
    title = 'Fail Report'
    summary = [{ label: 'Total failed:', value: String((data ?? []).length) }]
    columns = [
      { key: 'roll_number', label: 'Roll', width: 12, align: 'center' },
      { key: 'student_name', label: 'Student', width: 40 },
      { key: 'class_label', label: 'Class', width: 20 },
      { key: 'percentage', label: '%', width: 14, align: 'center' },
      { key: 'subjects_failed', label: 'Subjects failed', width: 14, align: 'center' },
    ]
    rows = ((data ?? []) as any[]).map(r => ({
      roll_number: num(r.roll_number), student_name: r.student_name, class_label: r.class_label,
      percentage: num(r.percentage), subjects_failed: num(r.subjects_failed),
    }))
  } else if (body.report === 'grade_distribution') {
    const { data, error } = await supabase.rpc('get_grade_distribution', args)
    if (error) return bad(error.message)
    title = 'Grade Distribution'
    columns = [
      { key: 'grade_label', label: 'Grade', width: 40 },
      { key: 'student_count', label: 'Students', width: 60, align: 'center' },
    ]
    rows = ((data ?? []) as any[]).map(r => ({
      grade_label: r.grade_label, student_count: num(r.student_count),
    }))
  } else if (body.report === 'exam_attendance') {
    const { data, error } = await supabase.rpc('get_exam_attendance_report', { p_exam_id: body.exam_id })
    if (error) return bad(error.message)
    title = 'Exam Attendance Report'
    columns = [
      { key: 'class_label', label: 'Class', width: 16 },
      { key: 'subject_name', label: 'Subject', width: 24 },
      { key: 'enrolled', label: 'Enr', width: 10, align: 'center' },
      { key: 'present', label: 'P', width: 10, align: 'center' },
      { key: 'late', label: 'L', width: 10, align: 'center' },
      { key: 'absent', label: 'A', width: 10, align: 'center' },
      { key: 'medical', label: 'M', width: 10, align: 'center' },
      { key: 'unmarked', label: '?', width: 10, align: 'center' },
    ]
    rows = ((data ?? []) as any[]).map(r => ({
      class_label: r.class_label, subject_name: r.subject_name, enrolled: num(r.enrolled),
      present: num(r.present), late: num(r.late), absent: num(r.absent),
      medical: num(r.medical), unmarked: num(r.unmarked),
    }))
  } else {
    return bad('Unknown report type')
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const doc: ExamReportDoc = {
    schoolName,
    title,
    subtitle: examName,
    generatedAt: new Date().toLocaleString('en-IN', {
      day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata',
    }),
    summary,
    columns,
    rows,
  }

  const buffer = await renderExamReportPdfBuffer(doc)
  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${body.report}-${examName.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.pdf"`,
    },
  })
}
