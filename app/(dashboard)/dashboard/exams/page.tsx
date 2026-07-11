'use client'

// FILE: app/(dashboard)/dashboard/exams/page.tsx
// Exam module landing: exam list for a session + status KPIs.

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { createClient } from '@/utils/supabase/client'
import { GraduationCap, Plus, CalendarRange, ChevronRight, Settings2 } from 'lucide-react'
import type { AcademicSession, Exam, ExamStatus } from '@/types'
import { ExamStatusBadge, formatDate } from '@/components/exams/examUi'

const STATUS_TABS: Array<{ key: ExamStatus | 'all'; label: string }> = [
  { key: 'all',       label: 'All' },
  { key: 'draft',     label: 'Draft' },
  { key: 'published', label: 'Published' },
  { key: 'ongoing',   label: 'Ongoing' },
  { key: 'completed', label: 'Completed' },
  { key: 'locked',    label: 'Locked' },
  { key: 'cancelled', label: 'Cancelled' },
]

export default function ExamsPage() {
  const [sessions, setSessions] = useState<AcademicSession[]>([])
  const [sessionId, setSessionId] = useState<string>('')
  const [exams, setExams] = useState<Exam[]>([])
  const [tab, setTab] = useState<ExamStatus | 'all'>('all')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    (async () => {
      const supabase = createClient()
      const { data } = await supabase
        .from('academic_sessions')
        .select('*')
        .neq('status', 'archived')
        .order('start_date', { ascending: false })
      const list = (data ?? []) as AcademicSession[]
      setSessions(list)
      const current = list.find(s => s.is_current) ?? list[0]
      if (current) setSessionId(current.id)
      else setLoading(false)
    })()
  }, [])

  const fetchExams = useCallback(async () => {
    if (!sessionId) return
    setLoading(true)
    const supabase = createClient()
    const { data } = await supabase
      .from('exams')
      .select('*, exam_types(name, code, category), academic_terms(name)')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false })
    setExams((data ?? []) as Exam[])
    setLoading(false)
  }, [sessionId])

  useEffect(() => { fetchExams() }, [fetchExams])

  const counts = exams.reduce<Record<string, number>>((acc, e) => {
    acc[e.status] = (acc[e.status] ?? 0) + 1
    return acc
  }, {})
  const visible = tab === 'all' ? exams : exams.filter(e => e.status === tab)

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Exams</h1>
          <p className="text-slate-500 text-sm mt-1">
            Examination lifecycle — create, schedule, publish, results
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/dashboard/exams/sessions" className="btn-secondary text-sm flex items-center gap-1.5">
            <CalendarRange size={15} /> Sessions
          </Link>
          <Link href="/dashboard/exams/settings" className="btn-secondary text-sm flex items-center gap-1.5">
            <Settings2 size={15} /> Settings
          </Link>
          <Link href="/dashboard/exams/new" className="btn-primary text-sm flex items-center gap-2">
            <Plus size={16} /> New exam
          </Link>
        </div>
      </div>

      {sessions.length === 0 && !loading ? (
        <div className="card flex flex-col items-center justify-center py-16 text-center">
          <div className="w-14 h-14 bg-slate-100 rounded-full flex items-center justify-center mb-4">
            <CalendarRange size={24} className="text-slate-400" />
          </div>
          <h3 className="font-semibold text-slate-900 mb-1">Set up your academic session first</h3>
          <p className="text-sm text-slate-500 mb-4 max-w-sm">
            Exams live inside an academic session (e.g. 2026-27). Create one, then come back here.
          </p>
          <Link href="/dashboard/exams/sessions" className="btn-primary text-sm">Create session</Link>
        </div>
      ) : (
        <>
          {/* Session picker + KPIs */}
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <select
              className="input !w-auto text-sm"
              value={sessionId}
              onChange={e => setSessionId(e.target.value)}
            >
              {sessions.map(s => (
                <option key={s.id} value={s.id}>
                  {s.name}{s.is_current ? ' (current)' : ''}{s.status === 'locked' ? ' — locked' : ''}
                </option>
              ))}
            </select>
            <div className="flex gap-2 text-xs text-slate-500">
              <span className="card-sm px-3 py-1.5">{exams.length} total</span>
              {(counts['ongoing'] ?? 0) > 0 && (
                <span className="card-sm px-3 py-1.5 text-amber-600 font-medium">{counts['ongoing']} ongoing</span>
              )}
              {(counts['draft'] ?? 0) > 0 && (
                <span className="card-sm px-3 py-1.5">{counts['draft']} draft</span>
              )}
            </div>
          </div>

          {/* Status tabs */}
          <div className="flex gap-1.5 overflow-x-auto pb-1 mb-4">
            {STATUS_TABS.map(t => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                  tab === t.key ? 'bg-brand-600 text-white' : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
              >
                {t.label}{t.key !== 'all' && counts[t.key] ? ` (${counts[t.key]})` : ''}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="flex flex-col gap-3">
              {[...Array(3)].map((_, i) => <div key={i} className="card h-20 animate-pulse bg-slate-50" />)}
            </div>
          ) : visible.length === 0 ? (
            <div className="card flex flex-col items-center justify-center py-14 text-center">
              <div className="w-14 h-14 bg-slate-100 rounded-full flex items-center justify-center mb-4">
                <GraduationCap size={24} className="text-slate-400" />
              </div>
              <h3 className="font-semibold text-slate-900 mb-1">
                {tab === 'all' ? 'No exams in this session yet' : `No ${tab} exams`}
              </h3>
              {tab === 'all' && (
                <>
                  <p className="text-sm text-slate-500 mb-4">Create the first exam — unit test, term exam or annual.</p>
                  <Link href="/dashboard/exams/new" className="btn-primary text-sm">+ New exam</Link>
                </>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {visible.map(exam => (
                <Link key={exam.id} href={`/dashboard/exams/${exam.id}`}
                  className="card p-4 flex items-center justify-between gap-3 hover:shadow transition-shadow group">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-9 h-9 bg-brand-50 rounded-lg flex items-center justify-center shrink-0">
                      <GraduationCap size={17} className="text-brand-600" />
                    </div>
                    <div className="min-w-0">
                      <p className="font-semibold text-slate-900 truncate">{exam.name}</p>
                      <p className="text-xs text-slate-500 truncate">
                        {exam.exam_types?.name ?? '—'}
                        {exam.academic_terms?.name ? ` · ${exam.academic_terms.name}` : ''}
                        {exam.start_date ? ` · ${formatDate(exam.start_date)} – ${formatDate(exam.end_date)}` : ' · not scheduled yet'}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <ExamStatusBadge status={exam.status} />
                    <ChevronRight size={16} className="text-slate-300 group-hover:text-slate-500 transition-colors" />
                  </div>
                </Link>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
