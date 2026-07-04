'use client'

// FILE: app/(dashboard)/dashboard/staff/assignments/page.tsx
//
// Teacher assignments (chat17 Module 2). Admin/principal pick a teacher
// and manage two things, matching the product spec exactly:
//   1. CLASS TEACHER - a teacher can be class teacher of any number of
//      classes, and a class can have multiple class teachers (toggles).
//   2. SUBJECT ASSIGNMENTS - subject x classes rows, e.g.
//      Amit Sir: Maths -> 5A, Maths -> 5B, Maths -> 6A.
//
// Writes are direct table inserts/deletes - RLS restricts them to
// admin/principal, and the same-school triggers in the DB reject any
// cross-school mix even if the client misbehaves.

import { useState, useEffect, useCallback, useMemo } from 'react'
import Link from 'next/link'
import { createClient } from '@/utils/supabase/client'
import { ArrowLeft, Plus, X, GraduationCap, BookOpen } from 'lucide-react'

interface TeacherItem {
  id: string
  full_name: string
  employee_id: string
  designation: string
  employment_status: string
}

interface ClassItem {
  id: string
  name: string
  section: string | null
}

interface SubjectItem {
  id: string
  name: string
  is_active: boolean
}

interface ClassTeacherRow {
  id: string
  class_id: string
  staff_id: string
}

interface SubjectAssignmentRow {
  id: string
  staff_id: string
  subject_id: string
  class_id: string
}

function sortClasses(classes: ClassItem[]): ClassItem[] {
  return [...classes].sort((a, b) => {
    const aNum = parseInt(a.name), bNum = parseInt(b.name)
    const aIsNum = !isNaN(aNum), bIsNum = !isNaN(bNum)
    if (aIsNum && bIsNum) {
      if (aNum !== bNum) return aNum - bNum
      return (a.section ?? '').localeCompare(b.section ?? '')
    }
    if (aIsNum) return -1
    if (bIsNum) return 1
    const n = a.name.localeCompare(b.name)
    return n !== 0 ? n : (a.section ?? '').localeCompare(b.section ?? '')
  })
}

function classLabel(c: ClassItem) {
  return `${c.name}${c.section ? ` - ${c.section}` : ''}`
}

