'use client'

// FILE: app/(dashboard)/dashboard/fees/reversals/page.tsx
// Admin-only: reversal request queue.
// Collector requests (full receipt or a subset of lines) -> admin approves or
// rejects the whole group here. Lines requested together share a group id.

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { createClient } from '@/utils/supabase/client'
import {
  ArrowLeft, CheckCircle2, AlertCircle,
  RotateCcw, Clock, Ban,
} from 'lucide-react'

interface ReversalRequest {
  id: string
  reason: string
  status: string
  requested_at: string
  reviewed_at: string | null
  admin_notes: string | null
  reversal_group_id: string | null
  fee_payments: {
    id: string
    amount_paid: number
    payment_method: string
    receipt_number: string | null
    paid_date: string
    students: { full_name: string; student_uid: string | null } | null
    fee_dues: { label: string } | null
  } | null
}

interface ReversalGroup {
  groupId: string
  status: string
  requestedAt: string
  adminNotes: string | null
  reason: string
  studentName: string
  studentUid: string | null
  receiptNumber: string | null
  paymentMethod: string | null
  paidDate: string | null
  total: number
  lines: { label: string; amount: number }[]
}

function fmt(n: number) {
  return '₹' + Number(n).toLocaleString('en-IN')
}

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function buildGroups(reqs: ReversalRequest[]): ReversalGroup[] {
  const map = new Map<string, ReversalRequest[]>()
  for (const r of reqs) {
    const key = r.reversal_group_id ?? r.id
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(r)
  }
  const groups: ReversalGroup[] = Array.from(map.entries()).map(([groupId, rows]) => {
    const first = rows[0]
    const fp0 = first.fee_payments as any
    return {
      groupId,
      status: first.status,
      requestedAt: first.requested_at,
      adminNotes: first.admin_notes,
      reason: first.reason,
      studentName: fp0?.students?.full_name ?? '—',
      studentUid: fp0?.students?.student_uid ?? null,
      receiptNumber: fp0?.receipt_number ?? null,
      paymentMethod: fp0?.payment_method ?? null,
      paidDate: fp0?.paid_date ?? null,
      total: rows.reduce((s, r) => s + Number((r.fee_payments as any)?.amount_paid ?? 0), 0),
      lines: rows.map(r => ({
        label: (r.fee_payments as any)?.fee_dues?.label ?? 'Fee',
        amount: Number((r.fee_payments as any)?.amount_paid ?? 0),
      })),
    }
  })
  groups.sort((a, b) => +new Date(b.requestedAt) - +new Date(a.requestedAt))
  return groups
}

