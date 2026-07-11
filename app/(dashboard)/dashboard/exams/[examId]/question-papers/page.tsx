'use client'

// FILE: app/(dashboard)/dashboard/exams/[examId]/question-papers/page.tsx
// Admin board: per-paper question paper status, upload (admins can too),
// download (logged), final lock / admin unlock, access-log drawer.

import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { createClient } from '@/utils/supabase/client'
import { ArrowLeft, X, FileText, Upload, Download, Lock, LockOpen, History } from 'lucide-react'
import type { Exam, QuestionPaper, QuestionPaperVersion, QuestionPaperAccessLog } from '@/types'
import { ExamStatusBadge, classLabel, formatDate } from '@/components/exams/examUi'
import { uploadQuestionPaper, downloadQuestionPaper } from '@/components/exams/qpActions'

interface PaperRow {
  exam_subject_id: string
  class_id: string
  class_label: string
  subject_name: string
  exam_date: string | null
  is_cancelled: boolean
  qp: QuestionPaper | null
  current_version_no: number | null
}

export default function QuestionPapersBoardPage() {
  const { examId } = useParams<{ examId: string }>()
  const router = useRouter()

  const [exam, setExam] = useState<Exam | null>(null)
  const [rows, setRows] = useState<PaperRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [logsFor, setLogsFor] = useState<{ row: PaperRow; logs: QuestionPaperAccessLog[]; versions: QuestionPaperVersion[] } | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const uploadTarget = useRef<string | null>(null)

  const fetchAll = useCallback(async () => {
    const supabase = createClient()
    const eRes = await supabase.from('exams').select('*').eq('id', examId).single()
    if (eRes.error || !eRes.data) { router.push('/dashboard/exams'); return }
    setExam(eRes.data as Exam)

    const [esRes, qpRes] = await Promise.all([
      supabase.from('exam_subjects')
        .select('id, class_id, exam_date, is_cancelled, classes(name, section), subjects(name)')
        .eq('exam_id', examId).order('exam_date'),
      supabase.from('question_papers').select('*'),
    ])
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const qps = (qpRes.data ?? []) as QuestionPaper[]
    const qpByPaper = new Map(qps.map(q => [q.exam_subject_id, q]))
    const versionIds = qps.map(q => q.current_version_id).filter(Boolean) as string[]
    const vMap = new Map<string, number>()
    if (versionIds.length > 0) {
      const { data: vs } = await supabase.from('question_paper_versions')
        .select('id, version_no').in('id', versionIds)
      ;((vs ?? []) as any[]).forEach(v => vMap.set(v.id, v.version_no))
    }
    setRows(((esRes.data ?? []) as any[]).map(es => {
      const qp = qpByPaper.get(es.id) ?? null
      return {
        exam_subject_id: es.id,
        class_id: es.class_id,
        class_label: classLabel(es.classes),
        subject_name: es.subjects?.name ?? '—',
        exam_date: es.exam_date,
        is_cancelled: es.is_cancelled,
        qp,
        current_version_no: qp?.current_version_id ? (vMap.get(qp.current_version_id) ?? null) : null,
      }
    }).sort((a, b) => a.class_label.localeCompare(b.class_label) || a.subject_name.localeCompare(b.subject_name)))
    /* eslint-enable @typescript-eslint/no-explicit-any */
    setLoading(false)
  }, [examId, router])

  useEffect(() => { fetchAll() }, [fetchAll])

  function pickFile(examSubjectId: string) {
    uploadTarget.current = examSubjectId
    fileInput.current?.click()
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !uploadTarget.current) return
    setBusy(true); setError(''); setNotice('')
    const r = await uploadQuestionPaper(uploadTarget.current, file)
    setBusy(false)
    if (!r.ok) { setError(r.error); return }
    setNotice(`Uploaded v${r.versionNo}`)
    await fetchAll()
  }

  async function download(row: PaperRow) {
    if (!row.qp) return
    setBusy(true); setError('')
    const r = await downloadQuestionPaper(row.qp.id)
    setBusy(false)
    if (!r.ok) setError(r.error)
  }

  async function toggleLock(row: PaperRow) {
    if (!row.qp) return
    setBusy(true); setError(''); setNotice('')
    const supabase = createClient()
    if (row.qp.status === 'draft') {
      if (!confirm(`Mark ${row.subject_name} (${row.class_label}) as FINAL?\n\nUploads are blocked until the school admin unlocks it.`)) { setBusy(false); return }
      const { error } = await supabase.rpc('lock_question_paper', { p_question_paper_id: row.qp.id })
      if (error) { setError(error.message); setBusy(false); return }
    } else {
      const reason = prompt('Unlock reason (required, min 10 characters — recorded):')
      if (reason === null) { setBusy(false); return }
      const { error } = await supabase.rpc('unlock_question_paper', { p_question_paper_id: row.qp.id, p_reason: reason })
      if (error) { setError(error.message); setBusy(false); return }
    }
    setBusy(false)
    await fetchAll()
  }

  async function openLogs(row: PaperRow) {
    if (!row.qp) return
    const supabase = createClient()
    const [lRes, vRes] = await Promise.all([
      supabase.from('question_paper_access_logs')
        .select('*, profiles(full_name)')
        .eq('question_paper_id', row.qp.id)
        .order('created_at', { ascending: false }).limit(100),
      supabase.from('question_paper_versions')
        .select('*').eq('question_paper_id', row.qp.id)
        .order('version_no', { ascending: false }),
    ])
    setLogsFor({
      row,
      logs: (lRes.data ?? []) as unknown as QuestionPaperAccessLog[],
      versions: (vRes.data ?? []) as QuestionPaperVersion[],
    })
  }

  if (loading || !exam) {
    return <div className="max-w-4xl mx-auto"><div className="card h-96 animate-pulse bg-slate-50" /></div>
  }

  const finalCount = rows.filter(r => r.qp?.status === 'final').length
  const liveRows = rows.filter(r => !r.is_cancelled)

  return (
    <div className="max-w-4xl mx-auto">
      <input ref={fileInput} type="file" accept="application/pdf" className="hidden" onChange={onFile} />
      <Link href={`/dashboard/exams/${examId}`} className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600 mb-1">
        <ArrowLeft size={12} /> {exam.name}
      </Link>
      <div className="flex items-center justify-between gap-3 mb-6">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-slate-900">Question papers</h1>
            <ExamStatusBadge status={exam.status} />
          </div>
          <p className="text-slate-500 text-sm mt-1">
            {finalCount}/{liveRows.length} final · uploads by assigned subject teachers or admins ·
            every view/download is logged
          </p>
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

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[620px]">
            <thead>
              <tr className="text-left text-xs text-slate-400 border-b border-slate-100">
                <th className="px-4 py-3 font-medium">Class</th>
                <th className="px-4 py-3 font-medium">Subject</th>
                <th className="px-4 py-3 font-medium">Exam date</th>
                <th className="px-4 py-3 font-medium">Paper</th>
                <th className="px-4 py-3 font-medium w-56">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {liveRows.map(row => (
                <tr key={row.exam_subject_id}>
                  <td className="px-4 py-2.5 font-medium text-slate-800">{row.class_label}</td>
                  <td className="px-4 py-2.5 text-slate-700">{row.subject_name}</td>
                  <td className="px-4 py-2.5 text-slate-500 text-xs">{formatDate(row.exam_date)}</td>
                  <td className="px-4 py-2.5">
                    {!row.qp ? (
                      <span className="text-xs text-slate-400">not uploaded</span>
                    ) : row.qp.status === 'final' ? (
                      <span className="badge-green inline-flex items-center gap-1"><Lock size={10} /> final v{row.current_version_no}</span>
                    ) : (
                      <span className="badge-blue">draft v{row.current_version_no ?? '?'}</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-1 flex-wrap">
                      {(!row.qp || row.qp.status === 'draft') && (
                        <button onClick={() => pickFile(row.exam_subject_id)} disabled={busy}
                          className="text-xs px-2 py-1 rounded text-slate-500 hover:bg-slate-100 flex items-center gap-1">
                          <Upload size={12} /> Upload
                        </button>
                      )}
                      {row.qp?.current_version_id && (
                        <button onClick={() => download(row)} disabled={busy}
                          className="text-xs px-2 py-1 rounded text-slate-500 hover:bg-slate-100 flex items-center gap-1">
                          <Download size={12} /> Download
                        </button>
                      )}
                      {row.qp?.current_version_id && (
                        <button onClick={() => toggleLock(row)} disabled={busy}
                          className={`text-xs px-2 py-1 rounded flex items-center gap-1 ${
                            row.qp.status === 'draft'
                              ? 'text-purple-600 hover:bg-purple-50'
                              : 'text-slate-500 hover:bg-slate-100'
                          }`}>
                          {row.qp.status === 'draft' ? <><Lock size={12} /> Lock final</> : <><LockOpen size={12} /> Unlock</>}
                        </button>
                      )}
                      {row.qp && (
                        <button onClick={() => openLogs(row)} disabled={busy}
                          className="text-xs px-2 py-1 rounded text-slate-500 hover:bg-slate-100 flex items-center gap-1">
                          <History size={12} /> Log
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {liveRows.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-10 text-center text-sm text-slate-400">
                  <FileText size={22} className="mx-auto mb-2 text-slate-300" />
                  Configure papers first — question papers attach to them.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Access log drawer */}
      {logsFor && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between p-5 border-b border-slate-100">
              <h2 className="font-semibold text-slate-900 text-sm">
                {logsFor.row.subject_name} ({logsFor.row.class_label}) — history
              </h2>
              <button onClick={() => setLogsFor(null)} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100">
                <X size={18} className="text-slate-500" />
              </button>
            </div>
            <div className="p-5 overflow-y-auto flex flex-col gap-4">
              <div>
                <h3 className="text-xs font-semibold text-slate-500 mb-2">Versions</h3>
                {logsFor.versions.map(v => (
                  <div key={v.id} className="flex items-center justify-between text-xs py-1.5 border-b border-slate-50">
                    <span className="text-slate-700 font-medium">v{v.version_no}{v.note ? ` — ${v.note}` : ''}</span>
                    <button
                      onClick={() => downloadQuestionPaper(logsFor.row.qp!.id, v.id).then(r => { if (!r.ok) setError(r.error) })}
                      className="text-brand-600 hover:text-brand-700 flex items-center gap-1">
                      <Download size={11} /> open
                    </button>
                  </div>
                ))}
              </div>
              <div>
                <h3 className="text-xs font-semibold text-slate-500 mb-2">Access log (latest 100)</h3>
                {logsFor.logs.length === 0 ? (
                  <p className="text-xs text-slate-400">No entries.</p>
                ) : logsFor.logs.map(l => (
                  <div key={l.id} className="flex items-center justify-between text-xs py-1.5 border-b border-slate-50">
                    <span className="text-slate-600">
                      <span className="font-medium capitalize">{l.action}</span>
                      {' · '}{l.profiles?.full_name ?? 'unknown'}
                    </span>
                    <span className="text-slate-400">
                      {new Date(l.created_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
