'use client'

// FILE: app/(dashboard)/dashboard/staff/[id]/edit/page.tsx
//
// Edit a staff member's HR record (chat17). Direct UPDATE on staff -
// RLS restricts this to school_admin/principal of the same school.
// full_name and mobile sync to the profiles row via the
// trg_sync_staff_profile trigger (SECURITY DEFINER).
// Login email / password changes live on the detail page (StaffActions),
// role changes are deliberately not editable here (auth-level change).

import { useState, useEffect, useCallback } from 'react'
import { useRouter, useParams } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/utils/supabase/client'
import { ArrowLeft } from 'lucide-react'
import type { Staff } from '@/types'

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']
const DEPARTMENT_SUGGESTIONS = [
  'Teaching', 'Administration', 'Accounts', 'Library', 'Transport', 'Support',
]

export default function EditStaffPage() {
  const router = useRouter()
  const params = useParams<{ id: string }>()

  const [loading, setLoading] = useState(true)
  const [saving, setSaving]   = useState(false)
  const [error, setError]     = useState('')
  const [notFound, setNotFound] = useState(false)

  const [form, setForm] = useState({
    full_name: '',
    father_name: '',
    mobile: '',
    designation: '',
    department: '',
    is_teaching: false,
    date_of_birth: '',
    gender: '',
    blood_group: '',
    qualification: '',
    experience_years: '',
    joining_date: '',
    address: '',
  })

  const load = useCallback(async () => {
    const supabase = createClient()
    const { data } = await supabase
      .from('staff')
      .select('*')
      .eq('id', params.id)
      .maybeSingle()

    const staff = data as Staff | null
    if (!staff) { setNotFound(true); setLoading(false); return }

    setForm({
      full_name: staff.full_name,
      father_name: staff.father_name ?? '',
      mobile: staff.mobile,
      designation: staff.designation,
      department: staff.department,
      is_teaching: staff.is_teaching,
      date_of_birth: staff.date_of_birth ?? '',
      gender: staff.gender ?? '',
      blood_group: staff.blood_group ?? '',
      qualification: staff.qualification ?? '',
      experience_years: staff.experience_years ? String(staff.experience_years) : '',
      joining_date: staff.joining_date,
      address: staff.address ?? '',
    })
    setLoading(false)
  }, [params.id])

  useEffect(() => { load() }, [load])

  function handleChange(
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>
  ) {
    const { name, value } = e.target
    if (name === 'mobile') {
      setForm({ ...form, mobile: value.replace(/\D/g, '').slice(0, 10) })
      return
    }
    setForm({ ...form, [name]: value })
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (form.full_name.trim().length < 2) { setError('Full name is required'); return }
    if (form.mobile.length !== 10)        { setError('Mobile must be 10 digits'); return }
    if (!form.designation.trim())         { setError('Designation is required'); return }

    setSaving(true)
    setError('')

    const supabase = createClient()
    const { error: updateError } = await supabase
      .from('staff')
      .update({
        full_name: form.full_name.trim(),
        father_name: form.father_name.trim() || null,
        mobile: form.mobile,
        designation: form.designation.trim(),
        department: form.department.trim() || 'Teaching',
        is_teaching: form.is_teaching,
        date_of_birth: form.date_of_birth || null,
        gender: form.gender || null,
        blood_group: form.blood_group || null,
        qualification: form.qualification.trim() || null,
        experience_years: form.experience_years ? Number(form.experience_years) : 0,
        joining_date: form.joining_date,
        address: form.address.trim() || null,
      })
      .eq('id', params.id)

    if (updateError) {
      setError(updateError.message)
      setSaving(false)
      return
    }

    router.push(`/dashboard/staff/${params.id}`)
    router.refresh()
  }

  if (notFound) {
    return (
      <div className="max-w-2xl mx-auto">
        <div className="card">
          <h1 className="text-lg font-semibold text-slate-900 mb-1">Staff member not found</h1>
          <p className="text-sm text-slate-500 mb-4">
            This record does not exist or you do not have access to it.
          </p>
          <Link href="/dashboard/staff" className="btn-secondary text-sm inline-block">
            Back to staff
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link
          href={`/dashboard/staff/${params.id}`}
          className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 transition-colors"
        >
          <ArrowLeft size={18} className="text-slate-600" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Edit staff member</h1>
          <p className="text-slate-500 text-sm">Login email, password and role are managed from the profile page</p>
        </div>
      </div>

      {loading ? (
        <div className="card flex flex-col gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-9 bg-slate-100 rounded-lg animate-pulse" />
          ))}
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-5" noValidate>
          <div className="card flex flex-col gap-4">
            <h2 className="font-semibold text-slate-800">Personal information</h2>

            <div>
              <label className="label">Full name *</label>
              <input name="full_name" type="text" className="input"
                value={form.full_name} onChange={handleChange} required />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">Father&apos;s name</label>
                <input name="father_name" type="text" className="input"
                  value={form.father_name} onChange={handleChange} />
              </div>
              <div>
                <label className="label">Mobile *</label>
                <input name="mobile" type="tel" className="input"
                  value={form.mobile} onChange={handleChange} required />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">Date of birth</label>
                <input name="date_of_birth" type="date" className="input"
                  value={form.date_of_birth} onChange={handleChange}
                  max={new Date().toISOString().split('T')[0]} />
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
                <label className="label">Blood group</label>
                <select name="blood_group" className="input" value={form.blood_group} onChange={handleChange}>
                  <option value="">Select</option>
                  {BLOOD_GROUPS.map(bg => <option key={bg} value={bg}>{bg}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Qualification</label>
                <input name="qualification" type="text" className="input"
                  value={form.qualification} onChange={handleChange} />
              </div>
            </div>

            <div>
              <label className="label">Address</label>
              <textarea name="address" className="input" rows={2}
                value={form.address} onChange={handleChange} />
            </div>
          </div>

          <div className="card flex flex-col gap-4">
            <h2 className="font-semibold text-slate-800">Employment</h2>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">Designation *</label>
                <input name="designation" type="text" className="input"
                  value={form.designation} onChange={handleChange} required />
              </div>
              <div>
                <label className="label">Department</label>
                <input name="department" type="text" className="input" list="dept-suggestions"
                  value={form.department} onChange={handleChange} />
                <datalist id="dept-suggestions">
                  {DEPARTMENT_SUGGESTIONS.map(d => <option key={d} value={d} />)}
                </datalist>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">Joining date</label>
                <input name="joining_date" type="date" className="input"
                  value={form.joining_date} onChange={handleChange} />
              </div>
              <div>
                <label className="label">Experience (years)</label>
                <input name="experience_years" type="number" min="0" max="60" step="0.5" className="input"
                  value={form.experience_years} onChange={handleChange} />
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer select-none">
              <input type="checkbox" checked={form.is_teaching}
                onChange={e => setForm({ ...form, is_teaching: e.target.checked })}
                className="rounded border-slate-300" />
              Teaching staff
            </label>
          </div>

          {error && (
            <div className="bg-red-50 text-red-600 text-sm px-3 py-2 rounded-lg">{error}</div>
          )}

          <div className="flex gap-3">
            <button type="submit" className="btn-primary flex-1 py-2.5" disabled={saving}>
              {saving ? 'Saving...' : 'Save changes'}
            </button>
            <Link href={`/dashboard/staff/${params.id}`} className="btn-secondary py-2.5 px-6 text-center">
              Cancel
            </Link>
          </div>
        </form>
      )}
    </div>
  )
}
