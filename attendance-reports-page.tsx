'use client'

// FILE: app/(dashboard)/dashboard/attendance/reports/page.tsx
// Class-wise attendance reports — Daily, Monthly, Yearly
// All queries scoped by school_id via RLS — zero cross-tenant risk

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/utils/supabase/client'
import {
  ArrowLeft, CalendarCheck, TrendingUp,
  Users, Download, ChevronLeft, ChevronRight
} from 'lucide-react'
import Link from 'next/link'

type ReportMode = 'daily' | 'monthly' | 'yearly'

interface ClassOption { id: string; name: string; section: string | null }

interface StudentRow {
  id: string
  full_name: string
  student_uid: string | null
}

interface AttendanceRecord {
  student_id: string
  scan_date: string
  entry_type: 'entry' | 'exit'
}

// ── Helpers ───────────────────────────────────────────────────
function fmtDate(dateStr: string) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-IN', {
    weekday: 'short', day: 'numeric', month: 'short'
  })
}

function workingDaysInMonth(year: number, month: number): string[] {
  const days: string[] = []
  const daysInMonth = new Date(year, month, 0).getDate()
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, month - 1, d)
    if (date.getDay() !== 0) { // exclude Sundays
      days.push(`${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`)
    }
  }
  return days
}

function workingDaysInYear(year: number): number {
  let count = 0
  for (let m = 1; m <= 12; m++) {
    count += workingDaysInMonth(year, m).length
  }
  return count
}

function pctColor(pct: number) {
  if (pct >= 75) return 'text-green-700'
  if (pct >= 50) return 'text-yellow-600'
  return 'text-red-600'
}

function pctBg(pct: number) {
  if (pct >= 75) return 'bg-green-500'
  if (pct >= 50) return 'bg-yellow-400'
  return 'bg-red-500'
}

