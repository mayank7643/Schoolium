'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter, useParams } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/utils/supabase/client'
import {
  ArrowLeft, Phone, Mail, MapPin, Calendar, Pencil,
  Trash2, X, Save, Eye, EyeOff, IndianRupee
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

export default function StudentDetailPage() {
  const params = useParams()
  const router = useRouter()
  const studentId = params.id as string

  const [student, setStudent] = useState<StudentData | null>(null)
  const [fees, setFees] = useState<FeeRecord[]>([])
  const [classes, setClasses] = useState<ClassOption[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showAadhaar, setShowAadhaar] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState<Partial<StudentData>>({})

  const fetchData = useCallback(async () => {
    const supabase = createClient()
    const [studentRes, feesRes, classesRes] = await Promise.all([
      supabase.from('students').select('*, classes(id, name, section)').eq('id', studentId).single(),
      supabase.from('fees').select('*').eq('student_id', studentId).order('created_at', { ascending: false }),
      supabase.from('classes').select('id, name, section').order('name'),
    ])
    if (studentRes.data) {
      setStudent(studentRes.data as StudentData)
      setForm(studentRes.data as StudentData)
    }
    setFees((feesRes.data ?? []) as FeeRecord[])
    setClasses((classesRes.data ?? []) as ClassOption[])
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
      full_name: form.full_name,
      father_name: form.father_name || null,
      mother_name: form.mother_name || null,
      date_of_birth: form.date_of_birth || null,
      gender: form.gender || null,
      class_id: form.class_id || null,
      aadhaar_number: aadhaarDigits,
      address: form.address || null,
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

  const totalPaid = fees.filter(f => f.status === 'paid').reduce((s, f) => s + Number(f.amount), 0)
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
        <div className="flex gap-2">
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

            {/* Student UID badge */}
            {student.student_uid && (
              <span className="font-mono text-xs bg-brand-50 text-brand-700 border border-brand-200 px-2 py-0.5 rounded mt-1 mb-1">
                {student.student_uid}
              </span>
            )}

            {/* Class */}
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

            {/* Details */}
            <div className="w-full border-t border-slate-100 mt-4 pt-4 flex flex-col gap-3 text-sm text-left">

              {/* Father */}
              <div>
                <p className="text-xs text-slate-400 mb-1">Father's name</p>
                {editing
                  ? <input name="father_name" type="text" className="input text-sm" placeholder="Father's name" value={form.father_name ?? ''} onChange={handleChange} />
                  : <p className="text-slate-700">{student.father_name ?? <span className="text-slate-400">—</span>}</p>}
              </div>

              {/* Mother */}
              <div>
                <p className="text-xs text-slate-400 mb-1">Mother's name</p>
                {editing
                  ? <input name="mother_name" type="text" className="input text-sm" placeholder="Mother's name" value={form.mother_name ?? ''} onChange={handleChange} />
                  : <p className="text-slate-700">{student.mother_name ?? <span className="text-slate-400">—</span>}</p>}
              </div>

              {/* Phone */}
              <div className="flex items-center gap-2 text-slate-600">
                <Phone size={14} className="text-slate-400 shrink-0" />
                {editing
                  ? <input name="parent_phone" type="tel" inputMode="numeric" className="input text-sm" placeholder="Phone" value={form.parent_phone ?? ''} onChange={handleChange} maxLength={10} />
                  : <span>{student.parent_phone ?? <span className="text-slate-400">—</span>}</span>}
              </div>

              {/* Email */}
              <div className="flex items-center gap-2 text-slate-600">
                <Mail size={14} className="text-slate-400 shrink-0" />
                {editing
                  ? <input name="parent_email" type="email" className="input text-sm" placeholder="Email" value={form.parent_email ?? ''} onChange={handleChange} />
                  : <span className="break-all">{student.parent_email ?? <span className="text-slate-400">—</span>}</span>}
              </div>

              {/* Address */}
              <div className="flex items-start gap-2 text-slate-600">
                <MapPin size={14} className="text-slate-400 mt-0.5 shrink-0" />
                {editing
                  ? <textarea name="address" className="input text-sm resize-none" rows={2} placeholder="Address" value={form.address ?? ''} onChange={handleChange} />
                  : <span>{student.address ?? <span className="text-slate-400">—</span>}</span>}
              </div>

              {/* DOB */}
              <div className="flex items-center gap-2 text-slate-600">
                <Calendar size={14} className="text-slate-400 shrink-0" />
                {editing
                  ? <input name="date_of_birth" type="date" className="input text-sm" value={form.date_of_birth ?? ''} onChange={handleChange} />
                  : <span>{student.date_of_birth ? new Date(student.date_of_birth).toLocaleDateString('en-IN') : <span className="text-slate-400">—</span>}</span>}
              </div>

              {/* Aadhaar */}
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
              <Link href="/dashboard/fees" className="text-sm text-brand-600 hover:underline">Record payment</Link>
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
