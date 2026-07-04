'use client'

// FILE: app/(dashboard)/dashboard/staff/id-cards/page.tsx
//
// Staff ID card generator + printer (chat17 Module 4). Mirrors the
// student print-qr architecture exactly (chat16 CR80 rebuild):
//   - cards exactly 86mm x 54mm, CSS grid 2 x 5 = 10 per A4
//   - solid card border + dashed cut guide in the gap
//   - prints through the PERSISTENT hidden iframe (never dynamic)
//   - print at 100% scale, Margins None - never Fit to page
// Differences for staff:
//   - QR encodes "STAFF:<uuid>" so the gate scanner routes it to
//     record_staff_scan() instead of the student flow
//   - dark header so guards can tell staff cards from student cards
//     at a glance; school logo renders in the header when set
//   - shows designation, department and the EMP employee ID

import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { createClient } from '@/utils/supabase/client'
import { ArrowLeft, Printer, CreditCard, Loader2, Info, AlertCircle } from 'lucide-react'

interface StaffCard {
  id: string
  full_name: string
  employee_id: string
  designation: string
  department: string
  mobile: string
  photo_url: string | null
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, c => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string))
}

// ---- print document (exact mm) ---------------------------------------------
function buildDoc(
  schoolName: string,
  logoUrl: string | null,
  staff: StaffCard[],
  qr: Record<string, string>
): string {
  const card = (s: StaffCard) => {
    const photo = s.photo_url
      ? `<img class="photo" src="${esc(s.photo_url)}" alt=""/>`
      : `<div class="photo ph">${esc((s.full_name || '?').charAt(0).toUpperCase())}</div>`
    const logo = logoUrl ? `<img class="logo" src="${esc(logoUrl)}" alt=""/>` : ''
    return `<div class="card">
      <div class="hdr">${logo}<div class="hdrt"><div class="sch">${esc((schoolName || 'School').toUpperCase())}</div><div class="sub">STAFF IDENTITY CARD</div></div></div>
      <div class="body">
        ${photo}
        <div class="info">
          <div class="nm">${esc(s.full_name)}</div>
          <div class="dg">${esc(s.designation)}</div>
          <div class="uid">${esc(s.employee_id)}</div>
          <div class="mt"><span class="ml">Dept</span>${esc(s.department)}</div>
          <div class="mt"><span class="ml">Phone</span>${esc(s.mobile || '—')}</div>
        </div>
        <div class="qrw">${qr[s.id] ? `<img class="qr" src="${qr[s.id]}"/>` : '<div class="qr"></div>'}<div class="qrl">Scan for attendance</div></div>
      </div>
    </div>`
  }

  const pages: string[] = []
  for (let i = 0; i < staff.length; i += 10) {
    pages.push(`<div class="page">${staff.slice(i, i + 10).map(card).join('')}</div>`)
  }

  return `<!doctype html><html><head><meta charset="utf-8"><title>Staff ID Cards</title><style>
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
.hdr { background:#0f172a; color:#fff; padding:1.5mm 2mm; display:flex; align-items:center; gap:1.6mm; justify-content:center; }
.logo { width:6mm; height:6mm; object-fit:contain; background:#fff; border-radius:1mm; flex-shrink:0; }
.hdrt { text-align:center; }
.sch { font-size:8pt; font-weight:bold; line-height:1.1; }
.sub { font-size:4.6pt; letter-spacing:.6pt; opacity:.85; margin-top:.3mm; }
.body { flex:1; display:flex; gap:2.6mm; padding:2.4mm 2.8mm; align-items:flex-start; }
.photo { width:15mm; height:19mm; border-radius:1mm; border:1px solid #cbd5e1; object-fit:cover; flex-shrink:0; }
.photo.ph { display:flex; align-items:center; justify-content:center; background:#e2e8f0; color:#0f172a; font-size:13pt; font-weight:bold; }
.info { flex:1; min-width:0; display:flex; flex-direction:column; gap:.6mm; }
.nm  { font-size:9pt; font-weight:bold; color:#0f172a; line-height:1.15; }
.dg  { font-size:6.4pt; color:#475569; }
.uid { align-self:flex-start; font-family:'Courier New',monospace; font-size:6.4pt; font-weight:bold;
       color:#0f172a; background:#f1f5f9; border:.5pt solid #cbd5e1; padding:.4mm 1.4mm; border-radius:1mm; margin:.3mm 0; }
.mt  { font-size:5.6pt; color:#334155; }
.ml  { color:#94a3b8; display:inline-block; width:8mm; }
.qrw { display:flex; flex-direction:column; align-items:center; flex-shrink:0; }
.qr  { width:17mm; height:17mm; }
.qrl { font-size:4.4pt; color:#94a3b8; margin-top:.6mm; text-align:center; }
</style></head><body>${pages.join('')}</body></html>`
}