// ── Main component ────────────────────────────────────────────
export default function AttendanceReportsPage() {
  const [schoolId,    setSchoolId]    = useState('')
  const [classes,     setClasses]     = useState<ClassOption[]>([])
  const [selectedClass, setSelectedClass] = useState<ClassOption | null>(null)
  const [students,    setStudents]    = useState<StudentRow[]>([])
  const [attendance,  setAttendance]  = useState<AttendanceRecord[]>([])
  const [mode,        setMode]        = useState<ReportMode>('daily')
  const [loading,     setLoading]     = useState(true)
  const [dataLoading, setDataLoading] = useState(false)

  // Date navigation
  const today = new Date()
  const [selectedDate,  setSelectedDate]  = useState(today.toISOString().split('T')[0])
  const [selectedMonth, setSelectedMonth] = useState(
    `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`
  )
  const [selectedYear, setSelectedYear] = useState(today.getFullYear())

  // ── Initial load: school + classes ───────────────────────────
  useEffect(() => {
    async function init() {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      const { data: profile } = await supabase
        .from('profiles')
        .select('school_id')
        .eq('id', user.id)
        .single()
      if (!profile?.school_id) return
      setSchoolId(profile.school_id)

      const { data: classData } = await supabase
        .from('classes')
        .select('id, name, section')
        .eq('school_id', profile.school_id)
        .order('name')

      const classList = (classData ?? []) as ClassOption[]
      setClasses(classList)
      if (classList.length > 0) setSelectedClass(classList[0])
      setLoading(false)
    }
    init()
  }, [])

  // ── Fetch students + attendance when class/mode/date changes ─
  const fetchReport = useCallback(async () => {
    if (!schoolId || !selectedClass) return
    setDataLoading(true)

    const supabase = createClient()

    // Always fetch students for this class
    const { data: studentData } = await supabase
      .from('students')
      .select('id, full_name, student_uid')
      .eq('school_id', schoolId)
      .eq('class_id', selectedClass.id)
      .eq('is_active', true)
      .order('full_name')

    setStudents((studentData ?? []) as StudentRow[])

    // Date range based on mode
    let fromDate = ''
    let toDate   = ''

    if (mode === 'daily') {
      fromDate = selectedDate
      toDate   = selectedDate
    } else if (mode === 'monthly') {
      const [yr, mo] = selectedMonth.split('-').map(Number)
      fromDate = `${yr}-${String(mo).padStart(2, '0')}-01`
      const lastDay = new Date(yr, mo, 0).getDate()
      toDate = `${yr}-${String(mo).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
    } else {
      fromDate = `${selectedYear}-01-01`
      toDate   = `${selectedYear}-12-31`
    }

    const studentIds = (studentData ?? []).map((s: any) => s.id)
    if (studentIds.length === 0) {
      setAttendance([])
      setDataLoading(false)
      return
    }

    const { data: attData } = await supabase
      .from('attendance')
      .select('student_id, scan_date, entry_type')
      .eq('school_id', schoolId)
      .in('student_id', studentIds)
      .gte('scan_date', fromDate)
      .lte('scan_date', toDate)

    setAttendance((attData ?? []) as AttendanceRecord[])
    setDataLoading(false)
  }, [schoolId, selectedClass, mode, selectedDate, selectedMonth, selectedYear])

  useEffect(() => { fetchReport() }, [fetchReport])

  // ── Date navigation helpers ───────────────────────────────────
  function shiftDate(delta: number) {
    const d = new Date(selectedDate + 'T00:00:00')
    d.setDate(d.getDate() + delta)
    setSelectedDate(d.toISOString().split('T')[0])
  }

  function shiftMonth(delta: number) {
    const [yr, mo] = selectedMonth.split('-').map(Number)
    const d = new Date(yr, mo - 1 + delta, 1)
    setSelectedMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  }

  // ── Derived data ─────────────────────────────────────────────
  // Set of student_ids present on selected day (entry only = present)
  const presentOnDay = new Set(
    attendance.filter(r => r.entry_type === 'entry').map(r => r.student_id)
  )

  // Days present per student for monthly/yearly
  function daysPresent(studentId: string): number {
    const dates = new Set(
      attendance
        .filter(r => r.student_id === studentId && r.entry_type === 'entry')
        .map(r => r.scan_date)
    )
    return dates.size
  }

  const [mYr, mMo] = selectedMonth.split('-').map(Number)
  const workingDaysMonth = workingDaysInMonth(mYr, mMo).length
  const workingDaysYear  = workingDaysInYear(selectedYear)

  const classAvgDaily   = students.length > 0 ? Math.round((presentOnDay.size / students.length) * 100) : 0
  const classAvgMonthly = students.length > 0
    ? Math.round(students.reduce((sum, s) => sum + daysPresent(s.id), 0) / (students.length * workingDaysMonth) * 100)
    : 0
  const classAvgYearly = students.length > 0
    ? Math.round(students.reduce((sum, s) => sum + daysPresent(s.id), 0) / (students.length * workingDaysYear) * 100)
    : 0

  // ── Export CSV ───────────────────────────────────────────────
  function exportCSV() {
    if (students.length === 0) return
    let csv = ''
    if (mode === 'daily') {
      csv = 'Student,UID,Status\n'
      students.forEach(s => {
        csv += `"${s.full_name}","${s.student_uid ?? ''}","${presentOnDay.has(s.id) ? 'Present' : 'Absent'}"\n`
      })
    } else {
      const total = mode === 'monthly' ? workingDaysMonth : workingDaysYear
      csv = 'Student,UID,Days Present,Working Days,Percentage\n'
      students.forEach(s => {
        const p = daysPresent(s.id)
        const pct = total > 0 ? Math.round((p / total) * 100) : 0
        csv += `"${s.full_name}","${s.student_uid ?? ''}",${p},${total},${pct}%\n`
      })
    }
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const className = selectedClass ? selectedClass.name : 'class'
    a.href = url
    a.download = `attendance_${className}_${mode}_${selectedDate || selectedMonth || selectedYear}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto">
        <div className="h-8 w-48 bg-slate-200 rounded animate-pulse mb-6" />
        <div className="card h-96 animate-pulse bg-slate-50" />
      </div>
    )
  }

  const className = selectedClass
    ? `${selectedClass.name}${selectedClass.section ? ' - ' + selectedClass.section : ''}`
    : '—'

  return (
    <div className="max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <Link href="/dashboard/attendance"
          className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 transition-colors">
          <ArrowLeft size={17} className="text-slate-500" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Attendance Reports</h1>
          <p className="text-sm text-slate-500">Class-wise analysis</p>
        </div>
        <button
          onClick={exportCSV}
          disabled={students.length === 0}
          className="ml-auto btn-secondary flex items-center gap-2 text-sm disabled:opacity-40">
          <Download size={15} /> Export CSV
        </button>
      </div>

      {/* Controls row */}
      <div className="card mb-6">
        <div className="flex flex-wrap gap-4 items-end">
          {/* Class selector */}
          <div className="flex-1 min-w-[160px]">
            <label className="label">Class</label>
            <select
              className="input text-sm"
              value={selectedClass?.id ?? ''}
              onChange={e => {
                const c = classes.find(c => c.id === e.target.value)
                setSelectedClass(c ?? null)
              }}
            >
              {classes.map(c => (
                <option key={c.id} value={c.id}>
                  {c.name}{c.section ? ` - ${c.section}` : ''}
                </option>
              ))}
            </select>
          </div>

          {/* Mode selector */}
          <div>
            <label className="label">Period</label>
            <div className="flex bg-slate-100 rounded-lg p-0.5 gap-0.5">
              {(['daily', 'monthly', 'yearly'] as ReportMode[]).map(m => (
                <button key={m}
                  onClick={() => setMode(m)}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium capitalize transition-colors ${
                    mode === m ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>

          {/* Date nav */}
          <div>
            <label className="label">
              {mode === 'daily' ? 'Date' : mode === 'monthly' ? 'Month' : 'Year'}
            </label>
            <div className="flex items-center gap-1">
              <button
                onClick={() => mode === 'daily' ? shiftDate(-1) : mode === 'monthly' ? shiftMonth(-1) : setSelectedYear(y => y - 1)}
                className="w-7 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 text-slate-500">
                <ChevronLeft size={16} />
              </button>
              {mode === 'daily' && (
                <input type="date" value={selectedDate}
                  max={today.toISOString().split('T')[0]}
                  onChange={e => setSelectedDate(e.target.value)}
                  className="input text-sm py-1 w-36" />
              )}
              {mode === 'monthly' && (
                <input type="month" value={selectedMonth}
                  max={`${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`}
                  onChange={e => setSelectedMonth(e.target.value)}
                  className="input text-sm py-1 w-36" />
              )}
              {mode === 'yearly' && (
                <div className="input text-sm py-1 w-20 text-center font-medium">{selectedYear}</div>
              )}
              <button
                onClick={() => mode === 'daily' ? shiftDate(1) : mode === 'monthly' ? shiftMonth(1) : setSelectedYear(y => y + 1)}
                disabled={
                  (mode === 'daily' && selectedDate >= today.toISOString().split('T')[0]) ||
                  (mode === 'monthly' && selectedMonth >= `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`) ||
                  (mode === 'yearly' && selectedYear >= today.getFullYear())
                }
                className="w-7 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 text-slate-500 disabled:opacity-30">
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Summary stat cards */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="stat-card">
          <div className="w-8 h-8 bg-brand-50 rounded-lg flex items-center justify-center mb-2">
            <Users size={16} className="text-brand-600" />
          </div>
          <p className="text-xs text-slate-500">{className}</p>
          <p className="text-2xl font-bold text-slate-900">{students.length}</p>
          <p className="text-xs text-slate-400">students</p>
        </div>

        {mode === 'daily' && (
          <>
            <div className="stat-card">
              <div className="w-8 h-8 bg-green-50 rounded-lg flex items-center justify-center mb-2">
                <CalendarCheck size={16} className="text-green-600" />
              </div>
              <p className="text-xs text-slate-500">Present</p>
              <p className="text-2xl font-bold text-green-600">{presentOnDay.size}</p>
              <p className="text-xs text-slate-400">of {students.length}</p>
            </div>
            <div className="stat-card">
              <div className="w-8 h-8 bg-brand-50 rounded-lg flex items-center justify-center mb-2">
                <TrendingUp size={16} className="text-brand-600" />
              </div>
              <p className="text-xs text-slate-500">Attendance</p>
              <p className={`text-2xl font-bold ${pctColor(classAvgDaily)}`}>{classAvgDaily}%</p>
              <p className="text-xs text-slate-400">{fmtDate(selectedDate)}</p>
            </div>
          </>
        )}

        {mode === 'monthly' && (
          <>
            <div className="stat-card">
              <div className="w-8 h-8 bg-slate-50 rounded-lg flex items-center justify-center mb-2">
                <CalendarCheck size={16} className="text-slate-500" />
              </div>
              <p className="text-xs text-slate-500">Working days</p>
              <p className="text-2xl font-bold text-slate-700">{workingDaysMonth}</p>
              <p className="text-xs text-slate-400">this month</p>
            </div>
            <div className="stat-card">
              <div className="w-8 h-8 bg-brand-50 rounded-lg flex items-center justify-center mb-2">
                <TrendingUp size={16} className="text-brand-600" />
              </div>
              <p className="text-xs text-slate-500">Class avg</p>
              <p className={`text-2xl font-bold ${pctColor(classAvgMonthly)}`}>{classAvgMonthly}%</p>
              <p className="text-xs text-slate-400">attendance</p>
            </div>
          </>
        )}

        {mode === 'yearly' && (
          <>
            <div className="stat-card">
              <div className="w-8 h-8 bg-slate-50 rounded-lg flex items-center justify-center mb-2">
                <CalendarCheck size={16} className="text-slate-500" />
              </div>
              <p className="text-xs text-slate-500">Working days</p>
              <p className="text-2xl font-bold text-slate-700">{workingDaysYear}</p>
              <p className="text-xs text-slate-400">{selectedYear}</p>
            </div>
            <div className="stat-card">
              <div className="w-8 h-8 bg-brand-50 rounded-lg flex items-center justify-center mb-2">
                <TrendingUp size={16} className="text-brand-600" />
              </div>
              <p className="text-xs text-slate-500">Class avg</p>
              <p className={`text-2xl font-bold ${pctColor(classAvgYearly)}`}>{classAvgYearly}%</p>
              <p className="text-xs text-slate-400">annual</p>
            </div>
          </>
        )}
      </div>

      {/* Student table */}
      <div className="card">
        <h2 className="font-semibold text-slate-800 mb-4">
          {mode === 'daily' && `${fmtDate(selectedDate)} — ${className}`}
          {mode === 'monthly' && `${new Date(selectedMonth + '-01').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })} — ${className}`}
          {mode === 'yearly' && `${selectedYear} — ${className}`}
        </h2>

        {dataLoading ? (
          <div className="flex flex-col gap-3">
            {[0,1,2,3,4].map(i => (
              <div key={i} className="h-10 bg-slate-50 rounded-lg animate-pulse" />
            ))}
          </div>
        ) : students.length === 0 ? (
          <div className="text-center py-10">
            <Users size={32} className="text-slate-200 mx-auto mb-3" />
            <p className="text-sm text-slate-400">No students in this class</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="table w-full" style={{ tableLayout: 'fixed' }}>
              <colgroup>
                <col style={{ width: '40%' }} />
                <col style={{ width: '18%' }} />
                {mode === 'daily'   && <col style={{ width: '22%' }} />}
                {mode !== 'daily'   && <col style={{ width: '14%' }} />}
                {mode !== 'daily'   && <col style={{ width: '14%' }} />}
                {mode !== 'daily'   && <col style={{ width: '14%' }} />}
              </colgroup>
              <thead>
                <tr>
                  <th className="text-left text-xs font-semibold text-slate-500 pb-3">Student</th>
                  <th className="text-left text-xs font-semibold text-slate-500 pb-3">UID</th>
                  {mode === 'daily' && <th className="text-center text-xs font-semibold text-slate-500 pb-3">Status</th>}
                  {mode !== 'daily' && <th className="text-center text-xs font-semibold text-slate-500 pb-3">Present</th>}
                  {mode !== 'daily' && <th className="text-center text-xs font-semibold text-slate-500 pb-3">Working</th>}
                  {mode !== 'daily' && <th className="text-center text-xs font-semibold text-slate-500 pb-3">%</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {students.map(student => {
                  const present = presentOnDay.has(student.id)
                  const dp  = daysPresent(student.id)
                  const total = mode === 'monthly' ? workingDaysMonth : workingDaysYear
                  const pct = total > 0 ? Math.round((dp / total) * 100) : 0

                  return (
                    <tr key={student.id} className="hover:bg-slate-50/50">
                      <td className="py-3 text-sm font-medium text-slate-800 truncate pr-2">
                        <Link href={`/dashboard/students/${student.id}`}
                          className="hover:text-brand-600 transition-colors">
                          {student.full_name}
                        </Link>
                      </td>
                      <td className="py-3">
                        <span className="font-mono text-xs text-slate-500">{student.student_uid ?? '—'}</span>
                      </td>

                      {mode === 'daily' && (
                        <td className="py-3 text-center">
                          <span className={present ? 'badge-green' : 'badge-red'}>
                            {present ? 'Present' : 'Absent'}
                          </span>
                        </td>
                      )}

                      {mode !== 'daily' && (
                        <>
                          <td className="py-3 text-center text-sm font-semibold text-slate-700">{dp}</td>
                          <td className="py-3 text-center text-sm text-slate-400">{total}</td>
                          <td className="py-3 text-center">
                            <div className="flex flex-col items-center gap-1">
                              <span className={`text-sm font-bold ${pctColor(pct)}`}>{pct}%</span>
                              <div className="w-12 h-1 bg-slate-100 rounded-full overflow-hidden">
                                <div className={`h-full rounded-full ${pctBg(pct)}`} style={{ width: `${pct}%` }} />
                              </div>
                            </div>
                          </td>
                        </>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
