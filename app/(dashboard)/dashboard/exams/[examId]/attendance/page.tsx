'use client'

// FILE: app/(dashboard)/dashboard/exams/[examId]/attendance/page.tsx
// Admin exam-attendance matrix: per-paper counts from
// get_exam_attendance_report. Drill into any paper to mark/correct.

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { createClient } from '@/utils/supabase/client'
import { ArrowLeft, X, CalendarCheck } from 'lucide-react'
import type { Exam, ExamAttendanceReportRow } from '@/types'
import { ExamStatusBadge, formatDate } from '@/components/exams/examUi'

export default function ExamAttendanceMatrixPage() {
  const { examId } = useParams<{ examId: string }>()
  const router = useRouter()
  const [exam, setExam] = useState<Exam | null>(null)
  const [rows, setRows] = useState<ExamAttendanceReportRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const fetchAll = useCallback(async () => {
    const supabase = createClient()
    const eRes = await supabase.from('exams').select('*').eq('id', examId).single()
    if (eRes.error || !eRes.data) { router.push('/dashboard/exams'); return }
    setExam(eRes.data as Exam)
    const { data, error } = await supabase.rpc('get_exam_attendance_report', { p_exam_id: examId })
    if (error) setError(error.message)
    else setRows((data ?? []) as ExamAttendanceReportRow[])
    setLoading(false)
  }, [examId, router])

  useEffect(() => { fetchAll() }, [fetchAll])

  if (loading || !exam) {
    return <div className="max-w-4xl mx-auto"><div className="card h-96 animate-pulse bg-slate-50" /></div>
  }

  const totals = rows.reduce((a, r) => ({
    present: a.present + r.present, late: a.late + r.late,
    absent: a.absent + r.absent, medical: a.medical + r.medical,
    unmarked: a.unmarked + r.unmarked,
  }), { present: 0, late: 0, absent: 0, medical: 0, unmarked: 0 })

  return (
    <div className="max-w-4xl mx-auto">
      <Link href={`/dashboard/exams/${examId}`} className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600 mb-1">
        <ArrowLeft size={12} /> {exam.name}
      </Link>
      <div className="flex items-center justify-between gap-3 mb-6">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-slate-900">Exam attendance</h1>
            <ExamStatusBadge status={exam.status} />
          </div>
          <p className="text-slate-500 text-sm mt-1">Per-paper attendance — separate from daily/gate attendance</p>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 text-red-600 text-sm px-4 py-3 rounded-lg mb-4 flex items-start justify-between gap-3">
          <span>{error}</span><button onClick={() => setError('')}><X size={14} /></button>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="card flex flex-col items-center justify-center py-16 text-center">
          <div className="w-14 h-14 bg-slate-100 rounded-full flex items-center justify-center mb-4">
            <CalendarCheck size={24} className="text-slate-400" />
          </div>
          <p className="text-sm text-slate-500">No papers to show — configure the exam first.</p>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead>
                <tr className="text-left text-xs text-slate-400 border-b border-slate-100">
                  <th className="px-4 py-3 font-medium">Class</th>
                  <th className="px-4 py-3 font-medium">Subject</th>
                  <th className="px-4 py-3 font-medium">Date</th>
                  <th className="px-3 py-3 font-medium text-center">Enr.</th>
                  <th className="px-3 py-3 font-medium text-center text-emerald-600">P</th>
                  <th className="px-3 py-3 font-medium text-center text-amber-600">L</th>
                  <th className="px-3 py-3 font-medium text-center text-red-500">A</th>
                  <th className="px-3 py-3 font-medium text-center text-blue-600">M</th>
                  <th className="px-3 py-3 font-medium text-center text-slate-400">?</th>
                  <th className="px-4 py-3 font-medium"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {rows.map(r => (
                  <tr key={r.exam_subject_id}>
                    <td className="px-4 py-2.5 font-medium text-slate-800">{r.class_label}</td>
                    <td className="px-4 py-2.5 text-slate-700">{r.subject_name}</td>
                    <td className="px-4 py-2.5 text-xs text-slate-500">{formatDate(r.exam_date)}</td>
                    <td className="px-3 py-2.5 text-center text-slate-600">{r.enrolled}</td>
                    <td className="px-3 py-2.5 text-center font-medium text-emerald-600">{r.present || '·'}</td>
                    <td className="px-3 py-2.5 text-center font-medium text-amber-600">{r.late || '·'}</td>
                    <td className="px-3 py-2.5 text-center font-medium text-red-500">{r.absent || '·'}</td>
                    <td className="px-3 py-2.5 text-center font-medium text-blue-600">{r.medical || '·'}</td>
                    <td className="px-3 py-2.5 text-center text-slate-400">{r.unmarked || '·'}</td>
                    <td className="px-4 py-2.5 text-right">
                      <Link href={`/dashboard/my-exams/attendance/${r.exam_subject_id}`}
                        className="text-xs text-brand-600 font-medium hover:text-brand-700">
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-slate-100 text-xs font-semibold text-slate-600">
                  <td className="px-4 py-2.5" colSpan={4}>Totals</td>
                  <td className="px-3 py-2.5 text-center text-emerald-600">{totals.present}</td>
                  <td className="px-3 py-2.5 text-center text-amber-600">{totals.late}</td>
                  <td className="px-3 py-2.5 text-center text-red-500">{totals.absent}</td>
                  <td className="px-3 py-2.5 text-center text-blue-600">{totals.medical}</td>
                  <td className="px-3 py-2.5 text-center text-slate-400">{totals.unmarked}</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
