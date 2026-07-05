'use client'

// FILE: app/(dashboard)/dashboard/staff/new/page.tsx
//
// Add a staff member (chat17). Collects HR details + login credentials,
// POSTs to /api/staff/create (which creates the auth user and the staff
// record atomically, with rollback), then shows the credentials once so
// the admin can hand them over. Employee ID is auto-generated (EMP-NNNN).

import { useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Eye, EyeOff, CheckCircle2, Copy } from 'lucide-react'

const ROLE_OPTIONS = [
  { value: 'teacher',      label: 'Teacher',              defaultDesignation: 'Teacher',           defaultDept: 'Teaching' },
  { value: 'principal',    label: 'Principal',            defaultDesignation: 'Principal',         defaultDept: 'Administration' },
  { value: 'collector',    label: 'Accountant',           defaultDesignation: 'Accountant',        defaultDept: 'Accounts' },
  { value: 'receptionist', label: 'Receptionist',         defaultDesignation: 'Receptionist',      defaultDept: 'Administration' },
  { value: 'staff',        label: 'Other staff',          defaultDesignation: '',                  defaultDept: 'Support' },
] as const

const DESIGNATION_SUGGESTIONS = [
  'Teacher', 'Senior Teacher', 'Principal', 'Vice Principal', 'Accountant',
  'Receptionist', 'Librarian', 'Transport Manager', 'Lab Assistant',
  'Office Assistant', 'Peon', 'Cleaner', 'Driver',
]

const DEPARTMENT_SUGGESTIONS = [
  'Teaching', 'Administration', 'Accounts', 'Library', 'Transport', 'Support',
]

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']

