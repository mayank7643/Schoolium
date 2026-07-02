'use client'

// FILE: app/(dashboard)/dashboard/fees/collect/page.tsx
// Sprint 3 — Complete rebuild per blueprint
// 5-step flow: Omnibox → Live balances → Adjustable fields → Transaction → Immutable receipt
// Structured path: fee structure assigned (tuition locked, prev dues locked, late fee editable)
// Manual path: no fee structure (all fields from fixed category list, mandatory)
// Both paths: same immutable receipt, audit trail, reversal queue

import { useState, useEffect, useCallback, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/utils/supabase/client'
import Link from 'next/link'
import {
  Search, X, IndianRupee, CheckCircle2, AlertCircle,
  ChevronDown, ChevronUp, Printer, ArrowLeft,
  Lock, Unlock, Plus, Trash2, UserCheck,
  ShieldAlert, KeyRound, Clock, Filter, RotateCcw,
} from 'lucide-react'
import type { PaymentMethod } from '@/types'

// ── Types ─────────────────────────────────────────────────────────────────────

interface StudentResult {
  id: string
  full_name: string
  student_uid: string | null
  father_name: string | null
  parent_phone: string | null
  class_name: string | null
  class_section: string | null
  address?: string | null   // enriched on select (omnibox search does not return it)
}

// Short, privacy-friendly address for the receipt: first 1-2 comma segments,
// capped in length. Returns '' when there is no address.
function shortAddress(addr: string | null | undefined): string {
  if (!addr) return ''
  const parts = addr.split(',').map(p => p.trim()).filter(Boolean)
  let out = parts.length > 1 ? parts.slice(0, 2).join(', ') : (parts[0] || '')
  if (out.length > 40) out = out.slice(0, 40).trimEnd() + '…'
  return out
}

// Amount in words, Indian numbering (rupees only, whole number).
function amountInWords(num: number): string {
  const n = Math.round(num)
  if (n === 0) return 'Zero Rupees Only'
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
    'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
    'Seventeen', 'Eighteen', 'Nineteen']
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']
  function twoDigit(x: number): string {
    if (x < 20) return ones[x]
    return tens[Math.floor(x / 10)] + (x % 10 ? ' ' + ones[x % 10] : '')
  }
  function threeDigit(x: number): string {
    const h = Math.floor(x / 100)
    const r = x % 100
    return (h ? ones[h] + ' Hundred' + (r ? ' ' : '') : '') + (r ? twoDigit(r) : '')
  }
  const crore = Math.floor(n / 10000000)
  const lakh  = Math.floor((n % 10000000) / 100000)
  const thousand = Math.floor((n % 100000) / 1000)
  const rest  = n % 1000
  let words = ''
  if (crore)    words += threeDigit(crore) + ' Crore '
  if (lakh)     words += twoDigit(lakh) + ' Lakh '
  if (thousand) words += twoDigit(thousand) + ' Thousand '
  if (rest)     words += threeDigit(rest) + ' '
  return words.trim() + ' Rupees Only'
}

interface ClassOption { id: string; name: string; section: string | null }

interface SchoolInfo {
  id: string
  name: string
  phone: string | null
  late_fee_waiver_max_pct: number
  late_fee_waiver_max_flat: number
}

// Row from get_student_billing_summary RPC
interface BillingRow {
  student_id: string
  full_name: string
  student_uid: string | null
  father_name: string | null
  parent_phone: string | null
  class_name: string | null
  class_section: string | null
  fee_structure_id: string | null
  fee_structure_name: string | null
  has_fee_structure: boolean
  source: string        // 'structured' | 'manual'
  due_id: string | null
  fee_type: string | null
  due_label: string | null
  due_month: string | null
  due_date: string | null
  base_amount: number | null
  discount_amount: number | null
  net_amount: number | null
  late_fee_amount: number | null
  total_due: number | null
  amount_paid: number | null
  balance: number | null
  status: string | null
  late_fee_applied: boolean | null
  grand_total_due: number
  grand_total_paid: number
  grand_balance: number
}

// A pending due to be collected
interface PendingDue {
  due_id: string
  source: 'structured' | 'manual'
  fee_type: string
  label: string
  month: string
  due_date: string
  balance: number
  total_due: number
  amount_paid: number
  discount_amount: number
  late_fee_amount: number
  late_fee_applied: boolean
  status: string
  isCurrentMonth: boolean  // true = current month, false = previous arrear
}

// An additional fee line item admin adds (other fees section)
interface ExtraFee {
  id: string             // local key only
  fee_type: string
  label: string          // for 'custom' fee_type, label is freeform
  amount: number
  amountStr: string      // controlled input string
}

// A payment result from record_fee_payment RPC
interface PaymentResult {
  payment_id: string
  receipt_number: string
}

// Receipt line for combined success screen
interface ReceiptLine {
  label: string
  fee_type: string
  amount: number
  receipt_number: string
  payment_id: string        // fee_payments.id — needed for reversal request
  is_arrear?: boolean
  is_extra?: boolean
  discount_amount?: number
  late_fee_amount?: number
}

// ── Constants ─────────────────────────────────────────────────────────────────

const FEE_TYPES = [
  { value: 'tuition',     label: 'Tuition Fee' },
  { value: 'exam',        label: 'Exam Fee' },
  { value: 'transport',   label: 'Transport Fee' },
  { value: 'hostel',      label: 'Hostel Fee' },
  { value: 'admission',   label: 'Admission Fee' },
  { value: 'sports',      label: 'Sports Fee' },
  { value: 'library',     label: 'Library Fee' },
  { value: 'other',       label: 'Other (specify)' },
]

const PAYMENT_METHODS: { value: PaymentMethod; label: string }[] = [
  { value: 'cash',          label: 'Cash' },
  { value: 'upi',           label: 'UPI' },
  { value: 'bank_transfer', label: 'Bank Transfer' },
  { value: 'cheque',        label: 'Cheque' },
  { value: 'card',          label: 'Card' },
  { value: 'other',         label: 'Other' },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  return '₹' + Number(n).toLocaleString('en-IN')
}

function fmtDate(d: string): string {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
  })
}

function fmtMonth(ym: string): string {
  const [y, m] = ym.split('-')
  return new Date(parseInt(y), parseInt(m) - 1, 1)
    .toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
}

