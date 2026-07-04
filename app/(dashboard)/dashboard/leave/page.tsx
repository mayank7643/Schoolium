'use client'

// FILE: app/(dashboard)/dashboard/leave/page.tsx
//
// My Leave (chat17 Module 5) - self-service for every staff member
// (teacher, accountant, receptionist, principal, other staff).
//   - apply for leave via the apply_leave RPC (overlap/date rules
//     are validated server-side; errors surface as friendly text)
//   - optional supporting document upload to the private staff-docs
//     bucket, path {school_id}/{staff_id}/leave-<ts>.<ext>
//   - history with status badges, cancel while pending, view the
//     uploaded document via a short-lived signed URL
//
// UPLOAD LIMIT: MAX_UPLOAD_KB is the client-side check for a clear
// message. The REAL enforcement is the bucket's file_size_limit set
// in chat17b - keep the two values in sync.

import { useState, useEffect, useCallback, useRef } from 'react'
import { createClient } from '@/utils/supabase/client'
import { CalendarPlus, FileText, Paperclip, X } from 'lucide-react'
import type { LeaveRequest, LeaveType } from '@/types'

const MAX_UPLOAD_KB = 500 // keep in sync with chat17b bucket file_size_limit
const ALLOWED_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
const ALLOWED_EXT_LABEL = 'PDF, JPG, PNG or WebP'

const LEAVE_TYPES: { value: LeaveType; label: string }[] = [
  { value: 'casual', label: 'Casual leave' },
  { value: 'sick',   label: 'Sick leave' },
  { value: 'earned', label: 'Earned leave' },
  { value: 'unpaid', label: 'Unpaid leave' },
  { value: 'other',  label: 'Other' },
]

const STATUS_BADGE: Record<string, string> = {
  pending: 'badge-yellow', approved: 'badge-green',
  rejected: 'badge-red', cancelled: 'badge-red',
}

