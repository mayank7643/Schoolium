'use client'

// FILE: app/(dashboard)/dashboard/my-exams/verify/[examSubjectId]/page.tsx
// Class-teacher verification: read-only grid + distribution/outlier
// hints, verify or reject with reason.

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { createClient } from '@/utils/supabase/client'
import { ArrowLeft, X, Check, RotateCcw } from 'lucide-react'
import type { SubmissionStatus, MarksGridData } from '@/types'
import { classLabel, formatDate } from '@/components/exams/examUi'
import MarksGrid from '@/components/exams/MarksGrid'

export default function VerifyMarksPage() {
  const { examSubjectId } = useParams<{ examSubjectId: string }>()
  const [meta, setMeta] = useState<{ exam_name: string; class_label: string; subject_name: string; exam_date: string | null } | null>(null)
  const [status, setStatus] = useState<SubmissionStatus>('pending')
  const [grid, setGrid] = useState<MarksGridData | null>(null)
  const [reload, setReload] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const fetchMeta = useCallback(async () => {
    const supabase = createClient()
    const { data } = await supabase.from('exam_subjects')
      .select('exam_date, classes(name, section), subjects(name), exams(name)')
      .eq('id', examSubjectId).single()
    if (data) {
      const d = data as any
      setMeta({ exam_name: d.exams?.name ?? '—', class_label: classLabel(d.classes), subject_name: d.subjects?.name ?? '—', exam_date: d.exam_date })
    }
    const { data: g } = await supabase.rpc('get_marks_grid', { p_exam_subject_id: examSubjectId })
    setGrid(g as MarksGridData)
  }, [examSubjectId])

  useEffect(() => { fetchMeta() }, [fetchMeta, reload])

  async function verify() {
    setBusy(true); setError('')
    const supabase = createClient()
    const { error } = await supabase.rpc('verify_marks', { p_exam_subject_id: examSubjectId })
    setBusy(false)
    if (error) { setError(error.message); return }
    setReload(x => x + 1)
  }

  async function reject() {
    const reason = prompt('Return these marks to the subject teacher.\nReason (required, min 10 characters):')
    if (reason === null) return
    setBusy(true); setError('')
    const supabase = createClient()
    const { error } = await supabase.rpc('reject_marks', { p_exam_subject_id: examSubjectId, p_reason: reason })
    setBusy(false)
    if (error) { setError(error.message); return }
    setReload(x => x + 1)
  }

  // distribution / outliers from the grid
  const stats = (() => {
    if (!grid) return null
    const scored = grid.rows.filter(r => !r.is_absent && !r.is_exempted && r.total !== null)
    if (scored.length === 0) return { avg: 0, max: 0, min: 0, fails: 0, outliers: 0, full: 0 }
    const totals = scored.map(r => r.total as number)
    const avg = totals.reduce((a, b) => a + b, 0) / totals.length
    const fails = scored.filter(r => (r.total as number) < grid.pass_marks).length
    const full = scored.filter(r => (r.total as number) >= grid.total_max * 0.95).length
    const outliers = scored.filter(r => (r.total as number) <= grid.total_max * 0.05).length
    return { avg: Math.round(avg * 10) / 10, max: Math.max(...totals), min: Math.min(...totals), fails, outliers, full }
  })()

  const canAct = status === 'submitted'

  return (
    <div className="max-w-3xl mx-auto">
      <Link href="/dashboard/my-exams" className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600 mb-1">
        <ArrowLeft size={12} /> My Exams
      </Link>
      {meta && (
        <div className="mb-4">
          <h1 className="text-2xl font-bold text-slate-900">Verify — {meta.subject_name} ({meta.class_label})</h1>
          <p className="text-slate-500 text-sm mt-1">{meta.exam_name}{meta.exam_date ? ` · ${formatDate(meta.exam_date)}` : ''}</p>
        </div>
      )}

      {error && (
        <div className="bg-red-50 text-red-600 text-sm px-4 py-3 rounded-lg mb-3 flex items-start justify-between gap-3">
          <span>{error}</span><button onClick={() => setError('')}><X size={14} /></button>
        </div>
      )}

      {!canAct && (
        <div className="bg-slate-50 text-slate-500 text-sm px-4 py-3 rounded-lg mb-3">
          {status === 'pending' || status === 'rejected'
            ? 'Not yet submitted by the subject teacher.'
            : `These marks are already ${status}.`}
        </div>
      )}

      {stats && (
        <div className="card p-4 mb-3 flex flex-wrap gap-4 text-sm">
          <span><span className="text-slate-400">Average</span> <span className="font-semibold">{stats.avg}</span> / {grid?.total_max}</span>
          <span><span className="text-slate-400">Range</span> <span className="font-semibold">{stats.min}–{stats.max}</span></span>
          {stats.fails > 0 && <span className="text-red-500 font-medium">{stats.fails} below pass</span>}
          {stats.full > 0 && <span className="text-amber-600">{stats.full} near-full (check)</span>}
          {stats.outliers > 0 && <span className="text-amber-600">{stats.outliers} very low (check)</span>}
        </div>
      )}

      <MarksGrid examSubjectId={examSubjectId} reload={reload} onStatus={setStatus} />

      {canAct && (
        <div className="sticky bottom-4 mt-4 flex items-center justify-end gap-2">
          <button onClick={reject} disabled={busy}
            className="btn-secondary text-sm flex items-center gap-1.5 !text-red-600 shadow-lg">
            <RotateCcw size={15} /> Return
          </button>
          <button onClick={verify} disabled={busy}
            className="btn-primary text-sm flex items-center gap-1.5 shadow-lg">
            <Check size={15} /> {busy ? 'Working…' : 'Verify'}
          </button>
        </div>
      )}
    </div>
  )
}
