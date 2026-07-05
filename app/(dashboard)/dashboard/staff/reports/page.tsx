'use client'

// FILE: app/(dashboard)/dashboard/staff/reports/page.tsx
//
// Staff reports hub (chat17 Module 8) - admin/principal. Five
// PDF reports built server-side by /api/staff-report-pdf using the
// caller's own session (RLS applies) and the shared table renderer.

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { createClient } from '@/utils/supabase/client'
import {
  ArrowLeft, Download, Users, CalendarCheck, ClipboardList,
  Building2, GraduationCap,
} from 'lucide-react'

function currentMonth() {
  return new Date().toISOString().slice(0, 7)
}

const REPORTS = [
  {
    type: 'directory', icon: Users, title: 'Staff directory',
    desc: 'Every staff member with designation, department, mobile, status and joining date.',
    usesMonth: false, usesStatus: false,
  },
  {
    type: 'attendance', icon: CalendarCheck, title: 'Attendance report',
    desc: 'Monthly present / late / half day / absent / leave counts with percentage per staff member.',
    usesMonth: true, usesStatus: false,
  },
  {
    type: 'leave', icon: ClipboardList, title: 'Leave report',
    desc: 'Leave requests starting in the month, with dates, days, status and comments.',
    usesMonth: true, usesStatus: true,
  },
  {
    type: 'department', icon: Building2, title: 'Department report',
    desc: 'Active staff per department with teaching / non-teaching split.',
    usesMonth: false, usesStatus: false,
  },
  {
    type: 'assignments', icon: GraduationCap, title: 'Teacher assignments',
    desc: 'Class teacher allocations and subject-to-class assignments for every teacher.',
    usesMonth: false, usesStatus: false,
  },
] as const

export default function StaffReportsPage() {
  const [allowed, setAllowed]   = useState<boolean | null>(null)
  const [month, setMonth]       = useState(currentMonth())
  const [leaveStatus, setLeaveStatus] = useState('all')
  const [busy, setBusy]         = useState('')
  const [error, setError]       = useState('')

  useEffect(() => {
    (async () => {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { setAllowed(false); return }
      const { data: profile } = await supabase
        .from('profiles').select('role').eq('id', user.id).single()
      setAllowed(profile?.role === 'school_admin' || profile?.role === 'principal')
    })()
  }, [])

  async function download(type: string) {
    setBusy(type)
    setError('')
    try {
      const res = await fetch('/api/staff-report-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          month,
          status: leaveStatus === 'all' ? undefined : leaveStatus,
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setError(data.error ?? 'Failed to generate the report')
      } else {
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = res.headers.get('Content-Disposition')?.match(/filename="(.+)"/)?.[1]
          ?? `${type}-report.pdf`
        document.body.appendChild(a)
        a.click()
        a.remove()
        URL.revokeObjectURL(url)
      }
    } catch {
      setError('Network error - check your connection')
    }
    setBusy('')
  }

  if (allowed === false) {
    return (
      <div className="max-w-2xl">
        <div className="card">
          <h1 className="text-lg font-semibold text-slate-900 mb-1">Staff reports</h1>
          <p className="text-sm text-slate-500">
            Only a school admin or principal can generate reports.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link href="/dashboard/staff"
          className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 transition-colors">
          <ArrowLeft size={18} className="text-slate-600" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Staff reports</h1>
          <p className="text-slate-500 text-sm">Download print-ready PDF reports</p>
        </div>
      </div>

      {/* Shared parameters */}
      <div className="card flex flex-wrap items-end gap-4 mb-5">
        <div>
          <label className="label">Month (attendance &amp; leave)</label>
          <input type="month" className="input w-44" value={month}
            max={currentMonth()} onChange={e => setMonth(e.target.value)} />
        </div>
        <div>
          <label className="label">Leave status</label>
          <select className="input w-40" value={leaveStatus}
            onChange={e => setLeaveStatus(e.target.value)}>
            <option value="all">All</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 text-red-600 text-sm px-3 py-2 rounded-lg mb-4">{error}</div>
      )}

      <div className="flex flex-col gap-3">
        {REPORTS.map(r => {
          const Icon = r.icon
          return (
            <div key={r.type} className="card flex items-center gap-4">
              <div className="w-10 h-10 bg-brand-50 rounded-lg flex items-center justify-center shrink-0">
                <Icon size={18} className="text-brand-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-medium text-slate-900 text-sm">{r.title}</p>
                <p className="text-xs text-slate-400 mt-0.5">{r.desc}</p>
                {(r.usesMonth || r.usesStatus) && (
                  <p className="text-[11px] text-brand-600 mt-1">
                    Uses {[r.usesMonth && 'month', r.usesStatus && 'leave status']
                      .filter(Boolean).join(' + ')} above
                  </p>
                )}
              </div>
              <button onClick={() => download(r.type)} disabled={busy !== ''}
                className="btn-secondary flex items-center gap-2 text-sm shrink-0 disabled:opacity-50">
                <Download size={15} />
                {busy === r.type ? 'Building...' : 'PDF'}
              </button>
            </div>
          )
        })}
      </div>

      <p className="text-xs text-slate-400 mt-5">
        Reports are generated fresh from live data and formatted for black-and-white printing.
      </p>
    </div>
  )
}
