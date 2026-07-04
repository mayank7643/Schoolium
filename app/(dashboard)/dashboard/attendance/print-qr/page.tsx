'use client'

// FILE: app/(dashboard)/dashboard/attendance/print-qr/page.tsx
// ID card generator + printer. CR80 cards exactly 86mm x 54mm, imposed 2 x 5
// (10 per A4 page) on a CSS grid with cut guides. Prints through a PERSISTENT
// hidden iframe containing ONLY the cards (a dynamically-created iframe makes
// Chrome print the parent dashboard). Photo slot renders photo_url if present,
// else an initials placeholder.

import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { createClient } from '@/utils/supabase/client'
import { ArrowLeft, Printer, CreditCard, Loader2, Info, AlertCircle } from 'lucide-react'

interface St {
  id: string
  full_name: string
  student_uid: string | null
  father_name: string | null
  parent_phone: string | null
  photo_url: string | null
  class_name: string | null
  section: string | null
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, c => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string))
}

// ---- print document (exact mm) ---------------------------------------------
function buildDoc(schoolName: string, students: St[], qr: Record<string, string>): string {
  const card = (s: St) => {
    const cls = s.class_name ? `${s.class_name}${s.section ? '-' + s.section : ''}` : ''
    const photo = s.photo_url
      ? `<img class="photo" src="${esc(s.photo_url)}" alt=""/>`
      : `<div class="photo ph">${esc((s.full_name || '?').charAt(0).toUpperCase())}</div>`
    return `<div class="card">
      <div class="hdr"><div class="sch">${esc((schoolName || 'School').toUpperCase())}</div><div class="sub">STUDENT IDENTITY CARD</div></div>
      <div class="body">
        ${photo}
        <div class="info">
          <div class="nm">${esc(s.full_name)}</div>
          ${cls ? `<div class="cl">Class ${esc(cls)}</div>` : ''}
          ${s.student_uid ? `<div class="uid">${esc(s.student_uid)}</div>` : ''}
          <div class="mt"><span class="ml">Father</span>${esc(s.father_name || '—')}</div>
          <div class="mt"><span class="ml">Phone</span>${esc(s.parent_phone || '—')}</div>
        </div>
        <div class="qrw">${qr[s.id] ? `<img class="qr" src="${qr[s.id]}"/>` : '<div class="qr"></div>'}<div class="qrl">Scan for attendance</div></div>
      </div>
    </div>`
  }

  const pages: string[] = []
  for (let i = 0; i < students.length; i += 10) {
    pages.push(`<div class="page">${students.slice(i, i + 10).map(card).join('')}</div>`)
  }

  return `<!doctype html><html><head><meta charset="utf-8"><title>ID Cards</title><style>
@page { size: A4 portrait; margin: 3mm; }
* { margin:0; padding:0; box-sizing:border-box; font-family: Arial, Helvetica, sans-serif;
    -webkit-print-color-adjust:exact; print-color-adjust:exact; }
body { background:#fff; }
.page {
  display:grid;
  grid-template-columns: repeat(2, 86mm);   /* 2 columns, exact width */
  grid-auto-rows: 54mm;                      /* 5 rows, exact height */
  column-gap: 8mm; row-gap: 5mm;             /* cutting room */
  justify-content:center; align-content:start;
  page-break-after: always;
}
.page:last-child { page-break-after: auto; }
.card {
  width:86mm; height:54mm; overflow:hidden; background:#fff;
  border:1px solid #e2e8f0;         /* card box */
  outline:1px dashed #94a3b8;       /* cut guide, sits in the gap */
  outline-offset:2.2mm;
  display:flex; flex-direction:column;
  page-break-inside:avoid; break-inside:avoid;
}
.hdr { background:#1d4ed8; color:#fff; text-align:center; padding:1.5mm 2mm; }
.sch { font-size:8pt; font-weight:bold; line-height:1.1; }
.sub { font-size:4.6pt; letter-spacing:.6pt; opacity:.85; margin-top:.3mm; }
.body { flex:1; display:flex; gap:2.6mm; padding:2.4mm 2.8mm; align-items:flex-start; }
.photo { width:15mm; height:19mm; border-radius:1mm; border:1px solid #cbd5e1; object-fit:cover; flex-shrink:0; }
.photo.ph { display:flex; align-items:center; justify-content:center; background:#dbeafe; color:#1d4ed8; font-size:13pt; font-weight:bold; }
.info { flex:1; min-width:0; display:flex; flex-direction:column; gap:.6mm; }
.nm  { font-size:9pt; font-weight:bold; color:#0f172a; line-height:1.15; }
.cl  { font-size:6.4pt; color:#475569; }
.uid { align-self:flex-start; font-family:'Courier New',monospace; font-size:6.4pt; font-weight:bold;
       color:#1d4ed8; background:#eff6ff; border:.5pt solid #bfdbfe; padding:.4mm 1.4mm; border-radius:1mm; margin:.3mm 0; }
.mt  { font-size:5.6pt; color:#334155; }
.ml  { color:#94a3b8; display:inline-block; width:8mm; }
.qrw { display:flex; flex-direction:column; align-items:center; flex-shrink:0; }
.qr  { width:17mm; height:17mm; }
.qrl { font-size:4.4pt; color:#94a3b8; margin-top:.6mm; text-align:center; }
</style></head><body>${pages.join('')}</body></html>`
}

