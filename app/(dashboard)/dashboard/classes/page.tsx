'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/utils/supabase/client'
import { BookOpen, Plus, X, Trash2, Pencil } from 'lucide-react'
import type { Class } from '@/types'

// Sort classes: numerically first (1,2,3...10), then alphabetically (Graduation, LKG etc)
function sortClasses(classes: Class[]): Class[] {
  return [...classes].sort((a, b) => {
    const aNum = parseInt(a.name)
    const bNum = parseInt(b.name)
    const aIsNum = !isNaN(aNum)
    const bIsNum = !isNaN(bNum)
    if (aIsNum && bIsNum) {
      if (aNum !== bNum) return aNum - bNum
      // same number — sort by section
      return (a.section ?? '').localeCompare(b.section ?? '')
    }
    if (aIsNum) return -1 // numbers before words
    if (bIsNum) return 1
    // both alphabetic
    const nameCmp = a.name.localeCompare(b.name)
    if (nameCmp !== 0) return nameCmp
    return (a.section ?? '').localeCompare(b.section ?? '')
  })
}

export default function ClassesPage() {
  const [classes, setClasses] = useState<Class[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editingClass, setEditingClass] = useState<Class | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState({ name: '', section: '' })
  const [studentCounts, setStudentCounts] = useState<Record<string, number>>({})

  useEffect(() => { fetchClasses() }, [])

  async function fetchClasses() {
    const supabase = createClient()
    const [classesRes, studentsRes] = await Promise.all([
      supabase.from('classes').select('*'),
      supabase.from('students').select('class_id').eq('is_active', true),
    ])
    const sorted = sortClasses(classesRes.data ?? [])
    setClasses(sorted)

    // Count students per class
    const counts: Record<string, number> = {}
    studentsRes.data?.forEach(s => {
      if (s.class_id) counts[s.class_id] = (counts[s.class_id] ?? 0) + 1
    })
    setStudentCounts(counts)
    setLoading(false)
  }

  function openAdd() {
    setEditingClass(null)
    setForm({ name: '', section: '' })
    setError('')
    setShowModal(true)
  }

  function openEdit(cls: Class) {
    setEditingClass(cls)
    setForm({ name: cls.name, section: cls.section ?? '' })
    setError('')
    setShowModal(true)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.name.trim()) { setError('Class name is required'); return }
    setSaving(true); setError('')
    const supabase = createClient()

    if (editingClass) {
      const { error } = await supabase.from('classes').update({
        name: form.name.trim(),
        section: form.section.trim() || null,
      }).eq('id', editingClass.id)
      if (error) { setError(error.message); setSaving(false); return }
    } else {
      const { data: profile } = await supabase.from('profiles').select('school_id').single()
      const { error } = await supabase.from('classes').insert({
        name: form.name.trim(),
        section: form.section.trim() || null,
        school_id: profile?.school_id,
      })
      if (error) { setError(error.message); setSaving(false); return }
    }

    setShowModal(false)
    setForm({ name: '', section: '' })
    setEditingClass(null)
    fetchClasses()
    setSaving(false)
  }

  async function handleDelete(id: string, name: string) {
    const count = studentCounts[id] ?? 0
    const msg = count > 0
      ? `Delete class "${name}"? ${count} student${count > 1 ? 's' : ''} will be unassigned.`
      : `Delete class "${name}"?`
    if (!confirm(msg)) return
    const supabase = createClient()
    await supabase.from('classes').delete().eq('id', id)
    fetchClasses()
  }

  return (
    <div className="max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Classes</h1>
          <p className="text-slate-500 text-sm mt-1">{classes.length} classes</p>
        </div>
        <button onClick={openAdd} className="btn-primary flex items-center gap-2 text-sm">
          <Plus size={16} /> Add class
        </button>
      </div>

      {loading ? (
        <div className="grid grid-cols-3 gap-4">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="card h-20 animate-pulse bg-slate-50" />
          ))}
        </div>
      ) : classes.length > 0 ? (
        <div className="grid grid-cols-3 gap-4">
          {classes.map((cls) => (
            <div key={cls.id} className="card flex items-start justify-between gap-2 group">
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 bg-purple-50 rounded-lg flex items-center justify-center shrink-0 mt-0.5">
                  <BookOpen size={16} className="text-purple-600" />
                </div>
                <div>
                  <p className="font-semibold text-slate-900">{cls.name}</p>
                  {cls.section && <p className="text-xs text-slate-500">{cls.section}</p>}
                  <p className="text-xs text-slate-400 mt-0.5">
                    {studentCounts[cls.id] ?? 0} student{(studentCounts[cls.id] ?? 0) !== 1 ? 's' : ''}
                  </p>
                </div>
              </div>
              <div className="flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button onClick={() => openEdit(cls)}
                  className="w-6 h-6 flex items-center justify-center rounded text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors">
                  <Pencil size={12} />
                </button>
                <button onClick={() => handleDelete(cls.id, cls.name)}
                  className="w-6 h-6 flex items-center justify-center rounded text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors">
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="card flex flex-col items-center justify-center py-16 text-center">
          <div className="w-14 h-14 bg-slate-100 rounded-full flex items-center justify-center mb-4">
            <BookOpen size={24} className="text-slate-400" />
          </div>
          <h3 className="font-semibold text-slate-900 mb-1">No classes yet</h3>
          <p className="text-sm text-slate-500 mb-4">Add your first class to get started</p>
          <button onClick={openAdd} className="btn-primary text-sm">+ Add class</button>
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm">
            <div className="flex items-center justify-between p-5 border-b border-slate-100">
              <h2 className="font-semibold text-slate-900">{editingClass ? 'Edit class' : 'Add class'}</h2>
              <button onClick={() => setShowModal(false)} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100">
                <X size={18} className="text-slate-500" />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="p-5 flex flex-col gap-4">
              <div>
                <label className="label">Class name *</label>
                <input
                  type="text" className="input" placeholder="e.g. 5 or LKG or Graduation"
                  value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required
                />
                <p className="text-xs text-slate-400 mt-1">Use numbers for standard classes (1, 2 … 12)</p>
              </div>
              <div>
                <label className="label">Section (optional)</label>
                <input
                  type="text" className="input" placeholder="e.g. A, B, Science"
                  value={form.section} onChange={e => setForm({ ...form, section: e.target.value })}
                />
              </div>
              {error && <div className="bg-red-50 text-red-600 text-sm px-3 py-2 rounded-lg">{error}</div>}
              <button type="submit" className="btn-primary w-full py-2.5" disabled={saving}>
                {saving
                  ? <span className="flex items-center justify-center gap-2"><span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />{editingClass ? 'Saving...' : 'Adding...'}</span>
                  : editingClass ? 'Save changes' : 'Add class'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
