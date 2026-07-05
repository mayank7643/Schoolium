// FILE: app/(dashboard)/dashboard/staff/[id]/page.tsx
//
// Staff detail (chat17). Server component: profile + assignments +
// recent attendance + leave history in one Promise.all. Status changes
// and password resets live in the StaffActions client component.
// RLS scopes reads: only admin/principal (or the member themself)
// can load this page's data.

import { createClient } from '@/utils/supabase/server'
import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import {
  ArrowLeft, Phone, Mail, MapPin, GraduationCap, CalendarCheck,
  Droplets, BookOpen, Pencil,
} from 'lucide-react'
import type { Staff, StaffAttendance, LeaveRequest, TeacherAssignments } from '@/types'
import StaffActions from './StaffActions'
import StaffDocuments from './StaffDocuments'

export const dynamic = 'force-dynamic'

const STATUS_BADGE: Record<string, string> = {
  active: 'badge-green', probation: 'badge-blue', on_leave: 'badge-yellow',
  resigned: 'badge-red', terminated: 'badge-red', retired: 'badge-red',
}
const ATT_BADGE: Record<string, string> = {
  present: 'badge-green', late: 'badge-yellow', half_day: 'badge-blue',
  absent: 'badge-red', leave: 'badge-yellow',
}
const LEAVE_BADGE: Record<string, string> = {
  pending: 'badge-yellow', approved: 'badge-green',
  rejected: 'badge-red', cancelled: 'badge-red',
}

function fmtDate(d: string | null) {
  return d ? new Date(d).toLocaleDateString('en-IN') : null
}

function InfoRow({ icon: Icon, label, value }: {
  icon: React.ElementType
  label: string
  value: string | null
}) {
  if (!value) return null
  return (
    <div className="flex items-start gap-3">
      <Icon size={15} className="text-slate-400 mt-0.5 shrink-0" />
      <div className="min-w-0">
        <p className="text-xs text-slate-400">{label}</p>
        <p className="text-sm text-slate-800 break-words">{value}</p>
      </div>
    </div>
  )
}

