// FILE: app/(dashboard)/dashboard/TeacherDashboard.tsx
//
// Personal dashboard for teacher / collector / receptionist / other
// staff roles (chat17 Module 7). Server component rendered by the
// dashboard page when the role is not admin/principal. Shows:
//   - today's own attendance status + this month's percentage
//   - assigned classes (class teacher) and subject allocations
//   - latest leave request status + link to My Leave
//   - placeholders for marks entry / upcoming exams (exam module)
// Everything reads through self-scoped RLS and RPCs - a teacher can
// only ever see their own rows here.

import { createClient } from '@/utils/supabase/server'
import Link from 'next/link'
import {
  CalendarCheck, GraduationCap, BookOpen, ClipboardList,
  ArrowRight, FileText, Bell,
} from 'lucide-react'
import type { TeacherAssignments, LeaveRequest } from '@/types'

const ATT_LABEL: Record<string, { label: string; cls: string }> = {
  present:  { label: 'Present',  cls: 'badge-green'  },
  late:     { label: 'Late',     cls: 'badge-yellow' },
  half_day: { label: 'Half day', cls: 'badge-blue'   },
  absent:   { label: 'Absent',   cls: 'badge-red'    },
  leave:    { label: 'On leave', cls: 'badge-yellow' },
}

const LEAVE_BADGE: Record<string, string> = {
  pending: 'badge-yellow', approved: 'badge-green',
  rejected: 'badge-red', cancelled: 'badge-red',
}

// IST calendar date regardless of server timezone
function istToday() {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().split('T')[0]
}

