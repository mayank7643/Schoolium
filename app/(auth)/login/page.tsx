'use client'

// FILE: app/(auth)/login/page.tsx
// Two ways in:
//   - password: signInWithPassword (unchanged behaviour)
//   - email code: signInWithOtp({ shouldCreateUser:false }) sends a
//     6-digit code, verifyOtp(type:'email') signs the user in. No
//     redirect URL needed, so this works on every preview domain.
// shouldCreateUser:false is deliberate - a login code must never mint a
// brand-new account that skips signup's school-creation step.
// After either path, finishLogin() runs the shared role routing:
// guards -> scan page, everyone else -> dashboard.

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/utils/supabase/client'
import { useCooldown } from '@/utils/useCooldown'

type Mode = 'password' | 'otp-email' | 'otp-code'

export default function LoginPage() {
  const router = useRouter()
  const [mode,     setMode]     = useState<Mode>('password')
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [token,    setToken]    = useState('')
  const [error,    setError]    = useState('')
  const [loading,  setLoading]  = useState(false)
  const cooldown = useCooldown(45)

  // Shared post-auth routing used by both the password and OTP paths.
  async function finishLogin() {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { setError('Sign in failed. Try again.'); setLoading(false); return }

    const { data: profile } = await supabase
      .from('profiles')
      .select('role, school_id, is_active')
      .eq('id', user.id)
      .single()

    if (!profile || !profile.is_active) {
      await supabase.auth.signOut()
      setError('Your account has been deactivated. Contact your school admin.')
      setLoading(false)
      return
    }

    // Record last login + login history (chat17). Fire-and-forget:
    // a logging failure must never block the sign-in.
    supabase
      .rpc('touch_login', { p_user_agent: navigator.userAgent })
      .then(() => {}, () => {})

    if (profile.role === 'guard') {
      router.push(`/scan/${profile.school_id}`)
    } else {
      router.push('/dashboard')
    }
    router.refresh()
  }

  async function handlePasswordLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')

    const supabase = createClient()
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password })
    if (signInError) {
      setError(signInError.message)
      setLoading(false)
      return
    }
    await finishLogin()
  }

  async function sendLoginCode(e?: React.FormEvent) {
    e?.preventDefault()
    setLoading(true)
    setError('')

    const supabase = createClient()
    const { error: otpError } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false },
    })
    if (otpError) {
      const m = otpError.message.toLowerCase()
      setError(m.includes('signups not allowed') || m.includes('not found')
        ? 'No account is registered with this email.'
        : otpError.message)
      setLoading(false)
      return
    }

    cooldown.start()
    setMode('otp-code')
    setLoading(false)
  }

  async function handleOtpLogin(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (!/^\d{6}$/.test(token.trim())) {
      setError('Enter the 6-digit code from your email.')
      return
    }

    setLoading(true)
    const supabase = createClient()
    const { error: verifyError } = await supabase.auth.verifyOtp({
      email, token: token.trim(), type: 'email',
    })
    if (verifyError) {
      setError('That code is invalid or has expired. Request a new one.')
      setLoading(false)
      return
    }
    await finishLogin()
  }

  // Check for disabled account message from middleware
  const searchParams = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search)
    : null
  const isDisabled = searchParams?.get('error') === 'account_disabled'

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
          <h1 className="text-xl font-semibold text-slate-900 mb-1">Welcome back</h1>
          <p className="text-sm text-slate-500 mb-6">
            {mode === 'password' ? 'Sign in to your account' : 'Sign in with an email code'}
          </p>

          {isDisabled && (
            <div className="bg-red-50 text-red-600 text-sm px-3 py-2 rounded-lg mb-4">
              Your account has been deactivated. Contact your school admin.
            </div>
          )}

          {/* ── Password sign-in ─────────────────────────────── */}
          {mode === 'password' && (
            <>
              <form onSubmit={handlePasswordLogin} className="flex flex-col gap-4">
                <div>
                  <label className="label">Email</label>
                  <input type="email" className="input" placeholder="your@email.com"
                    value={email} onChange={e => setEmail(e.target.value)}
                    required autoComplete="email" />
                </div>
                <div>
                  <div className="flex items-center justify-between">
                    <label className="label">Password</label>
                    <Link href="/forgot-password"
                      className="text-xs text-brand-600 font-medium hover:underline">
                      Forgot password?
                    </Link>
                  </div>
                  <input type="password" className="input" placeholder="••••••••"
                    value={password} onChange={e => setPassword(e.target.value)}
                    required autoComplete="current-password" />
                </div>

                {error && (
                  <div className="bg-red-50 text-red-600 text-sm px-3 py-2 rounded-lg">{error}</div>
                )}

                <button type="submit" className="btn-primary w-full py-2.5 mt-1" disabled={loading}>
                  {loading ? 'Signing in...' : 'Sign in'}
                </button>
              </form>

              <div className="flex items-center gap-3 my-4">
                <div className="flex-1 h-px bg-slate-200" />
                <span className="text-xs text-slate-400">or</span>
                <div className="flex-1 h-px bg-slate-200" />
              </div>

              <button type="button"
                onClick={() => { setMode('otp-email'); setError('') }}
                className="btn-secondary w-full py-2.5">
                Email me a login code
              </button>
            </>
          )}

          {/* ── Request an email code ────────────────────────── */}
          {mode === 'otp-email' && (
            <>
              <form onSubmit={sendLoginCode} className="flex flex-col gap-4">
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

              <button type="button"
                onClick={() => { setMode('password'); setError('') }}
                className="text-sm text-slate-500 hover:underline mt-4 block mx-auto">
                Use password instead
              </button>
            </>
          )}

          {/* ── Enter the email code ─────────────────────────── */}
          {mode === 'otp-code' && (
            <>
              <p className="text-sm text-slate-500 mb-4 -mt-2">
                We sent a 6-digit code to <span className="font-medium">{email}</span>.
              </p>
              <form onSubmit={handleOtpLogin} className="flex flex-col gap-4">
                <div>
                  <label className="label">6-digit code</label>
                  <input inputMode="numeric" autoComplete="one-time-code"
                    className="input tracking-[0.4em] text-center font-mono"
                    placeholder="000000" maxLength={6}
                    value={token}
                    onChange={e => setToken(e.target.value.replace(/\D/g, '').slice(0, 6))} />
                </div>

                {error && (
                  <div className="bg-red-50 text-red-600 text-sm px-3 py-2 rounded-lg">{error}</div>
                )}

                <button type="submit" className="btn-primary w-full py-2.5 mt-1" disabled={loading}>
                  {loading ? 'Signing in...' : 'Sign in'}
                </button>
              </form>

              <div className="flex items-center justify-between mt-4 text-sm">
                <button type="button"
                  onClick={() => sendLoginCode()}
                  disabled={cooldown.active || loading}
                  className="text-brand-600 font-medium hover:underline disabled:text-slate-400 disabled:no-underline">
                  {cooldown.active ? `Resend in ${cooldown.remaining}s` : 'Resend code'}
                </button>
                <button type="button"
                  onClick={() => { setMode('otp-email'); setToken(''); setError('') }}
                  className="text-slate-500 hover:underline">
                  Change email
                </button>
              </div>
            </>
          )}
        </div>

        <p className="text-center text-sm text-slate-500 mt-4">
          Don&apos;t have an account?{' '}
          <Link href="/signup" className="text-brand-600 font-medium hover:underline">Sign up</Link>
        </p>
      </div>
    </main>
  )
}
