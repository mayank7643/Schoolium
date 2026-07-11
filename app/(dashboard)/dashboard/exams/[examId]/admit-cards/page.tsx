'use client'

// FILE: app/(dashboard)/dashboard/exams/[examId]/admit-cards/page.tsx
// Admit cards: generate (bulk, idempotent), bulk print per layout,
// revoke + regenerate, per-student reprint.

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { createClient } from '@/utils/supabase/client'
import { ArrowLeft, X, Contact, Printer, RefreshCw, Ban } from 'lucide-react'
import type { Exam, AdmitCardLayout, GenerateAdmitCardsResult } from '@/types'
import { ExamStatusBadge, classLabel } from '@/components/exams/examUi'

interface CardRow {
  id: string
  print_count: number
  last_printed_at: string | null
  enrollment: {
    id: string
    roll_number: number
    class_id: string
    student_id: string
    student_name: string
    student_uid: string | null
  }
}

interface ClassOpt { id: string; label: string }

const LAYOUT_OPTIONS: Array<{ value: AdmitCardLayout; label: string }> = [
  { value: 'single',        label: '1 per A4 (full schedule)' },
  { value: 'two_per_a4',    label: '2 per A4' },
  { value: 'three_per_a4',  label: '3 per A4 (compact)' },
  { value: 'four_per_a4',   label: '4 per A4 (compact)' },
]

