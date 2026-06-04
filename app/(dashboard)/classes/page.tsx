'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/utils/supabase/client'
import { BookOpen, Plus, X, Trash2 } from 'lucide-react'
import type { Class } from '@/types'

export default function ClassesPage() {
  const [classes, setClasses] = useState<Class[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState({ name: '', section: '' })

  useEffect(() => {
    fetchClasses()
  }, [])

  async function fetchClasses() {
    const supabase = createClient()
    const { data } = await supabase
      .from('classes')
      .select('*')
      .order('name')
    setClasses(data ?? [])
    setLoading(false)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError('')

    const supabase = createClient()
    const { data: profile } = await supabase
      .from('profiles')
      .select('school_id')
      .single()

    const { error } = await supabase.from('classes').insert({
      name: form.name,
      section: form.section || null,
      school_id: profile?.school_id,
    })

    if (error) {
      setError(error.message)
      setSaving(false)
      return
    }

    setShowModal(false)
    setForm({ name: '', section: '' })
    fetchClasses()
    setSaving(false)
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this class? Students assigned to it will be unassigned.')) return
    const supabase = createClient()
    await supabase.from('classes').delete().eq('id', id)
    fetchClasses()
  }

  return (
    <div className="max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Classes</h1>
          <p className="text-slate-500 text-sm mt-1">{classes.length} classes</p>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="btn-primary flex items-center gap-2 text-sm"
        >
          <Plus size={16} />
          Add class
        </button>
      </div>

      {/* Classes grid */}
      {loading ? (
        <div className="card flex items-center justify-center py-16">
          <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : classes.length > 0 ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          {classes.map((cls) => (
            <div key={cls.id} className="card-sm flex items-center justify-between group">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 bg-purple-50 rounded-lg flex items-center justify-center shrink-0">
                  <BookOpen size={16} className="text-purple-600" />
                </div>
                <div>
                  <p className="font-medium text-slate-900 text-sm">{cls.name}</p>
                  {cls.section && (
                    <p className="text-xs text-slate-400">Section {cls.section}</p>
                  )}
                </div>
              </div>
              <button
                onClick={() => handleDelete(cls.id)}
                className="opacity-0 group-hover:opacity-100 w-7 h-7 flex items-center justify-center rounded-lg hover:bg-red-50 transition-all"
              >
                <Trash2 size={14} className="text-red-400" />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="card flex flex-col items-center justify-center py-16 text-center">
          <div className="w-14 h-14 bg-slate-100 rounded-full flex items-center justify-center mb-4">
            <BookOpen size={24} className="text-slate-400" />
          </div>
          <h3 className="font-semibold text-slate-900 mb-1">No classes yet</h3>
          <p className="text-sm text-slate-500 mb-4">Add your first class to assign students</p>
          <button onClick={() => setShowModal(true)} className="btn-primary text-sm">
            + Add class
          </button>
        </div>
      )}

      {/* Add Class Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm">
            <div className="flex items-center justify-between p-5 border-b border-slate-100">
              <h2 className="font-semibold text-slate-900">Add class</h2>
              <button
                onClick={() => setShowModal(false)}
                className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100"
              >
                <X size={18} className="text-slate-500" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="p-5 flex flex-col gap-4">
              <div>
                <label className="label">Class name *</label>
                <input
                  type="text"
                  className="input"
                  placeholder="e.g. Class 5, Grade 10, LKG"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  required
                />
              </div>
              <div>
                <label className="label">Section (optional)</label>
                <input
                  type="text"
                  className="input"
                  placeholder="e.g. A, B, C"
                  value={form.section}
                  onChange={(e) => setForm({ ...form, section: e.target.value })}
                />
              </div>

              {error && (
                <div className="bg-red-50 text-red-600 text-sm px-3 py-2 rounded-lg">{error}</div>
              )}

              <button type="submit" className="btn-primary w-full py-2.5" disabled={saving}>
                {saving ? 'Saving...' : 'Add class'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
