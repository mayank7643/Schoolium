'use client'

// FILE: app/(dashboard)/dashboard/staff/attendance/page.tsx
//
// Daily staff attendance (chat17 Module 3). Admin/principal pick a date
// (up to 31 days back - RPC enforces the same window) and mark everyone
// with one tap per person, or "Mark all present" for the common case.
// QR check-ins made at the gate appear pre-filled with their times and
// a QR badge; approved leave shows as a Leave badge. Saving sends ONLY
// the changed rows through mark_staff_attendance_bulk().

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { createClient } from '@/utils/supabase/client'
import { ArrowLeft, CheckCheck, BarChart3 } from 'lucide-react'
import type { StaffAttStatus, StaffAttSource } from '@/types'

interface StaffRow {
  id: string
  full_name: string
  employee_id: string
  designation: string
}

interface AttRow {
  staff_id: string
  status: StaffAttStatus
  check_in_time: string | null
  check_out_time: string | null
  source: StaffAttSource
}

const STATUS_OPTIONS: { value: StaffAttStatus; label: string; on: string }[] = [
  { value: 'present',  label: 'P',  on: 'bg-green-600 text-white border-green-600' },
  { value: 'late',     label: 'L',  on: 'bg-amber-500 text-white border-amber-500' },
  { value: 'half_day', label: 'H',  on: 'bg-blue-600 text-white border-blue-600' },
  { value: 'absent',   label: 'A',  on: 'bg-red-600 text-white border-red-600' },
  { value: 'leave',    label: 'Lv', on: 'bg-slate-600 text-white border-slate-600' },
]

const SOURCE_BADGE: Record<string, string> = {
  qr: 'QR', leave_sync: 'Leave', biometric: 'Bio',
}

function todayStr() {
  return new Date().toISOString().split('T')[0]
}

function minDateStr() {
  const d = new Date()
  d.setDate(d.getDate() - 31)
  return d.toISOString().split('T')[0]
}

