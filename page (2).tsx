'use client'

// FILE: app/(dashboard)/dashboard/my-classes/[classId]/page.tsx
//
// Class workspace (chat18 Teacher Workspace). Access model, enforced
// server-side by the RPCs and RLS and mirrored in this UI:
//   - CLASS TEACHER of this class (or admin/principal): roster +
//     roll-call attendance marking + READ-ONLY fee summary
//   - subject teacher of this class: roster only
// Attendance is CLASSROOM roll call (class_attendance) - independent
// from gate QR scans, but each row shows a "Gate" tick if the student
// scanned in at the gate that day, so the teacher can cross-check.
// Fee view is via get_class_fee_summary: view and due list only, no
// collection - by design.

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { createClient } from '@/utils/supabase/client'
import { ArrowLeft, CheckCheck, IndianRupee, DoorOpen } from 'lucide-react'
import type { ClassAttStatus, ClassFeeSummaryRow, TeacherAssignments } from '@/types'

interface StudentRow {
  id: string
  full_name: string
  student_uid: string | null
}

const STATUS_OPTIONS: { value: ClassAttStatus; label: string; on: string }[] = [
  { value: 'present', label: 'P', on: 'bg-green-600 text-white border-green-600' },
  { value: 'late',    label: 'L', on: 'bg-amber-500 text-white border-amber-500' },
  { value: 'absent',  label: 'A', on: 'bg-red-600 text-white border-red-600' },
]

function istToday() {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().split('T')[0]
}
function minDate() {
  return new Date(Date.now() + 5.5 * 3600 * 1000 - 7 * 24 * 3600 * 1000).toISOString().split('T')[0]
}
function fmtINR(n: number) {
  return `Rs. ${Number(n).toLocaleString('en-IN')}`
}