function fmt(d: string) {
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

function todayStr() {
  return new Date().toISOString().split('T')[0]
}

export default function MyLeavePage() {
  const [staffId, setStaffId]   = useState<string | null>(null)
  const [schoolId, setSchoolId] = useState<string | null>(null)
  const [noStaff, setNoStaff]   = useState(false)
  const [loading, setLoading]   = useState(true)
  const [leaves, setLeaves]     = useState<LeaveRequest[]>([])

  const [form, setForm] = useState({
    leave_type: 'casual' as LeaveType,
    from_date: todayStr(),
    to_date: todayStr(),
    reason: '',
  })
  const [file, setFile]           = useState<File | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError]         = useState('')
  const [message, setMessage]     = useState('')
  const [busyId, setBusyId]       = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const fetchLeaves = useCallback(async () => {
    const supabase = createClient()
    const { data } = await supabase
      .from('leave_requests')
      .select('id, leave_type, from_date, to_date, total_days, reason, status, admin_comment, document_path, created_at')
      .order('created_at', { ascending: false })
      .limit(30)
    setLeaves((data ?? []) as any as LeaveRequest[])
  }, [])

  useEffect(() => {
    async function init() {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { setLoading(false); return }

      const [{ data: staff }, { data: profile }] = await Promise.all([
        supabase.from('staff').select('id').eq('profile_id', user.id).maybeSingle(),
        supabase.from('profiles').select('school_id').eq('id', user.id).single(),
      ])

      if (!staff) { setNoStaff(true); setLoading(false); return }
      setStaffId(staff.id)
      setSchoolId(profile?.school_id ?? null)
      await fetchLeaves()
      setLoading(false)
    }
    init()
  }, [fetchLeaves])

  function handleFilePick(f: File | null) {
    setError('')
    if (!f) { setFile(null); return }
    if (!ALLOWED_TYPES.includes(f.type)) {
      setError(`Only ${ALLOWED_EXT_LABEL} files are allowed`)
      if (fileInputRef.current) fileInputRef.current.value = ''
      return
    }
    if (f.size > MAX_UPLOAD_KB * 1024) {
      setError(`File is ${Math.round(f.size / 1024)} KB - the limit is ${MAX_UPLOAD_KB} KB. Compress or take a smaller photo.`)
      if (fileInputRef.current) fileInputRef.current.value = ''
      return
    }
    setFile(f)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!staffId || !schoolId) return
    if (form.reason.trim().length < 3) { setError('Please give a reason'); return }
    if (!form.from_date || !form.to_date) { setError('Pick the dates'); return }

    setSubmitting(true)
    setError('')
    setMessage('')

    const supabase = createClient()
    let documentPath: string | null = null

    // 1. upload the document first (if any) - bucket enforces the
    //    real size/type limits server-side (chat17b)
    if (file) {
      const ext = file.name.split('.').pop()?.toLowerCase() ?? 'pdf'
      const path = `${schoolId}/${staffId}/leave-${Date.now()}.${ext}`
      const { error: upError } = await supabase.storage
        .from('staff-docs')
        .upload(path, file, { contentType: file.type, upsert: false })

      if (upError) {
        setError(
          /exceeded|too large|payload/i.test(upError.message)
            ? `Upload rejected - files must be under ${MAX_UPLOAD_KB} KB`
            : upError.message
        )
        setSubmitting(false)
        return
      }
      documentPath = path
    }

    // 2. create the request (server validates dates + overlaps)
    const { error: rpcError } = await supabase.rpc('apply_leave', {
      p_leave_type: form.leave_type,
      p_from_date: form.from_date,
      p_to_date: form.to_date,
      p_reason: form.reason.trim(),
      p_document_path: documentPath,
    })

    if (rpcError) {
      setError(rpcError.message)
      // best-effort cleanup of the orphan upload
      if (documentPath) {
        await supabase.storage.from('staff-docs').remove([documentPath]).catch(() => {})
      }
    } else {
      setMessage('Leave request submitted')
      setForm({ leave_type: 'casual', from_date: todayStr(), to_date: todayStr(), reason: '' })
      setFile(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
      await fetchLeaves()
    }
    setSubmitting(false)
  }

  async function handleCancel(id: string) {
    if (!window.confirm('Cancel this leave request?')) return
    setBusyId(id)
    const supabase = createClient()
    const { error: rpcError } = await supabase.rpc('cancel_leave', { p_leave_id: id })
    if (rpcError) setError(rpcError.message)
    await fetchLeaves()
    setBusyId('')
  }

  async function openDocument(path: string) {
    const supabase = createClient()
    const { data } = await supabase.storage.from('staff-docs').createSignedUrl(path, 300)
    if (data?.signedUrl) window.open(data.signedUrl, '_blank')
  }

  if (!loading && noStaff) {
    return (
      <div className="max-w-2xl">
        <div className="card">
          <h1 className="text-lg font-semibold text-slate-900 mb-1">My leave</h1>
          <p className="text-sm text-slate-500">
            No staff record is linked to this account, so leave requests are not available here.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">My leave</h1>
        <p className="text-slate-500 text-sm">Apply for leave and track your requests</p>
      </div>

      {/* Apply */}
      <form onSubmit={handleSubmit} className="card flex flex-col gap-4 mb-6">
        <h2 className="font-semibold text-slate-800 flex items-center gap-2">
          <CalendarPlus size={16} className="text-slate-400" /> Apply for leave
        </h2>

        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2 sm:col-span-1">
            <label className="label">Leave type</label>
            <select className="input" value={form.leave_type}
              onChange={e => setForm({ ...form, leave_type: e.target.value as LeaveType })}>
              {LEAVE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">From</label>
            <input type="date" className="input" value={form.from_date}
              onChange={e => setForm({
                ...form,
                from_date: e.target.value,
                to_date: form.to_date < e.target.value ? e.target.value : form.to_date,
              })} />
          </div>
          <div>
            <label className="label">To</label>
            <input type="date" className="input" value={form.to_date} min={form.from_date}
              onChange={e => setForm({ ...form, to_date: e.target.value })} />
          </div>
        </div>

        <div>
          <label className="label">Reason</label>
          <textarea className="input" rows={2} placeholder="e.g. Fever - doctor advised rest"
            value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} />
        </div>

        <div>
          <label className="label">Supporting document (optional)</label>
          {file ? (
            <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
              <Paperclip size={14} className="text-slate-400 shrink-0" />
              <span className="text-sm text-slate-700 truncate flex-1">{file.name}</span>
              <span className="text-xs text-slate-400">{Math.round(file.size / 1024)} KB</span>
              <button type="button"
                onClick={() => { setFile(null); if (fileInputRef.current) fileInputRef.current.value = '' }}
                className="text-slate-400 hover:text-red-500">
                <X size={14} />
              </button>
            </div>
          ) : (
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,.webp"
              className="input"
              onChange={e => handleFilePick(e.target.files?.[0] ?? null)}
            />
          )}
          <p className="text-xs text-slate-400 mt-1">
            {ALLOWED_EXT_LABEL}, max {MAX_UPLOAD_KB} KB (e.g. medical certificate)
          </p>
        </div>

        {error && <div className="bg-red-50 text-red-600 text-sm px-3 py-2 rounded-lg">{error}</div>}
        {message && <div className="bg-green-50 text-green-700 text-sm px-3 py-2 rounded-lg">{message}</div>}

        <button type="submit" className="btn-primary py-2.5" disabled={submitting}>
          {submitting ? 'Submitting...' : 'Submit request'}
        </button>
      </form>

      {/* History */}
      <h2 className="font-semibold text-slate-800 mb-3">Leave history</h2>
      {loading ? (
        <div className="card flex flex-col gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-14 bg-slate-100 rounded-lg animate-pulse" />
          ))}
        </div>
      ) : leaves.length === 0 ? (
        <div className="card text-center py-10">
          <p className="text-sm text-slate-400">No leave requests yet.</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-slate-100 shadow-sm overflow-hidden">
          {leaves.map(l => (
            <div key={l.id} className="px-4 py-3 border-b border-slate-50 last:border-0">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="text-sm font-medium text-slate-800 capitalize">
                  {l.leave_type} · {l.total_days} day{l.total_days !== 1 ? 's' : ''}
                </span>
                <div className="flex items-center gap-2">
                  <span className={STATUS_BADGE[l.status] ?? 'badge-blue'}>{l.status}</span>
                  {l.status === 'pending' && (
                    <button onClick={() => handleCancel(l.id)} disabled={busyId === l.id}
                      className="text-xs text-red-500 hover:text-red-700 font-medium">
                      Cancel
                    </button>
                  )}
                </div>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                {fmt(l.from_date)} → {fmt(l.to_date)} · {l.reason}
              </p>
              {l.document_path && (
                <button onClick={() => openDocument(l.document_path as string)}
                  className="flex items-center gap-1 text-xs text-brand-600 hover:underline mt-1">
                  <FileText size={12} /> View document
                </button>
              )}
              {l.admin_comment && (
                <p className="text-xs text-slate-500 mt-1.5 bg-slate-50 rounded px-2 py-1">
                  Admin: {l.admin_comment}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
