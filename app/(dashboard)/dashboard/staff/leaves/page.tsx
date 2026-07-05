'use client'

// FILE: app/(dashboard)/dashboard/staff/leaves/page.tsx
//
// Leave review queue (chat17 Module 5) - admin/principal.
// Pending requests first with approve/reject + optional comment.
// Approval syncs staff_attendance as 'leave' for the range via the
// review_leave_request RPC (never downgrading days already marked
// present/late/half-day); a principal cannot review their own
// request - the RPC blocks it and the error surfaces here.

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { createClient } from '@/utils/supabase/client'
import { ArrowLeft, FileText, Check, X } from 'lucide-react'
import type { LeaveStatus, LeaveType } from '@/types'

interface LeaveRow {
  id: string
  leave_type: LeaveType
  from_date: string
  to_date: string
  total_days: number
  reason: string
  document_path: string | null
  status: LeaveStatus
  admin_comment: string | null
  created_at: string
  staff: {
    full_name: string
    employee_id: string
    designation: string
  } | null
}

const STATUS_BADGE: Record<string, string> = {
  pending: 'badge-yellow', approved: 'badge-green',
  rejected: 'badge-red', cancelled: 'badge-red',
}

const FILTERS: { value: string; label: string }[] = [
  { value: 'pending',  label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: '',         label: 'All' },
]

