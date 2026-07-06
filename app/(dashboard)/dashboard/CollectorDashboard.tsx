// FILE: app/(dashboard)/dashboard/CollectorDashboard.tsx
//
// Personal dashboard for the accountant / fee collector role. Server
// component rendered by the dashboard page when role === 'collector'.
// Everything is scoped to THIS collector (fee_payments.collected_by =
// them, own eod_closures) plus a little school-wide context (defaulters
// / outstanding) that is the collector's work queue. Reads go through
// the collector-scoped RLS + RPCs added in chat20.

import { createClient } from '@/utils/supabase/server'
import Link from 'next/link'
import {
  IndianRupee, Banknote, AlertCircle, ArrowRight, CalendarCheck,
  HandCoins, FileBarChart, ClipboardCheck, CheckCircle2, ReceiptText,
} from 'lucide-react'

function fmtINR(n: number) {
  return `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`
}

// IST calendar date regardless of server timezone
function istToday() {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().split('T')[0]
}

const ATT_LABEL: Record<string, { label: string; cls: string }> = {
  present:  { label: 'Present',  cls: 'badge-green'  },
  late:     { label: 'Late',     cls: 'badge-yellow' },
  half_day: { label: 'Half day', cls: 'badge-blue'   },
  absent:   { label: 'Absent',   cls: 'badge-red'    },
  leave:    { label: 'On leave', cls: 'badge-yellow' },
}

interface PaymentRow {
  id: string
  amount_paid: number
  payment_method: string
  paid_date: string
  receipt_number: string | null
  reversal_status: string | null
  created_at: string | null
  students: { full_name: string; student_uid: string | null } | null
  fee_dues: { label: string } | null
}

