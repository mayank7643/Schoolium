'use client'

// FILE: app/(dashboard)/dashboard/fees/ledger/[student_id]/page.tsx
//
// Student Fee Ledger — complete fee history for one student.
// Shows all auto-generated dues, payments, discounts, balances.
// Also shows manual billing records (existing fees table) in a separate tab.
// Both systems visible in one place — unified view.
//
// Accessible from:
//   - Student profile page → "View ledger" button
//   - Defaulters page → student name link
//   - Direct URL: /dashboard/fees/ledger/[student_id]

import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/utils/supabase/client'
import {
  ArrowLeft, IndianRupee, CheckCircle2, AlertCircle,
  Clock, Receipt, ChevronDown, ChevronUp, Tag,
  MessageSquare, CreditCard,
} from 'lucide-react'
import type { DueStatus, PaymentMethod } from '@/types'

// ── Types ─────────────────────────────────────────────────────────────────────

interface StudentInfo {
  id: string
  full_name: string
  student_uid: string | null
  father_name: string | null
  parent_phone: string | null
  class_id: string | null
  classes: { name: string; section: string | null } | null
}

interface LedgerDue {
  due_id: string
  fee_type: string
  label: string
  month: string
  academic_year: string
  due_date: string
  base_amount: number
  discount_amount: number
  net_amount: number
  late_fee_amount: number
  total_due: number
  amount_paid: number
  balance: number
  status: DueStatus
  payments_count: number
  last_payment_date: string | null
  last_receipt: string | null
}

interface LedgerPayment {
  id: string
  fee_due_id: string
  amount_paid: number
  payment_method: PaymentMethod
  receipt_number: string | null
  paid_date: string
  notes: string | null
}

interface ManualFee {
  id: string
  fee_type: string
  amount: number
  status: string
  due_date: string | null
  paid_date: string | null
  receipt_number: string | null
  notes: string | null
  period_months: string[] | null
}

interface DiscountRecord {
  id: string
  label: string
  discount_type: string
  value: number
  applies_to_fee_type: string | null
  valid_from: string | null
  valid_until: string | null
  is_active: boolean
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatCurrency(n: number): string {
  return '₹' + Number(n).toLocaleString('en-IN')
}

function formatMonth(ym: string): string {
  const [y, m] = ym.split('-')
  return new Date(parseInt(y), parseInt(m) - 1, 1)
    .toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
}

function formatDate(d: string | null): string {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
  })
}

function isOverdue(due_date: string, status: DueStatus): boolean {
  return (status === 'unpaid' || status === 'partial') &&
    new Date(due_date) < new Date(new Date().toDateString())
}

const STATUS_BADGE: Record<DueStatus, string> = {
  unpaid:  'badge-red',
  partial: 'badge-yellow',
  paid:    'badge-green',
  waived:  'badge-blue',
}

// ── Due Row Component ─────────────────────────────────────────────────────────