export default async function StaffDetailPage({
  params,
}: {
  params: { id: string }
}) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, school_id, is_active')
    .eq('id', user.id)
    .single()

  if (!profile || !profile.is_active) redirect('/login')

  const isManager = profile.role === 'school_admin' || profile.role === 'principal'

  const [staffRes, attendanceRes, leavesRes] = await Promise.all([
    supabase.from('staff').select('*').eq('id', params.id).maybeSingle(),
    supabase
      .from('staff_attendance')
      .select('id, attendance_date, status, check_in_time, check_out_time, source')
      .eq('staff_id', params.id)
      .order('attendance_date', { ascending: false })
      .limit(10),
    supabase
      .from('leave_requests')
      .select('id, leave_type, from_date, to_date, total_days, reason, status, admin_comment, created_at')
      .eq('staff_id', params.id)
      .order('created_at', { ascending: false })
      .limit(10),
  ])

  const staff = staffRes.data as Staff | null
  if (!staff) notFound()

  // Assignments only matter for teaching staff; RPC checks permissions
  let assignments: TeacherAssignments | null = null
  if (staff.is_teaching) {
    const { data } = await supabase.rpc('get_teacher_assignments', { p_staff_id: staff.id })
    assignments = (data ?? null) as TeacherAssignments | null
  }

  const attendance = (attendanceRes.data ?? []) as any as StaffAttendance[]
  const leaves = (leavesRes.data ?? []) as any as LeaveRequest[]

  const isSelf = staff.profile_id === user.id

  return (
    <div className="max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <Link
          href="/dashboard/staff"
          className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 transition-colors"
        >
          <ArrowLeft size={18} className="text-slate-600" />
        </Link>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-xl lg:text-2xl font-bold text-slate-900 truncate">{staff.full_name}</h1>
            <span className="font-mono text-xs bg-brand-50 text-brand-700 border border-brand-200 px-2 py-0.5 rounded">
              {staff.employee_id}
            </span>
            <span className={STATUS_BADGE[staff.employment_status] ?? 'badge-blue'}>
              {staff.employment_status.replace('_', ' ')}
            </span>
          </div>
          <p className="text-slate-500 text-sm mt-0.5">
            {staff.designation} · {staff.department}
          </p>
        </div>
        {isManager && (
          <Link href={`/dashboard/staff/${staff.id}/edit`}
            className="btn-secondary flex items-center gap-2 text-sm shrink-0">
            <Pencil size={14} /> Edit
          </Link>
        )}
      </div>

      <div className="grid lg:grid-cols-3 gap-5">
        {/* Left column: profile info */}
        <div className="lg:col-span-1 flex flex-col gap-5">
          <div className="card flex flex-col gap-4">
            <h2 className="font-semibold text-slate-800">Details</h2>
            <InfoRow icon={Phone} label="Mobile" value={staff.mobile} />
            <InfoRow icon={Mail} label="Email" value={staff.email} />
            <InfoRow icon={MapPin} label="Address" value={staff.address} />
            <InfoRow icon={CalendarCheck} label="Date of birth" value={fmtDate(staff.date_of_birth)} />
            <InfoRow icon={Droplets} label="Blood group" value={staff.blood_group} />
            <InfoRow icon={GraduationCap} label="Qualification" value={staff.qualification} />
            <InfoRow icon={CalendarCheck} label="Joined" value={fmtDate(staff.joining_date)} />
            {staff.father_name && (
              <InfoRow icon={BookOpen} label="Father's name" value={staff.father_name} />
            )}
            {staff.experience_years > 0 && (
              <InfoRow icon={BookOpen} label="Experience"
                value={`${staff.experience_years} year${staff.experience_years !== 1 ? 's' : ''}`} />
            )}
          </div>

          {isManager && !isSelf && (
            <StaffActions
              staffId={staff.id}
              currentStatus={staff.employment_status}
              staffName={staff.full_name}
            />
          )}
        </div>

        {/* Right column: assignments + attendance + leave */}
        <div className="lg:col-span-2 flex flex-col gap-5">

          {/* Teaching assignments */}
          {staff.is_teaching && (
            <div className="card">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-semibold text-slate-800">Teaching assignments</h2>
                {isManager && (
                  <Link href="/dashboard/staff/assignments" className="text-brand-600 text-xs font-medium hover:underline">
                    Manage
                  </Link>
                )}
              </div>
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
                <p className="text-sm text-slate-400">No classes or subjects assigned yet.</p>
              )}
            </div>
          )}

          {/* Recent attendance */}
          <div className="card">
            <h2 className="font-semibold text-slate-800 mb-3">Recent attendance</h2>
            {attendance.length > 0 ? (
              <div className="flex flex-col divide-y divide-slate-50">
                {attendance.map(a => (
                  <div key={a.id} className="flex items-center justify-between py-2 gap-3">
                    <span className="text-sm text-slate-700">
                      {new Date(a.attendance_date).toLocaleDateString('en-IN', {
                        day: 'numeric', month: 'short', weekday: 'short',
                      })}
                    </span>
                    <div className="flex items-center gap-3">
                      {(a.check_in_time || a.check_out_time) && (
                        <span className="font-mono text-xs text-slate-400">
                          {a.check_in_time ? a.check_in_time.slice(0, 5) : '--'}
                          {' - '}
                          {a.check_out_time ? a.check_out_time.slice(0, 5) : '--'}
                        </span>
                      )}
                      <span className={ATT_BADGE[a.status] ?? 'badge-blue'}>
                        {a.status.replace('_', ' ')}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-slate-400">No attendance marked yet.</p>
            )}
          </div>

          {/* Leave history */}
          <div className="card">
            <h2 className="font-semibold text-slate-800 mb-3">Leave history</h2>
            {leaves.length > 0 ? (
              <div className="flex flex-col divide-y divide-slate-50">
                {leaves.map(l => (
                  <div key={l.id} className="py-2.5">
                    <div className="flex items-center justify-between gap-3 mb-0.5">
                      <span className="text-sm text-slate-700 capitalize">
                        {l.leave_type} · {l.total_days} day{l.total_days !== 1 ? 's' : ''}
                      </span>
                      <span className={LEAVE_BADGE[l.status] ?? 'badge-blue'}>{l.status}</span>
                    </div>
                    <p className="text-xs text-slate-400">
                      {fmtDate(l.from_date)} → {fmtDate(l.to_date)}
                      {l.reason ? ` · ${l.reason}` : ''}
                    </p>
                    {l.admin_comment && (
                      <p className="text-xs text-slate-500 mt-1 bg-slate-50 rounded px-2 py-1">
                        {l.admin_comment}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-slate-400">No leave requests yet.</p>
            )}
          </div>

          {/* Documents (chat17 Module 6) */}
          <StaffDocuments
            staffId={staff.id}
            schoolId={staff.school_id}
            canManage={isManager}
          />
        </div>
      </div>
    </div>
  )
}
