'use client'

// FILE: app/(dashboard)/dashboard/fees/collect/page.tsx
//
// Fee Collection page — staff searches for a student, sees all their
// pending dues, and records full / partial / advance payments.
// Also supports manual/miscellaneous fees (existing system) via the
// "Record manual fee" button which links back to the fees page.
//
// FLOW:
//   1. Staff searches student by UID or name
//   2. Student's pending dues load automatically
//   3. Staff selects a due and enters amount
//   4. Payment recorded via record_fee_payment() RPC
//   5. Receipt generated and shown inline

import { useState, useEffect, useCallback, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/utils/supabase/client'
import Link from 'next/link'
import {
  Search, X, IndianRupee, CheckCircle2, AlertCircle,
  ChevronDown, ChevronUp, Printer, ArrowLeft,
  Clock, BadgeCheck, Wallet, Plus,
} from 'lucide-react'
import type { DueStatus, PaymentMethod } from '@/types'

// ── Types ─────────────────────────────────────────────────────────────────────

interface StudentResult {
  id: string
  full_name: string
  student_uid: string | null
  father_name: string | null
  parent_phone: string | null
  classes: { name: string; section: string | null } | null
}

interface DueRow {
  id: string
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
  late_fee_applied: boolean
}

interface PaymentResult {
  payment_id: string
  receipt_number: string
}

interface SchoolInfo {
  name: string
  phone: string | null
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatCurrency(n: number): string {
  return '₹' + Number(n).toLocaleString('en-IN')
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
  })
}

function formatMonth(ym: string): string {
  const [y, m] = ym.split('-')
  return new Date(parseInt(y), parseInt(m) - 1, 1)
    .toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
}

function getDueStatusStyle(status: DueStatus, balance: number, dueDate: string) {
  const overdue = balance > 0 && new Date(dueDate) < new Date()
  if (status === 'paid')    return { badge: 'badge-green', label: 'Paid' }
  if (status === 'waived')  return { badge: 'badge-blue',  label: 'Waived' }
  if (status === 'partial') return { badge: 'badge-yellow', label: 'Partial' }
  if (overdue)              return { badge: 'badge-red',   label: 'Overdue' }
  return { badge: 'badge-yellow', label: 'Pending' }
}

// ── Receipt Modal ─────────────────────────────────────────────────────────────

