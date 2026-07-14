'use client'

// FILE: app/(dashboard)/dashboard/exams/[examId]/results/publish/page.tsx
// Result publishing: publish now / schedule / unpublish / lock, with
// notification-target count. Actual message dispatch is pipeline-
// agnostic (get_result_notification_targets feeds whatever sends them).

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { createClient } from '@/utils/supabase/client'
import { ArrowLeft, X, Send, Clock, EyeOff, Lock, Globe, Copy } from 'lucide-react'
import type { Exam, ResultPublication, PublicationStatus } from '@/types'
import { ExamStatusBadge } from '@/components/exams/examUi'

const PUB_BADGE: Record<PublicationStatus, { label: string; cls: string }> = {
  unpublished: { label: 'Not published', cls: 'bg-slate-100 text-slate-600' },
  scheduled:   { label: 'Scheduled', cls: 'bg-blue-50 text-blue-700' },
  published:   { label: 'Published', cls: 'bg-emerald-50 text-emerald-700' },
  locked:      { label: 'Locked', cls: 'bg-purple-50 text-purple-700' },
}

export default function PublishResultsPage() {
  const { examId } = useParams<{ examId: string }>()
  const router = useRouter()
  const [exam, setExam] = useState<Exam | null>(null)
  const [pub, setPub] = useState<ResultPublication | null>(null)
  const [targets, setTargets] = useState(0)
  const [schoolId, setSchoolId] = useState('')
  const [scheduleAt, setScheduleAt] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const fetchAll = useCallback(async () => {
    const supabase = createClient()
    const [eRes, pRes, tRes, profRes] = await Promise.all([
      supabase.from('exams').select('*').eq('id', examId).single(),
      supabase.from('result_publications').select('*').eq('exam_id', examId).maybeSingle(),
      supabase.rpc('get_result_notification_targets', { p_exam_id: examId }),
      supabase.from('profiles').select('school_id').single(),
    ])
    if (eRes.error || !eRes.data) { router.push('/dashboard/exams'); return }
    setExam(eRes.data as Exam)
    setPub((pRes.data ?? null) as ResultPublication | null)
    setTargets(((tRes.data ?? []) as unknown[]).length)
    setSchoolId((profRes.data as { school_id: string } | null)?.school_id ?? '')
    setLoading(false)
  }, [examId, router])

  useEffect(() => { fetchAll() }, [fetchAll])

  async function rpc(fn: string, args: Record<string, unknown>, confirmMsg?: string, successMsg?: string) {
    if (confirmMsg && !confirm(confirmMsg)) return
    setBusy(true); setError(''); setNotice('')
    const supabase = createClient()
    const { error } = await supabase.rpc(fn, args)
    setBusy(false)
    if (error) { setError(error.message); return }
    if (successMsg) setNotice(successMsg)
    await fetchAll()
  }

  if (loading || !exam) {
    return <div className="max-w-2xl mx-auto"><div className="card h-96 animate-pulse bg-slate-50" /></div>
  }

  const status: PublicationStatus = pub?.status ?? 'unpublished'
  const publicUrl = typeof window !== 'undefined' ? `${window.location.origin}/results/${schoolId}` : ''

  return (
    <div className="max-w-2xl mx-auto">
      <Link href={`/dashboard/exams/${examId}/results`} className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600 mb-1">
        <ArrowLeft size={12} /> Results
      </Link>
      <div className="flex items-center justify-between gap-3 mb-6">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-slate-900">Publish results</h1>
            <ExamStatusBadge status={exam.status} />
          </div>
          <p className="text-slate-500 text-sm mt-1">{exam.name}</p>
        </div>
        <span className={`text-xs font-medium px-3 py-1.5 rounded-lg ${PUB_BADGE[status].cls}`}>{PUB_BADGE[status].label}</span>
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

      {status === 'scheduled' && pub?.scheduled_for && (
        <div className="bg-blue-50 text-blue-700 text-sm px-4 py-3 rounded-lg mb-4">
          Scheduled to publish on {new Date(pub.scheduled_for).toLocaleString('en-IN')}
        </div>
      )}

      {/* Actions */}
      <div className="card p-5 mb-4">
        <h3 className="font-semibold text-slate-900 text-sm mb-3">Actions</h3>
        <div className="flex flex-wrap gap-2">
          {(status === 'unpublished' || status === 'scheduled') && (
            <button onClick={() => rpc('publish_results', { p_exam_id: examId },
              `Publish results now?\n\n${targets} parent(s) can be notified and the public result page goes live.`,
              'Results published')}
              disabled={busy} className="btn-primary text-sm flex items-center gap-1.5">
              <Send size={15} /> Publish now
            </button>
          )}
          {status === 'published' && (
            <>
              <button onClick={() => rpc('unpublish_results', { p_exam_id: examId },
                'Unpublish results? The public page and portal access are hidden immediately (already-sent messages are not recalled).',
                'Results unpublished')}
                disabled={busy} className="btn-secondary text-sm flex items-center gap-1.5">
                <EyeOff size={15} /> Unpublish
              </button>
              <button onClick={() => rpc('lock_results', { p_exam_id: examId },
                'Lock results permanently? This is final — marks can no longer be reopened and results cannot be unpublished.',
                'Results locked')}
                disabled={busy} className="btn-secondary text-sm flex items-center gap-1.5 !text-purple-600">
                <Lock size={15} /> Lock (final)
              </button>
            </>
          )}
          {status === 'locked' && (
            <p className="text-sm text-slate-500">Results are locked — this is terminal.</p>
          )}
        </div>

        {/* Schedule */}
        {(status === 'unpublished' || status === 'scheduled') && (
          <div className="mt-4 pt-4 border-t border-slate-100">
            <label className="label">Or schedule for later</label>
            <div className="flex items-center gap-2">
              <input type="datetime-local" className="input !w-auto text-sm"
                value={scheduleAt} onChange={e => setScheduleAt(e.target.value)} />
              <button
                disabled={busy || !scheduleAt}
                onClick={() => rpc('schedule_results', { p_exam_id: examId, p_when: new Date(scheduleAt).toISOString() },
                  undefined, 'Scheduled')}
                className="btn-secondary text-sm flex items-center gap-1.5">
                <Clock size={15} /> Schedule
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Public link */}
      {(status === 'published' || status === 'locked') && (
        <div className="card p-5">
          <h3 className="font-semibold text-slate-900 text-sm mb-2 flex items-center gap-2">
            <Globe size={15} className="text-brand-600" /> Public result page
          </h3>
          <p className="text-xs text-slate-500 mb-3">
            Parents check results with roll number + date of birth. {targets} parent(s) have a
            phone on file for notifications.
          </p>
          <div className="flex items-center gap-2 bg-slate-50 rounded-lg px-3 py-2">
            <code className="text-xs text-slate-600 flex-1 truncate">{publicUrl}</code>
            <button onClick={() => { navigator.clipboard.writeText(publicUrl); setNotice('Link copied') }}
              className="text-slate-400 hover:text-slate-600"><Copy size={14} /></button>
          </div>
        </div>
      )}
    </div>
  )
}
