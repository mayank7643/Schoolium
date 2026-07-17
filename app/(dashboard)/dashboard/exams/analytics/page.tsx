'use client'

// FILE: app/(dashboard)/dashboard/exams/analytics/page.tsx
// School performance dashboard (session-scoped) + per-exam analytics
// with report-PDF exports. Charts: components/exams/charts.tsx.

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { createClient } from '@/utils/supabase/client'
import { ArrowLeft, X, Download, TrendingUp, Award, BarChart3 } from 'lucide-react'
import type {
  AcademicSession, SchoolPerformanceRow, ClassResultSummaryRow,
  SubjectPerformanceRow, GradeDistributionRow, TopperRow,
} from '@/types'
import {
  SchoolTrendChart, ClassComparisonChart, SubjectPerformanceChart, GradeDistributionChart,
} from '@/components/exams/charts'

interface ExamOpt { exam_id: string; exam_name: string }

export default function AnalyticsPage() {
  const [sessions, setSessions] = useState<AcademicSession[]>([])
  const [sessionId, setSessionId] = useState('')
  const [school, setSchool] = useState<SchoolPerformanceRow[]>([])
  const [examId, setExamId] = useState('')
  const [summary, setSummary] = useState<ClassResultSummaryRow[]>([])
  const [subjects, setSubjects] = useState<SubjectPerformanceRow[]>([])
  const [grades, setGrades] = useState<GradeDistributionRow[]>([])
  const [toppers, setToppers] = useState<TopperRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    (async () => {
      const supabase = createClient()
      const { data } = await supabase.from('academic_sessions').select('*')
        .neq('status', 'archived').order('start_date', { ascending: false })
      const list = (data ?? []) as AcademicSession[]
      setSessions(list)
      const cur = list.find(s => s.is_current) ?? list[0]
      if (cur) setSessionId(cur.id)
      else setLoading(false)
    })()
  }, [])

  const fetchSession = useCallback(async () => {
    if (!sessionId) return
    setLoading(true)
    const supabase = createClient()
    const { data, error } = await supabase.rpc('get_school_performance', { p_session_id: sessionId })
    if (error) setError(error.message)
    const rows = (data ?? []) as SchoolPerformanceRow[]
    setSchool(rows)
    setExamId(prev => rows.some(r => r.exam_id === prev) ? prev : (rows[rows.length - 1]?.exam_id ?? ''))
    setLoading(false)
  }, [sessionId])

  useEffect(() => { fetchSession() }, [fetchSession])

  const fetchExam = useCallback(async () => {
    if (!examId) { setSummary([]); setSubjects([]); setGrades([]); setToppers([]); return }
    const supabase = createClient()
    const [su, sp, gd, tp] = await Promise.all([
      supabase.rpc('get_class_result_summary', { p_exam_id: examId }),
      supabase.rpc('get_subject_performance', { p_exam_id: examId, p_class_id: null }),
      supabase.rpc('get_grade_distribution', { p_exam_id: examId, p_class_id: null }),
      supabase.rpc('get_topper_list', { p_exam_id: examId, p_class_id: null, p_limit: 10 }),
    ])
    setSummary((su.data ?? []) as ClassResultSummaryRow[])
    setSubjects((sp.data ?? []) as SubjectPerformanceRow[])
    setGrades((gd.data ?? []) as GradeDistributionRow[])
    setToppers((tp.data ?? []) as TopperRow[])
  }, [examId])

  useEffect(() => { fetchExam() }, [fetchExam])

  async function downloadReport(report: string) {
    setBusy(true); setError('')
    const res = await fetch('/api/exams/report-pdf', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ report, exam_id: examId, class_id: null }),
    })
    setBusy(false)
    if (!res.ok) { const j = await res.json().catch(() => ({ error: 'Download failed' })); setError(j.error ?? 'Download failed'); return }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = `${report}.pdf`; a.click()
    URL.revokeObjectURL(url)
  }

  const kpi = (() => {
    if (school.length === 0) return null
    const totalStudents = school.reduce((a, r) => a + r.students, 0)
    const avg = school.reduce((a, r) => a + r.average_pct * r.students, 0) / (totalStudents || 1)
    const pass = school.reduce((a, r) => a + r.pass_pct * r.students, 0) / (totalStudents || 1)
    return { exams: school.length, avg: Math.round(avg * 10) / 10, pass: Math.round(pass * 10) / 10 }
  })()

  const examOpts: ExamOpt[] = school.map(r => ({ exam_id: r.exam_id, exam_name: r.exam_name }))
  const classComparison = summary.map(s => ({ class_label: s.class_label, average_pct: s.average_pct }))

  const REPORTS = [
    { key: 'class_result', label: 'Class result' },
    { key: 'subject_performance', label: 'Subject performance' },
    { key: 'topper_list', label: 'Topper list' },
    { key: 'fail_list', label: 'Fail report' },
    { key: 'grade_distribution', label: 'Grade distribution' },
    { key: 'exam_attendance', label: 'Exam attendance' },
  ]

  return (
    <div className="max-w-5xl mx-auto">
      <Link href="/dashboard/exams" className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600 mb-1">
        <ArrowLeft size={12} /> Exams
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Analytics</h1>
          <p className="text-slate-500 text-sm mt-1">School performance and exam reports</p>
        </div>
        <select className="input !w-auto text-sm" value={sessionId} onChange={e => setSessionId(e.target.value)}>
          {sessions.map(s => <option key={s.id} value={s.id}>{s.name}{s.is_current ? ' (current)' : ''}</option>)}
        </select>
      </div>

      {error && (
        <div className="bg-red-50 text-red-600 text-sm px-4 py-3 rounded-lg mb-4 flex items-start justify-between gap-3">
          <span>{error}</span><button onClick={() => setError('')}><X size={14} /></button>
        </div>
      )}

      {loading ? (
        <div className="card h-64 animate-pulse bg-slate-50" />
      ) : school.length === 0 ? (
        <div className="card flex flex-col items-center justify-center py-16 text-center">
          <div className="w-14 h-14 bg-slate-100 rounded-full flex items-center justify-center mb-4">
            <BarChart3 size={24} className="text-slate-400" />
          </div>
          <p className="text-sm text-slate-500">No computed results in this session yet. Analytics appear once an exam&apos;s results are computed.</p>
        </div>
      ) : (
        <>
          {/* KPI tiles */}
          {kpi && (
            <div className="grid grid-cols-3 gap-3 mb-4">
              <div className="card p-4">
                <p className="text-xs text-slate-400">Exams with results</p>
                <p className="text-2xl font-bold text-slate-900 mt-1">{kpi.exams}</p>
              </div>
              <div className="card p-4">
                <p className="text-xs text-slate-400">Weighted avg %</p>
                <p className="text-2xl font-bold text-slate-900 mt-1">{kpi.avg}%</p>
              </div>
              <div className="card p-4">
                <p className="text-xs text-slate-400">Weighted pass %</p>
                <p className="text-2xl font-bold text-emerald-600 mt-1">{kpi.pass}%</p>
              </div>
            </div>
          )}

          {/* School trend */}
          {school.length > 1 && (
            <div className="card p-5 mb-4">
              <h3 className="font-semibold text-slate-900 text-sm mb-2 flex items-center gap-2">
                <TrendingUp size={15} className="text-brand-600" /> Performance across exams
              </h3>
              <SchoolTrendChart data={school.map(r => ({ exam_name: r.exam_name, average_pct: r.average_pct, pass_pct: r.pass_pct }))} />
            </div>
          )}

          {/* Per-exam analytics */}
          <div className="flex items-center justify-between gap-3 mb-3">
            <h3 className="font-semibold text-slate-900 text-sm">Exam detail</h3>
            <select className="input !w-auto text-sm" value={examId} onChange={e => setExamId(e.target.value)}>
              {examOpts.map(e => <option key={e.exam_id} value={e.exam_id}>{e.exam_name}</option>)}
            </select>
          </div>

          <div className="grid lg:grid-cols-2 gap-4 mb-4">
            {classComparison.length > 0 && (
              <div className="card p-5">
                <h4 className="font-semibold text-slate-900 text-sm mb-2">Class comparison</h4>
                <ClassComparisonChart data={classComparison} />
              </div>
            )}
            {grades.length > 0 && (
              <div className="card p-5">
                <h4 className="font-semibold text-slate-900 text-sm mb-2">Grade distribution</h4>
                <GradeDistributionChart data={grades} />
              </div>
            )}
          </div>

          {subjects.length > 0 && (
            <div className="card p-5 mb-4">
              <h4 className="font-semibold text-slate-900 text-sm mb-2">Subject performance</h4>
              <SubjectPerformanceChart data={subjects} />
            </div>
          )}

          {/* Toppers */}
          {toppers.length > 0 && (
            <div className="card p-5 mb-4">
              <h4 className="font-semibold text-slate-900 text-sm mb-3 flex items-center gap-2">
                <Award size={15} className="text-amber-500" /> Top performers
              </h4>
              <div className="flex flex-col divide-y divide-slate-50">
                {toppers.map((t, i) => (
                  <div key={i} className="flex items-center justify-between py-2 text-sm">
                    <div className="flex items-center gap-3">
                      <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${i < 3 ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-500'}`}>{i + 1}</span>
                      <span className="font-medium text-slate-800">{t.student_name}</span>
                      <span className="text-xs text-slate-400">{t.class_label}</span>
                    </div>
                    <span className="font-semibold text-slate-700">{t.percentage}% <span className="text-xs text-slate-400 font-normal">{t.grade_label}</span></span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Report exports */}
          <div className="card p-5">
            <h4 className="font-semibold text-slate-900 text-sm mb-3 flex items-center gap-2">
              <Download size={15} className="text-slate-500" /> Download reports (PDF)
            </h4>
            <div className="flex flex-wrap gap-2">
              {REPORTS.map(r => (
                <button key={r.key} onClick={() => downloadReport(r.key)} disabled={busy}
                  className="btn-secondary text-xs">{r.label}</button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
