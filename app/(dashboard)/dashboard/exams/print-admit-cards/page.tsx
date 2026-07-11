'use client'

// FILE: app/(dashboard)/dashboard/exams/print-admit-cards/page.tsx
// Front-desk admit card printing (receptionist-reachable via its own
// middleware carve-out). Search a student in a published exam and
// print/reprint a single card. Reprints are counted in the DB.

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/utils/supabase/client'
import { Printer, Search, X, Contact } from 'lucide-react'
import type { Exam } from '@/types'
import { classLabel, formatDate } from '@/components/exams/examUi'

interface Row {
  card_id: string
  student_id: string
  student_name: string
  student_uid: string | null
  class_label: string
  roll_number: number
  print_count: number
  last_printed_at: string | null
}

export default function PrintAdmitCardsPage() {
  const [exams, setExams] = useState<Exam[]>([])
  const [examId, setExamId] = useState('')
  const [rows, setRows] = useState<Row[]>([])
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    (async () => {
      const supabase = createClient()
      const { data } = await supabase.from('exams')
        .select('*')
        .in('status', ['published', 'ongoing'])
        .order('start_date', { ascending: true })
      const list = (data ?? []) as Exam[]
      setExams(list)
      if (list[0]) setExamId(list[0].id)
      else setLoading(false)
    })()
  }, [])

  const fetchCards = useCallback(async () => {
    if (!examId) return
    setLoading(true)
    const supabase = createClient()
    const { data, error } = await supabase
      .from('admit_cards')
      .select('id, print_count, last_printed_at, exam_enrollments!inner(roll_number, student_id, students(full_name, student_uid), classes(name, section))')
      .eq('exam_id', examId)
      .eq('is_revoked', false)
    if (error) { setError(error.message); setLoading(false); return }
    /* eslint-disable @typescript-eslint/no-explicit-any */
    setRows(((data ?? []) as any[]).map(r => ({
      card_id: r.id,
      student_id: r.exam_enrollments.student_id,
      student_name: r.exam_enrollments.students?.full_name ?? '—',
      student_uid: r.exam_enrollments.students?.student_uid ?? null,
      class_label: classLabel(r.exam_enrollments.classes),
      roll_number: r.exam_enrollments.roll_number,
      print_count: r.print_count,
      last_printed_at: r.last_printed_at,
    })).sort((a, b) => a.class_label.localeCompare(b.class_label) || a.roll_number - b.roll_number))
    /* eslint-enable @typescript-eslint/no-explicit-any */
    setLoading(false)
  }, [examId])

  useEffect(() => { fetchCards() }, [fetchCards])

  async function printOne(row: Row) {
    setBusy(row.card_id); setError('')
    const res = await fetch('/api/exams/admit-cards-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exam_id: examId, layout: 'single', student_ids: [row.student_id] }),
    })
    setBusy(null)
    if (!res.ok) {
      const j = await res.json().catch(() => ({ error: 'Print failed' }))
      setError(j.error ?? 'Print failed'); return
    }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `admit-card-${row.student_name.replace(/\s+/g, '-').toLowerCase()}.pdf`
    a.click()
    URL.revokeObjectURL(url)
    await fetchCards()
  }

  const needle = q.trim().toLowerCase()
  const visible = needle
    ? rows.filter(r =>
        r.student_name.toLowerCase().includes(needle)
        || (r.student_uid ?? '').toLowerCase().includes(needle)
        || r.class_label.toLowerCase().includes(needle)
        || String(r.roll_number) === needle)
    : rows

  return (
    <div className="max-w-3xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Print admit cards</h1>
        <p className="text-slate-500 text-sm mt-1">Front desk — search a student and print or reprint their card</p>
      </div>

      {error && (
        <div className="bg-red-50 text-red-600 text-sm px-4 py-3 rounded-lg mb-4 flex items-start justify-between gap-3">
          <span>{error}</span><button onClick={() => setError('')}><X size={14} /></button>
        </div>
      )}

      {exams.length === 0 && !loading ? (
        <div className="card flex flex-col items-center justify-center py-16 text-center">
          <div className="w-14 h-14 bg-slate-100 rounded-full flex items-center justify-center mb-4">
            <Contact size={24} className="text-slate-400" />
          </div>
          <p className="text-sm text-slate-500">No published exams right now.</p>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <select className="input !w-auto text-sm" value={examId} onChange={e => setExamId(e.target.value)}>
              {exams.map(e => (
                <option key={e.id} value={e.id}>
                  {e.name}{e.start_date ? ` (${formatDate(e.start_date)})` : ''}
                </option>
              ))}
            </select>
            <div className="relative flex-1 min-w-[200px]">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input type="text" className="input !pl-9" placeholder="Search name, ID, class or roll…"
                value={q} onChange={e => setQ(e.target.value)} />
            </div>
          </div>

          <div className="card overflow-hidden">
            {loading ? (
              <div className="h-48 animate-pulse bg-slate-50" />
            ) : visible.length === 0 ? (
              <p className="text-sm text-slate-400 py-10 text-center">
                {rows.length === 0
                  ? 'No admit cards generated for this exam yet — ask the exam admin to generate them.'
                  : 'No students match your search.'}
              </p>
            ) : (
              <div className="divide-y divide-slate-50">
                {visible.slice(0, 50).map(r => (
                  <div key={r.card_id} className="flex items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-800">{r.student_name}</p>
                      <p className="text-xs text-slate-400">
                        {r.class_label} · Roll {r.roll_number}
                        {r.student_uid ? ` · ${r.student_uid}` : ''}
                        {r.print_count > 0 ? ` · printed ${r.print_count}×` : ' · never printed'}
                      </p>
                    </div>
                    <button onClick={() => printOne(r)} disabled={busy !== null}
                      className="btn-secondary text-xs flex items-center gap-1.5 shrink-0">
                      <Printer size={13} />
                      {busy === r.card_id ? 'Preparing…' : r.print_count > 0 ? 'Reprint' : 'Print'}
                    </button>
                  </div>
                ))}
                {visible.length > 50 && (
                  <p className="text-xs text-slate-400 text-center py-2">Showing first 50 — refine your search.</p>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
