'use client'

// FILE: app/(dashboard)/dashboard/students/[id]/page.tsx
// Updated: added Print QR Card button using canvas-based QR generation

import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter, useParams } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/utils/supabase/client'
import {
  ArrowLeft, Phone, Mail, MapPin, Calendar, Pencil,
  Trash2, X, Save, Eye, EyeOff, IndianRupee, QrCode, Printer
} from 'lucide-react'

interface StudentData {
  id: string
  full_name: string
  student_uid: string | null
  father_name: string | null
  mother_name: string | null
  date_of_birth: string | null
  gender: string | null
  aadhaar_number: string | null
  address: string | null
  parent_name: string | null
  parent_phone: string | null
  parent_email: string | null
  is_active: boolean
  admission_date: string
  class_id: string | null
  classes?: { id: string; name: string; section: string | null } | null
}

interface FeeRecord {
  id: string
  fee_type: string
  amount: number
  status: string
  paid_date: string | null
  due_date: string | null
  receipt_number: string | null
}

interface ClassOption { id: string; name: string; section: string | null }

function formatAadhaar(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 12)
  return digits.replace(/(\d{4})(?=\d)/g, '$1 ').trim()
}

// ── QR Card Modal ─────────────────────────────────────────────
function QRCardModal({
  student,
  schoolName,
  onClose,
}: {
  student: StudentData
  schoolName: string
  onClose: () => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [qrReady, setQrReady] = useState(false)

  useEffect(() => {
    async function generateQR() {
      const canvas = canvasRef.current
      if (!canvas) return
      try {
        const QRCode = (await import('qrcode')).default
        // Encode the Supabase UUID — unguessable, this is what the scanner reads
        await QRCode.toCanvas(canvas, student.id, {
          width: 200,
          margin: 1,
          color: { dark: '#0f172a', light: '#ffffff' },
        })
        setQrReady(true)
      } catch (err) {
        console.error('QR generation failed:', err)
      }
    }
    generateQR()
  }, [student.id])

  function handlePrint() {
    const canvas = canvasRef.current
    if (!canvas) return
    const qrDataUrl = canvas.toDataURL('image/png')
    const className = student.classes
      ? `${student.classes.name}${student.classes.section ? ' - ' + student.classes.section : ''}`
      : ''

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>ID Card – ${student.full_name}</title>
  <style>
    @page { size: 54mm 85mm; margin: 0; }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Arial', sans-serif; }
    body { width: 54mm; height: 85mm; background: #fff; }
    .card {
      width: 54mm; height: 85mm;
      display: flex; flex-direction: column;
      border: 1.5px solid #1d4ed8; border-radius: 8px; overflow: hidden;
    }
    .header {
      background: #1d4ed8; color: white;
      padding: 6px 8px; text-align: center;
    }
    .school-name { font-size: 8px; font-weight: bold; letter-spacing: 0.3px; }
    .subtitle { font-size: 6px; opacity: 0.85; margin-top: 1px; }
    .body { flex: 1; display: flex; flex-direction: column; align-items: center; padding: 8px 8px 6px; gap: 5px; }
    .avatar {
      width: 36px; height: 36px; border-radius: 50%;
      background: #dbeafe; display: flex; align-items: center; justify-content: center;
      font-size: 16px; font-weight: bold; color: #1d4ed8; flex-shrink: 0;
    }
    .name { font-size: 9px; font-weight: bold; color: #0f172a; text-align: center; line-height: 1.2; }
    .class { font-size: 7px; color: #64748b; text-align: center; }
    .uid {
      font-family: monospace; font-size: 7px; font-weight: bold;
      background: #eff6ff; color: #1d4ed8; border: 1px solid #bfdbfe;
      padding: 2px 6px; border-radius: 4px;
    }
    .qr-box { display: flex; flex-direction: column; align-items: center; gap: 2px; }
    .qr-img { width: 64px; height: 64px; }
    .scan-label { font-size: 5.5px; color: #94a3b8; text-align: center; }
    .footer {
      background: #f8fafc; border-top: 1px solid #e2e8f0;
      padding: 4px 8px; display: flex; justify-content: space-between;
      align-items: center;
    }
    .footer-label { font-size: 5.5px; color: #94a3b8; }
    .footer-value { font-size: 6px; color: #475569; font-weight: 500; }
  </style>
</head>
<body>
<div class="card">
  <div class="header">
    <div class="school-name">${schoolName.toUpperCase()}</div>
    <div class="subtitle">Student Identity Card</div>
  </div>
  <div class="body">
    <div class="avatar">${student.full_name.charAt(0).toUpperCase()}</div>
    <div class="name">${student.full_name}</div>
    ${className ? `<div class="class">${className}</div>` : ''}
    ${student.student_uid ? `<div class="uid">${student.student_uid}</div>` : ''}
    <div class="qr-box">
      <img class="qr-img" src="${qrDataUrl}" alt="QR"/>
      <div class="scan-label">Scan for attendance</div>
    </div>
  </div>
  <div class="footer">
    <div>
      <div class="footer-label">Father</div>
      <div class="footer-value">${student.father_name ?? '—'}</div>
    </div>
    <div style="text-align:right">
      <div class="footer-label">Phone</div>
      <div class="footer-value">${student.parent_phone ?? '—'}</div>
    </div>
  </div>
</div>
</body>
</html>`

    const iframe = document.createElement('iframe')
    iframe.style.display = 'none'
    document.body.appendChild(iframe)
    iframe.contentWindow!.document.open()
    iframe.contentWindow!.document.write(html)
    iframe.contentWindow!.document.close()
    setTimeout(() => {
      iframe.contentWindow!.focus()
      iframe.contentWindow!.print()
      setTimeout(() => document.body.removeChild(iframe), 2000)
    }, 400)
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 px-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-xs p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-slate-800 flex items-center gap-2">
            <QrCode size={18} className="text-brand-600" /> ID Card Preview
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X size={18} />
          </button>
        </div>

        {/* Card preview */}
        <div className="border-2 border-brand-200 rounded-xl overflow-hidden mb-4">
          {/* Card header */}
          <div className="bg-brand-700 text-white text-center py-2 px-3">
            <p className="text-xs font-bold tracking-wide">{schoolName.toUpperCase()}</p>
            <p className="text-[10px] opacity-80">Student Identity Card</p>
          </div>
          {/* Card body */}
          <div className="flex flex-col items-center gap-2 py-4 px-3 bg-white">
            <div className="w-10 h-10 bg-brand-100 rounded-full flex items-center justify-center">
              <span className="text-brand-700 font-bold text-lg">
                {student.full_name.charAt(0).toUpperCase()}
              </span>
            </div>
            <p className="font-semibold text-slate-900 text-sm text-center leading-tight">
              {student.full_name}
            </p>
            {student.classes && (
              <p className="text-xs text-slate-500">
                {student.classes.name}{student.classes.section ? ` - ${student.classes.section}` : ''}
              </p>
            )}
            {student.student_uid && (
              <span className="font-mono text-xs bg-brand-50 text-brand-700 border border-brand-200 px-2 py-0.5 rounded">
                {student.student_uid}
              </span>
            )}
            {/* QR canvas */}
            <div className="flex flex-col items-center gap-1">
              <canvas ref={canvasRef} className="rounded-lg" />
              {!qrReady && (
                <div className="w-[200px] h-[200px] bg-slate-100 rounded-lg flex items-center justify-center">
                  <div className="w-6 h-6 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
                </div>
              )}
              <p className="text-[10px] text-slate-400">Scan for attendance</p>
            </div>
          </div>
          {/* Card footer */}
          <div className="bg-slate-50 border-t border-slate-100 px-3 py-2 flex justify-between">
            <div>
              <p className="text-[10px] text-slate-400">Father</p>
              <p className="text-xs text-slate-600 font-medium">{student.father_name ?? '—'}</p>
            </div>
            <div className="text-right">
              <p className="text-[10px] text-slate-400">Phone</p>
              <p className="text-xs text-slate-600 font-medium">{student.parent_phone ?? '—'}</p>
            </div>
          </div>
        </div>

        <button
          onClick={handlePrint}
          disabled={!qrReady}
          className="btn-primary w-full flex items-center justify-center gap-2 disabled:opacity-50"
        >
          <Printer size={16} />
          {qrReady ? 'Print ID Card' : 'Generating QR…'}
        </button>
        <p className="text-xs text-slate-400 text-center mt-2">
          Card size: 54×85mm (standard ID)
        </p>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────
export default function StudentDetailPage() {
  const params    = useParams()
  const router    = useRouter()
  const studentId = params.id as string

  const [student,           setStudent]           = useState<StudentData | null>(null)
  const [fees,              setFees]              = useState<FeeRecord[]>([])
  const [classes,           setClasses]           = useState<ClassOption[]>([])
  const [loading,           setLoading]           = useState(true)
  const [editing,           setEditing]           = useState(false)
  const [saving,            setSaving]            = useState(false)
  const [deleting,          setDeleting]          = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showAadhaar,       setShowAadhaar]       = useState(false)
  const [showQRModal,       setShowQRModal]       = useState(false)
  const [schoolName,        setSchoolName]        = useState('School')
  const [error,             setError]             = useState('')
  const [form,              setForm]              = useState<Partial<StudentData>>({})

  const fetchData = useCallback(async () => {
    const supabase = createClient()
    const [studentRes, feesRes, classesRes, profileRes] = await Promise.all([
      supabase.from('students').select('*, classes(id, name, section)').eq('id', studentId).single(),
      supabase.from('fees').select('*').eq('student_id', studentId).order('created_at', { ascending: false }),
      supabase.from('classes').select('id, name, section').order('name'),
      supabase.from('profiles').select('school_id, schools(name)').single(),
    ])
    if (studentRes.data) {
      setStudent(studentRes.data as StudentData)
      setForm(studentRes.data as StudentData)
    }
    setFees((feesRes.data ?? []) as FeeRecord[])
    setClasses((classesRes.data ?? []) as ClassOption[])
    if (profileRes.data) {
      setSchoolName((profileRes.data as any).schools?.name ?? 'School')
    }
    setLoading(false)
  }, [studentId])

  useEffect(() => { fetchData() }, [fetchData])

  function handleChange(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) {
    const { name, value } = e.target
    if (name === 'parent_phone') {
      setForm({ ...form, parent_phone: value.replace(/\D/g, '').slice(0, 10) })
      return
    }
    if (name === 'aadhaar_number') {
      setForm({ ...form, aadhaar_number: formatAadhaar(value) })
      return
    }
    setForm({ ...form, [name]: value })
  }

  async function handleSave() {
    if (!form.full_name?.trim()) { setError('Name is required'); return }
    setSaving(true); setError('')
    const supabase = createClient()
    const aadhaarDigits = (form.aadhaar_number ?? '').replace(/\s/g, '') || null
    const { error } = await supabase.from('students').update({
      full_name:    form.full_name,
      father_name:  form.father_name  || null,
      mother_name:  form.mother_name  || null,
      date_of_birth: form.date_of_birth || null,
      gender:       form.gender       || null,
      class_id:     form.class_id     || null,
      aadhaar_number: aadhaarDigits,
      address:      form.address      || null,
      parent_phone: form.parent_phone || null,
      parent_email: form.parent_email || null,
    }).eq('id', studentId)
    if (error) { setError(error.message); setSaving(false); return }
    await fetchData()
    setEditing(false)
    setSaving(false)
  }

  async function handleDelete() {
    setDeleting(true)
    const supabase = createClient()
    await supabase.from('students').update({ is_active: false }).eq('id', studentId)
    router.push('/dashboard/students')
    router.refresh()
  }

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-8 h-8 bg-slate-200 rounded-lg animate-pulse" />
          <div className="h-7 w-40 bg-slate-200 rounded animate-pulse" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          <div className="card h-64 animate-pulse bg-slate-50" />
          <div className="md:col-span-2 flex flex-col gap-5">
            <div className="grid grid-cols-2 gap-4">
              <div className="stat-card h-24 animate-pulse bg-slate-50" />
              <div className="stat-card h-24 animate-pulse bg-slate-50" />
            </div>
            <div className="card h-48 animate-pulse bg-slate-50" />
          </div>
        </div>
      </div>
    )
  }

  if (!student) return <div className="text-center py-16 text-slate-500">Student not found.</div>

  const totalPaid    = fees.filter(f => f.status === 'paid').reduce((s, f) => s + Number(f.amount), 0)
  const totalPending = fees.filter(f => f.status === 'pending' || f.status === 'overdue').reduce((s, f) => s + Number(f.amount), 0)

  const aadhaarDisplay = form.aadhaar_number
    ? (showAadhaar ? form.aadhaar_number : (() => {
        const d = form.aadhaar_number!.replace(/\s/g, '')
        return d.length > 4 ? 'XXXX XXXX ' + d.slice(8, 12) : form.aadhaar_number
      })())
    : ''

  return (
    <div className="max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Link href="/dashboard/students" className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 transition-colors">
            <ArrowLeft size={18} className="text-slate-600" />
          </Link>
          <h1 className="text-2xl font-bold text-slate-900">Student profile</h1>
        </div>
        <div className="flex gap-2 flex-wrap justify-end">
          {/* Print QR button — always visible */}
          {!editing && (
            <button
              onClick={() => setShowQRModal(true)}
              className="btn-secondary flex items-center gap-2 text-sm py-1.5 px-3"
            >
              <QrCode size={15} /> Print QR
            </button>
          )}
          {editing ? (
            <>
              <button onClick={() => { setEditing(false); setForm(student); setError('') }}
                className="btn-secondary flex items-center gap-2 text-sm py-1.5 px-3">
                <X size={15} /> Cancel
              </button>
              <button onClick={handleSave} disabled={saving}
                className="btn-primary flex items-center gap-2 text-sm py-1.5 px-3">
                {saving
                  ? <span className="flex items-center gap-1"><span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" /> Saving</span>
                  : <><Save size={15} /> Save</>}
              </button>
            </>
          ) : (
            <>
              <button onClick={() => setEditing(true)}
                className="btn-secondary flex items-center gap-2 text-sm py-1.5 px-3">
                <Pencil size={15} /> Edit
              </button>
              <button onClick={() => setShowDeleteConfirm(true)}
                className="flex items-center gap-2 text-sm py-1.5 px-3 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 transition-colors">
                <Trash2 size={15} /> Delete
              </button>
            </>
          )}
        </div>
      </div>

      {error && <div className="bg-red-50 text-red-600 text-sm px-4 py-3 rounded-lg mb-4">{error}</div>}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        {/* Left — profile card */}
        <div className="md:col-span-1">
          <div className="card flex flex-col items-center text-center">
            <div className="w-16 h-16 bg-brand-100 rounded-full flex items-center justify-center mb-3">
              <span className="text-brand-700 font-bold text-2xl">{student.full_name.charAt(0).toUpperCase()}</span>
            </div>

            {editing ? (
              <input name="full_name" type="text" className="input text-center font-semibold mb-1"
                value={form.full_name ?? ''} onChange={handleChange} />
            ) : (
              <h2 className="font-semibold text-slate-900 text-lg">{student.full_name}</h2>
            )}

            {student.student_uid && (
              <span className="font-mono text-xs bg-brand-50 text-brand-700 border border-brand-200 px-2 py-0.5 rounded mt-1 mb-1">
                {student.student_uid}
              </span>
            )}

            {editing ? (
              <select name="class_id" className="input text-sm mt-1 mb-2" value={form.class_id ?? ''} onChange={handleChange}>
                <option value="">No class</option>
                {classes.map(c => <option key={c.id} value={c.id}>{c.name}{c.section ? ` - ${c.section}` : ''}</option>)}
              </select>
            ) : (
              <p className="text-sm text-slate-500 mb-2">
                {student.classes ? `${student.classes.name}${student.classes.section ? ' - ' + student.classes.section : ''}` : 'No class assigned'}
              </p>
            )}

            <span className={student.is_active ? 'badge-green' : 'badge-red'}>
              {student.is_active ? 'Active' : 'Inactive'}
            </span>

            <div className="w-full border-t border-slate-100 mt-4 pt-4 flex flex-col gap-3 text-sm text-left">
              <div>
                <p className="text-xs text-slate-400 mb-1">Father's name</p>
                {editing
                  ? <input name="father_name" type="text" className="input text-sm" placeholder="Father's name" value={form.father_name ?? ''} onChange={handleChange} />
                  : <p className="text-slate-700">{student.father_name ?? <span className="text-slate-400">—</span>}</p>}
              </div>
              <div>
                <p className="text-xs text-slate-400 mb-1">Mother's name</p>
                {editing
                  ? <input name="mother_name" type="text" className="input text-sm" placeholder="Mother's name" value={form.mother_name ?? ''} onChange={handleChange} />
                  : <p className="text-slate-700">{student.mother_name ?? <span className="text-slate-400">—</span>}</p>}
              </div>
              <div className="flex items-center gap-2 text-slate-600">
                <Phone size={14} className="text-slate-400 shrink-0" />
                {editing
                  ? <input name="parent_phone" type="tel" inputMode="numeric" className="input text-sm" placeholder="Phone" value={form.parent_phone ?? ''} onChange={handleChange} maxLength={10} />
                  : <span>{student.parent_phone ?? <span className="text-slate-400">—</span>}</span>}
              </div>
              <div className="flex items-center gap-2 text-slate-600">
                <Mail size={14} className="text-slate-400 shrink-0" />
                {editing
                  ? <input name="parent_email" type="email" className="input text-sm" placeholder="Email" value={form.parent_email ?? ''} onChange={handleChange} />
                  : <span className="break-all">{student.parent_email ?? <span className="text-slate-400">—</span>}</span>}
              </div>
              <div className="flex items-start gap-2 text-slate-600">
                <MapPin size={14} className="text-slate-400 mt-0.5 shrink-0" />
                {editing
                  ? <textarea name="address" className="input text-sm resize-none" rows={2} placeholder="Address" value={form.address ?? ''} onChange={handleChange} />
                  : <span>{student.address ?? <span className="text-slate-400">—</span>}</span>}
              </div>
              <div className="flex items-center gap-2 text-slate-600">
                <Calendar size={14} className="text-slate-400 shrink-0" />
                {editing
                  ? <input name="date_of_birth" type="date" className="input text-sm" value={form.date_of_birth ?? ''} onChange={handleChange} />
                  : <span>{student.date_of_birth ? new Date(student.date_of_birth).toLocaleDateString('en-IN') : <span className="text-slate-400">—</span>}</span>}
              </div>
              <div>
                <p className="text-xs text-slate-400 mb-1">Aadhaar</p>
                {editing ? (
                  <div className="relative">
                    <input name="aadhaar_number" type="text" inputMode="numeric"
                      className="input text-sm pr-8"
                      value={showAadhaar ? (form.aadhaar_number ?? '') : aadhaarDisplay}
                      onChange={handleChange}
                      onFocus={() => setShowAadhaar(true)}
                      onBlur={() => setShowAadhaar(false)}
                      maxLength={14} placeholder="XXXX XXXX XXXX"
                    />
                    <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400"
                      onClick={() => setShowAadhaar(!showAadhaar)}>
                      {showAadhaar ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                ) : (
                  <p className="text-slate-700 font-mono text-xs">
                    {student.aadhaar_number
                      ? 'XXXX XXXX ' + student.aadhaar_number.slice(-4)
                      : <span className="text-slate-400">—</span>}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2 text-slate-600">
                <Calendar size={14} className="text-slate-400 shrink-0" />
                <span className="text-xs">Admitted {new Date(student.admission_date).toLocaleDateString('en-IN')}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Right — fees */}
        <div className="md:col-span-2 flex flex-col gap-5">
          <div className="grid grid-cols-2 gap-4">
            <div className="stat-card">
              <div className="w-8 h-8 bg-green-50 rounded-lg flex items-center justify-center mb-2">
                <IndianRupee size={16} className="text-green-600" />
              </div>
              <p className="text-xs text-slate-500">Total paid</p>
              <p className="text-xl font-bold text-green-600">₹{totalPaid.toLocaleString('en-IN')}</p>
            </div>
            <div className="stat-card">
              <div className="w-8 h-8 bg-yellow-50 rounded-lg flex items-center justify-center mb-2">
                <IndianRupee size={16} className="text-yellow-600" />
              </div>
              <p className="text-xs text-slate-500">Pending</p>
              <p className="text-xl font-bold text-yellow-600">₹{totalPending.toLocaleString('en-IN')}</p>
            </div>
          </div>

          <div className="card">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-slate-800">Fee history</h3>
              <Link
                href={`/dashboard/fees${student.student_uid ? `?student_uid=${student.student_uid}` : ''}`}
                className="btn-primary flex items-center gap-1.5 text-xs py-1.5 px-3"
              >
                <IndianRupee size={13} /> Record payment
              </Link>
            </div>
            {fees.length > 0 ? (
              <div className="flex flex-col gap-2">
                {fees.map((fee) => (
                  <div key={fee.id} className="flex items-center justify-between py-2 border-b border-slate-50 last:border-0">
                    <div>
                      <p className="text-sm font-medium text-slate-800 capitalize">{fee.fee_type}</p>
                      <p className="text-xs text-slate-400">
                        {fee.paid_date
                          ? `Paid ${new Date(fee.paid_date).toLocaleDateString('en-IN')}`
                          : fee.due_date ? `Due ${new Date(fee.due_date).toLocaleDateString('en-IN')}` : 'No date'}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="font-semibold text-slate-900">₹{Number(fee.amount).toLocaleString('en-IN')}</span>
                      <span className={fee.status === 'paid' ? 'badge-green' : fee.status === 'overdue' ? 'badge-red' : 'badge-yellow'}>
                        {fee.status}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-slate-400 text-center py-4">No fee records yet</p>
            )}
          </div>
        </div>
      </div>

      {/* QR Card Modal */}
      {showQRModal && student && (
        <QRCardModal
          student={student}
          schoolName={schoolName}
          onClose={() => setShowQRModal(false)}
        />
      )}

      {/* Delete confirmation modal */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
            <div className="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <Trash2 size={20} className="text-red-600" />
            </div>
            <h3 className="text-lg font-semibold text-slate-900 text-center mb-2">Delete student?</h3>
            <p className="text-sm text-slate-500 text-center mb-6">
              <strong>{student.full_name}</strong> will be marked inactive. Their fee records will be preserved.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setShowDeleteConfirm(false)} className="btn-secondary flex-1">Cancel</button>
              <button onClick={handleDelete} disabled={deleting}
                className="flex-1 py-2 px-4 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-50 transition-colors">
                {deleting ? 'Deleting...' : 'Yes, delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
