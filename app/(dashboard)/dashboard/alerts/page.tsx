'use client'

// FILE: app/(dashboard)/dashboard/alerts/page.tsx
//
// Delivery ledger + alerts overview (chat21, blueprint section 11).
// "Delivered to 412 parents. Read by 388." - this screen IS the demo.
// Reads message_outbox / alert_notifications / spend_guard through RLS
// (school_admin, operator, principal). All writes happen elsewhere.

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/utils/supabase/client'
import Link from 'next/link'
import {
  Megaphone, Send, Upload, Settings, RefreshCw, Download,
  CheckCheck, Eye, AlertTriangle, IndianRupee, Clock, XCircle,
} from 'lucide-react'
import type { AlertNotification, OutboxStatus } from '@/types'

interface LedgerRow {
  id: number
  channel: string
  recipient: string
  status: OutboxStatus
  triggered_by: string
  cost_estimate_paise: number
  error_message: string | null
  created_at: string
  sent_at: string | null
}

interface SpendRow {
  daily_cap_paise: number
  spent_today_paise: number
  spent_date: string
}

type RangeKey = 'today' | '7d' | '30d'

const RANGE_LABEL: Record<RangeKey, string> = { today: 'Today', '7d': '7 days', '30d': '30 days' }

function rangeStart(range: RangeKey): string {
  const d = new Date()
  if (range === '7d') d.setDate(d.getDate() - 7)
  else if (range === '30d') d.setDate(d.getDate() - 30)
  else d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

// Reconciliation rule: recipients are always masked on screen and in
// the export (blueprint: "recipient (masked)").
function maskRecipient(value: string): string {
  if (value.includes('@')) {
    const [user, domain] = value.split('@')
    return `${user.slice(0, 2)}***@${domain}`
  }
  return value.length > 4 ? `${value.slice(0, 3)}******${value.slice(-4)}` : value
}

function paise(n: number): string {
  return `Rs ${(n / 100).toFixed(2)}`
}

const STATUS_BADGE: Record<OutboxStatus, string> = {
  queued: 'badge-yellow',
  sending: 'badge-yellow',
  sent: 'badge-blue',
  delivered: 'badge-green',
  read: 'badge-green',
  failed: 'badge-red',
  dead: 'badge-red',
}

export default function AlertsOverviewPage() {
  const [role, setRole] = useState<string>('')
  const [range, setRange] = useState<RangeKey>('today')
  const [rows, setRows] = useState<LedgerRow[]>([])
  const [notifications, setNotifications] = useState<AlertNotification[]>([])
  const [spend, setSpend] = useState<SpendRow | null>(null)
  const [alertsEnabled, setAlertsEnabled] = useState<boolean | null>(null)
  const [loadError, setLoadError] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async (r: RangeKey) => {
    setLoading(true)
    setLoadError('')
    try {
    const supabase = createClient()

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    const { data: profile } = await supabase
      .from('profiles').select('role, school_id').eq('id', user.id).single()
    setRole(profile?.role ?? '')

    const [outbox, notifs, guard, school] = await Promise.all([
      supabase
        .from('message_outbox')
        .select('id, channel, recipient, status, triggered_by, cost_estimate_paise, error_message, created_at, sent_at')
        .gte('created_at', rangeStart(r))
        .order('created_at', { ascending: false })
        .limit(500),
      supabase
        .from('alert_notifications')
        .select('*')
        .eq('is_read', false)
        .order('created_at', { ascending: false })
        .limit(10),
      supabase.from('spend_guard').select('daily_cap_paise, spent_today_paise, spent_date').maybeSingle(),
      profile?.school_id
        ? supabase.from('schools').select('alerts_enabled').eq('id', profile.school_id).single()
        : Promise.resolve({ data: null }),
    ])

    // Missing table = the chat21 migration is not applied yet.
    if (outbox.error) {
      const m = outbox.error.message
      setLoadError(
        /does not exist|schema cache/i.test(m)
          ? 'The alerts schema is not in this database yet. Run "Migration sql/chat21_alerts_byog_foundation.sql" in the Supabase SQL editor, then reload. (' + m + ')'
          : m,
      )
      return
    }

    setRows((outbox.data as LedgerRow[]) || [])
    setNotifications((notifs.data as AlertNotification[]) || [])
    setSpend((guard.data as SpendRow) || null)
    setAlertsEnabled((school.data as { alerts_enabled: boolean } | null)?.alerts_enabled ?? null)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load(range) }, [load, range])

  async function dismissNotification(id: number) {
    const supabase = createClient()
    await supabase.from('alert_notifications').update({ is_read: true }).eq('id', id)
    setNotifications((n) => n.filter((x) => x.id !== id))
  }

  // Monthly reconciliation export: the school checks this against
  // their Meta/DLT invoice in five minutes. Masked recipients only.
  function exportCsv() {
    const header = 'date,recipient_masked,channel,status,triggered_by,cost_paise\n'
    const body = rows
      .map((r) =>
        [
          new Date(r.created_at).toISOString(),
          maskRecipient(r.recipient),
          r.channel,
          r.status,
          r.triggered_by,
          r.cost_estimate_paise,
        ].join(','),
      )
      .join('\n')
    const blob = new Blob([header + body], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `alerts-reconciliation-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const counts = {
    total: rows.length,
    queued: rows.filter((r) => r.status === 'queued' || r.status === 'sending').length,
    delivered: rows.filter((r) => r.status === 'delivered' || r.status === 'read').length,
    read: rows.filter((r) => r.status === 'read').length,
    failed: rows.filter((r) => r.status === 'failed' || r.status === 'dead').length,
    cost: rows.reduce((s, r) => s + r.cost_estimate_paise, 0),
  }
  const spendPct = spend && spend.daily_cap_paise > 0
    ? Math.min(100, Math.round((spend.spent_today_paise / spend.daily_cap_paise) * 100))
    : 0
  const canCompose = role === 'school_admin' || role === 'operator' || role === 'super_admin'

  return (
    <div className="max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <Megaphone size={20} className="text-brand-600" /> Alerts
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Gate attendance &amp; announcement messages, sent through your school&apos;s own gateway
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canCompose && (
            <Link href="/dashboard/alerts/compose" className="btn-primary flex items-center gap-1.5">
              <Send size={15} /> Send notice
            </Link>
          )}
          {canCompose && (
            <Link href="/dashboard/alerts/import" className="btn-secondary flex items-center gap-1.5">
              <Upload size={15} /> Import CSV
            </Link>
          )}
          {role === 'school_admin' && (
            <Link href="/dashboard/alerts/settings" className="btn-secondary flex items-center gap-1.5">
              <Settings size={15} /> Settings
            </Link>
          )}
        </div>
      </div>

      {loadError && (
        <div className="card mb-6 border-l-4 border-red-500 text-sm text-red-700 flex items-start gap-3">
          <AlertTriangle size={18} className="mt-0.5 shrink-0" /> {loadError}
        </div>
      )}

      {/* Pipeline disabled banner */}
      {alertsEnabled === false && (
        <div className="card mb-6 border-l-4 border-yellow-400 flex items-start gap-3">
          <AlertTriangle size={18} className="text-yellow-500 mt-0.5 shrink-0" />
          <div className="text-sm text-slate-600">
            <span className="font-medium text-slate-800">Alerts are switched off for this school.</span>{' '}
            Scans are recorded but no messages go out.
            {role === 'school_admin' && (
              <> Enable them in <Link href="/dashboard/alerts/settings" className="text-brand-600 font-medium">Alerts settings</Link>.</>
            )}
          </div>
        </div>
      )}

      {/* Unread ops notifications - spend cap hits, channel health */}
      {notifications.map((n) => (
        <div
          key={n.id}
          className={`card mb-3 border-l-4 flex items-start justify-between gap-3 ${
            n.severity === 'error' ? 'border-red-500' : n.severity === 'warning' ? 'border-yellow-400' : 'border-slate-300'
          }`}
        >
          <div className="text-sm">
            <span className="font-medium text-slate-800 capitalize">{n.kind.replace(/_/g, ' ')}</span>
            <span className="text-slate-600"> — {n.message}</span>
            <span className="block text-xs text-slate-400 mt-0.5">
              {new Date(n.created_at).toLocaleString('en-IN')}
            </span>
          </div>
          <button onClick={() => void dismissNotification(n.id)} className="text-xs text-slate-400 hover:text-slate-600 shrink-0">
            Dismiss
          </button>
        </div>
      ))}

      {/* Range picker */}
      <div className="flex items-center gap-2 mb-4">
        <div className="inline-flex rounded-lg bg-slate-100 p-1">
          {(Object.keys(RANGE_LABEL) as RangeKey[]).map((k) => (
            <button
              key={k}
              onClick={() => setRange(k)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                range === k ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {RANGE_LABEL[k]}
            </button>
          ))}
        </div>
        <button onClick={() => void load(range)} className="btn-secondary flex items-center gap-1.5 text-xs">
          <RefreshCw size={13} /> Refresh
        </button>
        <button onClick={exportCsv} disabled={!rows.length} className="btn-secondary flex items-center gap-1.5 text-xs disabled:opacity-50">
          <Download size={13} /> Reconciliation CSV
        </button>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-6">
        <div className="stat-card">
          <div className="flex items-center gap-2 text-slate-500 text-xs font-medium"><Send size={13} /> Messages</div>
          <p className="text-2xl font-bold text-slate-900 mt-1">{counts.total}</p>
        </div>
        <div className="stat-card">
          <div className="flex items-center gap-2 text-slate-500 text-xs font-medium"><CheckCheck size={13} /> Delivered</div>
          <p className="text-2xl font-bold text-green-700 mt-1">{counts.delivered}</p>
        </div>
        <div className="stat-card">
          <div className="flex items-center gap-2 text-slate-500 text-xs font-medium"><Eye size={13} /> Read</div>
          <p className="text-2xl font-bold text-green-700 mt-1">{counts.read}</p>
        </div>
        <div className="stat-card">
          <div className="flex items-center gap-2 text-slate-500 text-xs font-medium"><XCircle size={13} /> Failed</div>
          <p className={`text-2xl font-bold mt-1 ${counts.failed ? 'text-red-600' : 'text-slate-900'}`}>{counts.failed}</p>
        </div>
        <div className="stat-card">
          <div className="flex items-center gap-2 text-slate-500 text-xs font-medium"><IndianRupee size={13} /> Est. cost</div>
          <p className="text-2xl font-bold text-slate-900 mt-1">{paise(counts.cost)}</p>
        </div>
      </div>

      {/* Spend guard meter */}
      {spend && (
        <div className="card mb-6">
          <div className="flex items-center justify-between text-sm mb-2">
            <span className="font-medium text-slate-700">Daily spend guard</span>
            <span className="text-slate-500">
              {paise(spend.spent_today_paise)} of {paise(spend.daily_cap_paise)} ({spendPct}%)
            </span>
          </div>
          <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
            <div
              className={`h-full rounded-full ${spendPct >= 90 ? 'bg-red-500' : spendPct >= 60 ? 'bg-yellow-400' : 'bg-brand-600'}`}
              style={{ width: `${spendPct}%` }}
            />
          </div>
          <p className="text-xs text-slate-400 mt-2">
            When the cap is hit, messages stop and a notification lands here. Nothing sends past it.
          </p>
        </div>
      )}

      {/* Ledger table */}
      <div className="card overflow-x-auto">
        <h2 className="text-sm font-semibold text-slate-800 mb-3">
          Delivery ledger <span className="text-slate-400 font-normal">— {RANGE_LABEL[range].toLowerCase()}, newest first</span>
        </h2>
        {loading ? (
          <div className="h-40 animate-pulse bg-slate-50 rounded-lg" />
        ) : rows.length === 0 ? (
          <div className="py-12 text-center text-sm text-slate-400 flex flex-col items-center gap-2">
            <Clock size={20} />
            No messages in this period yet. They appear here the moment a scan or notice queues one.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-400 border-b border-slate-100">
                <th className="py-2 pr-3 font-medium">When</th>
                <th className="py-2 pr-3 font-medium">Recipient</th>
                <th className="py-2 pr-3 font-medium">Channel</th>
                <th className="py-2 pr-3 font-medium">Trigger</th>
                <th className="py-2 pr-3 font-medium">Status</th>
                <th className="py-2 pr-3 font-medium text-right">Cost</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 100).map((r) => (
                <tr key={r.id} className="border-b border-slate-50 last:border-0">
                  <td className="py-2 pr-3 text-slate-500 whitespace-nowrap">
                    {new Date(r.created_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </td>
                  <td className="py-2 pr-3 font-mono text-xs text-slate-700">{maskRecipient(r.recipient)}</td>
                  <td className="py-2 pr-3 capitalize text-slate-600">{r.channel}</td>
                  <td className="py-2 pr-3 capitalize text-slate-500">{r.triggered_by}</td>
                  <td className="py-2 pr-3">
                    <span className={STATUS_BADGE[r.status]} title={r.error_message ?? undefined}>{r.status}</span>
                  </td>
                  <td className="py-2 pr-3 text-right text-slate-600">{paise(r.cost_estimate_paise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
