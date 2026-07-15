'use client'

// FILE: app/(dashboard)/dashboard/my-exams/page.tsx
// Teacher exam workspace (Phase 4 scope): the teacher's assigned
// papers across active exams, with question paper upload/download.
// Marks entry and exam attendance land here in later phases.

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/utils/supabase/client'
import Link from 'next/link'
import { GraduationCap, Upload, Download, Lock, X, CalendarCheck } from 'lucide-react'
import type { QuestionPaper, TeacherAssignments, SubmissionStatus } from '@/types'
import { ExamStatusBadge, formatDate, formatTime } from '@/components/exams/examUi'
import { uploadQuestionPaper, downloadQuestionPaper } from '@/components/exams/qpActions'
import { useRef } from 'react'
import type { ExamStatus } from '@/types'
import { PencilLine, ClipboardCheck } from 'lucide-react'

interface MyPaper {
  exam_subject_id: string
  exam_id: string
  exam_name: string
  exam_status: ExamStatus
  class_label: string
  subject_name: string
  exam_date: string | null
  start_time: string | null
  qp: QuestionPaper | null
  qp_version: number | null
  marks_status: SubmissionStatus | null
}

interface VerifyItem {
  exam_subject_id: string
  exam_name: string
  class_label: string
  subject_name: string
  status: SubmissionStatus
}

