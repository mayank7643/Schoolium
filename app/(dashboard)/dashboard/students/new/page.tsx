'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/utils/supabase/client'
import { ArrowLeft, Eye, EyeOff } from 'lucide-react'
import type { Class } from '@/types'

function formatAadhaar(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 12)
  return digits.replace(/(\d{4})(?=\d)/g, '$1 ').trim()
}

function getMaskedAadhaar(value: string): string {
  const digits = value.replace(/\s/g, '')
  if (digits.length <= 4) return value
  return 'XXXX XXXX ' + digits.slice(8, 12)
}

export default function NewStudentPage() {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [classes, setClasses] = useState<Class[]>([])
  const [showAadhaar, setShowAadhaar] = useState(false)
  const [form, setForm] = useState({
    full_name: '',
    father_name: '',
    mother_name: '',
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
      const { data } = await supabase.from('classes').select('*').order('name')
      setClasses(data ?? [])
    }
    fetchClasses()
  }, [])

  function handleChange(
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>
  ) {
    const { name, value } = e.target

    if (name === 'parent_phone') {
      const digits = value.replace(/\D/g, '').slice(0, 10)
      setForm({ ...form, parent_phone: digits })
      if (fieldErrors.parent_phone) setFieldErrors({ ...fieldErrors, parent_phone: '' })
      return
    }
    if (name === 'aadhaar_number') {
      const formatted = formatAadhaar(value)
      setForm({ ...form, aadhaar_number: formatted })
      if (fieldErrors.aadhaar_number) setFieldErrors({ ...fieldErrors, aadhaar_number: '' })
      return
    }
    setForm({ ...form, [name]: value })
    if (fieldErrors[name]) setFieldErrors({ ...fieldErrors, [name]: '' })
  }

  function validateField(name: string, value: string) {
    let msg = ''
    if (name === 'full_name' && value.trim().length < 2) msg = 'At least 2 characters'
    if (name === 'parent_phone' && value && value.length !== 10) msg = 'Must be 10 digits'
    if (name === 'aadhaar_number') {
      const digits = value.replace(/\s/g, '')
      if (digits && digits.length !== 12) msg = 'Must be exactly 12 digits'
    }
    setFieldErrors((prev) => ({ ...prev, [name]: msg }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (form.full_name.trim().length < 2) {
      setError('Student name is required')
      return
    }
    if (form.parent_phone && form.parent_phone.length !== 10) {
      setError('Parent phone must be 10 digits')
      return
    }
    const aadhaarDigits = form.aadhaar_number.replace(/\s/g, '')
    if (aadhaarDigits && aadhaarDigits.length !== 12) {
      setError('Aadhaar number must be 12 digits')
      return
    }

    setLoading(true)
    setError('')
    const supabase = createClient()

    // Check Aadhaar uniqueness
    if (aadhaarDigits) {
      const { data: existing } = await supabase
        .from('students')
        .select('id')
        .eq('aadhaar_number', aadhaarDigits)
        .maybeSingle()
      if (existing) {
        setError('A student with this Aadhaar number already exists')
        setLoading(false)
        return
      }
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('school_id')
      .single()

    const schoolId = profile?.school_id

    // Generate student UID atomically via DB function
    const { data: uidData, error: uidError } = await supabase
      .rpc('generate_student_uid', { p_school_id: schoolId })

    if (uidError) {
      setError('Failed to generate student ID: ' + uidError.message)
      setLoading(false)
      return
    }

    const { error: insertError } = await supabase.from('students').insert({
      full_name: form.full_name,
      father_name: form.father_name || null,
      mother_name: form.mother_name || null,
      date_of_birth: form.date_of_birth || null,
      gender: form.gender || null,
      class_id: form.class_id || null,
      aadhaar_number: aadhaarDigits || null,
      address: form.address || null,
      parent_name: form.father_name || form.parent_name || null,
      parent_phone: form.parent_phone || null,
      parent_email: form.parent_email || null,
      admission_date: form.admission_date,
      school_id: schoolId,
      student_uid: uidData,
    })

    if (insertError) {
      setError(insertError.message)
      setLoading(false)
      return
    }

    router.push('/dashboard/students')
    router.refresh()
  }

  return (
    <div className="max-w-2xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link
          href="/dashboard/students"
          className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 transition-colors"
        >
          <ArrowLeft size={18} className="text-slate-600" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Add student</h1>
          <p className="text-slate-500 text-sm">Student ID will be auto-generated on save</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-5" noValidate>

        {/* Student info */}
        <div className="card flex flex-col gap-4">
          <h2 className="font-semibold text-slate-800">Student information</h2>

          <div>
            <label className="label">Full name *</label>
            <input
              name="full_name" type="text" className={`input ${fieldErrors.full_name ? 'border-red-400' : ''}`}
              placeholder="Rahul Sharma" value={form.full_name} onChange={handleChange}
              onBlur={(e) => validateField('full_name', e.target.value)} required
            />
            {fieldErrors.full_name && <p className="text-xs text-red-500 mt-1">{fieldErrors.full_name}</p>}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Date of birth</label>
              <input
                name="date_of_birth" type="date" className="input"
                value={form.date_of_birth} onChange={handleChange}
                max={new Date().toISOString().split('T')[0]}
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
                name="admission_date" type="date" className="input"
                value={form.admission_date} onChange={handleChange}
              />
            </div>
          </div>

          {/* Aadhaar with mask */}
          <div>
            <label className="label">Aadhaar number</label>
            <div className="relative">
              <input
                name="aadhaar_number" type="text" inputMode="numeric"
                className={`input pr-10 ${fieldErrors.aadhaar_number ? 'border-red-400' : ''}`}
                placeholder="XXXX XXXX XXXX"
                value={showAadhaar ? form.aadhaar_number : (form.aadhaar_number ? getMaskedAadhaar(form.aadhaar_number) : '')}
                onChange={handleChange}
                onFocus={() => setShowAadhaar(true)}
                onBlur={(e) => { setShowAadhaar(false); validateField('aadhaar_number', e.target.value) }}
                maxLength={14}
              />
              <button type="button"
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                onClick={() => setShowAadhaar(!showAadhaar)}
              >
                {showAadhaar ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            <p className="text-xs text-slate-400 mt-1">12 digits · unique · masked for privacy</p>
            {fieldErrors.aadhaar_number && <p className="text-xs text-red-500">{fieldErrors.aadhaar_number}</p>}
          </div>

          <div>
            <label className="label">Address</label>
            <textarea
              name="address" className="input resize-none" rows={2}
              placeholder="House no, street, city" value={form.address} onChange={handleChange}
            />
          </div>
        </div>

        {/* Parent info */}
        <div className="card flex flex-col gap-4">
          <h2 className="font-semibold text-slate-800">Parent / Guardian</h2>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Father's name</label>
              <input
                name="father_name" type="text" className="input"
                placeholder="Suresh Sharma" value={form.father_name} onChange={handleChange}
              />
            </div>
            <div>
              <label className="label">Mother's name</label>
              <input
                name="mother_name" type="text" className="input"
                placeholder="Sunita Sharma" value={form.mother_name} onChange={handleChange}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Phone</label>
              <input
                name="parent_phone" type="tel" inputMode="numeric" pattern="[0-9]{10}"
                className={`input ${fieldErrors.parent_phone ? 'border-red-400' : ''}`}
                placeholder="9876543210" value={form.parent_phone} onChange={handleChange}
                onBlur={(e) => validateField('parent_phone', e.target.value)} maxLength={10}
              />
              <p className="text-xs text-slate-400 mt-1">{form.parent_phone.length}/10</p>
              {fieldErrors.parent_phone && <p className="text-xs text-red-500">{fieldErrors.parent_phone}</p>}
            </div>
            <div>
              <label className="label">Email</label>
              <input
                name="parent_email" type="email" inputMode="email" className="input"
                placeholder="parent@email.com" value={form.parent_email} onChange={handleChange}
              />
            </div>
          </div>
        </div>

        {error && (
          <div className="bg-red-50 text-red-600 text-sm px-4 py-3 rounded-lg">{error}</div>
        )}

        <div className="flex gap-3">
          <button type="submit" className="btn-primary flex-1 py-2.5" disabled={loading}>
            {loading
              ? <span className="flex items-center justify-center gap-2">
                  <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Saving...
                </span>
              : 'Save student'}
          </button>
          <Link href="/dashboard/students" className="btn-secondary px-6 py-2.5">Cancel</Link>
        </div>
      </form>
    </div>
  )
}
