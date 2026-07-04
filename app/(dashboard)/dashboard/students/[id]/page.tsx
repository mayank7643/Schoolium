'use client'

// FILE: app/(dashboard)/dashboard/students/[id]/page.tsx
// Updated: added Print QR Card button using canvas-based QR generation

import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter, useParams } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/utils/supabase/client'
import {
  ArrowLeft, Phone, Mail, MapPin, Calendar, Pencil,
  Trash2, X, Save, Eye, EyeOff, IndianRupee, QrCode, Printer,
  CalendarCheck, LogIn, LogOut as LogOutIcon, TrendingUp,
  Package, CheckCircle2, AlertCircle, ChevronDown
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
  fee_structure_id: string | null
  classes?: { id: string; name: string; section: string | null } | null
}

interface FeeRecord {
  id: string
  label: string
  total_due: number
  amount_paid: number
  balance: number
  status: string          // unpaid | partial | paid | waived
  due_date: string | null
}

interface AttendanceRecord {
  id: string
  scan_date: string
  scan_time: string
  entry_type: 'entry' | 'exit'
  gate: string
}

interface ClassOption { id: string; name: string; section: string | null }

interface FeeStructureOption {
  id: string
  name: string
  academic_year: string
  is_active: boolean
}

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
  const [feeStructures,     setFeeStructures]     = useState<FeeStructureOption[]>([])
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

  // Fee Package state
  const [selectedStructureId, setSelectedStructureId] = useState<string>('')
  const [pkgSaving,           setPkgSaving]           = useState(false)
  const [pkgSuccess,          setPkgSuccess]          = useState('')
  const [pkgError,            setPkgError]            = useState('')
  const [showGenPrompt,       setShowGenPrompt]       = useState(false)
  const [genLoading,          setGenLoading]          = useState(false)
  const [genResult,           setGenResult]           = useState<{ generated: number; skipped: number } | null>(null)

  // Attendance history
  const [attendance,        setAttendance]        = useState<AttendanceRecord[]>([])
  const [attendanceMonth,   setAttendanceMonth]   = useState(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  })

  const fetchData = useCallback(async () => {
    const supabase = createClient()
    const [studentRes, feesRes, classesRes, profileRes, attendanceRes, structuresRes] = await Promise.all([
      supabase.from('students').select('*, classes(id, name, section)').eq('id', studentId).single(),
      supabase.from('fee_dues').select('id, label, total_due, amount_paid, balance, status, due_date').eq('student_id', studentId).order('due_date', { ascending: false }),
      supabase.from('classes').select('id, name, section').order('name'),
      supabase.from('profiles').select('school_id, schools(name)').single(),
      // Last 90 days of attendance — enough for monthly view + history
      supabase.from('attendance')
        .select('id, scan_date, scan_time, entry_type, gate')
        .eq('student_id', studentId)
        .order('scan_date', { ascending: false })
        .order('entry_type',  { ascending: true })
        .limit(200),
      supabase.from('fee_structures')
        .select('id, name, academic_year, is_active')
        .eq('is_active', true)
        .order('name'),
    ])
    if (studentRes.data) {
      const s = studentRes.data as StudentData
      setStudent(s)
      setForm(s)
      setSelectedStructureId(s.fee_structure_id ?? '')
    }
    setFees((feesRes.data ?? []) as FeeRecord[])
    setClasses((classesRes.data ?? []) as ClassOption[])
    setFeeStructures((structuresRes.data ?? []) as FeeStructureOption[])
    if (profileRes.data) {
      const p = profileRes.data as any
      setSchoolName(
        Array.isArray(p.schools) ? p.schools[0]?.name ?? 'School' : p.schools?.name ?? 'School'
      )
    }
    setAttendance((attendanceRes.data ?? []) as AttendanceRecord[])
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

  async function handleAssignPackage() {
    if (!student) return
    setPkgSaving(true); setPkgError(''); setPkgSuccess(''); setGenResult(null)
    const supabase = createClient()
    const structureId = selectedStructureId || null
    const { error: rpcError } = await supabase.rpc('assign_student_fee_structure', {
      p_student_id: studentId,
      p_fee_structure_id: structureId,
    })
    if (rpcError) {
      setPkgError(rpcError.message)
      setPkgSaving(false)
      return
    }
    // Update local student state
    setStudent(prev => prev ? { ...prev, fee_structure_id: structureId } : prev)
    setPkgSuccess(structureId ? 'Fee package assigned.' : 'Package removed.')
    setPkgSaving(false)
    // Only prompt to generate dues when assigning (not unassigning)
    if (structureId) {
      setShowGenPrompt(true)
    }
    setTimeout(() => setPkgSuccess(''), 3000)
  }

  async function handleGenerateDues() {
    if (!student?.fee_structure_id && !selectedStructureId) return
    setGenLoading(true); setPkgError('')
    const supabase = createClient()
    const { data, error: rpcError } = await supabase.rpc('generate_fee_dues_capped', {
      p_fee_structure_id: student?.fee_structure_id ?? selectedStructureId,
      p_school_id: null, // RPC resolves school_id from admin profile
    })
    setGenLoading(false)
    setShowGenPrompt(false)
    if (rpcError) {
      setPkgError(rpcError.message)
      return
    }
    const result = data as any
    setGenResult({
      generated: result?.generated_count ?? 0,
      skipped:   result?.skipped_count ?? 0,
    })
    setTimeout(() => setGenResult(null), 5000)
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

  const totalPaid    = fees.reduce((s, f) => s + Number(f.amount_paid || 0), 0)
  const totalPending = fees.filter(f => f.status === 'unpaid' || f.status === 'partial').reduce((s, f) => s + Number(f.balance || 0), 0)

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

          {/* ── Fee Package card ─────────────────────────────── */}
          <div className="card">
            <div className="flex items-center gap-2 mb-4">
              <Package size={17} className="text-brand-600" />
              <h3 className="font-semibold text-slate-800">Fee Package</h3>
              {student.fee_structure_id ? (
                <span className="badge-green ml-auto">Assigned</span>
              ) : (
                <span className="badge-yellow ml-auto">Not assigned</span>
              )}
            </div>

            {/* Current assignment display */}
            {student.fee_structure_id && (
              <div className="bg-brand-50 border border-brand-100 rounded-lg px-3 py-2 mb-3 flex items-center gap-2">
                <CheckCircle2 size={14} className="text-brand-600 shrink-0" />
                <span className="text-sm text-brand-800 font-medium">
                  {feeStructures.find(s => s.id === student.fee_structure_id)?.name ?? 'Loading…'}
                </span>
              </div>
            )}

            {/* Dropdown + Save button */}
            <div className="flex gap-2 items-end">
              <div className="flex-1">
                <label className="label">Select fee structure</label>
                <select
                  className="input text-sm"
                  value={selectedStructureId}
                  onChange={e => { setSelectedStructureId(e.target.value); setPkgError(''); setPkgSuccess('') }}
                >
                  <option value="">— No package —</option>
                  {feeStructures.map(fs => (
                    <option key={fs.id} value={fs.id}>
                      {fs.name} ({fs.academic_year})
                    </option>
                  ))}
                </select>
              </div>
              <button
                onClick={handleAssignPackage}
                disabled={pkgSaving || selectedStructureId === (student.fee_structure_id ?? '')}
                className="btn-primary text-sm py-2 px-4 shrink-0"
              >
                {pkgSaving ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Saving
                  </span>
                ) : 'Save'}
              </button>
            </div>

            {/* Unassign link — only when a package is currently assigned */}
            {student.fee_structure_id && selectedStructureId === student.fee_structure_id && (
              <button
                onClick={() => setSelectedStructureId('')}
                className="mt-2 text-xs text-red-500 hover:text-red-700 transition-colors"
              >
                Remove package assignment
              </button>
            )}

            {/* Feedback */}
            {pkgError && (
              <div className="flex items-center gap-2 mt-3 text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg">
                <AlertCircle size={13} className="shrink-0" /> {pkgError}
              </div>
            )}
            {pkgSuccess && (
              <div className="flex items-center gap-2 mt-3 text-xs text-green-700 bg-green-50 px-3 py-2 rounded-lg">
                <CheckCircle2 size={13} className="shrink-0" /> {pkgSuccess}
              </div>
            )}

            {/* Generate dues prompt */}
            {showGenPrompt && (
              <div className="mt-3 border border-brand-100 bg-brand-50 rounded-xl px-3 py-3">
                <p className="text-sm text-slate-700 font-medium mb-1">Generate dues now?</p>
                <p className="text-xs text-slate-500 mb-3">
                  This will create pending fee entries for the current month based on the assigned structure.
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={handleGenerateDues}
                    disabled={genLoading}
                    className="btn-primary text-xs py-1.5 px-3 flex items-center gap-1.5"
                  >
                    {genLoading ? (
                      <><span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" /> Generating</>
                    ) : 'Yes, generate'}
                  </button>
                  <button
                    onClick={() => setShowGenPrompt(false)}
                    className="btn-secondary text-xs py-1.5 px-3"
                  >
                    Skip
                  </button>
                </div>
              </div>
            )}

            {/* Generation result */}
            {genResult && (
              <div className="mt-3 flex items-center gap-2 text-xs text-green-700 bg-green-50 px-3 py-2 rounded-lg">
                <CheckCircle2 size={13} className="shrink-0" />
                {genResult.generated} dues generated, {genResult.skipped} skipped (already exist)
              </div>
            )}
          </div>

          {/* ── Fee stats ──────────────────────────────────────── */}
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
            <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
              <h3 className="font-semibold text-slate-800">Fee history</h3>
              <div className="flex items-center gap-2">
                <Link
                  href={`/dashboard/fees/ledger/${student.id}`}
                  className="btn-secondary flex items-center gap-1.5 text-xs py-1.5 px-3"
                >
                  <IndianRupee size={13} /> Fee Ledger
                </Link>
                <Link
                  href={`/dashboard/fees/collect?student_id=${student.id}`}
                  className="btn-primary flex items-center gap-1.5 text-xs py-1.5 px-3"
                >
                  <IndianRupee size={13} /> Collect Fee
                </Link>
              </div>
            </div>
            {fees.length > 0 ? (
              <div className="flex flex-col gap-2">
                {fees.map((fee) => {
                  const overdue = fee.status !== 'paid' && fee.status !== 'waived' && !!fee.due_date && new Date(fee.due_date) < new Date()
                  return (
                  <div key={fee.id} className="flex items-center justify-between py-2 border-b border-slate-50 last:border-0">
                    <div>
                      <p className="text-sm font-medium text-slate-800">{fee.label}</p>
                      <p className="text-xs text-slate-400">
                        {fee.due_date ? `Due ${new Date(fee.due_date).toLocaleDateString('en-IN')}` : 'No date'}
                        {fee.status === 'partial' ? ` · ₹${Number(fee.balance).toLocaleString('en-IN')} left` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="font-semibold text-slate-900">₹{Number(fee.total_due).toLocaleString('en-IN')}</span>
                      <span className={fee.status === 'paid' ? 'badge-green' : overdue ? 'badge-red' : 'badge-yellow'}>
                        {overdue ? 'overdue' : fee.status}
                      </span>
                    </div>
                  </div>
                )})}
              </div>
            ) : (
              <p className="text-sm text-slate-400 text-center py-4">No dues yet</p>
            )}
          </div>

          {/* ── Attendance history panel ─────────────────────── */}
          <div className="card">
            <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
              <h3 className="font-semibold text-slate-800 flex items-center gap-2">
                <CalendarCheck size={17} className="text-brand-600" /> Attendance history
              </h3>
              {/* Month picker */}
              <input
                type="month"
                value={attendanceMonth}
                max={new Date().toISOString().slice(0, 7)}
                onChange={e => setAttendanceMonth(e.target.value)}
                className="input text-xs py-1 px-2 w-auto"
              />
            </div>

            {(() => {
              // Filter records for selected month
              const [yr, mo] = attendanceMonth.split('-').map(Number)
              const monthRecords = attendance.filter(r => {
                const d = new Date(r.scan_date)
                return d.getFullYear() === yr && d.getMonth() + 1 === mo
              })

              // Group by date — each date can have entry + exit
              const byDate: Record<string, { entry?: AttendanceRecord; exit?: AttendanceRecord }> = {}
              monthRecords.forEach(r => {
                if (!byDate[r.scan_date]) byDate[r.scan_date] = {}
                if (r.entry_type === 'entry') byDate[r.scan_date].entry = r
                else byDate[r.scan_date].exit = r
              })

              const presentDays = Object.keys(byDate).length
              // Working days = weekdays in selected month (Mon-Sat)
              const daysInMonth = new Date(yr, mo, 0).getDate()
              const workingDays = Array.from({ length: daysInMonth }, (_, i) => {
                const d = new Date(yr, mo - 1, i + 1).getDay()
                return d !== 0 // exclude Sundays only
              }).filter(Boolean).length
              const pct = workingDays > 0 ? Math.round((presentDays / workingDays) * 100) : 0

              const sortedDates = Object.keys(byDate).sort((a, b) => b.localeCompare(a))

              return (
                <>
                  {/* Month summary */}
                  <div className="grid grid-cols-3 gap-3 mb-4">
                    <div className="bg-brand-50 rounded-xl p-3 text-center">
                      <p className="text-xs text-slate-500 mb-1">Present</p>
                      <p className="text-xl font-bold text-brand-700">{presentDays}</p>
                      <p className="text-xs text-slate-400">days</p>
                    </div>
                    <div className="bg-slate-50 rounded-xl p-3 text-center">
                      <p className="text-xs text-slate-500 mb-1">Working</p>
                      <p className="text-xl font-bold text-slate-700">{workingDays}</p>
                      <p className="text-xs text-slate-400">days</p>
                    </div>
                    <div className={`rounded-xl p-3 text-center ${pct >= 75 ? 'bg-green-50' : pct >= 50 ? 'bg-yellow-50' : 'bg-red-50'}`}>
                      <p className="text-xs text-slate-500 mb-1">Rate</p>
                      <p className={`text-xl font-bold ${pct >= 75 ? 'text-green-700' : pct >= 50 ? 'text-yellow-700' : 'text-red-600'}`}>{pct}%</p>
                      <p className="text-xs text-slate-400">attendance</p>
                    </div>
                  </div>

                  {/* Progress bar */}
                  <div className="w-full bg-slate-100 rounded-full h-1.5 mb-4">
                    <div
                      className={`h-1.5 rounded-full transition-all ${pct >= 75 ? 'bg-green-500' : pct >= 50 ? 'bg-yellow-500' : 'bg-red-500'}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>

                  {/* Daily log */}
                  {sortedDates.length === 0 ? (
                    <p className="text-sm text-slate-400 text-center py-4">No attendance records this month</p>
                  ) : (
                    <div className="flex flex-col divide-y divide-slate-50">
                      {sortedDates.map(date => {
                        const { entry, exit } = byDate[date]
                        const d = new Date(date + 'T00:00:00')
                        const dayLabel = d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })
                        const entryTime = entry ? new Date(entry.scan_time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }) : null
                        const exitTime  = exit  ? new Date(exit.scan_time).toLocaleTimeString('en-IN',  { hour: '2-digit', minute: '2-digit', hour12: true }) : null
                        return (
                          <div key={date} className="flex items-center justify-between py-2.5">
                            <div className="flex items-center gap-2.5">
                              <div className="w-8 h-8 bg-green-50 rounded-lg flex items-center justify-center shrink-0">
                                <CalendarCheck size={14} className="text-green-600" />
                              </div>
                              <div>
                                <p className="text-sm font-medium text-slate-800">{dayLabel}</p>
                                <p className="text-xs text-slate-400">{entry?.gate ?? exit?.gate ?? '—'}</p>
                              </div>
                            </div>
                            <div className="flex items-center gap-3 text-xs">
                              {entryTime && (
                                <div className="flex items-center gap-1 text-green-700 bg-green-50 px-2 py-0.5 rounded-full">
                                  <LogIn size={11} /> {entryTime}
                                </div>
                              )}
                              {exitTime && (
                                <div className="flex items-center gap-1 text-blue-700 bg-blue-50 px-2 py-0.5 rounded-full">
                                  <LogOutIcon size={11} /> {exitTime}
                                </div>
                              )}
                              {!entryTime && !exitTime && <span className="text-slate-400">—</span>}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </>
              )
            })()}
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
