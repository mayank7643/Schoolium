'use client'

import { useState, useEffect, useRef } from 'react'
import { createClient } from '@/utils/supabase/client'
import { IndianRupee, Plus, X, Printer } from 'lucide-react'
import type { Fee } from '@/types'

interface StudentOption {
  id: string
  full_name: string
}

interface FeeWithStudent extends Fee {
  students?: { full_name: string }
}

interface SchoolInfo {
  name: string
  email: string
  phone: string
}

function generateReceiptNumber(): string {
  const date = new Date()
  const year = date.getFullYear().toString().slice(2)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const random = Math.floor(1000 + Math.random() * 9000)
  return `RCP-${year}${month}-${random}`
}

function ReceiptModal({
  fee,
  school,
  onClose,
}: {
  fee: FeeWithStudent
  school: SchoolInfo
  onClose: () => void
}) {
  const printRef = useRef<HTMLDivElement>(null)

  function handlePrint() {
    const content = printRef.current?.innerHTML
    if (!content) return
    const win = window.open('', '_blank', 'width=600,height=800')
    if (!win) return
    win.document.write(`
      <html>
        <head>
          <title>Fee Receipt - ${fee.receipt_number}</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 32px; color: #1e293b; }
            .header { text-align: center; border-bottom: 2px solid #2563eb; padding-bottom: 16px; margin-bottom: 24px; }
            .school-name { font-size: 22px; font-weight: bold; color: #2563eb; }
            .receipt-title { font-size: 14px; color: #64748b; margin-top: 4px; letter-spacing: 2px; text-transform: uppercase; }
            .receipt-number { font-size: 13px; color: #94a3b8; margin-top: 8px; }
            .row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #f1f5f9; }
            .label { color: #64748b; font-size: 13px; }
            .value { font-weight: 600; font-size: 13px; color: #1e293b; }
            .amount-row { background: #f0f4ff; padding: 16px; border-radius: 8px; margin: 20px 0; display: flex; justify-content: space-between; }
            .amount-label { font-size: 15px; font-weight: bold; color: #2563eb; }
            .amount-value { font-size: 20px; font-weight: bold; color: #1e293b; }
            .status-badge { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; }
            .paid { background: #dcfce7; color: #166534; }
            .pending { background: #fef9c3; color: #854d0e; }
            .overdue { background: #fee2e2; color: #991b1b; }
            .footer { margin-top: 40px; text-align: center; font-size: 11px; color: #94a3b8; border-top: 1px solid #e2e8f0; padding-top: 16px; }
            .signature-area { display: flex; justify-content: flex-end; margin-top: 40px; }
            .signature-box { text-align: center; }
            .signature-line { border-top: 1px solid #334155; width: 160px; padding-top: 8px; font-size: 12px; color: #64748b; }
          </style>
        </head>
        <body>${content}</body>
      </html>
    `)
    win.document.close()
    win.focus()
    win.print()
    win.close()
  }

  const feeDate = fee.paid_date
    ? new Date(fee.paid_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' })
    : fee.due_date
    ? new Date(fee.due_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' })
    : new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' })

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 px-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between p-4 border-b border-slate-100">
          <h2 className="font-semibold text-slate-900">Fee Receipt</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={handlePrint}
              className="btn-primary flex items-center gap-2 text-sm py-1.5 px-3"
            >
              <Printer size={15} /> Print
            </button>
            <button
              onClick={onClose}
              className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100"
            >
              <X size={18} className="text-slate-500" />
            </button>
          </div>
        </div>

        <div className="p-6">
          <div ref={printRef}>
            <div className="header">
              <div className="school-name">{school.name}</div>
              <div className="receipt-title">Fee Receipt</div>
              <div className="receipt-number">{fee.receipt_number}</div>
            </div>

            <div className="amount-row">
              <span className="amount-label">Amount</span>
              <span className="amount-value">₹{Number(fee.amount).toLocaleString('en-IN')}</span>
            </div>

            <div className="row">
              <span className="label">Student</span>
              <span className="value">{fee.students?.full_name ?? '—'}</span>
            </div>
            <div className="row">
              <span className="label">Fee type</span>
              <span className="value" style={{ textTransform: 'capitalize' }}>{fee.fee_type}</span>
            </div>
            <div className="row">
              <span className="label">Status</span>
              <span className={`status-badge ${fee.status}`}>{fee.status}</span>
            </div>
            {fee.payment_method && (
              <div className="row">
                <span className="label">Payment via</span>
                <span className="value" style={{ textTransform: 'capitalize' }}>{fee.payment_method.replace('_', ' ')}</span>
              </div>
            )}
            <div className="row">
              <span className="label">Date</span>
              <span className="value">{feeDate}</span>
            </div>
            {fee.notes && (
              <div className="row">
                <span className="label">Notes</span>
                <span className="value">{fee.notes}</span>
              </div>
            )}

            <div className="signature-area">
              <div className="signature-box">
                <div className="signature-line">Authorized Signature</div>
              </div>
            </div>

            <div className="footer">
              {school.name} · {school.phone} · {school.email}<br />
              This is a computer-generated receipt.
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function FeesPage() {
  const [fees, setFees] = useState<FeeWithStudent[]>([])
  const [students, setStudents] = useState<StudentOption[]>([])
  const [school, setSchool] = useState<SchoolInfo>({ name: '', email: '', phone: '' })
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [selectedFee, setSelectedFee] = useState<FeeWithStudent | null>(null)
  const [form, setForm] = useState({
    student_id: '',
    amount: '',
    fee_type: 'tuition',
    due_date: '',
    paid_date: '',
    status: 'pending',
    payment_method: '',
    notes: '',
  })

  useEffect(() => {
    fetchData()
  }, [])

  async function fetchData() {
    const supabase = createClient()
    const [feesRes, studentsRes, profileRes] = await Promise.all([
      supabase
        .from('fees')
        .select('*, students(full_name)')
        .order('created_at', { ascending: false }),
      supabase
        .from('students')
        .select('id, full_name')
        .eq('is_active', true)
        .order('full_name'),
      supabase
        .from('profiles')
        .select('school_id, schools(name, email, phone)')
        .single(),
    ])
    setFees((feesRes.data ?? []) as FeeWithStudent[])
    setStudents((studentsRes.data ?? []) as StudentOption[])
    const schoolData = (profileRes.data as any)?.schools
    if (schoolData) {
      setSchool({
        name: schoolData.name ?? '',
        email: schoolData.email ?? '',
        phone: schoolData.phone ?? '',
      })
    }
    setLoading(false)
  }

  function handleChange(
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>
  ) {
    const { name, value } = e.target
    // Amount: only positive numbers
    if (name === 'amount') {
      if (value && !/^\d+$/.test(value)) return
    }
    setForm({ ...form, [name]: value })
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.amount || Number(form.amount) <= 0) {
      setError('Enter a valid amount')
      return
    }
    setSaving(true)
    setError('')

    const supabase = createClient()
    const { data: profile } = await supabase
      .from('profiles')
      .select('school_id')
      .single()

    const receipt_number = generateReceiptNumber()

    const { error } = await supabase.from('fees').insert({
      ...form,
      school_id: profile?.school_id,
      amount: parseFloat(form.amount),
      receipt_number,
      due_date: form.due_date || null,
      paid_date: form.status === 'paid'
        ? (form.paid_date || new Date().toISOString().split('T')[0])
        : null,
      payment_method: form.payment_method || null,
    })

    if (error) {
      setError(error.message)
      setSaving(false)
      return
    }

    setShowModal(false)
    setForm({
      student_id: '',
      amount: '',
      fee_type: 'tuition',
      due_date: '',
      paid_date: '',
      status: 'pending',
      payment_method: '',
      notes: '',
    })
    fetchData()
    setSaving(false)
  }

  const totalCollected = fees
    .filter((f) => f.status === 'paid')
    .reduce((sum, f) => sum + Number(f.amount), 0)

  const totalPending = fees
    .filter((f) => f.status === 'pending' || f.status === 'overdue')
    .reduce((sum, f) => sum + Number(f.amount), 0)

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Fees</h1>
          <p className="text-slate-500 text-sm mt-1">{fees.length} total records</p>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="btn-primary flex items-center gap-2 text-sm"
        >
          <Plus size={16} />
          Record payment
        </button>
      </div>

      <div className="grid grid-cols-2 gap-4 mb-6">
        <div className="stat-card">
          <div className="w-9 h-9 bg-green-50 rounded-lg flex items-center justify-center mb-3">
            <IndianRupee size={18} className="text-green-600" />
          </div>
          <p className="text-2xl font-bold text-slate-900">
            ₹{totalCollected.toLocaleString('en-IN')}
          </p>
          <p className="text-xs text-slate-500">Total collected</p>
        </div>
        <div className="stat-card">
          <div className="w-9 h-9 bg-yellow-50 rounded-lg flex items-center justify-center mb-3">
            <IndianRupee size={18} className="text-yellow-600" />
          </div>
          <p className="text-2xl font-bold text-slate-900">
            ₹{totalPending.toLocaleString('en-IN')}
          </p>
          <p className="text-xs text-slate-500">Total pending</p>
        </div>
      </div>

      {loading ? (
        <div className="card flex items-center justify-center py-16">
          <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : fees.length > 0 ? (
        <div className="table-wrapper">
          <table className="table">
            <thead>
              <tr>
                <th>Student</th>
                <th>Type</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Date</th>
                <th>Receipt</th>
              </tr>
            </thead>
            <tbody>
              {fees.map((fee) => (
                <tr key={fee.id}>
                  <td className="font-medium text-slate-900">
                    {fee.students?.full_name ?? '—'}
                  </td>
                  <td className="capitalize">{fee.fee_type}</td>
                  <td className="font-semibold">₹{Number(fee.amount).toLocaleString('en-IN')}</td>
                  <td>
                    <span className={
                      fee.status === 'paid' ? 'badge-green' :
                      fee.status === 'overdue' ? 'badge-red' : 'badge-yellow'
                    }>
                      {fee.status}
                    </span>
                  </td>
                  <td className="text-slate-500 text-xs">
                    {fee.paid_date
                      ? new Date(fee.paid_date).toLocaleDateString('en-IN')
                      : fee.due_date
                      ? `Due ${new Date(fee.due_date).toLocaleDateString('en-IN')}`
                      : '—'}
                  </td>
                  <td>
                    <button
                      onClick={() => setSelectedFee(fee)}
                      className="text-xs text-brand-600 hover:underline font-medium"
                    >
                      {fee.receipt_number}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="card flex flex-col items-center justify-center py-16 text-center">
          <div className="w-14 h-14 bg-slate-100 rounded-full flex items-center justify-center mb-4">
            <IndianRupee size={24} className="text-slate-400" />
          </div>
          <h3 className="font-semibold text-slate-900 mb-1">No fee records yet</h3>
          <p className="text-sm text-slate-500 mb-4">Record your first payment to get started</p>
          <button onClick={() => setShowModal(true)} className="btn-primary text-sm">
            + Record payment
          </button>
        </div>
      )}

      {/* Record payment modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-5 border-b border-slate-100">
              <h2 className="font-semibold text-slate-900">Record payment</h2>
              <button
                onClick={() => setShowModal(false)}
                className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100"
              >
                <X size={18} className="text-slate-500" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="p-5 flex flex-col gap-4">
              <div>
                <label className="label">Student *</label>
                <select
                  name="student_id"
                  className="input"
                  value={form.student_id}
                  onChange={handleChange}
                  required
                >
                  <option value="">Select student</option>
                  {students.map((s) => (
                    <option key={s.id} value={s.id}>{s.full_name}</option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="label">Amount (₹) *</label>
                  <input
                    name="amount"
                    type="text"
                    inputMode="numeric"
                    className="input"
                    placeholder="2000"
                    value={form.amount}
                    onChange={handleChange}
                    required
                  />
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
                  <input
                    name="due_date"
                    type="date"
                    className="input"
                    value={form.due_date}
                    onChange={handleChange}
                  />
                </div>
                <div>
                  <label className="label">Paid date</label>
                  <input
                    name="paid_date"
                    type="date"
                    className="input"
                    value={form.paid_date}
                    onChange={handleChange}
                  />
                </div>
              </div>

              <div>
                <label className="label">Notes</label>
                <textarea
                  name="notes"
                  className="input resize-none"
                  rows={2}
                  placeholder="Optional notes"
                  value={form.notes}
                  onChange={handleChange}
                />
              </div>

              {error && (
                <div className="bg-red-50 text-red-600 text-sm px-3 py-2 rounded-lg">{error}</div>
              )}

              <button type="submit" className="btn-primary w-full py-2.5" disabled={saving}>
                {saving ? 'Saving...' : 'Save record'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Receipt modal */}
      {selectedFee && (
        <ReceiptModal
          fee={selectedFee}
          school={school}
          onClose={() => setSelectedFee(null)}
        />
      )}
    </div>
  )
}
