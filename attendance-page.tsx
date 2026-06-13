'use client'

// FILE: app/(dashboard)/dashboard/attendance/page.tsx
// Admin view: today's attendance stats + full guard management

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/utils/supabase/client'
import {
  Users, QrCode, Plus, Trash2, Shield,
  ExternalLink, RefreshCw, Eye, EyeOff,
  CalendarCheck, Copy, Check, X, Printer
} from 'lucide-react'
import Link from 'next/link'

interface Guard {
  id: string
  full_name: string
  gate: string | null
  is_active: boolean
  created_at: string
  // auth email stored separately
  email?: string
}

interface AttendanceStat {
  total_present: number
  total_students: number
}

export default function AttendancePage() {
  const [guards,      setGuards]      = useState<Guard[]>([])
  const [stats,       setStats]       = useState<AttendanceStat>({ total_present: 0, total_students: 0 })
  const [schoolId,    setSchoolId]    = useState('')
  const [schoolName,  setSchoolName]  = useState('')
  const [loading,     setLoading]     = useState(true)
  const [showAddForm, setShowAddForm] = useState(false)
  const [copied,      setCopied]      = useState(false)

  // Add guard form
  const [newName,     setNewName]     = useState('')
  const [newEmail,    setNewEmail]    = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newGate,     setNewGate]     = useState('Main Gate')
  const [showPass,    setShowPass]    = useState(false)
  const [adding,      setAdding]      = useState(false)
  const [addError,    setAddError]    = useState('')
  const [addSuccess,  setAddSuccess]  = useState('')

  const fetchData = useCallback(async () => {
    const supabase = createClient()

    const { data: profileData } = await supabase
      .from('profiles')
      .select('school_id, schools(id, name)')
      .single()

    if (!profileData) return
    const p = profileData as any
    const sid = p.school_id
    const sname = Array.isArray(p.schools) ? p.schools[0]?.name : p.schools?.name
    setSchoolId(sid)
    setSchoolName(sname ?? '')

    const today = new Date().toISOString().split('T')[0]

    const [guardsRes, presentRes, totalRes] = await Promise.all([
      // All guards for this school
      supabase.from('profiles')
        .select('id, full_name, gate, is_active, created_at')
        .eq('school_id', sid)
        .eq('role', 'guard')
        .order('created_at', { ascending: false }),

      // Today's attendance count
      supabase.from('attendance')
        .select('id', { count: 'exact', head: true })
        .eq('school_id', sid)
        .eq('scan_date', today),

      // Total active students
      supabase.from('students')
        .select('id', { count: 'exact', head: true })
        .eq('school_id', sid)
        .eq('is_active', true),
    ])

    setGuards((guardsRes.data ?? []) as Guard[])
    setStats({
      total_present: presentRes.count ?? 0,
      total_students: totalRes.count ?? 0,
    })
    setLoading(false)
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  // ── Add guard ───────────────────────────────────────────────
  async function handleAddGuard() {
    if (!newName.trim())  { setAddError('Name is required'); return }
    if (!newEmail.trim()) { setAddError('Email is required'); return }
    if (newPassword.length < 8) { setAddError('Password must be at least 8 characters'); return }

    setAdding(true); setAddError(''); setAddSuccess('')

    const supabase = createClient()

    // Step 1: Create auth user via Supabase Admin (using service role via API route)
    // Since we're on client, we use the standard signUp flow and then update the profile
    const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
      email: newEmail.trim(),
      password: newPassword,
      options: {
        data: { full_name: newName.trim() }
      }
    })

    if (signUpError) {
      setAddError(signUpError.message)
      setAdding(false)
      return
    }

    if (!signUpData.user) {
      setAddError('Failed to create user account')
      setAdding(false)
      return
    }

    // Step 2: Update the auto-created profile to set role=guard + school_id + gate
    const { error: profileError } = await supabase
      .from('profiles')
      .upsert({
        id:         signUpData.user.id,
        full_name:  newName.trim(),
        role:       'guard',
        school_id:  schoolId,
        gate:       newGate,
        is_active:  true,
      })

    if (profileError) {
      setAddError(profileError.message)
      setAdding(false)
      return
    }

    setAddSuccess(`Guard account created! Share these credentials:\nEmail: ${newEmail}\nPassword: ${newPassword}\nScan URL: ${window.location.origin}/scan/${schoolId}`)
    setNewName(''); setNewEmail(''); setNewPassword(''); setNewGate('Main Gate')
    setAdding(false)
    fetchData()
  }

  // ── Toggle guard active/inactive ────────────────────────────
  async function toggleGuard(guardId: string, currentState: boolean) {
    const supabase = createClient()
    await supabase.from('profiles')
      .update({ is_active: !currentState })
      .eq('id', guardId)
      .eq('school_id', schoolId) // safety: only own school
    fetchData()
  }

  // ── Delete guard ────────────────────────────────────────────
  async function deleteGuard(guardId: string) {
    if (!confirm('Delete this guard account permanently?')) return
    const supabase = createClient()
    await supabase.from('profiles')
      .delete()
      .eq('id', guardId)
      .eq('school_id', schoolId) // safety: only own school
    fetchData()
  }

  // ── Copy scan URL ────────────────────────────────────────────
  function copyScanUrl() {
    const url = `${window.location.origin}/scan/${schoolId}`
    navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const scanUrl = schoolId ? `${typeof window !== 'undefined' ? window.location.origin : ''}/scan/${schoolId}` : ''
  const attendanceRate = stats.total_students > 0
    ? Math.round((stats.total_present / stats.total_students) * 100)
    : 0
  const today = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto">
        <div className="h-8 w-48 bg-slate-200 rounded animate-pulse mb-6" />
        <div className="grid grid-cols-2 gap-4 mb-6">
          <div className="stat-card h-28 animate-pulse bg-slate-50" />
          <div className="stat-card h-28 animate-pulse bg-slate-50" />
        </div>
        <div className="card h-64 animate-pulse bg-slate-50" />
      </div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Attendance</h1>
          <p className="text-sm text-slate-500">{today}</p>
        </div>
        <Link href="/dashboard/attendance/print-qr"
          className="btn-secondary flex items-center gap-2 text-sm">
          <Printer size={15} /> Print ID Cards
        </Link>
      </div>

      {/* Today's stats */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        <div className="stat-card">
          <div className="w-8 h-8 bg-green-50 rounded-lg flex items-center justify-center mb-2">
            <CalendarCheck size={16} className="text-green-600" />
          </div>
          <p className="text-xs text-slate-500">Present today</p>
          <p className="text-2xl font-bold text-green-600">{stats.total_present}</p>
          <p className="text-xs text-slate-400">of {stats.total_students} students</p>
        </div>
        <div className="stat-card">
          <div className="w-8 h-8 bg-brand-50 rounded-lg flex items-center justify-center mb-2">
            <Users size={16} className="text-brand-600" />
          </div>
          <p className="text-xs text-slate-500">Attendance rate</p>
          <p className={`text-2xl font-bold ${
            attendanceRate >= 80 ? 'text-green-600' :
            attendanceRate >= 50 ? 'text-yellow-600' : 'text-red-500'
          }`}>{attendanceRate}%</p>
          <p className="text-xs text-slate-400">{stats.total_students - stats.total_present} absent</p>
        </div>
      </div>

      {/* Scanner URL */}
      <div className="card mb-6">
        <h2 className="font-semibold text-slate-800 mb-3 flex items-center gap-2">
          <QrCode size={17} className="text-brand-600" /> Scanner Access
        </h2>
        <p className="text-sm text-slate-500 mb-3">
          Share this URL with guards. They log in with their credentials and are taken directly to the scanner.
        </p>
        <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 mb-3">
          <span className="text-xs text-slate-600 font-mono flex-1 truncate">{scanUrl}</span>
          <button onClick={copyScanUrl}
            className="flex items-center gap-1 text-xs text-brand-600 hover:text-brand-700 font-medium shrink-0">
            {copied ? <><Check size={13} /> Copied!</> : <><Copy size={13} /> Copy</>}
          </button>
        </div>
        <a href={scanUrl} target="_blank" rel="noopener noreferrer"
          className="btn-primary flex items-center justify-center gap-2 text-sm w-full">
          <ExternalLink size={15} /> Open Scanner
        </a>
      </div>

      {/* Guard management */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-slate-800 flex items-center gap-2">
            <Shield size={17} className="text-brand-600" />
            Guards
            <span className="text-xs bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full font-normal">
              {guards.length}
            </span>
          </h2>
          <button
            onClick={() => { setShowAddForm(!showAddForm); setAddError(''); setAddSuccess('') }}
            className="btn-primary flex items-center gap-1.5 text-sm py-1.5 px-3"
          >
            {showAddForm ? <><X size={14} /> Cancel</> : <><Plus size={14} /> Add Guard</>}
          </button>
        </div>

        {/* Add guard form */}
        {showAddForm && (
          <div className="bg-brand-50 border border-brand-100 rounded-xl p-4 mb-4">
            <h3 className="font-medium text-slate-800 text-sm mb-3">New guard account</h3>
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
              {addSuccess && (
                <div className="bg-green-50 border border-green-200 text-green-800 text-xs px-3 py-3 rounded-lg whitespace-pre-line font-mono">
                  {addSuccess}
                </div>
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
        {guards.length === 0 ? (
          <div className="text-center py-8">
            <Shield size={32} className="text-slate-200 mx-auto mb-3" />
            <p className="text-sm text-slate-400">No guards added yet</p>
            <p className="text-xs text-slate-400 mt-1">Add a guard to give them scanner access</p>
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
            Deactivating a guard blocks them instantly — they cannot scan on their next page load.
            Deleting removes their account permanently.
          </p>
        </div>
      </div>
    </div>
  )
}