export default function StaffAttendancePage() {
  const [allowed, setAllowed]   = useState<boolean | null>(null)
  const [loading, setLoading]   = useState(true)
  const [date, setDate]         = useState(todayStr())
  const [staff, setStaff]       = useState<StaffRow[]>([])
  const [marks, setMarks]       = useState<Record<string, AttRow>>({})
  const [dirty, setDirty]       = useState<Record<string, StaffAttStatus>>({})
  const [saving, setSaving]     = useState(false)
  const [message, setMessage]   = useState('')
  const [error, setError]       = useState('')

  const fetchDay = useCallback(async (d: string) => {
    const supabase = createClient()
    const { data } = await supabase
      .from('staff_attendance')
      .select('staff_id, status, check_in_time, check_out_time, source')
      .eq('attendance_date', d)

    const map: Record<string, AttRow> = {}
    ;(data ?? []).forEach((r: any) => { map[r.staff_id] = r as AttRow })
    setMarks(map)
    setDirty({})
    setMessage('')
    setError('')
  }, [])

  useEffect(() => {
    async function init() {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { setAllowed(false); setLoading(false); return }

      const { data: profile } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .single()

      const ok = profile?.role === 'school_admin' || profile?.role === 'principal'
      setAllowed(ok)

      if (ok) {
        const { data: staffData } = await supabase
          .from('staff')
          .select('id, full_name, employee_id, designation')
          .in('employment_status', ['active', 'probation', 'on_leave'])
          .order('full_name')
        setStaff((staffData ?? []) as StaffRow[])
        await fetchDay(todayStr())
      }
      setLoading(false)
    }
    init()
  }, [fetchDay])

  function handleDateChange(d: string) {
    setDate(d)
    fetchDay(d)
  }

  // effective status for a row = unsaved edit, else saved mark
  function effectiveStatus(staffId: string): StaffAttStatus | null {
    return dirty[staffId] ?? marks[staffId]?.status ?? null
  }

  function setStatus(staffId: string, status: StaffAttStatus) {
    setMessage('')
    const saved = marks[staffId]?.status ?? null
    setDirty(prev => {
      const next = { ...prev }
      if (saved === status) {
        delete next[staffId]   // back to saved state - nothing to send
      } else {
        next[staffId] = status
      }
      return next
    })
  }

  function markAllPresent() {
    setMessage('')
    setDirty(prev => {
      const next = { ...prev }
      staff.forEach(s => {
        const saved = marks[s.id]?.status ?? null
        if (saved === null && next[s.id] === undefined) {
          next[s.id] = 'present'
        }
      })
      return next
    })
  }

  async function save() {
    const rows = Object.entries(dirty).map(([staff_id, status]) => ({ staff_id, status }))
    if (rows.length === 0) return

    setSaving(true)
    setError('')

    const supabase = createClient()
    const { data, error: rpcError } = await supabase.rpc('mark_staff_attendance_bulk', {
      p_date: date,
      p_rows: rows,
    })

    if (rpcError) {
      setError(rpcError.message)
    } else {
      setMessage(`Saved ${data} record${data !== 1 ? 's' : ''}`)
      await fetchDay(date)
    }
    setSaving(false)
  }

  // counts for the summary strip
  const counts: Record<StaffAttStatus, number> = {
    present: 0, late: 0, half_day: 0, absent: 0, leave: 0,
  }
  staff.forEach(s => {
    const st = effectiveStatus(s.id)
    if (st) counts[st] += 1
  })
  const unmarked = staff.length - Object.values(counts).reduce((a, b) => a + b, 0)
  const dirtyCount = Object.keys(dirty).length

  if (!loading && allowed === false) {
    return (
      <div className="max-w-2xl">
        <div className="card">
          <h1 className="text-lg font-semibold text-slate-900 mb-1">Staff attendance</h1>
          <p className="text-sm text-slate-500">
            Only a school admin or principal can mark staff attendance.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto pb-24">
      <div className="flex items-center gap-3 mb-6">
        <Link
          href="/dashboard/staff"
          className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 transition-colors"
        >
          <ArrowLeft size={18} className="text-slate-600" />
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-slate-900">Staff attendance</h1>
          <p className="text-slate-500 text-sm">Gate QR check-ins appear here automatically</p>
        </div>
        <Link href="/dashboard/staff/attendance/report"
          className="btn-secondary flex items-center gap-2 text-sm shrink-0">
          <BarChart3 size={15} /> Report
        </Link>
      </div>

      {/* Date + quick actions */}
      <div className="card flex flex-col sm:flex-row sm:items-center gap-3 mb-5">
        <div className="flex-1">
          <label className="label">Date</label>
          <input
            type="date" className="input"
            value={date}
            min={minDateStr()} max={todayStr()}
            onChange={e => handleDateChange(e.target.value)}
          />
        </div>
        <button
          onClick={markAllPresent}
          className="btn-secondary flex items-center justify-center gap-2 text-sm sm:self-end"
          disabled={loading || unmarked === 0}
        >
          <CheckCheck size={15} /> Mark all present
        </button>
      </div>

      {/* Summary strip */}
      {!loading && staff.length > 0 && (
        <div className="flex gap-2 flex-wrap mb-4 text-xs">
          <span className="badge-green">Present {counts.present}</span>
          <span className="badge-yellow">Late {counts.late}</span>
          <span className="badge-blue">Half day {counts.half_day}</span>
          <span className="badge-red">Absent {counts.absent}</span>
          <span className="badge-yellow">Leave {counts.leave}</span>
          {unmarked > 0 && (
            <span className="text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">
              Unmarked {unmarked}
            </span>
          )}
        </div>
      )}

      {/* Staff rows */}
      {loading ? (
        <div className="bg-white rounded-xl border border-slate-100 shadow-sm overflow-hidden">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="px-4 py-3.5 border-b border-slate-50 last:border-0">
              <div className="h-4 w-40 bg-slate-100 rounded animate-pulse mb-2" />
              <div className="h-7 w-56 bg-slate-100 rounded animate-pulse" />
            </div>
          ))}
        </div>
      ) : staff.length === 0 ? (
        <div className="card text-center py-12">
          <p className="text-sm text-slate-500">No active staff yet.</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-slate-100 shadow-sm overflow-hidden">
          {staff.map(s => {
            const saved = marks[s.id]
            const st = effectiveStatus(s.id)
            const isDirty = dirty[s.id] !== undefined
            return (
              <div key={s.id}
                className="flex flex-col sm:flex-row sm:items-center gap-2 px-4 py-3 border-b border-slate-50 last:border-0">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-slate-900 text-sm truncate">{s.full_name}</span>
                    <span className="font-mono text-[10px] text-slate-400">{s.employee_id}</span>
                    {isDirty && <span className="w-1.5 h-1.5 bg-amber-400 rounded-full" title="Unsaved" />}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-slate-400 mt-0.5 flex-wrap">
                    <span>{s.designation}</span>
                    {saved?.check_in_time && (
                      <span className="font-mono">
                        {saved.check_in_time.slice(0, 5)}
                        {saved.check_out_time ? ` - ${saved.check_out_time.slice(0, 5)}` : ''}
                      </span>
                    )}
                    {saved && SOURCE_BADGE[saved.source] && (
                      <span className="bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded text-[10px]">
                        {SOURCE_BADGE[saved.source]}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex gap-1.5">
                  {STATUS_OPTIONS.map(o => {
                    const on = st === o.value
                    return (
                      <button
                        key={o.value}
                        onClick={() => setStatus(s.id, o.value)}
                        title={o.value.replace('_', ' ')}
                        className={`w-9 h-9 rounded-lg text-xs font-semibold border transition-colors ${
                          on ? o.on : 'border-slate-200 text-slate-500 hover:bg-slate-50'
                        }`}
                      >
                        {o.label}
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Sticky save bar */}
      {dirtyCount > 0 && (
        <div className="fixed bottom-16 lg:bottom-4 left-0 right-0 lg:left-60 z-30 px-4">
          <div className="max-w-3xl mx-auto bg-slate-900 text-white rounded-xl shadow-lg px-4 py-3 flex items-center justify-between gap-3">
            <span className="text-sm">
              {dirtyCount} unsaved change{dirtyCount !== 1 ? 's' : ''}
            </span>
            <div className="flex items-center gap-2">
              <button onClick={() => setDirty({})}
                className="text-xs text-slate-300 hover:text-white px-2 py-1">
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

      {message && !dirtyCount && (
        <p className="text-sm text-green-600 mt-4 text-center">{message}</p>
      )}
      {error && (
        <p className="text-sm text-red-500 mt-4 text-center">{error}</p>
      )}
    </div>
  )
}
