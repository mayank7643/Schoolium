'use client'

// FILE: app/(dashboard)/dashboard/exams/settings/page.tsx
// Exam module settings: exam types, rooms, holidays.
// These are P1 config tables (school read, admin/principal direct
// write under RLS) - no RPCs needed.

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { createClient } from '@/utils/supabase/client'
import { ArrowLeft, Plus, X, Pencil, Trash2, DoorOpen, CalendarOff, Tags, GraduationCap } from 'lucide-react'
import type { AcademicSession, ExamType, ExamTypeCategory, ExamRoom, Holiday, GradeScale, GradeBand } from '@/types'
import { formatDate } from '@/components/exams/examUi'

type Tab = 'types' | 'rooms' | 'holidays' | 'grades'

const CATEGORIES: Array<{ value: ExamTypeCategory; label: string }> = [
  { value: 'unit_test',   label: 'Unit Test' },
  { value: 'monthly',     label: 'Monthly' },
  { value: 'quarterly',   label: 'Quarterly' },
  { value: 'half_yearly', label: 'Half Yearly' },
  { value: 'annual',      label: 'Annual' },
  { value: 'practical',   label: 'Practical' },
  { value: 'custom',      label: 'Custom' },
]

export default function ExamSettingsPage() {
  const [tab, setTab] = useState<Tab>('types')
  const [schoolId, setSchoolId] = useState('')
  const [types, setTypes] = useState<ExamType[]>([])
  const [rooms, setRooms] = useState<ExamRoom[]>([])
  const [holidays, setHolidays] = useState<Holiday[]>([])
  const [sessions, setSessions] = useState<AcademicSession[]>([])
  const [gradeScales, setGradeScales] = useState<GradeScale[]>([])
  const [gradeBands, setGradeBands] = useState<GradeBand[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const [modal, setModal] = useState<null | 'type' | 'room' | 'holiday'>(null)
  const [editId, setEditId] = useState<string | null>(null)
  const [typeForm, setTypeForm] = useState({ name: '', code: '', category: 'custom' as ExamTypeCategory })
  const [roomForm, setRoomForm] = useState({ name: '', capacity: '', location: '' })
  const [holidayForm, setHolidayForm] = useState({ session_id: '', holiday_date: '', name: '' })

  const fetchAll = useCallback(async () => {
    const supabase = createClient()
    const { data: profile } = await supabase.from('profiles').select('school_id').single()
    setSchoolId(profile?.school_id ?? '')
    const [tRes, rRes, hRes, sRes, gsRes, gbRes] = await Promise.all([
      supabase.from('exam_types').select('*').order('name'),
      supabase.from('exam_rooms').select('*').order('name'),
      supabase.from('holidays').select('*').order('holiday_date'),
      supabase.from('academic_sessions').select('*').neq('status', 'archived').order('start_date', { ascending: false }),
      supabase.from('grade_scales').select('*').order('is_default', { ascending: false }),
      supabase.from('grade_bands').select('*').order('min_percent', { ascending: false }),
    ])
    setTypes((tRes.data ?? []) as ExamType[])
    setRooms((rRes.data ?? []) as ExamRoom[])
    setHolidays((hRes.data ?? []) as Holiday[])
    setSessions((sRes.data ?? []) as AcademicSession[])
    setGradeScales((gsRes.data ?? []) as GradeScale[])
    setGradeBands((gbRes.data ?? []) as GradeBand[])
    setLoading(false)
  }, [])

  async function seedCbse() {
    setBusy(true); setError('')
    const supabase = createClient()
    const { error } = await supabase.rpc('seed_cbse_grade_scale', { p_school_id: schoolId })
    setBusy(false)
    if (error) { setError(error.message); return }
    await fetchAll()
  }

  useEffect(() => { fetchAll() }, [fetchAll])

  function openModal(kind: 'type' | 'room' | 'holiday', row?: ExamType | ExamRoom | Holiday) {
    setError('')
    setEditId(row?.id ?? null)
    if (kind === 'type') {
      const t = row as ExamType | undefined
      setTypeForm({ name: t?.name ?? '', code: t?.code ?? '', category: t?.category ?? 'custom' })
    } else if (kind === 'room') {
      const r = row as ExamRoom | undefined
      setRoomForm({ name: r?.name ?? '', capacity: r?.capacity?.toString() ?? '', location: r?.location ?? '' })
    } else {
      const h = row as Holiday | undefined
      const current = sessions.find(s => s.is_current) ?? sessions[0]
      setHolidayForm({
        session_id: h?.session_id ?? current?.id ?? '',
        holiday_date: h?.holiday_date ?? '',
        name: h?.name ?? '',
      })
    }
    setModal(kind)
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError('')
    const supabase = createClient()
    let err: { message: string } | null = null

    if (modal === 'type') {
      const row = { name: typeForm.name.trim(), code: typeForm.code.trim() || null, category: typeForm.category }
      err = editId
        ? (await supabase.from('exam_types').update(row).eq('id', editId)).error
        : (await supabase.from('exam_types').insert({ ...row, school_id: schoolId })).error
    } else if (modal === 'room') {
      const row = {
        name: roomForm.name.trim(),
        capacity: roomForm.capacity ? Number(roomForm.capacity) : null,
        location: roomForm.location.trim() || null,
      }
      err = editId
        ? (await supabase.from('exam_rooms').update(row).eq('id', editId)).error
        : (await supabase.from('exam_rooms').insert({ ...row, school_id: schoolId })).error
    } else if (modal === 'holiday') {
      const row = {
        session_id: holidayForm.session_id,
        holiday_date: holidayForm.holiday_date,
        name: holidayForm.name.trim(),
      }
      err = editId
        ? (await supabase.from('holidays').update(row).eq('id', editId)).error
        : (await supabase.from('holidays').insert({ ...row, school_id: schoolId })).error
    }

    setBusy(false)
    if (err) { setError(err.message); return }
    setModal(null)
    await fetchAll()
  }

  async function toggleActive(table: 'exam_types' | 'exam_rooms', row: ExamType | ExamRoom) {
    const supabase = createClient()
    const { error } = await supabase.from(table).update({ is_active: !row.is_active }).eq('id', row.id)
    if (error) { setError(error.message); return }
    await fetchAll()
  }

  async function deleteRow(table: 'exam_types' | 'exam_rooms' | 'holidays', id: string, label: string) {
    if (!confirm(`Delete ${label}?`)) return
    const supabase = createClient()
    const { error } = await supabase.from(table).delete().eq('id', id)
    if (error) {
      setError(error.message.includes('foreign key')
        ? `${label} is in use by an exam — deactivate it instead of deleting.`
        : error.message)
      return
    }
    await fetchAll()
  }

  const TABS: Array<{ key: Tab; label: string; icon: React.ElementType }> = [
    { key: 'types',    label: 'Exam types', icon: Tags },
    { key: 'rooms',    label: 'Rooms',      icon: DoorOpen },
    { key: 'holidays', label: 'Holidays',   icon: CalendarOff },
    { key: 'grades',   label: 'Grades',     icon: GraduationCap },
  ]

  return (
    <div className="max-w-3xl mx-auto">
      <Link href="/dashboard/exams" className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600 mb-1">
        <ArrowLeft size={12} /> Exams
      </Link>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Exam settings</h1>
          <p className="text-slate-500 text-sm mt-1">Types, rooms and the holiday calendar</p>
        </div>
        {tab !== 'grades' && (
          <button
            onClick={() => openModal(tab === 'types' ? 'type' : tab === 'rooms' ? 'room' : 'holiday')}
            className="btn-primary flex items-center gap-2 text-sm">
            <Plus size={16} /> Add
          </button>
        )}
      </div>

      <div className="flex gap-1.5 mb-4">
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors ${
              tab === t.key ? 'bg-brand-600 text-white' : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
            }`}>
            <t.icon size={13} /> {t.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="bg-red-50 text-red-600 text-sm px-4 py-3 rounded-lg mb-4 flex items-start justify-between gap-3">
          <span>{error}</span><button onClick={() => setError('')}><X size={14} /></button>
        </div>
      )}

      {loading ? (
        <div className="card h-64 animate-pulse bg-slate-50" />
      ) : (
        <div className="card overflow-hidden">
          {tab === 'types' && (
            types.length === 0 ? (
              <p className="text-sm text-slate-400 py-10 text-center">
                No exam types — they are seeded automatically with your first academic session.
              </p>
            ) : (
              <div className="divide-y divide-slate-50">
                {types.map(t => (
                  <div key={t.id} className="flex items-center justify-between gap-3 px-4 py-3 group">
                    <div className="min-w-0">
                      <p className={`text-sm font-medium ${t.is_active ? 'text-slate-800' : 'text-slate-400 line-through'}`}>
                        {t.name}{t.code ? ` (${t.code})` : ''}
                      </p>
                      <p className="text-xs text-slate-400 capitalize">{t.category.replace('_', ' ')}</p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button onClick={() => toggleActive('exam_types', t)}
                        className="text-xs px-2 py-1 rounded text-slate-500 hover:bg-slate-100">
                        {t.is_active ? 'Deactivate' : 'Activate'}
                      </button>
                      <button onClick={() => openModal('type', t)}
                        className="w-7 h-7 flex items-center justify-center rounded text-slate-400 hover:text-slate-600 hover:bg-slate-100">
                        <Pencil size={13} />
                      </button>
                      <button onClick={() => deleteRow('exam_types', t.id, t.name)}
                        className="w-7 h-7 flex items-center justify-center rounded text-slate-400 hover:text-red-600 hover:bg-red-50">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )
          )}

          {tab === 'rooms' && (
            rooms.length === 0 ? (
              <p className="text-sm text-slate-400 py-10 text-center">
                No rooms yet — rooms enable room allocation on the timetable and capacity warnings.
              </p>
            ) : (
              <div className="divide-y divide-slate-50">
                {rooms.map(r => (
                  <div key={r.id} className="flex items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <p className={`text-sm font-medium ${r.is_active ? 'text-slate-800' : 'text-slate-400 line-through'}`}>{r.name}</p>
                      <p className="text-xs text-slate-400">
                        {r.capacity ? `Capacity ${r.capacity}` : 'No capacity set'}{r.location ? ` · ${r.location}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button onClick={() => toggleActive('exam_rooms', r)}
                        className="text-xs px-2 py-1 rounded text-slate-500 hover:bg-slate-100">
                        {r.is_active ? 'Deactivate' : 'Activate'}
                      </button>
                      <button onClick={() => openModal('room', r)}
                        className="w-7 h-7 flex items-center justify-center rounded text-slate-400 hover:text-slate-600 hover:bg-slate-100">
                        <Pencil size={13} />
                      </button>
                      <button onClick={() => deleteRow('exam_rooms', r.id, r.name)}
                        className="w-7 h-7 flex items-center justify-center rounded text-slate-400 hover:text-red-600 hover:bg-red-50">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )
          )}

          {tab === 'grades' && (
            gradeScales.length === 0 ? (
              <div className="py-10 text-center">
                <p className="text-sm text-slate-400 mb-3">
                  No grade scale yet. Results use the school default; seed the CBSE 8-point
                  scale to get started (also seeded automatically on first result computation).
                </p>
                <button onClick={seedCbse} disabled={busy} className="btn-primary text-sm">Seed CBSE scale</button>
              </div>
            ) : (
              <div className="p-4 flex flex-col gap-4">
                {gradeScales.map(gs => (
                  <div key={gs.id}>
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-sm font-semibold text-slate-800">{gs.name}</span>
                      {gs.is_default && <span className="badge-green">default</span>}
                      {!gs.is_active && <span className="text-xs text-slate-400">inactive</span>}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {gradeBands.filter(b => b.grade_scale_id === gs.id).map(b => (
                        <span key={b.id} className={`text-xs px-2 py-1 rounded-lg border ${b.is_fail ? 'border-red-200 bg-red-50 text-red-600' : 'border-slate-200 bg-slate-50 text-slate-600'}`}>
                          <span className="font-semibold">{b.grade_label}</span> {b.min_percent}–{b.max_percent}%
                          {b.grade_point !== null ? ` · ${b.grade_point}` : ''}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
                <p className="text-xs text-slate-400">
                  Custom grade-scale editing arrives with analytics. The CBSE default covers
                  percentage, grade and CGPA out of the box.
                </p>
              </div>
            )
          )}

          {tab === 'holidays' && (
            holidays.length === 0 ? (
              <p className="text-sm text-slate-400 py-10 text-center">
                No holidays yet — timetable auto-generation skips holidays, and the
                validator flags papers landing on one.
              </p>
            ) : (
              <div className="divide-y divide-slate-50">
                {holidays.map(h => (
                  <div key={h.id} className="flex items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-800">{h.name}</p>
                      <p className="text-xs text-slate-400">
                        {formatDate(h.holiday_date)}
                        {' · '}{sessions.find(s => s.id === h.session_id)?.name ?? '—'}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button onClick={() => openModal('holiday', h)}
                        className="w-7 h-7 flex items-center justify-center rounded text-slate-400 hover:text-slate-600 hover:bg-slate-100">
                        <Pencil size={13} />
                      </button>
                      <button onClick={() => deleteRow('holidays', h.id, h.name)}
                        className="w-7 h-7 flex items-center justify-center rounded text-slate-400 hover:text-red-600 hover:bg-red-50">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )
          )}
        </div>
      )}

      {/* Modal */}
      {modal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm">
            <div className="flex items-center justify-between p-5 border-b border-slate-100">
              <h2 className="font-semibold text-slate-900">
                {editId ? 'Edit' : 'Add'} {modal === 'type' ? 'exam type' : modal === 'room' ? 'room' : 'holiday'}
              </h2>
              <button onClick={() => setModal(null)} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100">
                <X size={18} className="text-slate-500" />
              </button>
            </div>
            <form onSubmit={save} className="p-5 flex flex-col gap-4">
              {modal === 'type' && (
                <>
                  <div>
                    <label className="label">Name *</label>
                    <input type="text" className="input" required value={typeForm.name}
                      onChange={e => setTypeForm({ ...typeForm, name: e.target.value })} />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="label">Code</label>
                      <input type="text" className="input" placeholder="e.g. UT" value={typeForm.code}
                        onChange={e => setTypeForm({ ...typeForm, code: e.target.value })} />
                    </div>
                    <div>
                      <label className="label">Category</label>
                      <select className="input" value={typeForm.category}
                        onChange={e => setTypeForm({ ...typeForm, category: e.target.value as ExamTypeCategory })}>
                        {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                      </select>
                    </div>
                  </div>
                </>
              )}
              {modal === 'room' && (
                <>
                  <div>
                    <label className="label">Room name *</label>
                    <input type="text" className="input" required placeholder="e.g. Hall A" value={roomForm.name}
                      onChange={e => setRoomForm({ ...roomForm, name: e.target.value })} />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="label">Capacity</label>
                      <input type="number" min={1} className="input" placeholder="e.g. 40" value={roomForm.capacity}
                        onChange={e => setRoomForm({ ...roomForm, capacity: e.target.value })} />
                    </div>
                    <div>
                      <label className="label">Location</label>
                      <input type="text" className="input" placeholder="e.g. Block B" value={roomForm.location}
                        onChange={e => setRoomForm({ ...roomForm, location: e.target.value })} />
                    </div>
                  </div>
                </>
              )}
              {modal === 'holiday' && (
                <>
                  <div>
                    <label className="label">Holiday name *</label>
                    <input type="text" className="input" required placeholder="e.g. Diwali" value={holidayForm.name}
                      onChange={e => setHolidayForm({ ...holidayForm, name: e.target.value })} />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="label">Date *</label>
                      <input type="date" className="input" required value={holidayForm.holiday_date}
                        onChange={e => setHolidayForm({ ...holidayForm, holiday_date: e.target.value })} />
                    </div>
                    <div>
                      <label className="label">Session *</label>
                      <select className="input" required value={holidayForm.session_id}
                        onChange={e => setHolidayForm({ ...holidayForm, session_id: e.target.value })}>
                        {sessions.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                    </div>
                  </div>
                </>
              )}
              {error && <div className="bg-red-50 text-red-600 text-sm px-3 py-2 rounded-lg">{error}</div>}
              <button type="submit" className="btn-primary w-full py-2.5" disabled={busy}>
                {busy ? 'Saving…' : editId ? 'Save changes' : 'Add'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
