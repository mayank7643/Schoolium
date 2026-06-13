'use client'

// FILE: app/(dashboard)/dashboard/attendance/print-qr/page.tsx
// Bulk QR card printer — filter by class or whole school
// Generates all cards in browser, then prints via hidden iframe

import { useState, useEffect, useRef, useCallback } from 'react'
import { createClient } from '@/utils/supabase/client'
import { ArrowLeft, Printer, QrCode, Users, BookOpen, CheckSquare } from 'lucide-react'
import Link from 'next/link'

interface Student {
  id: string
  full_name: string
  student_uid: string | null
  parent_phone: string | null
  father_name: string | null
  classes: { id: string; name: string; section: string | null } | null
}

interface ClassGroup {
  id: string
  name: string
  section: string | null
  students: Student[]
}

export default function PrintQRPage() {
  const [classes,       setClasses]       = useState<ClassGroup[]>([])
  const [selectedClass, setSelectedClass] = useState<string>('all') // 'all' or class id
  const [schoolName,    setSchoolName]    = useState('School')
  const [loading,       setLoading]       = useState(true)
  const [printing,      setPrinting]      = useState(false)
  const [progress,      setProgress]      = useState(0)
  const [total,         setTotal]         = useState(0)

  useEffect(() => {
    async function load() {
      const supabase = createClient()
      const [profileRes, studentsRes, classesRes] = await Promise.all([
        supabase.from('profiles').select('school_id, schools(name)').single(),
        supabase.from('students')
          .select('id, full_name, student_uid, parent_phone, father_name, classes(id, name, section)')
          .eq('is_active', true)
          .order('full_name'),
        supabase.from('classes').select('id, name, section').order('name'),
      ])

      if (profileRes.data) {
        setSchoolName((profileRes.data as any).schools?.name ?? 'School')
      }

      const allStudents = (studentsRes.data ?? []) as Student[]
      const allClasses  = (classesRes.data ?? []) as { id: string; name: string; section: string | null }[]

      // Group students by class
      const grouped: ClassGroup[] = allClasses.map(cls => ({
        ...cls,
        students: allStudents.filter(s => s.classes?.id === cls.id),
      })).filter(g => g.students.length > 0)

      // Add unassigned group if any
      const unassigned = allStudents.filter(s => !s.classes)
      if (unassigned.length > 0) {
        grouped.push({ id: 'unassigned', name: 'No Class', section: null, students: unassigned })
      }

      setClasses(grouped)
      setLoading(false)
    }
    load()
  }, [])

  const selectedStudents = selectedClass === 'all'
    ? classes.flatMap(g => g.students)
    : classes.find(g => g.id === selectedClass)?.students ?? []

  async function handlePrint() {
    if (selectedStudents.length === 0) return
    setPrinting(true)
    setProgress(0)
    setTotal(selectedStudents.length)

    try {
      const QRCode = (await import('qrcode')).default

      // Generate all QR data URLs in sequence
      const cards: { student: Student; qrDataUrl: string }[] = []
      for (let i = 0; i < selectedStudents.length; i++) {
        const s = selectedStudents[i]
        const canvas = document.createElement('canvas')
        await QRCode.toCanvas(canvas, s.id, {
          width: 160,
          margin: 1,
          color: { dark: '#0f172a', light: '#ffffff' },
        })
        cards.push({ student: s, qrDataUrl: canvas.toDataURL('image/png') })
        setProgress(i + 1)
      }

      // Build print HTML — 3 cards per row, standard ID card size
      const cardHTML = cards.map(({ student, qrDataUrl }) => {
        const cls = student.classes
          ? `${student.classes.name}${student.classes.section ? ' - ' + student.classes.section : ''}`
          : ''
        return `
<div class="card">
  <div class="header">
    <div class="school">${schoolName.toUpperCase()}</div>
    <div class="sub">Student Identity Card</div>
  </div>
  <div class="body">
    <div class="avatar">${student.full_name.charAt(0).toUpperCase()}</div>
    <div class="name">${student.full_name}</div>
    ${cls     ? `<div class="class">${cls}</div>` : ''}
    ${student.student_uid ? `<div class="uid">${student.student_uid}</div>` : ''}
    <img class="qr" src="${qrDataUrl}" alt="QR"/>
    <div class="scan-label">Scan for attendance</div>
  </div>
  <div class="footer">
    <div><div class="fl">Father</div><div class="fv">${student.father_name ?? '—'}</div></div>
    <div style="text-align:right"><div class="fl">Phone</div><div class="fv">${student.parent_phone ?? '—'}</div></div>
  </div>
</div>`
      }).join('')

      const printHTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>ID Cards – ${schoolName}</title>
  <style>
    @page { size: A4; margin: 10mm; }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: Arial, sans-serif; }
    body { background: #fff; }
    .grid { display: flex; flex-wrap: wrap; gap: 6mm; justify-content: flex-start; }
    .card {
      width: 54mm; height: 85mm;
      border: 1.5px solid #1d4ed8; border-radius: 6px;
      overflow: hidden; display: flex; flex-direction: column;
      page-break-inside: avoid; break-inside: avoid;
    }
    .header { background: #1d4ed8; color: white; padding: 5px 6px; text-align: center; }
    .school { font-size: 7px; font-weight: bold; letter-spacing: 0.3px; }
    .sub    { font-size: 5.5px; opacity: 0.8; margin-top: 1px; }
    .body   { flex: 1; display: flex; flex-direction: column; align-items: center; padding: 6px 6px 4px; gap: 3px; }
    .avatar {
      width: 32px; height: 32px; border-radius: 50%;
      background: #dbeafe; display: flex; align-items: center; justify-content: center;
      font-size: 14px; font-weight: bold; color: #1d4ed8; flex-shrink: 0;
    }
    .name  { font-size: 8.5px; font-weight: bold; color: #0f172a; text-align: center; line-height: 1.2; }
    .class { font-size: 6.5px; color: #64748b; }
    .uid   {
      font-family: monospace; font-size: 6.5px; font-weight: bold;
      background: #eff6ff; color: #1d4ed8; border: 0.5px solid #bfdbfe;
      padding: 1.5px 5px; border-radius: 3px;
    }
    .qr    { width: 58px; height: 58px; }
    .scan-label { font-size: 5px; color: #94a3b8; }
    .footer {
      background: #f8fafc; border-top: 0.5px solid #e2e8f0;
      padding: 3px 6px; display: flex; justify-content: space-between;
    }
    .fl { font-size: 5px; color: #94a3b8; }
    .fv { font-size: 5.5px; color: #475569; font-weight: 500; }
  </style>
</head>
<body>
<div class="grid">${cardHTML}</div>
</body>
</html>`

      const iframe = document.createElement('iframe')
      iframe.style.display = 'none'
      document.body.appendChild(iframe)
      iframe.contentWindow!.document.open()
      iframe.contentWindow!.document.write(printHTML)
      iframe.contentWindow!.document.close()
      setTimeout(() => {
        iframe.contentWindow!.focus()
        iframe.contentWindow!.print()
        setTimeout(() => {
          document.body.removeChild(iframe)
          setPrinting(false)
          setProgress(0)
        }, 2000)
      }, 600)

    } catch (err) {
      console.error('Print failed:', err)
      setPrinting(false)
    }
  }

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-8 h-8 bg-slate-200 rounded-lg animate-pulse" />
          <div className="h-7 w-48 bg-slate-200 rounded animate-pulse" />
        </div>
        <div className="card h-64 animate-pulse bg-slate-50" />
      </div>
    )
  }

  const totalStudents = classes.reduce((s, g) => s + g.students.length, 0)

  return (
    <div className="max-w-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <Link href="/dashboard/attendance"
          className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 transition-colors">
          <ArrowLeft size={18} className="text-slate-600" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Print ID Cards</h1>
          <p className="text-sm text-slate-500">{totalStudents} students · {classes.length} classes</p>
        </div>
      </div>

      <div className="card mb-5">
        <h2 className="font-semibold text-slate-800 mb-4 flex items-center gap-2">
          <BookOpen size={18} className="text-brand-600" /> Select students to print
        </h2>

        {/* Filter pills */}
        <div className="flex flex-wrap gap-2 mb-5">
          {/* All school */}
          <button
            onClick={() => setSelectedClass('all')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium border transition-colors ${
              selectedClass === 'all'
                ? 'bg-brand-600 text-white border-brand-600'
                : 'bg-white text-slate-600 border-slate-200 hover:border-brand-300'
            }`}
          >
            <Users size={13} />
            Whole school
            <span className={`text-xs rounded-full px-1.5 py-0.5 ${
              selectedClass === 'all' ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-500'
            }`}>
              {totalStudents}
            </span>
          </button>

          {/* Per class */}
          {classes.map(g => (
            <button
              key={g.id}
              onClick={() => setSelectedClass(g.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium border transition-colors ${
                selectedClass === g.id
                  ? 'bg-brand-600 text-white border-brand-600'
                  : 'bg-white text-slate-600 border-slate-200 hover:border-brand-300'
              }`}
            >
              {g.name}{g.section ? ` ${g.section}` : ''}
              <span className={`text-xs rounded-full px-1.5 py-0.5 ${
                selectedClass === g.id ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-500'
              }`}>
                {g.students.length}
              </span>
            </button>
          ))}
        </div>

        {/* Selected summary */}
        <div className="bg-brand-50 border border-brand-100 rounded-xl p-4 mb-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CheckSquare size={18} className="text-brand-600" />
              <span className="font-medium text-brand-800">
                {selectedClass === 'all' ? 'Whole school' : classes.find(g => g.id === selectedClass)?.name}
              </span>
            </div>
            <span className="text-brand-700 font-semibold text-sm">
              {selectedStudents.length} cards
            </span>
          </div>
          <p className="text-xs text-brand-600 mt-1 ml-6">
            Each card is 54×85mm · 3 cards per A4 row · will open print dialog
          </p>
        </div>

        {/* Progress bar while generating */}
        {printing && (
          <div className="mb-4">
            <div className="flex justify-between text-xs text-slate-500 mb-1">
              <span>Generating QR codes…</span>
              <span>{progress} / {total}</span>
            </div>
            <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-brand-600 rounded-full transition-all duration-200"
                style={{ width: `${total > 0 ? (progress / total) * 100 : 0}%` }}
              />
            </div>
          </div>
        )}

        <button
          onClick={handlePrint}
          disabled={printing || selectedStudents.length === 0}
          className="btn-primary w-full flex items-center justify-center gap-2 py-3 text-base"
        >
          {printing ? (
            <>
              <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              Generating {progress}/{total}…
            </>
          ) : (
            <>
              <Printer size={18} />
              Print {selectedStudents.length} ID Card{selectedStudents.length !== 1 ? 's' : ''}
            </>
          )}
        </button>
      </div>

      {/* Student list preview */}
      <div className="card">
        <h3 className="font-semibold text-slate-800 mb-3 flex items-center gap-2">
          <QrCode size={16} className="text-brand-600" />
          Cards to print ({selectedStudents.length})
        </h3>
        <div className="flex flex-col divide-y divide-slate-50">
          {selectedStudents.slice(0, 20).map(s => (
            <div key={s.id} className="flex items-center justify-between py-2">
              <div className="flex items-center gap-3">
                <div className="w-7 h-7 bg-brand-100 rounded-full flex items-center justify-center">
                  <span className="text-brand-700 text-xs font-bold">
                    {s.full_name.charAt(0).toUpperCase()}
                  </span>
                </div>
                <div>
                  <p className="text-sm font-medium text-slate-800">{s.full_name}</p>
                  <p className="text-xs text-slate-400">
                    {s.classes ? s.classes.name : 'No class'}
                    {s.student_uid ? ` · ${s.student_uid}` : ''}
                  </p>
                </div>
              </div>
              <QrCode size={14} className="text-slate-300" />
            </div>
          ))}
          {selectedStudents.length > 20 && (
            <p className="text-xs text-slate-400 text-center py-3">
              +{selectedStudents.length - 20} more students
            </p>
          )}
          {selectedStudents.length === 0 && (
            <p className="text-sm text-slate-400 text-center py-6">No students in this selection</p>
          )}
        </div>
      </div>
    </div>
  )
}
