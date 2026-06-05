'use client'

import { useState, useEffect, useRef } from 'react'
import { createClient } from '@/utils/supabase/client'
import { IndianRupee, Plus, X, Printer, Pencil, Trash2 } from 'lucide-react'
import type { Fee } from '@/types'

interface StudentOption { id: string; full_name: string }
interface FeeWithStudent extends Fee { students?: { full_name: string } }
interface SchoolInfo { name: string; phone: string }

function generateReceiptNumber(): string {
  const d = new Date()
  const yr = d.getFullYear().toString().slice(2)
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  return `RCP-${yr}${mo}-${Math.floor(1000 + Math.random() * 9000)}`
}

function ReceiptModal({ fee, school, onClose }: { fee: FeeWithStudent; school: SchoolInfo; onClose: () => void }) {
  const iframeRef = useRef<HTMLIFrameElement>(null)

  const feeDate = fee.paid_date
    ? new Date(fee.paid_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' })
    : fee.due_date
    ? new Date(fee.due_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' })
    : new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' })

  const statusColor = fee.status === 'paid' ? '#166534' : fee.status === 'overdue' ? '#991b1b' : '#854d0e'
  const statusBg = fee.status === 'paid' ? '#dcfce7' : fee.status === 'overdue' ? '#fee2e2' : '#fef9c3'

  const receiptHTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Receipt ${fee.receipt_number}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: Arial, sans-serif; background: #fff; color: #1e293b; padding: 32px; max-width: 480px; margin: 0 auto; }
  .top-bar { background: #2563eb; height: 6px; border-radius: 4px; margin-bottom: 28px; }
  .school { font-size: 20px; font-weight: 700; color: #1e3a8a; letter-spacing: -0.3px; }
  .receipt-label { font-size: 11px; color: #64748b; letter-spacing: 2px; text-transform: uppercase; margin-top: 2px; }
  .rcpnum { font-size: 12px; color: #94a3b8; margin-top: 6px; font-family: monospace; }
  .divider { border: none; border-top: 1px dashed #e2e8f0; margin: 20px 0; }
  .amount-box { background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 10px; padding: 18px 20px; margin: 20px 0; display: flex; justify-content: space-between; align-items: center; }
  .amount-label { font-size: 13px; color: #1d4ed8; font-weight: 600; }
  .amount-value { font-size: 26px; font-weight: 700; color: #1e3a8a; letter-spacing: -0.5px; }
  .row { display: flex; justify-content: space-between; align-items: center; padding: 9px 0; border-bottom: 1px solid #f8fafc; }
  .row:last-of-type { border-bottom: none; }
  .rl { font-size: 12px; color: #64748b; }
  .rv { font-size: 13px; font-weight: 600; color: #1e293b; text-transform: capitalize; }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; background: ${statusBg}; color: ${statusColor}; }
  .sig { display: flex; justify-content: flex-end; margin-top: 32px; padding-top: 16px; border-top: 1px solid #e2e8f0; }
  .sig-inner { text-align: center; }
  .sig-line { border-top: 1.5px solid #334155; width: 140px; padding-top: 6px; font-size: 11px; color: #64748b; }
  .footer { margin-top: 24px; text-align: center; font-size: 10px; color: #94a3b8; }
  @media print {
    body { padding: 20px; }
    .top-bar { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .amount-box { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .badge { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style>
</head>
<body>
  <div class="top-bar"></div>
  <div class="school">${school.name}</div>
  <div class="receipt-label">Fee Receipt</div>
  <div class="rcpnum">${fee.receipt_number}</div>
  <hr class="divider">
  <div class="amount-box">
    <span class="amount-label">Amount Paid</span>
    <span class="amount-value">₹${Number(fee.amount).toLocaleString('en-IN')}</span>
  </div>
  <div class="row"><span class="rl">Student Name</span><span class="rv">${fee.students?.full_name ?? '—'}</span></div>
  <div class="row"><span class="rl">Fee Type</span><span class="rv">${fee.fee_type}</span></div>
  <div class="row"><span class="rl">Status</span><span class="rv"><span class="badge">${fee.status}</span></span></div>
  ${fee.payment_method ? `<div class="row"><span class="rl">Payment Via</span><span class="rv">${fee.payment_method.replace('_', ' ')}</span></div>` : ''}
  <div class="row"><span class="rl">Date</span><span class="rv">${feeDate}</span></div>
  ${fee.notes ? `<div class="row"><span class="rl">Notes</span><span class="rv">${fee.notes}</span></div>` : ''}
  <div class="sig"><div class="sig-inner"><div class="sig-line">Authorized Signature</div></div></div>
  <div class="footer">${school.name} &nbsp;·&nbsp; ${school.phone}<br>This is a computer-generated receipt. No signature required.</div>
</body>
</html>`

  function handlePrint() {
    const iframe = iframeRef.current
    if (!iframe || !iframe.contentWindow) return
    iframe.contentWindow.document.open()
    iframe.contentWindow.document.write(receiptHTML)
    iframe.contentWindow.document.close()
    setTimeout(() => {
      iframe.contentWindow?.focus()
      iframe.contentWindow?.print()
    }, 300)
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '16px' }}>
      <div style={{ background: '#fff', borderRadius: '16px', width: '100%', maxWidth: '420px', boxShadow: '0 20px 60px rgba(0,0,0,0.15)' }}>
        {/* Modal header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid #f1f5f9' }}>
          <span style={{ fontWeight: 600, fontSize: '15px', color: '#1e293b' }}>Fee Receipt</span>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button onClick={handlePrint} className="btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', padding: '6px 14px' }}>
              <Printer size={15} /> Print / Save PDF
            </button>
            <button onClick={onClose} style={{ width: '32px', height: '32px', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '8px', border: 'none', background: 'transparent', cursor: 'pointer' }}>
              <X size={18} color="#64748b" />
            </button>
          </div>
        </div>

        {/* Receipt preview */}
        <div style={{ padding: '20px', background: '#f8fafc', margin: '16px', borderRadius: '12px', border: '1px solid #e2e8f0' }}>
          <div style={{ height: '5px', background: '#2563eb', borderRadius: '3px', marginBottom: '20px' }} />
          <div style={{ fontSize: '17px', fontWeight: 700, color: '#1e3a8a' }}>{school.name}</div>
          <div style={{ fontSize: '10px', color: '#64748b', letterSpacing: '2px', textTransform: 'uppercase', marginTop: '2px' }}>Fee Receipt</div>
          <div style={{ fontSize: '11px', color: '#94a3b8', fontFamily: 'monospace', marginTop: '4px' }}>{fee.receipt_number}</div>

          <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: '10px', padding: '14px 16px', margin: '16px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '12px', color: '#1d4ed8', fontWeight: 600 }}>Amount</span>
            <span style={{ fontSize: '22px', fontWeight: 700, color: '#1e3a8a' }}>₹{Number(fee.amount).toLocaleString('en-IN')}</span>
          </div>

          {[
            ['Student', fee.students?.full_name ?? '—'],
            ['Fee Type', fee.fee_type],
            ['Status', fee.status],
            ...(fee.payment_method ? [['Payment Via', fee.payment_method.replace('_', ' ')]] : []),
            ['Date', feeDate],
            ...(fee.notes ? [['Notes', fee.notes]] : []),
          ].map(([label, value]) => (
            <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid #f1f5f9', fontSize: '13px' }}>
              <span style={{ color: '#64748b' }}>{label}</span>
              <span style={{ fontWeight: 600, color: '#1e293b', textTransform: 'capitalize' }}>
                {label === 'Status'
                  ? <span style={{ background: statusBg, color: statusColor, padding: '2px 8px', borderRadius: '20px', fontSize: '11px', fontWeight: 700 }}>{value}</span>
                  : value}
              </span>
            </div>
          ))}

          <div style={{ textAlign: 'right', marginTop: '20px', paddingTop: '14px', borderTop: '1px solid #e2e8f0' }}>
            <div style={{ display: 'inline-block', textAlign: 'center' }}>
              <div style={{ borderTop: '1.5px solid #334155', width: '130px', paddingTop: '5px', fontSize: '10px', color: '#64748b' }}>Authorized Signature</div>
            </div>
          </div>

          <div style={{ marginTop: '16px', textAlign: 'center', fontSize: '10px', color: '#94a3b8' }}>
            {school.name} · {school.phone}<br />
            Computer-generated receipt
          </div>
        </div>
      </div>

      {/* Hidden iframe for printing — works on Android */}
      <iframe ref={iframeRef} style={{ display: 'none' }} title="print-frame" />
    </div>
  )
}

export default function FeesPage() {
  const [fees, setFees] = useState<FeeWithStudent[]>([])
  const [students, setStudents] = useState<StudentOption[]>([])
  const [school, setSchool] = useState<SchoolInfo>({ name: '', phone: '' })
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [selectedFee, setSelectedFee] = useState<FeeWithStudent | null>(null)
  const [form, setForm] = useState({
    student_id: '', amount: '', fee_type: 'tuition',
    due_date: '', paid_date: '', status: 'pending', payment_method: '', notes: '',
  })

  useEffect(() => { fetchData() }, [])

  async function fetchData() {
    const supabase = createClient()
    const [feesRes, studentsRes, profileRes] = await Promise.all([
      supabase.from('fees').select('*, students(full_name)').order('created_at', { ascending: false }),
      supabase.from('students').select('id, full_name').eq('is_active', true).order('full_name'),
      supabase.from('profiles').select('school_id, schools(name, phone)').single(),
    ])
    setFees((feesRes.data ?? []) as FeeWithStudent[])
    setStudents((studentsRes.data ?? []) as StudentOption[])
    const s = (profileRes.data as any)?.schools
    if (s) setSchool({ name: s.name ?? '', phone: s.phone ?? '' })
    setLoading(false)
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) {
    const { name, value } = e.target
    if (name === 'amount' && value && !/^\d*$/.test(value)) return
    setForm({ ...form, [name]: value })
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.amount || Number(form.amount) <= 0) { setError('Enter a valid amount'); return }
    setSaving(true); setError('')
    const supabase = createClient()
    const { data: profile } = await supabase.from('profiles').select('school_id').single()
    const { error } = await supabase.from('fees').insert({
      ...form,
      school_id: profile?.school_id,
      amount: parseFloat(form.amount),
      receipt_number: generateReceiptNumber(),
      due_date: form.due_date || null,
      paid_date: form.status === 'paid' ? (form.paid_date || new Date().toISOString().split('T')[0]) : null,
      payment_method: form.payment_method || null,
    })
    if (error) { setError(error.message); setSaving(false); return }
    setShowModal(false)
    setForm({ student_id: '', amount: '', fee_type: 'tuition', due_date: '', paid_date: '', status: 'pending', payment_method: '', notes: '' })
    fetchData(); setSaving(false)
  }

  const totalCollected = fees.filter(f => f.status === 'paid').reduce((s, f) => s + Number(f.amount), 0)
  const totalPending = fees.filter(f => f.status === 'pending' || f.status === 'overdue').reduce((s, f) => s + Number(f.amount), 0)

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Fees</h1>
          <p className="text-slate-500 text-sm mt-1">{fees.length} total records</p>
        </div>
        <button onClick={() => setShowModal(true)} className="btn-primary flex items-center gap-2 text-sm">
          <Plus size={16} /> Record payment
        </button>
      </div>

      <div className="grid grid-cols-2 gap-4 mb-6">
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

      {loading ? (
        <div className="card flex items-center justify-center py-16">
          <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : fees.length > 0 ? (
        <div className="table-wrapper">
          <table className="table">
            <thead><tr><th>Student</th><th>Type</th><th>Amount</th><th>Status</th><th>Date</th><th>Receipt</th></tr></thead>
            <tbody>
              {fees.map((fee) => (
                <tr key={fee.id}>
                  <td className="font-medium text-slate-900">{fee.students?.full_name ?? '—'}</td>
                  <td className="capitalize">{fee.fee_type}</td>
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
          <button onClick={() => setShowModal(true)} className="btn-primary text-sm">+ Record payment</button>
        </div>
      )}

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
              <div>
                <label className="label">Student *</label>
                <select name="student_id" className="input" value={form.student_id} onChange={handleChange} required>
                  <option value="">Select student</option>
                  {students.map(s => <option key={s.id} value={s.id}>{s.full_name}</option>)}
                </select>
              </div>
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
                <textarea name="notes" className="input resize-none" rows={2} placeholder="Optional notes" value={form.notes} onChange={handleChange} />
              </div>
              {error && <div className="bg-red-50 text-red-600 text-sm px-3 py-2 rounded-lg">{error}</div>}
              <button type="submit" className="btn-primary w-full py-2.5" disabled={saving}>
                {saving ? <span className="flex items-center justify-center gap-2"><span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />Saving...</span> : 'Save record'}
              </button>
            </form>
          </div>
        </div>
      )}

      {selectedFee && <ReceiptModal fee={selectedFee} school={school} onClose={() => setSelectedFee(null)} />}
    </div>
  )
}
