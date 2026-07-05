'use client'

// FILE: app/(auth)/reset-password/page.tsx
// Landing page for the password-recovery email link. The user arrives
// here already holding a recovery session (created by /auth/callback),
// so we just let them set a new password via updateUser.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/utils/supabase/client'

export default function ResetPasswordPage() {
  const router = useRouter()
  const [password,        setPassword]        = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error,           setError]           = useState('')
  const [loading,         setLoading]         = useState(false)
  const [hasSession,      setHasSession]      = useState<boolean | null>(null)

  // The recovery link is single-use and expires — without a session,
  // updateUser would fail, so show the "request a new link" state instead.
  useEffect(() => {
    const supabase = createClient()
    supabase.auth.getSession().then(({ data: { session } }) => {
      setHasSession(!!session)
    })
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')

    if (password.length < 6) {
      setError('Password must be at least 6 characters.')
      return
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    setLoading(true)
    const supabase = createClient()
    const { error: updateError } = await supabase.auth.updateUser({ password })

    if (updateError) {
      setError(updateError.message)
      setLoading(false)
      return
    }

    // Middleware sends each role to its own home from /login
    router.push('/login')
    router.refresh()
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
          <h1 className="text-xl font-semibold text-slate-900 mb-1">Set new password</h1>
          <p className="text-sm text-slate-500 mb-6">Choose a new password for your account</p>

          {hasSession === false ? (
            <div className="flex flex-col gap-4">
              <div className="bg-red-50 text-red-600 text-sm px-3 py-2 rounded-lg">
                This reset link is invalid or has expired.
              </div>
              <Link href="/forgot-password" className="btn-primary w-full py-2.5 text-center">
                Request a new link
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div>
                <label className="label">New password</label>
                <input type="password" className="input" placeholder="••••••••"
                  value={password} onChange={e => setPassword(e.target.value)}
                  required autoComplete="new-password" minLength={6} />
              </div>
              <div>
                <label className="label">Confirm new password</label>
                <input type="password" className="input" placeholder="••••••••"
                  value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)}
                  required autoComplete="new-password" minLength={6} />
              </div>

              {error && (
                <div className="bg-red-50 text-red-600 text-sm px-3 py-2 rounded-lg">{error}</div>
              )}

              <button type="submit" className="btn-primary w-full py-2.5 mt-1"
                disabled={loading || hasSession === null}>
                {loading ? 'Updating...' : 'Update password'}
              </button>
            </form>
          )}
        </div>
      </div>
    </main>
  )
}
