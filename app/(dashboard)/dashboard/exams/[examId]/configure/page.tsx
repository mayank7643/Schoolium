'use client'

// FILE: app/(dashboard)/dashboard/exams/[examId]/configure/page.tsx
// Exam configuration: classes + papers (subjects, marks scheme, schedule).
// Draft: everything editable. Published: schedule fields only (the DB
// rejects anything else). Ongoing and later: read-only.

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { createClient } from '@/utils/supabase/client'
import { ArrowLeft, Plus, Trash2, Copy, X, ShieldCheck, AlertTriangle, Info, Wand2, CalendarDays } from 'lucide-react'
import type { Exam, ExamSubject, ExamRoom, Class, Subject, TimetableIssue, ExamSubjectRowInput, AutoGenerateTimetableResult } from '@/types'
import { ExamStatusBadge, classLabel, formatDate, formatTime } from '@/components/exams/examUi'

interface PaperRow {
  key: string               // stable local key
  id: string | null         // persisted exam_subjects.id
  class_id: string
  subject_id: string
  max_marks_theory: number
  max_marks_practical: number
  max_marks_internal: number
  pass_marks: number
  weightage_percent: number
  is_optional: boolean
  is_cancelled: boolean
  exam_date: string
  start_time: string
  reporting_time: string
  duration_minutes: string  // keep as string for the input; '' = null
  room_id: string
}

let keySeq = 0
const nextKey = () => `row-${++keySeq}`

function sortClasses(list: Class[]): Class[] {
  return [...list].sort((a, b) => {
    const an = parseInt(a.name); const bn = parseInt(b.name)
    if (!isNaN(an) && !isNaN(bn)) return an - bn || (a.section ?? '').localeCompare(b.section ?? '')
    if (!isNaN(an)) return -1
    if (!isNaN(bn)) return 1
    return a.name.localeCompare(b.name) || (a.section ?? '').localeCompare(b.section ?? '')
  })
}

