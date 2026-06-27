'use client'

// FILE: app/(dashboard)/dashboard/fees/eod/page.tsx
// End-of-day cash drawer reconciliation
// Collector submits physical cash count → system computes expected → variance shown to admin

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { createClient } from '@/utils/supabase/client'
import {
  ArrowLeft, ClipboardCheck, CheckCircle2,
  AlertCircle, IndianRupee, AlertTriangle,
} from 'lucide-react'

interface EodClosure {
  id: string
  closure_date: string
  system_cash_total: number
  physical_cash_count: number
  variance: number
  status: string
  notes: string | null
  admin_notes: string | null
  created_at: string
  collector_profiles: { full_name: string } | null
}

function fmt(n: number) {
  return '₹' + Math.abs(Number(n)).toLocaleString('en-IN')
}

export default function EodPage() {
  const [todayClosure,   setTodayClosure]   = useState<EodClosure | null>(null)
  const [history,        setHistory]        = useState<EodClosure[]>([])
  const [loading,        setLoading]        = useState(true)
  const [isAdmin,        setIsAdmin]        = useState(false)
  const [mySystemCash,   setMySystemCash]   = useState<number | null>(null)

  // Form state
  const [physicalCount,  setPhysicalCount]  = useState('')
  const [notes,          setNotes]          = useState('')
  const [submitting,     setSubmitting]     = useState(false)
  const [submitError,    setSubmitError]    = useState('')
  const [result,         setResult]         = useState<{
    closure_id: string
    system_cash_total: number
    variance: number
  } | null>(null)

  const fetchData = useCallback(async () => {
    const supabase = createClient()
    const today = new Date().toISOString().split('T')[0]

    const profileRes = await supabase
      .from('profiles')
      .select('id, role, school_id')
      .single()
    const p       = profileRes.data as any
    const myId    = p?.id
    const sid     = p?.school_id
    const admin   = p?.role === 'school_admin'
    setIsAdmin(admin)

    // Check if today's closure already exists for this collector
    const todayRes = await supabase
      .from('eod_closures')
      .select('*')
      .eq('school_id', sid)
      .eq('collector_id', myId)
      .eq('closure_date', today)
      .maybeSingle()

    setTodayClosure((todayRes.data ?? null) as EodClosure | null)

    // Load recent EOD history
    const historyQuery = admin
      ? supabase
          .from('eod_closures')
          .select('*, collector_profiles:profiles!eod_closures_collector_id_fkey(full_name)')
          .eq('school_id', sid)
          .order('closure_date', { ascending: false })
          .limit(20)
      : supabase
          .from('eod_closures')
          .select('*, collector_profiles:profiles!eod_closures_collector_id_fkey(full_name)')
          .eq('school_id', sid)
          .eq('collector_id', myId)
          .order('closure_date', { ascending: false })
          .limit(10)

    const { data: histData } = await historyQuery
    setHistory((histData ?? []) as any as EodClosure[])

    // Compute collector's expected cash for today (cash payments only)
    // We DON'T show this before submission — only after, to prevent gaming
    // But we pre-fetch it so the RPC result is consistent
    setLoading(false)
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  async function handleSubmit() {
    const amount = parseFloat(physicalCount)
    if (!physicalCount || isNaN(amount) || amount < 0) {
      setSubmitError('Enter a valid cash amount (0 or more)')
      return
    }
    setSubmitting(true)
    setSubmitError('')

    const supabase = createClient()
    const { data, error } = await supabase.rpc('submit_eod_closure', {
      p_physical_cash_count: amount,
      p_notes:               notes || null,
    })

    if (error) { setSubmitError(error.message); setSubmitting(false); return }

    const row = Array.isArray(data) ? data[0] : data
    setResult({
      closure_id:        row.closure_id,
      system_cash_total: Number(row.system_cash_total),
      variance:          Number(row.variance),
    })
    setSubmitting(false)
    fetchData()
  }

  const today = new Date().toLocaleDateString('en-IN', {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
  })

  return (
    <div className="max-w-2xl mx-auto">

      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <Link href="/dashboard/fees" className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 text-slate-500">
          <ArrowLeft size={18} />
        </Link>
        <div>
          <h1 className="text-xl font-bold text-slate-900">EOD Cash Closure</h1>
          <p className="text-slate-400 text-xs mt-0.5">{today}</p>
        </div>
      </div>

      {loading ? (
        <div className="flex flex-col gap-3">
          {[1, 2].map(i => <div key={i} className="card h-24 animate-pulse bg-slate-50" />)}
        </div>
      ) : result ? (
        /* ── Result screen (shown immediately after submission) ── */
        <div className="flex flex-col gap-4">
          <div className={`rounded-2xl p-5 text-center border ${
            result.variance === 0 ? 'bg-green-50 border-green-200' :
            result.variance < 0   ? 'bg-red-50 border-red-200' :
                                    'bg-amber-50 border-amber-200'
          }`}>
            {result.variance === 0
              ? <CheckCircle2 size={36} className="mx-auto text-green-500 mb-2" />
              : <AlertTriangle size={36} className={`mx-auto mb-2 ${result.variance < 0 ? 'text-red-500' : 'text-amber-500'}`} />}
            <p className="text-lg font-bold text-slate-900">
              {result.variance === 0 ? 'Cash balanced!' :
               result.variance < 0  ? 'Cash shortage' : 'Cash excess'}
            </p>
            {result.variance !== 0 && (
              <p className={`text-3xl font-extrabold mt-1 ${result.variance < 0 ? 'text-red-600' : 'text-amber-600'}`}>
                {result.variance < 0 ? '-' : '+'}{fmt(result.variance)}
              </p>
            )}
          </div>

          <div className="card p-4 flex flex-col gap-3">
            <div className="flex justify-between text-sm">
              <span className="text-slate-500">System expected (cash)</span>
              <span className="font-semibold">{fmt(result.system_cash_total)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-slate-500">Your physical count</span>
              <span className="font-semibold">{fmt(parseFloat(physicalCount))}</span>
            </div>
            <div className={`flex justify-between text-sm pt-2 border-t border-slate-100 font-bold ${
              result.variance === 0 ? 'text-green-600' :
              result.variance < 0  ? 'text-red-600' : 'text-amber-600'
            }`}>
              <span>Variance</span>
              <span>{result.variance >= 0 ? '+' : '-'}{fmt(result.variance)}</span>
            </div>
          </div>

          {result.variance !== 0 && (
            <div className="bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm text-slate-600">
              {result.variance < 0
                ? 'A shortage report has been recorded. The admin will review this.'
                : 'An excess report has been recorded. Please hand over the extra cash to the admin.'}
            </div>
          )}

          <Link href="/dashboard/fees" className="btn-secondary text-center text-sm py-2.5">
            Back to fees
          </Link>
        </div>
      ) : todayClosure ? (
        /* ── Already submitted today ── */
        <div className="flex flex-col gap-4">
          <div className={`rounded-2xl p-5 border ${
            todayClosure.variance === 0  ? 'bg-green-50 border-green-200' :
            todayClosure.variance < 0    ? 'bg-red-50 border-red-200' :
                                           'bg-amber-50 border-amber-200'
          }`}>
            <div className="flex items-center gap-2 mb-3">
              <CheckCircle2 size={18} className="text-green-600 shrink-0" />
              <p className="font-semibold text-slate-800">Today's closure already submitted</p>
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-slate-400 text-[10px] uppercase tracking-wide">System cash</p>
                <p className="font-semibold">{fmt(todayClosure.system_cash_total)}</p>
              </div>
              <div>
                <p className="text-slate-400 text-[10px] uppercase tracking-wide">Physical count</p>
                <p className="font-semibold">{fmt(todayClosure.physical_cash_count)}</p>
              </div>
              <div className={`col-span-2 pt-2 border-t border-slate-200`}>
                <p className="text-slate-400 text-[10px] uppercase tracking-wide">Variance</p>
                <p className={`font-bold text-lg ${
                  todayClosure.variance === 0 ? 'text-green-600' :
                  todayClosure.variance < 0  ? 'text-red-600' : 'text-amber-600'
                }`}>
                  {todayClosure.variance >= 0 ? '+' : '-'}{fmt(todayClosure.variance)}
                </p>
              </div>
            </div>
            {todayClosure.admin_notes && (
              <div className="mt-3 pt-3 border-t border-slate-200">
                <p className="text-[10px] text-slate-400 uppercase tracking-wide mb-1">Admin notes</p>
                <p className="text-sm text-slate-700">{todayClosure.admin_notes}</p>
              </div>
            )}
          </div>
        </div>
      ) : (
        /* ── Submission form ── */
        <div className="flex flex-col gap-4">
          <div className="card p-4">
            <div className="flex items-center gap-2 mb-4">
              <ClipboardCheck size={17} className="text-brand-600" />
              <h2 className="font-semibold text-slate-800">Submit end-of-day cash count</h2>
            </div>

            <div className="bg-amber-50 border border-amber-100 rounded-xl px-3 py-2.5 mb-4 text-xs text-amber-700">
              Count your physical cash drawer carefully before submitting. You cannot change this after submission.
            </div>

            <div className="flex flex-col gap-4">
              <div>
                <label className="label">Physical cash in drawer *</label>
                <div className="relative">
                  <IndianRupee size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    type="text"
                    inputMode="numeric"
                    className="input pl-8 text-2xl font-bold"
                    placeholder="0"
                    value={physicalCount}
                    onChange={e => {
                      const val = e.target.value
                      if (val === '' || /^\d+(\.\d{0,2})?$/.test(val)) {
                        setPhysicalCount(val)
                        setSubmitError('')
                      }
                    }}
                  />
                </div>
                <p className="text-xs text-slate-400 mt-1">
                  Include all cash collected today. Do not include UPI/card/cheque.
                </p>
              </div>

              <div>
                <label className="label">Notes (optional)</label>
                <textarea
                  className="input resize-none"
                  rows={2}
                  placeholder="Any notes for the admin (e.g. denomination breakdown)"
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                />
              </div>

              {submitError && (
                <div className="flex items-center gap-2 bg-red-50 text-red-600 text-sm px-3 py-2.5 rounded-lg">
                  <AlertCircle size={14} className="shrink-0" /> {submitError}
                </div>
              )}

              <button
                onClick={handleSubmit}
                disabled={submitting || !physicalCount}
                className="btn-primary w-full py-3 font-semibold disabled:opacity-50"
              >
                {submitting
                  ? <span className="flex items-center justify-center gap-2">
                      <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      Submitting…
                    </span>
                  : 'Submit EOD Closure'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── History (admin sees all, collector sees own) ── */}
      {history.length > 0 && (
        <div className="mt-6">
          <h2 className="text-sm font-semibold text-slate-700 mb-3">
            {isAdmin ? 'All EOD closures' : 'Your EOD history'}
          </h2>
          <div className="flex flex-col gap-2">
            {history.map(h => {
              const isSameAsToday = h.closure_date === new Date().toISOString().split('T')[0]
              if (isSameAsToday && !result) return null  // already shown above
              return (
                <div key={h.id} className="card p-3 flex items-center justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-slate-800">
                        {new Date(h.closure_date).toLocaleDateString('en-IN', {
                          day: '2-digit', month: 'short', year: 'numeric',
                        })}
                      </p>
                      {isAdmin && (h.collector_profiles as any)?.full_name && (
                        <span className="text-xs text-slate-400">· {(h.collector_profiles as any).full_name}</span>
                      )}
                    </div>
                    <p className="text-xs text-slate-400">
                      System: {fmt(h.system_cash_total)} · Physical: {fmt(h.physical_cash_count)}
                    </p>
                  </div>
                  <div className={`text-right shrink-0 font-bold ${
                    h.variance === 0 ? 'text-green-600' :
                    h.variance < 0  ? 'text-red-500' : 'text-amber-600'
                  }`}>
                    <p className="text-sm">{h.variance >= 0 ? '+' : '-'}{fmt(h.variance)}</p>
                    <p className="text-[10px] font-normal text-slate-400 capitalize">{h.status}</p>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

    </div>
  )
}