function ReceiptModal({
  receiptNumber,
  student,
  due,
  amountPaid,
  paymentMethod,
  paidDate,
  school,
  onClose,
}: {
  receiptNumber: string
  student: StudentResult
  due: DueRow
  amountPaid: number
  paymentMethod: PaymentMethod
  paidDate: string
  school: SchoolInfo
  onClose: () => void
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null)

  const className = student.classes
    ? `${student.classes.name}${student.classes.section ? ' - ' + student.classes.section : ''}`
    : null

  const formattedDate = new Date(paidDate).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'long', year: 'numeric',
  })

  const receiptHTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Receipt ${receiptNumber}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: Arial, sans-serif; background: #fff; color: #1e293b; padding: 32px; max-width: 500px; margin: 0 auto; }
  .top-bar { background: linear-gradient(90deg, #2563eb, #1d4ed8); height: 6px; border-radius: 4px; margin-bottom: 28px; }
  .school { font-size: 22px; font-weight: 700; color: #1e3a8a; }
  .receipt-label { font-size: 10px; color: #64748b; letter-spacing: 2.5px; text-transform: uppercase; margin-top: 3px; }
  .rcpnum { font-size: 11px; color: #94a3b8; margin-top: 5px; font-family: monospace; }
  .divider { border: none; border-top: 1px dashed #cbd5e1; margin: 18px 0; }
  .amount-box { background: linear-gradient(135deg, #eff6ff, #dbeafe); border: 1px solid #bfdbfe; border-radius: 12px; padding: 16px 20px; margin: 16px 0; display: flex; justify-content: space-between; align-items: center; }
  .amount-label { font-size: 12px; color: #1d4ed8; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; }
  .amount-value { font-size: 28px; font-weight: 800; color: #1e3a8a; }
  .table { width: 100%; border-collapse: collapse; }
  .table tr td { padding: 8px 0; border-bottom: 1px solid #f1f5f9; font-size: 13px; }
  .table tr:last-child td { border-bottom: none; }
  .table .label { color: #64748b; width: 45%; }
  .table .value { font-weight: 600; color: #1e293b; text-align: right; }
  .sig-area { display: flex; justify-content: flex-end; margin-top: 28px; padding-top: 16px; border-top: 1px solid #e2e8f0; }
  .sig-line { border-top: 1.5px solid #475569; width: 150px; padding-top: 6px; font-size: 10px; color: #64748b; letter-spacing: 0.5px; text-align: center; }
  .footer { margin-top: 20px; text-align: center; font-size: 10px; color: #94a3b8; line-height: 1.6; }
  @media print {
    .top-bar, .amount-box { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style>
</head>
<body>
  <div class="top-bar"></div>
  <div class="school">${school.name}</div>
  <div class="receipt-label">Fee Receipt</div>
  <div class="rcpnum">${receiptNumber}</div>
  <hr class="divider">
  <div class="amount-box">
    <span class="amount-label">Amount Paid</span>
    <span class="amount-value">₹${amountPaid.toLocaleString('en-IN')}</span>
  </div>
  <table class="table">
    <tr><td class="label">Student Name</td><td class="value">${student.full_name}</td></tr>
    ${student.student_uid ? `<tr><td class="label">Student ID</td><td class="value" style="font-family:monospace">${student.student_uid}</td></tr>` : ''}
    ${className ? `<tr><td class="label">Class</td><td class="value">${className}</td></tr>` : ''}
    ${student.father_name ? `<tr><td class="label">Father's Name</td><td class="value">${student.father_name}</td></tr>` : ''}
    <tr><td class="label">Fee Description</td><td class="value">${due.label}</td></tr>
    <tr><td class="label">Period</td><td class="value">${formatMonth(due.month)}</td></tr>
    <tr><td class="label">Payment Mode</td><td class="value">${paymentMethod.replace('_', ' ').toUpperCase()}</td></tr>
    <tr><td class="label">Date</td><td class="value">${formattedDate}</td></tr>
    ${due.balance - amountPaid > 0 ? `<tr><td class="label">Remaining Balance</td><td class="value" style="color:#b45309">₹${(due.balance - amountPaid).toLocaleString('en-IN')}</td></tr>` : ''}
  </table>
  <div class="sig-area"><div class="sig-line">Authorized Signature</div></div>
  <div class="footer">${school.name}${school.phone ? ' · ' + school.phone : ''}<br>Computer-generated receipt. No physical signature required.</div>
</body>
</html>`

  function handlePrint() {
    const iframe = iframeRef.current
    if (!iframe?.contentWindow) return
    iframe.contentWindow.document.open()
    iframe.contentWindow.document.write(receiptHTML)
    iframe.contentWindow.document.close()
    setTimeout(() => { iframe.contentWindow?.focus(); iframe.contentWindow?.print() }, 350)
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 px-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <div className="flex items-center gap-2">
            <CheckCircle2 size={18} className="text-green-600" />
            <span className="font-semibold text-slate-900">Payment successful</span>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handlePrint}
              className="btn-primary flex items-center gap-1.5 text-sm py-1.5 px-3"
            >
              <Printer size={14} /> Print receipt
            </button>
            <button
              onClick={onClose}
              className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100"
            >
              <X size={17} className="text-slate-500" />
            </button>
          </div>
        </div>

        <div className="p-4 max-h-[75vh] overflow-y-auto">
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-5">
            <div className="h-1.5 bg-gradient-to-r from-blue-600 to-blue-500 rounded-full mb-4" />
            <div className="text-base font-bold text-blue-900">{school.name}</div>
            <div className="text-[10px] text-slate-400 tracking-widest uppercase mt-0.5">Fee Receipt</div>
            <div className="text-[11px] text-slate-400 font-mono mt-1">{receiptNumber}</div>

            <div className="bg-gradient-to-br from-blue-50 to-blue-100 border border-blue-200 rounded-xl px-4 py-3 my-4 flex justify-between items-center">
              <span className="text-[11px] font-bold text-blue-700 uppercase tracking-wider">Amount Paid</span>
              <span className="text-2xl font-extrabold text-blue-900">{formatCurrency(amountPaid)}</span>
            </div>

            <div className="flex flex-col gap-2 text-sm">
              {[
                ['Student', student.full_name],
                ...(student.student_uid ? [['Student ID', student.student_uid]] : []),
                ...(className ? [['Class', className]] : []),
                ['Fee', due.label],
                ['Period', formatMonth(due.month)],
                ['Mode', paymentMethod.replace('_', ' ')],
                ['Date', formattedDate],
                ...(due.balance - amountPaid > 0 ? [['Balance left', formatCurrency(due.balance - amountPaid)]] : []),
              ].map(([label, value]) => (
                <div key={label} className="flex justify-between items-center py-1.5 border-b border-slate-100 last:border-0">
                  <span className="text-slate-500">{label}</span>
                  <span className={`font-semibold text-slate-800 ${label === 'Balance left' ? 'text-amber-700' : ''}`}>
                    {value}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
        <iframe ref={iframeRef} style={{ display: 'none' }} title="receipt-print" />
      </div>
    </div>
  )
}

// ── Due Card ──────────────────────────────────────────────────────────────────

function DueCard({
  due,
  onCollect,
}: {
  due: DueRow
  onCollect: (due: DueRow) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const { badge, label } = getDueStatusStyle(due.status, due.balance, due.due_date)
  const canPay = due.status !== 'paid' && due.status !== 'waived' && due.balance > 0

  return (
    <div className="border border-slate-200 rounded-xl bg-white overflow-hidden">
      <div className="flex items-center gap-3 p-3.5">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-medium text-sm text-slate-900">{due.label}</p>
            <span className={badge}>{label}</span>
            {due.late_fee_applied && (
              <span className="text-[10px] bg-red-50 text-red-600 px-1.5 py-0.5 rounded font-medium">
                +Late fee
              </span>
            )}
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            {formatMonth(due.month)} · Due {formatDate(due.due_date)}
          </p>
        </div>

        <div className="text-right shrink-0">
          <p className="font-bold text-slate-900">{formatCurrency(due.balance)}</p>
          <p className="text-[11px] text-slate-400">remaining</p>
        </div>

        <button
          onClick={() => setExpanded(e => !e)}
          className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-slate-100 text-slate-400 shrink-0"
        >
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>

      {expanded && (
        <div className="border-t border-slate-100 px-3.5 py-3 bg-slate-50 flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
            {[
              ['Base amount',    formatCurrency(due.base_amount)],
              ['Discount',       due.discount_amount > 0 ? `-${formatCurrency(due.discount_amount)}` : '—'],
              ['Net due',        formatCurrency(due.net_amount)],
              ['Late fee',       due.late_fee_amount > 0 ? `+${formatCurrency(due.late_fee_amount)}` : '—'],
              ['Total due',      formatCurrency(due.total_due)],
              ['Amount paid',    formatCurrency(due.amount_paid)],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between">
                <span className="text-slate-400">{k}</span>
                <span className="font-medium text-slate-700">{v}</span>
              </div>
            ))}
          </div>

          {canPay && (
            <button
              onClick={() => onCollect(due)}
              className="btn-primary w-full py-2 text-sm mt-1"
            >
              Collect payment
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ── Collect Modal ─────────────────────────────────────────────────────────────

function CollectModal({
  due,
  student,
  school,
  onClose,
  onSuccess,
}: {
  due: DueRow
  student: StudentResult
  school: SchoolInfo
  onClose: () => void
  onSuccess: (result: PaymentResult, amount: number, method: PaymentMethod, date: string) => void
}) {
  const [amount, setAmount]   = useState(String(due.balance))
  const [method, setMethod]   = useState<PaymentMethod>('cash')
  const [date, setDate]       = useState(new Date().toISOString().split('T')[0])
  const [notes, setNotes]     = useState('')
  const [saving, setSaving]   = useState(false)
  const [error, setError]     = useState('')

  const parsedAmount = parseFloat(amount) || 0
  const isPartial    = parsedAmount < due.balance && parsedAmount > 0
  const isOver       = parsedAmount > due.balance

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (parsedAmount <= 0) { setError('Enter a valid amount'); return }
    if (parsedAmount > due.total_due) {
      setError(`Maximum collectible amount is ${formatCurrency(due.total_due)}`)
      return
    }

    setSaving(true)
    setError('')

    const supabase = createClient()
    const { data: profile } = await supabase.from('profiles').select('id, school_id').single()

    if (!profile) { setError('Session error — please reload'); setSaving(false); return }

    const { data, error: rpcError } = await supabase.rpc('record_fee_payment', {
      p_school_id:      profile.school_id,
      p_student_id:     student.id,
      p_fee_due_id:     due.id,
      p_amount_paid:    parsedAmount,
      p_payment_method: method,
      p_paid_date:      date,
      p_collected_by:   profile.id,
      p_notes:          notes || null,
    })

    if (rpcError) { setError(rpcError.message); setSaving(false); return }

    const result = Array.isArray(data) ? data[0] : data
    onSuccess(result as PaymentResult, parsedAmount, method, date)
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 px-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between p-5 border-b border-slate-100">
          <div>
            <h2 className="font-semibold text-slate-900">Collect payment</h2>
            <p className="text-xs text-slate-400 mt-0.5">{due.label} · {formatMonth(due.month)}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100">
            <X size={18} className="text-slate-500" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 flex flex-col gap-4">

          {/* Balance summary */}
          <div className="bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 flex justify-between items-center">
            <div>
              <p className="text-xs text-slate-400">Outstanding balance</p>
              <p className="text-xl font-bold text-slate-900 mt-0.5">{formatCurrency(due.balance)}</p>
            </div>
            {due.discount_amount > 0 && (
              <div className="text-right">
                <p className="text-xs text-slate-400">Discount applied</p>
                <p className="text-sm font-medium text-green-700">-{formatCurrency(due.discount_amount)}</p>
              </div>
            )}
          </div>

          {/* Amount input */}
          <div>
            <label className="label">Amount to collect (₹) *</label>
            <div className="relative">
              <IndianRupee size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                inputMode="numeric"
                className="input pl-8 text-lg font-semibold"
                value={amount}
                onChange={e => {
                  if (e.target.value === '' || /^\d+(\.\d{0,2})?$/.test(e.target.value)) {
                    setAmount(e.target.value)
                    setError('')
                  }
                }}
                autoFocus
              />
            </div>
            {/* Quick amount buttons */}
            <div className="flex gap-2 mt-2">
              {[due.balance, due.balance / 2, due.balance / 4]
                .filter(a => a > 0)
                .map((a, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setAmount(String(Math.round(a)))}
                    className="flex-1 py-1.5 text-xs border border-slate-200 rounded-lg hover:bg-slate-50 text-slate-600 font-medium transition-colors"
                  >
                    {i === 0 ? 'Full' : i === 1 ? 'Half' : '¼'}
                    <span className="block text-[10px] text-slate-400">{formatCurrency(Math.round(a))}</span>
                  </button>
                ))}
            </div>
            {isPartial && (
              <p className="text-xs text-amber-600 mt-1.5 bg-amber-50 px-2.5 py-1.5 rounded-lg">
                Partial payment — {formatCurrency(due.balance - parsedAmount)} will remain as outstanding balance
              </p>
            )}
            {isOver && (
              <p className="text-xs text-red-600 mt-1.5">
                Amount exceeds the outstanding balance
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Payment method *</label>
              <select
                className="input"
                value={method}
                onChange={e => setMethod(e.target.value as PaymentMethod)}
              >
                <option value="cash">Cash</option>
                <option value="upi">UPI</option>
                <option value="bank_transfer">Bank Transfer</option>
                <option value="cheque">Cheque</option>
                <option value="online">Online</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div>
              <label className="label">Payment date *</label>
              <input
                type="date"
                className="input"
                value={date}
                onChange={e => setDate(e.target.value)}
                max={new Date().toISOString().split('T')[0]}
              />
            </div>
          </div>

          <div>
            <label className="label">Notes (optional)</label>
            <input
              type="text"
              className="input"
              placeholder="e.g. Cheque no. 123456"
              value={notes}
              onChange={e => setNotes(e.target.value)}
            />
          </div>

          {error && (
            <div className="flex items-center gap-2 bg-red-50 text-red-600 text-sm px-3 py-2.5 rounded-lg">
              <AlertCircle size={14} className="shrink-0" />
              {error}
            </div>
          )}

          <button type="submit" disabled={saving || parsedAmount <= 0} className="btn-primary w-full py-2.5">
            {saving
              ? <span className="flex items-center justify-center gap-2">
                  <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Recording...
                </span>
              : `Collect ${parsedAmount > 0 ? formatCurrency(parsedAmount) : ''}`}
          </button>
        </form>
      </div>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function FeeCollectPage() {
  const [query, setQuery]               = useState('')
  const [results, setResults]           = useState<StudentResult[]>([])
  const [searching, setSearching]       = useState(false)
  const [selectedStudent, setSelectedStudent] = useState<StudentResult | null>(null)
  const [dues, setDues]                 = useState<DueRow[]>([])
  const [loadingDues, setLoadingDues]   = useState(false)
  const [school, setSchool]             = useState<SchoolInfo>({ name: '', phone: null })
  const [collectingDue, setCollectingDue] = useState<DueRow | null>(null)
  const [receipt, setReceipt]           = useState<{
    result: PaymentResult
    due: DueRow
    amount: number
    method: PaymentMethod
    date: string
  } | null>(null)
  const [filter, setFilter] = useState<'pending' | 'all'>('pending')
  const debounceRef = useRef<ReturnType<typeof setTimeout>>()
  const searchParams = useSearchParams()

  // Auto-load student if student_id query param is present (e.g. from student profile)
  useEffect(() => {
    const studentId = searchParams.get('student_id')
    if (!studentId) return
    async function autoLoadStudent() {
      const supabase = createClient()
      const { data } = await supabase
        .from('students')
        .select('id, full_name, student_uid, father_name, parent_phone, classes(name, section)')
        .eq('id', studentId)
        .single()
      if (data) {
        const student: StudentResult = {
          ...data,
          classes: Array.isArray((data as any).classes)
            ? (data as any).classes[0] ?? null
            : (data as any).classes,
        }
        setSelectedStudent(student)
        loadDues(student)
      }
    }
    autoLoadStudent()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Load school info once
  useEffect(() => {
    async function loadSchool() {
      const supabase = createClient()
      const { data } = await supabase
        .from('profiles')
        .select('schools(name, phone)')
        .single()
      const s = (data as any)?.schools
      if (s) setSchool({ name: s.name, phone: s.phone })
    }
    loadSchool()
  }, [])

  // Debounced student search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (!query.trim() || query.trim().length < 2) { setResults([]); return }

    debounceRef.current = setTimeout(async () => {
      setSearching(true)
      const supabase = createClient()
      const q = query.trim().toUpperCase()

      const { data } = await supabase
        .from('students')
        .select('id, full_name, student_uid, father_name, parent_phone, classes(name, section)')
        .eq('is_active', true)
        .or(`full_name.ilike.%${query.trim()}%,student_uid.ilike.%${q}%`)
        .limit(10)

      setResults((data ?? []).map((s: any) => ({
        ...s,
        classes: Array.isArray(s.classes) ? s.classes[0] ?? null : s.classes,
      })))
      setSearching(false)
    }, 300)
  }, [query])

  const loadDues = useCallback(async (student: StudentResult) => {
    setLoadingDues(true)
    setDues([])
    const supabase = createClient()

    const { data } = await supabase
      .from('fee_dues')
      .select('*')
      .eq('student_id', student.id)
      .order('due_date', { ascending: true })

    setDues((data ?? []) as DueRow[])
    setLoadingDues(false)
  }, [])

  function selectStudent(student: StudentResult) {
    setSelectedStudent(student)
    setQuery('')
    setResults([])
    setReceipt(null)
    loadDues(student)
  }

  function clearStudent() {
    setSelectedStudent(null)
    setDues([])
    setReceipt(null)
    setQuery('')
  }

  function handlePaymentSuccess(
    result: PaymentResult,
    amount: number,
    method: PaymentMethod,
    date: string,
  ) {
    if (!collectingDue) return
    setReceipt({ result, due: collectingDue, amount, method, date })
    setCollectingDue(null)
    // Reload dues to reflect updated balances
    if (selectedStudent) loadDues(selectedStudent)
  }

  // Stats from dues
  const totalPending   = dues.filter(d => d.status !== 'paid' && d.status !== 'waived').reduce((s, d) => s + d.balance, 0)
  const totalPaid      = dues.filter(d => d.status === 'paid').reduce((s, d) => s + d.amount_paid, 0)
  const overdueCount   = dues.filter(d => d.balance > 0 && new Date(d.due_date) < new Date() && d.status !== 'paid' && d.status !== 'waived').length

  const filteredDues = filter === 'pending'
    ? dues.filter(d => d.status !== 'paid' && d.status !== 'waived')
    : dues

  return (
    <div className="max-w-2xl mx-auto">

      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <Link href="/dashboard/fees" className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 text-slate-500">
          <ArrowLeft size={18} />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Collect Fee</h1>
          <p className="text-slate-500 text-sm mt-0.5">Search a student and record payment against their dues</p>
        </div>
      </div>

      {/* Search box */}
      <div className="relative mb-4">
        <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          type="text"
          className="input pl-10 pr-10"
          placeholder="Search by student name or ID (e.g. NA-26-0001)…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          autoComplete="off"
        />
        {query && (
          <button
            onClick={() => { setQuery(''); setResults([]) }}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
          >
            <X size={15} />
          </button>
        )}

        {/* Dropdown results */}
        {(results.length > 0 || searching) && (
          <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-slate-200 rounded-xl shadow-lg z-20 overflow-hidden">
            {searching ? (
              <div className="px-4 py-3 text-sm text-slate-400">Searching…</div>
            ) : results.length === 0 ? (
              <div className="px-4 py-3 text-sm text-slate-400">No students found</div>
            ) : (
              results.map(s => (
                <button
                  key={s.id}
                  onClick={() => selectStudent(s)}
                  className="w-full flex items-center gap-3 px-4 py-3 hover:bg-slate-50 transition-colors text-left border-b border-slate-50 last:border-0"
                >
                  <div className="w-9 h-9 bg-brand-100 rounded-full flex items-center justify-center shrink-0">
                    <span className="text-brand-700 font-bold text-sm">
                      {s.full_name.charAt(0)}
                    </span>
                  </div>
                  <div>
                    <p className="font-medium text-slate-900 text-sm">{s.full_name}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      {s.student_uid && (
                        <span className="font-mono text-[11px] text-slate-500">{s.student_uid}</span>
                      )}
                      {s.classes && (
                        <span className="text-[11px] text-slate-400">
                          · {s.classes.name}{s.classes.section ? ` - ${s.classes.section}` : ''}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      {/* Selected student */}
      {selectedStudent && (
        <>
          {/* Student card */}
          <div className="card p-4 mb-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 bg-brand-100 rounded-full flex items-center justify-center shrink-0">
                  <span className="text-brand-700 font-bold">
                    {selectedStudent.full_name.charAt(0)}
                  </span>
                </div>
                <div>
                  <p className="font-semibold text-slate-900">{selectedStudent.full_name}</p>
                  <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                    {selectedStudent.student_uid && (
                      <span className="font-mono text-xs bg-brand-50 text-brand-700 border border-brand-200 px-1.5 py-0.5 rounded">
                        {selectedStudent.student_uid}
                      </span>
                    )}
                    {selectedStudent.classes && (
                      <span className="text-xs text-slate-500">
                        {selectedStudent.classes.name}
                        {selectedStudent.classes.section ? ` - ${selectedStudent.classes.section}` : ''}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <button
                onClick={clearStudent}
                className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 text-slate-400"
              >
                <X size={16} />
              </button>
            </div>

            {/* Fee summary */}
            {!loadingDues && dues.length > 0 && (
              <div className="grid grid-cols-3 gap-3 mt-4 pt-4 border-t border-slate-100">
                <div className="text-center">
                  <p className="text-base font-bold text-red-600">{formatCurrency(totalPending)}</p>
                  <p className="text-[11px] text-slate-400 mt-0.5">Outstanding</p>
                </div>
                <div className="text-center">
                  <p className="text-base font-bold text-green-600">{formatCurrency(totalPaid)}</p>
                  <p className="text-[11px] text-slate-400 mt-0.5">Paid this year</p>
                </div>
                <div className="text-center">
                  <p className="text-base font-bold text-amber-600">{overdueCount}</p>
                  <p className="text-[11px] text-slate-400 mt-0.5">Overdue dues</p>
                </div>
              </div>
            )}
          </div>

          {/* Dues section */}
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-semibold text-slate-700">Fee dues</p>
            <div className="flex gap-1.5">
              {(['pending', 'all'] as const).map(f => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`px-3 py-1 rounded-lg text-xs font-medium border transition-colors ${
                    filter === f
                      ? 'bg-brand-600 text-white border-brand-600'
                      : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {f === 'pending' ? 'Pending only' : 'All dues'}
                </button>
              ))}
            </div>
          </div>

          {loadingDues ? (
            <div className="flex flex-col gap-2">
              {[1, 2, 3].map(i => (
                <div key={i} className="border border-slate-200 rounded-xl p-3.5 animate-pulse">
                  <div className="flex justify-between">
                    <div className="h-4 w-32 bg-slate-100 rounded" />
                    <div className="h-4 w-16 bg-slate-100 rounded" />
                  </div>
                  <div className="h-3 w-24 bg-slate-100 rounded mt-2" />
                </div>
              ))}
            </div>
          ) : filteredDues.length === 0 ? (
            <div className="border border-dashed border-slate-200 rounded-xl py-10 text-center">
              {filter === 'pending' ? (
                <>
                  <BadgeCheck size={28} className="mx-auto text-green-400 mb-2" />
                  <p className="text-sm font-medium text-slate-600">All dues are paid</p>
                  <p className="text-xs text-slate-400 mt-1">Switch to "All dues" to see history</p>
                </>
              ) : (
                <>
                  <Wallet size={28} className="mx-auto text-slate-300 mb-2" />
                  <p className="text-sm font-medium text-slate-600">No fee dues found</p>
                  <p className="text-xs text-slate-400 mt-1">
                    Dues are auto-generated from fee structures.
                    <br />Ask admin to create a structure for this student's class.
                  </p>
                </>
              )}

              {/* Manual fee option always visible */}
              <Link
                href={`/dashboard/fees?student_uid=${selectedStudent.student_uid ?? ''}`}
                className="inline-flex items-center gap-1.5 mt-4 text-xs text-brand-600 hover:underline font-medium"
              >
                <Plus size={13} /> Record a manual fee instead
              </Link>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {filteredDues.map(due => (
                <DueCard
                  key={due.id}
                  due={due}
                  onCollect={setCollectingDue}
                />
              ))}

              {/* Manual fee link always at bottom */}
              <div className="mt-2 text-center">
                <Link
                  href={`/dashboard/fees?student_uid=${selectedStudent.student_uid ?? ''}`}
                  className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-brand-600 transition-colors"
                >
                  <Plus size={13} /> Record a manual / miscellaneous fee
                </Link>
              </div>
            </div>
          )}
        </>
      )}

      {/* Empty state — no student selected */}
      {!selectedStudent && !query && (
        <div className="border border-dashed border-slate-200 rounded-2xl py-16 text-center">
          <div className="w-14 h-14 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <Search size={22} className="text-slate-400" />
          </div>
          <h3 className="font-semibold text-slate-700">Search for a student</h3>
          <p className="text-sm text-slate-400 mt-1">
            Enter their name or student ID above to load their dues
          </p>
          <div className="flex items-center justify-center gap-4 mt-6">
            <div className="flex items-center gap-1.5 text-xs text-slate-400">
              <Clock size={12} /> Auto-generated dues
            </div>
            <div className="flex items-center gap-1.5 text-xs text-slate-400">
              <IndianRupee size={12} /> Full or partial payment
            </div>
            <div className="flex items-center gap-1.5 text-xs text-slate-400">
              <Printer size={12} /> Instant receipt
            </div>
          </div>
        </div>
      )}

      {/* Collect modal */}
      {collectingDue && selectedStudent && (
        <CollectModal
          due={collectingDue}
          student={selectedStudent}
          school={school}
          onClose={() => setCollectingDue(null)}
          onSuccess={handlePaymentSuccess}
        />
      )}

      {/* Receipt modal */}
      {receipt && selectedStudent && (
        <ReceiptModal
          receiptNumber={receipt.result.receipt_number}
          student={selectedStudent}
          due={receipt.due}
          amountPaid={receipt.amount}
          paymentMethod={receipt.method}
          paidDate={receipt.date}
          school={school}
          onClose={() => setReceipt(null)}
        />
      )}
    </div>
  )
}
