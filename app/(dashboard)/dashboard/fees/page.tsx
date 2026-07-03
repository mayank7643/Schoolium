'use client'

// FILE: app/(dashboard)/dashboard/fees/page.tsx
// Sprint 3 — Navigation hub. fees table gone. All reads from fee_payments.

import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { createClient } from '@/utils/supabase/client'
import {
  IndianRupee, Settings2, HandCoins, AlertTriangle,
  Zap, X, CheckCircle2, AlertCircle, RotateCcw,
  ClipboardCheck, TrendingUp, Clock, Printer, Eye, ChevronDown,
} from 'lucide-react'
import { buildReceiptHTML } from '@/app/lib/receipt'

interface RecentPayment {
  id: string
  amount_paid: number
  payment_method: string
  receipt_number: string | null
  paid_date: string
  created_at: string | null
  reversal_status: string | null
  students: {
    full_name: string
    student_uid: string | null
    father_name: string | null
    address: string | null
    classes: { name: string; section: string | null } | { name: string; section: string | null }[] | null
  } | null
  fee_dues: { label: string; source: string; month: string | null } | null
}

// Payments grouped by receipt number — one collection session = one row
interface GroupedPayment {
  receipt_number: string | null
  total_amount: number
  payment_method: string
  paid_date: string
  generated_at: string
  student_name: string
  student_uid: string | null
  student_father: string | null
  student_address: string | null
  student_class: string | null
  lines: RecentPayment[]       // all fee_payments rows in this session
  reversal_status: string | null  // worst status across all lines
  any_manual: boolean
  any_reversed: boolean
  any_pending: boolean
}

interface PendingReversal {
  id: string
  reason: string
  requested_at: string
  fee_payments: {
    amount_paid: number
    receipt_number: string | null
    students: { full_name: string } | null
  } | null
}

interface StatsRow {
  month_collection:    number
  total_pending:       number
  defaulters_count:    number
  total_collected_ytd: number
}

function fmt(n: number) {
  return '₹' + Number(n).toLocaleString('en-IN')
}

function fmtDate(d: string) {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
  })
}

const PAGE_SIZE = 100  // recent payments loaded per "Load more" click