export default function StaffIdCardsPage() {
  const [staff, setStaff]           = useState<StaffCard[]>([])
  const [schoolName, setSchoolName] = useState('')
  const [logoUrl, setLogoUrl]       = useState<string | null>(null)
  const [selDept, setSelDept]       = useState('')
  const [loading, setLoading]       = useState(true)
  const [building, setBuilding]     = useState(false)
  const [doc, setDoc]               = useState('')
  const [error, setError]           = useState('')
  const [allowed, setAllowed]       = useState<boolean | null>(null)

  const frameRef = useRef<HTMLIFrameElement>(null)

  // Load staff + school
  useEffect(() => {
    (async () => {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { setAllowed(false); setLoading(false); return }

      const { data: profile } = await supabase
        .from('profiles')
        .select('role, school_id, schools(name, logo_url)')
        .eq('id', user.id)
        .single()

      const p = profile as any
      const ok = p?.role === 'school_admin' || p?.role === 'principal'
      setAllowed(ok)
      if (!ok) { setLoading(false); return }

      const school = Array.isArray(p.schools) ? p.schools[0] : p.schools
      setSchoolName(school?.name ?? '')
      setLogoUrl(school?.logo_url ?? null)

      const { data: staffData } = await supabase
        .from('staff')
        .select('id, full_name, employee_id, designation, department, mobile, photo_url')
        .in('employment_status', ['active', 'probation', 'on_leave'])
        .order('full_name')

      setStaff((staffData ?? []) as StaffCard[])
      setLoading(false)
    })()
  }, [])

  const filtered = staff.filter(s => !selDept || s.department === selDept)

  // Build QR + print document whenever the selection changes.
  // QR payload is "STAFF:<uuid>" - the gate scanner detects the prefix
  // and routes to record_staff_scan() (chat17 Module 3).
  const rebuild = useCallback(async (list: StaffCard[]) => {
    if (list.length === 0) { setDoc(''); return }
    setBuilding(true); setError('')
    try {
      const QRCode = (await import('qrcode')).default
      const qr: Record<string, string> = {}
      for (const s of list) {
        qr[s.id] = await QRCode.toDataURL(`STAFF:${s.id}`, { width: 220, margin: 0, errorCorrectionLevel: 'M' })
      }
      setDoc(buildDoc(schoolName, logoUrl, list, qr))
    } catch {
      setError('Could not generate QR codes')
    }
    setBuilding(false)
  }, [schoolName, logoUrl])

  useEffect(() => { rebuild(filtered) /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [selDept, staff, schoolName, logoUrl])

  function handlePrint() {
    const frame = frameRef.current
    if (!frame || !doc) return
    setError('')
    try { frame.contentWindow?.focus(); frame.contentWindow?.print() }
    catch { setError('Could not open the print dialog') }
  }

  const departments = Array.from(new Set(staff.map(s => s.department))).sort()
  const pageCount   = Math.ceil(filtered.length / 10)

  if (!loading && allowed === false) {
    return (
      <div className="max-w-2xl">
        <div className="card">
          <h1 className="text-lg font-semibold text-slate-900 mb-1">Staff ID cards</h1>
          <p className="text-sm text-slate-500">
            Only a school admin or principal can print staff ID cards.
          </p>
        </div>
      </div>
    )
  }

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
          <Link href="/dashboard/staff" className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 text-slate-500">
            <ArrowLeft size={18} />
          </Link>
          <div>
            <h1 className="text-xl font-bold text-slate-900">Staff ID Cards</h1>
            <p className="text-slate-400 text-xs mt-0.5">CR80 · 86×54mm · 10 per A4 sheet</p>
          </div>
        </div>
        <button onClick={handlePrint} disabled={building || filtered.length === 0}
          className="btn-primary flex items-center gap-2 text-sm">
          {building ? <><Loader2 size={15} className="animate-spin" /> Preparing…</> : <><Printer size={15} /> Print {filtered.length} card{filtered.length === 1 ? '' : 's'}</>}
        </button>
      </div>

      {/* Filter */}
      <div className="card flex flex-wrap items-end gap-3 mb-4">
        <div className="w-48">
          <label className="label">Department</label>
          <select className="input" value={selDept} onChange={e => setSelDept(e.target.value)}>
            <option value="">All departments</option>
            {departments.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
        <p className="text-xs text-slate-400 ml-auto self-center">
          {filtered.length} member{filtered.length === 1 ? '' : 's'} · {pageCount} page{pageCount === 1 ? '' : 's'}
        </p>
      </div>

      {/* Critical print-settings note */}
      <div className="flex items-start gap-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5 mb-4">
        <Info size={14} className="shrink-0 mt-0.5 text-amber-500" />
        <p>
          In the print dialog, set <b>Scale = 100%</b> (or Default) and <b>Margins = None / Minimum</b>.
          Do <b>not</b> enable &ldquo;Fit to page&rdquo; — it resizes the cards and they won&apos;t fit lamination pouches.
          Cut along the dashed guides. Scanning a staff card at the gate records staff check-in / check-out.
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
          <div className="py-16 text-center text-slate-400 text-sm">No staff match this filter.</div>
        ) : (
          <iframe
            ref={frameRef}
            title="staff-id-card-print"
            srcDoc={doc}
            className="w-full bg-slate-100"
            style={{ height: 560, border: 'none' }}
          />
        )}
      </div>
    </div>
  )
}