function fmt(d: string) {
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

export default function LeaveReviewPage() {
  const [allowed, setAllowed] = useState<boolean | null>(null)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter]   = useState('pending')
  const [rows, setRows]       = useState<LeaveRow[]>([])
  const [error, setError]     = useState('')

  // review state: which request has its comment box open + action
  const [reviewing, setReviewing] = useState<{ id: string; action: 'approve' | 'reject' } | null>(null)
  const [comment, setComment]     = useState('')
  const [busy, setBusy]           = useState(false)
  const [notice, setNotice]       = useState('')

  const fetchRows = useCallback(async (f: string) => {
    const supabase = createClient()
    let q = supabase
      .from('leave_requests')
      .select('id, leave_type, from_date, to_date, total_days, reason, document_path, status, admin_comment, created_at, staff(full_name, employee_id, designation)')
      .order('created_at', { ascending: false })
      .limit(100)
    if (f) q = q.eq('status', f)

    const { data } = await q
    setRows(
      ((data ?? []) as any[]).map(r => ({
        ...r,
        staff: Array.isArray(r.staff) ? r.staff[0] ?? null : r.staff,
      })) as LeaveRow[]
    )
  }, [])

  useEffect(() => {
    async function init() {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { setAllowed(false); setLoading(false); return }

      const { data: profile } = await supabase
        .from('profiles').select('role').eq('id', user.id).single()

      const ok = profile?.role === 'school_admin' || profile?.role === 'principal'
      setAllowed(ok)
      if (ok) await fetchRows('pending')
      setLoading(false)
    }
    init()
  }, [fetchRows])

  function handleFilter(f: string) {
    setFilter(f)
    setReviewing(null)
    setNotice('')
    fetchRows(f)
  }

  function startReview(id: string, action: 'approve' | 'reject') {
    setReviewing({ id, action })
    setComment('')
    setError('')
    setNotice('')
  }

  async function confirmReview() {
    if (!reviewing) return
    setBusy(true)
    setError('')

    const supabase = createClient()
    const { data, error: rpcError } = await supabase.rpc('review_leave_request', {
      p_leave_id: reviewing.id,
      p_action: reviewing.action,
      p_comment: comment.trim() || null,
    })

    if (rpcError) {
      setError(rpcError.message)
    } else {
      const res = data as { status: string; attendance_rows_synced: number }
      setNotice(
        res.status === 'approved'
          ? `Approved - ${res.attendance_rows_synced} attendance day${res.attendance_rows_synced !== 1 ? 's' : ''} marked as leave`
          : 'Request rejected'
      )
      setReviewing(null)
      await fetchRows(filter)
    }
    setBusy(false)
  }

  async function openDocument(path: string) {
    const supabase = createClient()
    const { data } = await supabase.storage.from('staff-docs').createSignedUrl(path, 300)
    if (data?.signedUrl) window.open(data.signedUrl, '_blank')
  }

  if (!loading && allowed === false) {
    return (
      <div className="max-w-2xl">
        <div className="card">
          <h1 className="text-lg font-semibold text-slate-900 mb-1">Leave requests</h1>
          <p className="text-sm text-slate-500">
            Only a school admin or principal can review leave requests.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link
          href="/dashboard/staff"
          className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 transition-colors"
        >
          <ArrowLeft size={18} className="text-slate-600" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Leave requests</h1>
          <p className="text-slate-500 text-sm">Approving marks those days as leave automatically</p>
        </div>
      </div>

      {/* Filter chips */}
      <div className="flex gap-2 flex-wrap mb-5">
        {FILTERS.map(f => (
          <button key={f.value} onClick={() => handleFilter(f.value)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              filter === f.value
                ? 'bg-brand-600 text-white border-brand-600'
                : 'border-slate-200 text-slate-600 hover:bg-slate-50'
            }`}>
            {f.label}
          </button>
        ))}
      </div>

      {notice && <div className="bg-green-50 text-green-700 text-sm px-3 py-2 rounded-lg mb-4">{notice}</div>}
      {error && <div className="bg-red-50 text-red-600 text-sm px-3 py-2 rounded-lg mb-4">{error}</div>}

      {loading ? (
        <div className="card flex flex-col gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-20 bg-slate-100 rounded-lg animate-pulse" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="card text-center py-12">
          <p className="text-sm text-slate-400">
            {filter === 'pending' ? 'No pending requests - all caught up.' : 'No requests found.'}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map(l => (
            <div key={l.id} className="card">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-slate-900 text-sm">
                      {l.staff?.full_name ?? 'Staff member'}
                    </span>
                    <span className="font-mono text-[10px] text-slate-400">
                      {l.staff?.employee_id}
                    </span>
                    <span className={STATUS_BADGE[l.status] ?? 'badge-blue'}>{l.status}</span>
                  </div>
                  <p className="text-xs text-slate-500 mt-1 capitalize">
                    {l.leave_type} · {fmt(l.from_date)} → {fmt(l.to_date)} · {l.total_days} day{l.total_days !== 1 ? 's' : ''}
                  </p>
                  <p className="text-sm text-slate-600 mt-1.5">{l.reason}</p>
                  {l.document_path && (
                    <button onClick={() => openDocument(l.document_path as string)}
                      className="flex items-center gap-1 text-xs text-brand-600 hover:underline mt-1.5">
                      <FileText size={12} /> View document
                    </button>
                  )}
                  {l.admin_comment && (
                    <p className="text-xs text-slate-500 mt-1.5 bg-slate-50 rounded px-2 py-1">
                      Comment: {l.admin_comment}
                    </p>
                  )}
                </div>

                {l.status === 'pending' && reviewing?.id !== l.id && (
                  <div className="flex gap-2 shrink-0">
                    <button onClick={() => startReview(l.id, 'approve')}
                      className="flex items-center gap-1.5 bg-green-600 hover:bg-green-700 text-white text-xs font-medium px-3 py-2 rounded-lg">
                      <Check size={13} /> Approve
                    </button>
                    <button onClick={() => startReview(l.id, 'reject')}
                      className="flex items-center gap-1.5 bg-red-600 hover:bg-red-700 text-white text-xs font-medium px-3 py-2 rounded-lg">
                      <X size={13} /> Reject
                    </button>
                  </div>
                )}
              </div>

              {/* Inline confirm with optional comment */}
              {reviewing?.id === l.id && (
                <div className="mt-3 pt-3 border-t border-slate-100 flex flex-col gap-2">
                  <label className="label">
                    {reviewing.action === 'approve' ? 'Approve' : 'Reject'} with a comment (optional)
                  </label>
                  <div className="flex gap-2 flex-col sm:flex-row">
                    <input type="text" className="input flex-1"
                      placeholder={reviewing.action === 'approve' ? 'e.g. Get well soon' : 'e.g. Exams that week - please reschedule'}
                      value={comment} onChange={e => setComment(e.target.value)} />
                    <div className="flex gap-2">
                      <button onClick={confirmReview} disabled={busy}
                        className={`text-white text-sm font-medium px-5 py-2 rounded-lg disabled:opacity-60 ${
                          reviewing.action === 'approve'
                            ? 'bg-green-600 hover:bg-green-700'
                            : 'bg-red-600 hover:bg-red-700'
                        }`}>
                        {busy ? 'Saving...' : `Confirm ${reviewing.action}`}
                      </button>
                      <button onClick={() => setReviewing(null)} className="btn-secondary text-sm px-4">
                        Back
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
