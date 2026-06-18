'use client'

// FILE: app/(dashboard)/dashboard/attendance/guards/page.tsx
// Separate guard management page — create, activate/deactivate, delete guards
// Guard creation calls the Edge Function (no email confirmation needed)
// Guard LIST fetched via get_school_guards() RPC — no RLS change needed

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/utils/supabase/client'
import {
  Shield, Plus, Trash2, Eye, EyeOff,
  ArrowLeft, RefreshCw, X, Check,
  LogIn, Copy
} from 'lucide-react'
import Link from 'next/link'

interface Guard {
  id: string
  full_name: string
  gate: string | null
  is_active: boolean
  created_at: string
}

export default function GuardsPage() {
  const [guards,      setGuards]      = useState<Guard[]>([])
  const [schoolId,    setSchoolId]    = useState('')
  const [schoolName,  setSchoolName]  = useState('')
  const [loading,     setLoading]     = useState(true)
  const [showForm,    setShowForm]    = useState(false)

  // Form state
  const [newName,     setNewName]     = useState('')
  const [newEmail,    setNewEmail]    = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newGate,     setNewGate]     = useState('Main Gate')
  const [showPass,    setShowPass]    = useState(false)
  const [adding,      setAdding]      = useState(false)
  const [addError,    setAddError]    = useState('')
  const [addSuccess,  setAddSuccess]  = useState<{ email: string; password: string; scanUrl: string } | null>(null)
  const [copied,      setCopied]      = useState<'email' | 'pass' | 'url' | null>(null)

  const fetchData = useCallback(async () => {
    const supabase = createClient()

    // Always use getUser() + .eq('id', user.id) — never rely on .single() alone
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return

    const { data: profileData } = await supabase
      .from('profiles')
      .select('school_id, schools(id, name)')
      .eq('id', user.id)
      .single()

    if (!profileData) return
    const p = profileData as any
    const sid   = p.school_id
    const sname = Array.isArray(p.schools) ? p.schools[0]?.name : p.schools?.name
    if (!sid) return
    setSchoolId(sid)
    setSchoolName(sname ?? '')

    // Guards fetched via SECURITY DEFINER function — bypasses RLS safely.
    // Direct .from('profiles').eq('role','guard') fails because RLS only
    // allows users to read their own profile row, not others'.
    // get_school_guards() enforces school ownership inside the function.
    const { data: guardsData, error: guardsError } = await supabase
      .rpc('get_school_guards', { p_school_id: sid })

    if (guardsError) {
      console.error('get_school_guards error:', guardsError.message)
    }

    setGuards((guardsData ?? []) as Guard[])
    setLoading(false)
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  // ── Create guard via Edge Function ──────────────────────────
  async function handleAddGuard() {
    if (!newName.trim())        { setAddError('Name is required'); return }
    if (!newEmail.trim())       { setAddError('Email is required'); return }
    if (newPassword.length < 8) { setAddError('Password must be at least 8 characters'); return }

    setAdding(true); setAddError(''); setAddSuccess(null)

    const supabase = createClient()

    // Get session token to pass to Edge Function
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) {
      setAddError('Not authenticated')
      setAdding(false)
      return
    }

    try {
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/create-guard`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            email:     newEmail.trim(),
            password:  newPassword,
            full_name: newName.trim(),
            gate:      newGate,
            school_id: schoolId,
          }),
        }
      )

      const data = await res.json()

      if (!res.ok) {
        setAddError(data.error ?? 'Failed to create guard')
        setAdding(false)
        return
      }

      const scanUrl = `${window.location.origin}/scan/${schoolId}`
      setAddSuccess({ email: newEmail.trim(), password: newPassword, scanUrl })
      setNewName(''); setNewEmail(''); setNewPassword(''); setNewGate('Main Gate')
      fetchData()
    } catch {
      setAddError('Network error — check your connection')
    }

    setAdding(false)
  }

  // ── Toggle active ────────────────────────────────────────────
  // Uses SECURITY DEFINER RPC — admin cannot UPDATE other profile
  // rows directly due to RLS. update_guard() verifies school
  // ownership server-side before touching anything.
  async function toggleGuard(guardId: string, currentState: boolean) {
    const supabase = createClient()
    const { error } = await supabase.rpc('update_guard', {
      p_guard_id:  guardId,
      p_school_id: schoolId,
      p_is_active: !currentState,
    })
    if (error) {
      console.error('update_guard error:', error.message)
      return
    }
    fetchData()
  }

  // ── Delete guard ─────────────────────────────────────────────
  // Uses SECURITY DEFINER RPC — delete_guard() verifies the guard
  // belongs to this school before deleting, preventing cross-tenant deletion.
  async function deleteGuard(guardId: string) {
    if (!confirm('Delete this guard account permanently?')) return
    const supabase = createClient()
    const { error } = await supabase.rpc('delete_guard', {
      p_guard_id:  guardId,
      p_school_id: schoolId,
    })
    if (error) {
      console.error('delete_guard error:', error.message)
      return
    }
    fetchData()
  }

  // ── Copy helper ──────────────────────────────────────────────
  function copyText(text: string, field: 'email' | 'pass' | 'url') {
    navigator.clipboard.writeText(text)
    setCopied(field)
    setTimeout(() => setCopied(null), 2000)
  }

  const scanUrl = schoolId
    ? `${typeof window !== 'undefined' ? window.location.origin : ''}/scan/${schoolId}`
    : ''

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto">
        <div className="h-8 w-40 bg-slate-200 rounded animate-pulse mb-6" />
        <div className="card h-64 animate-pulse bg-slate-50" />
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto">

      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <Link href="/dashboard/attendance"
          className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 transition-colors">
          <ArrowLeft size={17} className="text-slate-500" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Guards</h1>
          <p className="text-sm text-slate-500">{schoolName}</p>
        </div>
        <button
          onClick={() => { setShowForm(!showForm); setAddError(''); setAddSuccess(null) }}
          className="ml-auto btn-primary flex items-center gap-1.5 text-sm py-1.5 px-3"
        >
          {showForm ? <><X size={14} /> Cancel</> : <><Plus size={14} /> Add Guard</>}
        </button>
      </div>

      {/* Add guard form */}
      {showForm && (
        <div className="card mb-6">
          <h2 className="font-semibold text-slate-800 mb-4 flex items-center gap-2">
            <Shield size={16} className="text-brand-600" /> New guard account
          </h2>

          {/* Success card */}
          {addSuccess && (
            <div className="bg-green-50 border border-green-200 rounded-xl p-4 mb-4">
              <p className="text-sm font-semibold text-green-800 mb-3 flex items-center gap-2">
                <Check size={15} /> Guard created — share these credentials
              </p>
              {[
                { label: 'Email',    value: addSuccess.email,    field: 'email' as const },
                { label: 'Password', value: addSuccess.password, field: 'pass'  as const },
                { label: 'Scan URL', value: addSuccess.scanUrl,  field: 'url'   as const },
              ].map(({ label, value, field }) => (
                <div key={field} className="flex items-center gap-2 mb-2">
                  <span className="text-xs text-green-700 w-16 shrink-0">{label}</span>
                  <span className="text-xs font-mono text-green-900 bg-green-100 rounded px-2 py-1 flex-1 truncate">
                    {value}
                  </span>
                  <button onClick={() => copyText(value, field)}
                    className="flex items-center gap-1 text-xs text-green-700 hover:text-green-900 shrink-0">
                    {copied === field ? <Check size={12} /> : <Copy size={12} />}
                    {copied === field ? 'Copied' : 'Copy'}
                  </button>
                </div>
              ))}
              <p className="text-xs text-green-600 mt-2">
                Guard can log in at the scan URL — they&apos;ll be taken straight to the scanner.
              </p>
            </div>
          )}

          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Full name</label>
                <input type="text" className="input text-sm" placeholder="Ram Kumar"
                  value={newName} onChange={e => setNewName(e.target.value)} />
              </div>
              <div>
                <label className="label">Gate</label>
                <select className="input text-sm" value={newGate} onChange={e => setNewGate(e.target.value)}>
                  <option>Main Gate</option>
                  <option>Side Gate</option>
                  <option>Back Gate</option>
                </select>
              </div>
            </div>
            <div>
              <label className="label">Email (for login)</label>
              <input type="email" className="input text-sm" placeholder="guard@yourschool.com"
                value={newEmail} onChange={e => setNewEmail(e.target.value)} />
            </div>
            <div>
              <label className="label">Password</label>
              <div className="relative">
                <input type={showPass ? 'text' : 'password'} className="input text-sm pr-9"
                  placeholder="Min 8 characters"
                  value={newPassword} onChange={e => setNewPassword(e.target.value)} />
                <button type="button" onClick={() => setShowPass(!showPass)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400">
                  {showPass ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>

            {addError && (
              <div className="bg-red-50 text-red-600 text-xs px-3 py-2 rounded-lg">{addError}</div>
            )}

            <button onClick={handleAddGuard} disabled={adding}
              className="btn-primary flex items-center justify-center gap-2">
              {adding
                ? <><span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" /> Creating…</>
                : <><Plus size={15} /> Create guard account</>}
            </button>
          </div>
        </div>
      )}

      {/* Guards list */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-slate-800 flex items-center gap-2">
            <Shield size={17} className="text-brand-600" />
            Guards
            <span className="text-xs bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full font-normal">
              {guards.length}
            </span>
          </h2>
          <button onClick={fetchData}
            className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600">
            <RefreshCw size={12} /> Refresh
          </button>
        </div>

        {/* Scanner URL */}
        <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 mb-4">
          <LogIn size={13} className="text-slate-400 shrink-0" />
          <span className="text-xs text-slate-600 font-mono flex-1 truncate">{scanUrl}</span>
          <button onClick={() => copyText(scanUrl, 'url')}
            className="flex items-center gap-1 text-xs text-brand-600 hover:text-brand-700 font-medium shrink-0">
            {copied === 'url' ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy URL</>}
          </button>
        </div>

        {guards.length === 0 ? (
          <div className="text-center py-10">
            <Shield size={32} className="text-slate-200 mx-auto mb-3" />
            <p className="text-sm text-slate-400">No guards added yet</p>
            <p className="text-xs text-slate-400 mt-1">Click Add Guard to create the first one</p>
          </div>
        ) : (
          <div className="flex flex-col divide-y divide-slate-50">
            {guards.map(guard => (
              <div key={guard.id} className="flex items-center justify-between py-3">
                <div className="flex items-center gap-3">
                  <div className={`w-9 h-9 rounded-full flex items-center justify-center ${
                    guard.is_active ? 'bg-brand-100' : 'bg-slate-100'
                  }`}>
                    <span className={`font-bold text-sm ${
                      guard.is_active ? 'text-brand-700' : 'text-slate-400'
                    }`}>
                      {guard.full_name.charAt(0).toUpperCase()}
                    </span>
                  </div>
                  <div>
                    <p className={`text-sm font-medium ${guard.is_active ? 'text-slate-800' : 'text-slate-400'}`}>
                      {guard.full_name}
                    </p>
                    <p className="text-xs text-slate-400">
                      {guard.gate ?? 'Main Gate'}
                      {!guard.is_active && ' · Deactivated'}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => toggleGuard(guard.id, guard.is_active)}
                    className={`text-xs px-2.5 py-1 rounded-full font-medium border transition-colors ${
                      guard.is_active
                        ? 'border-green-200 text-green-700 bg-green-50 hover:bg-red-50 hover:text-red-600 hover:border-red-200'
                        : 'border-slate-200 text-slate-500 bg-slate-50 hover:bg-green-50 hover:text-green-700 hover:border-green-200'
                    }`}
                  >
                    {guard.is_active ? 'Active' : 'Inactive'}
                  </button>
                  <button onClick={() => deleteGuard(guard.id)}
                    className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="mt-4 pt-4 border-t border-slate-100 flex items-start gap-2">
          <RefreshCw size={12} className="text-slate-400 mt-0.5 shrink-0" />
          <p className="text-xs text-slate-400">
            Deactivating a guard blocks them instantly on their next page load.
            Deleting removes the account permanently.
          </p>
        </div>
      </div>
    </div>
  )
}
