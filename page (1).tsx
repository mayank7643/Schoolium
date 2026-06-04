'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/utils/supabase/client'

export default function SignupPage() {
  const router = useRouter()
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

    // 1. Create the school first
    const { data: school, error: schoolError } = await supabase
      .from('schools')
      .insert({
        name: form.schoolName,
        email: form.email,
        phone: form.phone,
        plan: 'basic',
      })
      .select()
      .single()

    if (schoolError) {
      setError(schoolError.message)
      setLoading(false)
      return
    }

    // 2. Sign up the user with school_id in metadata
    const { error: authError } = await supabase.auth.signUp({
      email: form.email,
      password: form.password,
      options: {
        data: {
          full_name: form.fullName,
          role: 'school_admin',
          school_id: school.id,
        },
      },
    })

    if (authError) {
      setError(authError.message)
      setLoading(false)
      return
    }

    // 3. Update the profile with school_id (trigger creates the profile row)
    const { data: { user } } = await supabase.auth.getUser()
    if (user) {
      await supabase
        .from('profiles')
        .update({ school_id: school.id, phone: form.phone })
        .eq('id', user.id)
    }

    router.push('/dashboard')
    router.refresh()
  }

  return (
    <main className="min-h-screen bg-slate-50 flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        {/* Logo */}
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
