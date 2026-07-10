'use client'

// FILE: app/(dashboard)/dashboard/attendance/qr-stickers/page.tsx
//
// Bulk QR sticker sheets for schools that already have their own ID
// cards: print QR-only stickers on A4 sticker/label paper and stick
// them onto each card. Complements print-qr (full CR80 ID cards).
//
// - Resizable stickers (presets + 15-60mm slider), adjustable spacing
// - Print scope: whole school, class/section groups, search, or
//   individually ticked students; copies per student for spares
// - Optional name/class/UID caption under each QR so 500 stickers
//   remain matchable to the right card; optional cut guides
// - QR encodes the student UUID - exactly what the gate scanner reads
//   (same payload as the ID card generator)
// - Prints through a persistent hidden iframe (dynamically created
//   iframes make Chrome print the whole dashboard - see print-qr)

import { useState, useEffect, useMemo, useRef } from 'react'
import Link from 'next/link'
import { createClient } from '@/utils/supabase/client'
import {
  ArrowLeft, Printer, QrCode, Loader2, Info, AlertCircle, Search,
} from 'lucide-react'

interface St {
  id: string
  full_name: string
  student_uid: string | null
  class_name: string | null
  section: string | null
}

interface StickerOpts {
  qrMm: number
  gapMm: number
  copies: number
  showName: boolean
  showClass: boolean
  showUid: boolean
  cutGuides: boolean
}

const SIZE_PRESETS = [
  { label: 'Small', mm: 20 },
  { label: 'Medium', mm: 25 },
  { label: 'Large', mm: 32 },
]

// A4 portrait, 6mm printer margin on each side.
const PAGE_W = 210 - 12
const PAGE_H = 297 - 12

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string))
}

function fontSizes(qrMm: number) {
  const name = qrMm >= 30 ? 7 : qrMm >= 22 ? 6 : 5
  return { name, sub: Math.max(4, name - 1.4) }
}

// Cell geometry in mm (pt -> mm is ~0.353; labels get a little air).
function geometry(o: StickerOpts) {
  const fs = fontSizes(o.qrMm)
  const labelH =
    (o.showName ? fs.name * 0.42 + 0.8 : 0) +
    (o.showClass || o.showUid ? fs.sub * 0.42 + 0.6 : 0)
  const cellW = o.qrMm + 2
  const cellH = o.qrMm + 2 + labelH
  const cols = Math.max(1, Math.floor((PAGE_W + o.gapMm) / (cellW + o.gapMm)))
  const rows = Math.max(1, Math.floor((PAGE_H + o.gapMm) / (cellH + o.gapMm)))
  return { cellW, cellH, cols, rows, perPage: cols * rows, fs }
}

function buildDoc(students: St[], qr: Record<string, string>, o: StickerOpts): string {
  const { cellW, fs } = geometry(o)

  const cell = (s: St) => {
    const cls = s.class_name ? `${s.class_name}${s.section ? '-' + s.section : ''}` : ''
    const subParts: string[] = []
    if (o.showUid && s.student_uid) subParts.push(esc(s.student_uid))
    if (o.showClass && cls) subParts.push(esc(cls))
    return `<div class="cell">
      ${qr[s.id] ? `<img class="qr" src="${qr[s.id]}"/>` : '<div class="qr"></div>'}
      ${o.showName ? `<div class="nm">${esc(s.full_name)}</div>` : ''}
      ${subParts.length ? `<div class="sub">${subParts.join(' &middot; ')}</div>` : ''}
    </div>`
  }

  const cells: string[] = []
  for (const s of students) {
    for (let c = 0; c < o.copies; c++) cells.push(cell(s))
  }

  return `<!doctype html><html><head><meta charset="utf-8"><title>QR Stickers</title><style>
@page { size: A4 portrait; margin: 6mm; }
* { margin:0; padding:0; box-sizing:border-box; font-family: Arial, Helvetica, sans-serif;
    -webkit-print-color-adjust:exact; print-color-adjust:exact; }
body { background:#fff; }
.sheet {
  display:grid;
  grid-template-columns: repeat(auto-fill, ${cellW}mm);
  gap: ${o.gapMm}mm;
  justify-content:flex-start; align-content:start;
}
.cell {
  width:${cellW}mm; padding:1mm;
  display:flex; flex-direction:column; align-items:center;
  break-inside:avoid; page-break-inside:avoid;
  ${o.cutGuides ? 'outline:0.5pt dashed #94a3b8;' : ''}
}
.qr  { width:${o.qrMm}mm; height:${o.qrMm}mm; display:block; }
.nm  { font-size:${fs.name}pt; font-weight:bold; color:#0f172a; line-height:1.2; margin-top:0.6mm;
       max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-align:center; }
.sub { font-size:${fs.sub}pt; color:#475569; line-height:1.2;
       max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-align:center; }
</style></head><body><div class="sheet">${cells.join('')}</div></body></html>`
}

