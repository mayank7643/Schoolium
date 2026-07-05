'use client'

// FILE: app/(auth)/forgot-password/page.tsx
// OTP-based password reset.
//   Step 1 (email): confirm an account exists (rate-limited email_exists
//     RPC) - if not, tell the user - then send a recovery email carrying
//     a 6-digit code (and a fallback link).
//   Step 2 (otp): the user types the code + a new password; verifyOtp
//     (type:'recovery') mints a recovery session, then updateUser sets
//     the password.
// The email link still works: it lands on /reset-password via
// /auth/callback for users who prefer clicking.

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/utils/supabase/client'
import { useCooldown } from '@/utils/useCooldown'

type Step = 'email' | 'otp' | 'done'

export default function ForgotPasswordPage() {
  const router = useRouter()
  const [step,            setStep]            = useState<Step>('email')
  const [email,           setEmail]           = useState('')
  const [token,           setToken]           = useState('')
  const [password,        setPassword]        = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error,           setError]           = useState('')
  const [loading,         setLoading]         = useState(false)
  const cooldown = useCooldown(45)

  async function sendCode(e?: React.FormEvent) {
    e?.preventDefault()
    setError('')
    setLoading(true)
    const supabase = createClient()

    // 1) Does an account exist? (rate-limited server-side)
    const { data: exists, error: rpcError } = await supabase.rpc('email_exists', {
      p_email: email,
    })
    if (rpcError) {
      setError(rpcError.message === 'rate_limited'
        ? 'Too many attempts. Please wait a minute and try again.'
        : 'Something went wrong. Please try again.')
      setLoading(false)
      return
    }
    if (!exists) {
      setError('No account is registered with this email.')
      setLoading(false)
      return
    }

    // 2) Send the recovery email (carries the OTP code + a fallback link)
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
    })
    if (resetError) {
      setError(resetError.message)
      setLoading(false)
      return
    }

    cooldown.start()
    setStep('otp')
    setLoading(false)
  }

  async function verifyAndReset(e: React.FormEvent) {
    e.preventDefault()
    setError('')

    if (!/^\d{6}$/.test(token.trim())) {
      setError('Enter the 6-digit code from your email.')
      return
    }
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
    const { error: verifyError } = await supabase.auth.verifyOtp({
      email, token: token.trim(), type: 'recovery',
    })
    if (verifyError) {
      setError('That code is invalid or has expired. Request a new one.')
      setLoading(false)
      return
    }

    const { error: updateError } = await supabase.auth.updateUser({ password })
    if (updateError) {
      setError(updateError.message)
      setLoading(false)
      return
    }

    setStep('done')
    setLoading(false)
    setTimeout(() => { router.push('/login'); router.refresh() }, 1500)
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
          {step === 'done' ? (
            <>
              <h1 className="text-xl font-semibold text-slate-900 mb-1">Password updated</h1>
              <div className="bg-green-50 text-green-700 text-sm px-3 py-2 rounded-lg mt-3">
                Your password has been changed. Taking you to sign in...
              </div>
            </>
          ) : step === 'otp' ? (
            <>
              <h1 className="text-xl font-semibold text-slate-900 mb-1">Enter reset code</h1>
              <p className="text-sm text-slate-500 mb-6">
                We sent a 6-digit code to <span className="font-medium">{email}</span>.
                Enter it below with your new password.
              </p>

              <form onSubmit={verifyAndReset} className="flex flex-col gap-4">
                <div>
                  <label className="label">6-digit code</label>
                  <input inputMode="numeric" autoComplete="one-time-code"
                    className="input tracking-[0.4em] text-center font-mono"
                    placeholder="000000" maxLength={6}
                    value={token}
                    onChange={e => setToken(e.target.value.replace(/\D/g, '').slice(0, 6))} />
                </div>
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

                <button type="submit" className="btn-primary w-full py-2.5 mt-1" disabled={loading}>
                  {loading ? 'Updating...' : 'Update password'}
                </button>
              </form>

              <div className="flex items-center justify-between mt-4 text-sm">
                <button
                  type="button"
                  onClick={() => sendCode()}
                  disabled={cooldown.active || loading}
                  className="text-brand-600 font-medium hover:underline disabled:text-slate-400 disabled:no-underline">
                  {cooldown.active ? `Resend in ${cooldown.remaining}s` : 'Resend code'}
                </button>
                <button
                  type="button"
                  onClick={() => { setStep('email'); setToken(''); setError('') }}
                  className="text-slate-500 hover:underline">
                  Change email
                </button>
              </div>
            </>
          ) : (
            <>
              <h1 className="text-xl font-semibold text-slate-900 mb-1">Reset password</h1>
              <p className="text-sm text-slate-500 mb-6">
                Enter your email and we&apos;ll send you a 6-digit code to reset your password.
              </p>

              <form onSubmit={sendCode} className="flex flex-col gap-4">
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
                  {loading ? 'Sending...' : 'Send code'}
                </button>
              </form>
            </>
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
