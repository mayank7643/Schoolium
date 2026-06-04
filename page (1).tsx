'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/utils/supabase/client'
import { ArrowLeft } from 'lucide-react'
import type { Class } from '@/types'

export default function NewStudentPage() {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [classes, setClasses] = useState<Class[]>([])
  const [form, setForm] = useState({
    full_name: '',
    date_of_birth: '',
    gender: '',
    class_id: '',
    aadhaar_number: '',
    address: '',
    parent_name: '',
    parent_phone: '',
    parent_email: '',
    admission_date: new Date().toISOString().split('T')[0],
  })

  useEffect(() => {
    async function fetchClasses() {
      const supabase = createClient()
      const { data } = await supabase
        .from('classes')
        .select('*')
        .order('name')
      setClasses(data ?? [])
    }
    fetchClasses()
  }, [])

  function handleChange(
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>
  ) {
    setForm({ ...form, [e.target.name]: e.target.value })
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')

    const supabase = createClient()

    const { data: profile } = await supabase
      .from('profiles')
      .select('school_id')
      .single()

    const { error } = await supabase.from('students').insert({
      ...form,
      school_id: profile?.school_id,
      class_id: form.class_id || null,
      date_of_birth: form.date_of_birth || null,
      gender: form.gender || null,
      aadhaar_number: form.aadhaar_number || null,
    })

    if (error) {
      setError(error.message)
      setLoading(false)
      return
    }

    router.push('/dashboard/students')
    router.refresh()
  }

  return (
    <div className="max-w-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <Link
          href="/dashboard/students"
          className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 transition-colors"
        >
          <ArrowLeft size={18} className="text-slate-600" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Add student</h1>
          <p className="text-slate-500 text-sm">Fill in the student details below</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        {/* Student info */}
        <div className="card flex flex-col gap-4">
          <h2 className="font-semibold text-slate-800">Student information</h2>

          <div>
            <label className="label">Full name *</label>
            <input
              name="full_name"
              type="text"
              className="input"
              placeholder="Rahul Sharma"
              value={form.full_name}
              onChange={handleChange}
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Date of birth</label>
              <input
                name="date_of_birth"
                type="date"
                className="input"
                value={form.date_of_birth}
                onChange={handleChange}
              />
            </div>
            <div>
              <label className="label">Gender</label>
              <select name="gender" className="input" value={form.gender} onChange={handleChange}>
                <option value="">Select</option>
                <option value="male">Male</option>
                <option value="female">Female</option>
                <option value="other">Other</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Class</label>
              <select name="class_id" className="input" value={form.class_id} onChange={handleChange}>
                <option value="">Select class</option>
                {classes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}{c.section ? ` - ${c.section}` : ''}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Admission date</label>
              <input
                name="admission_date"
                type="date"
                className="input"
                value={form.admission_date}
                onChange={handleChange}
              />
            </div>
          </div>

          <div>
            <label className="label">Aadhaar number</label>
            <input
              name="aadhaar_number"
              type="text"
              className="input"
              placeholder="XXXX XXXX XXXX"
              value={form.aadhaar_number}
              onChange={handleChange}
              maxLength={14}
            />
          </div>

          <div>
            <label className="label">Address</label>
            <textarea
              name="address"
              className="input resize-none"
              rows={2}
              placeholder="House no, street, city"
              value={form.address}
              onChange={handleChange}
            />
          </div>
        </div>

        {/* Parent info */}
        <div className="card flex flex-col gap-4">
          <h2 className="font-semibold text-slate-800">Parent / Guardian</h2>

          <div>
            <label className="label">Parent name</label>
            <input
              name="parent_name"
              type="text"
              className="input"
              placeholder="Suresh Sharma"
              value={form.parent_name}
              onChange={handleChange}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Phone</label>
              <input
                name="parent_phone"
                type="tel"
                className="input"
                placeholder="9876543210"
                value={form.parent_phone}
                onChange={handleChange}
              />
            </div>
            <div>
              <label className="label">Email</label>
              <input
                name="parent_email"
                type="email"
                className="input"
                placeholder="parent@email.com"
                value={form.parent_email}
                onChange={handleChange}
              />
            </div>
          </div>
        </div>

        {error && (
          <div className="bg-red-50 text-red-600 text-sm px-4 py-3 rounded-lg">
            {error}
          </div>
        )}

        <div className="flex gap-3">
          <button type="submit" className="btn-primary flex-1 py-2.5" disabled={loading}>
            {loading ? 'Saving...' : 'Save student'}
          </button>
          <Link href="/dashboard/students" className="btn-secondary px-6 py-2.5">
            Cancel
          </Link>
        </div>
      </form>
    </div>
  )
}
