'use client'

// FILE: app/(dashboard)/dashboard/exams/[examId]/enrollments/page.tsx
// Enrollments: roll numbers per class, status changes (exempt/withdraw/
// transfer), late-admission re-run, and session subject overrides.

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { createClient } from '@/utils/supabase/client'
import { ArrowLeft, RefreshCw, X, Plus, Trash2, UserRound } from 'lucide-react'
import type {
  Exam, ExamEnrollment, EnrollmentStatus, Class, Subject, Student,
  StudentSubjectOverride, GenerateEnrollmentsResult,
} from '@/types'
import { ExamStatusBadge, classLabel } from '@/components/exams/examUi'

const ENROLL_BADGE: Record<EnrollmentStatus, string> = {
  enrolled:    'badge-green',
  exempted:    'badge-blue',
  withdrawn:   'badge-yellow',
  transferred: 'badge-red',
}

export default function EnrollmentsPage() {
  const { examId } = useParams<{ examId: string }>()
  const router = useRouter()

  const [exam, setExam] = useState<Exam | null>(null)
  const [enrollments, setEnrollments] = useState<ExamEnrollment[]>([])
  const [examClasses, setExamClasses] = useState<Class[]>([])
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [overrides, setOverrides] = useState<StudentSubjectOverride[]>([])
  const [activeClass, setActiveClass] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const [showOverrideModal, setShowOverrideModal] = useState(false)
  const [overrideForm, setOverrideForm] = useState({
    student_id: '', subject_id: '', kind: 'exempted' as 'exempted' | 'optional_selected', reason: '',
  })

  const fetchAll = useCallback(async () => {
    const supabase = createClient()
    const eRes = await supabase.from('exams')
      .select('*, exam_types(name, code, category)').eq('id', examId).single()
    if (eRes.error || !eRes.data) { router.push('/dashboard/exams'); return }
    const ex = eRes.data as Exam
    setExam(ex)

    const [enRes, ecRes, subRes, ovRes] = await Promise.all([
      supabase.from('exam_enrollments')
        .select('*, students(full_name, photo_url, student_uid), classes(id, school_id, name, section, created_at)')
        .eq('exam_id', examId)
        .order('roll_number'),
      supabase.from('exam_classes').select('classes(id, school_id, name, section, created_at)').eq('exam_id', examId),
      supabase.from('subjects').select('*').eq('is_active', true).order('name'),
      supabase.from('student_subject_overrides')
        .select('*, students(full_name), subjects(name)')
        .eq('session_id', ex.session_id),
    ])
    setEnrollments((enRes.data ?? []) as unknown as ExamEnrollment[])
    const cls = ((ecRes.data ?? []) as unknown as Array<{ classes: Class }>)
      .map(r => r.classes).filter(Boolean)
    setExamClasses(cls)
    setActiveClass(prev => prev && cls.some(c => c.id === prev) ? prev : (cls[0]?.id ?? ''))
    setSubjects((subRes.data ?? []) as Subject[])
    setOverrides((ovRes.data ?? []) as unknown as StudentSubjectOverride[])
    setLoading(false)
  }, [examId, router])

  useEffect(() => { fetchAll() }, [fetchAll])

  const classEnrollments = enrollments.filter(e => e.class_id === activeClass)
  const mutable = exam != null && exam.status !== 'locked' && exam.status !== 'cancelled'

  async function regenerate() {
    setBusy(true); setError(''); setNotice('')
    const supabase = createClient()
    const { data, error } = await supabase.rpc('generate_exam_enrollments', { p_exam_id: examId })
    setBusy(false)
    if (error) { setError(error.message); return }
    const r = data as GenerateEnrollmentsResult
    setNotice(r.enrolled > 0
      ? `${r.enrolled} new student(s) enrolled (late admissions get the next roll number)`
      : 'No new students to enroll — everyone is already in')
    await fetchAll()
  }

  async function changeStatus(en: ExamEnrollment, status: EnrollmentStatus) {
    if (status === en.status) return
    let remarks: string | null = null
    if (status !== 'enrolled') {
      remarks = prompt(`Remark for marking ${en.students?.full_name ?? 'student'} as ${status} (optional):`)
      if (remarks === null) return
    }
    setBusy(true); setError('')
    const supabase = createClient()
    const { error } = await supabase.rpc('set_enrollment_status', {
      p_enrollment_id: en.id, p_status: status, p_remarks: remarks || null,
    })
    setBusy(false)
    if (error) { setError(error.message); return }
    await fetchAll()
  }

  async function submitOverride(e: React.FormEvent) {
    e.preventDefault()
    if (!exam) return
    setBusy(true); setError('')
    const supabase = createClient()
    const { error } = await supabase.rpc('upsert_student_subject_override', {
      p_session_id: exam.session_id,
      p_student_id: overrideForm.student_id,
      p_subject_id: overrideForm.subject_id,
      p_kind: overrideForm.kind,
      p_reason: overrideForm.reason.trim() || null,
    })
    setBusy(false)
    if (error) { setError(error.message); return }
    setShowOverrideModal(false)
    await fetchAll()
  }

  async function deleteOverride(ov: StudentSubjectOverride) {
    if (!confirm(`Remove ${ov.kind === 'exempted' ? 'exemption' : 'optional selection'} of ${ov.subjects?.name} for ${ov.students?.full_name}?`)) return
    setBusy(true); setError('')
    const supabase = createClient()
    const { error } = await supabase.rpc('delete_student_subject_override', { p_override_id: ov.id })
    setBusy(false)
    if (error) { setError(error.message); return }
    await fetchAll()
  }

  if (loading || !exam) {
    return <div className="max-w-4xl mx-auto"><div className="card h-96 animate-pulse bg-slate-50" /></div>
  }

  // students enrolled in this exam, for the override picker
  const enrolledStudents: Array<{ id: string; label: string }> = enrollments.map(e => ({
    id: e.student_id,
    label: `${e.students?.full_name ?? '—'} (${classLabel(e.classes)} · roll ${e.roll_number})`,
  }))

  return (
    <div className="max-w-4xl mx-auto">
      <Link href={`/dashboard/exams/${examId}`} className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600 mb-1">
        <ArrowLeft size={12} /> {exam.name}
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-slate-900">Enrollments</h1>
            <ExamStatusBadge status={exam.status} />
          </div>
          <p className="text-slate-500 text-sm mt-1">{enrollments.length} student(s) · roll numbers are exam-specific</p>
        </div>
        {mutable && (
          <button onClick={regenerate} disabled={busy} className="btn-secondary text-sm flex items-center gap-1.5">
            <RefreshCw size={15} className={busy ? 'animate-spin' : ''} /> Enroll new students
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

      {/* Class tabs */}
      <div className="flex gap-1.5 overflow-x-auto pb-1 mb-4">
        {examClasses.map(c => (
          <button key={c.id} onClick={() => setActiveClass(c.id)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
              activeClass === c.id ? 'bg-brand-600 text-white' : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
            }`}>
            {classLabel(c)} ({enrollments.filter(e => e.class_id === c.id).length})
          </button>
        ))}
      </div>

      {/* Enrollment table */}
      <div className="card overflow-hidden mb-6">
        {classEnrollments.length === 0 ? (
          <div className="py-14 text-center">
            <div className="w-14 h-14 bg-slate-100 rounded-full flex items-center justify-center mb-4 mx-auto">
              <UserRound size={24} className="text-slate-400" />
            </div>
            <p className="text-sm text-slate-500">
              No enrollments yet — they are generated automatically when the exam is published.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[560px]">
              <thead>
                <tr className="text-left text-xs text-slate-400 border-b border-slate-100">
                  <th className="px-4 py-3 font-medium w-16">Roll</th>
                  <th className="px-4 py-3 font-medium">Student</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Remarks</th>
                  {mutable && <th className="px-4 py-3 font-medium w-36">Change</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {classEnrollments.map(en => (
                  <tr key={en.id}>
                    <td className="px-4 py-2.5 font-semibold text-slate-700">{en.roll_number}</td>
                    <td className="px-4 py-2.5">
                      <p className="font-medium text-slate-800">{en.students?.full_name ?? '—'}</p>
                      {en.students?.student_uid && (
                        <p className="text-xs text-slate-400">{en.students.student_uid}</p>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={ENROLL_BADGE[en.status]}>{en.status}</span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-slate-500 max-w-[180px] truncate">{en.remarks ?? '—'}</td>
                    {mutable && (
                      <td className="px-4 py-2.5">
                        <select
                          className="input !py-1 !text-xs"
                          value={en.status}
                          disabled={busy}
                          onChange={e => changeStatus(en, e.target.value as EnrollmentStatus)}
                        >
                          <option value="enrolled">enrolled</option>
                          <option value="exempted">exempted</option>
                          <option value="withdrawn">withdrawn</option>
                          <option value="transferred">transferred (TC)</option>
                        </select>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Subject overrides (session-wide) */}
      <div className="card p-5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="font-semibold text-slate-900 text-sm">Subject exemptions & optional subjects</h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Session-wide — applies to every exam in this academic session
            </p>
          </div>
          {mutable && enrolledStudents.length > 0 && (
            <button
              onClick={() => {
                setOverrideForm({ student_id: enrolledStudents[0].id, subject_id: subjects[0]?.id ?? '', kind: 'exempted', reason: '' })
                setShowOverrideModal(true)
              }}
              className="text-xs text-brand-600 font-medium hover:text-brand-700 flex items-center gap-1">
              <Plus size={13} /> Add
            </button>
          )}
        </div>
        {overrides.length === 0 ? (
          <p className="text-sm text-slate-400 py-3 text-center">
            None — e.g. exempt a student from Sanskrit, or record an optional-subject selection.
          </p>
        ) : (
          <div className="flex flex-col divide-y divide-slate-50">
            {overrides.map(ov => (
              <div key={ov.id} className="flex items-center justify-between gap-3 py-2.5 group">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-800">
                    {ov.students?.full_name ?? '—'}
                    <span className="text-slate-400 font-normal"> · {ov.subjects?.name ?? '—'}</span>
                  </p>
                  <p className="text-xs text-slate-500">
                    {ov.kind === 'exempted' ? 'Exempted' : 'Optional subject selected'}
                    {ov.reason ? ` — ${ov.reason}` : ''}
                  </p>
                </div>
                {mutable && (
                  <button onClick={() => deleteOverride(ov)}
                    className="w-6 h-6 flex items-center justify-center rounded text-slate-300 hover:text-red-600 hover:bg-red-50 shrink-0">
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Override modal */}
      {showOverrideModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm">
            <div className="flex items-center justify-between p-5 border-b border-slate-100">
              <h2 className="font-semibold text-slate-900">Add subject override</h2>
              <button onClick={() => setShowOverrideModal(false)} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100">
                <X size={18} className="text-slate-500" />
              </button>
            </div>
            <form onSubmit={submitOverride} className="p-5 flex flex-col gap-4">
              <div>
                <label className="label">Student *</label>
                <select className="input" required value={overrideForm.student_id}
                  onChange={e => setOverrideForm({ ...overrideForm, student_id: e.target.value })}>
                  {enrolledStudents.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Subject *</label>
                  <select className="input" required value={overrideForm.subject_id}
                    onChange={e => setOverrideForm({ ...overrideForm, subject_id: e.target.value })}>
                    {subjects.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label">Kind *</label>
                  <select className="input" value={overrideForm.kind}
                    onChange={e => setOverrideForm({ ...overrideForm, kind: e.target.value as 'exempted' | 'optional_selected' })}>
                    <option value="exempted">Exempted</option>
                    <option value="optional_selected">Optional selected</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="label">Reason</label>
                <input type="text" className="input" placeholder="e.g. Medical exemption"
                  value={overrideForm.reason} onChange={e => setOverrideForm({ ...overrideForm, reason: e.target.value })} />
              </div>
              {error && <div className="bg-red-50 text-red-600 text-sm px-3 py-2 rounded-lg">{error}</div>}
              <button type="submit" className="btn-primary w-full py-2.5" disabled={busy}>
                {busy ? 'Saving…' : 'Save override'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
