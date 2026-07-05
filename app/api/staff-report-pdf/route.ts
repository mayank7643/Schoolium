// FILE: app/api/staff-report-pdf/route.ts
//
// Builds one of five staff report PDFs (chat17 Module 8) and returns
// it as a download. Caller must be an active school_admin/principal;
// all data is read with the CALLER'S session so RLS applies on top.
//   type: directory | attendance | leave | department | assignments
//   month: YYYY-MM (attendance, leave)
//   status: pending|approved|rejected|cancelled|all (leave)

import { createClient } from '@/utils/supabase/server'
import { renderStaffReportPdfBuffer, StaffReportDoc, ReportColumn } from '@/app/lib/staffReportPdf'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const TYPES = ['directory', 'attendance', 'leave', 'department', 'assignments'] as const
type ReportType = (typeof TYPES)[number]

function bad(message: string, status = 400) {
  return new Response(JSON.stringify({ error: message }), { status })
}

function fmtDate(d: string | null) {
  return d ? new Date(d).toLocaleDateString('en-IN') : ''
}

function monthLabel(m: string) {
  return new Date(m + '-01').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
}

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return bad('unauthorized', 401)

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, is_active, schools(name)')
    .eq('id', user.id)
    .single()

  if (!profile?.is_active || !['school_admin', 'principal'].includes(profile.role)) {
    return bad('Only a school admin or principal can generate reports', 403)
  }
  const schoolName = ((profile as any)?.schools?.name as string) || 'School'

  let body: { type?: string; month?: string; status?: string } = {}
  try { body = await req.json() } catch { /* defaults */ }

  const type = (body.type ?? '') as ReportType
  if (!TYPES.includes(type)) return bad('invalid report type')

  const month = /^\d{4}-\d{2}$/.test(body.month ?? '')
    ? (body.month as string)
    : new Date().toISOString().slice(0, 7)
  const monthStart = `${month}-01`
  const monthEndDate = new Date(new Date(monthStart).getFullYear(), new Date(monthStart).getMonth() + 1, 0)
  const monthEnd = monthEndDate.toISOString().split('T')[0]

  const generatedAt = new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })

  let title = ''
  let subtitle = ''
  let columns: ReportColumn[] = []
  let rows: Record<string, string>[] = []
  let summary: { label: string; value: string }[] = []

  // ── DIRECTORY ────────────────────────────────────────────────
  if (type === 'directory') {
    const { data } = await supabase
      .from('staff')
      .select('employee_id, full_name, designation, department, mobile, employment_status, joining_date')
      .order('department')
      .order('full_name')

    const staff = (data ?? []) as any[]
    title = 'Staff Directory'
    subtitle = 'All staff'
    columns = [
      { key: 'emp', label: 'Emp ID', width: 55 },
      { key: 'name', label: 'Name', width: 125 },
      { key: 'designation', label: 'Designation', width: 100 },
      { key: 'department', label: 'Department', width: 85 },
      { key: 'mobile', label: 'Mobile', width: 70 },
      { key: 'status', label: 'Status', width: 55 },
      { key: 'joined', label: 'Joined', width: 49 },
    ]
    rows = staff.map(s => ({
      emp: s.employee_id, name: s.full_name, designation: s.designation,
      department: s.department, mobile: s.mobile,
      status: String(s.employment_status).replace('_', ' '),
      joined: fmtDate(s.joining_date),
    }))
    const active = staff.filter(s => ['active', 'probation', 'on_leave'].includes(s.employment_status)).length
    summary = [
      { label: 'Total', value: String(staff.length) },
      { label: 'Active', value: String(active) },
      { label: 'Former', value: String(staff.length - active) },
    ]
  }

  // ── ATTENDANCE (monthly) ─────────────────────────────────────
  if (type === 'attendance') {
    const { data, error } = await supabase.rpc('get_staff_attendance_summary', { p_month: month })
    if (error) return bad(error.message)
    const rws = (data ?? []) as any[]
    title = 'Staff Attendance Report'
    subtitle = monthLabel(month)
    columns = [
      { key: 'emp', label: 'Emp ID', width: 55 },
      { key: 'name', label: 'Name', width: 125 },
      { key: 'department', label: 'Department', width: 85 },
      { key: 'p', label: 'P', width: 32, align: 'center' },
      { key: 'l', label: 'L', width: 32, align: 'center' },
      { key: 'h', label: 'H', width: 32, align: 'center' },
      { key: 'a', label: 'A', width: 32, align: 'center' },
      { key: 'lv', label: 'Lv', width: 32, align: 'center' },
      { key: 'days', label: 'Days', width: 40, align: 'center' },
      { key: 'pct', label: '%', width: 44, align: 'right' },
    ]
    rows = rws.map(r => ({
      emp: r.employee_id, name: r.full_name, department: r.department,
      p: String(r.present_days), l: String(r.late_days), h: String(r.half_days),
      a: String(r.absent_days), lv: String(r.leave_days),
      days: String(r.working_days), pct: `${r.percentage}%`,
    }))
    summary = [
      { label: 'Staff', value: String(rws.length) },
      { label: 'Working days', value: String(rws[0]?.working_days ?? 0) },
    ]
  }

  // ── LEAVE ────────────────────────────────────────────────────
  if (type === 'leave') {
    const status = ['pending', 'approved', 'rejected', 'cancelled'].includes(body.status ?? '')
      ? (body.status as string) : null

    let q = supabase
      .from('leave_requests')
      .select('leave_type, from_date, to_date, total_days, reason, status, admin_comment, staff(full_name, employee_id)')
      .gte('from_date', monthStart)
      .lte('from_date', monthEnd)
      .order('from_date')
    if (status) q = q.eq('status', status)

    const { data } = await q
    const reqs = ((data ?? []) as any[]).map(r => ({
      ...r, staff: Array.isArray(r.staff) ? r.staff[0] ?? null : r.staff,
    }))

    title = 'Leave Report'
    subtitle = `${monthLabel(month)}${status ? ` - ${status}` : ''}`
    columns = [
      { key: 'name', label: 'Name', width: 110 },
      { key: 'emp', label: 'Emp ID', width: 52 },
      { key: 'type', label: 'Type', width: 48 },
      { key: 'from', label: 'From', width: 58 },
      { key: 'to', label: 'To', width: 58 },
      { key: 'days', label: 'Days', width: 34, align: 'center' },
      { key: 'status', label: 'Status', width: 52 },
      { key: 'reason', label: 'Reason / comment', width: 127 },
    ]
    rows = reqs.map(r => ({
      name: r.staff?.full_name ?? '', emp: r.staff?.employee_id ?? '',
      type: r.leave_type, from: fmtDate(r.from_date), to: fmtDate(r.to_date),
      days: String(r.total_days), status: r.status,
      reason: r.admin_comment ? `${r.reason} / ${r.admin_comment}` : r.reason,
    }))
    const approvedDays = reqs.filter(r => r.status === 'approved')
      .reduce((s, r) => s + Number(r.total_days), 0)
    summary = [
      { label: 'Requests', value: String(reqs.length) },
      { label: 'Approved days', value: String(approvedDays) },
      { label: 'Pending', value: String(reqs.filter(r => r.status === 'pending').length) },
    ]
  }

  // ── DEPARTMENT ───────────────────────────────────────────────
  if (type === 'department') {
    const { data } = await supabase
      .from('staff')
      .select('department, is_teaching, employment_status')

    const staff = (data ?? []) as any[]
    const active = staff.filter(s => ['active', 'probation', 'on_leave'].includes(s.employment_status))
    const byDept = new Map<string, { total: number; teaching: number; nonTeaching: number }>()
    active.forEach(s => {
      const d = byDept.get(s.department) ?? { total: 0, teaching: 0, nonTeaching: 0 }
      d.total += 1
      if (s.is_teaching) d.teaching += 1; else d.nonTeaching += 1
      byDept.set(s.department, d)
    })

    title = 'Department Report'
    subtitle = 'Active staff by department'
    columns = [
      { key: 'department', label: 'Department', width: 220 },
      { key: 'total', label: 'Staff', width: 90, align: 'center' },
      { key: 'teaching', label: 'Teaching', width: 115, align: 'center' },
      { key: 'non', label: 'Non-teaching', width: 114, align: 'center' },
    ]
    rows = Array.from(byDept.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([dept, d]) => ({
        department: dept, total: String(d.total),
        teaching: String(d.teaching), non: String(d.nonTeaching),
      }))
    summary = [
      { label: 'Departments', value: String(byDept.size) },
      { label: 'Active staff', value: String(active.length) },
    ]
  }

  // ── TEACHER ASSIGNMENTS ─────────────────────────────────────
  if (type === 'assignments') {
    const [staffRes, ctRes, saRes] = await Promise.all([
      supabase.from('staff')
        .select('id, full_name, employee_id')
        .eq('is_teaching', true)
        .in('employment_status', ['active', 'probation', 'on_leave'])
        .order('full_name'),
      supabase.from('class_teachers').select('staff_id, classes(name, section)'),
      supabase.from('subject_assignments').select('staff_id, subjects(name), classes(name, section)'),
    ])

    const teachers = (staffRes.data ?? []) as any[]
    const one = (v: any) => (Array.isArray(v) ? v[0] ?? null : v)
    const clsLabel = (c: any) => (c ? `${c.name}${c.section ? `-${c.section}` : ''}` : '')

    const ctMap = new Map<string, string[]>()
    ;((ctRes.data ?? []) as any[]).forEach(r => {
      const label = clsLabel(one(r.classes))
      if (!label) return
      ctMap.set(r.staff_id, [...(ctMap.get(r.staff_id) ?? []), label])
    })

    const saMap = new Map<string, string[]>()
    ;((saRes.data ?? []) as any[]).forEach(r => {
      const sub = one(r.subjects)?.name
      const label = clsLabel(one(r.classes))
      if (!sub || !label) return
      saMap.set(r.staff_id, [...(saMap.get(r.staff_id) ?? []), `${sub} > ${label}`])
    })

    title = 'Teacher Assignment Report'
    subtitle = 'Class teachers and subject allocations'
    columns = [
      { key: 'name', label: 'Teacher', width: 110 },
      { key: 'emp', label: 'Emp ID', width: 52 },
      { key: 'classTeacher', label: 'Class teacher of', width: 110 },
      { key: 'subjects', label: 'Subjects', width: 267 },
    ]
    rows = teachers.map(t => ({
      name: t.full_name, emp: t.employee_id,
      classTeacher: (ctMap.get(t.id) ?? []).sort().join(', ') || '-',
      subjects: (saMap.get(t.id) ?? []).sort().join(', ') || '-',
    }))
    const unassigned = teachers.filter(t => !ctMap.has(t.id) && !saMap.has(t.id)).length
    summary = [
      { label: 'Teachers', value: String(teachers.length) },
      { label: 'Unassigned', value: String(unassigned) },
    ]
  }

  const doc: StaffReportDoc = { schoolName, title, subtitle, generatedAt, summary, columns, rows }
  const buffer = await renderStaffReportPdfBuffer(doc)

  const fname = `${type}-report${type === 'attendance' || type === 'leave' ? `-${month}` : ''}.pdf`
  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${fname}"`,
    },
  })
}
