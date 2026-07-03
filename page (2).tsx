'use client'

// FILE: app/(dashboard)/dashboard/fees/reversals/page.tsx
// Admin-only: reversal request queue
// Collector requests → admin approves or rejects here

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { createClient } from '@/utils/supabase/client'
import {
  ArrowLeft, CheckCircle2, X, AlertCircle,
  RotateCcw, Clock, Ban,
} from 'lucide-react'

interface ReversalRequest {
  id: string
  reason: string
  status: string
  requested_at: string
  reviewed_at: string | null
  admin_notes: string | null
  requested_by_profile: { full_name: string; role: string } | null
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

function fmt(n: number) {
  return '₹' + Number(n).toLocaleString('en-IN')
}

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

export default function ReversalsPage() {
  const [requests,   setRequests]   = useState<ReversalRequest[]>([])
  const [loading,    setLoading]    = useState(true)
  const [isAdmin,    setIsAdmin]    = useState(false)
  const [activeTab,  setActiveTab]  = useState<'pending' | 'resolved'>('pending')

  // Per-request action state
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
        id, reason, status, requested_at, reviewed_at, admin_notes,
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

  async function handleApprove(requestId: string) {
    setSaving(true); setSaveError('')
    const supabase = createClient()
    const { error } = await supabase.rpc('approve_payment_reversal', {
      p_request_id:  requestId,
      p_admin_notes: adminNotes || null,
    })
    if (error) { setSaveError(error.message); setSaving(false); return }
    setSaving(false)
    setActionId(null)
    setAdminNotes('')
    fetchData()
  }

  async function handleReject(requestId: string) {
    if (!adminNotes.trim()) { setSaveError('Notes are required when rejecting'); return }
    setSaving(true); setSaveError('')
    const supabase = createClient()
    const { error } = await supabase.rpc('reject_payment_reversal', {
      p_request_id:  requestId,
      p_admin_notes: adminNotes.trim(),
    })
    if (error) { setSaveError(error.message); setSaving(false); return }
    setSaving(false)
    setActionId(null)
    setAdminNotes('')
    fetchData()
  }

  const pending  = requests.filter(r => r.status === 'pending')
  const resolved = requests.filter(r => r.status !== 'pending')

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
          {displayList.map(req => {
            const fp = req.fee_payments as any
            const isActive = actionId === req.id
            return (
              <div key={req.id} className={`card p-0 overflow-hidden ${req.status === 'pending' ? 'border-amber-200' : ''}`}>

                {/* Status bar */}
                <div className={`px-4 py-2.5 flex items-center justify-between ${
                  req.status === 'pending'  ? 'bg-amber-50 border-b border-amber-100' :
                  req.status === 'approved' ? 'bg-green-50 border-b border-green-100' :
                                              'bg-slate-50 border-b border-slate-100'
                }`}>
                  <div className="flex items-center gap-2">
                    {req.status === 'pending'  && <Clock size={13} className="text-amber-600" />}
                    {req.status === 'approved' && <CheckCircle2 size={13} className="text-green-600" />}
                    {req.status === 'rejected' && <Ban size={13} className="text-slate-500" />}
                    <span className={`text-xs font-semibold capitalize ${
                      req.status === 'pending' ? 'text-amber-700' :
                      req.status === 'approved' ? 'text-green-700' : 'text-slate-600'
                    }`}>
                      {req.status}
                    </span>
                  </div>
                  <span className="text-[10px] text-slate-400">{fmtDate(req.requested_at)}</span>
                </div>

                <div className="p-4">
                  {/* Payment info */}
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-slate-900">{fp?.students?.full_name ?? '—'}</p>
                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        {fp?.students?.student_uid && (
                          <span className="font-mono text-[11px] bg-brand-50 text-brand-700 border border-brand-200 px-1.5 py-0.5 rounded">
                            {fp.students.student_uid}
                          </span>
                        )}
                        {fp?.receipt_number && (
                          <span className="text-[11px] text-slate-400 font-mono">{fp.receipt_number}</span>
                        )}
                        {fp?.paid_date && (
                          <span className="text-xs text-slate-400">
                            · {new Date(fp.paid_date + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}
                          </span>
                        )}
                      </div>
                      {fp?.fee_dues?.label && (
                        <p className="text-xs text-slate-500 mt-1">{fp.fee_dues.label}</p>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-lg font-bold text-red-500">{fp ? fmt(fp.amount_paid) : '—'}</p>
                      <p className="text-[10px] text-slate-400 capitalize">{fp?.payment_method?.replace('_',' ')}</p>
                    </div>
                  </div>

                  {/* Reason */}
                  <div className="bg-slate-50 rounded-xl px-3 py-2.5 mb-3">
                    <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Reason given</p>
                    <p className="text-sm text-slate-700">{req.reason}</p>
                  </div>

                  {/* Admin notes (resolved) */}
                  {req.admin_notes && (
                    <div className="bg-slate-50 rounded-xl px-3 py-2.5 mb-3">
                      <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Admin notes</p>
                      <p className="text-sm text-slate-700">{req.admin_notes}</p>
                    </div>
                  )}

                  {/* Action panel — pending only */}
                  {req.status === 'pending' && (
                    <>
                      {!isActive ? (
                        <button
                          onClick={() => { setActionId(req.id); setAdminNotes(''); setSaveError('') }}
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
                              onClick={() => handleReject(req.id)}
                              disabled={saving}
                              className="text-sm py-2 border border-red-200 text-red-600 bg-red-50 rounded-lg hover:bg-red-100 transition-colors disabled:opacity-50"
                            >
                              Reject
                            </button>
                            <button
                              onClick={() => handleApprove(req.id)}
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
                            Approval creates a counter-transaction. The original receipt is preserved.
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
