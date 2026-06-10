import { createClient } from '@/utils/supabase/server'
import { redirect } from 'next/navigation'
import { Users, IndianRupee, BookOpen, AlertCircle, TrendingUp, TrendingDown, Minus, ArrowRight } from 'lucide-react'
import Link from 'next/link'

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtINR(n: number) {
  return `₹${n.toLocaleString('en-IN')}`
}

function monthRange(year: number, month: number) {
  // Returns ISO strings for the first and last moment of a given month
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
  const thisMonth = now.getMonth()         // 0-indexed
  const lastMonth = thisMonth === 0 ? 11 : thisMonth - 1
  const lastYear  = thisMonth === 0 ? thisYear - 1 : thisYear

  const { first: thisFirst, last: thisLast }   = monthRange(thisYear, thisMonth)
  const { first: lastFirst, last: lastLast }   = monthRange(lastYear, lastMonth)

  // ── Single Promise.all — all data in one round trip ──────────────────────
  const [
    studentsRes,
    classesRes,
    thisMonthFeesRes,
    lastMonthFeesRes,
    recentFeesRes,
    defaultersRes,
  ] = await Promise.all([
    // Total active students
    supabase
      .from('students')
      .select('id', { count: 'exact' })
      .eq('school_id', schoolId)
      .eq('is_active', true),

    // Total classes
    supabase
      .from('classes')
      .select('id', { count: 'exact' })
      .eq('school_id', schoolId),

    // This month's fees — paid_date for collected, created_at for pending/overdue
    supabase
      .from('fees')
      .select('amount, status, paid_date, created_at')
      .eq('school_id', schoolId)
      .gte('created_at', `${thisFirst}T00:00:00`)
      .lte('created_at', `${thisLast}T23:59:59`),

    // Last month's fees (paid) — for comparison
    supabase
      .from('fees')
      .select('amount, status')
      .eq('school_id', schoolId)
      .eq('status', 'paid')
      .gte('paid_date', lastFirst)
      .lte('paid_date', lastLast),

    // 5 most recent payments for the activity feed
    supabase
      .from('fees')
      .select('id, amount, status, fee_type, paid_date, created_at, receipt_number, students(full_name, student_uid)')
      .eq('school_id', schoolId)
      .order('created_at', { ascending: false })
      .limit(5),

    // Overdue fees — students who owe money
    supabase
      .from('fees')
      .select('student_id, amount, students(full_name, student_uid)')
      .eq('school_id', schoolId)
      .eq('status', 'overdue'),
  ])

  // ── Compute stats ─────────────────────────────────────────────────────────
  const totalStudents = studentsRes.count ?? 0
  const totalClasses  = classesRes.count ?? 0

  const thisMonthFees = thisMonthFeesRes.data ?? []
  const thisCollected = thisMonthFees
    .filter(f => f.status === 'paid')
    .reduce((s, f) => s + Number(f.amount), 0)
  const thisPending = thisMonthFees
    .filter(f => f.status === 'pending')
    .reduce((s, f) => s + Number(f.amount), 0)
  const thisOverdue = thisMonthFees
    .filter(f => f.status === 'overdue')
    .reduce((s, f) => s + Number(f.amount), 0)

  const lastCollected = (lastMonthFeesRes.data ?? [])
    .reduce((s, f) => s + Number(f.amount), 0)

  // Trend: % change vs last month
  const trendPct = lastCollected === 0
    ? (thisCollected > 0 ? 100 : 0)
    : Math.round(((thisCollected - lastCollected) / lastCollected) * 100)
  const trendUp   = trendPct > 0
  const trendFlat = trendPct === 0

  // Collection rate this month
  const thisTotal = thisCollected + thisPending + thisOverdue
  const collectionRate = thisTotal > 0 ? Math.round((thisCollected / thisTotal) * 100) : 0

  // Defaulters — deduplicated by student
  const defaulterMap: Record<string, { name: string; uid: string | null; total: number }> = {}
  for (const f of defaultersRes.data ?? []) {
    const s = f.students as any
    if (!f.student_id) continue
    if (!defaulterMap[f.student_id]) {
      defaulterMap[f.student_id] = { name: s?.full_name ?? '—', uid: s?.student_uid, total: 0 }
    }
    defaulterMap[f.student_id].total += Number(f.amount)
  }
  const defaulters = Object.values(defaulterMap).sort((a, b) => b.total - a.total).slice(0, 5)
  const defaulterCount = Object.keys(defaulterMap).length

  const recentFees = recentFeesRes.data ?? []

  // Month label
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

        {/* This month collected */}
        <Link href="/dashboard/fees" className="stat-card hover:shadow-md transition-shadow">
          <div className="w-8 h-8 rounded-lg bg-green-50 flex items-center justify-center mb-2">
            <IndianRupee size={16} className="text-green-600" />
          </div>
          <p className="text-xl lg:text-2xl font-bold text-slate-900 truncate">{fmtINR(thisCollected)}</p>
          <p className="text-xs text-slate-500">Collected this month</p>
          {/* Trend vs last month */}
          <div className={`flex items-center gap-1 mt-1 text-xs font-medium ${
            trendUp ? 'text-green-600' : trendFlat ? 'text-slate-400' : 'text-red-500'
          }`}>
            {trendFlat
              ? <Minus size={12} />
              : trendUp
              ? <TrendingUp size={12} />
              : <TrendingDown size={12} />}
            <span>
              {trendFlat ? 'Same as last month' : `${trendUp ? '+' : ''}${trendPct}% vs last month`}
            </span>
          </div>
        </Link>

        {/* Pending this month */}
        <Link href="/dashboard/fees" className="stat-card hover:shadow-md transition-shadow">
          <div className="w-8 h-8 rounded-lg bg-yellow-50 flex items-center justify-center mb-2">
            <IndianRupee size={16} className="text-yellow-600" />
          </div>
          <p className="text-xl lg:text-2xl font-bold text-slate-900 truncate">{fmtINR(thisPending)}</p>
          <p className="text-xs text-slate-500">Pending this month</p>
          <p className="text-xs text-slate-400 mt-1">{fmtINR(thisOverdue)} overdue</p>
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

        {/* Defaulters */}
        <Link href="/dashboard/fees/summary" className="stat-card hover:shadow-md transition-shadow">
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center mb-2 ${
            defaulterCount > 0 ? 'bg-red-50' : 'bg-slate-50'
          }`}>
            <AlertCircle size={16} className={defaulterCount > 0 ? 'text-red-500' : 'text-slate-400'} />
          </div>
          <p className={`text-xl lg:text-2xl font-bold ${defaulterCount > 0 ? 'text-red-500' : 'text-slate-900'}`}>
            {defaulterCount}
          </p>
          <p className="text-xs text-slate-500">Overdue students</p>
          {defaulterCount > 0 && (
            <p className="text-xs text-red-400 mt-1">{fmtINR(defaulters.reduce((s, d) => s + d.total, 0))} total</p>
          )}
        </Link>

      </div>

      {/* ── Collection progress bar ── */}
      {thisTotal > 0 && (
        <div className="card mb-5">
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-semibold text-slate-700">{monthLabel} collection</p>
            <span className={`text-sm font-semibold ${
              collectionRate >= 80 ? 'text-green-600' :
              collectionRate >= 50 ? 'text-yellow-600' : 'text-red-500'
            }`}>{collectionRate}% collected</span>
          </div>
          <div className="w-full h-2.5 bg-slate-100 rounded-full overflow-hidden flex">
            {thisCollected > 0 && (
              <div className="bg-green-400 h-full rounded-full transition-all"
                style={{ width: `${Math.round((thisCollected / thisTotal) * 100)}%` }} />
            )}
            {thisPending > 0 && (
              <div className="bg-yellow-300 h-full"
                style={{ width: `${Math.round((thisPending / thisTotal) * 100)}%` }} />
            )}
            {thisOverdue > 0 && (
              <div className="bg-red-400 h-full"
                style={{ width: `${Math.round((thisOverdue / thisTotal) * 100)}%` }} />
            )}
          </div>
          <div className="flex items-center gap-4 mt-2">
            <span className="flex items-center gap-1.5 text-xs text-slate-500">
              <span className="w-2 h-2 rounded-full bg-green-400 inline-block" />Collected {fmtINR(thisCollected)}
            </span>
            <span className="flex items-center gap-1.5 text-xs text-slate-500">
              <span className="w-2 h-2 rounded-full bg-yellow-300 inline-block" />Pending {fmtINR(thisPending)}
            </span>
            {thisOverdue > 0 && (
              <span className="flex items-center gap-1.5 text-xs text-slate-500">
                <span className="w-2 h-2 rounded-full bg-red-400 inline-block" />Overdue {fmtINR(thisOverdue)}
              </span>
            )}
          </div>
        </div>
      )}

      {/* ── Bottom two-column section ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-5">

        {/* Recent payments */}
        <div className="card p-0 overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
            <h2 className="text-sm font-semibold text-slate-700">Recent payments</h2>
            <Link href="/dashboard/fees" className="text-xs text-brand-600 hover:underline flex items-center gap-1">
              View all <ArrowRight size={12} />
            </Link>
          </div>
          {recentFees.length === 0 ? (
            <div className="px-5 py-8 text-center text-sm text-slate-400">No payments recorded yet</div>
          ) : (
            <div className="divide-y divide-slate-50">
              {recentFees.map(fee => {
                const student = fee.students as any
                const isPaid  = fee.status === 'paid'
                return (
                  <div key={fee.id} className="flex items-center justify-between px-5 py-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-7 h-7 bg-brand-50 rounded-full flex items-center justify-center shrink-0">
                        <span className="text-brand-700 font-semibold text-xs">
                          {(student?.full_name ?? '?').charAt(0).toUpperCase()}
                        </span>
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-slate-800 truncate">{student?.full_name ?? '—'}</p>
                        <p className="text-xs text-slate-400 capitalize">{fee.fee_type}</p>
                      </div>
                    </div>
                    <div className="text-right shrink-0 ml-3">
                      <p className={`text-sm font-semibold ${isPaid ? 'text-green-600' : 'text-yellow-600'}`}>
                        {fmtINR(Number(fee.amount))}
                      </p>
                      <p className="text-[10px] text-slate-400">
                        {fee.paid_date
                          ? new Date(fee.paid_date + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
                          : new Date(fee.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                      </p>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Defaulters */}
        <div className="card p-0 overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
            <h2 className="text-sm font-semibold text-slate-700">Overdue students</h2>
            <Link href="/dashboard/fees/summary" className="text-xs text-brand-600 hover:underline flex items-center gap-1">
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
                      href={`/dashboard/fees?student_uid=${d.uid ?? ''}`}
                      className="text-[10px] text-brand-600 hover:underline"
                    >
                      Record →
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
          <Link href="/dashboard/students/new" className="btn-primary text-sm">+ Add student</Link>
          <Link href="/dashboard/fees" className="btn-secondary text-sm">Record payment</Link>
          <Link href="/dashboard/fees/summary" className="btn-secondary text-sm">Fee summary</Link>
          <Link href="/dashboard/classes" className="btn-secondary text-sm">Manage classes</Link>
        </div>
      </div>

    </div>
  )
}