export default function NewStaffPage() {
  const [loading, setLoading]           = useState(false)
  const [error, setError]               = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [success, setSuccess]           = useState<{
    employee_id: string
    staff_id: string
    email: string
    password: string
  } | null>(null)
  const [copied, setCopied] = useState(false)

  const [form, setForm] = useState({
    full_name: '',
    father_name: '',
    mobile: '',
    email: '',
    password: '',
    role: 'teacher',
    designation: 'Teacher',
    department: 'Teaching',
    is_teaching: true,
    date_of_birth: '',
    gender: '',
    blood_group: '',
    qualification: '',
    experience_years: '',
    joining_date: new Date().toISOString().split('T')[0],
    address: '',
  })

  function handleChange(
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>
  ) {
    const { name, value } = e.target
    if (name === 'mobile') {
      setForm({ ...form, mobile: value.replace(/\D/g, '').slice(0, 10) })
      return
    }
    if (name === 'role') {
      const opt = ROLE_OPTIONS.find(o => o.value === value)
      setForm({
        ...form,
        role: value,
        designation: opt?.defaultDesignation ?? form.designation,
        department: opt?.defaultDept ?? form.department,
        is_teaching: value === 'teacher',
      })
      return
    }
    setForm({ ...form, [name]: value })
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (form.full_name.trim().length < 2) { setError('Full name is required'); return }
    if (form.mobile.length !== 10)        { setError('Mobile must be 10 digits'); return }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) { setError('A valid email is required'); return }
    if (form.password.length < 8)         { setError('Password must be at least 8 characters'); return }
    if (!form.designation.trim())         { setError('Designation is required'); return }

    setLoading(true)
    setError('')

    try {
      const res = await fetch('/api/staff/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: form.email.trim(),
          password: form.password,
          role: form.role,
          full_name: form.full_name.trim(),
          mobile: form.mobile,
          designation: form.designation.trim(),
          department: form.department.trim() || 'Teaching',
          is_teaching: form.is_teaching,
          father_name: form.father_name || undefined,
          address: form.address || undefined,
          date_of_birth: form.date_of_birth || undefined,
          gender: form.gender || undefined,
          blood_group: form.blood_group || undefined,
          qualification: form.qualification || undefined,
          experience_years: form.experience_years ? Number(form.experience_years) : undefined,
          joining_date: form.joining_date || undefined,
        }),
      })

      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Failed to create staff member')
        setLoading(false)
        return
      }

      setSuccess({
        employee_id: data.employee_id,
        staff_id: data.staff_id,
        email: form.email.trim(),
        password: form.password,
      })
    } catch {
      setError('Network error - check your connection')
    }
    setLoading(false)
  }

  async function copyCredentials() {
    if (!success) return
    try {
      await navigator.clipboard.writeText(
        `Schoolium login\nEmail: ${success.email}\nPassword: ${success.password}\nEmployee ID: ${success.employee_id}`
      )
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // clipboard unavailable - the admin can copy manually
    }
  }

  // -- Success panel: credentials shown ONCE ---------------------------------
  if (success) {
    return (
      <div className="max-w-2xl mx-auto">
        <div className="card flex flex-col items-center text-center py-10">
          <div className="w-14 h-14 bg-green-50 rounded-full flex items-center justify-center mb-4">
            <CheckCircle2 size={28} className="text-green-600" />
          </div>
          <h1 className="text-xl font-bold text-slate-900 mb-1">Staff member added</h1>
          <p className="text-sm text-slate-500 mb-6">
            Employee ID <span className="font-mono font-medium text-slate-700">{success.employee_id}</span> was
            assigned. Share these login details now - the password is not shown again.
          </p>

          <div className="w-full max-w-sm bg-slate-50 rounded-xl border border-slate-100 p-4 text-left mb-5">
            <div className="mb-3">
              <p className="text-xs text-slate-400 mb-0.5">Email</p>
              <p className="font-mono text-sm text-slate-800 break-all">{success.email}</p>
            </div>
            <div>
              <p className="text-xs text-slate-400 mb-0.5">Password</p>
              <p className="font-mono text-sm text-slate-800">{success.password}</p>
            </div>
          </div>

          <div className="flex gap-3 flex-wrap justify-center">
            <button onClick={copyCredentials} className="btn-secondary flex items-center gap-2 text-sm">
              <Copy size={15} /> {copied ? 'Copied!' : 'Copy credentials'}
            </button>
            <Link href={`/dashboard/staff/${success.staff_id}`} className="btn-primary text-sm">
              View profile
            </Link>
            <Link href="/dashboard/staff/new" className="btn-secondary text-sm"
              onClick={() => { setSuccess(null); setForm(f => ({ ...f, full_name: '', father_name: '', mobile: '', email: '', password: '', qualification: '', experience_years: '', address: '', date_of_birth: '', gender: '', blood_group: '' })) }}>
              Add another
            </Link>
          </div>
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
          <h1 className="text-2xl font-bold text-slate-900">Add staff member</h1>
          <p className="text-slate-500 text-sm">Employee ID is auto-generated on save</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-5" noValidate>

        {/* Personal information */}
        <div className="card flex flex-col gap-4">
          <h2 className="font-semibold text-slate-800">Personal information</h2>

          <div>
            <label className="label">Full name *</label>
            <input name="full_name" type="text" className="input" placeholder="Amit Kumar"
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
              <input name="mobile" type="tel" className="input" placeholder="10-digit number"
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
              <input name="qualification" type="text" className="input" placeholder="M.Sc, B.Ed"
                value={form.qualification} onChange={handleChange} />
            </div>
          </div>

          <div>
            <label className="label">Address</label>
            <textarea name="address" className="input" rows={2}
              value={form.address} onChange={handleChange} />
          </div>
        </div>

        {/* Employment */}
        <div className="card flex flex-col gap-4">
          <h2 className="font-semibold text-slate-800">Employment</h2>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Role *</label>
              <select name="role" className="input" value={form.role} onChange={handleChange}>
                {ROLE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <p className="text-xs text-slate-400 mt-1">Controls what they can access after login</p>
            </div>
            <div>
              <label className="label">Designation *</label>
              <input name="designation" type="text" className="input" list="designation-suggestions"
                placeholder="e.g. Librarian" value={form.designation} onChange={handleChange} required />
              <datalist id="designation-suggestions">
                {DESIGNATION_SUGGESTIONS.map(d => <option key={d} value={d} />)}
              </datalist>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Department</label>
              <input name="department" type="text" className="input" list="department-suggestions"
                value={form.department} onChange={handleChange} />
              <datalist id="department-suggestions">
                {DEPARTMENT_SUGGESTIONS.map(d => <option key={d} value={d} />)}
              </datalist>
            </div>
            <div>
              <label className="label">Joining date</label>
              <input name="joining_date" type="date" className="input"
                value={form.joining_date} onChange={handleChange} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Experience (years)</label>
              <input name="experience_years" type="number" min="0" max="60" step="0.5" className="input"
                value={form.experience_years} onChange={handleChange} />
            </div>
            <div className="flex items-end pb-2">
              <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer select-none">
                <input type="checkbox" checked={form.is_teaching}
                  onChange={e => setForm({ ...form, is_teaching: e.target.checked })}
                  className="rounded border-slate-300" />
                Teaching staff
              </label>
            </div>
          </div>
        </div>

        {/* Login account */}
        <div className="card flex flex-col gap-4">
          <h2 className="font-semibold text-slate-800">Login account</h2>
          <p className="text-xs text-slate-400 -mt-2">
            They sign in at the same login page with these credentials.
          </p>

          <div>
            <label className="label">Email *</label>
            <input name="email" type="email" className="input" placeholder="amit@school.com"
              value={form.email} onChange={handleChange} required autoComplete="off" />
          </div>

          <div>
            <label className="label">Password *</label>
            <div className="relative">
              <input name="password" type={showPassword ? 'text' : 'password'} className="input pr-10"
                placeholder="At least 8 characters" value={form.password} onChange={handleChange}
                required autoComplete="new-password" />
              <button type="button" onClick={() => setShowPassword(v => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>
        </div>

        {error && (
          <div className="bg-red-50 text-red-600 text-sm px-3 py-2 rounded-lg">{error}</div>
        )}

        <div className="flex gap-3">
          <button type="submit" className="btn-primary flex-1 py-2.5" disabled={loading}>
            {loading ? 'Creating...' : 'Create staff member'}
          </button>
          <Link href="/dashboard/staff" className="btn-secondary py-2.5 px-6 text-center">
            Cancel
          </Link>
        </div>
      </form>
    </div>
  )
}