export default async function TeacherDashboard({
  userId,
  schoolName,
}: {
  userId: string
  schoolName: string
}) {
  const supabase = await createClient()

  const { data: staff } = await supabase
    .from('staff')
    .select('id, full_name, designation, employee_id, is_teaching')
    .eq('profile_id', userId)
    .maybeSingle()

  if (!staff) {
    return (
      <div className="max-w-2xl">
        <div className="card">
          <h1 className="text-lg font-semibold text-slate-900 mb-1">Welcome</h1>
          <p className="text-sm text-slate-500">
            No staff record is linked to this account yet. Ask your school admin.
          </p>
        </div>
      </div>
    )
  }

  const today = istToday()
  const month = today.slice(0, 7)

  const [attRes, summaryRes, leavesRes, assignRes] = await Promise.all([
    supabase
      .from('staff_attendance')
      .select('status, check_in_time, check_out_time')
      .eq('staff_id', staff.id)
      .eq('attendance_date', today)
      .maybeSingle(),
    supabase.rpc('get_staff_attendance_summary', { p_month: month }),
    supabase
      .from('leave_requests')
      .select('id, leave_type, from_date, to_date, total_days, status, admin_comment, reviewed_at, created_at')
      .eq('staff_id', staff.id)
      .order('created_at', { ascending: false })
      .limit(5),
    staff.is_teaching
      ? supabase.rpc('get_teacher_assignments', { p_staff_id: staff.id })
      : Promise.resolve({ data: null }),
  ])

  const todayAtt = attRes.data as { status: string; check_in_time: string | null; check_out_time: string | null } | null
  const myMonth = ((summaryRes.data ?? []) as any[]).find(r => r.staff_id === staff.id)
  const leaves = (leavesRes.data ?? []) as any as LeaveRequest[]
  const assignments = (assignRes.data ?? null) as TeacherAssignments | null

  const latestLeave = leaves[0]
  // recent decisions (approved/rejected in the last 14 days) as "notifications"
  const cutoff = Date.now() - 14 * 24 * 3600 * 1000
  const recentDecisions = leaves.filter(l =>
    (l.status === 'approved' || l.status === 'rejected') &&
    l.reviewed_at && new Date(l.reviewed_at).getTime() > cutoff
  )

  const attBadge = todayAtt ? (ATT_LABEL[todayAtt.status] ?? ATT_LABEL.present) : null

  return (
    <div className="max-w-4xl mx-auto">
      {/* Greeting */}
      <div className="mb-6">
        <h1 className="text-xl lg:text-2xl font-bold text-slate-900">
          Hello, {staff.full_name.split(' ')[0]}
        </h1>
        <p className="text-slate-500 text-sm mt-0.5">
          {staff.designation} · {schoolName} ·{' '}
          {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
        </p>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <div className="stat-card">
          <div className="flex items-center gap-2 text-slate-400 text-xs mb-2">
            <CalendarCheck size={14} /> Today
          </div>
          {attBadge ? (
            <div>
              <span className={attBadge.cls}>{attBadge.label}</span>
              {todayAtt?.check_in_time && (
                <p className="text-xs text-slate-400 font-mono mt-1.5">
                  {todayAtt.check_in_time.slice(0, 5)}
                  {todayAtt.check_out_time ? ` - ${todayAtt.check_out_time.slice(0, 5)}` : ''}
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-slate-400">Not marked yet</p>
          )}
        </div>

        <div className="stat-card">
          <div className="flex items-center gap-2 text-slate-400 text-xs mb-2">
            <CalendarCheck size={14} /> This month
          </div>
          <p className="text-2xl font-bold text-slate-900">
            {myMonth ? `${myMonth.percentage}%` : '—'}
          </p>
          <p className="text-xs text-slate-400 mt-0.5">
            {myMonth ? `attendance · ${myMonth.working_days} working days` : 'no records yet'}
          </p>
        </div>

        <div className="stat-card">
          <div className="flex items-center gap-2 text-slate-400 text-xs mb-2">
            <GraduationCap size={14} /> My classes
          </div>
          <p className="text-2xl font-bold text-slate-900">
            {assignments?.class_teacher_of.length ?? 0}
          </p>
          <p className="text-xs text-slate-400 mt-0.5">class teacher of</p>
        </div>

        <div className="stat-card">
          <div className="flex items-center gap-2 text-slate-400 text-xs mb-2">
            <BookOpen size={14} /> Subjects
          </div>
          <p className="text-2xl font-bold text-slate-900">
            {assignments?.subjects.length ?? 0}
          </p>
          <p className="text-xs text-slate-400 mt-0.5">subject allocations</p>
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-5">
        {/* Assignments */}
        {staff.is_teaching && (
          <div className="card lg:col-span-2">
            <h2 className="font-semibold text-slate-800 mb-3">My teaching assignments</h2>
            {assignments && (assignments.class_teacher_of.length > 0 || assignments.subjects.length > 0) ? (
              <div className="flex flex-col gap-3">
                {assignments.class_teacher_of.length > 0 && (
                  <div>
                    <p className="text-xs text-slate-400 mb-1.5">Class teacher of</p>
                    <div className="flex gap-2 flex-wrap">
                      {assignments.class_teacher_of.map(c => (
                        <span key={c.class_id} className="badge-blue">
                          {c.name}{c.section ? ` - ${c.section}` : ''}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {assignments.subjects.length > 0 && (
                  <div>
                    <p className="text-xs text-slate-400 mb-1.5">Subjects</p>
                    <div className="flex gap-2 flex-wrap">
                      {assignments.subjects.map(s => (
                        <span key={s.assignment_id} className="badge-green">
                          {s.subject} → {s.class_name}{s.section ? ` - ${s.section}` : ''}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-sm text-slate-400">
                No classes or subjects assigned yet - your admin will set these up.
              </p>
            )}
          </div>
        )}

        {/* Leave */}
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold text-slate-800 flex items-center gap-2">
              <ClipboardList size={16} className="text-slate-400" /> My leave
            </h2>
            <Link href="/dashboard/leave" className="text-brand-600 text-xs font-medium hover:underline flex items-center gap-1">
              Apply / history <ArrowRight size={12} />
            </Link>
          </div>
          {latestLeave ? (
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm text-slate-700 capitalize">
                  {latestLeave.leave_type} · {latestLeave.total_days} day{latestLeave.total_days !== 1 ? 's' : ''}
                </span>
                <span className={LEAVE_BADGE[latestLeave.status] ?? 'badge-blue'}>{latestLeave.status}</span>
              </div>
              <p className="text-xs text-slate-400 mt-1">
                {new Date(latestLeave.from_date).toLocaleDateString('en-IN')} →{' '}
                {new Date(latestLeave.to_date).toLocaleDateString('en-IN')}
              </p>
              {latestLeave.admin_comment && (
                <p className="text-xs text-slate-500 mt-1.5 bg-slate-50 rounded px-2 py-1">
                  {latestLeave.admin_comment}
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-slate-400">No leave requests yet.</p>
          )}
        </div>

        {/* Notifications */}
        <div className="card">
          <h2 className="font-semibold text-slate-800 flex items-center gap-2 mb-3">
            <Bell size={16} className="text-slate-400" /> Notifications
          </h2>
          {recentDecisions.length > 0 ? (
            <div className="flex flex-col gap-2">
              {recentDecisions.map(l => (
                <p key={l.id} className="text-sm text-slate-600">
                  Your {l.leave_type} leave ({l.total_days} day{l.total_days !== 1 ? 's' : ''}) was{' '}
                  <span className={l.status === 'approved' ? 'text-green-600 font-medium' : 'text-red-600 font-medium'}>
                    {l.status}
                  </span>
                </p>
              ))}
            </div>
          ) : (
            <p className="text-sm text-slate-400">Nothing new right now.</p>
          )}
        </div>

        {/* Exam module placeholders */}
        <div className="card lg:col-span-2">
          <h2 className="font-semibold text-slate-800 flex items-center gap-2 mb-3">
            <FileText size={16} className="text-slate-400" /> Marks entry &amp; upcoming exams
          </h2>
          <p className="text-sm text-slate-400">
            Pending marks entry and your exam schedule will appear here once the
            exam management module is live.
          </p>
        </div>
      </div>
    </div>
  )
}
