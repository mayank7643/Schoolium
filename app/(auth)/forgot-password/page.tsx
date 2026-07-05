'use client'

// FILE: app/(auth)/forgot-password/page.tsx
// Sends a Supabase password-recovery email. The link in the email goes
// through /auth/callback which exchanges the code for a session and then
// lands the user on /reset-password to set a new password.

import { useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/utils/supabase/client'

export default function ForgotPasswordPage() {
  const [email,   setEmail]   = useState('')
  const [error,   setError]   = useState('')
  const [sent,    setSent]    = useState(false)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')

    const supabase = createClient()
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
    })

    if (resetError) {
      setError(resetError.message)
      setLoading(false)
      return
    }

    setSent(true)
    setLoading(false)
  }

  return (
    <main className="min-h-screen bg-slate-50 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-2 mb-8">
          <div className="w-9 h-9 bg-brand-600 rounded-lg flex items-center justify-center">
            <span className="text-white font-bold">S</span>
          </div>
          <span className="font-semibold text-slate-900 text-xl">Schoolium</span>
        </div>

        <div className="card">
          <h1 className="text-xl font-semibold text-slate-900 mb-1">Reset password</h1>
          <p className="text-sm text-slate-500 mb-6">
            Enter your email and we&apos;ll send you a link to reset your password.
          </p>

          {sent ? (
            <div className="bg-green-50 text-green-700 text-sm px-3 py-2 rounded-lg">
              If an account exists for <span className="font-medium">{email}</span>,
              a password reset link has been sent. Check your inbox.
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div>
                <label className="label">Email</label>
                <input type="email" className="input" placeholder="your@email.com"
                  value={email} onChange={e => setEmail(e.target.value)}
                  required autoComplete="email" />
              </div>

              {error && (
                <div className="bg-red-50 text-red-600 text-sm px-3 py-2 rounded-lg">{error}</div>
              )}

              <button type="submit" className="btn-primary w-full py-2.5 mt-1" disabled={loading}>
                {loading ? 'Sending...' : 'Send reset link'}
              </button>
            </form>
          )}
        </div>

        <p className="text-center text-sm text-slate-500 mt-4">
          Remember your password?{' '}
          <Link href="/login" className="text-brand-600 font-medium hover:underline">Sign in</Link>
        </p>
      </div>
    </main>
  )
}
