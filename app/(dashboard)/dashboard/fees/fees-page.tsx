'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/utils/supabase/client'
import { IndianRupee, Plus, X, Printer, Pencil, Trash2, Search, CheckCircle2, AlertCircle } from 'lucide-react'

interface StudentOption {
  id: string
  full_name: string
  student_uid: string | null
  father_name: string | null
  class_id: string | null
  classes?: { name: string; section: string | null } | null
}

interface FeeRecord {
  id: string
  student_id: string
  fee_type: string
  amount: number
  status: string
  payment_method: string | null
  receipt_number: string | null
  paid_date: string | null
  due_date: string | null
  period_month: string | null   // stored as YYYY-MM-01, displayed as "June 2026"
  notes: string | null
  created_at: string
  students?: {
    full_name: string
    student_uid: string | null
    father_name: string | null
    classes?: { name: string; section: string | null } | null
  } | null
}

interface ClassOption { id: string; name: string; section: string | null }
interface SchoolInfo { name: string; phone: string }

function generateReceiptNumber(): string {
  const d = new Date()
  const yr = d.getFullYear().toString().slice(2)
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  return `RCP-${yr}${mo}-${Math.floor(1000 + Math.random() * 9000)}`
}

function ReceiptModal({
  fee, school, onClose,
}: {
  fee: FeeRecord; school: SchoolInfo; onClose: () => void
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null)

  const feeDate = fee.paid_date
    ? new Date(fee.paid_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' })
    : fee.due_date
    ? new Date(fee.due_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' })
    : new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' })

  const statusColor = fee.status === 'paid' ? '#166534' : fee.status === 'overdue' ? '#991b1b' : '#854d0e'
  const statusBg = fee.status === 'paid' ? '#dcfce7' : fee.status === 'overdue' ? '#fee2e2' : '#fef9c3'
  const className = fee.students?.classes
    ? `${fee.students.classes.name}${fee.students.classes.section ? ' - ' + fee.students.classes.section : ''}`
    : null

  const receiptHTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Receipt ${fee.receipt_number}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: Arial, sans-serif; background: #fff; color: #1e293b; padding: 32px; max-width: 500px; margin: 0 auto; }
  .top-bar { background: linear-gradient(90deg, #2563eb, #1d4ed8); height: 6px; border-radius: 4px; margin-bottom: 28px; }
  .school { font-size: 22px; font-weight: 700; color: #1e3a8a; letter-spacing: -0.3px; }
  .receipt-label { font-size: 10px; color: #64748b; letter-spacing: 2.5px; text-transform: uppercase; margin-top: 3px; }
  .rcpnum { font-size: 11px; color: #94a3b8; margin-top: 5px; font-family: monospace; }
  .divider { border: none; border-top: 1px dashed #cbd5e1; margin: 18px 0; }
  .amount-box { background: linear-gradient(135deg, #eff6ff, #dbeafe); border: 1px solid #bfdbfe; border-radius: 12px; padding: 16px 20px; margin: 16px 0; display: flex; justify-content: space-between; align-items: center; }
  .amount-label { font-size: 12px; color: #1d4ed8; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; }
  .amount-value { font-size: 28px; font-weight: 800; color: #1e3a8a; letter-spacing: -1px; }
  .table { width: 100%; border-collapse: collapse; }
  .table tr td { padding: 8px 0; border-bottom: 1px solid #f1f5f9; font-size: 13px; }
  .table tr:last-child td { border-bottom: none; }
  .table .label { color: #64748b; width: 45%; }
  .table .value { font-weight: 600; color: #1e293b; text-align: right; text-transform: capitalize; }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; background: ${statusBg}; color: ${statusColor}; }
  .uid { font-family: monospace; font-size: 12px; background: #f0f4ff; color: #3730a3; padding: 1px 6px; border-radius: 4px; }
  .sig-area { display: flex; justify-content: flex-end; margin-top: 28px; padding-top: 16px; border-top: 1px solid #e2e8f0; }
  .sig-box { text-align: center; }
  .sig-line { border-top: 1.5px solid #475569; width: 150px; padding-top: 6px; font-size: 10px; color: #64748b; letter-spacing: 0.5px; }
  .footer { margin-top: 20px; text-align: center; font-size: 10px; color: #94a3b8; line-height: 1.6; }
  @media print {
    body { padding: 20px; }
    .top-bar, .amount-box, .badge { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style>
</head>
<body>
  <div class="top-bar"></div>
  <div class="school">${school.name}</div>
  <div class="receipt-label">Fee Receipt</div>
  <div class="rcpnum">${fee.receipt_number ?? ''}</div>
  <hr class="divider">
  <div class="amount-box">
    <span class="amount-label">Amount Paid</span>
    <span class="amount-value">₹${Number(fee.amount).toLocaleString('en-IN')}</span>
  </div>
  <table class="table">
    <tr><td class="label">Student Name</td><td class="value">${fee.students?.full_name ?? '—'}</td></tr>
    ${fee.students?.student_uid ? `<tr><td class="label">Student ID</td><td class="value"><span class="uid">${fee.students.student_uid}</span></td></tr>` : ''}
    ${className ? `<tr><td class="label">Class</td><td class="value">${className}</td></tr>` : ''}
    ${fee.students?.father_name ? `<tr><td class="label">Father's Name</td><td class="value">${fee.students.father_name}</td></tr>` : ''}
    <tr><td class="label">Fee Type</td><td class="value">${fee.fee_type}</td></tr>
    ${fee.period_month ? `<tr><td class="label">Fee Period</td><td class="value">${new Date(fee.period_month + 'T00:00:00').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}</td></tr>` : ''}
    <tr><td class="label">Status</td><td class="value"><span class="badge">${fee.status}</span></td></tr>
    ${fee.payment_method ? `<tr><td class="label">Payment Via</td><td class="value">${fee.payment_method.replace('_', ' ')}</td></tr>` : ''}
    <tr><td class="label">Date</td><td class="value">${feeDate}</td></tr>
    ${fee.notes ? `<tr><td class="label">Notes</td><td class="value">${fee.notes}</td></tr>` : ''}
  </table>
  <div class="sig-area"><div class="sig-box"><div class="sig-line">Authorized Signature</div></div></div>
  <div class="footer">${school.name} &nbsp;·&nbsp; ${school.phone}<br>This is a computer-generated receipt. No physical signature required.</div>
</body>
</html>`

  function handlePrint() {
    const iframe = iframeRef.current
    if (!iframe || !iframe.contentWindow) return
    iframe.contentWindow.document.open()
    iframe.contentWindow.document.write(receiptHTML)
    iframe.contentWindow.document.close()
    setTimeout(() => { iframe.contentWindow?.focus(); iframe.contentWindow?.print() }, 350)
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 px-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <span className="font-semibold text-slate-900">Fee Receipt</span>
          <div className="flex gap-2">
            <button onClick={handlePrint} className="btn-primary flex items-center gap-1.5 text-sm py-1.5 px-3">
              <Printer size={14} /> Print / Save PDF
            </button>
            <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100">
              <X size={17} className="text-slate-500" />
            </button>
          </div>
        </div>

        {/* Preview */}
        <div className="p-4 max-h-[75vh] overflow-y-auto">
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-5">
            <div className="h-1.5 bg-gradient-to-r from-blue-600 to-blue-500 rounded-full mb-5" />
            <div className="text-[17px] font-bold text-blue-900">{school.name}</div>
            <div className="text-[10px] text-slate-400 tracking-widest uppercase mt-0.5">Fee Receipt</div>
            <div className="text-[11px] text-slate-400 font-mono mt-1">{fee.receipt_number}</div>

            <div className="bg-gradient-to-br from-blue-50 to-blue-100 border border-blue-200 rounded-xl px-4 py-3 my-4 flex justify-between items-center">
              <span className="text-[11px] font-bold text-blue-700 uppercase tracking-wider">Amount Paid</span>
              <span className="text-2xl font-extrabold text-blue-900">₹{Number(fee.amount).toLocaleString('en-IN')}</span>
            </div>

            <div className="flex flex-col gap-2 text-[13px]">
              {[
                ['Student', fee.students?.full_name ?? '—'],
                ...(fee.students?.student_uid ? [['Student ID', fee.students.student_uid]] : []),
                ...(className ? [['Class', className]] : []),
                ...(fee.students?.father_name ? [["Father's Name", fee.students.father_name]] : []),
                ['Fee Type', fee.fee_type],
                ...(fee.period_month ? [['Fee Period', new Date(fee.period_month + 'T00:00:00').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })]] : []),
                ['Status', fee.status],
                ...(fee.payment_method ? [['Payment Via', fee.payment_method.replace('_', ' ')]] : []),
                ['Date', feeDate],
                ...(fee.notes ? [['Notes', fee.notes]] : []),
              ].map(([label, value]) => (
                <div key={label} className="flex justify-between items-center py-1.5 border-b border-slate-100 last:border-0">
                  <span className="text-slate-500">{label}</span>
                  <span className="font-semibold text-slate-800 capitalize text-right max-w-[55%]">
                    {label === 'Status'
                      ? <span style={{ background: statusBg, color: statusColor }} className="px-2 py-0.5 rounded-full text-[11px] font-bold uppercase">{value}</span>
                      : label === 'Student ID'
                      ? <span className="font-mono text-[12px] bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded">{value}</span>
                      : value}
                  </span>
                </div>
              ))}
            </div>

            <div className="flex justify-end mt-5 pt-4 border-t border-slate-200">
              <div className="text-center">
                <div style={{ borderTop: '1.5px solid #475569', paddingTop: '5px', width: '130px', fontSize: '10px', color: '#64748b' }}>
                  Authorized Signature
                </div>
              </div>
            </div>

            <div className="mt-4 text-center text-[10px] text-slate-400">
              {school.name} · {school.phone}<br />
              Computer-generated receipt
            </div>
          </div>
        </div>
      </div>
      <iframe ref={iframeRef} style={{ display: 'none' }} title="print-frame" />
    </div>
  )
}

function EditFeeModal({
  fee, onClose, onSaved,
}: {
  fee: FeeRecord; onClose: () => void; onSaved: () => void
}) {
  const [form, setForm] = useState({
    amount: String(fee.amount),
    fee_type: fee.fee_type,
    period_month: fee.period_month ?? '',
    status: fee.status,
    payment_method: fee.payment_method ?? '',
    due_date: fee.due_date ?? '',
    paid_date: fee.paid_date ?? '',
    notes: fee.notes ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  function handleChange(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) {
    const { name, value } = e.target
    if (name === 'amount' && value && !/^\d*$/.test(value)) return
    setForm({ ...form, [name]: value })
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!form.amount || Number(form.amount) <= 0) { setError('Enter valid amount'); return }
    setSaving(true); setError('')
    const supabase = createClient()
    const { error } = await supabase.from('fees').update({
      amount: parseFloat(form.amount),
      fee_type: form.fee_type,
      period_month: form.period_month || null,
      status: form.status,
      payment_method: form.payment_method || null,
      due_date: form.due_date || null,
      paid_date: form.status === 'paid' ? (form.paid_date || new Date().toISOString().split('T')[0]) : null,
      notes: form.notes || null,
    }).eq('id', fee.id)
    if (error) { setError(error.message); setSaving(false); return }
    onSaved()
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-slate-100">
          <h2 className="font-semibold text-slate-900">Edit fee record</h2>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100">
            <X size={18} className="text-slate-500" />
          </button>
        </div>
        <form onSubmit={handleSave} className="p-5 flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Amount (₹) *</label>
              <input name="amount" type="text" inputMode="numeric" className="input" value={form.amount} onChange={handleChange} required />
            </div>
            <div>
              <label className="label">Fee type *</label>
              <select name="fee_type" className="input" value={form.fee_type} onChange={handleChange}>
                <option value="tuition">Tuition</option>
                <option value="exam">Exam</option>
                <option value="transport">Transport</option>
                <option value="other">Other</option>
              </select>
            </div>
          </div>
          {/* Fee period */}
          <div>
            <label className="label">
              Fee period <span className="text-slate-400 font-normal">(month this payment covers)</span>
            </label>
            <input
              name="period_month"
              type="month"
              className="input"
              value={form.period_month}
              onChange={handleChange}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Status *</label>
              <select name="status" className="input" value={form.status} onChange={handleChange}>
                <option value="pending">Pending</option>
                <option value="paid">Paid</option>
                <option value="overdue">Overdue</option>
              </select>
            </div>
            <div>
              <label className="label">Payment method</label>
              <select name="payment_method" className="input" value={form.payment_method} onChange={handleChange}>
                <option value="">Select</option>
                <option value="cash">Cash</option>
                <option value="upi">UPI</option>
                <option value="bank_transfer">Bank transfer</option>
                <option value="online">Online</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Due date</label>
              <input name="due_date" type="date" className="input" value={form.due_date} onChange={handleChange} />
            </div>
            <div>
              <label className="label">Paid date</label>
              <input name="paid_date" type="date" className="input" value={form.paid_date} onChange={handleChange} />
            </div>
          </div>
          <div>
            <label className="label">Notes</label>
            <textarea name="notes" className="input resize-none" rows={2} value={form.notes} onChange={handleChange} />
          </div>
          {error && <div className="bg-red-50 text-red-600 text-sm px-3 py-2 rounded-lg">{error}</div>}
          <button type="submit" className="btn-primary w-full py-2.5" disabled={saving}>
            {saving
              ? <span className="flex items-center justify-center gap-2"><span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />Saving...</span>
              : 'Save changes'}
          </button>
        </form>
      </div>
    </div>
  )
}

// ─── Student ID Lookup Component ─────────────────────────────────────────────
function StudentLookup({
  students,
  selectedStudentId,
  onSelect,
  initialUid = '',
}: {
  students: StudentOption[]
  selectedStudentId: string
  onSelect: (id: string) => void
  initialUid?: string
}) {
  const [uidInput, setUidInput] = useState(initialUid)
  const [lookupError, setLookupError] = useState('')

  // Auto-trigger lookup when initialUid is provided (prefill from student profile)
  const didAutoLookup = useRef(false)
  useEffect(() => {
    if (!initialUid || didAutoLookup.current || students.length === 0) return
    didAutoLookup.current = true
    const found = students.find(s => s.student_uid?.toUpperCase() === initialUid.toUpperCase())
    if (found) {
      setLookupError('')
      onSelect(found.id)
    } else {
      setLookupError(`No student found with ID "${initialUid.toUpperCase()}"`)
    }
  }, [initialUid, students, onSelect])

  const selectedStudent = students.find(s => s.id === selectedStudentId) ?? null

  const className = selectedStudent?.classes
    ? `${selectedStudent.classes.name}${selectedStudent.classes.section ? ' - ' + selectedStudent.classes.section : ''}`
    : null

  function handleLookup() {
    const trimmed = uidInput.trim().toUpperCase()
    if (!trimmed) { setLookupError('Enter a student ID'); return }
    const found = students.find(
      s => s.student_uid?.toUpperCase() === trimmed
    )
    if (!found) {
      setLookupError(`No student found with ID "${trimmed}"`)
      onSelect('')
      return
    }
    setLookupError('')
    onSelect(found.id)
  }

  function handleClear() {
    setUidInput('')
    setLookupError('')
    onSelect('')
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); handleLookup() }
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Step 1: ID input */}
      <div>
        <label className="label">Student ID *</label>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              className="input pl-8 font-mono uppercase tracking-wider"
              placeholder="e.g. NA-26-0001"
              value={uidInput}
              onChange={e => { setUidInput(e.target.value); setLookupError(''); if (!e.target.value) onSelect('') }}
              onKeyDown={handleKeyDown}
            />
          </div>
          <button
            type="button"
            onClick={handleLookup}
            className="btn-secondary text-sm px-4 shrink-0"
          >
            Find
          </button>
        </div>
        {lookupError && (
          <div className="flex items-center gap-1.5 mt-1.5 text-red-600 text-xs">
            <AlertCircle size={12} /> {lookupError}
          </div>
        )}
      </div>

      {/* Step 2: Resolved student card */}
      {selectedStudent ? (
        <div className="flex items-center justify-between bg-green-50 border border-green-200 rounded-xl px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-brand-100 rounded-full flex items-center justify-center shrink-0">
              <span className="text-brand-700 font-bold text-sm">
                {selectedStudent.full_name.charAt(0).toUpperCase()}
              </span>
            </div>
            <div>
              <p className="font-semibold text-slate-900 text-sm">{selectedStudent.full_name}</p>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="font-mono text-[11px] text-slate-500 bg-white border border-slate-200 px-1.5 py-0.5 rounded">
                  {selectedStudent.student_uid}
                </span>
                {className && (
                  <span className="text-[11px] text-slate-500">· {className}</span>
                )}
                {selectedStudent.father_name && (
                  <span className="text-[11px] text-slate-400">· {selectedStudent.father_name}</span>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <CheckCircle2 size={16} className="text-green-600 shrink-0" />
            <button
              type="button"
              onClick={handleClear}
              className="w-6 h-6 flex items-center justify-center rounded hover:bg-green-100 text-slate-400 hover:text-slate-600"
            >
              <X size={13} />
            </button>
          </div>
        </div>
      ) : (
        <div className="bg-slate-50 border border-dashed border-slate-200 rounded-xl px-4 py-3 text-center">
          <p className="text-xs text-slate-400">
            Enter the student&apos;s ID above and click <span className="font-medium text-slate-500">Find</span> to look them up
          </p>
        </div>
      )}
    </div>
  )
}

export default function FeesPage() {
  const [fees, setFees] = useState<FeeRecord[]>([])
  const [feesTotal, setFeesTotal] = useState(0)
  const [feesPage, setFeesPage] = useState(0)
  const [feesHasMore, setFeesHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [students, setStudents] = useState<StudentOption[]>([])
  const [classes, setClasses] = useState<ClassOption[]>([])
  const [school, setSchool] = useState<SchoolInfo>({ name: '', phone: '' })
  const [loading, setLoading] = useState(true)
  const [classLoading, setClassLoading] = useState(false)
  const [showModal, setShowModal] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [selectedFee, setSelectedFee] = useState<FeeRecord | null>(null)
  const [editingFee, setEditingFee] = useState<FeeRecord | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [classFilter, setClassFilter] = useState('')
  const [form, setForm] = useState({
    student_id: '', amount: '', fee_type: 'tuition',
    period_month: '',
    due_date: '', paid_date: '', status: 'pending', payment_method: '', notes: '',
  })

  const fetchData = useCallback(async (cls?: string, pageNum = 0, append = false) => {
    const supabase = createClient()
    const FEE_PAGE = 100
    const from = pageNum * FEE_PAGE
    const to   = from + FEE_PAGE - 1

    const [feesRes, studentsRes, classesRes, profileRes] = await Promise.all([
      supabase
        .from('fees')
        .select('*, students(full_name, student_uid, father_name, class_id, classes(name, section))', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(from, to),
      supabase.from('students').select('id, full_name, student_uid, father_name, class_id, classes(name, section)').eq('is_active', true).order('full_name').limit(500),
      supabase.from('classes').select('id, name, section').order('name'),
      supabase.from('profiles').select('school_id, schools(name, phone)').single(),
    ])

    let newFees = (feesRes.data ?? []) as FeeRecord[]
    const total = feesRes.count ?? 0
    // client-side class filter (fast — only 100 records max)
    if (cls) newFees = newFees.filter(f => (f.students as any)?.class_id === cls)

    if (append) {
      setFees(prev => [...prev, ...newFees])
    } else {
      setFees(newFees)
    }
    setFeesTotal(total)
    setFeesPage(pageNum)
    setFeesHasMore(from + newFees.length < total)

    setStudents((studentsRes.data ?? []) as any as StudentOption[])
    setClasses((classesRes.data ?? []) as ClassOption[])
    const s = (profileRes.data as any)?.schools
    if (s) setSchool({ name: s.name ?? '', phone: s.phone ?? '' })
    setLoading(false)
    setClassLoading(false)
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  // ── Prefill: read ?student_uid= query param set by student profile page ──────
  const searchParams = useSearchParams()
  const prefillUid = searchParams.get('student_uid') ?? ''

  // Auto-open modal when arriving via prefill link
  const prefillHandled = useRef(false)
  useEffect(() => {
    if (!prefillUid || prefillHandled.current || loading) return
    prefillHandled.current = true
    setForm({ student_id: '', amount: '', fee_type: 'tuition', period_month: '', due_date: '', paid_date: '', status: 'pending', payment_method: '', notes: '' })
    setError('')
    setShowModal(true)
  }, [prefillUid, loading])


  async function handleLoadMoreFees() {
    setLoadingMore(true)
    await fetchData(classFilter || undefined, feesPage + 1, true)
    setLoadingMore(false)
  }

  async function handleClassFilter(cls: string) {
    setClassFilter(cls)
    setClassLoading(true)
    await fetchData(cls || undefined, 0, false)
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) {
    const { name, value } = e.target
    if (name === 'amount' && value && !/^\d*$/.test(value)) return
    setForm({ ...form, [name]: value })
  }

  function handleModalOpen() {
    setForm({ student_id: '', amount: '', fee_type: 'tuition', period_month: '', due_date: '', paid_date: '', status: 'pending', payment_method: '', notes: '' })
    setError('')
    setShowModal(true)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.student_id) { setError('Please look up and select a student first'); return }
    if (!form.amount || Number(form.amount) <= 0) { setError('Enter a valid amount'); return }
    setSaving(true); setError('')
    const supabase = createClient()
    const { data: profile } = await supabase.from('profiles').select('school_id').single()
    const { error } = await supabase.from('fees').insert({
      ...form,
      school_id: profile?.school_id,
      amount: parseFloat(form.amount),
      receipt_number: generateReceiptNumber(),
      period_month: form.period_month || null,
      due_date: form.due_date || null,
      paid_date: form.status === 'paid' ? (form.paid_date || new Date().toISOString().split('T')[0]) : null,
      payment_method: form.payment_method || null,
    })
    if (error) { setError(error.message); setSaving(false); return }
    setShowModal(false)
    setForm({ student_id: '', amount: '', fee_type: 'tuition', period_month: '', due_date: '', paid_date: '', status: 'pending', payment_method: '', notes: '' })
    fetchData(classFilter)
    setSaving(false)
  }

  async function handleDelete(id: string) {
    setDeletingId(id)
    const supabase = createClient()
    await supabase.from('fees').delete().eq('id', id)
    setDeletingId(null)
    fetchData(classFilter)
  }

  const totalCollected = fees.filter(f => f.status === 'paid').reduce((s, f) => s + Number(f.amount), 0)
  const totalPending = fees.filter(f => f.status === 'pending' || f.status === 'overdue').reduce((s, f) => s + Number(f.amount), 0)

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Fees</h1>
          <p className="text-slate-500 text-sm mt-1">
            {feesTotal > fees.length
              ? `Showing ${fees.length} of ${feesTotal} records`
              : `${fees.length} record${fees.length !== 1 ? 's' : ''}${classFilter ? ' in this class' : ''}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/dashboard/fees/summary" className="btn-secondary flex items-center gap-2 text-sm">
            Class summary
          </Link>
          <button onClick={handleModalOpen} className="btn-primary flex items-center gap-2 text-sm">
            <Plus size={16} /> Record payment
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4 mb-5">
        <div className="stat-card">
          <div className="w-9 h-9 bg-green-50 rounded-lg flex items-center justify-center mb-3">
            <IndianRupee size={18} className="text-green-600" />
          </div>
          <p className="text-2xl font-bold text-slate-900">₹{totalCollected.toLocaleString('en-IN')}</p>
          <p className="text-xs text-slate-500">Total collected</p>
        </div>
        <div className="stat-card">
          <div className="w-9 h-9 bg-yellow-50 rounded-lg flex items-center justify-center mb-3">
            <IndianRupee size={18} className="text-yellow-600" />
          </div>
          <p className="text-2xl font-bold text-slate-900">₹{totalPending.toLocaleString('en-IN')}</p>
          <p className="text-xs text-slate-500">Total pending</p>
        </div>
      </div>

      {/* Class filter */}
      <div className="flex gap-2 flex-wrap mb-5">
        <button
          onClick={() => handleClassFilter('')}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${!classFilter ? 'bg-brand-600 text-white border-brand-600' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}
        >
          All classes
        </button>
        {classes.map(c => (
          <button
            key={c.id}
            onClick={() => handleClassFilter(c.id)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${classFilter === c.id ? 'bg-brand-600 text-white border-brand-600' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}
          >
            {c.name}{c.section ? ` - ${c.section}` : ''}
          </button>
        ))}
      </div>

      {/* Table */}
      {loading || classLoading ? (
        <div className="card p-0 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 flex gap-6">
            {['Student', 'Class', 'Type', 'Amount', 'Status', 'Date', 'Receipt'].map(h => (
              <div key={h} className="h-3 w-16 bg-slate-200 rounded animate-pulse" />
            ))}
          </div>
          {[...Array(5)].map((_, i) => (
            <div key={i} className="px-4 py-4 border-b border-slate-50 flex gap-6 items-center">
              <div className="h-4 w-28 bg-slate-100 rounded animate-pulse" />
              <div className="h-4 w-16 bg-slate-100 rounded animate-pulse" />
              <div className="h-4 w-16 bg-slate-100 rounded animate-pulse" />
              <div className="h-4 w-20 bg-slate-100 rounded animate-pulse" />
              <div className="h-5 w-14 bg-slate-100 rounded-full animate-pulse" />
              <div className="h-4 w-20 bg-slate-100 rounded animate-pulse" />
            </div>
          ))}
        </div>
      ) : fees.length > 0 ? (
        <div className="table-wrapper">
          <table className="table">
            <thead>
              <tr>
                <th>Student</th>
                <th>Class</th>
                <th>Type</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Date</th>
                <th>Receipt</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {fees.map((fee) => {
                const cls = fee.students?.classes
                return (
                  <tr key={fee.id}>
                    <td className="font-medium text-slate-900">{fee.students?.full_name ?? '—'}</td>
                    <td className="text-slate-500 text-xs">
                      {cls ? `${cls.name}${cls.section ? ' - ' + cls.section : ''}` : <span className="text-slate-300">—</span>}
                    </td>
                    <td>
                      <span className="capitalize">{fee.fee_type}</span>
                      {fee.period_month && (
                        <div className="text-[10px] text-slate-400 mt-0.5">
                          {new Date(fee.period_month + 'T00:00:00').toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })}
                        </div>
                      )}
                    </td>
                    <td className="font-semibold">₹{Number(fee.amount).toLocaleString('en-IN')}</td>
                    <td>
                      <span className={fee.status === 'paid' ? 'badge-green' : fee.status === 'overdue' ? 'badge-red' : 'badge-yellow'}>
                        {fee.status}
                      </span>
                    </td>
                    <td className="text-slate-500 text-xs">
                      {fee.paid_date ? new Date(fee.paid_date).toLocaleDateString('en-IN')
                        : fee.due_date ? `Due ${new Date(fee.due_date).toLocaleDateString('en-IN')}` : '—'}
                    </td>
                    <td>
                      <button onClick={() => setSelectedFee(fee)} className="text-xs text-brand-600 hover:underline font-medium">
                        {fee.receipt_number}
                      </button>
                    </td>
                    <td>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setEditingFee(fee)}
                          className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-slate-100 text-slate-500 hover:text-slate-700 transition-colors"
                          title="Edit"
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          onClick={() => { if (confirm('Delete this fee record?')) handleDelete(fee.id) }}
                          disabled={deletingId === fee.id}
                          className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-red-50 text-slate-400 hover:text-red-600 transition-colors disabled:opacity-40"
                          title="Delete"
                        >
                          {deletingId === fee.id
                            ? <span className="w-3 h-3 border-2 border-red-400 border-t-transparent rounded-full animate-spin" />
                            : <Trash2 size={13} />}
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="card flex flex-col items-center justify-center py-16 text-center">
          <div className="w-14 h-14 bg-slate-100 rounded-full flex items-center justify-center mb-4">
            <IndianRupee size={24} className="text-slate-400" />
          </div>
          <h3 className="font-semibold text-slate-900 mb-1">
            {classFilter ? 'No fee records for this class' : 'No fee records yet'}
          </h3>
          <p className="text-sm text-slate-500 mb-4">Record the first payment to get started</p>
          <button onClick={handleModalOpen} className="btn-primary text-sm">+ Record payment</button>
        </div>
      )}

      {/* Add fee modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-5 border-b border-slate-100">
              <h2 className="font-semibold text-slate-900">Record payment</h2>
              <button onClick={() => setShowModal(false)} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100">
                <X size={18} className="text-slate-500" />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="p-5 flex flex-col gap-4">

              {/* Student lookup by ID */}
              <StudentLookup
                students={students}
                selectedStudentId={form.student_id}
                onSelect={(id) => setForm({ ...form, student_id: id })}
                initialUid={prefillUid}
              />

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="label">Amount (₹) *</label>
                  <input name="amount" type="text" inputMode="numeric" className="input" placeholder="2000" value={form.amount} onChange={handleChange} required />
                </div>
                <div>
                  <label className="label">Fee type *</label>
                  <select name="fee_type" className="input" value={form.fee_type} onChange={handleChange}>
                    <option value="tuition">Tuition</option>
                    <option value="exam">Exam</option>
                    <option value="transport">Transport</option>
                    <option value="other">Other</option>
                  </select>
                </div>
              </div>

              {/* Period — which month this fee covers */}
              <div>
                <label className="label">
                  Fee period <span className="text-slate-400 font-normal">(month this payment covers)</span>
                </label>
                <input
                  name="period_month"
                  type="month"
                  className="input"
                  value={form.period_month}
                  onChange={handleChange}
                />
                <p className="text-xs text-slate-400 mt-1">
                  e.g. select June 2026 for June tuition fee
                </p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="label">Status *</label>
                  <select name="status" className="input" value={form.status} onChange={handleChange}>
                    <option value="pending">Pending</option>
                    <option value="paid">Paid</option>
                    <option value="overdue">Overdue</option>
                  </select>
                </div>
                <div>
                  <label className="label">Payment method</label>
                  <select name="payment_method" className="input" value={form.payment_method} onChange={handleChange}>
                    <option value="">Select</option>
                    <option value="cash">Cash</option>
                    <option value="upi">UPI</option>
                    <option value="bank_transfer">Bank transfer</option>
                    <option value="online">Online</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="label">Due date</label>
                  <input name="due_date" type="date" className="input" value={form.due_date} onChange={handleChange} />
                </div>
                <div>
                  <label className="label">Paid date</label>
                  <input name="paid_date" type="date" className="input" value={form.paid_date} onChange={handleChange} />
                </div>
              </div>
              <div>
                <label className="label">Notes</label>
                <textarea name="notes" className="input resize-none" rows={2} placeholder="Optional" value={form.notes} onChange={handleChange} />
              </div>
              {error && <div className="bg-red-50 text-red-600 text-sm px-3 py-2 rounded-lg">{error}</div>}
              <button type="submit" className="btn-primary w-full py-2.5" disabled={saving}>
                {saving
                  ? <span className="flex items-center justify-center gap-2"><span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />Saving...</span>
                  : 'Save record'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Load more fees */}
      {feesHasMore && !loading && !classLoading && (
        <div className="mt-4 flex flex-col items-center gap-2">
          <p className="text-xs text-slate-400">Showing {fees.length} of {feesTotal} records</p>
          <button
            onClick={handleLoadMoreFees}
            disabled={loadingMore}
            className="btn-secondary flex items-center gap-2 text-sm px-6"
          >
            {loadingMore
              ? <><span className="w-3.5 h-3.5 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" />Loading...</>
              : <>Load more records</>}
          </button>
        </div>
      )}

      {selectedFee && <ReceiptModal fee={selectedFee} school={school} onClose={() => setSelectedFee(null)} />}
      {editingFee && <EditFeeModal fee={editingFee} onClose={() => setEditingFee(null)} onSaved={() => { setEditingFee(null); fetchData(classFilter || undefined) }} />}
    </div>
  )
}
