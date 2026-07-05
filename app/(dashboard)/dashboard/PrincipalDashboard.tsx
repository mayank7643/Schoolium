// FILE: app/(dashboard)/dashboard/PrincipalDashboard.tsx
//
// Principal dashboard (chat17 Module 7, spec module 9):
//   Total staff / Teachers / Non-teaching / Today's attendance /
//   Staff on leave / Pending leave requests - one RPC call
//   (get_staff_dashboard_stats) plus student & class counts and a
//   pending-leave preview with a jump to the review queue.

import { createClient } from '@/utils/supabase/server'
import Link from 'next/link'
import {
  Users, GraduationCap, Briefcase, CalendarCheck,
  ClipboardList, ArrowRight, BookOpen,
} from 'lucide-react'
import type { StaffDashboardStats } from '@/types'

export default async function PrincipalDashboard({
  schoolName,
}: {
  schoolName: string
}) {
  const supabase = await createClient()

  const [statsRes, studentsRes, classesRes, pendingRes] = await Promise.all([
    supabase.rpc('get_staff_dashboard_stats'),
    supabase.from('students').select('id', { count: 'exact', head: true }).eq('is_active', true),
    supabase.from('classes').select('id', { count: 'exact', head: true }),
    supabase
      .from('leave_requests')
      .select('id, leave_type, from_date, to_date, total_days, staff(full_name, employee_id)')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(5),
  ])

  const stats = (statsRes.data ?? null) as StaffDashboardStats | null
  const studentCount = studentsRes.count ?? 0
  const classCount = classesRes.count ?? 0
  const pending = ((pendingRes.data ?? []) as any[]).map(r => ({
    ...r,
    staff: Array.isArray(r.staff) ? r.staff[0] ?? null : r.staff,
  }))

  const today = stats?.today

  return (
    <div className="max-w-4xl mx-auto">
      {/* Greeting */}
      <div className="mb-6">
        <h1 className="text-xl lg:text-2xl font-bold text-slate-900">Principal dashboard</h1>
        <p className="text-slate-500 text-sm mt-0.5">
          {schoolName} ·{' '}
          {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
        </p>
      </div>

      {/* Staff stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <div className="stat-card">
          <div className="flex items-center gap-2 text-slate-400 text-xs mb-2">
            <Briefcase size={14} /> Total staff
          </div>
          <p className="text-2xl font-bold text-slate-900">{stats?.total_staff ?? 0}</p>
          <p className="text-xs text-slate-400 mt-0.5">
            {stats?.teaching_staff ?? 0} teaching · {stats?.non_teaching_staff ?? 0} non-teaching
          </p>
        </div>

        <div className="stat-card">
          <div className="flex items-center gap-2 text-slate-400 text-xs mb-2">
            <CalendarCheck size={14} /> Today
          </div>
          <p className="text-2xl font-bold text-slate-900">
            {(today?.present ?? 0) + (today?.late ?? 0) + (today?.half_day ?? 0)}
            <span className="text-sm font-normal text-slate-400"> / {stats?.total_staff ?? 0} in</span>
          </p>
          <p className="text-xs text-slate-400 mt-0.5">
            {today?.late ?? 0} late · {today?.absent ?? 0} absent · {today?.unmarked ?? 0} unmarked
          </p>
        </div>

        <div className="stat-card">
          <div className="flex items-center gap-2 text-slate-400 text-xs mb-2">
            <ClipboardList size={14} /> On leave today
          </div>
          <p className="text-2xl font-bold text-slate-900">{today?.on_leave ?? 0}</p>
          <Link href="/dashboard/staff/leaves" className="text-xs text-brand-600 font-medium hover:underline mt-0.5 inline-block">
            {stats?.pending_leave_requests ?? 0} pending request{(stats?.pending_leave_requests ?? 0) !== 1 ? 's' : ''}
          </Link>
        </div>

        <div className="stat-card">
          <div className="flex items-center gap-2 text-slate-400 text-xs mb-2">
            <Users size={14} /> Students
          </div>
          <p className="text-2xl font-bold text-slate-900">{studentCount}</p>
          <p className="text-xs text-slate-400 mt-0.5">{classCount} classes</p>
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-5">
        {/* Pending leave requests */}
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold text-slate-800">Pending leave requests</h2>
            <Link href="/dashboard/staff/leaves" className="text-brand-600 text-xs font-medium hover:underline flex items-center gap-1">
              Review <ArrowRight size={12} />
            </Link>
          </div>
          {pending.length > 0 ? (
            <div className="flex flex-col divide-y divide-slate-50">
              {pending.map(l => (
                <div key={l.id} className="py-2">
                  <p className="text-sm font-medium text-slate-800">
                    {l.staff?.full_name ?? 'Staff member'}
                    <span className="font-mono text-[10px] text-slate-400 ml-2">{l.staff?.employee_id}</span>
                  </p>
                  <p className="text-xs text-slate-400 mt-0.5 capitalize">
                    {l.leave_type} · {new Date(l.from_date).toLocaleDateString('en-IN')} →{' '}
                    {new Date(l.to_date).toLocaleDateString('en-IN')} · {l.total_days} day{l.total_days !== 1 ? 's' : ''}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-slate-400">All caught up - nothing pending.</p>
          )}
        </div>

        {/* Quick actions */}
        <div className="card">
          <h2 className="font-semibold text-slate-800 mb-3">Quick actions</h2>
          <div className="grid grid-cols-2 gap-2">
            <Link href="/dashboard/staff/attendance" className="btn-secondary flex items-center justify-center gap-2 text-sm py-2.5">
              <CalendarCheck size={15} /> Mark attendance
            </Link>
            <Link href="/dashboard/staff" className="btn-secondary flex items-center justify-center gap-2 text-sm py-2.5">
              <Briefcase size={15} /> Staff directory
            </Link>
            <Link href="/dashboard/staff/assignments" className="btn-secondary flex items-center justify-center gap-2 text-sm py-2.5">
              <GraduationCap size={15} /> Assignments
            </Link>
            <Link href="/dashboard/staff/attendance/report" className="btn-secondary flex items-center justify-center gap-2 text-sm py-2.5">
              <BookOpen size={15} /> Attendance report
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}
