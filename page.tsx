'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/utils/supabase/client'

type Step = 'form' | 'success'

export default function SignupPage() {
  const router = useRouter()
  const [step, setStep] = useState<Step>('form')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState({
    fullName: '',
    schoolName: '',
    email: '',
    phone: '',
    password: '',
  })

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    setForm({ ...form, [e.target.name]: e.target.value })
  }

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')

    const supabase = createClient()

    // Step 1: Create auth user
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

    // Step 2: Use security definer function to create school + link profile
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

    // Done — show success then redirect
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
          <h2 className="text-xl font-semibold text-slate-900 mb-2">Account created</h2>
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

          <form onSubmit={handleSignup} className="flex flex-col gap-4">
            <div>
              <label className="label">Your full name</label>
              <input
                name="fullName"
                type="text"
                className="input"
                placeholder="Rajesh Kumar"
                value={form.fullName}
                onChange={handleChange}
                required
              />
            </div>

            <div>
              <label className="label">School name</label>
              <input
                name="schoolName"
                type="text"
                className="input"
                placeholder="Sunrise Public School"
                value={form.schoolName}
                onChange={handleChange}
                required
              />
            </div>

            <div>
              <label className="label">Email</label>
              <input
                name="email"
                type="email"
                className="input"
                placeholder="principal@school.com"
                value={form.email}
                onChange={handleChange}
                required
              />
            </div>

            <div>
              <label className="label">Phone</label>
              <input
                name="phone"
                type="tel"
                className="input"
                placeholder="9876543210"
                value={form.phone}
                onChange={handleChange}
              />
            </div>

            <div>
              <label className="label">Password</label>
              <input
                name="password"
                type="password"
                className="input"
                placeholder="Min. 8 characters"
                value={form.password}
                onChange={handleChange}
                required
                minLength={8}
              />
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