export default function ClassWorkspacePage() {
  const params = useParams<{ classId: string }>()
  const classId = params.classId

  const [loading, setLoading]     = useState(true)
  const [denied, setDenied]       = useState(false)
  const [className, setClassName] = useState('')
  const [isClassTeacher, setIsClassTeacher] = useState(false)

  const [students, setStudents]   = useState<StudentRow[]>([])
  const [date, setDate]           = useState(istToday())
  const [marks, setMarks]         = useState<Record<string, ClassAttStatus>>({})
  const [dirty, setDirty]         = useState<Record<string, ClassAttStatus>>({})
  const [gateIn, setGateIn]       = useState<Set<string>>(new Set())
  const [saving, setSaving]       = useState(false)
  const [message, setMessage]     = useState('')
  const [error, setError]         = useState('')

  const [fees, setFees]           = useState<ClassFeeSummaryRow[] | null>(null)

  const fetchDay = useCallback(async (d: string, studentIds: string[]) => {
    const supabase = createClient()
    const [attRes, gateRes] = await Promise.all([
      supabase
        .from('class_attendance')
        .select('student_id, status')
        .eq('class_id', classId)
        .eq('attendance_date', d),
      studentIds.length > 0
        ? supabase.from('attendance').select('student_id').eq('scan_date', d).in('student_id', studentIds)
        : Promise.resolve({ data: [] }),
    ])

    const m: Record<string, ClassAttStatus> = {}
    ;((attRes.data ?? []) as any[]).forEach(r => { m[r.student_id] = r.status })
    setMarks(m)
    setDirty({})
    setMessage('')
    setError('')
    setGateIn(new Set(((gateRes.data ?? []) as any[]).map(r => r.student_id)))
  }, [classId])

  useEffect(() => {
    (async () => {
      const supabase = createClient()

      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { setDenied(true); setLoading(false); return }

      const [clsRes, assignRes, roleRes] = await Promise.all([
        supabase.from('classes').select('name, section').eq('id', classId).maybeSingle(),
        supabase.rpc('get_teacher_assignments'),
        supabase.from('profiles').select('role').eq('id', user.id).single(),
      ])

      const cls = clsRes.data
      if (!cls) { setDenied(true); setLoading(false); return }
      setClassName(`${cls.name}${cls.section ? ` - ${cls.section}` : ''}`)

      const role = (roleRes.data as any)?.role as string | undefined
      const isManager = role === 'school_admin' || role === 'principal'
      const assignments = (assignRes.data ?? null) as TeacherAssignments | null
      const ct = isManager || (assignments?.class_teacher_of.some(c => c.class_id === classId) ?? false)
      const subjectHere = assignments?.subjects.some(s => s.class_id === classId) ?? false

      if (!ct && !subjectHere) { setDenied(true); setLoading(false); return }
      setIsClassTeacher(ct)

      const { data: studentData } = await supabase
        .from('students')
        .select('id, full_name, student_uid')
        .eq('class_id', classId)
        .eq('is_active', true)
        .order('full_name')

      const list = (studentData ?? []) as StudentRow[]
      setStudents(list)

      if (ct) {
        await fetchDay(istToday(), list.map(s => s.id))
        const { data: feeData } = await supabase.rpc('get_class_fee_summary', { p_class_id: classId })
        setFees((feeData ?? []) as ClassFeeSummaryRow[])
      }
      setLoading(false)
    })()
  }, [classId, fetchDay])

  function handleDateChange(d: string) {
    setDate(d)
    fetchDay(d, students.map(s => s.id))
  }

  function effectiveStatus(id: string): ClassAttStatus | null {
    return dirty[id] ?? marks[id] ?? null
  }

  function setStatus(id: string, status: ClassAttStatus) {
    setMessage('')
    setDirty(prev => {
      const next = { ...prev }
      if ((marks[id] ?? null) === status) delete next[id]
      else next[id] = status
      return next
    })
  }

  function markAllPresent() {
    setDirty(prev => {
      const next = { ...prev }
      students.forEach(s => {
        if (!marks[s.id] && next[s.id] === undefined) next[s.id] = 'present'
      })
      return next
    })
  }

  async function save() {
    const rows = Object.entries(dirty).map(([student_id, status]) => ({ student_id, status }))
    if (rows.length === 0) return
    setSaving(true)
    setError('')

    const supabase = createClient()
    const { data, error: rpcError } = await supabase.rpc('mark_class_attendance', {
      p_class_id: classId,
      p_date: date,
      p_rows: rows,
    })

    if (rpcError) setError(rpcError.message)
    else {
      setMessage(`Saved ${data} record${data !== 1 ? 's' : ''}`)
      await fetchDay(date, students.map(s => s.id))
    }
    setSaving(false)
  }

  const counts = { present: 0, late: 0, absent: 0 }
  students.forEach(s => {
    const st = effectiveStatus(s.id)
    if (st) counts[st] += 1
  })
  const unmarked = students.length - counts.present - counts.late - counts.absent
  const dirtyCount = Object.keys(dirty).length
  const totalOutstanding = (fees ?? []).reduce((sum, f) => sum + Number(f.balance), 0)

  if (!loading && denied) {
    return (
      <div className="max-w-2xl">
        <div className="card">
          <h1 className="text-lg font-semibold text-slate-900 mb-1">Class workspace</h1>
          <p className="text-sm text-slate-500">
            This class is not assigned to you.
          </p>
          <Link href="/dashboard/my-classes" className="btn-secondary text-sm inline-block mt-3">
            Back to my classes
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto pb-24">
      <div className="flex items-center gap-3 mb-6">
        <Link href="/dashboard/my-classes"
          className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 transition-colors">
          <ArrowLeft size={18} className="text-slate-600" />
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-slate-900">
            {loading ? '...' : `Class ${className}`}
          </h1>
          <p className="text-slate-500 text-sm">
            {students.length} student{students.length !== 1 ? 's' : ''}
            {isClassTeacher ? ' · you are class teacher' : ' · subject class'}
          </p>
        </div>
      </div>

      {/* Roll-call attendance - class teacher only */}
      {isClassTeacher && !loading && (
        <>
          <div className="card flex flex-col sm:flex-row sm:items-center gap-3 mb-4">
            <div className="flex-1">
              <label className="label">Roll call date</label>
              <input type="date" className="input" value={date}
                min={minDate()} max={istToday()}
                onChange={e => handleDateChange(e.target.value)} />
            </div>
            <button onClick={markAllPresent} disabled={unmarked === 0}
              className="btn-secondary flex items-center justify-center gap-2 text-sm sm:self-end disabled:opacity-50">
              <CheckCheck size={15} /> Mark all present
            </button>
          </div>

          <div className="flex gap-2 flex-wrap mb-4 text-xs">
            <span className="badge-green">Present {counts.present}</span>
            <span className="badge-yellow">Late {counts.late}</span>
            <span className="badge-red">Absent {counts.absent}</span>
            {unmarked > 0 && (
              <span className="text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">Unmarked {unmarked}</span>
            )}
          </div>
        </>
      )}

      {/* Roster (+ marking buttons for class teacher) */}
      {loading ? (
        <div className="bg-white rounded-xl border border-slate-100 shadow-sm overflow-hidden">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="px-4 py-3.5 border-b border-slate-50 last:border-0">
              <div className="h-4 w-40 bg-slate-100 rounded animate-pulse" />
            </div>
          ))}
        </div>
      ) : students.length === 0 ? (
        <div className="card text-center py-12">
          <p className="text-sm text-slate-400">No active students in this class.</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-slate-100 shadow-sm overflow-hidden">
          {students.map(s => {
            const st = effectiveStatus(s.id)
            const isDirty = dirty[s.id] !== undefined
            return (
              <div key={s.id}
                className="flex flex-col sm:flex-row sm:items-center gap-2 px-4 py-3 border-b border-slate-50 last:border-0">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-slate-900 text-sm truncate">{s.full_name}</span>
                    {s.student_uid && (
                      <span className="font-mono text-[10px] text-slate-400">{s.student_uid}</span>
                    )}
                    {isDirty && <span className="w-1.5 h-1.5 bg-amber-400 rounded-full" title="Unsaved" />}
                  </div>
                  {isClassTeacher && gateIn.has(s.id) && (
                    <p className="flex items-center gap-1 text-[11px] text-green-600 mt-0.5">
                      <DoorOpen size={11} /> Scanned in at gate
                    </p>
                  )}
                </div>
                {isClassTeacher && (
                  <div className="flex gap-1.5">
                    {STATUS_OPTIONS.map(o => {
                      const on = st === o.value
                      return (
                        <button key={o.value} onClick={() => setStatus(s.id, o.value)}
                          title={o.value}
                          className={`w-9 h-9 rounded-lg text-xs font-semibold border transition-colors ${
                            on ? o.on : 'border-slate-200 text-slate-500 hover:bg-slate-50'
                          }`}>
                          {o.label}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Read-only class fee summary - class teacher only */}
      {isClassTeacher && fees && (
        <div className="card mt-6">
          <div className="flex items-center justify-between mb-1">
            <h2 className="font-semibold text-slate-800 flex items-center gap-2">
              <IndianRupee size={16} className="text-slate-400" /> Fee status
            </h2>
            <span className="text-xs text-slate-400">View only</span>
          </div>
          <p className="text-xs text-slate-400 mb-3">
            Outstanding {fmtINR(totalOutstanding)} across the class. Collection stays with the fee desk.
          </p>
          {fees.length === 0 ? (
            <p className="text-sm text-slate-400">No students.</p>
          ) : (
            <div className="flex flex-col divide-y divide-slate-50">
              {fees.map(f => (
                <div key={f.student_id} className="flex items-center justify-between gap-3 py-2">
                  <span className="text-sm text-slate-700 truncate">{f.full_name}</span>
                  <div className="flex items-center gap-2 shrink-0">
                    {f.overdue_count > 0 && (
                      <span className="badge-red">{f.overdue_count} overdue</span>
                    )}
                    <span className={`text-sm font-medium ${Number(f.balance) > 0 ? 'text-red-600' : 'text-green-600'}`}>
                      {Number(f.balance) > 0 ? fmtINR(Number(f.balance)) : 'Paid'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Sticky save bar */}
      {dirtyCount > 0 && (
        <div className="fixed bottom-16 lg:bottom-4 left-0 right-0 lg:left-60 z-30 px-4">
          <div className="max-w-3xl mx-auto bg-slate-900 text-white rounded-xl shadow-lg px-4 py-3 flex items-center justify-between gap-3">
            <span className="text-sm">{dirtyCount} unsaved change{dirtyCount !== 1 ? 's' : ''}</span>
            <div className="flex items-center gap-2">
              <button onClick={() => setDirty({})} className="text-xs text-slate-300 hover:text-white px-2 py-1">
                Discard
              </button>
              <button onClick={save} disabled={saving}
                className="bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium px-5 py-2 rounded-lg disabled:opacity-60">
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {message && !dirtyCount && <p className="text-sm text-green-600 mt-4 text-center">{message}</p>}
      {error && <p className="text-sm text-red-500 mt-4 text-center">{error}</p>}
    </div>
  )
}