export default function QrStickersPage() {
  const [students, setStudents] = useState<St[]>([])
  const [classes, setClasses] = useState<{ name: string; section: string | null }[]>([])
  const [selClass, setSelClass] = useState('')
  const [selSection, setSelSection] = useState('')
  const [search, setSearch] = useState('')
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [opts, setOpts] = useState<StickerOpts>({
    qrMm: 25, gapMm: 4, copies: 1,
    showName: true, showClass: true, showUid: false, cutGuides: true,
  })
  const [loading, setLoading] = useState(true)
  const [building, setBuilding] = useState(false)
  const [doc, setDoc] = useState('')
  const [error, setError] = useState('')

  const frameRef = useRef<HTMLIFrameElement>(null)
  const qrCache = useRef<{ px: number; map: Record<string, string> }>({ px: 0, map: {} })

  // ---- load roster -----------------------------------------------
  useEffect(() => {
    (async () => {
      const supabase = createClient()
      const { data: profile } = await supabase.from('profiles').select('school_id').single()
      if (!profile?.school_id) { setLoading(false); return }

      const [stuRes, clsRes] = await Promise.all([
        supabase.from('students')
          .select('id, full_name, student_uid, classes(name, section)')
          .eq('school_id', profile.school_id).eq('is_active', true).order('full_name'),
        supabase.from('classes').select('name, section').eq('school_id', profile.school_id).order('name'),
      ])

      const list: St[] = ((stuRes.data as unknown as Array<{
        id: string; full_name: string; student_uid: string | null
        classes: { name: string; section: string | null } | { name: string; section: string | null }[] | null
      }>) || []).map((s) => {
        const c = Array.isArray(s.classes) ? s.classes[0] : s.classes
        return {
          id: s.id, full_name: s.full_name, student_uid: s.student_uid,
          class_name: c?.name ?? null, section: c?.section ?? null,
        }
      })
      setStudents(list)
      setClasses((clsRes.data as { name: string; section: string | null }[]) || [])
      setLoading(false)
    })()
  }, [])

  // ---- filter + selection -----------------------------------------
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return students.filter((s) =>
      (!selClass || s.class_name === selClass) &&
      (!selSection || s.section === selSection) &&
      (!q || s.full_name.toLowerCase().includes(q) || (s.student_uid ?? '').toLowerCase().includes(q)),
    )
  }, [students, selClass, selSection, search])

  // Changing the class/section scope re-selects everyone in scope;
  // the search box only narrows the visible list, not the ticks.
  useEffect(() => {
    setChecked(new Set(students
      .filter((s) => (!selClass || s.class_name === selClass) && (!selSection || s.section === selSection))
      .map((s) => s.id)))
  }, [students, selClass, selSection])

  const selected = useMemo(() => students.filter((s) => checked.has(s.id)), [students, checked])
  const allFilteredChecked = filtered.length > 0 && filtered.every((s) => checked.has(s.id))

  function toggleOne(id: string) {
    setChecked((old) => {
      const next = new Set(old)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAllFiltered() {
    setChecked((old) => {
      const next = new Set(old)
      if (allFilteredChecked) filtered.forEach((s) => next.delete(s.id))
      else filtered.forEach((s) => next.add(s.id))
      return next
    })
  }

  // ---- build the print document (debounced) ------------------------
  useEffect(() => {
    if (loading) return
    if (selected.length === 0) { setDoc(''); return }
    const timer = setTimeout(async () => {
      setBuilding(true)
      setError('')
      try {
        // ~8 px/mm keeps modules crisp at 200+ dpi without huge pages.
        const px = Math.max(160, Math.round(opts.qrMm * 8))
        if (qrCache.current.px !== px) qrCache.current = { px, map: {} }
        const QRCode = (await import('qrcode')).default
        for (const s of selected) {
          if (!qrCache.current.map[s.id]) {
            qrCache.current.map[s.id] = await QRCode.toDataURL(s.id, {
              width: px, margin: 0, errorCorrectionLevel: 'M',
            })
          }
        }
        setDoc(buildDoc(selected, qrCache.current.map, opts))
      } catch {
        setError('Could not generate QR codes')
      }
      setBuilding(false)
    }, 350)
    return () => clearTimeout(timer)
  }, [selected, opts, loading])

  function handlePrint() {
    const frame = frameRef.current
    if (!frame || !doc) return
    setError('')
    try { frame.contentWindow?.focus(); frame.contentWindow?.print() }
    catch { setError('Could not open the print dialog') }
  }

  const classNames = Array.from(new Set(classes.map((c) => c.name))).sort()
  const sections = Array.from(new Set(classes.filter((c) => c.name === selClass && c.section).map((c) => c.section as string))).sort()
  const geo = geometry(opts)
  const totalStickers = selected.length * opts.copies
  const pageCount = totalStickers === 0 ? 0 : Math.ceil(totalStickers / geo.perPage)

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto">
        <div className="h-8 w-56 bg-slate-100 rounded animate-pulse mb-6" />
        <div className="card h-64 animate-pulse bg-slate-50" />
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 mb-5 flex-wrap">
        <div className="flex items-center gap-3">
          <Link href="/dashboard/attendance" className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 text-slate-500">
            <ArrowLeft size={18} />
          </Link>
          <div>
            <h1 className="text-xl font-bold text-slate-900">QR Stickers</h1>
            <p className="text-slate-400 text-xs mt-0.5">
              A4 sticker paper · {geo.cols} × {geo.rows} = {geo.perPage} per sheet at {opts.qrMm}mm
            </p>
          </div>
        </div>
        <button onClick={handlePrint} disabled={building || totalStickers === 0}
          className="btn-primary flex items-center gap-2 text-sm">
          {building
            ? <><Loader2 size={15} className="animate-spin" /> Preparing…</>
            : <><Printer size={15} /> Print {totalStickers} sticker{totalStickers === 1 ? '' : 's'} ({pageCount} page{pageCount === 1 ? '' : 's'})</>}
        </button>
      </div>

      {/* Sticker options */}
      <div className="card mb-4">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
          <div>
            <label className="label">Sticker size</label>
            <div className="flex items-center gap-2">
              {SIZE_PRESETS.map((p) => (
                <button key={p.mm}
                  onClick={() => setOpts((o) => ({ ...o, qrMm: p.mm }))}
                  className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                    opts.qrMm === p.mm
                      ? 'bg-brand-50 border-brand-300 text-brand-700'
                      : 'border-slate-200 text-slate-500 hover:border-slate-300'
                  }`}>
                  {p.label} {p.mm}mm
                </button>
              ))}
              <input
                type="range" min={15} max={60} step={1} value={opts.qrMm}
                onChange={(e) => setOpts((o) => ({ ...o, qrMm: Number(e.target.value) }))}
                className="w-32 accent-brand-600"
              />
              <span className="text-xs font-mono text-slate-600 w-12">{opts.qrMm} mm</span>
            </div>
          </div>
          <div>
            <label className="label">Spacing</label>
            <div className="flex items-center gap-2">
              <input
                type="range" min={2} max={10} step={1} value={opts.gapMm}
                onChange={(e) => setOpts((o) => ({ ...o, gapMm: Number(e.target.value) }))}
                className="w-24 accent-brand-600"
              />
              <span className="text-xs font-mono text-slate-600 w-10">{opts.gapMm} mm</span>
            </div>
          </div>
          <div>
            <label className="label">Copies each</label>
            <select className="input !py-1.5 w-20" value={opts.copies}
              onChange={(e) => setOpts((o) => ({ ...o, copies: Number(e.target.value) }))}>
              {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 mt-4 pt-3 border-t border-slate-50 text-sm text-slate-600">
          {([
            ['showName', 'Student name'],
            ['showClass', 'Class'],
            ['showUid', 'Student ID'],
            ['cutGuides', 'Cut guides'],
          ] as [keyof StickerOpts, string][]).map(([key, label]) => (
            <label key={key} className="flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" className="w-3.5 h-3.5 accent-brand-600"
                checked={opts[key] as boolean}
                onChange={(e) => setOpts((o) => ({ ...o, [key]: e.target.checked }))} />
              {label}
            </label>
          ))}
          <span className="text-xs text-slate-400 ml-auto">
            Captions help match each sticker to the right ID card
          </span>
        </div>
      </div>

      {/* Scope: class / section / search + individual ticks */}
      <div className="card mb-4">
        <div className="flex flex-wrap items-end gap-3 mb-3">
          <div className="w-40">
            <label className="label">Class</label>
            <select className="input" value={selClass}
              onChange={(e) => { setSelClass(e.target.value); setSelSection('') }}>
              <option value="">Whole school</option>
              {classNames.map((n) => <option key={n} value={n}>Class {n}</option>)}
            </select>
          </div>
          <div className="w-40">
            <label className="label">Section</label>
            <select className="input" value={selSection} disabled={!selClass || sections.length === 0}
              onChange={(e) => setSelSection(e.target.value)}>
              <option value="">All sections</option>
              {sections.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="flex-1 min-w-40">
            <label className="label">Find a student</label>
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-300" />
              <input className="input pl-8" value={search} placeholder="Name or ID…"
                onChange={(e) => setSearch(e.target.value)} />
            </div>
          </div>
          <p className="text-xs text-slate-400 self-center whitespace-nowrap">
            {selected.length} of {students.length} selected
          </p>
        </div>

        <div className="border border-slate-100 rounded-lg max-h-56 overflow-y-auto">
          <label className="flex items-center gap-2.5 px-3 py-2 border-b border-slate-100 bg-slate-50 sticky top-0 cursor-pointer text-xs font-medium text-slate-600">
            <input type="checkbox" className="w-3.5 h-3.5 accent-brand-600"
              checked={allFilteredChecked} onChange={toggleAllFiltered} />
            {allFilteredChecked ? 'Unselect' : 'Select'} all {filtered.length} shown
          </label>
          {filtered.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-400">No students match.</p>
          ) : (
            filtered.map((s) => (
              <label key={s.id} className="flex items-center gap-2.5 px-3 py-1.5 border-b border-slate-50 last:border-0 cursor-pointer hover:bg-slate-50 text-sm">
                <input type="checkbox" className="w-3.5 h-3.5 accent-brand-600"
                  checked={checked.has(s.id)} onChange={() => toggleOne(s.id)} />
                <span className="text-slate-800">{s.full_name}</span>
                <span className="text-xs text-slate-400 ml-auto">
                  {s.class_name ? `${s.class_name}${s.section ? '-' + s.section : ''}` : ''}
                  {s.student_uid ? ` · ${s.student_uid}` : ''}
                </span>
              </label>
            ))
          )}
        </div>
      </div>

      {/* Print-settings note */}
      <div className="flex items-start gap-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5 mb-4">
        <Info size={14} className="shrink-0 mt-0.5 text-amber-500" />
        <p>
          Load A4 sticker/label paper, then in the print dialog set <b>Scale = 100%</b> and{' '}
          <b>Margins = None / Minimum</b>. Do <b>not</b> enable &ldquo;Fit to page&rdquo; — it changes the
          sticker size. Cut along the dashed guides and stick one QR on each student&apos;s ID card.
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
          <QrCode size={13} /> Preview — printed output
        </div>
        {totalStickers === 0 ? (
          <div className="py-16 text-center text-slate-400 text-sm">Select at least one student.</div>
        ) : (
          <iframe
            ref={frameRef}
            title="qr-sticker-print"
            srcDoc={doc}
            className="w-full bg-slate-100"
            style={{ height: 560, border: 'none' }}
          />
        )}
      </div>
    </div>
  )
}
