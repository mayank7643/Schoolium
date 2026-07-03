'use client'

// FILE: app/(dashboard)/dashboard/fees/defaulters/page.tsx
//
// Defaulter Management — lists all students with outstanding fee balances.
// Filters: class, academic year, minimum balance, days overdue.
// Actions: collect fee, view ledger, send WA reminder.
//
// Data source: get_defaulters() SECURITY DEFINER RPC
// WA reminders: send-fee-reminder Edge Function

import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { createClient } from '@/utils/supabase/client'
import {
  AlertCircle, IndianRupee, Clock, Search,
  MessageCircle, ChevronDown, CheckCircle2,
  Filter, TrendingDown, Users, RefreshCw,
} from 'lucide-react'
import type { DefaulterRow } from '@/types'

// ── Local types ───────────────────────────────────────────────────────────────

interface ClassOption {
  id: string
  name: string
  section: string | null
}

interface ReminderState {
  sending: boolean
  sent: string[]       // student_ids successfully sent
  failed: string[]     // student_ids that failed
  skipped: string[]    // student_ids skipped (no phone / opted out / no WA)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatCurrency(n: number): string {
  return '₹' + Number(n).toLocaleString('en-IN')
}

function formatDate(d: string): string {
  return new Date(d).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
  })
}

function overdueBadge(days: number): { label: string; cls: string } {
  if (days <= 0)   return { label: 'Due today',   cls: 'badge-yellow' }
  if (days <= 30)  return { label: `${days}d overdue`, cls: 'badge-yellow' }
  if (days <= 90)  return { label: `${days}d overdue`, cls: 'badge-red' }
  return { label: `${days}d overdue`, cls: 'badge-red' }
}

