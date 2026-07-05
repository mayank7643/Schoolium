'use client'

// FILE: app/(dashboard)/dashboard/staff/attendance/report/page.tsx
//
// Monthly staff attendance report (chat17 Module 3). Reads the
// get_staff_attendance_summary RPC: per-staff present/late/half/absent/
// leave counts, working days (days with any marking that month) and an
// attendance percentage where present+late count 1 and half day 0.5.
// Admin/principal see the whole school; the RPC limits anyone else to
// their own row. PDF export lands with the Reports module - this table
// is the data source it will reuse.

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { createClient } from '@/utils/supabase/client'
import { ArrowLeft } from 'lucide-react'
import type { StaffAttendanceSummaryRow } from '@/types'

function currentMonth() {
  return new Date().toISOString().slice(0, 7) // YYYY-MM
}

function pctBadge(p: number) {
  if (p >= 90) return 'badge-green'
  if (p >= 75) return 'badge-yellow'
  return 'badge-red'
}

export default function StaffAttendanceReportPage() {
  const [month, setMonth]     = useState(currentMonth())
  const [rows, setRows]       = useState<StaffAttendanceSummaryRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')

  const fetchReport = useCallback(async (m: string) => {
    setLoading(true)
    setError('')
    const supabase = createClient()
    const { data, error: rpcError } = await supabase.rpc('get_staff_attendance_summary', {
      p_month: m,
    })
    if (rpcError) {
      setError(rpcError.message)
      setRows([])
    } else {
      setRows((data ?? []) as StaffAttendanceSummaryRow[])
    }
    setLoading(false)
  }, [])

  useEffect(() => { fetchReport(currentMonth()) }, [fetchReport])

  function handleMonthChange(m: string) {
    setMonth(m)
    if (m) fetchReport(m)
  }

  const workingDays = rows.length > 0 ? rows[0].working_days : 0

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link
          href="/dashboard/staff/attendance"
          className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 transition-colors"
        >
          <ArrowLeft size={18} className="text-slate-600" />
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-slate-900">Attendance report</h1>
          <p className="text-slate-500 text-sm">
            {workingDays > 0
              ? `${workingDays} working day${workingDays !== 1 ? 's' : ''} marked this month`
              : 'Monthly staff attendance summary'}
          </p>
        </div>
        <input
          type="month" className="input w-44 shrink-0"
          value={month}
          max={currentMonth()}
          onChange={e => handleMonthChange(e.target.value)}
        />
      </div>

      {error && (
        <div className="bg-red-50 text-red-600 text-sm px-3 py-2 rounded-lg mb-4">{error}</div>
      )}

      {loading ? (
        <div className="card flex flex-col gap-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-9 bg-slate-100 rounded animate-pulse" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="card text-center py-12">
          <p className="text-sm text-slate-500">No staff records for this month.</p>
        </div>
      ) : (
        <>
          {/* Mobile cards */}
          <div className="lg:hidden flex flex-col gap-3">
            {rows.map(r => (
              <div key={r.staff_id} className="card">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="min-w-0">
                    <p className="font-medium text-slate-900 text-sm truncate">{r.full_name}</p>
                    <p className="text-xs text-slate-400">{r.designation} · {r.employee_id}</p>
                  </div>
                  <span className={pctBadge(r.percentage)}>{r.percentage}%</span>
                </div>
                <div className="flex gap-3 text-xs text-slate-500 flex-wrap">
                  <span>P {r.present_days}</span>
                  <span>L {r.late_days}</span>
                  <span>H {r.half_days}</span>
                  <span>A {r.absent_days}</span>
                  <span>Lv {r.leave_days}</span>
                  <span className="text-slate-400">of {r.working_days} days</span>
                </div>
              </div>
            ))}
          </div>

          {/* Desktop table */}
          <div className="hidden lg:block table-wrapper">
            <table className="table" style={{ tableLayout: 'fixed', width: '100%' }}>
              <colgroup>
                <col style={{ width: '26%' }} />
                <col style={{ width: '16%' }} />
                <col style={{ width: '8%' }} />
                <col style={{ width: '8%' }} />
                <col style={{ width: '8%' }} />
                <col style={{ width: '8%' }} />
                <col style={{ width: '8%' }} />
                <col style={{ width: '9%' }} />
                <col style={{ width: '9%' }} />
              </colgroup>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Department</th>
                  <th>Present</th>
                  <th>Late</th>
                  <th>Half</th>
                  <th>Absent</th>
                  <th>Leave</th>
                  <th>Days</th>
                  <th>%</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.staff_id}>
                    <td>
                      <div className="min-w-0">
                        <p className="font-medium text-slate-900 truncate">{r.full_name}</p>
                        <p className="text-xs text-slate-400 font-mono">{r.employee_id}</p>
                      </div>
                    </td>
                    <td className="text-slate-600">{r.department}</td>
                    <td className="text-slate-700">{r.present_days}</td>
                    <td className="text-slate-700">{r.late_days}</td>
                    <td className="text-slate-700">{r.half_days}</td>
                    <td className={r.absent_days > 0 ? 'text-red-600 font-medium' : 'text-slate-700'}>
                      {r.absent_days}
                    </td>
                    <td className="text-slate-700">{r.leave_days}</td>
                    <td className="text-slate-500">{r.working_days}</td>
                    <td><span className={pctBadge(r.percentage)}>{r.percentage}%</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-slate-400 mt-4">
            Working days = days with any attendance marked for the school in the month.
            Percentage counts present and late as full days, half day as 0.5.
          </p>
        </>
      )}
    </div>
  )
}
