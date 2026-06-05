'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/utils/supabase/client'

type Step = 'form' | 'success'

function validateSignupForm(form: {
  fullName: string
  schoolName: string
  email: string
  phone: string
  password: string
}): string | null {
  if (form.fullName.trim().length < 3) return 'Full name must be at least 3 characters'
  if (!/^[a-zA-Z\s]+$/.test(form.fullName.trim())) return 'Full name should only contain letters'
  if (form.schoolName.trim().length < 3) return 'School name must be at least 3 characters'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) return 'Enter a valid email address'
  if (!/^\d{10}$/.test(form.phone)) return 'Phone number must be exactly 10 digits'
  if (form.password.length < 8) return 'Password must be at least 8 characters'
  if (!/(?=.*[A-Z])(?=.*\d)/.test(form.password)) return 'Password must include at least one uppercase letter and one number'
  return null
}

export default function SignupPage() {
  const router = useRouter()
  const [step, setStep] = useState<Step>('form')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [form, setForm] = useState({
    fullName: '',
    schoolName: '',
    email: '',
    phone: '',
    password: '',
  })

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const { name, value } = e.target

    // Phone: only allow digits, max 10
    if (name === 'phone') {
      const digits = value.replace(/\D/g, '').slice(0, 10)
      setForm({ ...form, phone: digits })
      if (fieldErrors.phone) setFieldErrors({ ...fieldErrors, phone: '' })
      return
    }

    setForm({ ...form, [name]: value })
    if (fieldErrors[name]) setFieldErrors({ ...fieldErrors, [name]: '' })
  }

  function validateField(name: string, value: string) {
    let msg = ''
    if (name === 'fullName') {
      if (value.trim().length < 3) msg = 'At least 3 characters'
      else if (!/^[a-zA-Z\s]+$/.test(value.trim())) msg = 'Letters only'
    }
    if (name === 'schoolName' && value.trim().length < 3) msg = 'At least 3 characters'
    if (name === 'email' && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) msg = 'Invalid email'
    if (name === 'phone' && value && value.length !== 10) msg = 'Must be 10 digits'
    if (name === 'password') {
      if (value.length < 8) msg = 'At least 8 characters'
      else if (!/(?=.*[A-Z])(?=.*\d)/.test(value)) msg = 'Needs 1 uppercase + 1 number'
    }
    setFieldErrors((prev) => ({ ...prev, [name]: msg }))
  }

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault()
    setError('')

    const validationError = validateSignupForm(form)
    if (validationError) {
      setError(validationError)
      return
    }

    setLoading(true)
    const supabase = createClient()

    const { data: authData, error: authError } = await supabase.auth.signUp({
      email: form.email,
      password: form.password,
      options: {
        data: {
          full_name: form.fullName,
          role: 'school_admin',
        },
      },
    })

    if (authError || !authData.user) {
      setError(authError?.message ?? 'Signup failed. Try again.')
      setLoading(false)
      return
    }

    const { error: fnError } = await supabase.rpc('create_school_for_user', {
      school_name: form.schoolName,
      school_email: form.email,
      school_phone: form.phone,
    })

    if (fnError) {
      setError(fnError.message)
      setLoading(false)
      return
    }

    setStep('success')
    setTimeout(() => {
      router.push('/dashboard')
      router.refresh()
    }, 2000)
  }

  if (step === 'success') {
    return (
      <main className="min-h-screen bg-slate-50 flex items-center justify-center px-4">
        <div className="w-full max-w-sm text-center">
          <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-slate-900 mb-2">Account created!</h2>
          <p className="text-slate-500 text-sm">Taking you to your dashboard...</p>
        </div>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-slate-50 flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-2 mb-8">
          <div className="w-9 h-9 bg-brand-600 rounded-lg flex items-center justify-center">
            <span className="text-white font-bold">S</span>
          </div>
          <span className="font-semibold text-slate-900 text-xl">Schoolium</span>
        </div>

        <div className="card">
          <h1 className="text-xl font-semibold text-slate-900 mb-1">Create your account</h1>
          <p className="text-sm text-slate-500 mb-6">Set up Schoolium for your school</p>

          <form onSubmit={handleSignup} className="flex flex-col gap-4" noValidate>
            <div>
              <label className="label">Your full name *</label>
              <input
                name="fullName"
                type="text"
                className={`input ${fieldErrors.fullName ? 'border-red-400' : ''}`}
                placeholder="Rajesh Kumar"
                value={form.fullName}
                onChange={handleChange}
                onBlur={(e) => validateField('fullName', e.target.value)}
                autoComplete="name"
                required
              />
              {fieldErrors.fullName && <p className="text-xs text-red-500 mt-1">{fieldErrors.fullName}</p>}
            </div>

            <div>
              <label className="label">School name *</label>
              <input
                name="schoolName"
                type="text"
                className={`input ${fieldErrors.schoolName ? 'border-red-400' : ''}`}
                placeholder="Sunrise Public School"
                value={form.schoolName}
                onChange={handleChange}
                onBlur={(e) => validateField('schoolName', e.target.value)}
                required
              />
              {fieldErrors.schoolName && <p className="text-xs text-red-500 mt-1">{fieldErrors.schoolName}</p>}
            </div>

            <div>
              <label className="label">School email *</label>
              <input
                name="email"
                type="email"
                inputMode="email"
                className={`input ${fieldErrors.email ? 'border-red-400' : ''}`}
                placeholder="principal@school.com"
                value={form.email}
                onChange={handleChange}
                onBlur={(e) => validateField('email', e.target.value)}
                autoComplete="email"
                required
              />
              {fieldErrors.email && <p className="text-xs text-red-500 mt-1">{fieldErrors.email}</p>}
            </div>

            <div>
              <label className="label">Phone number *</label>
              <input
                name="phone"
                type="tel"
                inputMode="numeric"
                pattern="[0-9]{10}"
                className={`input ${fieldErrors.phone ? 'border-red-400' : ''}`}
                placeholder="9876543210"
                value={form.phone}
                onChange={handleChange}
                onBlur={(e) => validateField('phone', e.target.value)}
                maxLength={10}
                required
              />
              <p className="text-xs text-slate-400 mt-1">{form.phone.length}/10 digits</p>
              {fieldErrors.phone && <p className="text-xs text-red-500">{fieldErrors.phone}</p>}
            </div>

            <div>
              <label className="label">Password *</label>
              <input
                name="password"
                type="password"
                className={`input ${fieldErrors.password ? 'border-red-400' : ''}`}
                placeholder="Min. 8 chars, 1 uppercase, 1 number"
                value={form.password}
                onChange={handleChange}
                onBlur={(e) => validateField('password', e.target.value)}
                autoComplete="new-password"
                required
                minLength={8}
              />
              {fieldErrors.password && <p className="text-xs text-red-500 mt-1">{fieldErrors.password}</p>}
            </div>

            {error && (
              <div className="bg-red-50 text-red-600 text-sm px-3 py-2 rounded-lg">
                {error}
              </div>
            )}

            <button
              type="submit"
              className="btn-primary w-full py-2.5 mt-1"
              disabled={loading}
            >
              {loading ? 'Creating account...' : 'Create account'}
            </button>
          </form>
        </div>

        <p className="text-center text-sm text-slate-500 mt-4">
          Already have an account?{' '}
          <Link href="/login" className="text-brand-600 font-medium hover:underline">
            Sign in
          </Link>
        </p>
        <p className="text-center text-xs text-slate-400 mt-3">
          ₹299/month · Cancel anytime
        </p>
      </div>
    </main>
  )
}
