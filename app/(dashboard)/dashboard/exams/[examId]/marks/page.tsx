'use client'

// FILE: app/(dashboard)/dashboard/exams/[examId]/marks/page.tsx
// Principal/admin marks board: all papers by submission status with
// bulk approve/freeze and per-paper drill-in.

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { createClient } from '@/utils/supabase/client'
import { ArrowLeft, X, ClipboardCheck, ChevronRight } from 'lucide-react'
import type { Exam, MarksBoardRow, SubmissionStatus } from '@/types'
import { ExamStatusBadge } from '@/components/exams/examUi'

const SUB_BADGE: Record<SubmissionStatus, string> = {
  pending:   'bg-slate-100 text-slate-600',
  submitted: 'bg-blue-50 text-blue-700',
  verified:  'bg-emerald-50 text-emerald-700',
  approved:  'bg-indigo-50 text-indigo-700',
  frozen:    'bg-purple-50 text-purple-700',
  rejected:  'bg-red-50 text-red-600',
}

export default function MarksBoardPage() {
  const { examId } = useParams<{ examId: string }>()
  const router = useRouter()
  const [exam, setExam] = useState<Exam | null>(null)
  const [rows, setRows] = useState<MarksBoardRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const fetchAll = useCallback(async () => {
    const supabase = createClient()
    const eRes = await supabase.from('exams').select('*').eq('id', examId).single()
    if (eRes.error || !eRes.data) { router.push('/dashboard/exams'); return }
    setExam(eRes.data as Exam)
    const { data, error } = await supabase.rpc('get_marks_board', { p_exam_id: examId })
    if (error) setError(error.message)
    else setRows((data ?? []) as MarksBoardRow[])
    setLoading(false)
  }, [examId, router])

  useEffect(() => { fetchAll() }, [fetchAll])

  async function act(fn: string, examSubjectId: string, reason?: string) {
    setBusy(true); setError(''); setNotice('')
    const supabase = createClient()
    const args: Record<string, unknown> = { p_exam_subject_id: examSubjectId }
    if (reason !== undefined) args.p_reason = reason
    const { error } = await supabase.rpc(fn, args)
    setBusy(false)
    if (error) { setError(error.message); return }
    await fetchAll()
  }

  async function bulkApprove() {
    const verified = rows.filter(r => r.status === 'verified')
    if (verified.length === 0) return
    if (!confirm(`Approve ${verified.length} verified paper(s)?`)) return
    setBusy(true); setError('')
    const supabase = createClient()
    for (const r of verified) {
      const { error } = await supabase.rpc('approve_marks', { p_exam_subject_id: r.exam_subject_id })
      if (error) { setError(error.message); break }
    }
    setBusy(false)
    setNotice('Approved verified papers')
    await fetchAll()
  }

  async function freezeAll() {
    const approved = rows.filter(r => r.status === 'approved')
    if (approved.length === 0) return
    if (!confirm(`Freeze ${approved.length} approved paper(s)? Marks become read-only.`)) return
    setBusy(true); setError('')
    const supabase = createClient()
    for (const r of approved) {
      const { error } = await supabase.rpc('freeze_marks', { p_exam_subject_id: r.exam_subject_id })
      if (error) { setError(error.message); break }
    }
    setBusy(false)
    setNotice('Frozen approved papers')
    await fetchAll()
  }

  if (loading || !exam) {
    return <div className="max-w-4xl mx-auto"><div className="card h-96 animate-pulse bg-slate-50" /></div>
  }

  const counts = rows.reduce<Record<string, number>>((a, r) => { a[r.status] = (a[r.status] ?? 0) + 1; return a }, {})
  const frozen = counts['frozen'] ?? 0

  return (
    <div className="max-w-4xl mx-auto">
      <Link href={`/dashboard/exams/${examId}`} className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600 mb-1">
        <ArrowLeft size={12} /> {exam.name}
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-slate-900">Marks</h1>
            <ExamStatusBadge status={exam.status} />
          </div>
          <p className="text-slate-500 text-sm mt-1">{frozen}/{rows.length} papers frozen</p>
        </div>
        <div className="flex items-center gap-2">
          {(counts['verified'] ?? 0) > 0 && (
            <button onClick={bulkApprove} disabled={busy} className="btn-secondary text-sm">
              Approve verified ({counts['verified']})
            </button>
          )}
          {(counts['approved'] ?? 0) > 0 && (
            <button onClick={freezeAll} disabled={busy} className="btn-primary text-sm">
              Freeze approved ({counts['approved']})
            </button>
          )}
        </div>
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

      {rows.length === 0 ? (
        <div className="card flex flex-col items-center justify-center py-16 text-center">
          <div className="w-14 h-14 bg-slate-100 rounded-full flex items-center justify-center mb-4">
            <ClipboardCheck size={24} className="text-slate-400" />
          </div>
          <p className="text-sm text-slate-500">No papers to show.</p>
        </div>
      ) : (
        <div className="card overflow-hidden divide-y divide-slate-50">
          {rows.map(r => (
            <div key={r.exam_subject_id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-800">
                  {r.subject_name} <span className="text-slate-400 font-normal">· {r.class_label}</span>
                </p>
                <p className="text-xs text-slate-400">{r.entered}/{r.enrolled} entered</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full capitalize ${SUB_BADGE[r.status]}`}>{r.status}</span>
                {r.status === 'verified' && (
                  <button onClick={() => act('approve_marks', r.exam_subject_id)} disabled={busy}
                    className="text-xs text-indigo-600 font-medium hover:text-indigo-700">Approve</button>
                )}
                {r.status === 'approved' && (
                  <button onClick={() => act('freeze_marks', r.exam_subject_id)} disabled={busy}
                    className="text-xs text-purple-600 font-medium hover:text-purple-700">Freeze</button>
                )}
                {(r.status === 'submitted' || r.status === 'verified') && (
                  <button onClick={() => {
                    const reason = prompt('Return reason (min 10 chars):')
                    if (reason !== null) act('reject_marks', r.exam_subject_id, reason)
                  }} disabled={busy}
                    className="text-xs text-red-500 font-medium hover:text-red-600">Return</button>
                )}
                {r.status === 'frozen' && (
                  <button onClick={() => {
                    const reason = prompt('Reopen reason (min 10 chars — invalidates any computed result):')
                    if (reason !== null) act('reopen_marks', r.exam_subject_id, reason)
                  }} disabled={busy}
                    className="text-xs text-slate-500 font-medium hover:text-slate-700">Reopen</button>
                )}
                <Link href={`/dashboard/my-exams/verify/${r.exam_subject_id}`}
                  className="text-slate-300 hover:text-slate-500"><ChevronRight size={16} /></Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