function LedgerDueRow({
  due,
  payments,
}: {
  due: LedgerDue
  payments: LedgerPayment[]
}) {
  const [expanded, setExpanded] = useState(false)
  const overdue = isOverdue(due.due_date, due.status)
  const duePayments = payments.filter(p => p.fee_due_id === due.due_id)

  return (
    <div className={`border-b border-slate-100 last:border-0 transition-colors ${
      overdue ? 'bg-red-50/30' : due.status === 'paid' ? 'bg-green-50/20' : ''
    }`}>
      {/* Main row */}
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-medium text-slate-800 text-sm">{due.label}</p>
            <span className={STATUS_BADGE[due.status]}>{due.status}</span>
            {overdue && (
              <span className="flex items-center gap-1 text-[10px] text-red-600 bg-red-50 border border-red-100 px-1.5 py-0.5 rounded-full">
                <Clock size={9} /> Overdue
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5 text-xs text-slate-400 flex-wrap">
            <span>{formatMonth(due.month)}</span>
            <span>·</span>
            <span>Due {formatDate(due.due_date)}</span>
            {due.discount_amount > 0 && (
              <span className="text-green-600">· -{formatCurrency(due.discount_amount)} disc.</span>
            )}
            {due.late_fee_amount > 0 && (
              <span className="text-amber-600">· +{formatCurrency(due.late_fee_amount)} late fee</span>
            )}
            {due.payments_count > 0 && (
              <span className="text-brand-500">· {due.payments_count} payment{due.payments_count > 1 ? 's' : ''}</span>
            )}
          </div>
        </div>

        {/* Amounts */}
        <div className="text-right shrink-0 min-w-[80px]">
          {due.status === 'paid' ? (
            <p className="font-semibold text-green-600">{formatCurrency(due.total_due)}</p>
          ) : (
            <>
              <p className="font-bold text-slate-900">{formatCurrency(due.balance)}</p>
              <p className="text-[10px] text-slate-400">of {formatCurrency(due.total_due)}</p>
            </>
          )}
        </div>

        {/* Collect button + expand */}
        <div className="flex items-center gap-1.5 shrink-0">
          {(due.status === 'unpaid' || due.status === 'partial') && (
            <Link
              href={`/dashboard/fees/collect?student_id=${due.due_id.split('-')[0]}`}
              className="text-xs text-brand-600 border border-brand-200 px-2.5 py-1 rounded-lg hover:bg-brand-50 transition-colors"
            >
              Collect
            </Link>
          )}
          {duePayments.length > 0 && (
            <button
              onClick={() => setExpanded(e => !e)}
              className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-slate-100 text-slate-400"
            >
              {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
          )}
        </div>
      </div>

      {/* Payment breakdown */}
      {expanded && duePayments.length > 0 && (
        <div className="px-4 pb-3 pt-1 bg-slate-50 border-t border-slate-100">
          <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-2">
            Payments
          </p>
          <div className="flex flex-col gap-2">
            {duePayments.map(p => (
              <div key={p.id} className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2 text-slate-600">
                  <Receipt size={11} className="text-slate-400" />
                  {p.receipt_number && (
                    <span className="font-mono text-[10px] text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">
                      {p.receipt_number}
                    </span>
                  )}
                  <span className="capitalize">{p.payment_method.replace('_', ' ')}</span>
                  <span className="text-slate-400">{formatDate(p.paid_date)}</span>
                  {p.notes && <span className="text-slate-400 italic truncate max-w-[120px]">{p.notes}</span>}
                </div>
                <span className="font-semibold text-green-700">{formatCurrency(p.amount_paid)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function StudentFeeLedgerPage() {
  const params = useParams()
  const studentId = params.student_id as string

  const [student, setStudent]       = useState<StudentInfo | null>(null)
  const [dues, setDues]             = useState<LedgerDue[]>([])
  const [payments, setPayments]     = useState<LedgerPayment[]>([])
  const [manualFees, setManualFees] = useState<ManualFee[]>([])
  const [discounts, setDiscounts]   = useState<DiscountRecord[]>([])
  const [loading, setLoading]       = useState(true)
  const [activeTab, setActiveTab]   = useState<'dues' | 'manual' | 'discounts'>('dues')

  // Year filter
  const [yearFilter, setYearFilter] = useState<string>('all')

  const loadData = useCallback(async () => {
    const supabase = createClient()

    const [studentRes, ledgerRes, paymentsRes, manualRes, discountsRes] = await Promise.all([
      supabase
        .from('students')
        .select('id, full_name, student_uid, father_name, parent_phone, class_id, classes(name, section)')
        .eq('id', studentId)
        .single(),

      supabase.rpc('get_student_fee_ledger', {
        p_school_id:  (await supabase.from('profiles').select('school_id').single()).data?.school_id,
        p_student_id: studentId,
      }),

      supabase
        .from('fee_payments')
        .select('*')
        .eq('student_id', studentId)
        .order('paid_date', { ascending: false }),

      supabase
        .from('fees')
        .select('id, fee_type, amount, status, due_date, paid_date, receipt_number, notes, period_months')
        .eq('student_id', studentId)
        .order('created_at', { ascending: false }),

      supabase
        .from('fee_discounts')
        .select('id, label, discount_type, value, applies_to_fee_type, valid_from, valid_until, is_active')
        .eq('student_id', studentId)
        .order('created_at', { ascending: false }),
    ])

    const raw = studentRes.data as any
    if (raw) {
      setStudent({
        ...raw,
        classes: Array.isArray(raw.classes) ? raw.classes[0] ?? null : raw.classes,
      })
    }

    setDues((ledgerRes.data ?? []) as LedgerDue[])
    setPayments((paymentsRes.data ?? []) as LedgerPayment[])
    setManualFees((manualRes.data ?? []) as ManualFee[])
    setDiscounts((discountsRes.data ?? []) as DiscountRecord[])
    setLoading(false)
  }, [studentId])

  useEffect(() => { loadData() }, [loadData])

  // ── Computed stats ────────────────────────────────────────────────────────

  // Get unique academic years from dues
  const academicYears = Array.from(new Set(dues.map(d => d.academic_year))).sort().reverse()

  const filteredDues = yearFilter === 'all'
    ? dues
    : dues.filter(d => d.academic_year === yearFilter)

  // Group dues by academic year then by month
  const groupedByYear = filteredDues.reduce<Record<string, LedgerDue[]>>((acc, due) => {
    const key = due.academic_year
    if (!acc[key]) acc[key] = []
    acc[key].push(due)
    return acc
  }, {})

  // Overall stats (all years)
  const totalDue       = dues.reduce((s, d) => s + Number(d.total_due), 0)
  const totalPaid      = dues.reduce((s, d) => s + Number(d.amount_paid), 0)
  const totalBalance   = dues.reduce((s, d) => s + Number(d.balance), 0)
  const totalDiscount  = dues.reduce((s, d) => s + Number(d.discount_amount), 0)
  const totalLateFee   = dues.reduce((s, d) => s + Number(d.late_fee_amount), 0)
  const overdueCount   = dues.filter(d => isOverdue(d.due_date, d.status)).length

  const manualTotal    = manualFees.reduce((s, f) => s + Number(f.amount), 0)
  const manualPaid     = manualFees.filter(f => f.status === 'paid').reduce((s, f) => s + Number(f.amount), 0)
  const manualPending  = manualTotal - manualPaid

  const className = student?.classes
    ? `${student.classes.name}${student.classes.section ? ' - ' + student.classes.section : ''}`
    : null

  // ── Loading ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <Link href="/dashboard/fees" className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100">
            <ArrowLeft size={18} className="text-slate-600" />
          </Link>
          <div className="h-6 w-48 bg-slate-100 rounded animate-pulse" />
        </div>
        <div className="flex flex-col gap-3">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="card p-4 animate-pulse">
              <div className="h-4 w-40 bg-slate-100 rounded mb-2" />
              <div className="h-3 w-28 bg-slate-100 rounded" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (!student) {
    return (
      <div className="max-w-2xl mx-auto text-center py-16">
        <p className="text-slate-500">Student not found</p>
        <Link href="/dashboard/fees" className="btn-primary mt-4 inline-block text-sm">
          Back to fees
        </Link>
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto">

      {/* Header */}
      <div className="flex items-center gap-3 mb-5">
        <Link
          href="/dashboard/fees"
          className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 transition-colors"
        >
          <ArrowLeft size={18} className="text-slate-600" />
        </Link>
        <div>
          <h1 className="text-xl font-bold text-slate-900">Fee Ledger</h1>
          <p className="text-slate-400 text-xs mt-0.5">Complete fee history for this student</p>
        </div>
      </div>

      {/* Student card */}
      <div className="card p-4 mb-5">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 bg-brand-100 rounded-full flex items-center justify-center shrink-0">
            <span className="text-brand-700 font-bold text-lg">
              {student.full_name.charAt(0).toUpperCase()}
            </span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-slate-900">{student.full_name}</p>
            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
              {student.student_uid && (
                <span className="font-mono text-[11px] text-brand-700 bg-brand-50 border border-brand-200 px-1.5 py-0.5 rounded">
                  {student.student_uid}
                </span>
              )}
              {className && <span className="text-xs text-slate-500">{className}</span>}
              {student.father_name && (
                <span className="text-xs text-slate-400">· {student.father_name}</span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Link
              href={`/dashboard/fees/collect?student_id=${student.id}`}
              className="btn-primary text-xs py-1.5 px-3"
            >
              Collect fee
            </Link>
            <Link
              href={`/dashboard/students/${student.id}`}
              className="btn-secondary text-xs py-1.5 px-3"
            >
              Profile
            </Link>
          </div>
        </div>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 gap-3 mb-5">
        <div className="stat-card">
          <div className="w-8 h-8 bg-red-50 rounded-lg flex items-center justify-center mb-2">
            <AlertCircle size={15} className="text-red-500" />
          </div>
          <p className="text-xl font-bold text-red-600">{formatCurrency(totalBalance)}</p>
          <p className="text-xs text-slate-500">Outstanding balance</p>
          {overdueCount > 0 && (
            <p className="text-[10px] text-red-500 mt-0.5">{overdueCount} overdue</p>
          )}
        </div>
        <div className="stat-card">
          <div className="w-8 h-8 bg-green-50 rounded-lg flex items-center justify-center mb-2">
            <CheckCircle2 size={15} className="text-green-600" />
          </div>
          <p className="text-xl font-bold text-green-600">{formatCurrency(totalPaid)}</p>
          <p className="text-xs text-slate-500">Total paid</p>
        </div>
        <div className="stat-card">
          <div className="w-8 h-8 bg-slate-50 rounded-lg flex items-center justify-center mb-2">
            <IndianRupee size={15} className="text-slate-500" />
          </div>
          <p className="text-xl font-bold text-slate-700">{formatCurrency(totalDue)}</p>
          <p className="text-xs text-slate-500">Total billed</p>
        </div>
        <div className="stat-card">
          <div className="w-8 h-8 bg-purple-50 rounded-lg flex items-center justify-center mb-2">
            <Tag size={15} className="text-purple-500" />
          </div>
          <p className="text-xl font-bold text-purple-600">{formatCurrency(totalDiscount)}</p>
          <p className="text-xs text-slate-500">Total discounts</p>
          {totalLateFee > 0 && (
            <p className="text-[10px] text-amber-600 mt-0.5">+{formatCurrency(totalLateFee)} late fees</p>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4 bg-slate-100 p-1 rounded-xl">
        <button
          onClick={() => setActiveTab('dues')}
          className={`flex-1 py-2 text-sm font-medium rounded-lg transition-colors ${
            activeTab === 'dues'
              ? 'bg-white text-slate-900 shadow-sm'
              : 'text-slate-500 hover:text-slate-700'
          }`}
        >
          Monthly dues ({dues.length})
        </button>
        <button
          onClick={() => setActiveTab('manual')}
          className={`flex-1 py-2 text-sm font-medium rounded-lg transition-colors ${
            activeTab === 'manual'
              ? 'bg-white text-slate-900 shadow-sm'
              : 'text-slate-500 hover:text-slate-700'
          }`}
        >
          Manual ({manualFees.length})
        </button>
        <button
          onClick={() => setActiveTab('discounts')}
          className={`flex-1 py-2 text-sm font-medium rounded-lg transition-colors ${
            activeTab === 'discounts'
              ? 'bg-white text-slate-900 shadow-sm'
              : 'text-slate-500 hover:text-slate-700'
          }`}
        >
          Discounts ({discounts.length})
        </button>
      </div>

      {/* ── TAB: Monthly Dues ──────────────────────────────────────────────── */}
      {activeTab === 'dues' && (
        <>
          {dues.length === 0 ? (
            <div className="card flex flex-col items-center justify-center py-12 text-center">
              <div className="w-12 h-12 bg-slate-100 rounded-full flex items-center justify-center mb-3">
                <IndianRupee size={20} className="text-slate-400" />
              </div>
              <p className="font-medium text-slate-700 mb-1">No auto-generated dues</p>
              <p className="text-sm text-slate-400 max-w-xs">
                Dues are created when a fee structure is generated for this student&apos;s class.
              </p>
            </div>
          ) : (
            <>
              {/* Year filter */}
              {academicYears.length > 1 && (
                <div className="flex gap-2 flex-wrap mb-3">
                  <button
                    onClick={() => setYearFilter('all')}
                    className={`px-3 py-1 rounded-lg text-xs font-medium border transition-colors ${
                      yearFilter === 'all'
                        ? 'bg-brand-600 text-white border-brand-600'
                        : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    All years
                  </button>
                  {academicYears.map(y => (
                    <button
                      key={y}
                      onClick={() => setYearFilter(y)}
                      className={`px-3 py-1 rounded-lg text-xs font-medium border transition-colors ${
                        yearFilter === y
                          ? 'bg-brand-600 text-white border-brand-600'
                          : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      {y}
                    </button>
                  ))}
                </div>
              )}

              {/* Grouped by year */}
              {Object.entries(groupedByYear)
                .sort(([a], [b]) => b.localeCompare(a))
                .map(([year, yearDues]) => {
                  const yearPaid    = yearDues.reduce((s, d) => s + Number(d.amount_paid), 0)
                  const yearBalance = yearDues.reduce((s, d) => s + Number(d.balance), 0)

                  return (
                    <div key={year} className="mb-4">
                      {/* Year header */}
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                          Academic Year {year}
                        </p>
                        <div className="flex items-center gap-3 text-xs">
                          <span className="text-green-600 font-medium">
                            Paid: {formatCurrency(yearPaid)}
                          </span>
                          {yearBalance > 0 && (
                            <span className="text-red-500 font-medium">
                              Due: {formatCurrency(yearBalance)}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="card p-0 overflow-hidden">
                        {yearDues.map(due => (
                          <LedgerDueRow
                            key={due.due_id}
                            due={due}
                            payments={payments}
                          />
                        ))}
                      </div>
                    </div>
                  )
                })}
            </>
          )}
        </>
      )}

      {/* ── TAB: Manual Billing ───────────────────────────────────────────── */}
      {activeTab === 'manual' && (
        <>
          {/* Manual billing summary */}
          {manualFees.length > 0 && (
            <div className="grid grid-cols-3 gap-3 mb-4">
              <div className="bg-slate-50 rounded-xl p-3 text-center border border-slate-100">
                <p className="text-sm font-bold text-slate-700">{formatCurrency(manualTotal)}</p>
                <p className="text-[10px] text-slate-400 uppercase tracking-wide mt-0.5">Total billed</p>
              </div>
              <div className="bg-green-50 rounded-xl p-3 text-center border border-green-100">
                <p className="text-sm font-bold text-green-700">{formatCurrency(manualPaid)}</p>
                <p className="text-[10px] text-green-500 uppercase tracking-wide mt-0.5">Paid</p>
              </div>
              <div className="bg-red-50 rounded-xl p-3 text-center border border-red-100">
                <p className="text-sm font-bold text-red-600">{formatCurrency(manualPending)}</p>
                <p className="text-[10px] text-red-400 uppercase tracking-wide mt-0.5">Pending</p>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between mb-3">
            <p className="text-xs text-slate-400">
              Manual billing is managed from the main{' '}
              <Link href="/dashboard/fees" className="text-brand-600 hover:underline">fees page</Link>
            </p>
          </div>

          {manualFees.length === 0 ? (
            <div className="card flex flex-col items-center justify-center py-12 text-center">
              <div className="w-12 h-12 bg-slate-100 rounded-full flex items-center justify-center mb-3">
                <CreditCard size={20} className="text-slate-400" />
              </div>
              <p className="font-medium text-slate-700 mb-1">No manual fees</p>
              <p className="text-sm text-slate-400">
                Manual fees are recorded from the main fees page.
              </p>
            </div>
          ) : (
            <div className="card p-0 overflow-hidden">
              {manualFees.map((fee, i) => (
                <div
                  key={fee.id}
                  className={`flex items-center justify-between px-4 py-3 border-b border-slate-100 last:border-0 ${
                    fee.status === 'paid' ? 'bg-green-50/20' : ''
                  }`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-slate-800 text-sm capitalize">{fee.fee_type}</p>
                      <span className={
                        fee.status === 'paid'    ? 'badge-green' :
                        fee.status === 'overdue' ? 'badge-red' : 'badge-yellow'
                      }>{fee.status}</span>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5 text-xs text-slate-400 flex-wrap">
                      {fee.due_date && <span>Due {formatDate(fee.due_date)}</span>}
                      {fee.paid_date && <span>· Paid {formatDate(fee.paid_date)}</span>}
                      {fee.receipt_number && (
                        <span className="font-mono text-[10px] bg-slate-100 px-1.5 py-0.5 rounded">
                          {fee.receipt_number}
                        </span>
                      )}
                      {fee.period_months && fee.period_months.length > 0 && (
                        <span>· {fee.period_months.join(', ')}</span>
                      )}
                      {fee.notes && <span className="italic truncate max-w-[120px]">{fee.notes}</span>}
                    </div>
                  </div>
                  <p className={`font-semibold shrink-0 ml-2 ${
                    fee.status === 'paid' ? 'text-green-600' : 'text-slate-700'
                  }`}>
                    {formatCurrency(fee.amount)}
                  </p>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ── TAB: Discounts ────────────────────────────────────────────────── */}
      {activeTab === 'discounts' && (
        <>
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs text-slate-400">
              Discounts are applied automatically when dues are generated
            </p>
          </div>

          {discounts.length === 0 ? (
            <div className="card flex flex-col items-center justify-center py-12 text-center">
              <div className="w-12 h-12 bg-slate-100 rounded-full flex items-center justify-center mb-3">
                <Tag size={20} className="text-slate-400" />
              </div>
              <p className="font-medium text-slate-700 mb-1">No discounts assigned</p>
              <p className="text-sm text-slate-400 max-w-xs">
                Discounts and scholarships can be added from the student profile page.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {discounts.map(d => (
                <div key={d.id} className={`card p-4 ${!d.is_active ? 'opacity-60' : ''}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <p className="font-semibold text-slate-900 text-sm">{d.label}</p>
                        {!d.is_active && (
                          <span className="text-[10px] text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">
                            Inactive
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-slate-500 mt-1">
                        {d.discount_type === 'percentage'
                          ? `${d.value}% off`
                          : `₹${d.value} off`}
                        {d.applies_to_fee_type
                          ? ` on ${d.applies_to_fee_type} fee`
                          : ' on all fees'}
                      </p>
                      {(d.valid_from || d.valid_until) && (
                        <p className="text-[10px] text-slate-400 mt-1">
                          Valid: {d.valid_from ? formatDate(d.valid_from) : 'start'}
                          {' → '}
                          {d.valid_until ? formatDate(d.valid_until) : 'ongoing'}
                        </p>
                      )}
                    </div>
                    <div className={`text-lg font-bold ${d.is_active ? 'text-purple-600' : 'text-slate-400'}`}>
                      {d.discount_type === 'percentage' ? `${d.value}%` : formatCurrency(d.value)}
                    </div>
                  </div>
                </div>
              ))}

              {/* Total discount applied */}
              {totalDiscount > 0 && (
                <div className="bg-purple-50 border border-purple-100 rounded-xl px-4 py-3 flex justify-between items-center">
                  <span className="text-sm text-purple-700">Total discount applied to dues</span>
                  <span className="font-bold text-purple-700">{formatCurrency(totalDiscount)}</span>
                </div>
              )}
            </div>
          )}
        </>
      )}

    </div>
  )
}