export default function AdmitCardsPage() {
  const { examId } = useParams<{ examId: string }>()
  const router = useRouter()

  const [exam, setExam] = useState<Exam | null>(null)
  const [classes, setClasses] = useState<ClassOpt[]>([])
  const [cards, setCards] = useState<CardRow[]>([])
  const [enrolledCount, setEnrolledCount] = useState(0)
  const [activeClass, setActiveClass] = useState<string>('all')
  const [layout, setLayout] = useState<AdmitCardLayout>('single')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const fetchAll = useCallback(async () => {
    const supabase = createClient()
    const eRes = await supabase.from('exams').select('*').eq('id', examId).single()
    if (eRes.error || !eRes.data) { router.push('/dashboard/exams'); return }
    setExam(eRes.data as Exam)

    const [ecRes, enRes, acRes] = await Promise.all([
      supabase.from('exam_classes').select('classes(id, name, section)').eq('exam_id', examId),
      supabase.from('exam_enrollments').select('id', { count: 'exact', head: true })
        .eq('exam_id', examId).eq('status', 'enrolled'),
      supabase.from('admit_cards')
        .select('id, print_count, last_printed_at, exam_enrollments!inner(id, roll_number, class_id, student_id, students(full_name, student_uid))')
        .eq('exam_id', examId).eq('is_revoked', false),
    ])
    /* eslint-disable @typescript-eslint/no-explicit-any */
    setClasses(((ecRes.data ?? []) as any[])
      .map(r => r.classes).filter(Boolean)
      .map((c: any) => ({ id: c.id, label: classLabel(c) })))
    setEnrolledCount(enRes.count ?? 0)
    setCards(((acRes.data ?? []) as any[]).map(r => ({
      id: r.id,
      print_count: r.print_count,
      last_printed_at: r.last_printed_at,
      enrollment: {
        id: r.exam_enrollments.id,
        roll_number: r.exam_enrollments.roll_number,
        class_id: r.exam_enrollments.class_id,
        student_id: r.exam_enrollments.student_id,
        student_name: r.exam_enrollments.students?.full_name ?? '—',
        student_uid: r.exam_enrollments.students?.student_uid ?? null,
      },
    })).sort((a, b) => a.enrollment.roll_number - b.enrollment.roll_number))
    /* eslint-enable @typescript-eslint/no-explicit-any */
    setLoading(false)
  }, [examId, router])

  useEffect(() => { fetchAll() }, [fetchAll])

  async function generate(classId?: string) {
    setBusy(true); setError(''); setNotice('')
    const supabase = createClient()
    const { data, error } = await supabase.rpc('generate_admit_cards', {
      p_exam_id: examId, p_class_id: classId ?? null, p_template_id: null,
    })
    setBusy(false)
    if (error) { setError(error.message); return }
    const r = data as GenerateAdmitCardsResult
    setNotice(r.generated > 0
      ? `${r.generated} admit card(s) generated (${r.total_live} total)`
      : 'All enrolled students already have a card')
    await fetchAll()
  }

  async function downloadPdf(opts: { class_id?: string; student_ids?: string[] }) {
    setBusy(true); setError('')
    const res = await fetch('/api/exams/admit-cards-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exam_id: examId, layout, ...opts }),
    })
    setBusy(false)
    if (!res.ok) {
      const j = await res.json().catch(() => ({ error: 'Download failed' }))
      setError(j.error ?? 'Download failed'); return
    }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'admit-cards.pdf'
    a.click()
    URL.revokeObjectURL(url)
    await fetchAll() // refresh print counts
  }

  async function revoke(card: CardRow) {
    const reason = prompt(`Revoke admit card of ${card.enrollment.student_name}?\nReason (required):`)
    if (reason === null) return
    setBusy(true); setError('')
    const supabase = createClient()
    const { error } = await supabase.rpc('revoke_admit_card', {
      p_admit_card_id: card.id, p_reason: reason,
    })
    setBusy(false)
    if (error) { setError(error.message); return }
    setNotice('Card revoked — regenerate to issue a fresh card with a new QR')
    await fetchAll()
  }

  if (loading || !exam) {
    return <div className="max-w-4xl mx-auto"><div className="card h-96 animate-pulse bg-slate-50" /></div>
  }

  const visibleCards = activeClass === 'all' ? cards : cards.filter(c => c.enrollment.class_id === activeClass)
  const canGenerate = exam.status === 'published' || exam.status === 'ongoing'

  return (
    <div className="max-w-4xl mx-auto">
      <Link href={`/dashboard/exams/${examId}`} className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600 mb-1">
        <ArrowLeft size={12} /> {exam.name}
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-slate-900">Admit cards</h1>
            <ExamStatusBadge status={exam.status} />
          </div>
          <p className="text-slate-500 text-sm mt-1">
            {cards.length} card(s) live · {enrolledCount} enrolled student(s)
          </p>
        </div>
        {canGenerate && (
          <button onClick={() => generate()} disabled={busy}
            className="btn-primary text-sm flex items-center gap-1.5">
            <Contact size={15} /> Generate missing cards
          </button>
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

      {/* Bulk print bar */}
      {cards.length > 0 && (
        <div className="card p-4 mb-4 flex flex-wrap items-center gap-3">
          <span className="text-sm font-medium text-slate-700">Bulk print:</span>
          <select className="input !w-auto text-sm" value={layout}
            onChange={e => setLayout(e.target.value as AdmitCardLayout)}>
            {LAYOUT_OPTIONS.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
          </select>
          <select className="input !w-auto text-sm" value={activeClass}
            onChange={e => setActiveClass(e.target.value)}>
            <option value="all">All classes</option>
            {classes.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
          <button
            onClick={() => downloadPdf(activeClass === 'all' ? {} : { class_id: activeClass })}
            disabled={busy}
            className="btn-secondary text-sm flex items-center gap-1.5">
            <Printer size={15} /> {busy ? 'Preparing…' : 'Download PDF'}
          </button>
        </div>
      )}

      {/* Cards table */}
      <div className="card overflow-hidden">
        {visibleCards.length === 0 ? (
          <div className="py-14 text-center">
            <div className="w-14 h-14 bg-slate-100 rounded-full flex items-center justify-center mb-4 mx-auto">
              <Contact size={24} className="text-slate-400" />
            </div>
            <p className="text-sm text-slate-500 max-w-sm mx-auto">
              {canGenerate
                ? 'No admit cards yet — generate them once the timetable is final.'
                : 'Admit cards are generated after the exam is published.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[560px]">
              <thead>
                <tr className="text-left text-xs text-slate-400 border-b border-slate-100">
                  <th className="px-4 py-3 font-medium w-16">Roll</th>
                  <th className="px-4 py-3 font-medium">Student</th>
                  <th className="px-4 py-3 font-medium">Class</th>
                  <th className="px-4 py-3 font-medium">Prints</th>
                  <th className="px-4 py-3 font-medium w-40">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {visibleCards.map(c => (
                  <tr key={c.id}>
                    <td className="px-4 py-2.5 font-semibold text-slate-700">{c.enrollment.roll_number}</td>
                    <td className="px-4 py-2.5">
                      <p className="font-medium text-slate-800">{c.enrollment.student_name}</p>
                      {c.enrollment.student_uid && <p className="text-xs text-slate-400">{c.enrollment.student_uid}</p>}
                    </td>
                    <td className="px-4 py-2.5 text-slate-600">
                      {classes.find(cl => cl.id === c.enrollment.class_id)?.label ?? '—'}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={c.print_count > 0 ? 'badge-blue' : 'text-xs text-slate-400'}>
                        {c.print_count > 0 ? `${c.print_count}×` : 'never'}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <button onClick={() => downloadPdf({ student_ids: [c.enrollment.student_id] })}
                          disabled={busy}
                          className="text-xs px-2 py-1 rounded text-slate-500 hover:bg-slate-100 flex items-center gap-1">
                          <Printer size={12} /> {c.print_count > 0 ? 'Reprint' : 'Print'}
                        </button>
                        {canGenerate && (
                          <button onClick={() => revoke(c)} disabled={busy}
                            className="text-xs px-2 py-1 rounded text-red-500 hover:bg-red-50 flex items-center gap-1">
                            <Ban size={12} /> Revoke
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {canGenerate && cards.length < enrolledCount && cards.length > 0 && (
        <div className="mt-4 flex items-center justify-center">
          <button onClick={() => generate()} disabled={busy}
            className="text-sm text-brand-600 font-medium hover:text-brand-700 flex items-center gap-1.5">
            <RefreshCw size={14} /> {enrolledCount - cards.length} student(s) missing a card — generate now
          </button>
        </div>
      )}
    </div>
  )
}
