'use client'

// FILE: app/(dashboard)/dashboard/exams/[examId]/results/page.tsx
// Results: compute (needs all papers frozen), class summary, per-class
// results table, generate report cards, download report-card PDFs.

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { createClient } from '@/utils/supabase/client'
import { ArrowLeft, X, Calculator, FileText, Download, Award, AlertTriangle } from 'lucide-react'
import type { Exam, ClassResultSummaryRow, ExamResult, ResultStatus, ComputeResultsResult, GenerateReportCardsResult } from '@/types'
import { ExamStatusBadge, classLabel } from '@/components/exams/examUi'

interface ResultRow extends ExamResult {
  full_name: string
  roll_number: number
  class_id: string
}

const RESULT_BADGE: Record<ResultStatus, string> = {
  pass: 'badge-green', fail: 'badge-red', withheld: 'badge-yellow', absent: 'bg-slate-100 text-slate-500 text-xs px-2 py-0.5 rounded-full',
}

export default function ResultsPage() {
  const { examId } = useParams<{ examId: string }>()
  const router = useRouter()
  const [exam, setExam] = useState<Exam | null>(null)
  const [summary, setSummary] = useState<ClassResultSummaryRow[]>([])
  const [results, setResults] = useState<ResultRow[]>([])
  const [reportCardCount, setReportCardCount] = useState(0)
  const [stale, setStale] = useState(false)
  const [activeClass, setActiveClass] = useState<string>('all')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const fetchAll = useCallback(async () => {
    const supabase = createClient()
    const eRes = await supabase.from('exams').select('*').eq('id', examId).single()
    if (eRes.error || !eRes.data) { router.push('/dashboard/exams'); return }
    setExam(eRes.data as Exam)

    const [sumRes, resRes, rcRes] = await Promise.all([
      supabase.rpc('get_class_result_summary', { p_exam_id: examId }),
      supabase.from('exam_results')
        .select('*, students(full_name), exam_enrollments!inner(roll_number, class_id)')
        .eq('exam_id', examId),
      supabase.from('report_cards').select('id', { count: 'exact', head: true }).eq('exam_id', examId),
    ])
    setSummary((sumRes.data ?? []) as ClassResultSummaryRow[])
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const rows = ((resRes.data ?? []) as any[]).map(r => ({
      ...r,
      full_name: r.students?.full_name ?? '—',
      roll_number: r.exam_enrollments?.roll_number ?? 0,
      class_id: r.exam_enrollments?.class_id ?? '',
    })) as ResultRow[]
    setResults(rows)
    setStale(rows.some(r => !r.is_final))
    /* eslint-enable @typescript-eslint/no-explicit-any */
    setReportCardCount(rcRes.count ?? 0)
    setLoading(false)
  }, [examId, router])

  useEffect(() => { fetchAll() }, [fetchAll])

  async function compute() {
    setBusy(true); setError(''); setNotice('')
    const supabase = createClient()
    const { data, error } = await supabase.rpc('compute_exam_results', { p_exam_id: examId })
    setBusy(false)
    if (error) { setError(error.message); return }
    const r = data as ComputeResultsResult
    setNotice(`Computed ${r.computed} result(s)${r.withheld > 0 ? `, ${r.withheld} withheld` : ''}`)
    await fetchAll()
  }

  async function generateReportCards() {
    setBusy(true); setError(''); setNotice('')
    const supabase = createClient()
    const { data, error } = await supabase.rpc('generate_report_cards', { p_exam_id: examId, p_class_id: null })
    setBusy(false)
    if (error) { setError(error.message); return }
    const r = data as GenerateReportCardsResult
    setNotice(`Generated ${r.generated} report card(s)`)
    await fetchAll()
  }

  async function downloadReportCards(classId?: string) {
    setBusy(true); setError('')
    const res = await fetch('/api/exams/report-cards-pdf', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exam_id: examId, class_id: classId ?? null }),
    })
    setBusy(false)
    if (!res.ok) {
      const j = await res.json().catch(() => ({ error: 'Download failed' }))
      setError(j.error ?? 'Download failed'); return
    }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = 'report-cards.pdf'; a.click()
    URL.revokeObjectURL(url)
  }

  if (loading || !exam) {
    return <div className="max-w-4xl mx-auto"><div className="card h-96 animate-pulse bg-slate-50" /></div>
  }

  const computed = results.length > 0
  const canCompute = exam.status === 'completed' || exam.status === 'locked'
  const classes = summary.map(s => ({ id: s.class_id, label: s.class_label }))
  const visible = activeClass === 'all' ? results : results.filter(r => r.class_id === activeClass)

  return (
    <div className="max-w-4xl mx-auto">
      <Link href={`/dashboard/exams/${examId}`} className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600 mb-1">
        <ArrowLeft size={12} /> {exam.name}
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-slate-900">Results</h1>
            <ExamStatusBadge status={exam.status} />
          </div>
          <p className="text-slate-500 text-sm mt-1">
            {computed ? `${results.length} result(s) computed` : 'Compute results once all papers are frozen'}
          </p>
        </div>
        {canCompute && (
          <button onClick={compute} disabled={busy} className="btn-primary text-sm flex items-center gap-1.5">
            <Calculator size={15} /> {computed ? 'Recompute' : 'Compute results'}
          </button>
        )}
      </div>

      {error && (
        <div className="bg-red-50 text-red-600 text-sm px-4 py-3 rounded-lg mb-4 flex items-start justify-between gap-3">
          <span>{error}</span><button onClick={() => setError('')}><X size={14} /></button>
        </div>
      )}
      {notice && (
        <div className="bg-emerald-50 text-emerald-700 text-sm px-4 py-3 rounded-lg mb-4 flex items-start justify-between gap-3">
          <span>{notice}</span><button onClick={() => setNotice('')}><X size={14} /></button>
        </div>
      )}
      {stale && (
        <div className="bg-amber-50 text-amber-700 text-sm px-4 py-3 rounded-lg mb-4 flex items-center gap-2">
          <AlertTriangle size={15} /> Marks were reopened after computing — recompute before generating or publishing.
        </div>
      )}

      {!computed ? (
        <div className="card flex flex-col items-center justify-center py-16 text-center">
          <div className="w-14 h-14 bg-slate-100 rounded-full flex items-center justify-center mb-4">
            <Award size={24} className="text-slate-400" />
          </div>
          <p className="text-sm text-slate-500 max-w-sm">
            {canCompute
              ? 'All papers must be frozen first (see Marks). Then compute results here.'
              : 'Results are computed after the exam is completed.'}
          </p>
        </div>
      ) : (
        <>
          {/* Class summary */}
          <div className="card overflow-hidden mb-4">
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[560px]">
                <thead>
                  <tr className="text-left text-xs text-slate-400 border-b border-slate-100">
                    <th className="px-4 py-3 font-medium">Class</th>
                    <th className="px-3 py-3 font-medium text-center">Students</th>
                    <th className="px-3 py-3 font-medium text-center">Avg %</th>
                    <th className="px-3 py-3 font-medium text-center">Pass %</th>
                    <th className="px-4 py-3 font-medium">Topper</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {summary.map(s => (
                    <tr key={s.class_id}>
                      <td className="px-4 py-2.5 font-medium text-slate-800">{s.class_label}</td>
                      <td className="px-3 py-2.5 text-center text-slate-600">{s.students}</td>
                      <td className="px-3 py-2.5 text-center font-medium">{s.average_pct}%</td>
                      <td className="px-3 py-2.5 text-center font-medium text-emerald-600">{s.pass_pct}%</td>
                      <td className="px-4 py-2.5 text-slate-700">{s.topper_name ?? '—'} <span className="text-xs text-slate-400">{s.topper_pct ? `(${s.topper_pct}%)` : ''}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Report cards actions */}
          <div className="card p-4 mb-4 flex flex-wrap items-center gap-3">
            <span className="text-sm font-medium text-slate-700">Report cards:</span>
            <span className="text-xs text-slate-500">{reportCardCount} generated</span>
            <button onClick={generateReportCards} disabled={busy || stale}
              className="btn-secondary text-sm flex items-center gap-1.5">
              <FileText size={15} /> {reportCardCount > 0 ? 'Regenerate' : 'Generate'}
            </button>
            {reportCardCount > 0 && (
              <button onClick={() => downloadReportCards(activeClass === 'all' ? undefined : activeClass)} disabled={busy}
                className="btn-secondary text-sm flex items-center gap-1.5">
                <Download size={15} /> Download PDF
              </button>
            )}
          </div>

          {/* Per-student results */}
          <div className="flex gap-1.5 overflow-x-auto pb-1 mb-3">
            <button onClick={() => setActiveClass('all')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap ${activeClass === 'all' ? 'bg-brand-600 text-white' : 'bg-white border border-slate-200 text-slate-600'}`}>All</button>
            {classes.map(c => (
              <button key={c.id} onClick={() => setActiveClass(c.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap ${activeClass === c.id ? 'bg-brand-600 text-white' : 'bg-white border border-slate-200 text-slate-600'}`}>{c.label}</button>
            ))}
          </div>

          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[560px]">
                <thead>
                  <tr className="text-left text-xs text-slate-400 border-b border-slate-100">
                    <th className="px-4 py-3 font-medium w-12">Roll</th>
                    <th className="px-4 py-3 font-medium">Student</th>
                    <th className="px-3 py-3 font-medium text-center">Total</th>
                    <th className="px-3 py-3 font-medium text-center">%</th>
                    <th className="px-3 py-3 font-medium text-center">Grade</th>
                    <th className="px-3 py-3 font-medium text-center">Rank</th>
                    <th className="px-3 py-3 font-medium text-center">Result</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {visible.sort((a, b) => a.class_id.localeCompare(b.class_id) || a.roll_number - b.roll_number).map(r => (
                    <tr key={r.id}>
                      <td className="px-4 py-2.5 font-semibold text-slate-600">{r.roll_number}</td>
                      <td className="px-4 py-2.5 text-slate-800">{r.full_name}</td>
                      <td className="px-3 py-2.5 text-center text-slate-600">{r.result_status === 'withheld' ? '—' : `${r.total_obtained}/${r.total_max}`}</td>
                      <td className="px-3 py-2.5 text-center font-medium">{r.result_status === 'withheld' ? '—' : `${r.percentage}%`}</td>
                      <td className="px-3 py-2.5 text-center">{r.grade_label ?? '—'}</td>
                      <td className="px-3 py-2.5 text-center text-slate-500">{r.rank_in_class ?? '—'}</td>
                      <td className="px-3 py-2.5 text-center"><span className={RESULT_BADGE[r.result_status]}>{r.result_status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