export default function FeesPage() {
  const [payments,         setPayments]         = useState<RecentPayment[]>([])
  const [pendingReversals, setPendingReversals] = useState<PendingReversal[]>([])
  const [stats,            setStats]            = useState<StatsRow | null>(null)
  const [school,           setSchool]           = useState<{ name: string; phone: string | null } | null>(null)
  const [expandedReceipt,  setExpandedReceipt]  = useState<string | null>(null)
  const printRef = useRef<HTMLIFrameElement>(null)
  const [isAdmin,          setIsAdmin]          = useState(false)
  const [loading,          setLoading]          = useState(true)
  const [generating,       setGenerating]       = useState(false)
  const [genResult,        setGenResult]        = useState<{ generated: number; skipped: number } | null>(null)
  const [genError,         setGenError]         = useState('')

  // Inline reversal request on each payment row
  const [reversalOpenKey,   setReversalOpenKey]   = useState<string | null>(null)
  const [reversalSelected,  setReversalSelected]  = useState<string[]>([])
  const [reversalReason,    setReversalReason]    = useState('')
  const [reversalSaving,    setReversalSaving]    = useState(false)
  const [reversalError,     setReversalError]     = useState('')
  const [reversalDoneKeys,  setReversalDoneKeys]  = useState<string[]>([])
  const [schoolId,          setSchoolId]          = useState<string | null>(null)
  const [hasMore,           setHasMore]           = useState(false)
  const [loadingMore,       setLoadingMore]       = useState(false)

  const fetchData = useCallback(async () => {
    const supabase = createClient()
    const profileRes = await supabase.from('profiles').select('school_id, role').single()
    const p   = profileRes.data as any
    const sid = p?.school_id
    const admin = p?.role === 'school_admin'
    setIsAdmin(admin)

    const [paymentsRes, reversalsRes, statsRes, schoolRes] = await Promise.all([
      supabase
        .from('fee_payments')
        .select('id, amount_paid, payment_method, receipt_number, paid_date, created_at, reversal_status, students(full_name, student_uid, father_name, address, classes(name, section)), fee_dues(label, source, month)')
        .eq('school_id', sid)
        .order('created_at', { ascending: false })
        .range(0, PAGE_SIZE - 1),
      admin
        ? supabase
            .from('reversal_requests')
            .select('id, reason, requested_at, fee_payments!fee_payment_id(amount_paid, receipt_number, students(full_name))')
            .eq('school_id', sid)
            .eq('status', 'pending')
            .order('requested_at', { ascending: false })
        : Promise.resolve({ data: [] }),
      supabase.rpc('get_fee_dashboard_stats', { p_school_id: sid }),
      supabase.from('schools').select('name, phone').eq('id', sid).single(),
    ])

    const firstPage = (paymentsRes.data ?? []) as any as RecentPayment[]
    setPayments(firstPage)
    setHasMore(firstPage.length === PAGE_SIZE)
    setSchoolId(sid ?? null)
    setPendingReversals((reversalsRes.data ?? []) as any as PendingReversal[])
    const statsData = ((statsRes as any).data ?? [])[0] as StatsRow | undefined
    setStats(statsData ?? null)
    setSchool(((schoolRes as any).data ?? null) as { name: string; phone: string | null } | null)
    setLoading(false)
  }, [])

  // Load the next 100 payments and append.
  async function loadMorePayments() {
    if (!schoolId || loadingMore) return
    setLoadingMore(true)
    const supabase = createClient()
    const from = payments.length
    const { data } = await supabase
      .from('fee_payments')
      .select('id, amount_paid, payment_method, receipt_number, paid_date, created_at, reversal_status, students(full_name, student_uid, father_name, address, classes(name, section)), fee_dues(label, source, month)')
      .eq('school_id', schoolId)
      .order('created_at', { ascending: false })
      .range(from, from + PAGE_SIZE - 1)
    const next = (data ?? []) as any as RecentPayment[]
    setPayments(prev => [...prev, ...next])
    setHasMore(next.length === PAGE_SIZE)
    setLoadingMore(false)
  }

  useEffect(() => { fetchData() }, [fetchData])

  async function handleGenerateAll() {
    if (!confirm('Generate dues for all active fee structures up to this month?\n\nAlready-generated dues will be skipped.')) return
    setGenerating(true); setGenResult(null); setGenError('')
    try {
      const supabase = createClient()
      const { data, error } = await supabase.rpc('trigger_manual_due_generation')
      if (error) { setGenError(error.message) } else {
        const rows = (data ?? []) as { generated_count: number; skipped_count: number }[]
        setGenResult({
          generated: rows.reduce((s, r) => s + (r.generated_count ?? 0), 0),
          skipped:   rows.reduce((s, r) => s + (r.skipped_count   ?? 0), 0),
        })
      }
    } catch { setGenError('Unexpected error — try again') }
    finally  { setGenerating(false) }
  }

  async function handleRequestReversal(rowKey: string, selectedIds: string[]) {
    if (selectedIds.length === 0) { setReversalError('Select at least one item to reverse'); return }
    if (!reversalReason.trim()) { setReversalError('Reason is required'); return }
    setReversalSaving(true); setReversalError('')
    const supabase = createClient()
    const { error } = await supabase.rpc('request_payment_reversals', {
      p_fee_payment_ids: selectedIds,
      p_reason:          reversalReason.trim(),
    })
    if (error) { setReversalError(error.message); setReversalSaving(false); return }
    setReversalDoneKeys(prev => [...prev, rowKey])
    setReversalOpenKey(null)
    setReversalReason('')
    setReversalSelected([])
    setReversalSaving(false)
    fetchData()
  }

  // Group payments by receipt_number — one collection session → one row
  // Counter-transactions (REV-) filtered out; shown via reversal_status badge
  const groupedPayments: GroupedPayment[] = (() => {
    const nonRev = payments.filter(p => !p.receipt_number?.startsWith('REV-'))
    const map: Record<string, RecentPayment[]> = {}
    for (const p of nonRev) {
      const key = p.receipt_number ?? p.id  // ungrouped if no receipt
      if (!map[key]) map[key] = []
      map[key].push(p)
    }
    return Object.values(map).map(rows => {
      const first = rows[0]
      const statuses = rows.map(r => r.reversal_status)
      const cls = Array.isArray(first.students?.classes)
        ? (first.students?.classes[0] ?? null)
        : (first.students?.classes ?? null)
      const className = cls
        ? cls.name + (cls.section ? ' - ' + cls.section : '')
        : null
      return {
        receipt_number: first.receipt_number,
        total_amount:   rows.reduce((s, r) => s + Number(r.amount_paid), 0),
        payment_method: first.payment_method,
        paid_date:      first.paid_date,
        generated_at:   first.created_at ?? (first.paid_date ? first.paid_date + 'T12:00:00' : new Date().toISOString()),
        student_name:   first.students?.full_name ?? '—',
        student_uid:    first.students?.student_uid ?? null,
        student_father: first.students?.father_name ?? null,
        student_address: first.students?.address ?? null,
        student_class:  className,
        lines:          rows,
        reversal_status: statuses.includes('reversal_requested') ? 'reversal_requested'
                       : statuses.includes('reversal_approved')  ? 'reversal_approved'
                       : null,
        any_manual:   rows.some(r => (r.fee_dues as any)?.source === 'manual'),
        any_reversed: statuses.some(s => s === 'reversal_approved'),
        any_pending:  statuses.some(s => s === 'reversal_requested'),
      }
    })
  })()

  // Rebuild and print a receipt for a past collection, straight from this list.
  function currentMonthStr(): string {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  }
  function printGroup(g: GroupedPayment) {
    if (!school) return
    const curMonth = currentMonthStr()
    const lines = g.lines.map(l => {
      const source = (l.fee_dues as any)?.source as string | undefined
      const month  = (l.fee_dues as any)?.month as string | null | undefined
      const isExtra = source === 'manual'
      const isArrear = !isExtra && !!month && month !== curMonth
      const baseLabel = (l.fee_dues as any)?.label ?? 'Fee payment'
      const monthSuffix = (isArrear && month)
        ? ` (${new Date(month + '-01T00:00:00').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })})`
        : ''
      return {
        label: baseLabel + monthSuffix,
        amount: Number(l.amount_paid),
        is_arrear: isArrear,
        is_extra: isExtra,
      }
    })
    const html = buildReceiptHTML({
      school:      { name: school.name, phone: school.phone },
      student:     {
        full_name:   g.student_name,
        student_uid: g.student_uid,
        father_name: g.student_father,
        address:     g.student_address,
      },
      lines,
      amountPaid:  g.total_amount,
      method:      g.payment_method,
      grandBalance: 0,   // historical balance not recomputed on a reprint
      generatedAt: g.generated_at,
    })
    // Print through the hidden in-page iframe (same mechanism as the collect
    // success screen) so only the receipt prints, not this dashboard page.
    const iframe = printRef.current
    if (!iframe?.contentWindow) return
    iframe.contentWindow.document.open()
    iframe.contentWindow.document.write(html)
    iframe.contentWindow.document.close()
    setTimeout(() => { iframe.contentWindow?.focus(); iframe.contentWindow?.print() }, 350)
  }

  return (
    <div className="max-w-5xl mx-auto">
      <iframe ref={printRef} style={{ display: 'none' }} title="receipt-print" />

      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Fees</h1>
          <p className="text-slate-500 text-sm mt-0.5">Fee collection and management</p>
        </div>
        <Link href="/dashboard/fees/collect" className="btn-primary flex items-center gap-2 text-sm">
          <HandCoins size={15} /> Collect Fee
        </Link>
      </div>

      {/* Pending reversal alert — admin only */}
      {isAdmin && pendingReversals.length > 0 && (
        <div className="border border-amber-200 bg-amber-50 rounded-2xl p-4 mb-5">
          <div className="flex items-center gap-2 mb-3">
            <AlertCircle size={16} className="text-amber-600 shrink-0" />
            <p className="font-semibold text-amber-800">
              {pendingReversals.length} reversal request{pendingReversals.length > 1 ? 's' : ''} pending your approval
            </p>
          </div>
          <div className="flex flex-col gap-2">
            {pendingReversals.map(r => {
              const fp = r.fee_payments as any
              return (
                <div key={r.id} className="bg-white border border-amber-100 rounded-xl px-3 py-2.5 flex items-center justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-800">
                      {fp?.students?.full_name ?? '—'} · {fp?.receipt_number ?? '—'}
                    </p>
                    <p className="text-xs text-slate-500 truncate">{r.reason}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {fp?.amount_paid && <span className="text-sm font-semibold text-red-600">{fmt(fp.amount_paid)}</span>}
                    <Link href="/dashboard/fees/reversals"
                      className="text-xs bg-amber-600 text-white px-3 py-1.5 rounded-lg hover:bg-amber-700 transition-colors">
                      Review
                    </Link>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Stats */}
      {!loading && stats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
          <div className="stat-card">
            <div className="w-8 h-8 bg-green-50 rounded-lg flex items-center justify-center mb-2">
              <IndianRupee size={15} className="text-green-600" />
            </div>
            <p className="text-xl font-bold text-slate-900">{fmt(stats.month_collection)}</p>
            <p className="text-xs text-slate-500">Collected this month</p>
          </div>
          <div className="stat-card">
            <div className="w-8 h-8 bg-yellow-50 rounded-lg flex items-center justify-center mb-2">
              <Clock size={15} className="text-yellow-600" />
            </div>
            <p className="text-xl font-bold text-slate-900">{fmt(stats.total_pending)}</p>
            <p className="text-xs text-slate-500">Outstanding</p>
          </div>
          <div className="stat-card">
            <div className="w-8 h-8 bg-red-50 rounded-lg flex items-center justify-center mb-2">
              <AlertTriangle size={15} className="text-red-500" />
            </div>
            <p className="text-xl font-bold text-red-500">{stats.defaulters_count}</p>
            <p className="text-xs text-slate-500">Defaulters</p>
          </div>
          <div className="stat-card">
            <div className="w-8 h-8 bg-blue-50 rounded-lg flex items-center justify-center mb-2">
              <TrendingUp size={15} className="text-blue-600" />
            </div>
            <p className="text-xl font-bold text-slate-900">{fmt(stats.total_collected_ytd)}</p>
            <p className="text-xs text-slate-500">Collected YTD</p>
          </div>
        </div>
      )}

      {/* Navigation actions */}
      <div className="flex flex-wrap gap-2 mb-5">
        <Link href="/dashboard/fees/structures" className="btn-secondary flex items-center gap-1.5 text-sm">
          <Settings2 size={14} /> Fee Structures
        </Link>
        <Link href="/dashboard/fees/defaulters" className="btn-secondary flex items-center gap-1.5 text-sm">
          <AlertTriangle size={14} /> Defaulters
        </Link>
        {isAdmin && (
          <Link href="/dashboard/fees/reversals" className="btn-secondary flex items-center gap-1.5 text-sm">
            <RotateCcw size={14} /> Reversals
            {pendingReversals.length > 0 && (
              <span className="ml-0.5 bg-red-500 text-white text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
                {pendingReversals.length}
              </span>
            )}
          </Link>
        )}
        <Link href="/dashboard/fees/eod" className="btn-secondary flex items-center gap-1.5 text-sm">
          <ClipboardCheck size={14} /> EOD Closure
        </Link>
        <button onClick={handleGenerateAll} disabled={generating}
          className="btn-secondary flex items-center gap-1.5 text-sm disabled:opacity-50">
          {generating
            ? <span className="w-3.5 h-3.5 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" />
            : <Zap size={14} />}
          {generating ? 'Generating…' : 'Generate Dues'}
        </button>
      </div>

      {/* Generate dues banners */}
      {genResult && (
        <div className="flex items-center gap-2 mb-4 text-sm text-green-700 bg-green-50 border border-green-200 px-3 py-2 rounded-lg">
          <CheckCircle2 size={14} className="shrink-0" />
          {genResult.generated === 0
            ? `All dues up to date — ${genResult.skipped} already existed`
            : `Generated ${genResult.generated} due${genResult.generated !== 1 ? 's' : ''} — ${genResult.skipped} already existed`}
          <button onClick={() => setGenResult(null)} className="ml-auto text-green-500 hover:text-green-700">
            <X size={13} />
          </button>
        </div>
      )}
      {genError && (
        <div className="flex items-center gap-2 mb-4 text-sm text-red-600 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">
          <AlertCircle size={14} className="shrink-0" /> {genError}
          <button onClick={() => setGenError('')} className="ml-auto text-red-400 hover:text-red-600"><X size={13} /></button>
        </div>
      )}

      {/* Recent payments */}
      <div className="card p-0 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <h2 className="text-sm font-semibold text-slate-700">Recent payments</h2>
          <Link href="/dashboard/fees/collect" className="text-xs text-brand-600 hover:underline">
            + Collect fee
          </Link>
        </div>

        {loading ? (
          <div className="divide-y divide-slate-50">
            {[1, 2, 3, 4, 5].map(i => (
              <div key={i} className="flex items-center gap-3 px-5 py-3 animate-pulse">
                <div className="w-8 h-8 bg-slate-100 rounded-full shrink-0" />
                <div className="flex-1">
                  <div className="h-3.5 w-36 bg-slate-100 rounded mb-1.5" />
                  <div className="h-3 w-24 bg-slate-100 rounded" />
                </div>
                <div className="h-4 w-16 bg-slate-100 rounded" />
              </div>
            ))}
          </div>
        ) : groupedPayments.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <IndianRupee size={28} className="mx-auto text-slate-300 mb-2" />
            <p className="text-sm text-slate-500">No payments recorded yet</p>
            <Link href="/dashboard/fees/collect" className="inline-block mt-3 btn-primary text-sm">
              Collect first payment
            </Link>
          </div>
        ) : (
          <div className="divide-y divide-slate-50">
            {groupedPayments.map(g => {
              const isReversed = g.any_reversed
              const isPending  = g.any_pending
              const rowKey     = g.receipt_number ?? g.lines[0]?.id ?? ''
              // Lines still eligible to reverse (not already reversed / pending)
              const reversibleLines = g.lines.filter(l => !l.reversal_status || l.reversal_status === 'reversal_rejected')
              const isDone     = reversalDoneKeys.includes(rowKey)
              const isOpen     = reversalOpenKey === rowKey
              const isExpanded = expandedReceipt === rowKey
              return (
                <div key={g.receipt_number ?? g.lines[0]?.id} className="px-5 py-3">
                  <div className={`flex items-center gap-3 ${isReversed ? 'opacity-50' : ''}`}>
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${isReversed ? 'bg-slate-100' : 'bg-brand-50'}`}>
                      <span className={`font-semibold text-xs ${isReversed ? 'text-slate-400' : 'text-brand-700'}`}>
                        {(g.student_name ?? '?').charAt(0).toUpperCase()}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-medium text-slate-800 truncate">{g.student_name}</p>
                        {g.student_class && <span className="text-[10px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded">{g.student_class}</span>}
                        {g.any_manual   && <span className="text-[10px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded">Manual</span>}
                        {isReversed     && <span className="badge-red">Reversed</span>}
                        {isPending      && <span className="badge-yellow">Reversal pending</span>}
                      </div>
                      <p className="text-xs text-slate-400 truncate mt-0.5">
                        {g.lines.length} item{g.lines.length !== 1 ? 's' : ''}
                        {g.receipt_number ? ` · ${g.receipt_number}` : ''}
                        {g.paid_date ? ` · ${fmtDate(g.paid_date)}` : ''}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className={`text-sm font-semibold ${isReversed ? 'text-slate-400 line-through' : 'text-green-600'}`}>
                        {fmt(g.total_amount)}
                      </p>
                      <p className="text-[10px] text-slate-400 capitalize">{g.payment_method?.replace('_', ' ')}</p>
                    </div>
                  </div>

                  {/* Actions: print receipt + view breakdown */}
                  <div className="flex items-center gap-4 mt-1.5 pl-11">
                    {!isReversed && (
                      <button
                        onClick={() => printGroup(g)}
                        className="inline-flex items-center gap-1 text-[11px] text-brand-600 hover:text-brand-700 font-medium"
                      >
                        <Printer size={12} /> Print receipt
                      </button>
                    )}
                    <button
                      onClick={() => setExpandedReceipt(isExpanded ? null : rowKey)}
                      className="inline-flex items-center gap-1 text-[11px] text-slate-500 hover:text-slate-700"
                    >
                      <Eye size={12} /> {isExpanded ? 'Hide' : 'View'} breakdown
                      <ChevronDown size={12} className={isExpanded ? 'rotate-180 transition-transform' : 'transition-transform'} />
                    </button>
                  </div>
                  {isExpanded && (
                    <div className="mt-2 ml-11 rounded-lg bg-slate-50 border border-slate-100 px-3 py-2 flex flex-col gap-1">
                      {g.lines.map(l => (
                        <div key={l.id} className="flex items-center justify-between text-[11px] text-slate-600">
                          <span className="truncate">{(l.fee_dues as any)?.label ?? 'Fee payment'}</span>
                          <span className="font-medium shrink-0">{fmt(l.amount_paid)}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Inline reversal request */}
                  {!isReversed && !isPending && isDone && (
                    <div className="flex items-center gap-2 text-xs text-amber-600 bg-amber-50 px-3 py-1.5 rounded-lg mt-1">
                      <AlertCircle size={11} className="shrink-0" />
                      Reversal requested — awaiting admin approval
                    </div>
                  )}
                  {!isReversed && !isPending && !isDone && isOpen && (
                    <div className="mt-2 border border-red-100 bg-red-50 rounded-xl p-3 flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <p className="text-xs font-semibold text-red-700">Request reversal</p>
                        <button
                          onClick={() => { setReversalOpenKey(null); setReversalReason(''); setReversalSelected([]); setReversalError('') }}
                          className="text-red-300 hover:text-red-500"
                        >
                          <X size={13} />
                        </button>
                      </div>
                      <p className="text-[10px] text-red-600 bg-red-100 px-2 py-1 rounded">
                        Tick the items to reverse (all ticked = full reversal). Not reversed until admin approves.
                      </p>

                      {/* Line selection */}
                      <div className="rounded-lg border border-red-100 bg-white divide-y divide-red-50">
                        {reversibleLines.map(l => {
                          const checked = reversalSelected.includes(l.id)
                          return (
                            <label key={l.id} className="flex items-center gap-2 px-2.5 py-2 cursor-pointer text-xs">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => setReversalSelected(prev =>
                                  prev.includes(l.id) ? prev.filter(x => x !== l.id) : [...prev, l.id]
                                )}
                                className="accent-red-500"
                              />
                              <span className="flex-1 truncate text-slate-700">{(l.fee_dues as any)?.label ?? 'Fee payment'}</span>
                              <span className="font-medium text-slate-800 shrink-0">{fmt(l.amount_paid)}</span>
                            </label>
                          )
                        })}
                        <div className="flex items-center justify-between px-2.5 py-2 bg-red-50 text-xs">
                          <button
                            type="button"
                            onClick={() => setReversalSelected(
                              reversalSelected.length === reversibleLines.length ? [] : reversibleLines.map(l => l.id)
                            )}
                            className="text-red-500 hover:text-red-700 font-medium"
                          >
                            {reversalSelected.length === reversibleLines.length ? 'Clear all' : 'Select all'}
                          </button>
                          <span className="font-bold text-red-600">
                            Reversing {fmt(reversibleLines.filter(l => reversalSelected.includes(l.id)).reduce((s, l) => s + Number(l.amount_paid), 0))}
                          </span>
                        </div>
                      </div>

                      <textarea
                        className="input resize-none text-sm"
                        rows={2}
                        placeholder="Reason for reversal (required) *"
                        value={reversalReason}
                        onChange={e => { setReversalReason(e.target.value); setReversalError('') }}
                      />
                      {reversalError && (
                        <p className="text-xs text-red-600 flex items-center gap-1">
                          <AlertCircle size={11} className="shrink-0" /> {reversalError}
                        </p>
                      )}
                      <button
                        onClick={() => handleRequestReversal(rowKey, reversalSelected)}
                        disabled={reversalSaving}
                        className="w-full py-1.5 text-xs font-semibold bg-red-500 text-white rounded-lg hover:bg-red-600 disabled:opacity-50"
                      >
                        {reversalSaving
                          ? <span className="flex items-center justify-center gap-1">
                              <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                              Submitting…
                            </span>
                          : 'Submit reversal request'}
                      </button>
                    </div>
                  )}
                  {!isReversed && !isPending && !isDone && !isOpen && (
                    <button
                      onClick={() => { setReversalOpenKey(rowKey); setReversalSelected(reversibleLines.map(l => l.id)); setReversalReason(''); setReversalError('') }}
                      className="mt-1 text-[11px] text-red-400 hover:text-red-600 transition-colors"
                    >
                      Made a mistake? Request reversal →
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
        {!loading && hasMore && (
          <div className="px-5 py-3 border-t border-slate-100">
            <button
              onClick={loadMorePayments}
              disabled={loadingMore}
              className="w-full py-2 text-sm font-medium text-brand-600 hover:bg-brand-50 rounded-lg disabled:opacity-50 transition-colors"
            >
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </div>

    </div>
  )
}
