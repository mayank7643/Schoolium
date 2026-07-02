import { createClient } from '@/utils/supabase/server'
import { redirect } from 'next/navigation'
import {
  Users, IndianRupee, BookOpen, AlertCircle,
  TrendingUp, TrendingDown, Minus, ArrowRight,
  CalendarCheck, Wallet,
} from 'lucide-react'
import Link from 'next/link'

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtINR(n: number) {
  return `₹${n.toLocaleString('en-IN')}`
}

function monthRange(year: number, month: number) {
  const first = new Date(year, month, 1).toISOString().split('T')[0]
  const last  = new Date(year, month + 1, 0).toISOString().split('T')[0]
  return { first, last }
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default async function DashboardPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('school_id, schools(name)')
    .eq('id', user.id)
    .single()

  const schoolId   = profile?.school_id
  const schoolName = (profile?.schools as any)?.name ?? 'Your school'
  if (!schoolId) redirect('/login')

  const now       = new Date()
  const thisYear  = now.getFullYear()
  const thisMonth = now.getMonth()
  const lastMonth = thisMonth === 0 ? 11 : thisMonth - 1
  const lastYear  = thisMonth === 0 ? thisYear - 1 : thisYear

  const { first: thisFirst, last: thisLast } = monthRange(thisYear, thisMonth)
  const { first: lastFirst, last: lastLast } = monthRange(lastYear, lastMonth)

  // ── Single Promise.all ────────────────────────────────────────────────────
  const [
    studentsRes,
    classesRes,
    // Structured fees — fee_payments this month
    structuredThisMonthRes,
    // Structured fees — fee_payments last month (trend)
    structuredLastMonthRes,
    // Structured outstanding — fee_dues balance
    structuredOutstandingRes,
    // Structured defaulters — via get_fee_dashboard_stats RPC
    feeStatsRes,
    // Manual fees — fees table this month (paid)
    manualThisMonthRes,
    // Manual fees — fees table last month paid (trend)
    manualLastMonthRes,
    // Manual fees — fees table pending/overdue (outstanding)
    manualPendingRes,
    // Recent activity — fee_payments (structured, newest first)
    recentStructuredRes,
    // Recent activity — fees table (manual, newest first)
    recentManualRes,
    // Defaulters from fee_dues (structured)
    structuredDefaultersRes,
    // Defaulters from fees table (manual overdue)
    manualDefaultersRes,
  ] = await Promise.all([
    supabase
      .from('students')
      .select('id', { count: 'exact' })
      .eq('school_id', schoolId)
      .eq('is_active', true),

    supabase
      .from('classes')
      .select('id', { count: 'exact' })
      .eq('school_id', schoolId),

    // Structured: fee_payments this month
    supabase
      .from('fee_payments')
      .select('amount_paid')
      .eq('school_id', schoolId)
      .gte('paid_date', thisFirst)
      .lte('paid_date', thisLast),

    // Structured: fee_payments last month
    supabase
      .from('fee_payments')
      .select('amount_paid')
      .eq('school_id', schoolId)
      .gte('paid_date', lastFirst)
      .lte('paid_date', lastLast),

    // Structured: outstanding balances from fee_dues
    supabase
      .from('fee_dues')
      .select('balance, due_date')
      .eq('school_id', schoolId)
      .in('status', ['unpaid', 'partial'])
      .gt('balance', 0),

    // Defaulters count + YTD stats via RPC
    supabase.rpc('get_fee_dashboard_stats', { p_school_id: schoolId }),

    // Manual collected this month: fee_payments already covers ALL payments
    // (structured + manual both flow through fee_payments since billing is unified).
    Promise.resolve({ data: [], error: null }),

    // Manual collected last month: same reason — no-op slot.
    Promise.resolve({ data: [], error: null }),

    // Manual outstanding: fee_dues source='manual' with balance > 0
    supabase
      .from('fee_dues')
      .select('balance, due_date')
      .eq('school_id', schoolId)
      .eq('source', 'manual')
      .gt('balance', 0),

    // Recent activity: all fee_payments (both paths), exclude REV- reversals
    supabase
      .from('fee_payments')
      .select('id, amount_paid, paid_date, receipt_number, students(full_name, student_uid), fee_dues(label, source)')
      .eq('school_id', schoolId)
      .not('receipt_number', 'like', 'REV-%')
      .order('created_at', { ascending: false })
      .limit(6),

    // No-op: recentManualRes slot (unified — label comes from fee_dues join above)
    Promise.resolve({ data: [], error: null }),

    // Defaulters — all sources: unpaid/partial fee_dues past due date
    supabase
      .from('fee_dues')
      .select('student_id, balance, students(full_name, student_uid)')
      .eq('school_id', schoolId)
      .in('status', ['unpaid', 'partial'])
      .lt('due_date', now.toISOString().split('T')[0])
      .gt('balance', 0),

    // No-op: manualDefaultersRes slot (already included in structuredDefaultersRes above)
    Promise.resolve({ data: [], error: null }),
  ])

  // ── Compute stats — both sources combined ─────────────────────────────────
  const totalStudents = studentsRes.count ?? 0
  const totalClasses  = classesRes.count ?? 0

  // This month collected — ALL payments go through fee_payments (unified billing)
  const structuredThisMonth = (structuredThisMonthRes.data ?? [])
    .reduce((s, p) => s + Number(p.amount_paid), 0)
  const manualThisMonth = 0  // unified: manual payments are in fee_payments already
  const thisCollected = structuredThisMonth

  // Last month collected — same: all in fee_payments
  const structuredLastMonth = (structuredLastMonthRes.data ?? [])
    .reduce((s, p) => s + Number(p.amount_paid), 0)
  const manualLastMonth = 0
  const lastCollected = structuredLastMonth

  // Outstanding: structured fee_dues (unpaid/partial) + manual fee_dues (balance > 0)
  const structuredOutstanding = (structuredOutstandingRes.data ?? [])
    .reduce((s, d) => s + Number(d.balance), 0)
  const manualOutstanding = (manualPendingRes.data ?? [])
    .reduce((s, d) => s + Number(d.balance), 0)
  const totalOutstanding = structuredOutstanding + manualOutstanding

  // Overdue: structured past due date, + manual past due date
  const structuredOverdue = (structuredOutstandingRes.data ?? [])
    .filter(d => d.due_date && new Date(d.due_date) < now)
    .reduce((s, d) => s + Number(d.balance), 0)
  const manualOverdue = (manualPendingRes.data ?? [])
    .filter((d: any) => d.due_date && new Date(d.due_date) < now)
    .reduce((s: number, d: any) => s + Number(d.balance), 0)
  const totalOverdue = structuredOverdue + manualOverdue

  // Trend vs last month
  const trendPct  = lastCollected === 0
    ? (thisCollected > 0 ? 100 : 0)
    : Math.round(((thisCollected - lastCollected) / lastCollected) * 100)
  const trendUp   = trendPct > 0
  const trendFlat = trendPct === 0

  // Defaulters — merge structured + manual, deduplicate by student_id
  const defaulterMap: Record<string, { name: string; uid: string | null; total: number; structured: boolean }> = {}

  for (const d of structuredDefaultersRes.data ?? []) {
    const s = d.students as any
    if (!d.student_id) continue
    if (!defaulterMap[d.student_id]) {
      defaulterMap[d.student_id] = { name: s?.full_name ?? '—', uid: s?.student_uid ?? null, total: 0, structured: true }
    }
    defaulterMap[d.student_id].total += Number(d.balance)
  }
  // manualDefaultersRes is a no-op (manual dues already in structuredDefaultersRes above)
  const defaulters     = Object.values(defaulterMap).sort((a, b) => b.total - a.total).slice(0, 5)
  const defaulterCount = Object.keys(defaulterMap).length

  // YTD from RPC — covers all fee_payments (unified billing)
  const feeStats    = (feeStatsRes.data as any)?.[0] ?? null
  const combinedYtd = Number(feeStats?.total_collected_ytd ?? 0)

  // Recent activity — interleave structured + manual, sort by date, take top 6
  type ActivityItem = {
    id: string
    name: string
    uid: string | null
    label: string
    amount: number
    date: string
    source: 'structured' | 'manual'
  }

  // All payments unified through fee_payments — label from fee_dues join (works for both paths)
  const recentActivity: ActivityItem[] = (recentStructuredRes.data ?? []).map((p: any) => {
    const due    = p.fee_dues as any
    const isMan  = due?.source === 'manual'
    const label  = due?.label ?? (isMan ? 'Manual fee' : 'Fee payment')
    return {
      id:     p.id,
      name:   p.students?.full_name ?? '—',
      uid:    p.students?.student_uid ?? null,
      label,
      amount: Number(p.amount_paid),
      date:   p.paid_date,
      source: isMan ? 'manual' : 'structured',
    }
  })

  // Collection progress bar: collected vs total (collected + outstanding)
  const thisTotal      = thisCollected + totalOutstanding
  const collectionRate = thisTotal > 0 ? Math.round((thisCollected / thisTotal) * 100) : 0

  const monthLabel = now.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })

  return (
    <div className="max-w-5xl mx-auto">

      {/* Header */}
      <div className="mb-6">
        <h1 className="text-xl lg:text-2xl font-bold text-slate-900">{schoolName}</h1>
        <p className="text-slate-500 text-sm mt-0.5">
          {now.toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
        </p>
      </div>

      {/* ── Top stat cards ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-4 mb-5">

        {/* This month collected — combined */}
        <Link href="/dashboard/fees" className="stat-card hover:shadow-md transition-shadow">
          <div className="w-8 h-8 rounded-lg bg-green-50 flex items-center justify-center mb-2">
            <IndianRupee size={16} className="text-green-600" />
          </div>
          <p className="text-xl lg:text-2xl font-bold text-slate-900 truncate">{fmtINR(thisCollected)}</p>
          <p className="text-xs text-slate-500">Collected this month</p>
          <div className={`flex items-center gap-1 mt-1 text-xs font-medium ${
            trendUp ? 'text-green-600' : trendFlat ? 'text-slate-400' : 'text-red-500'
          }`}>
            {trendFlat ? <Minus size={12} /> : trendUp ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
            <span>{trendFlat ? 'Same as last month' : `${trendUp ? '+' : ''}${trendPct}% vs last month`}</span>
          </div>
        </Link>

        {/* Total outstanding — combined */}
        <Link href="/dashboard/fees/defaulters" className="stat-card hover:shadow-md transition-shadow">
          <div className="w-8 h-8 rounded-lg bg-yellow-50 flex items-center justify-center mb-2">
            <Wallet size={16} className="text-yellow-600" />
          </div>
          <p className="text-xl lg:text-2xl font-bold text-slate-900 truncate">{fmtINR(totalOutstanding)}</p>
          <p className="text-xs text-slate-500">Total outstanding</p>
          {totalOverdue > 0 && (
            <p className="text-xs text-red-400 mt-1">{fmtINR(totalOverdue)} overdue</p>
          )}
        </Link>

        {/* Total students */}
        <Link href="/dashboard/students" className="stat-card hover:shadow-md transition-shadow">
          <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center mb-2">
            <Users size={16} className="text-blue-600" />
          </div>
          <p className="text-xl lg:text-2xl font-bold text-slate-900">{totalStudents}</p>
          <p className="text-xs text-slate-500">Active students</p>
          <p className="text-xs text-slate-400 mt-1">{totalClasses} class{totalClasses !== 1 ? 'es' : ''}</p>
        </Link>

        {/* Defaulters — combined count */}
        <Link href="/dashboard/fees/defaulters" className="stat-card hover:shadow-md transition-shadow">
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center mb-2 ${
            defaulterCount > 0 ? 'bg-red-50' : 'bg-slate-50'
          }`}>
            <AlertCircle size={16} className={defaulterCount > 0 ? 'text-red-500' : 'text-slate-400'} />
          </div>
          <p className={`text-xl lg:text-2xl font-bold ${defaulterCount > 0 ? 'text-red-500' : 'text-slate-900'}`}>
            {defaulterCount}
          </p>
          <p className="text-xs text-slate-500">Defaulters</p>
          {defaulterCount > 0 && (
            <p className="text-xs text-red-400 mt-1">
              {fmtINR(defaulters.reduce((s, d) => s + d.total, 0))} owed
            </p>
          )}
        </Link>

      </div>

      {/* ── Collection progress bar — combined ── */}
      {thisTotal > 0 && (
        <div className="card mb-5">
          <div className="flex items-center justify-between mb-2">
            <div>
              <p className="text-sm font-semibold text-slate-700">{monthLabel} collection</p>
              <p className="text-[11px] text-slate-400 mt-0.5">Structured + manual fees combined</p>
            </div>
            <span className={`text-sm font-semibold ${
              collectionRate >= 80 ? 'text-green-600' :
              collectionRate >= 50 ? 'text-yellow-600' : 'text-red-500'
            }`}>{collectionRate}% collected</span>
          </div>
          <div className="w-full h-2.5 bg-slate-100 rounded-full overflow-hidden flex">
            {thisCollected > 0 && (
              <div className="bg-green-400 h-full rounded-l-full transition-all"
                style={{ width: `${Math.round((thisCollected / thisTotal) * 100)}%` }} />
            )}
            {totalOutstanding > 0 && (
              <div className="bg-yellow-300 h-full rounded-r-full"
                style={{ width: `${Math.round((totalOutstanding / thisTotal) * 100)}%` }} />
            )}
          </div>
          <div className="flex items-center gap-4 mt-2 flex-wrap">
            <span className="flex items-center gap-1.5 text-xs text-slate-500">
              <span className="w-2 h-2 rounded-full bg-green-400 inline-block" />
              Collected {fmtINR(thisCollected)}
            </span>
            <span className="flex items-center gap-1.5 text-xs text-slate-500">
              <span className="w-2 h-2 rounded-full bg-yellow-300 inline-block" />
              Outstanding {fmtINR(totalOutstanding)}
            </span>
            {totalOverdue > 0 && (
              <span className="text-xs text-red-400">{fmtINR(totalOverdue)} overdue</span>
            )}
          </div>

          {/* Source breakdown row */}
          <div className="mt-3 pt-3 border-t border-slate-100 grid grid-cols-2 gap-3">
            <div>
              <p className="text-[10px] text-slate-400 uppercase tracking-wide mb-1">Structured fees</p>
              <p className="text-sm font-semibold text-slate-800">{fmtINR(structuredThisMonth)}</p>
              <p className="text-[11px] text-slate-400">{fmtINR(structuredOutstanding)} outstanding</p>
            </div>
            <div>
              <p className="text-[10px] text-slate-400 uppercase tracking-wide mb-1">Manual fees</p>
              <p className="text-sm font-semibold text-slate-800">{fmtINR(manualThisMonth)}</p>
              <p className="text-[11px] text-slate-400">{fmtINR(manualOutstanding)} outstanding</p>
            </div>
          </div>
        </div>
      )}

      {/* ── Bottom two-column section ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-5">

        {/* Recent payments — combined activity feed */}
        <div className="card p-0 overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
            <h2 className="text-sm font-semibold text-slate-700">Recent payments</h2>
            <Link href="/dashboard/fees/collect" className="text-xs text-brand-600 hover:underline flex items-center gap-1">
              Collect fee <ArrowRight size={12} />
            </Link>
          </div>
          {recentActivity.length === 0 ? (
            <div className="px-5 py-8 text-center text-sm text-slate-400">No payments recorded yet</div>
          ) : (
            <div className="divide-y divide-slate-50">
              {recentActivity.map(item => (
                <div key={`${item.source}-${item.id}`} className="flex items-center justify-between px-5 py-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-7 h-7 bg-brand-50 rounded-full flex items-center justify-center shrink-0">
                      <span className="text-brand-700 font-semibold text-xs">
                        {item.name.charAt(0).toUpperCase()}
                      </span>
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-800 truncate">{item.name}</p>
                      <p className="text-xs text-slate-400 capitalize">{item.label}</p>
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

        {/* Defaulters — combined */}
        <div className="card p-0 overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
            <h2 className="text-sm font-semibold text-slate-700">Defaulters</h2>
            <Link href="/dashboard/fees/defaulters" className="text-xs text-brand-600 hover:underline flex items-center gap-1">
              View all <ArrowRight size={12} />
            </Link>
          </div>
          {defaulters.length === 0 ? (
            <div className="px-5 py-8 text-center">
              <p className="text-sm text-green-600 font-medium">All clear — no overdue fees</p>
              <p className="text-xs text-slate-400 mt-1">Great collection rate this month</p>
            </div>
          ) : (
            <div className="divide-y divide-slate-50">
              {defaulters.map((d, i) => (
                <div key={i} className="flex items-center justify-between px-5 py-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-7 h-7 bg-red-50 rounded-full flex items-center justify-center shrink-0">
                      <span className="text-red-500 font-semibold text-xs">
                        {d.name.charAt(0).toUpperCase()}
                      </span>
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-800 truncate">{d.name}</p>
                      {d.uid && (
                        <span className="font-mono text-[10px] bg-brand-50 text-brand-700 border border-brand-200 px-1.5 py-0.5 rounded">
                          {d.uid}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="text-right shrink-0 ml-3">
                    <p className="text-sm font-semibold text-red-500">{fmtINR(d.total)}</p>
                    <Link
                      href={`/dashboard/fees/collect?student_uid=${d.uid ?? ''}`}
                      className="text-[10px] text-brand-600 hover:underline"
                    >
                      Collect →
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

      </div>

      {/* ── Quick actions ── */}
      <div className="card">
        <h2 className="text-sm font-semibold text-slate-700 mb-3">Quick actions</h2>
        <div className="flex flex-wrap gap-2 lg:gap-3">
          <Link href="/dashboard/students/new"    className="btn-primary text-sm">+ Add student</Link>
          <Link href="/dashboard/fees/collect"    className="btn-secondary text-sm">Collect fee</Link>
          <Link href="/dashboard/fees/defaulters" className="btn-secondary text-sm">View defaulters</Link>
          <Link href="/dashboard/fees/structures" className="btn-secondary text-sm">Fee structures</Link>
          <Link href="/dashboard/classes"         className="btn-secondary text-sm">Manage classes</Link>
        </div>
      </div>

    </div>
  )
}