export default function AssignmentsPage() {
  const [allowed, setAllowed]     = useState<boolean | null>(null)
  const [schoolId, setSchoolId]   = useState<string | null>(null)
  const [loading, setLoading]     = useState(true)

  const [teachers, setTeachers]   = useState<TeacherItem[]>([])
  const [classes, setClasses]     = useState<ClassItem[]>([])
  const [subjects, setSubjects]   = useState<SubjectItem[]>([])
  const [classTeachers, setClassTeachers]       = useState<ClassTeacherRow[]>([])
  const [subjectAssignments, setSubjectAssignments] = useState<SubjectAssignmentRow[]>([])

  const [selectedTeacher, setSelectedTeacher] = useState<string>('')

  // add-subject-assignment form state
  const [addSubject, setAddSubject]   = useState('')
  const [addClasses, setAddClasses]   = useState<string[]>([])
  const [saving, setSaving]           = useState(false)
  const [error, setError]             = useState('')
  const [busyKey, setBusyKey]         = useState('')

  const fetchAssignments = useCallback(async () => {
    const supabase = createClient()
    const [ctRes, saRes] = await Promise.all([
      supabase.from('class_teachers').select('id, class_id, staff_id'),
      supabase.from('subject_assignments').select('id, staff_id, subject_id, class_id'),
    ])
    setClassTeachers((ctRes.data ?? []) as ClassTeacherRow[])
    setSubjectAssignments((saRes.data ?? []) as SubjectAssignmentRow[])
  }, [])

  useEffect(() => {
    async function init() {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { setAllowed(false); setLoading(false); return }

      const { data: profile } = await supabase
        .from('profiles')
        .select('role, school_id')
        .eq('id', user.id)
        .single()

      const ok = profile?.role === 'school_admin' || profile?.role === 'principal'
      setAllowed(ok)
      setSchoolId(profile?.school_id ?? null)

      if (ok) {
        const [teachersRes, classesRes, subjectsRes] = await Promise.all([
          supabase
            .from('staff')
            .select('id, full_name, employee_id, designation, employment_status')
            .eq('is_teaching', true)
            .in('employment_status', ['active', 'probation', 'on_leave'])
            .order('full_name'),
          supabase.from('classes').select('id, name, section').order('name'),
          supabase.from('subjects').select('id, name, is_active').order('name'),
        ])

        const teacherRows = (teachersRes.data ?? []) as TeacherItem[]
        setTeachers(teacherRows)
        setClasses(sortClasses((classesRes.data ?? []) as ClassItem[]))
        setSubjects((subjectsRes.data ?? []) as SubjectItem[])
        if (teacherRows.length > 0) setSelectedTeacher(teacherRows[0].id)

        await fetchAssignments()
      }
      setLoading(false)
    }
    init()
  }, [fetchAssignments])

  // -- Derived data for the selected teacher ---------------------------------
  const classById   = useMemo(() => new Map(classes.map(c => [c.id, c])), [classes])
  const subjectById = useMemo(() => new Map(subjects.map(s => [s.id, s])), [subjects])

  const myClassTeacherRows = classTeachers.filter(ct => ct.staff_id === selectedTeacher)
  const myClassTeacherIds  = new Set(myClassTeacherRows.map(ct => ct.class_id))

  const myAssignments = subjectAssignments.filter(sa => sa.staff_id === selectedTeacher)

  // group my assignments by subject for display
  const mySubjectGroups = useMemo(() => {
    const groups: Record<string, SubjectAssignmentRow[]> = {}
    myAssignments.forEach(sa => {
      if (!groups[sa.subject_id]) groups[sa.subject_id] = []
      groups[sa.subject_id].push(sa)
    })
    return groups
  }, [myAssignments])

  const activeSubjects = subjects.filter(s => s.is_active)

  // classes still addable for the chosen subject in the add form
  const addableClasses = classes.filter(c =>
    !myAssignments.some(sa => sa.subject_id === addSubject && sa.class_id === c.id)
  )

  // -- Mutations --------------------------------------------------------------
  async function toggleClassTeacher(classId: string) {
    if (!schoolId || !selectedTeacher) return
    setBusyKey(`ct-${classId}`)
    setError('')
    const supabase = createClient()

    const existing = myClassTeacherRows.find(ct => ct.class_id === classId)
    if (existing) {
      const { error: delError } = await supabase
        .from('class_teachers').delete().eq('id', existing.id)
      if (delError) setError(delError.message)
    } else {
      const { error: insError } = await supabase.from('class_teachers').insert({
        school_id: schoolId,
        class_id: classId,
        staff_id: selectedTeacher,
      })
      if (insError && insError.code !== '23505') setError(insError.message)
    }
    await fetchAssignments()
    setBusyKey('')
  }

  async function addSubjectAssignments() {
    if (!schoolId || !selectedTeacher || !addSubject || addClasses.length === 0) return
    setSaving(true)
    setError('')
    const supabase = createClient()

    const rows = addClasses.map(classId => ({
      school_id: schoolId,
      staff_id: selectedTeacher,
      subject_id: addSubject,
      class_id: classId,
    }))

    const { error: insError } = await supabase.from('subject_assignments').insert(rows)
    if (insError && insError.code !== '23505') {
      setError(insError.message)
    } else {
      setAddClasses([])
    }
    await fetchAssignments()
    setSaving(false)
  }

  async function removeAssignment(id: string) {
    setBusyKey(`sa-${id}`)
    setError('')
    const supabase = createClient()
    const { error: delError } = await supabase
      .from('subject_assignments').delete().eq('id', id)
    if (delError) setError(delError.message)
    await fetchAssignments()
    setBusyKey('')
  }

  // -- Guards ------------------------------------------------------------------
  if (!loading && allowed === false) {
    return (
      <div className="max-w-2xl">
        <div className="card">
          <h1 className="text-lg font-semibold text-slate-900 mb-1">Teacher assignments</h1>
          <p className="text-sm text-slate-500">
            Only a school admin or principal can manage assignments.
          </p>
        </div>
      </div>
    )
  }

  const teacher = teachers.find(t => t.id === selectedTeacher)

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link
          href="/dashboard/staff"
          className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 transition-colors"
        >
          <ArrowLeft size={18} className="text-slate-600" />
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-slate-900">Teacher assignments</h1>
          <p className="text-slate-500 text-sm">Class teachers and subject allocations</p>
        </div>
        <Link href="/dashboard/staff/subjects" className="btn-secondary text-sm shrink-0">
          Manage subjects
        </Link>
      </div>

      {loading ? (
        <div className="grid lg:grid-cols-3 gap-5">
          <div className="card h-64 animate-pulse bg-slate-50" />
          <div className="lg:col-span-2 card h-64 animate-pulse bg-slate-50" />
        </div>
      ) : teachers.length === 0 ? (
        <div className="card flex flex-col items-center justify-center py-14 text-center">
          <div className="w-14 h-14 bg-slate-100 rounded-full flex items-center justify-center mb-4">
            <GraduationCap size={24} className="text-slate-400" />
          </div>
          <h3 className="font-semibold text-slate-900 mb-1">No teaching staff yet</h3>
          <p className="text-sm text-slate-500 mb-4">
            Add teachers first, then assign them classes and subjects here.
          </p>
          <Link href="/dashboard/staff/new" className="btn-primary text-sm">+ Add staff</Link>
        </div>
      ) : (
        <div className="grid lg:grid-cols-3 gap-5 items-start">

          {/* Teacher picker: dropdown on mobile, list on desktop */}
          <div className="lg:hidden">
            <label className="label">Teacher</label>
            <select className="input" value={selectedTeacher}
              onChange={e => { setSelectedTeacher(e.target.value); setAddSubject(''); setAddClasses([]) }}>
              {teachers.map(t => (
                <option key={t.id} value={t.id}>{t.full_name} ({t.employee_id})</option>
              ))}
            </select>
          </div>

          <div className="hidden lg:block bg-white rounded-xl border border-slate-100 shadow-sm overflow-hidden">
            {teachers.map(t => {
              const count =
                subjectAssignments.filter(sa => sa.staff_id === t.id).length +
                classTeachers.filter(ct => ct.staff_id === t.id).length
              const active = t.id === selectedTeacher
              return (
                <button
                  key={t.id}
                  onClick={() => { setSelectedTeacher(t.id); setAddSubject(''); setAddClasses([]) }}
                  className={`w-full text-left px-4 py-3 border-b border-slate-50 last:border-0 transition-colors ${
                    active ? 'bg-brand-50' : 'hover:bg-slate-50'
                  }`}
                >
                  <p className={`text-sm font-medium truncate ${active ? 'text-brand-700' : 'text-slate-800'}`}>
                    {t.full_name}
                  </p>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {t.designation} · {count} assignment{count !== 1 ? 's' : ''}
                  </p>
                </button>
              )
            })}
          </div>

          {/* Assignment panel */}
          <div className="lg:col-span-2 flex flex-col gap-5">

            {/* Class teacher */}
            <div className="card">
              <h2 className="font-semibold text-slate-800 mb-1">Class teacher</h2>
              <p className="text-xs text-slate-400 mb-3">
                Tap classes {teacher ? `${teacher.full_name} is` : 'this teacher is'} class teacher of.
                A class can have more than one class teacher.
              </p>
              {classes.length === 0 ? (
                <p className="text-sm text-slate-400">
                  No classes yet - create classes first.
                </p>
              ) : (
                <div className="flex gap-2 flex-wrap">
                  {classes.map(c => {
                    const on = myClassTeacherIds.has(c.id)
                    return (
                      <button
                        key={c.id}
                        onClick={() => toggleClassTeacher(c.id)}
                        disabled={busyKey === `ct-${c.id}`}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                          on
                            ? 'bg-brand-600 text-white border-brand-600'
                            : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                        }`}
                      >
                        {classLabel(c)}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Subject assignments */}
            <div className="card">
              <h2 className="font-semibold text-slate-800 mb-1">Subject assignments</h2>
              <p className="text-xs text-slate-400 mb-3">
                A teacher can teach any number of subjects across any classes.
              </p>

              {/* Existing, grouped by subject */}
              {Object.keys(mySubjectGroups).length > 0 ? (
                <div className="flex flex-col gap-3 mb-4">
                  {Object.entries(mySubjectGroups).map(([subjectId, rows]) => (
                    <div key={subjectId}>
                      <p className="text-xs font-medium text-slate-500 mb-1.5">
                        {subjectById.get(subjectId)?.name ?? 'Subject'}
                      </p>
                      <div className="flex gap-2 flex-wrap">
                        {rows.map(sa => {
                          const c = classById.get(sa.class_id)
                          return (
                            <span key={sa.id}
                              className="inline-flex items-center gap-1.5 bg-green-50 text-green-700 border border-green-200 rounded-lg px-2.5 py-1 text-xs font-medium">
                              {c ? classLabel(c) : 'Class'}
                              <button
                                onClick={() => removeAssignment(sa.id)}
                                disabled={busyKey === `sa-${sa.id}`}
                                className="text-green-500 hover:text-red-500"
                                aria-label="Remove assignment"
                              >
                                <X size={12} />
                              </button>
                            </span>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-slate-400 mb-4">No subjects assigned yet.</p>
              )}

              {/* Add new */}
              {activeSubjects.length === 0 ? (
                <div className="bg-slate-50 rounded-lg px-3 py-2.5 text-sm text-slate-500 flex items-center gap-2">
                  <BookOpen size={15} className="text-slate-400 shrink-0" />
                  <span>
                    No subjects in the catalogue yet.{' '}
                    <Link href="/dashboard/staff/subjects" className="text-brand-600 font-medium hover:underline">
                      Add subjects
                    </Link>{' '}first.
                  </span>
                </div>
              ) : (
                <div className="border-t border-slate-100 pt-4">
                  <p className="text-xs font-medium text-slate-500 mb-2">Add assignment</p>
                  <div className="flex flex-col gap-3">
                    <select
                      className="input"
                      value={addSubject}
                      onChange={e => { setAddSubject(e.target.value); setAddClasses([]) }}
                    >
                      <option value="">Select subject...</option>
                      {activeSubjects.map(s => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </select>

                    {addSubject && (
                      <>
                        {addableClasses.length === 0 ? (
                          <p className="text-xs text-slate-400">
                            This subject is already assigned to every class for this teacher.
                          </p>
                        ) : (
                          <div className="flex gap-2 flex-wrap">
                            {addableClasses.map(c => {
                              const on = addClasses.includes(c.id)
                              return (
                                <button
                                  key={c.id}
                                  type="button"
                                  onClick={() =>
                                    setAddClasses(prev =>
                                      on ? prev.filter(id => id !== c.id) : [...prev, c.id]
                                    )
                                  }
                                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                                    on
                                      ? 'bg-green-600 text-white border-green-600'
                                      : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                                  }`}
                                >
                                  {classLabel(c)}
                                </button>
                              )
                            })}
                          </div>
                        )}

                        <button
                          onClick={addSubjectAssignments}
                          disabled={saving || addClasses.length === 0}
                          className="btn-primary flex items-center justify-center gap-2 text-sm disabled:opacity-50 self-start px-5"
                        >
                          <Plus size={15} />
                          {saving
                            ? 'Adding...'
                            : `Add ${addClasses.length > 0 ? `${addClasses.length} ` : ''}assignment${addClasses.length !== 1 ? 's' : ''}`}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )}

              {error && (
                <p className="text-xs text-red-500 mt-3">{error}</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