export default async function CollectorDashboard({
  userId,
  schoolId,
  schoolName,
}: {
  userId: string
  schoolId: string
  schoolName: string
}) {
  const supabase = await createClient()

  const today      = istToday()
  const month      = today.slice(0, 7)
  const monthStart = month + '-01'

  // Need the staff id first - attendance is keyed by staff_id.
  const { data: staffData } = await supabase
    .from('staff')
    .select('id, full_name, designation')
    .eq('profile_id', userId)
    .maybeSingle()
  const staff   = staffData as { id: string; full_name: string; designation: string | null } | null
  const staffId = staff?.id ?? null

  const [monthRes, eodRes, statsRes, attRes, attSummaryRes] = await Promise.all([
    // This collector's own payments this month (newest first)
    supabase
      .from('fee_payments')
      .select('id, amount_paid, payment_method, paid_date, receipt_number, reversal_status, created_at, students(full_name, student_uid), fee_dues(label)')
      .eq('collected_by', userId)
      .gte('paid_date', monthStart)
      .lte('paid_date', today)
      .not('receipt_number', 'like', 'REV-%')
      .order('created_at', { ascending: false }),
    // Today's day-close for this collector, if any
    supabase
      .from('eod_closures')
      .select('id, system_cash_total, physical_cash_count')
      .eq('collector_id', userId)
      .eq('closure_date', today)
      .maybeSingle(),
    // School-wide fee context (defaulters / outstanding)
    supabase.rpc('get_fee_dashboard_stats', { p_school_id: schoolId }),
    // This collector's own attendance today
    staffId
      ? supabase
          .from('staff_attendance')
          .select('status, check_in_time, check_out_time')
          .eq('staff_id', staffId)
          .eq('attendance_date', today)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    // This month's attendance summary (own row only for non-admins)
    staffId
      ? supabase.rpc('get_staff_attendance_summary', { p_month: month })
      : Promise.resolve({ data: null }),
  ])

  const rows  = (monthRes.data ?? []) as unknown as PaymentRow[]

  // Approved reversals don't count as money collected
  const active   = rows.filter(r => r.reversal_status !== 'reversal_approved')
  const todayRows = active.filter(r => r.paid_date === today)

  const monthTotal    = active.reduce((s, r) => s + Number(r.amount_paid), 0)
  const todayTotal    = todayRows.reduce((s, r) => s + Number(r.amount_paid), 0)
  const todayCash     = todayRows
    .filter(r => r.payment_method === 'cash')
    .reduce((s, r) => s + Number(r.amount_paid), 0)
  const todayReceipts = new Set(todayRows.map(r => r.receipt_number ?? r.id)).size
  const monthReceipts = new Set(active.map(r => r.receipt_number ?? r.id)).size

  const eod       = eodRes.data as { system_cash_total: number; physical_cash_count: number } | null
  const eodClosed = !!eod
  const variance  = eod ? Number(eod.physical_cash_count) - Number(eod.system_cash_total) : null

  const stats       = (statsRes.data as any)?.[0] ?? null
  const defaulters  = Number(stats?.defaulters_count ?? 0)
  const outstanding = Number(stats?.total_pending ?? 0)

  // My attendance (own record only)
  const todayAtt = (attRes.data ?? null) as
    { status: string; check_in_time: string | null; check_out_time: string | null } | null
  const attRows  = (attSummaryRes.data ?? []) as any[]
  const myMonth  = attRows.find(r => r.staff_id === staffId) ?? attRows[0] ?? null
  const attBadge = todayAtt ? (ATT_LABEL[todayAtt.status] ?? ATT_LABEL.present) : null

  // Group this collector's payments by receipt → one collection per row
  const recMap: Record<string, PaymentRow[]> = {}
  const recOrder: string[] = []
  for (const p of active) {
    const key = p.receipt_number ?? p.id
    if (!recMap[key]) { recMap[key] = []; recOrder.push(key) }
    recMap[key].push(p)
  }
  const recent = recOrder.slice(0, 6).map(key => {
    const rs = recMap[key]
    const f  = rs[0]
    return {
      key,
      name:   f.students?.full_name ?? '—',
      label:  rs.length > 1 ? `${rs.length} items` : (f.fee_dues?.label ?? 'Fee payment'),
      amount: rs.reduce((s, r) => s + Number(r.amount_paid), 0),
      date:   f.paid_date,
      method: f.payment_method,
    }
  })

  const firstName = staff?.full_name?.split(' ')[0] ?? 'there'
  const dateLabel = new Date().toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  })

  return (
    <div className="max-w-5xl mx-auto">

      {/* Greeting */}
      <div className="mb-6">
        <h1 className="text-xl lg:text-2xl font-bold text-slate-900">
          Hello, {firstName}
        </h1>
        <p className="text-slate-500 text-sm mt-0.5">
          {staff?.designation ? `${staff.designation} · ` : 'Accountant · '}{schoolName} · {dateLabel}
        </p>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-4 mb-5">

        {/* Collected today (mine) */}
        <Link href="/dashboard/fees/collect" className="stat-card hover:shadow-md transition-shadow">
          <div className="w-8 h-8 rounded-lg bg-green-50 flex items-center justify-center mb-2">
            <IndianRupee size={16} className="text-green-600" />
          </div>
          <p className="text-xl lg:text-2xl font-bold text-slate-900 truncate">{fmtINR(todayTotal)}</p>
          <p className="text-xs text-slate-500">Collected today</p>
          <p className="text-xs text-slate-400 mt-1">
            {todayReceipts} receipt{todayReceipts !== 1 ? 's' : ''}
          </p>
        </Link>

        {/* Collected this month (mine) */}
        <div className="stat-card">
          <div className="w-8 h-8 rounded-lg bg-brand-50 flex items-center justify-center mb-2">
            <ReceiptText size={16} className="text-brand-600" />
          </div>
          <p className="text-xl lg:text-2xl font-bold text-slate-900 truncate">{fmtINR(monthTotal)}</p>
          <p className="text-xs text-slate-500">Collected this month</p>
          <p className="text-xs text-slate-400 mt-1">
            {monthReceipts} receipt{monthReceipts !== 1 ? 's' : ''}
          </p>
        </div>

        {/* Cash in hand today (mine) */}
        <Link href="/dashboard/fees/eod" className="stat-card hover:shadow-md transition-shadow">
          <div className="w-8 h-8 rounded-lg bg-amber-50 flex items-center justify-center mb-2">
            <Banknote size={16} className="text-amber-600" />
          </div>
          <p className="text-xl lg:text-2xl font-bold text-slate-900 truncate">{fmtINR(todayCash)}</p>
          <p className="text-xs text-slate-500">Cash to hand over</p>
          {eodClosed ? (
            <span className="badge-green mt-1 inline-flex items-center gap-1">
              <CheckCircle2 size={11} /> Day closed
            </span>
          ) : (
            <p className="text-xs text-amber-500 mt-1">Day open</p>
          )}
        </Link>

        {/* Defaulters (school work queue) */}
        <Link href="/dashboard/fees/defaulters" className="stat-card hover:shadow-md transition-shadow">
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center mb-2 ${
            defaulters > 0 ? 'bg-red-50' : 'bg-slate-50'
          }`}>
            <AlertCircle size={16} className={defaulters > 0 ? 'text-red-500' : 'text-slate-400'} />
          </div>
          <p className={`text-xl lg:text-2xl font-bold ${defaulters > 0 ? 'text-red-500' : 'text-slate-900'}`}>
            {defaulters}
          </p>
          <p className="text-xs text-slate-500">Defaulters</p>
          {outstanding > 0 && (
            <p className="text-xs text-red-400 mt-1">{fmtINR(outstanding)} due</p>
          )}
        </Link>

      </div>

      {/* Day-close / cash reconciliation */}
      <div className="card mb-5">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
            <ClipboardCheck size={16} className="text-slate-400" /> End-of-day cash
          </h2>
          <Link href="/dashboard/fees/eod" className="text-xs text-brand-600 hover:underline flex items-center gap-1">
            {eodClosed ? 'View' : 'Close the day'} <ArrowRight size={12} />
          </Link>
        </div>
        {eodClosed ? (
          <div className="flex flex-wrap items-center gap-4 mt-2">
            <div>
              <p className="text-[11px] text-slate-400 uppercase tracking-wide">System cash</p>
              <p className="text-sm font-semibold text-slate-800">{fmtINR(eod!.system_cash_total)}</p>
            </div>
            <div>
              <p className="text-[11px] text-slate-400 uppercase tracking-wide">Counted</p>
              <p className="text-sm font-semibold text-slate-800">{fmtINR(eod!.physical_cash_count)}</p>
            </div>
            <div>
              <p className="text-[11px] text-slate-400 uppercase tracking-wide">Variance</p>
              <p className={`text-sm font-semibold ${
                variance === 0 ? 'text-green-600' : 'text-red-500'
              }`}>
                {variance === 0 ? 'Balanced' : `${variance! > 0 ? '+' : ''}${fmtINR(variance!)}`}
              </p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-slate-500 mt-1">
            You have <span className="font-semibold text-slate-800">{fmtINR(todayCash)}</span> in cash to
            reconcile today. Close the day to record your handover.
          </p>
        )}
      </div>

      {/* My attendance (own record only) */}
      <div className="card mb-5">
        <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-2 mb-1">
          <CalendarCheck size={16} className="text-slate-400" /> My attendance
        </h2>
        <div className="flex flex-wrap items-center gap-8 mt-2">
          <div>
            <p className="text-[11px] text-slate-400 uppercase tracking-wide mb-1.5">Today</p>
            {attBadge ? (
              <div className="flex items-center gap-2">
                <span className={attBadge.cls}>{attBadge.label}</span>
                {todayAtt?.check_in_time && (
                  <span className="text-xs text-slate-400 font-mono">
                    {todayAtt.check_in_time.slice(0, 5)}
                    {todayAtt.check_out_time ? ` - ${todayAtt.check_out_time.slice(0, 5)}` : ''}
                  </span>
                )}
              </div>
            ) : (
              <p className="text-sm text-slate-400">Not marked yet</p>
            )}
          </div>
          <div>
            <p className="text-[11px] text-slate-400 uppercase tracking-wide mb-1.5">This month</p>
            <p className="text-lg font-bold text-slate-900 leading-none">
              {myMonth ? `${myMonth.percentage}%` : '—'}
            </p>
            <p className="text-xs text-slate-400 mt-1">
              {myMonth ? `${myMonth.working_days} working days` : 'no records yet'}
            </p>
          </div>
        </div>
      </div>

      {/* My recent receipts */}
      <div className="card p-0 overflow-hidden mb-5">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <h2 className="text-sm font-semibold text-slate-700">My recent collections</h2>
          <Link href="/dashboard/fees" className="text-xs text-brand-600 hover:underline flex items-center gap-1">
            All payments <ArrowRight size={12} />
          </Link>
        </div>
        {recent.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <p className="text-sm text-slate-400">No collections yet this month</p>
            <Link href="/dashboard/fees/collect" className="inline-block mt-3 btn-primary text-sm">
              Collect a fee
            </Link>
          </div>
        ) : (
          <div className="divide-y divide-slate-50">
            {recent.map(item => (
              <div key={item.key} className="flex items-center justify-between px-5 py-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-7 h-7 bg-brand-50 rounded-full flex items-center justify-center shrink-0">
                    <span className="text-brand-700 font-semibold text-xs">
                      {item.name.charAt(0).toUpperCase()}
                    </span>
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-800 truncate">{item.name}</p>
                    <p className="text-xs text-slate-400 capitalize truncate">
                      {item.label} · {item.method?.replace('_', ' ')}
                    </p>
                  </div>
                </div>
                <div className="text-right shrink-0 ml-3">
                  <p className="text-sm font-semibold text-green-600">{fmtINR(item.amount)}</p>
                  <p className="text-[10px] text-slate-400">
                    {item.date
                      ? new Date(item.date + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
                      : '—'}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Quick actions */}
      <div className="card">
        <h2 className="text-sm font-semibold text-slate-700 mb-3">Quick actions</h2>
        <div className="flex flex-wrap gap-2 lg:gap-3">
          <Link href="/dashboard/fees/collect" className="btn-primary text-sm flex items-center gap-1.5">
            <HandCoins size={15} /> Collect fee
          </Link>
          <Link href="/dashboard/fees/defaulters" className="btn-secondary text-sm">View defaulters</Link>
          <Link href="/dashboard/fees/summary" className="btn-secondary text-sm flex items-center gap-1.5">
            <FileBarChart size={14} /> Summary
          </Link>
          <Link href="/dashboard/fees/eod" className="btn-secondary text-sm">EOD closure</Link>
          <Link href="/dashboard/leave" className="btn-secondary text-sm">My leave</Link>
        </div>
      </div>

    </div>
  )
}
