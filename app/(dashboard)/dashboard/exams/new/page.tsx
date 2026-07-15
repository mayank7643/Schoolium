'use client'

// FILE: app/(dashboard)/dashboard/exams/new/page.tsx
// Create-exam form (basics). On create the draft opens in the
// configure screen for classes + papers.

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/utils/supabase/client'
import { ArrowLeft } from 'lucide-react'
import type { AcademicSession, AcademicTerm, ExamType } from '@/types'

export default function NewExamPage() {
  const router = useRouter()
  const [sessions, setSessions] = useState<AcademicSession[]>([])
  const [terms, setTerms] = useState<AcademicTerm[]>([])
  const [types, setTypes] = useState<ExamType[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const [form, setForm] = useState({
    session_id: '',
    exam_type_id: '',
    term_id: '',
    name: '',
    instructions: '',
  })

  useEffect(() => {
    (async () => {
      const supabase = createClient()
      const [sRes, tRes, tyRes] = await Promise.all([
        supabase.from('academic_sessions').select('*')
          .in('status', ['upcoming', 'active']).order('start_date', { ascending: false }),
        supabase.from('academic_terms').select('*').order('sort_order'),
        supabase.from('exam_types').select('*').eq('is_active', true).order('name'),
      ])
      const sList = (sRes.data ?? []) as AcademicSession[]
      setSessions(sList)
      setTerms((tRes.data ?? []) as AcademicTerm[])
      setTypes((tyRes.data ?? []) as ExamType[])
      const current = sList.find(s => s.is_current) ?? sList[0]
      setForm(f => ({ ...f, session_id: current?.id ?? '' }))
      setLoading(false)
    })()
  }, [])

  const sessionTerms = terms.filter(t => t.session_id === form.session_id)
  const typeName = types.find(t => t.id === form.exam_type_id)?.name
  const sessionName = sessions.find(s => s.id === form.session_id)?.name

  function suggestName() {
    if (!typeName || !sessionName || form.name.trim()) return
    setForm(f => ({ ...f, name: `${typeName} ${sessionName}` }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setError('')
    const supabase = createClient()
    const { data, error } = await supabase.rpc('create_exam', {
      p_session_id: form.session_id,
      p_exam_type_id: form.exam_type_id,
      p_name: form.name,
      p_term_id: form.term_id || null,
      p_instructions: form.instructions.trim() || null,
    })
    if (error) { setError(error.message); setSaving(false); return }
    router.push(`/dashboard/exams/${data}/configure`)
  }

  return (
    <div className="max-w-xl mx-auto">
      <Link href="/dashboard/exams" className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600 mb-1">
        <ArrowLeft size={12} /> Exams
      </Link>
      <h1 className="text-2xl font-bold text-slate-900 mb-1">New exam</h1>
      <p className="text-slate-500 text-sm mb-6">
        Step 1 of 2 — basics. Classes, subjects and the timetable come next.
      </p>

      {loading ? (
        <div className="card h-80 animate-pulse bg-slate-50" />
      ) : sessions.length === 0 ? (
        <div className="card p-6 text-center">
          <p className="text-sm text-slate-600 mb-3">
            No active academic session. Create one before adding exams.
          </p>
          <Link href="/dashboard/exams/sessions" className="btn-primary text-sm">Create session</Link>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="card p-6 flex flex-col gap-4">
          <div>
            <label className="label">Academic session *</label>
            <select className="input" required value={form.session_id}
              onChange={e => setForm({ ...form, session_id: e.target.value, term_id: '' })}>
              {sessions.map(s => (
                <option key={s.id} value={s.id}>{s.name}{s.is_current ? ' (current)' : ''}</option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="label">Exam type *</label>
              <select className="input" required value={form.exam_type_id}
                onChange={e => setForm({ ...form, exam_type_id: e.target.value })} onBlur={suggestName}>
                <option value="">Select type…</option>
                {types.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Term (optional)</label>
              <select className="input" value={form.term_id}
                onChange={e => setForm({ ...form, term_id: e.target.value })}>
                <option value="">No term</option>
                {sessionTerms.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="label">Exam name *</label>
            <input type="text" className="input" required placeholder="e.g. Half Yearly Examination 2026-27"
              value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <label className="label">General instructions (printed on admit cards)</label>
            <textarea className="input min-h-[90px]" placeholder="e.g. Reach 30 minutes before the exam. Carry your admit card…"
              value={form.instructions} onChange={e => setForm({ ...form, instructions: e.target.value })} />
          </div>
          {error && <div className="bg-red-50 text-red-600 text-sm px-3 py-2 rounded-lg">{error}</div>}
          <button type="submit" className="btn-primary w-full py-2.5" disabled={saving}>
            {saving ? 'Creating…' : 'Create draft & configure classes →'}
          </button>
        </form>
      )}
    </div>
  )
}
