'use client'

// FILE: app/(dashboard)/dashboard/exams/sessions/page.tsx
// Academic sessions + terms management (exam module Phase 1).
// All writes go through chat21 RPCs; this page never writes tables directly.

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { createClient } from '@/utils/supabase/client'
import { CalendarRange, Plus, X, Star, Lock, LockOpen, Archive, Pencil, Trash2, ArrowLeft } from 'lucide-react'
import type { AcademicSession, AcademicTerm } from '@/types'
import { SessionStatusBadge, formatDate } from '@/components/exams/examUi'

interface SessionForm { name: string; start_date: string; end_date: string }
interface TermForm {
  id: string | null
  name: string
  term_type: 'term' | 'semester'
  sort_order: number
  start_date: string
  end_date: string
  weightage_percent: number
}

const EMPTY_TERM: TermForm = {
  id: null, name: '', term_type: 'term', sort_order: 1,
  start_date: '', end_date: '', weightage_percent: 100,
}

export default function SessionsPage() {
  const [sessions, setSessions] = useState<AcademicSession[]>([])
  const [terms, setTerms] = useState<AcademicTerm[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const [showSessionModal, setShowSessionModal] = useState(false)
  const [editingSession, setEditingSession] = useState<AcademicSession | null>(null)
  const [sessionForm, setSessionForm] = useState<SessionForm>({ name: '', start_date: '', end_date: '' })

  const [showTermModal, setShowTermModal] = useState(false)
  const [termForm, setTermForm] = useState<TermForm>(EMPTY_TERM)

  const fetchAll = useCallback(async () => {
    const supabase = createClient()
    const [sRes, tRes] = await Promise.all([
      supabase.from('academic_sessions').select('*').order('start_date', { ascending: false }),
      supabase.from('academic_terms').select('*').order('sort_order'),
    ])
    const list = (sRes.data ?? []) as AcademicSession[]
    setSessions(list)
    setTerms((tRes.data ?? []) as AcademicTerm[])
    setSelectedId(prev => prev && list.some(s => s.id === prev)
      ? prev
      : (list.find(s => s.is_current)?.id ?? list[0]?.id ?? null))
    setLoading(false)
  }, [])

  useEffect(() => { fetchAll() }, [fetchAll])

  const selected = sessions.find(s => s.id === selectedId) ?? null
  const selectedTerms = terms.filter(t => t.session_id === selectedId)
  const selectedMutable = selected != null && selected.status !== 'locked' && selected.status !== 'archived'

  async function rpc(fn: string, args: Record<string, unknown>, confirmMsg?: string) {
    if (confirmMsg && !confirm(confirmMsg)) return false
    setBusy(true); setError('')
    const supabase = createClient()
    const { error } = await supabase.rpc(fn, args)
    setBusy(false)
    if (error) { setError(error.message); return false }
    await fetchAll()
    return true
  }

  // ── session actions ─────────────────────────────────────────
  function openAddSession() {
    setEditingSession(null)
    const y = new Date().getFullYear()
    setSessionForm({ name: `${y}-${String(y + 1).slice(2)}`, start_date: `${y}-04-01`, end_date: `${y + 1}-03-31` })
    setError(''); setShowSessionModal(true)
  }

  function openEditSession(s: AcademicSession) {
    setEditingSession(s)
    setSessionForm({ name: s.name, start_date: s.start_date, end_date: s.end_date })
    setError(''); setShowSessionModal(true)
  }

  async function submitSession(e: React.FormEvent) {
    e.preventDefault()
    const ok = editingSession
      ? await rpc('update_academic_session', {
          p_session_id: editingSession.id,
          p_name: sessionForm.name,
          p_start_date: sessionForm.start_date,
          p_end_date: sessionForm.end_date,
        })
      : await rpc('create_academic_session', {
          p_name: sessionForm.name,
          p_start_date: sessionForm.start_date,
          p_end_date: sessionForm.end_date,
        })
    if (ok) setShowSessionModal(false)
  }

  async function lockSession(s: AcademicSession) {
    await rpc('lock_academic_session', { p_session_id: s.id },
      `Lock session "${s.name}"?\n\nAll exams, marks and enrollments in it become read-only. ` +
      'Every exam in the session must already be locked or cancelled.')
  }

  async function unlockSession(s: AcademicSession) {
    const reason = prompt(`Unlock session "${s.name}" — reason (required, min 10 characters):`)
    if (reason === null) return
    await rpc('unlock_academic_session', { p_session_id: s.id, p_reason: reason })
  }

  async function archiveSession(s: AcademicSession) {
    await rpc('archive_academic_session', { p_session_id: s.id },
      `Archive session "${s.name}"?\n\nIt disappears from pickers permanently (history stays in reports).`)
  }

  // ── term actions ────────────────────────────────────────────
  function openAddTerm() {
    if (!selected) return
    setTermForm({
      ...EMPTY_TERM,
      sort_order: selectedTerms.length + 1,
      start_date: selected.start_date,
      end_date: selected.end_date,
    })
    setError(''); setShowTermModal(true)
  }

  function openEditTerm(t: AcademicTerm) {
    setTermForm({
      id: t.id, name: t.name, term_type: t.term_type, sort_order: t.sort_order,
      start_date: t.start_date, end_date: t.end_date, weightage_percent: t.weightage_percent,
    })
    setError(''); setShowTermModal(true)
  }

  async function submitTerm(e: React.FormEvent) {
    e.preventDefault()
    if (!selectedId) return
    const ok = await rpc('upsert_academic_term', {
      p_session_id: selectedId,
      p_term_id: termForm.id,
      p_name: termForm.name,
      p_term_type: termForm.term_type,
      p_sort_order: termForm.sort_order,
      p_start_date: termForm.start_date,
      p_end_date: termForm.end_date,
      p_weightage_percent: termForm.weightage_percent,
    })
    if (ok) setShowTermModal(false)
  }

  async function deleteTerm(t: AcademicTerm) {
    await rpc('delete_academic_term', { p_term_id: t.id }, `Delete term "${t.name}"?`)
  }

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <Link href="/dashboard/exams" className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600 mb-1">
            <ArrowLeft size={12} /> Exams
          </Link>
          <h1 className="text-2xl font-bold text-slate-900">Academic Sessions</h1>
          <p className="text-slate-500 text-sm mt-1">Academic years, terms and semesters</p>
        </div>
        <button onClick={openAddSession} className="btn-primary flex items-center gap-2 text-sm">
          <Plus size={16} /> New session
        </button>
      </div>

      {error && (
        <div className="bg-red-50 text-red-600 text-sm px-4 py-3 rounded-lg mb-4 flex items-start justify-between gap-3">
          <span>{error}</span>
          <button onClick={() => setError('')}><X size={14} /></button>
        </div>
      )}

      {loading ? (
        <div className="grid lg:grid-cols-2 gap-4">
          {[...Array(2)].map((_, i) => <div key={i} className="card h-48 animate-pulse bg-slate-50" />)}
        </div>
      ) : sessions.length === 0 ? (
        <div className="card flex flex-col items-center justify-center py-16 text-center">
          <div className="w-14 h-14 bg-slate-100 rounded-full flex items-center justify-center mb-4">
            <CalendarRange size={24} className="text-slate-400" />
          </div>
          <h3 className="font-semibold text-slate-900 mb-1">No academic session yet</h3>
          <p className="text-sm text-slate-500 mb-4 max-w-sm">
            Create your first academic session (e.g. 2026-27). It becomes the current session
            automatically and the standard exam types are set up for your school.
          </p>
          <button onClick={openAddSession} className="btn-primary text-sm">+ Create session</button>
        </div>
      ) : (
        <div className="grid lg:grid-cols-5 gap-4 items-start">
          {/* Sessions list */}
          <div className="lg:col-span-2 flex flex-col gap-3">
            {sessions.map(s => (
              <button
                key={s.id}
                onClick={() => setSelectedId(s.id)}
                className={`card p-4 text-left transition-shadow ${selectedId === s.id ? 'ring-2 ring-brand-500' : 'hover:shadow'}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-semibold text-slate-900 truncate">{s.name}</span>
                    {s.is_current && <Star size={14} className="text-amber-400 fill-amber-400 shrink-0" />}
                  </div>
                  <SessionStatusBadge status={s.status} />
                </div>
                <p className="text-xs text-slate-500 mt-1">
                  {formatDate(s.start_date)} – {formatDate(s.end_date)}
                </p>
              </button>
            ))}
          </div>

          {/* Selected session detail */}
          {selected && (
            <div className="lg:col-span-3 flex flex-col gap-4">
              <div className="card p-5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="font-semibold text-slate-900 text-lg">{selected.name}</h2>
                      <SessionStatusBadge status={selected.status} />
                    </div>
                    <p className="text-sm text-slate-500 mt-0.5">
                      {formatDate(selected.start_date)} – {formatDate(selected.end_date)}
                      {selected.is_current && <span className="text-amber-500 font-medium"> · Current session</span>}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 mt-4">
                  {!selected.is_current && selectedMutable && (
                    <button disabled={busy} onClick={() => rpc('set_current_session', { p_session_id: selected.id })}
                      className="btn-secondary text-xs flex items-center gap-1.5">
                      <Star size={13} /> Make current
                    </button>
                  )}
                  {selectedMutable && (
                    <>
                      <button disabled={busy} onClick={() => openEditSession(selected)}
                        className="btn-secondary text-xs flex items-center gap-1.5">
                        <Pencil size={13} /> Edit
                      </button>
                      <button disabled={busy} onClick={() => lockSession(selected)}
                        className="btn-secondary text-xs flex items-center gap-1.5">
                        <Lock size={13} /> Lock
                      </button>
                    </>
                  )}
                  {selected.status === 'locked' && (
                    <>
                      <button disabled={busy} onClick={() => unlockSession(selected)}
                        className="btn-secondary text-xs flex items-center gap-1.5">
                        <LockOpen size={13} /> Unlock
                      </button>
                      {!selected.is_current && (
                        <button disabled={busy} onClick={() => archiveSession(selected)}
                          className="btn-secondary text-xs flex items-center gap-1.5 text-slate-500">
                          <Archive size={13} /> Archive
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>

              {/* Terms */}
              <div className="card p-5">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-semibold text-slate-900 text-sm">Terms / Semesters</h3>
                  {selectedMutable && (
                    <button onClick={openAddTerm} className="text-xs text-brand-600 font-medium hover:text-brand-700 flex items-center gap-1">
                      <Plus size={13} /> Add term
                    </button>
                  )}
                </div>
                {selectedTerms.length === 0 ? (
                  <p className="text-sm text-slate-400 py-4 text-center">
                    No terms defined — exams can also be created without a term.
                  </p>
                ) : (
                  <div className="flex flex-col divide-y divide-slate-50">
                    {selectedTerms.map(t => (
                      <div key={t.id} className="flex items-center justify-between gap-3 py-2.5 group">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-slate-800">
                            {t.name}
                            <span className="text-xs text-slate-400 font-normal capitalize"> · {t.term_type} · {t.weightage_percent}% weight</span>
                          </p>
                          <p className="text-xs text-slate-500">{formatDate(t.start_date)} – {formatDate(t.end_date)}</p>
                        </div>
                        {selectedMutable && (
                          <div className="flex gap-1 opacity-100 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity shrink-0">
                            <button onClick={() => openEditTerm(t)}
                              className="w-6 h-6 flex items-center justify-center rounded text-slate-400 hover:text-slate-600 hover:bg-slate-100">
                              <Pencil size={12} />
                            </button>
                            <button onClick={() => deleteTerm(t)}
                              className="w-6 h-6 flex items-center justify-center rounded text-slate-400 hover:text-red-600 hover:bg-red-50">
                              <Trash2 size={12} />
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Session modal */}
      {showSessionModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm">
            <div className="flex items-center justify-between p-5 border-b border-slate-100">
              <h2 className="font-semibold text-slate-900">{editingSession ? 'Edit session' : 'New academic session'}</h2>
              <button onClick={() => setShowSessionModal(false)} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100">
                <X size={18} className="text-slate-500" />
              </button>
            </div>
            <form onSubmit={submitSession} className="p-5 flex flex-col gap-4">
              <div>
                <label className="label">Session name *</label>
                <input type="text" className="input" placeholder="e.g. 2026-27" required
                  value={sessionForm.name} onChange={e => setSessionForm({ ...sessionForm, name: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Starts *</label>
                  <input type="date" className="input" required
                    value={sessionForm.start_date} onChange={e => setSessionForm({ ...sessionForm, start_date: e.target.value })} />
                </div>
                <div>
                  <label className="label">Ends *</label>
                  <input type="date" className="input" required
                    value={sessionForm.end_date} onChange={e => setSessionForm({ ...sessionForm, end_date: e.target.value })} />
                </div>
              </div>
              {error && <div className="bg-red-50 text-red-600 text-sm px-3 py-2 rounded-lg">{error}</div>}
              <button type="submit" className="btn-primary w-full py-2.5" disabled={busy}>
                {busy ? 'Saving…' : editingSession ? 'Save changes' : 'Create session'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Term modal */}
      {showTermModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm">
            <div className="flex items-center justify-between p-5 border-b border-slate-100">
              <h2 className="font-semibold text-slate-900">{termForm.id ? 'Edit term' : 'Add term'}</h2>
              <button onClick={() => setShowTermModal(false)} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100">
                <X size={18} className="text-slate-500" />
              </button>
            </div>
            <form onSubmit={submitTerm} className="p-5 flex flex-col gap-4">
              <div>
                <label className="label">Name *</label>
                <input type="text" className="input" placeholder="e.g. Term 1" required
                  value={termForm.name} onChange={e => setTermForm({ ...termForm, name: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Type</label>
                  <select className="input" value={termForm.term_type}
                    onChange={e => setTermForm({ ...termForm, term_type: e.target.value as 'term' | 'semester' })}>
                    <option value="term">Term</option>
                    <option value="semester">Semester</option>
                  </select>
                </div>
                <div>
                  <label className="label">Weightage %</label>
                  <input type="number" className="input" min={0} max={100} step="0.01"
                    value={termForm.weightage_percent}
                    onChange={e => setTermForm({ ...termForm, weightage_percent: Number(e.target.value) })} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Starts *</label>
                  <input type="date" className="input" required
                    value={termForm.start_date} onChange={e => setTermForm({ ...termForm, start_date: e.target.value })} />
                </div>
                <div>
                  <label className="label">Ends *</label>
                  <input type="date" className="input" required
                    value={termForm.end_date} onChange={e => setTermForm({ ...termForm, end_date: e.target.value })} />
                </div>
              </div>
              {error && <div className="bg-red-50 text-red-600 text-sm px-3 py-2 rounded-lg">{error}</div>}
              <button type="submit" className="btn-primary w-full py-2.5" disabled={busy}>
                {busy ? 'Saving…' : termForm.id ? 'Save changes' : 'Add term'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