export default function ReversalsPage() {
  const [requests,   setRequests]   = useState<ReversalRequest[]>([])
  const [loading,    setLoading]    = useState(true)
  const [isAdmin,    setIsAdmin]    = useState(false)
  const [activeTab,  setActiveTab]  = useState<'pending' | 'resolved'>('pending')

  const [actionId,   setActionId]   = useState<string | null>(null)
  const [adminNotes, setAdminNotes] = useState('')
  const [saving,     setSaving]     = useState(false)
  const [saveError,  setSaveError]  = useState('')

  const fetchData = useCallback(async () => {
    const supabase = createClient()
    const { data: profile } = await supabase
      .from('profiles')
      .select('role, school_id')
      .single()

    if ((profile as any)?.role !== 'school_admin') {
      setIsAdmin(false)
      setLoading(false)
      return
    }
    setIsAdmin(true)

    const { data, error } = await supabase
      .from('reversal_requests')
      .select(`
        id, reason, status, requested_at, reviewed_at, admin_notes, reversal_group_id,
        fee_payments!fee_payment_id(
          id, amount_paid, payment_method, receipt_number, paid_date,
          students(full_name, student_uid),
          fee_dues(label)
        )
      `)
      .eq('school_id', (profile as any).school_id)
      .order('requested_at', { ascending: false })

    if (error) console.error('reversal_requests fetch failed:', error.message)
    setRequests((data ?? []) as any as ReversalRequest[])
    setLoading(false)
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  async function handleApprove(groupId: string) {
    setSaving(true); setSaveError('')
    const supabase = createClient()
    const { error } = await supabase.rpc('approve_reversal_group', {
      p_group_id:    groupId,
      p_admin_notes: adminNotes || null,
    })
    if (error) { setSaveError(error.message); setSaving(false); return }
    setSaving(false); setActionId(null); setAdminNotes('')
    fetchData()
  }

  async function handleReject(groupId: string) {
    if (!adminNotes.trim()) { setSaveError('Notes are required when rejecting'); return }
    setSaving(true); setSaveError('')
    const supabase = createClient()
    const { error } = await supabase.rpc('reject_reversal_group', {
      p_group_id:    groupId,
      p_admin_notes: adminNotes.trim(),
    })
    if (error) { setSaveError(error.message); setSaving(false); return }
    setSaving(false); setActionId(null); setAdminNotes('')
    fetchData()
  }

  const groups   = buildGroups(requests)
  const pending  = groups.filter(g => g.status === 'pending')
  const resolved = groups.filter(g => g.status !== 'pending')

  if (!loading && !isAdmin) {
    return (
      <div className="max-w-2xl mx-auto py-16 text-center">
        <AlertCircle size={32} className="mx-auto text-red-400 mb-3" />
        <p className="font-semibold text-slate-700">Access denied</p>
        <p className="text-sm text-slate-400 mt-1">Only school admins can view reversal requests</p>
        <Link href="/dashboard/fees" className="btn-primary mt-4 inline-block text-sm">Back to fees</Link>
      </div>
    )
  }

  const displayList = activeTab === 'pending' ? pending : resolved

  return (
    <div className="max-w-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <Link href="/dashboard/fees" className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 text-slate-500">
          <ArrowLeft size={18} />
        </Link>
        <div>
          <h1 className="text-xl font-bold text-slate-900">Reversal Requests</h1>
          <p className="text-slate-400 text-xs mt-0.5">Review and action reversal requests from collectors</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4 bg-slate-100 p-1 rounded-xl">
        {(['pending', 'resolved'] as const).map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)}
            className={`flex-1 py-2 text-sm font-medium rounded-lg transition-colors capitalize ${
              activeTab === tab ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            {tab}
            {tab === 'pending' && pending.length > 0 && (
              <span className="ml-1.5 bg-red-500 text-white text-[10px] font-bold rounded-full px-1.5 py-0.5">
                {pending.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex flex-col gap-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="card p-4 animate-pulse">
              <div className="h-4 w-48 bg-slate-100 rounded mb-2" />
              <div className="h-3 w-32 bg-slate-100 rounded" />
            </div>
          ))}
        </div>
      ) : displayList.length === 0 ? (
        <div className="card py-14 text-center">
          <RotateCcw size={28} className="mx-auto text-slate-300 mb-3" />
          <p className="font-medium text-slate-600">
            {activeTab === 'pending' ? 'No pending reversal requests' : 'No resolved reversals yet'}
          </p>
          <p className="text-xs text-slate-400 mt-1">
            {activeTab === 'pending' ? 'Collectors can request reversals from the payment receipt screen' : ''}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {displayList.map(g => {
            const isActive = actionId === g.groupId
            return (
              <div key={g.groupId} className={`card p-0 overflow-hidden ${g.status === 'pending' ? 'border-amber-200' : ''}`}>
                {/* Status bar */}
                <div className={`px-4 py-2.5 flex items-center justify-between ${
                  g.status === 'pending'  ? 'bg-amber-50 border-b border-amber-100' :
                  g.status === 'approved' ? 'bg-green-50 border-b border-green-100' :
                                            'bg-slate-50 border-b border-slate-100'
                }`}>
                  <div className="flex items-center gap-2">
                    {g.status === 'pending'  && <Clock size={13} className="text-amber-600" />}
                    {g.status === 'approved' && <CheckCircle2 size={13} className="text-green-600" />}
                    {g.status === 'rejected' && <Ban size={13} className="text-slate-500" />}
                    <span className={`text-xs font-semibold capitalize ${
                      g.status === 'pending' ? 'text-amber-700' :
                      g.status === 'approved' ? 'text-green-700' : 'text-slate-600'
                    }`}>
                      {g.status}
                    </span>
                  </div>
                  <span className="text-[10px] text-slate-400">{fmtDate(g.requestedAt)}</span>
                </div>

                <div className="p-4">
                  {/* Header row */}
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-slate-900">{g.studentName}</p>
                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        {g.studentUid && (
                          <span className="font-mono text-[11px] bg-brand-50 text-brand-700 border border-brand-200 px-1.5 py-0.5 rounded">
                            {g.studentUid}
                          </span>
                        )}
                        {g.receiptNumber && (
                          <span className="text-[11px] text-slate-400 font-mono">{g.receiptNumber}</span>
                        )}
                        {g.paidDate && (
                          <span className="text-xs text-slate-400">
                            · {new Date(g.paidDate + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-lg font-bold text-red-500">{fmt(g.total)}</p>
                      <p className="text-[10px] text-slate-400 capitalize">{g.paymentMethod?.replace('_', ' ')}</p>
                    </div>
                  </div>

                  {/* Line breakdown */}
                  <div className="rounded-xl border border-slate-100 divide-y divide-slate-50 mb-3">
                    {g.lines.map((l, i) => (
                      <div key={i} className="flex items-center justify-between px-3 py-2 text-sm">
                        <span className="text-slate-600 truncate mr-3">{l.label}</span>
                        <span className="font-medium text-slate-800">{fmt(l.amount)}</span>
                      </div>
                    ))}
                    {g.lines.length > 1 && (
                      <div className="flex items-center justify-between px-3 py-2 text-sm bg-slate-50">
                        <span className="text-slate-500 font-medium">{g.lines.length} lines</span>
                        <span className="font-bold text-slate-900">{fmt(g.total)}</span>
                      </div>
                    )}
                  </div>

                  {/* Reason */}
                  <div className="bg-slate-50 rounded-xl px-3 py-2.5 mb-3">
                    <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Reason given</p>
                    <p className="text-sm text-slate-700">{g.reason}</p>
                  </div>

                  {/* Admin notes (resolved) */}
                  {g.adminNotes && (
                    <div className="bg-slate-50 rounded-xl px-3 py-2.5 mb-3">
                      <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Admin notes</p>
                      <p className="text-sm text-slate-700">{g.adminNotes}</p>
                    </div>
                  )}

                  {/* Action panel — pending only */}
                  {g.status === 'pending' && (
                    <>
                      {!isActive ? (
                        <button
                          onClick={() => { setActionId(g.groupId); setAdminNotes(''); setSaveError('') }}
                          className="btn-primary text-sm w-full py-2"
                        >
                          Review this request
                        </button>
                      ) : (
                        <div className="flex flex-col gap-3 border-t border-slate-100 pt-3">
                          <div>
                            <label className="label">Admin notes</label>
                            <textarea
                              className="input resize-none"
                              rows={2}
                              placeholder="Required if rejecting. Optional for approval."
                              value={adminNotes}
                              onChange={e => { setAdminNotes(e.target.value); setSaveError('') }}
                            />
                          </div>
                          {saveError && (
                            <div className="flex items-center gap-2 text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg">
                              <AlertCircle size={12} className="shrink-0" /> {saveError}
                            </div>
                          )}
                          <div className="grid grid-cols-3 gap-2">
                            <button
                              onClick={() => { setActionId(null); setAdminNotes(''); setSaveError('') }}
                              className="btn-secondary text-sm py-2 col-span-1"
                            >
                              Cancel
                            </button>
                            <button
                              onClick={() => handleReject(g.groupId)}
                              disabled={saving}
                              className="text-sm py-2 border border-red-200 text-red-600 bg-red-50 rounded-lg hover:bg-red-100 transition-colors disabled:opacity-50"
                            >
                              Reject
                            </button>
                            <button
                              onClick={() => handleApprove(g.groupId)}
                              disabled={saving}
                              className="btn-primary text-sm py-2 disabled:opacity-50"
                            >
                              {saving
                                ? <span className="flex items-center justify-center gap-1">
                                    <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                    …
                                  </span>
                                : 'Approve'}
                            </button>
                          </div>
                          <p className="text-[10px] text-slate-400 text-center">
                            Approval reverses every line above with a counter-transaction. Original receipt preserved.
                          </p>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
