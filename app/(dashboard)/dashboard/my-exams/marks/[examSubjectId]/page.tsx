'use client'

// FILE: app/(dashboard)/dashboard/my-exams/marks/[examSubjectId]/page.tsx
// Subject teacher marks entry + submit. Grid autosaves; Submit runs
// the DB completeness + attendance cross-check.

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { createClient } from '@/utils/supabase/client'
import { ArrowLeft, X, Send, CheckCircle2 } from 'lucide-react'
import type { SubmissionStatus } from '@/types'
import { classLabel, formatDate } from '@/components/exams/examUi'
import MarksGrid from '@/components/exams/MarksGrid'

const STATUS_LABEL: Record<SubmissionStatus, { text: string; cls: string }> = {
  pending:   { text: 'Draft — not submitted', cls: 'bg-slate-100 text-slate-600' },
  submitted: { text: 'Submitted — awaiting verification', cls: 'bg-blue-50 text-blue-700' },
  verified:  { text: 'Verified by class teacher', cls: 'bg-emerald-50 text-emerald-700' },
  approved:  { text: 'Approved by principal', cls: 'bg-indigo-50 text-indigo-700' },
  frozen:    { text: 'Frozen — final', cls: 'bg-purple-50 text-purple-700' },
  rejected:  { text: 'Returned for correction', cls: 'bg-red-50 text-red-600' },
}

export default function MarksEntryPage() {
  const { examSubjectId } = useParams<{ examSubjectId: string }>()
  const [meta, setMeta] = useState<{ exam_name: string; class_label: string; subject_name: string; exam_date: string | null } | null>(null)
  const [status, setStatus] = useState<SubmissionStatus>('pending')
  const [rejection, setRejection] = useState<string | null>(null)
  const [progress, setProgress] = useState({ entered: 0, total: 0 })
  const [reload, setReload] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const fetchMeta = useCallback(async () => {
    const supabase = createClient()
    const { data } = await supabase.from('exam_subjects')
      .select('exam_date, classes(name, section), subjects(name), exams(name)')
      .eq('id', examSubjectId).single()
    if (data) {
      const d = data as any
      setMeta({
        exam_name: d.exams?.name ?? '—',
        class_label: classLabel(d.classes),
        subject_name: d.subjects?.name ?? '—',
        exam_date: d.exam_date,
      })
    }
    const { data: sub } = await supabase.from('marks_submissions')
      .select('rejection_reason').eq('exam_subject_id', examSubjectId).maybeSingle()
    setRejection((sub as any)?.rejection_reason ?? null)
  }, [examSubjectId])

  useEffect(() => { fetchMeta() }, [fetchMeta, reload])

  async function submit() {
    if (!confirm('Submit these marks for verification? You will not be able to edit until they are verified or returned.')) return
    setBusy(true); setError(''); setNotice('')
    const supabase = createClient()
    const { error } = await supabase.rpc('submit_marks', { p_exam_subject_id: examSubjectId })
    setBusy(false)
    if (error) { setError(error.message); return }
    setNotice('Submitted for verification')
    setReload(x => x + 1)
  }

  const canSubmit = status === 'pending' || status === 'rejected'

  return (
    <div className="max-w-3xl mx-auto">
      <Link href="/dashboard/my-exams" className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600 mb-1">
        <ArrowLeft size={12} /> My Exams
      </Link>
      {meta && (
        <div className="mb-4">
          <h1 className="text-2xl font-bold text-slate-900">{meta.subject_name} — {meta.class_label}</h1>
          <p className="text-slate-500 text-sm mt-1">
            {meta.exam_name}{meta.exam_date ? ` · ${formatDate(meta.exam_date)}` : ''}
          </p>
        </div>
      )}

      <div className={`text-xs font-medium px-3 py-1.5 rounded-lg inline-block mb-3 ${STATUS_LABEL[status].cls}`}>
        {STATUS_LABEL[status].text}
      </div>
      {status === 'rejected' && rejection && (
        <div className="bg-red-50 text-red-700 text-sm px-4 py-3 rounded-lg mb-3">
          <span className="font-medium">Returned:</span> {rejection}
        </div>
      )}

      {error && (
        <div className="bg-red-50 text-red-600 text-sm px-4 py-3 rounded-lg mb-3 flex items-start justify-between gap-3">
          <span>{error}</span><button onClick={() => setError('')}><X size={14} /></button>
        </div>
      )}
      {notice && (
        <div className="bg-emerald-50 text-emerald-700 text-sm px-4 py-3 rounded-lg mb-3 flex items-center gap-2">
          <CheckCircle2 size={15} /> {notice}
        </div>
      )}

      <MarksGrid
        examSubjectId={examSubjectId}
        reload={reload}
        onStatus={setStatus}
        onProgress={(entered, total) => setProgress({ entered, total })}
      />

      <div className="sticky bottom-4 mt-4 flex items-center justify-between gap-3">
        <span className="text-xs text-slate-500 bg-white/80 px-2 py-1 rounded">
          {progress.entered}/{progress.total} entered
        </span>
        {canSubmit && (
          <button onClick={submit} disabled={busy}
            className="btn-primary text-sm flex items-center gap-1.5 shadow-lg">
            <Send size={15} /> {busy ? 'Submitting…' : 'Submit for verification'}
          </button>
        )}
      </div>
    </div>
  )
}