export default function ConfigureExamPage() {
  const { examId } = useParams<{ examId: string }>()
  const router = useRouter()

  const [exam, setExam] = useState<Exam | null>(null)
  const [classes, setClasses] = useState<Class[]>([])
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [rooms, setRooms] = useState<ExamRoom[]>([])
  const [selectedClassIds, setSelectedClassIds] = useState<string[]>([])
  const [savedClassIds, setSavedClassIds] = useState<string[]>([])
  const [papers, setPapers] = useState<PaperRow[]>([])
  const [issues, setIssues] = useState<TimetableIssue[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const [showAutoGen, setShowAutoGen] = useState(false)
  const [autoGenForm, setAutoGenForm] = useState({
    start_date: '', end_date: '', gap_days: 0,
    default_start: '10:00', default_duration: 180,
    overwrite: false, skip_sundays: true,
  })

  const fetchAll = useCallback(async () => {
    const supabase = createClient()
    const [eRes, cRes, sRes, rRes, ecRes, esRes] = await Promise.all([
      supabase.from('exams').select('*, exam_types(name, code, category), academic_terms(name)').eq('id', examId).single(),
      supabase.from('classes').select('*'),
      supabase.from('subjects').select('*').eq('is_active', true).order('name'),
      supabase.from('exam_rooms').select('*').eq('is_active', true).order('name'),
      supabase.from('exam_classes').select('*').eq('exam_id', examId),
      supabase.from('exam_subjects').select('*').eq('exam_id', examId),
    ])
    if (eRes.error || !eRes.data) { router.push('/dashboard/exams'); return }
    setExam(eRes.data as Exam)
    setClasses(sortClasses((cRes.data ?? []) as Class[]))
    setSubjects((sRes.data ?? []) as Subject[])
    setRooms((rRes.data ?? []) as ExamRoom[])
    const classIds = ((ecRes.data ?? []) as Array<{ class_id: string }>).map(r => r.class_id)
    setSelectedClassIds(classIds)
    setSavedClassIds(classIds)
    setPapers(((esRes.data ?? []) as ExamSubject[]).map(es => ({
      key: nextKey(),
      id: es.id,
      class_id: es.class_id,
      subject_id: es.subject_id,
      max_marks_theory: Number(es.max_marks_theory),
      max_marks_practical: Number(es.max_marks_practical),
      max_marks_internal: Number(es.max_marks_internal),
      pass_marks: Number(es.pass_marks),
      weightage_percent: Number(es.weightage_percent),
      is_optional: es.is_optional,
      is_cancelled: es.is_cancelled,
      exam_date: es.exam_date ?? '',
      start_time: es.start_time?.slice(0, 5) ?? '',
      reporting_time: es.reporting_time?.slice(0, 5) ?? '',
      duration_minutes: es.duration_minutes?.toString() ?? '',
      room_id: es.room_id ?? '',
    })))
    setLoading(false)
  }, [examId, router])

  useEffect(() => { fetchAll() }, [fetchAll])

  const isDraft = exam?.status === 'draft'
  const isPublished = exam?.status === 'published'
  const editable = isDraft || isPublished

  // ── classes ─────────────────────────────────────────────────
  function toggleClass(id: string) {
    setSelectedClassIds(prev => prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id])
  }

  async function saveClasses() {
    const removed = savedClassIds.filter(id => !selectedClassIds.includes(id))
    if (removed.length > 0) {
      const labels = removed.map(id => classLabel(classes.find(c => c.id === id))).join(', ')
      if (!confirm(`Removing ${labels} deletes their configured papers for this exam. Continue?`)) return
    }
    setBusy(true); setError('')
    const supabase = createClient()
    const { error } = await supabase.rpc('set_exam_classes', {
      p_exam_id: examId, p_class_ids: selectedClassIds,
    })
    setBusy(false)
    if (error) { setError(error.message); return }
    setNotice('Classes saved')
    await fetchAll()
  }

  // ── papers ──────────────────────────────────────────────────
  const papersFor = (classId: string) => papers.filter(p => p.class_id === classId)

  function addPaper(classId: string) {
    const used = new Set(papersFor(classId).map(p => p.subject_id))
    const firstFree = subjects.find(s => !used.has(s.id))
    setPapers(prev => [...prev, {
      key: nextKey(), id: null, class_id: classId,
      subject_id: firstFree?.id ?? '',
      max_marks_theory: 100, max_marks_practical: 0, max_marks_internal: 0,
      pass_marks: 33, weightage_percent: 100, is_optional: false, is_cancelled: false,
      exam_date: '', start_time: '10:00', reporting_time: '09:30',
      duration_minutes: '180', room_id: '',
    }])
  }

  function updatePaper(key: string, patch: Partial<PaperRow>) {
    setPapers(prev => prev.map(p => p.key === key ? { ...p, ...patch } : p))
  }

  async function removePaper(row: PaperRow) {
    if (!row.id) { setPapers(prev => prev.filter(p => p.key !== row.key)); return }
    const sub = subjects.find(s => s.id === row.subject_id)?.name ?? 'paper'
    if (!confirm(`Remove ${sub} for ${classLabel(classes.find(c => c.id === row.class_id))}?`)) return
    setBusy(true); setError('')
    const supabase = createClient()
    const { error } = await supabase.rpc('delete_exam_subject', { p_exam_subject_id: row.id })
    setBusy(false)
    if (error) { setError(error.message); return }
    setPapers(prev => prev.filter(p => p.key !== row.key))
  }

  function copyToAllClasses(fromClassId: string) {
    const src = papersFor(fromClassId)
    if (src.length === 0) return
    if (!confirm(`Copy ${src.length} paper(s) of ${classLabel(classes.find(c => c.id === fromClassId))} to all other selected classes? Existing papers with the same subject are overwritten locally — press Save to apply.`)) return
    setPapers(prev => {
      const next = [...prev]
      for (const target of selectedClassIds.filter(id => id !== fromClassId)) {
        for (const s of src) {
          const existing = next.find(p => p.class_id === target && p.subject_id === s.subject_id)
          const copy = { ...s, class_id: target }
          if (existing) {
            Object.assign(existing, { ...copy, key: existing.key, id: existing.id })
          } else {
            next.push({ ...copy, key: nextKey(), id: null })
          }
        }
      }
      return next
    })
    setNotice('Copied — review and press Save papers')
  }

  async function savePapers() {
    const rows: ExamSubjectRowInput[] = []
    for (const p of papers) {
      if (!selectedClassIds.includes(p.class_id)) continue
      if (!p.subject_id) { setError('Every paper needs a subject selected'); return }
      if (isDraft) {
        rows.push({
          class_id: p.class_id, subject_id: p.subject_id,
          max_marks_theory: p.max_marks_theory,
          max_marks_practical: p.max_marks_practical,
          max_marks_internal: p.max_marks_internal,
          pass_marks: p.pass_marks,
          weightage_percent: p.weightage_percent,
          is_optional: p.is_optional,
          exam_date: p.exam_date || null,
          start_time: p.start_time || null,
          reporting_time: p.reporting_time || null,
          duration_minutes: p.duration_minutes ? Number(p.duration_minutes) : null,
          room_id: p.room_id || null,
        })
      } else {
        // published: schedule fields only — the RPC rejects scheme changes
        rows.push({
          class_id: p.class_id, subject_id: p.subject_id,
          exam_date: p.exam_date || null,
          start_time: p.start_time || null,
          reporting_time: p.reporting_time || null,
          duration_minutes: p.duration_minutes ? Number(p.duration_minutes) : null,
          room_id: p.room_id || null,
        })
      }
    }
    if (rows.length === 0) { setError('Nothing to save — add papers first'); return }
    setBusy(true); setError(''); setNotice('')
    const supabase = createClient()
    const { error } = await supabase.rpc('upsert_exam_subjects', { p_exam_id: examId, p_rows: rows })
    setBusy(false)
    if (error) { setError(error.message); return }
    setNotice(`Saved ${rows.length} paper(s)`)
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

  function openAutoGen() {
    const today = new Date()
    const start = new Date(today); start.setDate(start.getDate() + 7)
    const end = new Date(today); end.setDate(end.getDate() + 28)
    const iso = (d: Date) => d.toISOString().slice(0, 10)
    setAutoGenForm(f => ({ ...f, start_date: iso(start), end_date: iso(end) }))
    setShowAutoGen(true)
  }

  async function runAutoGen(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError(''); setNotice('')
    const supabase = createClient()
    const { data, error } = await supabase.rpc('auto_generate_timetable', {
      p_exam_id: examId,
      p_start_date: autoGenForm.start_date,
      p_end_date: autoGenForm.end_date,
      p_gap_days: autoGenForm.gap_days,
      p_default_start: autoGenForm.default_start,
      p_default_duration: autoGenForm.default_duration,
      p_overwrite: autoGenForm.overwrite,
      p_skip_sundays: autoGenForm.skip_sundays,
    })
    setBusy(false)
    if (error) { setError(error.message); return }
    const r = data as AutoGenerateTimetableResult
    setShowAutoGen(false)
    setNotice(`Timetable generated — ${r.scheduled} paper(s) scheduled${r.unscheduled > 0 ? `, ${r.unscheduled} did not fit the window` : ''}. Review below, adjust manually if needed, then validate.`)
    await fetchAll()
    await runValidation()
  }

  if (loading || !exam) {
    return <div className="max-w-5xl mx-auto"><div className="card h-96 animate-pulse bg-slate-50" /></div>
  }

  const activeClasses = classes.filter(c => selectedClassIds.includes(c.id))

  return (
    <div className="max-w-5xl mx-auto">
      <Link href={`/dashboard/exams/${examId}`} className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600 mb-1">
        <ArrowLeft size={12} /> {exam.name}
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-slate-900">Configure exam</h1>
            <ExamStatusBadge status={exam.status} />
          </div>
          <p className="text-slate-500 text-sm mt-1">
            {isDraft
              ? 'Classes, subjects, marks scheme and timetable'
              : isPublished
                ? 'Published — only the schedule (date, time, room) can change'
                : 'Read-only — the exam is past its editable stages'}
          </p>
        </div>
        {editable && (
          <div className="flex items-center gap-2">
            <button onClick={openAutoGen} disabled={busy} className="btn-secondary text-sm flex items-center gap-1.5">
              <Wand2 size={15} /> Auto-generate
            </button>
            <button onClick={runValidation} disabled={busy} className="btn-secondary text-sm flex items-center gap-1.5">
              <ShieldCheck size={15} /> Validate timetable
            </button>
          </div>
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

      {/* Validation issues */}
      {issues !== null && (
        <div className="card p-4 mb-4">
          <h3 className="font-semibold text-slate-900 text-sm mb-2 flex items-center gap-2">
            <ShieldCheck size={15} className="text-brand-600" /> Timetable check
            {issues.length === 0 && <span className="badge-green">All clear</span>}
          </h3>
          {issues.length > 0 && (
            <ul className="flex flex-col gap-1.5">
              {issues.map((i, idx) => (
                <li key={idx} className={`text-xs flex items-start gap-2 px-3 py-2 rounded-lg ${
                  i.severity === 'error' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-700'
                }`}>
                  {i.severity === 'error' ? <AlertTriangle size={13} className="mt-0.5 shrink-0" /> : <Info size={13} className="mt-0.5 shrink-0" />}
                  <span><span className="font-medium">{i.code}</span> — {i.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Schedule by day */}
      {papers.some(p => p.exam_date) && (
        <div className="card p-5 mb-4">
          <h3 className="font-semibold text-slate-900 text-sm mb-3 flex items-center gap-2">
            <CalendarDays size={15} className="text-brand-600" /> Exam calendar
          </h3>
          <div className="flex flex-col gap-2">
            {Object.entries(
              papers.filter(p => p.exam_date && !p.is_cancelled).reduce<Record<string, PaperRow[]>>((acc, p) => {
                (acc[p.exam_date] = acc[p.exam_date] ?? []).push(p)
                return acc
              }, {})
            ).sort(([a], [b]) => a.localeCompare(b)).map(([date, rows]) => (
              <div key={date} className="flex items-start gap-3">
                <span className="text-xs font-semibold text-slate-600 w-24 shrink-0 pt-1">{formatDate(date)}</span>
                <div className="flex flex-wrap gap-1.5">
                  {rows
                    .sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''))
                    .map(p => (
                      <span key={p.key} className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-slate-50 border border-slate-100 text-xs text-slate-600">
                        <span className="font-medium text-slate-800">
                          {classLabel(classes.find(c => c.id === p.class_id))}
                        </span>
                        {subjects.find(s => s.id === p.subject_id)?.name ?? '—'}
                        {p.start_time && <span className="text-slate-400">· {formatTime(p.start_time)}</span>}
                        {p.room_id && <span className="text-slate-400">· {rooms.find(r => r.id === p.room_id)?.name}</span>}
                      </span>
                    ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Classes */}
      <div className="card p-5 mb-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-slate-900 text-sm">Classes sitting this exam</h3>
          {isDraft && (
            <button onClick={saveClasses} disabled={busy} className="btn-primary text-xs">
              Save classes
            </button>
          )}
        </div>
        {classes.length === 0 ? (
          <p className="text-sm text-slate-400">No classes exist yet — add them under Classes.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {classes.map(c => {
              const on = selectedClassIds.includes(c.id)
              return (
                <button
                  key={c.id}
                  disabled={!isDraft}
                  onClick={() => toggleClass(c.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                    on ? 'bg-brand-600 border-brand-600 text-white' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                  } ${!isDraft ? 'opacity-60 cursor-not-allowed' : ''}`}
                >
                  {classLabel(c)}
                </button>
              )
            })}
          </div>
        )}
        {isDraft && selectedClassIds.length !== savedClassIds.length && (
          <p className="text-xs text-amber-600 mt-2">Unsaved class changes — press “Save classes”.</p>
        )}
      </div>

      {/* Papers per class */}
      {savedClassIds.length === 0 ? (
        <div className="card p-6 text-center text-sm text-slate-500">
          Select classes above and save — then configure each class&apos;s papers here.
        </div>
      ) : (
        <>
          {activeClasses.filter(c => savedClassIds.includes(c.id)).map(cls => (
            <div key={cls.id} className="card p-5 mb-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold text-slate-900 text-sm">Class {classLabel(cls)}</h3>
                {editable && (
                  <div className="flex items-center gap-2">
                    {isDraft && savedClassIds.length > 1 && papersFor(cls.id).length > 0 && (
                      <button onClick={() => copyToAllClasses(cls.id)}
                        className="text-xs text-slate-500 hover:text-slate-700 flex items-center gap-1">
                        <Copy size={12} /> Copy to all classes
                      </button>
                    )}
                    {isDraft && (
                      <button onClick={() => addPaper(cls.id)}
                        className="text-xs text-brand-600 font-medium hover:text-brand-700 flex items-center gap-1">
                        <Plus size={13} /> Add paper
                      </button>
                    )}
                  </div>
                )}
              </div>

              {papersFor(cls.id).length === 0 ? (
                <p className="text-sm text-slate-400 py-3 text-center">No papers yet for this class.</p>
              ) : (
                <div className="overflow-x-auto -mx-5 px-5">
                  <table className="w-full text-xs min-w-[900px]">
                    <thead>
                      <tr className="text-slate-400 text-left">
                        <th className="pb-2 pr-2 font-medium w-40">Subject</th>
                        <th className="pb-2 pr-2 font-medium">Theory</th>
                        <th className="pb-2 pr-2 font-medium">Practical</th>
                        <th className="pb-2 pr-2 font-medium">Internal</th>
                        <th className="pb-2 pr-2 font-medium">Pass</th>
                        <th className="pb-2 pr-2 font-medium">Date</th>
                        <th className="pb-2 pr-2 font-medium">Start</th>
                        <th className="pb-2 pr-2 font-medium">Report</th>
                        <th className="pb-2 pr-2 font-medium">Mins</th>
                        <th className="pb-2 pr-2 font-medium w-32">Room</th>
                        <th className="pb-2 font-medium" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {papersFor(cls.id).map(row => {
                        const schemeLocked = !isDraft
                        return (
                          <tr key={row.key} className={row.is_cancelled ? 'opacity-40 line-through' : ''}>
                            <td className="py-1.5 pr-2">
                              <select className="input !py-1 !text-xs" value={row.subject_id} disabled={schemeLocked || row.id !== null}
                                onChange={e => updatePaper(row.key, { subject_id: e.target.value })}>
                                <option value="">Subject…</option>
                                {subjects.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                              </select>
                            </td>
                            <td className="py-1.5 pr-2">
                              <input type="number" min={0} className="input !py-1 !text-xs !w-16" disabled={schemeLocked}
                                value={row.max_marks_theory} onChange={e => updatePaper(row.key, { max_marks_theory: Number(e.target.value) })} />
                            </td>
                            <td className="py-1.5 pr-2">
                              <input type="number" min={0} className="input !py-1 !text-xs !w-16" disabled={schemeLocked}
                                value={row.max_marks_practical} onChange={e => updatePaper(row.key, { max_marks_practical: Number(e.target.value) })} />
                            </td>
                            <td className="py-1.5 pr-2">
                              <input type="number" min={0} className="input !py-1 !text-xs !w-16" disabled={schemeLocked}
                                value={row.max_marks_internal} onChange={e => updatePaper(row.key, { max_marks_internal: Number(e.target.value) })} />
                            </td>
                            <td className="py-1.5 pr-2">
                              <input type="number" min={0} className="input !py-1 !text-xs !w-16" disabled={schemeLocked}
                                value={row.pass_marks} onChange={e => updatePaper(row.key, { pass_marks: Number(e.target.value) })} />
                            </td>
                            <td className="py-1.5 pr-2">
                              <input type="date" className="input !py-1 !text-xs" disabled={!editable || row.is_cancelled}
                                value={row.exam_date} onChange={e => updatePaper(row.key, { exam_date: e.target.value })} />
                            </td>
                            <td className="py-1.5 pr-2">
                              <input type="time" className="input !py-1 !text-xs" disabled={!editable || row.is_cancelled}
                                value={row.start_time} onChange={e => updatePaper(row.key, { start_time: e.target.value })} />
                            </td>
                            <td className="py-1.5 pr-2">
                              <input type="time" className="input !py-1 !text-xs" disabled={!editable || row.is_cancelled}
                                value={row.reporting_time} onChange={e => updatePaper(row.key, { reporting_time: e.target.value })} />
                            </td>
                            <td className="py-1.5 pr-2">
                              <input type="number" min={1} className="input !py-1 !text-xs !w-16" disabled={!editable || row.is_cancelled}
                                value={row.duration_minutes} onChange={e => updatePaper(row.key, { duration_minutes: e.target.value })} />
                            </td>
                            <td className="py-1.5 pr-2">
                              <select className="input !py-1 !text-xs" disabled={!editable || row.is_cancelled}
                                value={row.room_id} onChange={e => updatePaper(row.key, { room_id: e.target.value })}>
                                <option value="">No room</option>
                                {rooms.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                              </select>
                            </td>
                            <td className="py-1.5 text-right">
                              {isDraft && (
                                <button onClick={() => removePaper(row)} disabled={busy}
                                  className="w-6 h-6 inline-flex items-center justify-center rounded text-slate-300 hover:text-red-600 hover:bg-red-50">
                                  <Trash2 size={12} />
                                </button>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}

          {editable && (
            <div className="sticky bottom-4 flex justify-end">
              <button onClick={savePapers} disabled={busy} className="btn-primary text-sm shadow-lg">
                {busy ? 'Saving…' : isDraft ? 'Save papers' : 'Save schedule changes'}
              </button>
            </div>
          )}
        </>
      )}

      {/* Auto-generate modal */}
      {showAutoGen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm">
            <div className="flex items-center justify-between p-5 border-b border-slate-100">
              <h2 className="font-semibold text-slate-900 flex items-center gap-2">
                <Wand2 size={16} className="text-brand-600" /> Auto-generate timetable
              </h2>
              <button onClick={() => setShowAutoGen(false)} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100">
                <X size={18} className="text-slate-500" />
              </button>
            </div>
            <form onSubmit={runAutoGen} className="p-5 flex flex-col gap-4">
              <p className="text-xs text-slate-500 -mb-1">
                Fills dates for unscheduled papers: one paper per class per day, skipping
                holidays{autoGenForm.skip_sundays ? ' and Sundays' : ''}. Manual edits stay
                unless you overwrite.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">From *</label>
                  <input type="date" className="input" required value={autoGenForm.start_date}
                    onChange={e => setAutoGenForm({ ...autoGenForm, start_date: e.target.value })} />
                </div>
                <div>
                  <label className="label">To *</label>
                  <input type="date" className="input" required value={autoGenForm.end_date}
                    onChange={e => setAutoGenForm({ ...autoGenForm, end_date: e.target.value })} />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="label">Gap days</label>
                  <input type="number" min={0} max={30} className="input" value={autoGenForm.gap_days}
                    onChange={e => setAutoGenForm({ ...autoGenForm, gap_days: Number(e.target.value) })} />
                </div>
                <div>
                  <label className="label">Start time</label>
                  <input type="time" className="input" value={autoGenForm.default_start}
                    onChange={e => setAutoGenForm({ ...autoGenForm, default_start: e.target.value })} />
                </div>
                <div>
                  <label className="label">Minutes</label>
                  <input type="number" min={1} className="input" value={autoGenForm.default_duration}
                    onChange={e => setAutoGenForm({ ...autoGenForm, default_duration: Number(e.target.value) })} />
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm text-slate-600">
                <input type="checkbox" checked={autoGenForm.skip_sundays}
                  onChange={e => setAutoGenForm({ ...autoGenForm, skip_sundays: e.target.checked })} />
                Skip Sundays
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-600">
                <input type="checkbox" checked={autoGenForm.overwrite}
                  onChange={e => setAutoGenForm({ ...autoGenForm, overwrite: e.target.checked })} />
                Overwrite existing dates and times
              </label>
              {error && <div className="bg-red-50 text-red-600 text-sm px-3 py-2 rounded-lg">{error}</div>}
              <button type="submit" className="btn-primary w-full py-2.5" disabled={busy}>
                {busy ? 'Generating…' : 'Generate timetable'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