const CURRENT_YEAR  = new Date().getFullYear()
const ACADEMIC_YEARS = [
  `${CURRENT_YEAR - 1}-${String(CURRENT_YEAR).slice(2)}`,
  `${CURRENT_YEAR}-${String(CURRENT_YEAR + 1).slice(2)}`,
]

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function DefaultersPage() {
  const [defaulters, setDefaulters]     = useState<DefaulterRow[]>([])
  const [classes, setClasses]           = useState<ClassOption[]>([])
  const [waEnabled, setWaEnabled]       = useState(false)
  const [loading, setLoading]           = useState(true)
  const [error, setError]               = useState('')

  // Filters
  const [search, setSearch]             = useState('')
  const [classFilter, setClassFilter]   = useState('all')
  const [yearFilter, setYearFilter]     = useState('all')
  const [minBalance, setMinBalance]     = useState('')
  const [minDays, setMinDays]           = useState('')

  // Selection for bulk actions
  const [selected, setSelected]         = useState<Set<string>>(new Set())

  // Reminder state
  const [reminder, setReminder]         = useState<ReminderState>({
    sending: false, sent: [], failed: [], skipped: [],
  })
  const [reminderType, setReminderType] = useState<'due' | 'overdue'>('overdue')
  const [reminderMsg, setReminderMsg]   = useState('')

  const searchTimer = useRef<NodeJS.Timeout>()

  // ── Load data ─────────────────────────────────────────────────────────────
  const fetchData = useCallback(async () => {
    setLoading(true)
    setError('')
    const supabase = createClient()

    const { data: profileData } = await supabase
      .from('profiles')
      .select('school_id, schools(id, name, wa_fee_reminders_enabled)')
      .single()

    if (!profileData) { setError('Could not load school info'); setLoading(false); return }

    const p   = profileData as any
    const sid = p.school_id
    const school = Array.isArray(p.schools) ? p.schools[0] : p.schools
    setWaEnabled(school?.wa_fee_reminders_enabled ?? false)

    const [defaultersRes, classesRes] = await Promise.all([
      supabase.rpc('get_defaulters', {
        p_school_id:     sid,
        p_class_id:      null,
        p_academic_year: null,
      }),
      supabase.from('classes').select('id, name, section').order('name'),
    ])

    if (defaultersRes.error) {
      setError(defaultersRes.error.message)
    } else {
      setDefaulters((defaultersRes.data ?? []) as DefaulterRow[])
    }

    setClasses((classesRes.data ?? []) as ClassOption[])
    setLoading(false)
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  // ── Filtering ─────────────────────────────────────────────────────────────
  const filtered = defaulters.filter(d => {
    if (search.trim()) {
      const q = search.toLowerCase()
      if (!d.full_name.toLowerCase().includes(q) &&
          !(d.student_uid ?? '').toLowerCase().includes(q)) return false
    }
    if (classFilter !== 'all') {
      const cls = classes.find(c => c.id === classFilter)
      if (cls) {
        const className = `${cls.name}${cls.section ? ' - ' + cls.section : ''}`
        const dClass    = `${d.class_name ?? ''}${d.class_section ? ' - ' + d.class_section : ''}`
        if (!dClass.includes(cls.name)) return false
      }
    }
    if (minBalance && !isNaN(parseFloat(minBalance))) {
      if (Number(d.total_balance) < parseFloat(minBalance)) return false
    }
    if (minDays && !isNaN(parseInt(minDays))) {
      if (Number(d.days_overdue) < parseInt(minDays)) return false
    }
    return true
  })

  // ── Summary stats ─────────────────────────────────────────────────────────
  const totalOutstanding  = filtered.reduce((s, d) => s + Number(d.total_balance), 0)
  const criticalCount     = filtered.filter(d => Number(d.days_overdue) > 30).length

  // ── Selection helpers ─────────────────────────────────────────────────────
  const allSelected = filtered.length > 0 && filtered.every(d => selected.has(d.student_id))

  function toggleAll() {
    if (allSelected) {
      setSelected(new Set())
    } else {
      setSelected(new Set(filtered.map(d => d.student_id)))
    }
  }

  function toggleOne(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // ── Send WA reminders ─────────────────────────────────────────────────────
  async function sendReminders(studentIds: string[]) {
    if (!studentIds.length) return
    if (!waEnabled) {
      setReminderMsg('Fee reminders are turned off. A school admin can enable them in Settings.')
      return
    }

    setReminder(r => ({ ...r, sending: true }))
    setReminderMsg('')

    try {
      const res = await fetch('/api/wa/reminder', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          student_ids:   studentIds,
          reminder_type: reminderType,
        }),
      })

      const json = await res.json()

      if (!res.ok) {
        const reason =
          json.error === 'feature_off' ? 'Fee reminders are turned off. Enable them in Settings.'
          : json.error === 'forbidden' ? 'Only a school admin can send reminders.'
          : `Error: ${json.error ?? 'Failed to send reminders'}`
        setReminderMsg(reason)
      } else if ((json.enqueued ?? 0) === 0) {
        setReminder({ sending: false, sent: [], failed: [], skipped: [] })
        setReminderMsg('No new reminders sent (already reminded today, or no pending dues / no parent phone).')
      } else {
        const w = json.worker || {}
        const sentN = w.sent ?? 0, skipN = w.skipped ?? 0, failN = w.failed ?? 0
        const cleanSuccess = failN === 0 && skipN === 0
        setReminder({
          sending: false,
          sent:    cleanSuccess ? studentIds : [],
          failed:  [],
          skipped: [],
        })
        setReminderMsg(`Sent: ${sentN} - Skipped: ${skipN} - Failed: ${failN}`)
      }
    } catch {
      setReminderMsg('Network error - try again')
    } finally {
      setReminder(r => ({ ...r, sending: false }))
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-5xl mx-auto">

      {/* Header */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Defaulters</h1>
          <p className="text-slate-500 text-sm mt-1">
            Students with outstanding fee balances
          </p>
        </div>
        <button
          onClick={fetchData}
          className="btn-secondary flex items-center gap-2 text-sm"
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {/* Stats */}
      {!loading && defaulters.length > 0 && (
        <div className="grid grid-cols-3 gap-4 mb-5">
          <div className="stat-card">
            <div className="w-9 h-9 bg-red-50 rounded-lg flex items-center justify-center mb-3">
              <Users size={17} className="text-red-500" />
            </div>
            <p className="text-2xl font-bold text-slate-900">{filtered.length}</p>
            <p className="text-xs text-slate-500">Defaulters</p>
          </div>
          <div className="stat-card">
            <div className="w-9 h-9 bg-red-50 rounded-lg flex items-center justify-center mb-3">
              <IndianRupee size={17} className="text-red-500" />
            </div>
            <p className="text-2xl font-bold text-red-600">{formatCurrency(totalOutstanding)}</p>
            <p className="text-xs text-slate-500">Total outstanding</p>
          </div>
          <div className="stat-card">
            <div className="w-9 h-9 bg-amber-50 rounded-lg flex items-center justify-center mb-3">
              <Clock size={17} className="text-amber-600" />
            </div>
            <p className="text-2xl font-bold text-amber-600">{criticalCount}</p>
            <p className="text-xs text-slate-500">Over 30 days overdue</p>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="card p-4 mb-4">
        <div className="flex items-center gap-2 mb-3">
          <Filter size={14} className="text-slate-400" />
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Filters</span>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {/* Search */}
          <div className="relative col-span-2 lg:col-span-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              className="input pl-8 text-sm"
              placeholder="Search name or ID..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>

          {/* Class */}
          <select
            className="input text-sm"
            value={classFilter}
            onChange={e => setClassFilter(e.target.value)}
          >
            <option value="all">All classes</option>
            {classes.map(c => (
              <option key={c.id} value={c.id}>
                {c.name}{c.section ? ` - ${c.section}` : ''}
              </option>
            ))}
          </select>

          {/* Min balance */}
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">₹</span>
            <input
              type="number"
              className="input pl-7 text-sm"
              placeholder="Min balance"
              value={minBalance}
              onChange={e => setMinBalance(e.target.value)}
              min={0}
            />
          </div>

          {/* Min days overdue */}
          <input
            type="number"
            className="input text-sm"
            placeholder="Min days overdue"
            value={minDays}
            onChange={e => setMinDays(e.target.value)}
            min={0}
          />
        </div>

        {/* Active filter summary */}
        {(search || classFilter !== 'all' || minBalance || minDays) && (
          <div className="flex items-center justify-between mt-3 pt-3 border-t border-slate-100">
            <span className="text-xs text-slate-500">
              Showing {filtered.length} of {defaulters.length} defaulters
            </span>
            <button
              onClick={() => { setSearch(''); setClassFilter('all'); setMinBalance(''); setMinDays('') }}
              className="text-xs text-brand-600 hover:underline font-medium"
            >
              Clear filters
            </button>
          </div>
        )}
      </div>

      {/* Bulk actions bar */}
      {selected.size > 0 && (
        <div className="bg-brand-600 text-white rounded-xl px-4 py-3 mb-4 flex items-center justify-between gap-3 flex-wrap">
          <span className="text-sm font-medium">
            {selected.size} student{selected.size !== 1 ? 's' : ''} selected
          </span>
          <div className="flex items-center gap-3 flex-wrap">
            <select
              className="bg-white/20 text-white border border-white/30 rounded-lg px-2 py-1 text-xs"
              value={reminderType}
              onChange={e => setReminderType(e.target.value as 'due' | 'overdue')}
            >
              <option value="overdue">Overdue reminder</option>
              <option value="due">Due reminder</option>
            </select>
            <button
              onClick={() => sendReminders(Array.from(selected))}
              disabled={reminder.sending}
              className="flex items-center gap-1.5 bg-white text-brand-700 font-semibold text-xs px-3 py-1.5 rounded-lg hover:bg-brand-50 disabled:opacity-50 transition-colors"
            >
              {reminder.sending
                ? <><span className="w-3 h-3 border-2 border-brand-400 border-t-transparent rounded-full animate-spin" /> Sending...</>
                : <><MessageCircle size={13} /> Send WA reminder</>}
            </button>
            <button
              onClick={() => setSelected(new Set())}
              className="text-xs text-white/70 hover:text-white underline"
            >
              Clear
            </button>
          </div>
        </div>
      )}

      {/* Reminder result message */}
      {reminderMsg && (
        <div className={`flex items-center gap-2 text-sm px-4 py-3 rounded-xl mb-4 ${
          reminderMsg.startsWith('Error') || reminderMsg.startsWith('WhatsApp')
            ? 'bg-red-50 text-red-600 border border-red-100'
            : 'bg-green-50 text-green-700 border border-green-100'
        }`}>
          {reminderMsg.startsWith('Error') || reminderMsg.startsWith('WhatsApp')
            ? <AlertCircle size={15} className="shrink-0" />
            : <CheckCircle2 size={15} className="shrink-0" />}
          {reminderMsg}
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div className="card p-0 overflow-hidden">
          {[1,2,3,4,5].map(i => (
            <div key={i} className="flex items-center gap-4 px-4 py-3.5 border-b border-slate-50 animate-pulse">
              <div className="w-4 h-4 bg-slate-100 rounded" />
              <div className="w-9 h-9 bg-slate-100 rounded-full shrink-0" />
              <div className="flex-1">
                <div className="h-4 w-40 bg-slate-100 rounded mb-1.5" />
                <div className="h-3 w-28 bg-slate-100 rounded" />
              </div>
              <div className="h-5 w-20 bg-slate-100 rounded" />
              <div className="h-8 w-20 bg-slate-100 rounded-lg" />
            </div>
          ))}
        </div>
      ) : defaulters.length === 0 ? (
        <div className="card flex flex-col items-center justify-center py-20 text-center">
          <div className="w-14 h-14 bg-green-50 rounded-full flex items-center justify-center mb-4">
            <CheckCircle2 size={26} className="text-green-500" />
          </div>
          <h3 className="font-semibold text-slate-900 mb-1">No defaulters</h3>
          <p className="text-sm text-slate-400">
            All students are up to date with their fees
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="card flex flex-col items-center justify-center py-14 text-center">
          <TrendingDown size={32} className="text-slate-300 mb-3" />
          <p className="font-medium text-slate-600">No results match your filters</p>
          <button
            onClick={() => { setSearch(''); setClassFilter('all'); setMinBalance(''); setMinDays('') }}
            className="text-sm text-brand-600 hover:underline mt-2"
          >
            Clear filters
          </button>
        </div>
      ) : (
        <div className="card p-0 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full" style={{ tableLayout: 'fixed' }}>
              <colgroup>
                <col style={{ width: '36px' }} />
                <col style={{ width: '36px' }} />
                <col />
                <col style={{ width: '15%' }} className="hidden lg:table-column" />
                <col style={{ width: '18%' }} />
                <col style={{ width: '14%' }} className="hidden sm:table-column" />
                <col style={{ width: '130px' }} />
              </colgroup>
              <thead>
                <tr className="bg-slate-50 border-b border-slate-100">
                  {/* Select all checkbox */}
                  <th className="pl-4 py-2.5">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAll}
                      className="w-4 h-4 rounded border-slate-300 text-brand-600"
                    />
                  </th>
                  <th className="py-2.5" />
                  <th className="px-3 py-2.5 text-left text-xs font-semibold text-slate-500">Student</th>
                  <th className="px-3 py-2.5 text-left text-xs font-semibold text-slate-500 hidden lg:table-cell">Class</th>
                  <th className="px-3 py-2.5 text-right text-xs font-semibold text-slate-500">Balance</th>
                  <th className="px-3 py-2.5 text-left text-xs font-semibold text-slate-500 hidden sm:table-cell">Overdue</th>
                  <th className="px-3 py-2.5 text-right text-xs font-semibold text-slate-500 pr-4">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((d, idx) => {
                  const badge     = overdueBadge(Number(d.days_overdue))
                  const isChecked = selected.has(d.student_id)
                  const waResult  = reminder.sent.includes(d.student_id)    ? 'sent'
                                  : reminder.failed.includes(d.student_id)  ? 'failed'
                                  : reminder.skipped.includes(d.student_id) ? 'skipped'
                                  : null

                  return (
                    <tr
                      key={d.student_id}
                      className={`border-b border-slate-50 transition-colors ${
                        isChecked ? 'bg-brand-50' : 'hover:bg-slate-50'
                      }`}
                    >
                      {/* Checkbox */}
                      <td className="pl-4 py-3.5">
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggleOne(d.student_id)}
                          className="w-4 h-4 rounded border-slate-300 text-brand-600"
                        />
                      </td>

                      {/* Avatar */}
                      <td className="py-3.5">
                        <div className="w-8 h-8 bg-red-50 rounded-full flex items-center justify-center">
                          <span className="text-red-600 font-bold text-sm">
                            {d.full_name.charAt(0).toUpperCase()}
                          </span>
                        </div>
                      </td>

                      {/* Name + UID */}
                      <td className="px-3 py-3.5">
                        <p className="font-medium text-slate-900 text-sm truncate">{d.full_name}</p>
                        <div className="flex items-center gap-2 mt-0.5">
                          {d.student_uid && (
                            <span className="font-mono text-[11px] text-slate-500 bg-slate-100 px-1.5 rounded">
                              {d.student_uid}
                            </span>
                          )}
                          {/* WA send result badge */}
                          {waResult === 'sent' && (
                            <span className="text-[10px] text-green-600 bg-green-50 px-1.5 py-0.5 rounded-full">
                              ✓ Reminder sent
                            </span>
                          )}
                          {waResult === 'skipped' && (
                            <span className="text-[10px] text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded-full">
                              Skipped
                            </span>
                          )}
                          {waResult === 'failed' && (
                            <span className="text-[10px] text-red-500 bg-red-50 px-1.5 py-0.5 rounded-full">
                              Failed
                            </span>
                          )}
                        </div>
                      </td>

                      {/* Class */}
                      <td className="px-3 py-3.5 text-sm text-slate-500 hidden lg:table-cell">
                        {d.class_name
                          ? `${d.class_name}${d.class_section ? ' - ' + d.class_section : ''}`
                          : '—'}
                      </td>

                      {/* Balance */}
                      <td className="px-3 py-3.5 text-right">
                        <p className="font-bold text-red-600 text-sm">
                          {formatCurrency(Number(d.total_balance))}
                        </p>
                        <p className="text-[10px] text-slate-400">
                          {d.dues_count} due{Number(d.dues_count) !== 1 ? 's' : ''}
                        </p>
                      </td>

                      {/* Overdue */}
                      <td className="px-3 py-3.5 hidden sm:table-cell">
                        <span className={badge.cls}>{badge.label}</span>
                        <p className="text-[10px] text-slate-400 mt-0.5">
                          Since {formatDate(d.oldest_due_date)}
                        </p>
                      </td>

                      {/* Actions */}
                      <td className="px-3 py-3.5 pr-4">
                        <div className="flex items-center justify-end gap-1.5">
                          {/* Single WA reminder */}
                          {waEnabled && (
                            <button
                              onClick={() => sendReminders([d.student_id])}
                              disabled={reminder.sending}
                              title="Send WhatsApp reminder"
                              className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-green-50 text-slate-400 hover:text-green-600 transition-colors disabled:opacity-40"
                            >
                              <MessageCircle size={15} />
                            </button>
                          )}

                          {/* Collect fee */}
                          <Link
                            href={`/dashboard/fees/collect?student_id=${d.student_id}`}
                            className="btn-primary text-xs py-1.5 px-2.5"
                          >
                            Collect
                          </Link>

                          {/* View ledger */}
                          <Link
                            href={`/dashboard/fees/ledger/${d.student_id}`}
                            className="btn-secondary text-xs py-1.5 px-2.5"
                          >
                            Ledger
                          </Link>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Footer */}
          <div className="px-4 py-3 border-t border-slate-100 bg-slate-50 flex items-center justify-between flex-wrap gap-2">
            <span className="text-xs text-slate-500">
              {filtered.length} student{filtered.length !== 1 ? 's' : ''}
              {filtered.length !== defaulters.length ? ` (filtered from ${defaulters.length})` : ''}
            </span>
            <span className="text-xs font-semibold text-red-600">
              Total outstanding: {formatCurrency(totalOutstanding)}
            </span>
          </div>
        </div>
      )}

      {/* WA not enabled notice */}
      {!loading && !waEnabled && defaulters.length > 0 && (
        <div className="mt-4 flex items-start gap-3 bg-amber-50 border border-amber-100 rounded-xl px-4 py-3">
          <AlertCircle size={16} className="text-amber-500 shrink-0 mt-0.5" />
          <p className="text-sm text-amber-700">
            Fee reminders are turned off. A school admin can enable them in Settings.
          </p>
        </div>
      )}
    </div>
  )
}