export default function PrintIdCardsPage() {
  const [students, setStudents] = useState<St[]>([])
  const [classes, setClasses]   = useState<{ name: string; section: string | null }[]>([])
  const [schoolName, setSchoolName] = useState('')
  const [selClass, setSelClass] = useState('')
  const [selSection, setSelSection] = useState('')
  const [loading, setLoading]   = useState(true)
  const [building, setBuilding] = useState(false)
  const [doc, setDoc]           = useState('')
  const [error, setError]       = useState('')

  const frameRef = useRef<HTMLIFrameElement>(null)

  // Load students + classes + school name
  useEffect(() => {
    (async () => {
      const supabase = createClient()
      const { data: profile } = await supabase.from('profiles').select('school_id, schools(name)').single()
      if (!profile) { setLoading(false); return }
      const p = profile as any
      setSchoolName(Array.isArray(p.schools) ? (p.schools[0]?.name ?? '') : (p.schools?.name ?? ''))

      const [stuRes, clsRes] = await Promise.all([
        supabase.from('students')
          .select('id, full_name, student_uid, father_name, parent_phone, photo_url, classes(name, section)')
          .eq('school_id', p.school_id).eq('is_active', true).order('full_name'),
        supabase.from('classes').select('name, section').eq('school_id', p.school_id).order('name'),
      ])

      const list: St[] = ((stuRes.data as any[]) || []).map(s => {
        const c = Array.isArray(s.classes) ? s.classes[0] : s.classes
        return {
          id: s.id, full_name: s.full_name, student_uid: s.student_uid,
          father_name: s.father_name, parent_phone: s.parent_phone, photo_url: s.photo_url,
          class_name: c?.name ?? null, section: c?.section ?? null,
        }
      })
      setStudents(list)
      setClasses((clsRes.data as any[]) || [])
      setLoading(false)
    })()
  }, [])

  const filtered = students.filter(s =>
    (!selClass || s.class_name === selClass) && (!selSection || s.section === selSection)
  )

  // Build QR + print document whenever the selection changes
  const rebuild = useCallback(async (list: St[]) => {
    if (list.length === 0) { setDoc(''); return }
    setBuilding(true); setError('')
    try {
      const QRCode = (await import('qrcode')).default
      const qr: Record<string, string> = {}
      for (const s of list) {
        qr[s.id] = await QRCode.toDataURL(s.id, { width: 220, margin: 0, errorCorrectionLevel: 'M' })
      }
      setDoc(buildDoc(schoolName, list, qr))
    } catch (e) {
      setError('Could not generate QR codes')
    }
    setBuilding(false)
  }, [schoolName])

  useEffect(() => { rebuild(filtered) /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [selClass, selSection, students, schoolName])

  function handlePrint() {
    const frame = frameRef.current
    if (!frame || !doc) return
    setError('')
    try { frame.contentWindow?.focus(); frame.contentWindow?.print() }
    catch { setError('Could not open the print dialog') }
  }

  const classNames = Array.from(new Set(classes.map(c => c.name))).sort()
  const sections   = Array.from(new Set(classes.filter(c => c.name === selClass && c.section).map(c => c.section as string))).sort()
  const pageCount  = Math.ceil(filtered.length / 10)

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto">
        <div className="h-8 w-56 bg-slate-100 rounded animate-pulse mb-6" />
        <div className="card h-64 animate-pulse bg-slate-50" />
      </div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 mb-5 flex-wrap">
        <div className="flex items-center gap-3">
          <Link href="/dashboard/attendance" className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 text-slate-500">
            <ArrowLeft size={18} />
          </Link>
          <div>
            <h1 className="text-xl font-bold text-slate-900">Print ID Cards</h1>
            <p className="text-slate-400 text-xs mt-0.5">CR80 · 86×54mm · 10 per A4 sheet</p>
          </div>
        </div>
        <button onClick={handlePrint} disabled={building || filtered.length === 0}
          className="btn-primary flex items-center gap-2 text-sm">
          {building ? <><Loader2 size={15} className="animate-spin" /> Preparing…</> : <><Printer size={15} /> Print {filtered.length} card{filtered.length === 1 ? '' : 's'}</>}
        </button>
      </div>

      {/* Filters */}
      <div className="card flex flex-wrap items-end gap-3 mb-4">
        <div className="w-40">
          <label className="label">Class</label>
          <select className="input" value={selClass} onChange={e => { setSelClass(e.target.value); setSelSection('') }}>
            <option value="">Whole school</option>
            {classNames.map(n => <option key={n} value={n}>Class {n}</option>)}
          </select>
        </div>
        <div className="w-40">
          <label className="label">Section</label>
          <select className="input" value={selSection} disabled={!selClass || sections.length === 0}
            onChange={e => setSelSection(e.target.value)}>
            <option value="">All sections</option>
            {sections.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <p className="text-xs text-slate-400 ml-auto self-center">
          {filtered.length} student{filtered.length === 1 ? '' : 's'} · {pageCount} page{pageCount === 1 ? '' : 's'}
        </p>
      </div>

      {/* Critical print-settings note */}
      <div className="flex items-start gap-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5 mb-4">
        <Info size={14} className="shrink-0 mt-0.5 text-amber-500" />
        <p>
          In the print dialog, set <b>Scale = 100%</b> (or Default) and <b>Margins = None / Minimum</b>.
          Do <b>not</b> enable “Fit to page” — it resizes the cards and they won’t fit lamination pouches.
          Cut along the dashed guides.
        </p>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg mb-3">
          <AlertCircle size={14} /> {error}
        </div>
      )}

      {/* Live preview (this exact document is what prints) */}
      <div className="card p-0 overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-100 text-xs text-slate-500">
          <CreditCard size={13} /> Preview — printed output
        </div>
        {filtered.length === 0 ? (
          <div className="py-16 text-center text-slate-400 text-sm">No students match this filter.</div>
        ) : (
          <iframe
            ref={frameRef}
            title="id-card-print"
            srcDoc={doc}
            className="w-full bg-slate-100"
            style={{ height: 560, border: 'none' }}
          />
        )}
      </div>
    </div>
  )
}
