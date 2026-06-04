'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/utils/supabase/client'
import { IndianRupee, Plus, X } from 'lucide-react'
import type { Fee, Student } from '@/types'

export default function FeesPage() {
  const [fees, setFees] = useState<Fee[]>([])
  const [students, setStudents] = useState<Student[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
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
    const [feesRes, studentsRes] = await Promise.all([
      supabase
        .from('fees')
        .select('*, students(full_name)')
        .order('created_at', { ascending: false }),
      supabase
        .from('students')
        .select('id, full_name')
        .eq('is_active', true)
        .order('full_name'),
    ])
    setFees(feesRes.data ?? [])
    setStudents(studentsRes.data ?? [])
    setLoading(false)
  }

  function handleChange(
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>
  ) {
    setForm({ ...form, [e.target.name]: e.target.value })
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError('')

    const supabase = createClient()
    const { data: profile } = await supabase
      .from('profiles')
      .select('school_id')
      .single()

    // Generate receipt number
    const receipt_number = `RCP-${Date.now()}`

    const { error } = await supabase.from('fees').insert({
      ...form,
      school_id: profile?.school_id,
      amount: parseFloat(form.amount),
      receipt_number,
      due_date: form.due_date || null,
      paid_date: form.status === 'paid' ? (form.paid_date || new Date().toISOString().split('T')[0]) : null,
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
      {/* Header */}
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

      {/* Stats */}
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

      {/* Fees table */}
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
                    {(fee as any).students?.full_name ?? '—'}
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
                  <td className="text-xs text-slate-400">{fee.receipt_number}</td>
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

      {/* Add Fee Modal */}
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
                    type="number"
                    className="input"
                    placeholder="2000"
                    value={form.amount}
                    onChange={handleChange}
                    required
                    min="1"
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
    </div>
  )
}
