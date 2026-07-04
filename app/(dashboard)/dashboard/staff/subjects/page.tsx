'use client'

// FILE: app/(dashboard)/dashboard/staff/subjects/page.tsx
//
// Subject catalogue (chat17 Module 2). Admin/principal manage the
// per-school subject list that teacher assignments reference.
// RLS: whole school can read subjects; only admin/principal write.
// A subject with assignments cannot be deleted - deactivate instead
// (existing assignments keep working, it just leaves the picker).

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { createClient } from '@/utils/supabase/client'
import { ArrowLeft, Plus, BookOpen } from 'lucide-react'

interface SubjectRow {
  id: string
  name: string
  code: string | null
  is_active: boolean
  usage_count: number
}

export default function SubjectsPage() {
  const [allowed, setAllowed]   = useState<boolean | null>(null)
  const [schoolId, setSchoolId] = useState<string | null>(null)
  const [subjects, setSubjects] = useState<SubjectRow[]>([])
  const [loading, setLoading]   = useState(true)

  const [newName, setNewName]   = useState('')
  const [newCode, setNewCode]   = useState('')
  const [adding, setAdding]     = useState(false)
  const [error, setError]       = useState('')
  const [busyId, setBusyId]     = useState<string | null>(null)

  const fetchSubjects = useCallback(async () => {
    const supabase = createClient()
    const [subjectsRes, usageRes] = await Promise.all([
      supabase.from('subjects').select('id, name, code, is_active').order('name'),
      supabase.from('subject_assignments').select('subject_id'),
    ])

    const usage: Record<string, number> = {}
    ;(usageRes.data ?? []).forEach((r: { subject_id: string }) => {
      usage[r.subject_id] = (usage[r.subject_id] ?? 0) + 1
    })

    setSubjects(
      (subjectsRes.data ?? []).map((s: any) => ({
        ...s,
        usage_count: usage[s.id] ?? 0,
      })) as SubjectRow[]
    )
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
      if (ok) await fetchSubjects()
      setLoading(false)
    }
    init()
  }, [fetchSubjects])

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    const name = newName.trim()
    if (name.length < 2) { setError('Subject name is required'); return }
    if (!schoolId) return

    setAdding(true)
    setError('')

    const supabase = createClient()
    const { error: insertError } = await supabase.from('subjects').insert({
      school_id: schoolId,
      name,
      code: newCode.trim() || null,
    })

    if (insertError) {
      setError(
        insertError.code === '23505'
          ? 'A subject with this name already exists'
          : insertError.message
      )
    } else {
      setNewName('')
      setNewCode('')
      await fetchSubjects()
    }
    setAdding(false)
  }

  async function toggleActive(subject: SubjectRow) {
    setBusyId(subject.id)
    const supabase = createClient()
    await supabase
      .from('subjects')
      .update({ is_active: !subject.is_active })
      .eq('id', subject.id)
    await fetchSubjects()
    setBusyId(null)
  }

  async function handleDelete(subject: SubjectRow) {
    if (subject.usage_count > 0) return
    if (!window.confirm(`Delete subject "${subject.name}"?`)) return
    setBusyId(subject.id)
    const supabase = createClient()
    const { error: delError } = await supabase.from('subjects').delete().eq('id', subject.id)
    if (delError) setError(delError.message)
    await fetchSubjects()
    setBusyId(null)
  }

  if (!loading && allowed === false) {
    return (
      <div className="max-w-2xl">
        <div className="card">
          <h1 className="text-lg font-semibold text-slate-900 mb-1">Subjects</h1>
          <p className="text-sm text-slate-500">
            Only a school admin or principal can manage subjects.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link
          href="/dashboard/staff"
          className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 transition-colors"
        >
          <ArrowLeft size={18} className="text-slate-600" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Subjects</h1>
          <p className="text-slate-500 text-sm">The subject list teachers can be assigned to</p>
        </div>
      </div>

      {/* Add subject */}
      <form onSubmit={handleAdd} className="card flex flex-col gap-3 mb-5">
        <h2 className="font-semibold text-slate-800">Add subject</h2>
        <div className="flex gap-2 flex-col sm:flex-row">
          <input
            type="text" className="input flex-1" placeholder="e.g. Mathematics"
            value={newName} onChange={e => setNewName(e.target.value)}
          />
          <input
            type="text" className="input sm:w-32" placeholder="Code (opt.)"
            value={newCode} onChange={e => setNewCode(e.target.value)}
          />
          <button type="submit" className="btn-primary flex items-center justify-center gap-2 text-sm px-5"
            disabled={adding}>
            <Plus size={15} /> {adding ? 'Adding...' : 'Add'}
          </button>
        </div>
        {error && <p className="text-xs text-red-500">{error}</p>}
      </form>

      {/* List */}
      {loading ? (
        <div className="card flex flex-col gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-10 bg-slate-100 rounded-lg animate-pulse" />
          ))}
        </div>
      ) : subjects.length > 0 ? (
        <div className="bg-white rounded-xl border border-slate-100 shadow-sm overflow-hidden">
          {subjects.map(s => (
            <div key={s.id}
              className="flex items-center gap-3 px-4 py-3 border-b border-slate-50 last:border-0">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`font-medium text-sm ${s.is_active ? 'text-slate-900' : 'text-slate-400 line-through'}`}>
                    {s.name}
                  </span>
                  {s.code && (
                    <span className="font-mono text-[10px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded">
                      {s.code}
                    </span>
                  )}
                  {!s.is_active && <span className="badge-red">Inactive</span>}
                </div>
                <p className="text-xs text-slate-400 mt-0.5">
                  {s.usage_count > 0
                    ? `${s.usage_count} assignment${s.usage_count !== 1 ? 's' : ''}`
                    : 'Not assigned yet'}
                </p>
              </div>
              <button
                onClick={() => toggleActive(s)}
                disabled={busyId === s.id}
                className="text-xs font-medium text-slate-500 hover:text-slate-800 px-2 py-1 rounded hover:bg-slate-50"
              >
                {s.is_active ? 'Deactivate' : 'Activate'}
              </button>
              {s.usage_count === 0 && (
                <button
                  onClick={() => handleDelete(s)}
                  disabled={busyId === s.id}
                  className="text-xs font-medium text-red-500 hover:text-red-700 px-2 py-1 rounded hover:bg-red-50"
                >
                  Delete
                </button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="card flex flex-col items-center justify-center py-14 text-center">
          <div className="w-14 h-14 bg-slate-100 rounded-full flex items-center justify-center mb-4">
            <BookOpen size={24} className="text-slate-400" />
          </div>
          <h3 className="font-semibold text-slate-900 mb-1">No subjects yet</h3>
          <p className="text-sm text-slate-500">
            Add subjects like Mathematics, English, Science to assign teachers to them.
          </p>
        </div>
      )}
    </div>
  )
}
