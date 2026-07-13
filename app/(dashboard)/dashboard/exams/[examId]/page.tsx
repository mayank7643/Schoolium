'use client'

// FILE: app/(dashboard)/dashboard/exams/[examId]/page.tsx
// Exam cockpit: status, lifecycle checklist, state-machine actions.
// Every action is a chat21 RPC; buttons disable with a reason when the
// state machine forbids them.

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { createClient } from '@/utils/supabase/client'
import {
  ArrowLeft, Settings2, Users, ShieldCheck, AlertTriangle, ChevronRight,
  Send, Play, Flag, Lock, LockOpen, Ban, Trash2, X, CheckCircle2, Circle, Contact, FileText, CalendarCheck, ClipboardCheck, Award,
} from 'lucide-react'
import type { Exam, TimetableIssue, PublishExamResult } from '@/types'
import { ExamStatusBadge, formatDate } from '@/components/exams/examUi'

interface Counts {
  classes: number
  papers: number
  unscheduled: number
  enrollments: number
  admitCards: number
}

export default function ExamCockpitPage() {
  const { examId } = useParams<{ examId: string }>()
  const router = useRouter()

  const [exam, setExam] = useState<Exam | null>(null)
  const [counts, setCounts] = useState<Counts>({ classes: 0, papers: 0, unscheduled: 0, enrollments: 0, admitCards: 0 })
  const [issues, setIssues] = useState<TimetableIssue[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const fetchAll = useCallback(async () => {
    const supabase = createClient()
    const [eRes, ecRes, esRes, enRes, acRes] = await Promise.all([
      supabase.from('exams').select('*, exam_types(name, code, category), academic_terms(name), academic_sessions(name)').eq('id', examId).single(),
      supabase.from('exam_classes').select('id', { count: 'exact', head: true }).eq('exam_id', examId),
      supabase.from('exam_subjects').select('id, exam_date, start_time, duration_minutes, is_cancelled').eq('exam_id', examId),
      supabase.from('exam_enrollments').select('id', { count: 'exact', head: true }).eq('exam_id', examId),
      supabase.from('admit_cards').select('id', { count: 'exact', head: true }).eq('exam_id', examId).eq('is_revoked', false),
    ])
    if (eRes.error || !eRes.data) { router.push('/dashboard/exams'); return }
    setExam(eRes.data as Exam)
    const papers = (esRes.data ?? []) as Array<{ exam_date: string | null; start_time: string | null; duration_minutes: number | null; is_cancelled: boolean }>
    const live = papers.filter(p => !p.is_cancelled)
    setCounts({
      classes: ecRes.count ?? 0,
      papers: live.length,
      unscheduled: live.filter(p => !p.exam_date || !p.start_time || !p.duration_minutes).length,
      enrollments: enRes.count ?? 0,
      admitCards: acRes.count ?? 0,
    })
    setLoading(false)
  }, [examId, router])

  useEffect(() => { fetchAll() }, [fetchAll])

  async function rpc(fn: string, args: Record<string, unknown>, opts?: { confirmMsg?: string; reasonPrompt?: string; onDone?: (data: unknown) => void }) {
    if (opts?.confirmMsg && !confirm(opts.confirmMsg)) return
    if (opts?.reasonPrompt) {
      const reason = prompt(opts.reasonPrompt)
      if (reason === null) return
      args = { ...args, p_reason: reason }
    }
    setBusy(true); setError(''); setNotice(''); setIssues(null)
    const supabase = createClient()
    const { data, error } = await supabase.rpc(fn, args)
    setBusy(false)
    if (error) { setError(error.message); return }
    opts?.onDone?.(data)
    await fetchAll()
  }

  async function runValidation() {
    setBusy(true); setError('')
    const supabase = createClient()
    const { data, error } = await supabase.rpc('validate_exam_timetable', { p_exam_id: examId })
    setBusy(false)
    if (error) { setError(error.message); return }
    setIssues((data ?? []) as TimetableIssue[])
  }

  if (loading || !exam) {
    return <div className="max-w-4xl mx-auto"><div className="card h-96 animate-pulse bg-slate-50" /></div>
  }

  const st = exam.status
  const errorCount = issues?.filter(i => i.severity === 'error').length ?? null

  const checklist: Array<{ label: string; done: boolean; detail: string; href?: string }> = [
    {
      label: 'Classes selected', done: counts.classes > 0,
      detail: counts.classes > 0 ? `${counts.classes} class(es)` : 'None yet',
      href: `/dashboard/exams/${examId}/configure`,
    },
    {
      label: 'Papers configured', done: counts.papers > 0,
      detail: counts.papers > 0 ? `${counts.papers} paper(s)` : 'None yet',
      href: `/dashboard/exams/${examId}/configure`,
    },
    {
      label: 'Timetable complete', done: counts.papers > 0 && counts.unscheduled === 0,
      detail: counts.unscheduled > 0 ? `${counts.unscheduled} paper(s) missing date/time` : 'All papers scheduled',
      href: `/dashboard/exams/${examId}/configure`,
    },
    {
      label: 'Published & students enrolled', done: counts.enrollments > 0,
      detail: counts.enrollments > 0 ? `${counts.enrollments} student(s) enrolled` : 'Enrollments are generated on publish',
      href: counts.enrollments > 0 ? `/dashboard/exams/${examId}/enrollments` : undefined,
    },
    {
      label: 'Admit cards generated', done: counts.admitCards > 0 && counts.admitCards >= counts.enrollments - 0,
      detail: counts.admitCards > 0
        ? `${counts.admitCards} card(s) live`
        : counts.enrollments > 0 ? 'Generate once the timetable is final' : 'Available after publish',
      href: counts.enrollments > 0 ? `/dashboard/exams/${examId}/admit-cards` : undefined,
    },
  ]

  return (
    <div className="max-w-4xl mx-auto">
      <Link href="/dashboard/exams" className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600 mb-1">
        <ArrowLeft size={12} /> Exams
      </Link>

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3 mb-6">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-2xl font-bold text-slate-900">{exam.name}</h1>
            <ExamStatusBadge status={st} />
          </div>
          <p className="text-slate-500 text-sm mt-1">
            {exam.exam_types?.name ?? '—'}
            {exam.academic_terms?.name ? ` · ${exam.academic_terms.name}` : ''}
            {exam.academic_sessions?.name ? ` · ${exam.academic_sessions.name}` : ''}
            {exam.start_date ? ` · ${formatDate(exam.start_date)} – ${formatDate(exam.end_date)}` : ''}
          </p>
          {st === 'cancelled' && exam.cancel_reason && (
            <p className="text-xs text-red-500 mt-1">Cancelled: {exam.cancel_reason}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {(st === 'draft' || st === 'published') && (
            <Link href={`/dashboard/exams/${examId}/configure`} className="btn-secondary text-sm flex items-center gap-1.5">
              <Settings2 size={15} /> Configure
            </Link>
          )}
          {counts.enrollments > 0 && (
            <Link href={`/dashboard/exams/${examId}/enrollments`} className="btn-secondary text-sm flex items-center gap-1.5">
              <Users size={15} /> Enrollments
            </Link>
          )}
          {(st === 'published' || st === 'ongoing') && (
            <Link href={`/dashboard/exams/${examId}/admit-cards`} className="btn-secondary text-sm flex items-center gap-1.5">
              <Contact size={15} /> Admit cards
            </Link>
          )}
          {counts.papers > 0 && st !== 'cancelled' && (
            <Link href={`/dashboard/exams/${examId}/question-papers`} className="btn-secondary text-sm flex items-center gap-1.5">
              <FileText size={15} /> Question papers
            </Link>
          )}
          {(st === 'ongoing' || st === 'completed') && (
            <Link href={`/dashboard/exams/${examId}/attendance`} className="btn-secondary text-sm flex items-center gap-1.5">
              <CalendarCheck size={15} /> Attendance
            </Link>
          )}
          {(st === 'ongoing' || st === 'completed' || st === 'locked') && (
            <Link href={`/dashboard/exams/${examId}/marks`} className="btn-secondary text-sm flex items-center gap-1.5">
              <ClipboardCheck size={15} /> Marks
            </Link>
          )}
          {(st === 'completed' || st === 'locked') && (
            <Link href={`/dashboard/exams/${examId}/results`} className="btn-secondary text-sm flex items-center gap-1.5">
              <Award size={15} /> Results
            </Link>
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

      {/* Checklist */}
      <div className="card p-5 mb-4">
        <h3 className="font-semibold text-slate-900 text-sm mb-3">Lifecycle checklist</h3>
        <div className="flex flex-col divide-y divide-slate-50">
          {checklist.map((item, idx) => (
            <div key={idx} className="flex items-center justify-between gap-3 py-2.5">
              <div className="flex items-center gap-2.5 min-w-0">
                {item.done
                  ? <CheckCircle2 size={17} className="text-emerald-500 shrink-0" />
                  : <Circle size={17} className="text-slate-300 shrink-0" />}
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-800">{item.label}</p>
                  <p className="text-xs text-slate-400">{item.detail}</p>
                </div>
              </div>
              {item.href && (
                <Link href={item.href} className="text-slate-300 hover:text-slate-500">
                  <ChevronRight size={16} />
                </Link>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Validation */}
      {(st === 'draft' || st === 'published') && (
        <div className="card p-5 mb-4">
          <div className="flex items-center justify-between mb-1">
            <h3 className="font-semibold text-slate-900 text-sm flex items-center gap-2">
              <ShieldCheck size={15} className="text-brand-600" /> Timetable check
            </h3>
            <button onClick={runValidation} disabled={busy} className="btn-secondary text-xs">Run check</button>
          </div>
          {issues === null ? (
            <p className="text-xs text-slate-400">Run the check before publishing — publish is blocked while errors remain.</p>
          ) : issues.length === 0 ? (
            <p className="text-xs text-emerald-600 font-medium">All clear — ready to publish.</p>
          ) : (
            <ul className="flex flex-col gap-1.5 mt-2">
              {issues.map((i, idx) => (
                <li key={idx} className={`text-xs flex items-start gap-2 px-3 py-2 rounded-lg ${
                  i.severity === 'error' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-700'
                }`}>
                  <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                  <span><span className="font-medium">{i.code}</span> — {i.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="card p-5">
        <h3 className="font-semibold text-slate-900 text-sm mb-3">Actions</h3>
        <div className="flex flex-wrap gap-2">
          {st === 'draft' && (
            <>
              <button
                disabled={busy || counts.classes === 0 || counts.papers === 0 || counts.unscheduled > 0 || errorCount === null || errorCount > 0}
                title={
                  counts.classes === 0 ? 'Add classes first'
                  : counts.papers === 0 ? 'Add papers first'
                  : counts.unscheduled > 0 ? 'Every paper needs date, time and duration'
                  : errorCount === null ? 'Run the timetable check first'
                  : errorCount > 0 ? 'Fix timetable errors first'
                  : 'Publish and enroll students'
                }
                onClick={() => rpc('publish_exam', { p_exam_id: examId }, {
                  confirmMsg: 'Publish this exam?\n\nStudents of the selected classes are enrolled and roll numbers assigned. The marks scheme becomes locked.',
                  onDone: (d) => {
                    const r = d as PublishExamResult
                    setNotice(`Published — ${r.enrolled} student(s) enrolled`)
                  },
                })}
                className="btn-primary text-sm flex items-center gap-1.5 disabled:opacity-50"
              >
                <Send size={15} /> Publish
              </button>
              <button disabled={busy}
                onClick={() => rpc('delete_exam', { p_exam_id: examId }, {
                  confirmMsg: `Delete draft exam "${exam.name}"? This cannot be undone.`,
                  onDone: () => router.push('/dashboard/exams'),
                })}
                className="btn-secondary text-sm flex items-center gap-1.5 !text-red-600">
                <Trash2 size={15} /> Delete draft
              </button>
            </>
          )}

          {st === 'published' && (
            <>
              <button disabled={busy}
                onClick={() => rpc('start_exam', { p_exam_id: examId }, {
                  confirmMsg: 'Mark this exam as ongoing now? (It also flips automatically on the first paper date.)',
                })}
                className="btn-primary text-sm flex items-center gap-1.5">
                <Play size={15} /> Start now
              </button>
              <button disabled={busy}
                onClick={() => rpc('unpublish_exam', { p_exam_id: examId }, {
                  confirmMsg: 'Unpublish back to draft?\n\nEnrollments (and roll numbers) are removed and regenerated on the next publish.',
                })}
                className="btn-secondary text-sm">
                Unpublish
              </button>
            </>
          )}

          {st === 'ongoing' && (
            <button disabled={busy}
              onClick={() => rpc('complete_exam', { p_exam_id: examId }, {
                confirmMsg: 'Mark this exam completed? (It also flips automatically after the last paper date.)',
              })}
              className="btn-primary text-sm flex items-center gap-1.5">
              <Flag size={15} /> Mark completed
            </button>
          )}

          {st === 'completed' && (
            <button disabled={busy}
              onClick={() => rpc('lock_exam', { p_exam_id: examId }, {
                confirmMsg: 'Lock this exam?\n\nEverything becomes read-only. Only the school admin can unlock, with a recorded reason.',
              })}
              className="btn-primary text-sm flex items-center gap-1.5">
              <Lock size={15} /> Lock exam
            </button>
          )}

          {st === 'locked' && (
            <button disabled={busy}
              onClick={() => rpc('unlock_exam', { p_exam_id: examId }, {
                reasonPrompt: 'Unlock reason (required, min 10 characters — recorded in the audit log):',
              })}
              className="btn-secondary text-sm flex items-center gap-1.5">
              <LockOpen size={15} /> Unlock (admin)
            </button>
          )}

          {(st === 'draft' || st === 'published' || st === 'ongoing') && (
            <button disabled={busy}
              onClick={() => rpc('cancel_exam', { p_exam_id: examId }, {
                reasonPrompt: 'Cancellation reason (required, min 10 characters — parents of affected classes should be informed):',
              })}
              className="btn-secondary text-sm flex items-center gap-1.5 !text-red-600">
              <Ban size={15} /> Cancel exam
            </button>
          )}

          {st === 'cancelled' && (
            <button disabled={busy}
              onClick={() => rpc('delete_exam', { p_exam_id: examId }, {
                confirmMsg: `Delete cancelled exam "${exam.name}" permanently?`,
                onDone: () => router.push('/dashboard/exams'),
              })}
              className="btn-secondary text-sm flex items-center gap-1.5 !text-red-600">
              <Trash2 size={15} /> Delete
            </button>
          )}
        </div>
        {st === 'draft' && (
          <p className="text-xs text-slate-400 mt-3">
            Publishing validates the timetable, enrolls every active student of the selected
            classes and assigns roll numbers. Coming phases add admit cards, question papers,
            exam attendance, marks and results on top of this exam.
          </p>
        )}
      </div>
    </div>
  )
}
