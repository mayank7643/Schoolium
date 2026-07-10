'use client'

// FILE: app/(dashboard)/dashboard/attendance/page.tsx
// Admin view: today's attendance stats + scanner access
// Guard management moved to /dashboard/attendance/guards
// Guards fetched via get_school_guards() RPC — no RLS change needed

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/utils/supabase/client'
import {
  Users, QrCode, Shield, ExternalLink,
  CalendarCheck, Copy, Check, Printer,
  LogIn, LogOut as LogOutIcon, ArrowRight, TrendingUp
} from 'lucide-react'
import Link from 'next/link'

interface AttendanceStat {
  entry_present: number
  exit_present: number
  total_students: number
}

interface GuardSummary {
  id: string
  full_name: string
  gate: string | null
  is_active: boolean
}

export default function AttendancePage() {
  const [stats,      setStats]      = useState<AttendanceStat>({ entry_present: 0, exit_present: 0, total_students: 0 })
  const [guards,     setGuards]     = useState<GuardSummary[]>([])
  const [schoolId,   setSchoolId]   = useState('')
  const [loading,    setLoading]    = useState(true)
  const [copied,     setCopied]     = useState(false)

  const fetchData = useCallback(async () => {
    const supabase = createClient()

    // Always use getUser() + .eq('id', user.id) — never rely on .single() alone
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return

    const { data: profileData } = await supabase
      .from('profiles')
      .select('school_id')
      .eq('id', user.id)
      .single()

    if (!profileData) return
    const sid = profileData.school_id
    if (!sid) return
    setSchoolId(sid)

    const today = new Date().toISOString().split('T')[0]

    const [entryRes, exitRes, totalRes, guardsRes] = await Promise.all([
      // Today's entry count
      supabase.from('attendance')
        .select('id', { count: 'exact', head: true })
        .eq('school_id', sid)
        .eq('scan_date', today)
        .eq('entry_type', 'entry'),

      // Today's exit count
      supabase.from('attendance')
        .select('id', { count: 'exact', head: true })
        .eq('school_id', sid)
        .eq('scan_date', today)
        .eq('entry_type', 'exit'),

      // Total active students
      supabase.from('students')
        .select('id', { count: 'exact', head: true })
        .eq('school_id', sid)
        .eq('is_active', true),

      // Guards via SECURITY DEFINER function — bypasses RLS safely.
      // Direct .from('profiles').eq('role','guard') fails because RLS
      // only allows users to read their own profile row.
      // get_school_guards() verifies school ownership server-side.
      supabase.rpc('get_school_guards', { p_school_id: sid }),
    ])

    setStats({
      entry_present:  entryRes.count  ?? 0,
      exit_present:   exitRes.count   ?? 0,
      total_students: totalRes.count  ?? 0,
    })

    // rpc returns .data directly as the array — limit to 5 for the summary card
    const guardsData = (guardsRes.data ?? []) as GuardSummary[]
    setGuards(guardsData.slice(0, 5))
    setLoading(false)
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  function copyScanUrl() {
    const url = `${window.location.origin}/scan/${schoolId}`
    navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const scanUrl = schoolId
    ? `${typeof window !== 'undefined' ? window.location.origin : ''}/scan/${schoolId}`
    : ''
  const attendanceRate = stats.total_students > 0
    ? Math.round((stats.entry_present / stats.total_students) * 100)
    : 0
  const today = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto">
        <div className="h-8 w-48 bg-slate-200 rounded animate-pulse mb-6" />
        <div className="grid grid-cols-3 gap-4 mb-6">
          {[0,1,2].map(i => <div key={i} className="stat-card h-28 animate-pulse bg-slate-50" />)}
        </div>
        <div className="card h-40 animate-pulse bg-slate-50" />
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
        <div className="flex items-center gap-2">
          <Link href="/dashboard/attendance/reports"
            className="btn-secondary flex items-center gap-2 text-sm">
            <TrendingUp size={15} /> Reports
          </Link>
          <Link href="/dashboard/attendance/print-qr"
            className="btn-secondary flex items-center gap-2 text-sm">
            <Printer size={15} /> Print ID Cards
          </Link>
          <Link href="/dashboard/attendance/qr-stickers"
            className="btn-secondary flex items-center gap-2 text-sm">
            <QrCode size={15} /> QR Stickers
          </Link>
        </div>
      </div>

      {/* Today's stats — 3 cards: entry, exit, attendance % */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="stat-card">
          <div className="w-8 h-8 bg-green-50 rounded-lg flex items-center justify-center mb-2">
            <LogIn size={16} className="text-green-600" />
          </div>
          <p className="text-xs text-slate-500">Entries today</p>
          <p className="text-2xl font-bold text-green-600">{stats.entry_present}</p>
          <p className="text-xs text-slate-400">of {stats.total_students}</p>
        </div>
        <div className="stat-card">
          <div className="w-8 h-8 bg-blue-50 rounded-lg flex items-center justify-center mb-2">
            <LogOutIcon size={16} className="text-blue-600" />
          </div>
          <p className="text-xs text-slate-500">Exits today</p>
          <p className="text-2xl font-bold text-blue-600">{stats.exit_present}</p>
          <p className="text-xs text-slate-400">scanned out</p>
        </div>
        <div className="stat-card">
          <div className="w-8 h-8 bg-brand-50 rounded-lg flex items-center justify-center mb-2">
            <Users size={16} className="text-brand-600" />
          </div>
          <p className="text-xs text-slate-500">Attendance</p>
          <p className={`text-2xl font-bold ${
            attendanceRate >= 80 ? 'text-green-600' :
            attendanceRate >= 50 ? 'text-yellow-600' : 'text-red-500'
          }`}>{attendanceRate}%</p>
          <p className="text-xs text-slate-400">{stats.total_students - stats.entry_present} absent</p>
        </div>
      </div>

      {/* Scanner access */}
      <div className="card mb-6">
        <h2 className="font-semibold text-slate-800 mb-3 flex items-center gap-2">
          <QrCode size={17} className="text-brand-600" /> Scanner Access
        </h2>
        <p className="text-sm text-slate-500 mb-3">
          Share this URL with guards. They log in and are taken directly to the scanner.
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

      {/* Guards summary — links to full management page */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-slate-800 flex items-center gap-2">
            <Shield size={17} className="text-brand-600" />
            Guards
            <span className="text-xs bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full font-normal">
              {guards.length}
            </span>
          </h2>
          <Link href="/dashboard/attendance/guards"
            className="btn-primary flex items-center gap-1.5 text-sm py-1.5 px-3">
            Manage <ArrowRight size={13} />
          </Link>
        </div>

        {guards.length === 0 ? (
          <div className="text-center py-6">
            <Shield size={28} className="text-slate-200 mx-auto mb-2" />
            <p className="text-sm text-slate-400">No guards yet</p>
            <Link href="/dashboard/attendance/guards"
              className="text-xs text-brand-600 hover:underline mt-1 inline-block">
              Add your first guard
            </Link>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {guards.map(guard => (
              <div key={guard.id} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${
                    guard.is_active ? 'bg-brand-100 text-brand-700' : 'bg-slate-100 text-slate-400'
                  }`}>
                    {guard.full_name.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <p className={`text-sm font-medium ${guard.is_active ? 'text-slate-800' : 'text-slate-400'}`}>
                      {guard.full_name}
                    </p>
                    <p className="text-xs text-slate-400">{guard.gate ?? 'Main Gate'}</p>
                  </div>
                </div>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                  guard.is_active ? 'bg-green-50 text-green-700' : 'bg-slate-100 text-slate-400'
                }`}>
                  {guard.is_active ? 'Active' : 'Inactive'}
                </span>
              </div>
            ))}
            {guards.length >= 5 && (
              <Link href="/dashboard/attendance/guards"
                className="text-xs text-brand-600 hover:underline text-center mt-1">
                View all guards
              </Link>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