function currentMonthStr(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

function currentAcademicYear(): string {
  const now = new Date()
  const y   = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1
  return `${y}-${String(y + 1).slice(-2)}`
}

// ── Receipt HTML builder ──────────────────────────────────────────────────────

function buildReceiptHTML(params: {
  school: SchoolInfo
  student: StudentResult
  lines: ReceiptLine[]
  amountPaid: number
  method: PaymentMethod
  paidDate: string
  grandBalance: number
  generatedAt: string
}): string {
  const { school, student, lines, amountPaid, method, grandBalance, generatedAt } = params
  const formattedDateTime = new Date(generatedAt).toLocaleString('en-IN', {
    day: '2-digit', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  })
  const addrShort = shortAddress(student.address)
  const totalBilled = lines.reduce((s, l) => s + l.amount, 0)
  const paidWords = amountInWords(amountPaid)

  const currentLines = lines.filter(l => !l.is_arrear && !l.is_extra)
  const arrearLines  = lines.filter(l => l.is_arrear)
  const extraLines   = lines.filter(l => l.is_extra)

  function lineRow(l: ReceiptLine) {
    const discountNote = l.discount_amount && l.discount_amount > 0
      ? ` <span style="color:#16a34a;font-size:9px">(-₹${l.discount_amount.toLocaleString('en-IN')} disc)</span>` : ''
    const lateFeeNote  = l.late_fee_amount && l.late_fee_amount > 0
      ? ` <span style="color:#b45309;font-size:9px">(+₹${l.late_fee_amount.toLocaleString('en-IN')} late)</span>` : ''
    return `<tr>
      <td style="padding:3px 0;border-bottom:1px solid #f1f5f9;font-size:11px;color:#1e293b">${l.label}${discountNote}${lateFeeNote}</td>
      <td style="padding:3px 0;border-bottom:1px solid #f1f5f9;font-size:11px;text-align:right;font-weight:600;color:#1e293b">₹${l.amount.toLocaleString('en-IN')}</td>
    </tr>`
  }

  function section(title: string, rows: ReceiptLine[]) {
    if (rows.length === 0) return ''
    return `<tr><td colspan="2" style="padding:7px 0 2px;font-size:9px;font-weight:700;color:#64748b;letter-spacing:1px;text-transform:uppercase">${title}</td></tr>
      ${rows.map(lineRow).join('')}`
  }

  // One receipt copy. Rendered twice per A4 sheet: Office Copy + Student Copy.
  function copy(label: string) {
    return `<div class="copy">
  <div class="bar"></div>
  <div class="head">
    <div>
      <div class="school">${school.name}</div>
      ${school.phone ? `<div class="ph">Ph: ${school.phone}</div>` : ''}
    </div>
    <div class="tag">${label}</div>
  </div>
  <div class="rt">Fee Receipt</div>
  <div class="meta">
    <div class="mrow"><span class="ml">Student</span><span class="mv">${student.full_name}</span></div>
    ${student.student_uid ? `<div class="mrow"><span class="ml">ID</span><span class="mv mono">${student.student_uid}</span></div>` : ''}
    ${student.father_name ? `<div class="mrow"><span class="ml">Father</span><span class="mv">${student.father_name}</span></div>` : ''}
    ${addrShort ? `<div class="mrow"><span class="ml">Address</span><span class="mv">${addrShort}</span></div>` : ''}
    <div class="mrow"><span class="ml">Mode</span><span class="mv">${method.replace('_',' ').toUpperCase()}</span></div>
    <div class="mrow"><span class="ml">Date &amp; time</span><span class="mv">${formattedDateTime}</span></div>
  </div>
  <table>
    <thead><tr><th>Fee Head</th><th class="r">Amount</th></tr></thead>
    <tbody>
      ${section('Current Month Dues', currentLines)}
      ${section('Previous Arrears', arrearLines)}
      ${section('Additional Fees', extraLines)}
    </tbody>
  </table>
  <div class="totrow"><span>Total billed</span><span class="b">₹${totalBilled.toLocaleString('en-IN')}</span></div>
  <div class="box">
    <span class="pl">Paid Now</span>
    <span class="pv">₹${amountPaid.toLocaleString('en-IN')}</span>
  </div>
  <div class="words">(${paidWords})</div>
  ${grandBalance > 0 ? `<div class="bal">Outstanding balance after this payment: ₹${grandBalance.toLocaleString('en-IN')}</div>` : ''}
  <div class="sig"><div class="sigline">Authorized Signature</div></div>
  <div class="footer">${school.name}${school.phone ? ' · ' + school.phone : ''} · Computer-generated receipt</div>
</div>`
  }

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Fee Receipt</title>
<style>
@page { size: A4; margin: 6mm; }
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:Arial,sans-serif;background:#fff;color:#1e293b}
.copy{height:137mm;padding:0 2mm;page-break-inside:avoid;overflow:hidden}
.bar{background:#2563eb;height:5px;border-radius:3px;margin-bottom:8px}
.head{display:flex;justify-content:space-between;align-items:flex-start}
.school{font-size:16px;font-weight:700;color:#1e3a8a}
.ph{font-size:10px;color:#64748b;margin-top:2px}
.tag{font-size:10px;font-weight:700;color:#1d4ed8;border:1px solid #bfdbfe;background:#eff6ff;border-radius:4px;padding:3px 8px;letter-spacing:.5px;white-space:nowrap}
.rt{font-size:9px;color:#64748b;letter-spacing:2px;text-transform:uppercase;margin:6px 0 4px;border-bottom:1px dashed #cbd5e1;padding-bottom:6px}
.meta{display:grid;grid-template-columns:1fr 1fr;gap:0 16px;margin-bottom:8px}
.mrow{display:flex;justify-content:space-between;font-size:11px;padding:2px 0}
.ml{color:#64748b}.mv{font-weight:600}.mono{font-family:monospace}
table{width:100%;border-collapse:collapse}
th{font-size:9px;color:#94a3b8;text-align:left;padding-bottom:4px}
th.r{text-align:right}
.totrow{display:flex;justify-content:space-between;font-size:12px;padding:5px 0;border-top:1px solid #e2e8f0;margin-top:2px}
.totrow .b{font-weight:700}
.box{background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:8px 14px;margin:8px 0 2px;display:flex;justify-content:space-between;align-items:center}
.pl{font-size:10px;color:#1d4ed8;font-weight:700;text-transform:uppercase;letter-spacing:1px}
.pv{font-size:20px;font-weight:800;color:#1e3a8a}
.words{font-size:10px;color:#475569;font-style:italic;margin-bottom:4px}
.bal{font-size:10px;color:#b45309;background:#fffbeb;border:1px solid #fde68a;border-radius:5px;padding:5px 8px;margin-top:2px}
.sig{display:flex;justify-content:flex-end;margin-top:10px;padding-top:8px}
.sigline{border-top:1.5px solid #475569;width:130px;padding-top:4px;font-size:9px;color:#64748b;text-align:center}
.footer{margin-top:8px;text-align:center;font-size:9px;color:#94a3b8;line-height:1.5}
.cut{border-top:2px dashed #94a3b8;text-align:center;height:0;margin:1.5mm 0}
.cut span{position:relative;top:-9px;background:#fff;padding:0 10px;font-size:10px;color:#94a3b8}
@media print{.box,.tag,.bar{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style></head><body>
${copy('OFFICE COPY')}
<div class="cut"><span>✂ cut here</span></div>
${copy('STUDENT COPY')}
</body></html>`
}

// ── SuccessScreen ─────────────────────────────────────────────────────────────

function SuccessScreen({
  school, student, lines, amountPaid, method, paidDate,
  grandBalance, generatedAt, onCollectAnother, onClose,
}: {
  school: SchoolInfo
  student: StudentResult
  lines: ReceiptLine[]
  amountPaid: number
  method: PaymentMethod
  paidDate: string
  grandBalance: number
  generatedAt: string
  onCollectAnother: () => void
  onClose: () => void
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const totalBilled = lines.reduce((s, l) => s + l.amount, 0)
  const currentLines = lines.filter(l => !l.is_arrear && !l.is_extra)
  const arrearLines  = lines.filter(l => l.is_arrear)
  const extraLines   = lines.filter(l => l.is_extra)

  // Reversal request state
  const [showReversalForm, setShowReversalForm] = useState(false)
  const [reversalPaymentId, setReversalPaymentId] = useState<string>('')
  const [reversalReason,    setReversalReason]    = useState('')
  const [reversalSaving,    setReversalSaving]    = useState(false)
  const [reversalError,     setReversalError]     = useState('')
  const [reversalDone,      setReversalDone]      = useState<string | null>(null) // receipt_number of reversed payment

  function handlePrint() {
    const iframe = iframeRef.current
    if (!iframe?.contentWindow) return
    const html = buildReceiptHTML({ school, student, lines, amountPaid, method, paidDate, grandBalance, generatedAt })
    iframe.contentWindow.document.open()
    iframe.contentWindow.document.write(html)
    iframe.contentWindow.document.close()
    setTimeout(() => { iframe.contentWindow?.focus(); iframe.contentWindow?.print() }, 350)
  }

  async function handleRequestReversal() {
    if (!reversalPaymentId) { setReversalError('Select which payment to reverse'); return }
    if (!reversalReason.trim()) { setReversalError('Reason is required'); return }
    setReversalSaving(true)
    setReversalError('')
    const supabase = createClient()
    const { error } = await supabase.rpc('request_payment_reversal', {
      p_fee_payment_id: reversalPaymentId,
      p_reason:         reversalReason.trim(),
    })
    if (error) { setReversalError(error.message); setReversalSaving(false); return }
    const line = lines.find(l => l.payment_id === reversalPaymentId)
    setReversalDone(line?.receipt_number ?? 'payment')
    setReversalSaving(false)
    setShowReversalForm(false)
  }

  function LineGroup({ title, rows }: { title: string; rows: ReceiptLine[] }) {
    if (rows.length === 0) return null
    return (
      <div className="mt-3">
        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">{title}</p>
        {rows.map((l, i) => (
          <div key={i} className="flex items-center justify-between py-1.5 border-b border-slate-50 last:border-0 text-sm">
            <div className="flex-1 min-w-0 mr-3">
              <p className="text-slate-700 truncate">{l.label}</p>
              {l.discount_amount && l.discount_amount > 0 && (
                <p className="text-[10px] text-green-600">-{fmt(l.discount_amount)} discount</p>
              )}
              {l.late_fee_amount && l.late_fee_amount > 0 && (
                <p className="text-[10px] text-amber-600">+{fmt(l.late_fee_amount)} late fee</p>
              )}
            </div>
            <div className="text-right shrink-0">
              <p className="font-semibold text-slate-900">{fmt(l.amount)}</p>
              <p className="text-[10px] font-mono text-slate-400">{l.receipt_number}</p>
            </div>
          </div>
        ))}
      </div>
    )
  }

  const formattedDateTime = new Date(generatedAt).toLocaleString('en-IN', {
    day: '2-digit', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  })
  const addrShort = shortAddress(student.address)

  return (
    <div className="flex flex-col gap-4">
      {/* Banner */}
      <div className="bg-green-50 border border-green-200 rounded-2xl p-5 text-center">
        <CheckCircle2 size={40} className="mx-auto text-green-500 mb-2" />
        <p className="text-lg font-bold text-green-800">Payment recorded!</p>
        <p className="text-sm text-green-600 mt-1">{fmt(amountPaid)} collected</p>
      </div>

      {/* Receipt preview */}
      <div className="card p-5">
        <div className="h-1 bg-blue-600 rounded-full mb-4" />
        <p className="font-bold text-blue-900 text-base">{school.name}</p>
        <p className="text-[10px] text-slate-400 tracking-widest uppercase mt-0.5">Fee Receipt</p>

        <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-3 text-sm">
          {[
            ['Student',    student.full_name],
            ...(student.student_uid ? [['ID',       student.student_uid]] : []),
            ...(student.father_name  ? [['Father',   student.father_name]]  : []),
            ...(addrShort            ? [['Address',  addrShort]]            : []),
            ['Mode',       method.replace('_', ' ')],
            ['Date & time', formattedDateTime],
          ].map(([label, value]) => (
            <div key={label} className="flex flex-col">
              <span className="text-[10px] text-slate-400 uppercase tracking-wide">{label}</span>
              <span className="font-medium text-slate-800 text-sm truncate">{value}</span>
            </div>
          ))}
        </div>

        <div className="border-t border-slate-100 mt-4 pt-2">
          <LineGroup title="Current month dues"  rows={currentLines} />
          <LineGroup title="Previous arrears"    rows={arrearLines} />
          <LineGroup title="Additional fees"     rows={extraLines} />

          <div className="flex justify-between text-sm pt-3 mt-2 border-t border-slate-200">
            <span className="text-slate-500">Total billed</span>
            <span className="font-semibold text-slate-800">{fmt(totalBilled)}</span>
          </div>
        </div>

        <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 mt-4 flex justify-between items-center">
          <span className="text-[11px] font-bold text-blue-700 uppercase tracking-wider">Paid now</span>
          <span className="text-2xl font-extrabold text-blue-900">{fmt(amountPaid)}</span>
        </div>

        {grandBalance > 0 && (
          <div className="flex items-center gap-2 mt-3 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            <AlertCircle size={13} className="text-amber-600 shrink-0" />
            <p className="text-xs text-amber-700">
              Outstanding balance after this payment: <strong>{fmt(grandBalance)}</strong>
            </p>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <button onClick={handlePrint} className="btn-secondary flex items-center justify-center gap-2 py-3">
          <Printer size={15} /> Print receipt
        </button>
        <button onClick={onCollectAnother} className="btn-primary flex items-center justify-center gap-2 py-3">
          <UserCheck size={15} /> Collect another
        </button>
      </div>

      {/* ── Reversal request section ─────────────────────────────────────── */}
      {reversalDone ? (
        <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-700">
          <AlertCircle size={14} className="shrink-0 text-amber-500" />
          Reversal requested for {reversalDone}. Admin will review and approve.
        </div>
      ) : !showReversalForm ? (
        <button
          onClick={() => {
            setShowReversalForm(true)
            // Pre-select if only one payment
            if (lines.length === 1) setReversalPaymentId(lines[0].payment_id)
          }}
          className="text-xs text-red-400 hover:text-red-600 text-center py-1 transition-colors"
        >
          Made a mistake? Request reversal
        </button>
      ) : (
        <div className="border border-red-100 bg-red-50 rounded-xl p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-red-700">Request reversal</p>
            <button
              onClick={() => { setShowReversalForm(false); setReversalError(''); setReversalReason('') }}
              className="text-red-300 hover:text-red-500"
            >
              <X size={15} />
            </button>
          </div>

          <p className="text-xs text-red-600 bg-red-100 px-3 py-2 rounded-lg">
            This sends a reversal request to the admin. The payment is NOT reversed until admin approves.
            The original receipt is always preserved.
          </p>

          {/* Payment selector — only show if multiple payments in this session */}
          {lines.length > 1 && (
            <div>
              <label className="label text-red-700">Which payment to reverse *</label>
              <select
                className="input text-sm"
                value={reversalPaymentId}
                onChange={e => { setReversalPaymentId(e.target.value); setReversalError('') }}
              >
                <option value="">Select payment</option>
                {lines.map(l => (
                  <option key={l.payment_id} value={l.payment_id}>
                    {l.label} — {fmt(l.amount)} ({l.receipt_number})
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="label text-red-700">Reason *</label>
            <textarea
              className="input resize-none text-sm"
              rows={2}
              placeholder="e.g. Wrong amount entered, wrong student selected…"
              value={reversalReason}
              onChange={e => { setReversalReason(e.target.value); setReversalError('') }}
            />
          </div>

          {reversalError && (
            <div className="flex items-center gap-2 text-xs text-red-600">
              <AlertCircle size={12} className="shrink-0" /> {reversalError}
            </div>
          )}

          <button
            onClick={handleRequestReversal}
            disabled={reversalSaving}
            className="w-full py-2 text-sm font-semibold bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors disabled:opacity-50"
          >
            {reversalSaving
              ? <span className="flex items-center justify-center gap-2">
                  <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Submitting…
                </span>
              : 'Submit reversal request'}
          </button>
        </div>
      )}

      <button onClick={onClose} className="text-sm text-slate-400 hover:text-slate-600 text-center py-1 transition-colors">
        Close
      </button>

      <iframe ref={iframeRef} style={{ display: 'none' }} title="receipt-print" />
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function FeeCollectPage() {
  const debounceRef  = useRef<ReturnType<typeof setTimeout>>()
  const searchParams = useSearchParams()

  // ── State: search ──────────────────────────────────────────────────────────
  const [query,          setQuery]          = useState('')
  const [classFilter,    setClassFilter]    = useState('')
  const [classes,        setClasses]        = useState<ClassOption[]>([])
  const [results,        setResults]        = useState<StudentResult[]>([])
  const [searching,      setSearching]      = useState(false)
  const [showClassDrop,  setShowClassDrop]  = useState(false)

  // ── State: selected student ────────────────────────────────────────────────
  const [student,        setStudent]        = useState<StudentResult | null>(null)
  const [school,         setSchool]         = useState<SchoolInfo>({
    id: '', name: '', phone: null,
    late_fee_waiver_max_pct: 10, late_fee_waiver_max_flat: 200,
  })
  const [profile,        setProfile]        = useState<{ id: string; school_id: string } | null>(null)

  // ── State: billing data ────────────────────────────────────────────────────
  const [billingRows,    setBillingRows]    = useState<BillingRow[]>([])
  const [loadingBilling, setLoadingBilling] = useState(false)
  const [hasStructure,   setHasStructure]   = useState(false)
  const [structureName,  setStructureName]  = useState<string | null>(null)

  // ── State: pending dues (from billing rows) ────────────────────────────────
  const [currentDues,    setCurrentDues]    = useState<PendingDue[]>([])
  const [arrearDues,     setArrearDues]     = useState<PendingDue[]>([])

  // ── State: adjustable fields ───────────────────────────────────────────────
  // Late fee — structured path only, from due row; editable with waiver cap
  const [lateFeeAmount,    setLateFeeAmount]    = useState(0)
  const [lateFeeStr,       setLateFeeStr]       = useState('0')
  const [lateFeeOriginal,  setLateFeeOriginal]  = useState(0) // system value
  const [lateFeeWaived,    setLateFeeWaived]    = useState(0)
  const [showPinField,     setShowPinField]     = useState(false)
  const [pinInput,         setPinInput]         = useState('')
  const [pinError,         setPinError]         = useState('')
  const [pinUnlocked,      setPinUnlocked]      = useState(false)

  // Extra fees — both paths
  const [extraFees, setExtraFees] = useState<ExtraFee[]>([])

  // ── State: transaction ─────────────────────────────────────────────────────
  const [method,       setMethod]       = useState<PaymentMethod>('cash')
  // Payment date is locked to today -- it is never user-editable.
  const [paidDate]     = useState(new Date().toISOString().split('T')[0])
  const [notes,        setNotes]        = useState('')
  const [amountStr,    setAmountStr]    = useState('')   // "Amount being paid" field
  // Whether the collector manually changed the amount. While false, the amount
  // stays auto-filled to the full computed bill (dues + arrears + late + extras).
  const [amountEdited, setAmountEdited] = useState(false)
  const [saving,       setSaving]       = useState(false)
  const [saveError,    setSaveError]    = useState('')

  // ── State: success ─────────────────────────────────────────────────────────
  const [successData, setSuccessData] = useState<{
    lines: ReceiptLine[]
    amountPaid: number
    method: PaymentMethod
    paidDate: string
    grandBalance: number
    generatedAt: string   // ISO timestamp captured at the moment of payment
  } | null>(null)

  // ── Init: load school + profile + classes ──────────────────────────────────
  useEffect(() => {
    async function init() {
      const supabase = createClient()
      const [profileRes, classRes] = await Promise.all([
        supabase.from('profiles')
          .select('id, school_id, schools(id, name, phone, late_fee_waiver_max_pct, late_fee_waiver_max_flat)')
          .single(),
        supabase.from('classes').select('id, name, section').order('name'),
      ])
      if (profileRes.data) {
        const p = profileRes.data as any
        setProfile({ id: p.id, school_id: p.school_id })
        const s = Array.isArray(p.schools) ? p.schools[0] : p.schools
        if (s) setSchool({
          id: s.id, name: s.name, phone: s.phone ?? null,
          late_fee_waiver_max_pct:  Number(s.late_fee_waiver_max_pct  ?? 10),
          late_fee_waiver_max_flat: Number(s.late_fee_waiver_max_flat ?? 200),
        })
      }
      setClasses((classRes.data ?? []) as ClassOption[])
    }
    init()
  }, [])

  // ── Auto-load from student_id param ───────────────────────────────────────
  useEffect(() => {
    const sid = searchParams.get('student_id')
    if (!sid) return
    async function autoLoad() {
      const supabase = createClient()
      const { data } = await supabase
        .from('students')
        .select('id, full_name, student_uid, father_name, parent_phone, address, classes(name, section)')
        .eq('id', sid)
        .single()
      if (data) {
        const cls = Array.isArray((data as any).classes)
          ? (data as any).classes[0] ?? null
          : (data as any).classes
        const s: StudentResult = {
          id: data.id, full_name: data.full_name,
          student_uid: data.student_uid, father_name: data.father_name,
          parent_phone: data.parent_phone,
          address: (data as any).address ?? null,
          class_name: cls?.name ?? null, class_section: cls?.section ?? null,
        }
        selectStudent(s)
      }
    }
    autoLoad()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Debounced search ───────────────────────────────────────────────────────
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (!query.trim() || query.trim().length < 2) { setResults([]); return }
    debounceRef.current = setTimeout(async () => {
      setSearching(true)
      const supabase = createClient()
      const { data: p } = await supabase.from('profiles').select('school_id').single()
      if (!p) { setSearching(false); return }
      const { data } = await supabase.rpc('search_students_omnibox', {
        p_school_id: p.school_id,
        p_query:     query.trim(),
        p_class_id:  classFilter || null,
        p_limit:     10,
      })
      setResults((data ?? []) as StudentResult[])
      setSearching(false)
    }, 350)
  }, [query, classFilter])

  // ── Load billing summary ───────────────────────────────────────────────────
  const loadBilling = useCallback(async (s: StudentResult) => {
    setLoadingBilling(true)
    setBillingRows([])
    setCurrentDues([])
    setArrearDues([])
    setExtraFees([])
    setLateFeeAmount(0); setLateFeeStr('0'); setLateFeeOriginal(0); setLateFeeWaived(0)
    setPinUnlocked(false); setShowPinField(false); setPinInput(''); setPinError('')
    setSaveError('')

    const supabase = createClient()
    const { data, error } = await supabase.rpc('get_student_billing_summary', {
      p_student_id: s.id,
    })

    if (error || !data || data.length === 0) {
      // Student exists but no pending dues — show manual billing path
      setHasStructure(false)
      setStructureName(null)
      setBillingRows([])
      setLoadingBilling(false)
      return
    }

    const rows = data as BillingRow[]
    const firstRow = rows[0]
    setHasStructure(firstRow.has_fee_structure)
    setStructureName(firstRow.fee_structure_name ?? null)
    setBillingRows(rows)

    // Belt-and-suspenders: if the student object is missing father_name but the
    // billing summary has it, fill it in so the receipt shows it.
    if (firstRow.father_name && !s.father_name) {
      setStudent(prev => (prev && prev.id === s.id)
        ? { ...prev, father_name: firstRow.father_name }
        : prev)
    }

    // Build pending dues — split current month vs arrears
    const curMonth = currentMonthStr()
    const pendingDues: PendingDue[] = rows
      .filter(r => r.due_id !== null && r.balance && r.balance > 0)
      .map(r => ({
        due_id:          r.due_id!,
        source:          r.source as 'structured' | 'manual',
        fee_type:        r.fee_type ?? '',
        label:           r.due_label ?? '',
        month:           r.due_month ?? '',
        due_date:        r.due_date ?? '',
        balance:         Number(r.balance ?? 0),
        total_due:       Number(r.total_due ?? 0),
        amount_paid:     Number(r.amount_paid ?? 0),
        discount_amount: Number(r.discount_amount ?? 0),
        late_fee_amount: Number(r.late_fee_amount ?? 0),
        late_fee_applied: r.late_fee_applied ?? false,
        status:          r.status ?? 'unpaid',
        isCurrentMonth:  (r.due_month ?? '') === curMonth,
      }))

    const curr    = pendingDues.filter(d => d.isCurrentMonth)
    const arrears = pendingDues.filter(d => !d.isCurrentMonth)
    setCurrentDues(curr)
    setArrearDues(arrears)

    // Compute total late fee across all pending dues (editable by collector)
    const totalLate = pendingDues.reduce((s, d) => s + d.late_fee_amount, 0)
    setLateFeeOriginal(totalLate)
    setLateFeeAmount(totalLate)
    setLateFeeStr(String(totalLate))

    // Amount being paid is auto-filled by the effect above (full bill),
    // and stays editable. Reset the "edited" flag for the new student.
    setAmountEdited(false)

    setLoadingBilling(false)
  }, [])

  // Auto-fill "Amount being paid" with the full computed bill (current dues +
  // arrears + late fee + additional fees) until the collector edits it, so a
  // full payment never needs to be typed. Recomputed here to avoid depending
  // on render-scope values before the early returns below.
  useEffect(() => {
    if (amountEdited) return
    const total =
      currentDues.reduce((s, d) => s + d.balance, 0) +
      arrearDues.reduce((s, d) => s + d.balance, 0) +
      lateFeeAmount +
      extraFees.reduce((s, f) => s + (f.amount || 0), 0)
    setAmountStr(total > 0 ? String(total) : '')
  }, [currentDues, arrearDues, lateFeeAmount, extraFees, amountEdited])

  // ── Select / clear student ─────────────────────────────────────────────────
  async function selectStudent(s: StudentResult) {
    setQuery('')
    setResults([])
    setSuccessData(null)
    // Omnibox search results do not include the address, so pull it (and a
    // father-name fallback) before rendering, so the receipt has both.
    let full = s
    try {
      const supabase = createClient()
      const { data } = await supabase
        .from('students')
        .select('address, father_name')
        .eq('id', s.id)
        .single()
      if (data) {
        full = {
          ...s,
          address:     (data as any).address ?? null,
          father_name: s.father_name ?? (data as any).father_name ?? null,
        }
      }
    } catch { /* address is non-critical; fall back to what we have */ }
    setStudent(full)
    loadBilling(full)
  }

  function clearStudent() {
    setStudent(null)
    setBillingRows([])
    setCurrentDues([])
    setArrearDues([])
    setExtraFees([])
    setSuccessData(null)
    setAmountStr('')
    setAmountEdited(false)
    setSaveError('')
  }

  // ── Late fee waiver logic ──────────────────────────────────────────────────
  // Cap: min(pct%, flat₹) whichever is lower
  function lateFeeCap(): number {
    const capByPct  = lateFeeOriginal * (school.late_fee_waiver_max_pct / 100)
    const capByFlat = school.late_fee_waiver_max_flat
    return Math.min(capByPct, capByFlat)
  }

  function handleLateFeeChange(val: string) {
    setLateFeeStr(val)
    const parsed = parseFloat(val) || 0
    setLateFeeAmount(parsed)
    const waived = lateFeeOriginal - parsed
    setLateFeeWaived(waived)
    const cap = lateFeeCap()
    if (waived > cap && !pinUnlocked) {
      setShowPinField(true)
    } else if (waived <= cap) {
      setShowPinField(false)
      setPinUnlocked(false)
      setPinInput('')
      setPinError('')
    }
  }

  async function handlePinVerify() {
    // Verify admin PIN against school record
    const supabase = createClient()
    const { data } = await supabase
      .from('schools')
      .select('admin_override_pin')
      .eq('id', school.id)
      .single()
    const stored = (data as any)?.admin_override_pin
    if (!stored) { setPinError('No admin PIN set. Ask admin to set one.'); return }
    if (pinInput.trim() === stored) {
      setPinUnlocked(true)
      setShowPinField(false)
      setPinError('')
    } else {
      setPinError('Incorrect PIN')
    }
  }

  // ── Extra fees (manual add-on rows) ───────────────────────────────────────
  function addExtraFee() {
    setExtraFees(prev => [...prev, {
      id:        Math.random().toString(36).slice(2),
      fee_type:  'other',
      label:     '',
      amount:    0,
      amountStr: '',
    }])
  }

  function removeExtraFee(id: string) {
    setExtraFees(prev => prev.filter(f => f.id !== id))
  }

  function updateExtraFee(id: string, patch: Partial<ExtraFee>) {
    setExtraFees(prev => prev.map(f => f.id === id ? { ...f, ...patch } : f))
  }

  // ── Computed totals ────────────────────────────────────────────────────────
  const totalCurrentBalance = currentDues.reduce((s, d) => s + d.balance, 0)
  const totalArrearBalance  = arrearDues.reduce((s, d) => s + d.balance, 0)
  const totalExtraAmount    = extraFees.reduce((s, f) => s + (f.amount || 0), 0)
  const grandComputedBill   = totalCurrentBalance + totalArrearBalance + lateFeeAmount + totalExtraAmount
  const parsedAmountPaid    = parseFloat(amountStr) || 0
  const isPartial           = parsedAmountPaid < grandComputedBill && parsedAmountPaid > 0
  const isOverpay           = parsedAmountPaid > grandComputedBill

  // ── Validation before submit ───────────────────────────────────────────────
  function validate(): string | null {
    if (!student || !profile) return 'No student selected'
    if (parsedAmountPaid <= 0) return 'Enter amount being paid'
    if (isOverpay) return `Cannot exceed total bill of ${fmt(grandComputedBill)}`
    if (lateFeeWaived > lateFeeCap() && !pinUnlocked) return 'Admin PIN required to waive more than allowed'
    for (const f of extraFees) {
      if (!f.label.trim()) return 'Enter a description for each additional fee'
      if (f.amount <= 0)   return 'Each additional fee must have an amount > 0'
    }
    return null
  }

  // ── Submit: record payments ────────────────────────────────────────────────
  async function handleCollect() {
    const err = validate()
    if (err) { setSaveError(err); return }
    setSaving(true)
    setSaveError('')

    const supabase = createClient()
    const lines: ReceiptLine[] = []

    // Single allocation pass. Existing dues (current + arrears) are paid by
    // due_id via p_payments. Additional fees are created AND paid inside the
    // same atomic RPC via p_new_dues, so a failure can never leave an orphan
    // due behind. Everything shares ONE receipt number.
    let remaining = parsedAmountPaid

    type ExistingPay = {
      due_id: string
      amount: number
      meta: Omit<ReceiptLine, 'payment_id' | 'receipt_number'>
    }
    const existingPays: ExistingPay[] = []

    for (const due of currentDues) {
      if (remaining <= 0) break
      const toPay = Math.min(remaining, due.balance)
      if (toPay <= 0) continue
      existingPays.push({
        due_id: due.due_id,
        amount: toPay,
        meta: { label: due.label, fee_type: due.fee_type, amount: toPay,
                discount_amount: due.discount_amount, late_fee_amount: 0,
                is_arrear: false, is_extra: false },
      })
      remaining -= toPay
    }

    for (const due of arrearDues) {
      if (remaining <= 0) break
      const toPay = Math.min(remaining, due.balance)
      if (toPay <= 0) continue
      existingPays.push({
        due_id: due.due_id,
        amount: toPay,
        meta: { label: due.label + ` (${fmtMonth(due.month)})`, fee_type: due.fee_type,
                amount: toPay, is_arrear: true, is_extra: false },
      })
      remaining -= toPay
    }

    // Additional fees -> new manual dues, created + paid in the same call.
    type NewDuePayload = {
      fee_type: string
      label: string
      amount: number
      due_date: string
      month: string
      academic_year: string
      pay_amount: number
    }
    const newDues: NewDuePayload[] = []
    const extraMeta: Omit<ReceiptLine, 'payment_id' | 'receipt_number'>[] = []
    const curMonth = currentMonthStr()
    const acYear   = currentAcademicYear()

    for (const extra of extraFees) {
      if (extra.amount <= 0) continue
      const payNow = Math.min(remaining, extra.amount)
      if (payNow <= 0) break  // no money left to allocate
      newDues.push({
        fee_type:      extra.fee_type,
        label:         extra.label,
        amount:        extra.amount,
        due_date:      paidDate,
        month:         curMonth,
        academic_year: acYear,
        pay_amount:    payNow,
      })
      extraMeta.push({
        label: extra.label, fee_type: extra.fee_type, amount: payNow,
        is_arrear: false, is_extra: true,
      })
      remaining -= payNow
    }

    if (existingPays.length === 0 && newDues.length === 0) {
      setSaveError('Nothing to pay — all amounts are zero')
      setSaving(false)
      return
    }

    // ── Single atomic RPC: creates new dues + records all payments, one receipt ─
    const { data: bulkData, error: bulkError } = await supabase.rpc('record_bulk_fee_payment', {
      p_school_id:      profile!.school_id,
      p_student_id:     student!.id,
      p_payments:       existingPays.map(i => ({ due_id: i.due_id, amount: i.amount })),
      p_payment_method: method,
      p_paid_date:      paidDate,
      p_collected_by:   profile!.id,
      p_notes:          notes || null,
      p_new_dues:       newDues,
    })
    if (bulkError) { setSaveError(bulkError.message); setSaving(false); return }

    const bulkRows: { payment_id: string; receipt_number: string; due_id: string; amount_paid: number }[] =
      Array.isArray(bulkData) ? bulkData : []

    // Map existing-due payments back to receipt lines by due_id.
    for (const item of existingPays) {
      const row = bulkRows.find(r => r.due_id === item.due_id)
      if (!row) continue
      lines.push({ ...item.meta, payment_id: row.payment_id, receipt_number: row.receipt_number })
    }

    // Map new-due payments back. The RPC generates their due_ids server-side and
    // returns them after the existing-due rows, in p_new_dues order — so match
    // the leftover rows (due_ids not among the existing ones) positionally.
    const existingIds = new Set(existingPays.map(i => i.due_id))
    const newRows = bulkRows.filter(r => !existingIds.has(r.due_id))
    extraMeta.forEach((meta, idx) => {
      const row = newRows[idx]
      if (!row) return
      lines.push({ ...meta, payment_id: row.payment_id, receipt_number: row.receipt_number })
    })

    // ── Step 4: Audit events ─────────────────────────────────────────────────
    if (lateFeeWaived > 0) {
      await supabase.rpc('log_fee_audit_event', {
        p_event_type:      'late_fee_waived',
        p_student_id:      student!.id,
        p_original_value:  lateFeeOriginal,
        p_submitted_value: lateFeeAmount,
        p_notes:           pinUnlocked ? 'Admin PIN override used' : 'Within waiver cap',
      })
    }

    await supabase.rpc('log_fee_audit_event', {
      p_event_type:      'payment_collected',
      p_student_id:      student!.id,
      p_original_value:  grandComputedBill,
      p_submitted_value: parsedAmountPaid,
      p_notes:           notes || null,
    })

    const newGrandBalance = Math.max(0, grandComputedBill - parsedAmountPaid)

    setSaving(false)
    setSuccessData({
      lines,
      amountPaid:   parsedAmountPaid,
      method,
      paidDate,
      grandBalance: newGrandBalance,
      generatedAt:  new Date().toISOString(),  // date + time the receipt was generated
    })

    // Clear the fee-details form post payment. The receipt above keeps its own
    // snapshot (successData + student), so blanking these does not affect it —
    // it just prevents the now-paid dues from lingering in the form.
    setCurrentDues([])
    setArrearDues([])
    setExtraFees([])
    setAmountStr('')
    setAmountEdited(false)
    setLateFeeStr('0'); setLateFeeAmount(0); setLateFeeOriginal(0); setLateFeeWaived(0)
    setPinUnlocked(false); setShowPinField(false); setPinInput(''); setPinError('')
  }

  // ── Manual path: collect a standalone manual due ───────────────────────────
  // When student has no fee structure, everything is extra fees
  function totalManualBill(): number {
    return extraFees.reduce((s, f) => s + (f.amount || 0), 0)
  }

  // ── Section component: locked due rows ────────────────────────────────────
  function DueRow({ due }: { due: PendingDue }) {
    const isOverdue = due.due_date && new Date(due.due_date + 'T00:00:00') < new Date()
    return (
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 last:border-0">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-medium text-slate-800">{due.label}</p>
            {isOverdue && <span className="badge-red">Overdue</span>}
            {due.discount_amount > 0 && (
              <span className="text-[10px] text-green-600 bg-green-50 px-1.5 py-0.5 rounded">
                -{fmt(due.discount_amount)} disc
              </span>
            )}
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            {due.month ? fmtMonth(due.month) : ''}
            {due.due_date  ? ` · Due ${fmtDate(due.due_date)}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Lock size={12} className="text-slate-300" />
          <div className="text-right">
            <p className="font-bold text-slate-900">{fmt(due.balance)}</p>
            {due.amount_paid > 0 && (
              <p className="text-[10px] text-slate-400">{fmt(due.amount_paid)} paid</p>
            )}
          </div>
        </div>
      </div>
    )
  }

  // ── Render: success ────────────────────────────────────────────────────────
  if (successData && student) {
    return (
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <Link href="/dashboard/fees" className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 text-slate-500">
            <ArrowLeft size={18} />
          </Link>
          <h1 className="text-xl font-bold text-slate-900">Collect Fee</h1>
        </div>
        <SuccessScreen
          school={school}
          student={student}
          lines={successData.lines}
          amountPaid={successData.amountPaid}
          method={successData.method}
          paidDate={successData.paidDate}
          grandBalance={successData.grandBalance}
          generatedAt={successData.generatedAt}
          onCollectAnother={() => { setSuccessData(null); setExtraFees([]); if (student) loadBilling(student) }}
          onClose={clearStudent}
        />
      </div>
    )
  }

  // ── Render: main ───────────────────────────────────────────────────────────
  const hasAnyBilling = currentDues.length > 0 || arrearDues.length > 0
  const isManualPath  = !hasStructure || (!hasAnyBilling && !loadingBilling)

  return (
    <div className="max-w-2xl mx-auto">

      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <Link href="/dashboard/fees" className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 text-slate-500">
          <ArrowLeft size={18} />
        </Link>
        <div>
          <h1 className="text-xl font-bold text-slate-900">Collect Fee</h1>
          <p className="text-slate-500 text-sm mt-0.5">Search by name, father's name, phone, UID, or Aadhaar</p>
        </div>
      </div>

      {/* ── STEP 1: Omnibox ──────────────────────────────────────────────── */}
      <div className="relative mb-4">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              className="input pl-10 pr-10"
              placeholder="Name, father/mother name, phone, UID, Aadhaar…"
              value={query}
              onChange={e => setQuery(e.target.value)}
              autoComplete="off"
            />
            {query && (
              <button onClick={() => { setQuery(''); setResults([]) }}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                <X size={15} />
              </button>
            )}
          </div>
          <button
            onClick={() => setShowClassDrop(v => !v)}
            className={`flex items-center gap-1.5 px-3 border rounded-lg text-sm font-medium transition-colors ${
              classFilter ? 'bg-brand-600 text-white border-brand-600' : 'border-slate-200 text-slate-600 hover:bg-slate-50'
            }`}
          >
            <Filter size={14} />
            {classFilter ? (classes.find(c => c.id === classFilter)?.name ?? 'Class') : 'Class'}
          </button>
        </div>

        {/* Class dropdown */}
        {showClassDrop && (
          <div className="absolute top-full right-0 mt-1 bg-white border border-slate-200 rounded-xl shadow-lg z-20 w-56 py-1 overflow-hidden">
            <button onClick={() => { setClassFilter(''); setShowClassDrop(false) }}
              className={`w-full text-left px-4 py-2.5 text-sm hover:bg-slate-50 ${!classFilter ? 'font-semibold text-brand-600' : 'text-slate-700'}`}>
              All classes
            </button>
            {classes.map(c => (
              <button key={c.id} onClick={() => { setClassFilter(c.id); setShowClassDrop(false) }}
                className={`w-full text-left px-4 py-2.5 text-sm hover:bg-slate-50 ${classFilter === c.id ? 'font-semibold text-brand-600' : 'text-slate-700'}`}>
                {c.name}{c.section ? ` - ${c.section}` : ''}
              </button>
            ))}
          </div>
        )}

        {/* Search results */}
        {(results.length > 0 || searching) && query.length >= 2 && (
          <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-slate-200 rounded-xl shadow-lg z-20 overflow-hidden">
            {searching ? (
              <div className="px-4 py-3 text-sm text-slate-400">Searching…</div>
            ) : results.length === 0 ? (
              <div className="px-4 py-3 text-sm text-slate-400">No students found</div>
            ) : results.map(s => (
              <button key={s.id} onClick={() => selectStudent(s)}
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-slate-50 transition-colors text-left border-b border-slate-50 last:border-0">
                <div className="w-9 h-9 bg-brand-100 rounded-full flex items-center justify-center shrink-0">
                  <span className="text-brand-700 font-bold text-sm">{s.full_name.charAt(0)}</span>
                </div>
                <div className="min-w-0">
                  <p className="font-medium text-slate-900 text-sm">{s.full_name}</p>
                  <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                    {s.student_uid && <span className="font-mono text-[11px] text-slate-500">{s.student_uid}</span>}
                    {s.father_name && <span className="text-[11px] text-slate-400">· {s.father_name}</span>}
                    {s.class_name  && <span className="text-[11px] text-slate-400">· {s.class_name}{s.class_section ? ` - ${s.class_section}` : ''}</span>}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Student selected ──────────────────────────────────────────────── */}
      {student && (
        <>
          {/* Student card */}
          <div className="card p-4 mb-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 bg-brand-100 rounded-full flex items-center justify-center shrink-0">
                  <span className="text-brand-700 font-bold text-lg">{student.full_name.charAt(0)}</span>
                </div>
                <div>
                  <p className="font-semibold text-slate-900">{student.full_name}</p>
                  <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                    {student.student_uid && (
                      <span className="font-mono text-xs bg-brand-50 text-brand-700 border border-brand-200 px-1.5 py-0.5 rounded">
                        {student.student_uid}
                      </span>
                    )}
                    {student.class_name && (
                      <span className="text-xs text-slate-500">{student.class_name}{student.class_section ? ` - ${student.class_section}` : ''}</span>
                    )}
                    {student.father_name && <span className="text-xs text-slate-400">· {student.father_name}</span>}
                  </div>
                </div>
              </div>
              <button onClick={clearStudent} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 text-slate-400">
                <X size={16} />
              </button>
            </div>
            {structureName && (
              <div className="mt-3 pt-3 border-t border-slate-100 flex items-center gap-2 text-xs text-brand-700">
                <Lock size={11} className="text-brand-400" />
                <span>{structureName}</span>
              </div>
            )}
          </div>

          {/* Loading */}
          {loadingBilling && (
            <div className="flex flex-col gap-3">
              {[1, 2, 3].map(i => (
                <div key={i} className="card p-4 animate-pulse">
                  <div className="h-4 w-40 bg-slate-100 rounded mb-2" />
                  <div className="h-3 w-28 bg-slate-100 rounded" />
                </div>
              ))}
            </div>
          )}

          {!loadingBilling && (
            <div className="flex flex-col gap-4">

              {/* ── STEP 2A: Current month dues (LOCKED) ──────────────────── */}
              {currentDues.length > 0 && (
                <div className="card p-0 overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 bg-slate-50">
                    <div className="flex items-center gap-2">
                      <Lock size={13} className="text-slate-400" />
                      <p className="text-sm font-semibold text-slate-700">Current month dues</p>
                    </div>
                    <p className="text-sm font-bold text-slate-900">{fmt(totalCurrentBalance)}</p>
                  </div>
                  {currentDues.map(d => <DueRow key={d.due_id} due={d} />)}
                </div>
              )}

              {/* ── STEP 2B: Previous arrears (LOCKED) ───────────────────── */}
              {arrearDues.length > 0 && (
                <div className="card p-0 overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 bg-amber-50">
                    <div className="flex items-center gap-2">
                      <Clock size={13} className="text-amber-500" />
                      <p className="text-sm font-semibold text-amber-700">Previous arrears</p>
                    </div>
                    <p className="text-sm font-bold text-amber-700">{fmt(totalArrearBalance)}</p>
                  </div>
                  {arrearDues.map(d => <DueRow key={d.due_id} due={d} />)}
                </div>
              )}

              {/* ── STEP 3A: Late fee (EDITABLE with waiver cap) ──────────── */}
              {lateFeeOriginal > 0 && (
                <div className="card p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <Unlock size={13} className="text-slate-500" />
                      <p className="text-sm font-semibold text-slate-700">Late fee</p>
                    </div>
                    <p className="text-xs text-slate-400">
                      System: {fmt(lateFeeOriginal)} · Cap: {fmt(lateFeeCap())}
                    </p>
                  </div>

                  <div className="relative">
                    <IndianRupee size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                    <input
                      type="number"
                      min={0}
                      max={lateFeeOriginal}
                      step={1}
                      value={lateFeeStr}
                      onChange={e => handleLateFeeChange(e.target.value)}
                      className="input pl-8"
                    />
                  </div>

                  {lateFeeWaived > 0 && lateFeeWaived <= lateFeeCap() && (
                    <p className="text-xs text-amber-600 mt-2 bg-amber-50 px-2.5 py-1.5 rounded-lg">
                      Waiving {fmt(lateFeeWaived)} (within allowed cap of {fmt(lateFeeCap())})
                    </p>
                  )}

                  {/* Soft warn + PIN field when above cap */}
                  {showPinField && !pinUnlocked && (
                    <div className="mt-3 border border-amber-200 bg-amber-50 rounded-xl p-3">
                      <div className="flex items-center gap-2 mb-2">
                        <ShieldAlert size={14} className="text-amber-600 shrink-0" />
                        <p className="text-xs font-semibold text-amber-700">
                          Waiver of {fmt(lateFeeWaived)} exceeds allowed cap of {fmt(lateFeeCap())}.
                          Admin PIN required.
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <div className="relative flex-1">
                          <KeyRound size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                          <input
                            type="password"
                            inputMode="numeric"
                            placeholder="Admin PIN"
                            value={pinInput}
                            onChange={e => { setPinInput(e.target.value); setPinError('') }}
                            className="input pl-8 text-sm"
                          />
                        </div>
                        <button onClick={handlePinVerify} className="btn-primary text-sm px-4">
                          Verify
                        </button>
                      </div>
                      {pinError && (
                        <p className="text-xs text-red-600 mt-1.5 flex items-center gap-1">
                          <AlertCircle size={11} /> {pinError}
                        </p>
                      )}
                    </div>
                  )}

                  {pinUnlocked && (
                    <div className="mt-2 flex items-center gap-1.5 text-xs text-green-700 bg-green-50 px-2.5 py-1.5 rounded-lg">
                      <CheckCircle2 size={11} /> Admin override active — full waiver allowed
                    </div>
                  )}
                </div>
              )}

              {/* ── STEP 3B: Additional / other fees (BOTH PATHS) ────────── */}
              <div className="card p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Unlock size={13} className="text-slate-500" />
                    <p className="text-sm font-semibold text-slate-700">Additional fees</p>
                    <span className="text-[10px] text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">Optional</span>
                  </div>
                  <button onClick={addExtraFee} className="flex items-center gap-1 text-xs text-brand-600 hover:underline font-medium">
                    <Plus size={12} /> Add fee
                  </button>
                </div>

                {extraFees.length === 0 && (
                  <button onClick={addExtraFee}
                    className="w-full border border-dashed border-slate-200 rounded-xl py-4 text-xs text-slate-400 hover:border-brand-300 hover:text-brand-500 transition-colors">
                    + Add exam fee, transport, hostel, or any other charge
                  </button>
                )}

                <div className="flex flex-col gap-3">
                  {extraFees.map(f => (
                    <div key={f.id} className="border border-slate-200 rounded-xl p-3 flex flex-col gap-2">
                      <div className="flex gap-2">
                        <select
                          className="input text-sm flex-1"
                          value={f.fee_type}
                          onChange={e => updateExtraFee(f.id, { fee_type: e.target.value })}
                        >
                          {FEE_TYPES.map(ft => (
                            <option key={ft.value} value={ft.value}>{ft.label}</option>
                          ))}
                        </select>
                        <button onClick={() => removeExtraFee(f.id)}
                          className="w-8 h-8 flex items-center justify-center rounded-lg text-red-400 hover:bg-red-50 shrink-0">
                          <Trash2 size={14} />
                        </button>
                      </div>
                      <input
                        type="text"
                        className="input text-sm"
                        placeholder={f.fee_type === 'other' ? 'Description (required) *' : 'Label / description (required) *'}
                        value={f.label}
                        onChange={e => updateExtraFee(f.id, { label: e.target.value })}
                      />
                      <div className="relative">
                        <IndianRupee size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                        <input
                          type="text"
                          inputMode="numeric"
                          className="input pl-8 text-sm"
                          placeholder="Amount"
                          value={f.amountStr}
                          onChange={e => {
                            const val = e.target.value
                            if (val === '' || /^\d+(\.\d{0,2})?$/.test(val)) {
                              updateExtraFee(f.id, { amountStr: val, amount: parseFloat(val) || 0 })
                            }
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* ── STEP 4: Transaction ───────────────────────────────────── */}
              {(hasAnyBilling || extraFees.length > 0 || isManualPath) && (
                <div className="card p-4 flex flex-col gap-4">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold text-slate-700">Transaction</p>
                    {grandComputedBill > 0 && (
                      <p className="text-xs text-slate-500">
                        Total bill: <span className="font-bold text-slate-900">{fmt(grandComputedBill)}</span>
                      </p>
                    )}
                  </div>

                  {/* Bill breakdown summary */}
                  {grandComputedBill > 0 && (
                    <div className="bg-slate-50 rounded-xl p-3 flex flex-col gap-1 text-xs">
                      {totalCurrentBalance > 0 && (
                        <div className="flex justify-between">
                          <span className="text-slate-500">Current dues</span>
                          <span className="font-medium">{fmt(totalCurrentBalance)}</span>
                        </div>
                      )}
                      {totalArrearBalance > 0 && (
                        <div className="flex justify-between">
                          <span className="text-amber-600">Arrears</span>
                          <span className="font-medium text-amber-700">{fmt(totalArrearBalance)}</span>
                        </div>
                      )}
                      {lateFeeAmount > 0 && (
                        <div className="flex justify-between">
                          <span className="text-slate-500">Late fee</span>
                          <span className="font-medium">{fmt(lateFeeAmount)}</span>
                        </div>
                      )}
                      {totalExtraAmount > 0 && (
                        <div className="flex justify-between">
                          <span className="text-slate-500">Additional fees</span>
                          <span className="font-medium">{fmt(totalExtraAmount)}</span>
                        </div>
                      )}
                      <div className="flex justify-between pt-1.5 border-t border-slate-200 font-semibold text-sm">
                        <span>Total computed bill</span>
                        <span>{fmt(grandComputedBill)}</span>
                      </div>
                    </div>
                  )}

                  {/* Amount being paid — editable downward for partial */}
                  <div>
                    <label className="label">Amount being paid *</label>
                    <div className="relative">
                      <IndianRupee size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                      <input
                        type="text"
                        inputMode="numeric"
                        className="input pl-8 text-lg font-semibold"
                        placeholder={grandComputedBill > 0 ? `Up to ${fmt(grandComputedBill)}` : 'Enter amount'}
                        value={amountStr}
                        onChange={e => {
                          const val = e.target.value
                          if (val === '' || /^\d+(\.\d{0,2})?$/.test(val)) {
                            setAmountStr(val)
                            setAmountEdited(true)
                            setSaveError('')
                          }
                        }}
                      />
                    </div>
                    {/* Quick buttons */}
                    {grandComputedBill > 0 && (
                      <div className="flex gap-2 mt-2">
                        {[grandComputedBill, Math.ceil(grandComputedBill / 2)].map((a, i) => (
                          <button key={i} type="button"
                            onClick={() => { setAmountStr(String(a)); setAmountEdited(true) }}
                            className="flex-1 py-1.5 text-xs border border-slate-200 rounded-lg hover:bg-slate-50 text-slate-600 font-medium">
                            {i === 0 ? 'Full' : 'Half'}
                            <span className="block text-[10px] text-slate-400">{fmt(a)}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    {isPartial && (
                      <p className="text-xs text-amber-600 mt-1.5 bg-amber-50 px-2.5 py-1.5 rounded-lg">
                        Partial payment — {fmt(grandComputedBill - parsedAmountPaid)} will remain outstanding
                      </p>
                    )}
                    {isOverpay && (
                      <p className="text-xs text-red-600 mt-1.5">Amount exceeds total bill</p>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="label">Payment mode *</label>
                      <select className="input" value={method} onChange={e => setMethod(e.target.value as PaymentMethod)}>
                        {PAYMENT_METHODS.map(m => (
                          <option key={m.value} value={m.value}>{m.label}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="label">Payment date</label>
                      <div className="input flex items-center justify-between bg-slate-50 text-slate-600 cursor-not-allowed">
                        <span>{new Date(paidDate + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</span>
                        <Lock size={13} className="text-slate-400" />
                      </div>
                    </div>
                  </div>

                  <div>
                    <label className="label">Notes (optional)</label>
                    <input type="text" className="input" placeholder="e.g. Cheque no. 123456"
                      value={notes} onChange={e => setNotes(e.target.value)} />
                  </div>

                  {saveError && (
                    <div className="flex items-center gap-2 bg-red-50 text-red-600 text-sm px-3 py-2.5 rounded-lg">
                      <AlertCircle size={14} className="shrink-0" /> {saveError}
                    </div>
                  )}

                  {/* ── STEP 5: Immutable submit ─────────────────────────── */}
                  <button
                    onClick={handleCollect}
                    disabled={saving || parsedAmountPaid <= 0 || isOverpay || (grandComputedBill === 0 && totalManualBill() === 0)}
                    className="btn-primary w-full py-3 text-base font-semibold flex items-center justify-center gap-2 disabled:opacity-50"
                  >
                    {saving ? (
                      <><span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Recording…</>
                    ) : (
                      <><IndianRupee size={16} /> Generate Receipt — {parsedAmountPaid > 0 ? fmt(parsedAmountPaid) : ''}</>
                    )}
                  </button>
                  <p className="text-[10px] text-slate-400 text-center">
                    Receipt is permanent and cannot be edited after submission
                  </p>
                </div>
              )}

              {/* No dues + no extras: prompt to add fees */}
              {!hasAnyBilling && extraFees.length === 0 && !loadingBilling && (
                <div className="border border-dashed border-slate-200 rounded-xl py-10 text-center">
                  <IndianRupee size={28} className="mx-auto text-slate-300 mb-2" />
                  <p className="text-sm font-medium text-slate-600">No pending dues</p>
                  <p className="text-xs text-slate-400 mt-1 max-w-xs mx-auto">
                    {hasStructure
                      ? 'All structured dues are paid. Add an additional fee above to collect miscellaneous charges.'
                      : 'No fee structure assigned. Use "Add fee" above to collect any charges.'}
                  </p>
                </div>
              )}

            </div>
          )}
        </>
      )}

      {/* Empty state */}
      {!student && !query && (
        <div className="border border-dashed border-slate-200 rounded-2xl py-16 text-center">
          <div className="w-14 h-14 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <Search size={22} className="text-slate-400" />
          </div>
          <h3 className="font-semibold text-slate-700">Search for a student</h3>
          <p className="text-sm text-slate-400 mt-1 max-w-xs mx-auto">
            Type a name, father's name, phone number, student ID, or Aadhaar number
          </p>
        </div>
      )}

    </div>
  )
}
