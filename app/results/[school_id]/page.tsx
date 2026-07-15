'use client'

// FILE: app/results/[school_id]/page.tsx
// PUBLIC result check (no auth). Roll number + DOB, rate-limited by the
// DB. Renders the immutable snapshot (no PII beyond name/class/marks).

import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'
import { createClient } from '@/utils/supabase/client'
import type { PublicResultExam, PublicResultCheck, ReportCardSnapshot } from '@/types'

export default function PublicResultsPage() {
  const { school_id } = useParams<{ school_id: string }>()
  const [exams, setExams] = useState<PublicResultExam[]>([])
  const [examId, setExamId] = useState('')
  const [roll, setRoll] = useState('')
  const [dob, setDob] = useState('')
  const [report, setReport] = useState<ReportCardSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    (async () => {
      const supabase = createClient()
      const { data, error } = await supabase.rpc('list_public_result_exams', { p_school_id: school_id })
      if (error) setError(error.message.includes('rate_limited') ? 'Too many requests. Please try again shortly.' : 'Could not load results.')
      else setExams((data ?? []) as PublicResultExam[])
      if (data && (data as PublicResultExam[])[0]) setExamId((data as PublicResultExam[])[0].exam_id)
      setLoading(false)
    })()
  }, [school_id])

  async function check(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError(''); setReport(null)
    const supabase = createClient()
    const { data, error } = await supabase.rpc('check_result_public', {
      p_school_id: school_id, p_exam_id: examId,
      p_roll_number: Number(roll), p_dob: dob,
    })
    setBusy(false)
    if (error) {
      setError(error.message.includes('rate_limited')
        ? 'Too many attempts. Please try again in a few minutes.'
        : 'Something went wrong. Please try again.')
      return
    }
    const res = data as PublicResultCheck
    if (!res.found) {
      setError(res.reason === 'not_published'
        ? 'Results for this exam are not published yet.'
        : 'No match found. Check the roll number and date of birth.')
      return
    }
    setReport(res.report ?? null)
  }

  return (
    <div className="min-h-screen bg-slate-50 py-10 px-4">
      <div className="max-w-lg mx-auto">
        <div className="text-center mb-6">
          <h1 className="text-xl font-bold text-slate-900">Check Exam Result</h1>
          <p className="text-sm text-slate-500 mt-1">Enter roll number and date of birth</p>
        </div>

        {loading ? (
          <div className="bg-white rounded-2xl shadow-sm h-64 animate-pulse" />
        ) : exams.length === 0 ? (
          <div className="bg-white rounded-2xl shadow-sm p-8 text-center text-sm text-slate-500">
            No published results available right now.
          </div>
        ) : !report ? (
          <form onSubmit={check} className="bg-white rounded-2xl shadow-sm p-6 flex flex-col gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Exam</label>
              <select className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm" value={examId}
                onChange={e => setExamId(e.target.value)}>
                {exams.map(x => <option key={x.exam_id} value={x.exam_id}>{x.exam_name} · {x.session_name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Roll number</label>
              <input type="number" required className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                value={roll} onChange={e => setRoll(e.target.value)} />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Date of birth</label>
              <input type="date" required className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                value={dob} onChange={e => setDob(e.target.value)} />
            </div>
            {error && <div className="bg-red-50 text-red-600 text-sm px-3 py-2 rounded-lg">{error}</div>}
            <button type="submit" disabled={busy}
              className="w-full bg-brand-600 text-white rounded-lg py-2.5 text-sm font-medium hover:bg-brand-700 disabled:opacity-50">
              {busy ? 'Checking…' : 'View result'}
            </button>
          </form>
        ) : (
          <ResultCard report={report} onBack={() => { setReport(null); setError('') }} />
        )}
      </div>
    </div>
  )
}

function ResultCard({ report, onBack }: { report: ReportCardSnapshot; onBack: () => void }) {
  const r = report.result
  const pass = r.status === 'pass'
  return (
    <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
      <div className="px-6 py-5 border-b border-slate-100 text-center">
        <p className="font-bold text-slate-900">{report.school.name}</p>
        <p className="text-xs text-slate-500">{report.exam.name}</p>
      </div>
      <div className="px-6 py-4">
        <div className="flex items-center justify-between mb-4">
          <div>
            <p className="font-semibold text-slate-900">{report.student.full_name}</p>
            <p className="text-xs text-slate-500">{report.student.class} · Roll {report.student.roll_number}</p>
          </div>
          <span className={`text-xs font-semibold px-3 py-1 rounded-full ${pass ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-600'}`}>
            {r.status.toUpperCase()}
          </span>
        </div>

        <table className="w-full text-sm mb-4">
          <thead>
            <tr className="text-left text-xs text-slate-400 border-b border-slate-100">
              <th className="py-2">Subject</th>
              <th className="py-2 text-center">Marks</th>
              <th className="py-2 text-center">Grade</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {report.subjects.map((s, i) => (
              <tr key={i}>
                <td className="py-1.5 text-slate-700">{s.subject}</td>
                <td className="py-1.5 text-center">{s.is_absent ? 'AB' : `${s.total ?? '—'}/${s.max}`}</td>
                <td className="py-1.5 text-center text-slate-500">{s.grade ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="grid grid-cols-2 gap-2 text-sm bg-slate-50 rounded-lg p-3">
          <div><span className="text-slate-400 text-xs">Total </span><span className="font-semibold">{r.total_obtained}/{r.total_max}</span></div>
          <div><span className="text-slate-400 text-xs">Percentage </span><span className="font-semibold">{r.percentage}%</span></div>
          {r.grade ? <div><span className="text-slate-400 text-xs">Grade </span><span className="font-semibold">{r.grade}</span></div> : null}
          {r.rank !== null ? <div><span className="text-slate-400 text-xs">Rank </span><span className="font-semibold">{r.rank}</span></div> : null}
        </div>

        {report.remarks ? <p className="text-xs text-slate-500 mt-3">{report.remarks}</p> : null}
      </div>
      <div className="px-6 py-3 border-t border-slate-100 flex items-center justify-between">
        <button onClick={onBack} className="text-xs text-slate-500 hover:text-slate-700">← Check another</button>
        <button onClick={() => window.print()} className="text-xs text-brand-600 font-medium hover:text-brand-700">Print</button>
      </div>
    </div>
  )
}