export default function MyExamsPage() {
  const [papers, setPapers] = useState<MyPaper[]>([])
  const [verifyQueue, setVerifyQueue] = useState<VerifyItem[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  const uploadTarget = useRef<string | null>(null)

  const fetchAll = useCallback(async () => {
    const supabase = createClient()
    // my subject assignments (chat17 RPC)
    const { data: ta, error: taErr } = await supabase.rpc('get_teacher_assignments')
    if (taErr) { setError(taErr.message); setLoading(false); return }
    const assignments = (ta as TeacherAssignments)?.subjects ?? []
    if (assignments.length === 0) { setPapers([]); setLoading(false); return }

    const keys = new Set(assignments.map(a => `${a.subject_id}:${a.class_id}`))

    const { data: es } = await supabase
      .from('exam_subjects')
      .select('id, exam_id, class_id, subject_id, exam_date, start_time, is_cancelled, classes(name, section), subjects(name), exams!inner(id, name, status)')
      .in('exams.status', ['draft', 'published', 'ongoing', 'completed'])
      .order('exam_date')

    /* eslint-disable @typescript-eslint/no-explicit-any */
    const rowsAll = (es ?? []) as any[]
    const mine = rowsAll.filter(p => !p.is_cancelled && keys.has(`${p.subject_id}:${p.class_id}`))

    const qpRes = await supabase.from('question_papers').select('*')
    const qps = new Map(((qpRes.data ?? []) as QuestionPaper[]).map(q => [q.exam_subject_id, q]))
    const versionIds = Array.from(qps.values()).map(q => q.current_version_id).filter(Boolean) as string[]
    const vMap = new Map<string, number>()
    if (versionIds.length > 0) {
      const { data: vs } = await supabase.from('question_paper_versions')
        .select('id, version_no').in('id', versionIds)
      ;((vs ?? []) as any[]).forEach(v => vMap.set(v.id, v.version_no))
    }

    // marks submission status per paper (RLS returns only my papers/class)
    const { data: subs } = await supabase.from('marks_submissions').select('exam_subject_id, status')
    const subMap = new Map(((subs ?? []) as any[]).map(s => [s.exam_subject_id, s.status as SubmissionStatus]))

    setPapers(mine.map(p => {
      const qp = qps.get(p.id) ?? null
      return {
        exam_subject_id: p.id,
        exam_id: p.exam_id,
        exam_name: p.exams?.name ?? '—',
        exam_status: p.exams?.status ?? 'draft',
        class_label: p.classes ? `${p.classes.name}${p.classes.section ? '-' + p.classes.section : ''}` : '—',
        subject_name: p.subjects?.name ?? '—',
        exam_date: p.exam_date,
        start_time: p.start_time,
        qp,
        qp_version: qp?.current_version_id ? (vMap.get(qp.current_version_id) ?? null) : null,
        marks_status: subMap.get(p.id) ?? null,
      }
    }))

    // class-teacher verification queue: submitted papers of my classes
    // that I don't teach the subject of (subMap already RLS-scoped).
    const classTeacherOf = new Set((ta as TeacherAssignments)?.class_teacher_of?.map(c => c.class_id) ?? [])
    const vq: VerifyItem[] = rowsAll
      .filter(p => !p.is_cancelled
        && classTeacherOf.has(p.class_id)
        && subMap.get(p.id) === 'submitted')
      .map(p => ({
        exam_subject_id: p.id,
        exam_name: p.exams?.name ?? '—',
        class_label: p.classes ? `${p.classes.name}${p.classes.section ? '-' + p.classes.section : ''}` : '—',
        subject_name: p.subjects?.name ?? '—',
        status: 'submitted' as SubmissionStatus,
      }))
    setVerifyQueue(vq)
    /* eslint-enable @typescript-eslint/no-explicit-any */
    setLoading(false)
  }, [])

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
    setNotice(`Question paper uploaded (v${r.versionNo})`)
    await fetchAll()
  }

  async function download(p: MyPaper) {
    if (!p.qp) return
    setBusy(true); setError('')
    const r = await downloadQuestionPaper(p.qp.id)
    setBusy(false)
    if (!r.ok) setError(r.error)
  }

  // group by exam
  const byExam = papers.reduce<Record<string, MyPaper[]>>((acc, p) => {
    (acc[p.exam_id] = acc[p.exam_id] ?? []).push(p)
    return acc
  }, {})

  return (
    <div className="max-w-3xl mx-auto">
      <input ref={fileInput} type="file" accept="application/pdf" className="hidden" onChange={onFile} />
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">My Exams</h1>
        <p className="text-slate-500 text-sm mt-1">
          Your papers in upcoming and ongoing exams — upload question papers here.
          Marks entry opens once an exam starts.
        </p>
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

      {/* Class-teacher verification queue */}
      {!loading && verifyQueue.length > 0 && (
        <div className="card p-5 mb-4 border-blue-100 bg-blue-50/30">
          <h3 className="font-semibold text-slate-900 text-sm mb-3 flex items-center gap-2">
            <ClipboardCheck size={15} className="text-blue-600" /> To verify (your classes)
          </h3>
          <div className="flex flex-col divide-y divide-blue-100/50">
            {verifyQueue.map(v => (
              <Link key={v.exam_subject_id} href={`/dashboard/my-exams/verify/${v.exam_subject_id}`}
                className="flex items-center justify-between gap-3 py-2.5 group">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-800">{v.subject_name} · {v.class_label}</p>
                  <p className="text-xs text-slate-500">{v.exam_name}</p>
                </div>
                <span className="text-xs text-blue-600 font-medium group-hover:text-blue-700">Review →</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {loading ? (
        <div className="card h-64 animate-pulse bg-slate-50" />
      ) : papers.length === 0 && verifyQueue.length === 0 ? (
        <div className="card flex flex-col items-center justify-center py-16 text-center">
          <div className="w-14 h-14 bg-slate-100 rounded-full flex items-center justify-center mb-4">
            <GraduationCap size={24} className="text-slate-400" />
          </div>
          <h3 className="font-semibold text-slate-900 mb-1">No exam papers assigned</h3>
          <p className="text-sm text-slate-500 max-w-sm">
            When an exam includes a subject and class assigned to you, it shows up here.
          </p>
        </div>
      ) : (
        Object.entries(byExam).map(([examId, list]) => (
          <div key={examId} className="card p-5 mb-4">
            <div className="flex items-center gap-2 mb-3">
              <h3 className="font-semibold text-slate-900 text-sm">{list[0].exam_name}</h3>
              <ExamStatusBadge status={list[0].exam_status} />
            </div>
            <div className="flex flex-col divide-y divide-slate-50">
              {list.map(p => (
                <div key={p.exam_subject_id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-800">
                      {p.subject_name} <span className="text-slate-400 font-normal">· {p.class_label}</span>
                    </p>
                    <p className="text-xs text-slate-500">
                      {p.exam_date ? `${formatDate(p.exam_date)} · ${formatTime(p.start_time)}` : 'Not scheduled yet'}
                      {p.qp && (
                        p.qp.status === 'final'
                          ? <span className="text-emerald-600 font-medium"> · paper final (v{p.qp_version})</span>
                          : <span className="text-blue-600"> · paper draft v{p.qp_version}</span>
                      )}
                      {!p.qp && <span className="text-amber-600"> · question paper pending</span>}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {(p.exam_status === 'ongoing' || p.exam_status === 'completed') && (
                      <Link href={`/dashboard/my-exams/marks/${p.exam_subject_id}`}
                        className="btn-secondary text-xs flex items-center gap-1">
                        <PencilLine size={12} />
                        {p.marks_status && p.marks_status !== 'pending'
                          ? (p.marks_status === 'rejected' ? 'Fix marks' : 'Marks')
                          : 'Enter marks'}
                      </Link>
                    )}
                    {p.exam_status === 'ongoing' && (
                      <Link href={`/dashboard/my-exams/attendance/${p.exam_subject_id}`}
                        className="btn-secondary text-xs flex items-center gap-1">
                        <CalendarCheck size={12} /> Attendance
                      </Link>
                    )}
                    {p.qp?.status === 'final' ? (
                      <span className="text-xs text-slate-400 flex items-center gap-1"><Lock size={11} /> locked</span>
                    ) : (
                      <button onClick={() => pickFile(p.exam_subject_id)} disabled={busy}
                        className="btn-secondary text-xs flex items-center gap-1">
                        <Upload size={12} /> {p.qp ? 'New version' : 'Upload paper'}
                      </button>
                    )}
                    {p.qp?.current_version_id && (
                      <button onClick={() => download(p)} disabled={busy}
                        className="text-xs px-2 py-1 rounded text-slate-500 hover:bg-slate-100 flex items-center gap-1">
                        <Download size={12} /> Open
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  )
}
