'use client'

// FILE: app/(dashboard)/dashboard/alerts/import/page.tsx
//
// CSV student import with DIFF PREVIEW (chat21, blueprint section 9):
//   upload -> parse -> normalise phones -> validate -> diff preview
//   ("32 new / 4 removed / 7 changed") -> confirm -> apply.
//
// The diff preview is not a nicety: without it a re-upload with a
// changed id column silently duplicates 2,000 students and messages
// every parent twice. Removed students become is_active=false -
// NEVER hard delete. Batches are staged in import_batches/import_rows
// for audit.
//
// Required columns: student_id, student_name, class, guardian_phone
// Optional:         guardian_name, guardian_email, guardian2_phone

import { useState } from 'react'
import { createClient } from '@/utils/supabase/client'
import Link from 'next/link'
import { ArrowLeft, Upload, CheckCircle2, AlertTriangle, FileText } from 'lucide-react'

// ---- tiny CSV parser (quotes, commas, CRLF) -------------------------
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else inQuotes = false
      } else field += c
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      row.push(field); field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.some((f) => f.trim() !== '')) rows.push(row)
      row = []
    } else field += c
  }
  row.push(field)
  if (row.some((f) => f.trim() !== '')) rows.push(row)
  return rows
}

// Mirror of public.normalize_phone_e164 (+91 default).
function normalizePhone(raw: string | undefined): string | null {
  let v = (raw ?? '').replace(/[^0-9+]/g, '')
  if (!v || v === '+') return null
  if (v.startsWith('+')) v = '+' + v.slice(1).replace(/[^0-9]/g, '')
  else {
    v = v.replace(/^0+/, '')
    if (v.length === 10) v = '+91' + v
    else if (v.length === 12 && v.startsWith('91')) v = '+' + v
    else v = '+' + v
  }
  return /^\+[1-9][0-9]{7,14}$/.test(v) ? v : null
}

interface CsvRow {
  rowNumber: number
  externalRef: string
  name: string
  classLabel: string
  guardianName: string
  phone: string | null
  email: string | null
  phone2: string | null
  errors: string[]
  action: 'new' | 'update' | 'unchanged' | 'invalid'
  studentId?: string // existing student id for updates
}

interface ExistingStudent {
  id: string
  external_ref: string | null
  full_name: string
  class_label: string | null
  parent_phone: string | null
  is_active: boolean
}

type Step = 'upload' | 'preview' | 'applying' | 'done'

const HEADER_ALIASES: Record<string, string> = {
  student_id: 'student_id', studentid: 'student_id', id: 'student_id', admission_no: 'student_id',
  student_name: 'student_name', name: 'student_name',
  class: 'class', class_label: 'class', class_section: 'class',
  guardian_phone: 'guardian_phone', parent_phone: 'guardian_phone', phone: 'guardian_phone', mobile: 'guardian_phone',
  guardian_name: 'guardian_name', parent_name: 'guardian_name',
  guardian_email: 'guardian_email', parent_email: 'guardian_email', email: 'guardian_email',
  guardian2_phone: 'guardian2_phone', parent2_phone: 'guardian2_phone',
}

export default function ImportStudentsPage() {
  const [step, setStep] = useState<Step>('upload')
  const [fileName, setFileName] = useState('')
  const [rows, setRows] = useState<CsvRow[]>([])
  const [removed, setRemoved] = useState<ExistingStudent[]>([])
  const [error, setError] = useState('')
  const [progress, setProgress] = useState('')
  const [applied, setApplied] = useState({ inserted: 0, updated: 0, deactivated: 0 })

  async function handleFile(file: File) {
    setError('')
    setFileName(file.name)
    const text = await file.text()
    const parsed = parseCsv(text)
    if (parsed.length < 2) { setError('The file has no data rows.'); return }

    const header = parsed[0].map((h) => HEADER_ALIASES[h.trim().toLowerCase().replace(/\s+/g, '_')] ?? '')
    const need = ['student_id', 'student_name', 'class', 'guardian_phone']
    const missing = need.filter((n) => !header.includes(n))
    if (missing.length) { setError(`Missing required columns: ${missing.join(', ')}`); return }

    const col = (name: string) => header.indexOf(name)
    const seen = new Set<string>()
    const csvRows: CsvRow[] = parsed.slice(1).map((raw, i) => {
      const get = (name: string) => (col(name) >= 0 ? (raw[col(name)] ?? '').trim() : '')
      const externalRef = get('student_id')
      const name = get('student_name')
      const phone = normalizePhone(get('guardian_phone'))
      const emailRaw = get('guardian_email').toLowerCase()
      const email = emailRaw && emailRaw.includes('@') ? emailRaw : null
      const errors: string[] = []
      if (!externalRef) errors.push('student_id missing')
      else if (seen.has(externalRef)) errors.push('duplicate student_id in file')
      if (!name) errors.push('student_name missing')
      if (!phone && !email) errors.push('no valid phone or email')
      if (externalRef) seen.add(externalRef)
      return {
        rowNumber: i + 2,
        externalRef,
        name,
        classLabel: get('class'),
        guardianName: get('guardian_name'),
        phone,
        email,
        phone2: normalizePhone(get('guardian2_phone')),
        errors,
        action: errors.length ? ('invalid' as const) : ('new' as const),
      }
    })

    // Diff against the current roster.
    const supabase = createClient()
    const { data: existingRaw, error: exErr } = await supabase
      .from('students')
      .select('id, external_ref, full_name, class_label, parent_phone, is_active')
    if (exErr) { setError(exErr.message); return }
    const existing = (existingRaw as ExistingStudent[]) || []
    const byRef = new Map(existing.filter((s) => s.external_ref).map((s) => [s.external_ref as string, s]))

    const inFile = new Set<string>()
    for (const r of csvRows) {
      if (r.action === 'invalid') continue
      inFile.add(r.externalRef)
      const ex = byRef.get(r.externalRef)
      if (!ex) { r.action = 'new'; continue }
      r.studentId = ex.id
      const changed =
        ex.full_name !== r.name ||
        (ex.class_label ?? '') !== r.classLabel ||
        normalizePhone(ex.parent_phone ?? '') !== r.phone ||
        !ex.is_active
      r.action = changed ? 'update' : 'unchanged'
    }
    setRemoved(existing.filter((s) => s.is_active && s.external_ref && !inFile.has(s.external_ref)))
    setRows(csvRows)
    setStep('preview')
  }

  const counts = {
    new: rows.filter((r) => r.action === 'new').length,
    update: rows.filter((r) => r.action === 'update').length,
    unchanged: rows.filter((r) => r.action === 'unchanged').length,
    invalid: rows.filter((r) => r.action === 'invalid').length,
  }

  async function apply() {
    setStep('applying')
    setError('')
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    const { data: profile } = await supabase
      .from('profiles').select('school_id').eq('id', user!.id).single()
    const schoolId = profile?.school_id as string

    try {
      // Stage the batch for audit.
      setProgress('Staging batch…')
      const { data: batch, error: bErr } = await supabase
        .from('import_batches')
        .insert({
          school_id: schoolId, uploaded_by: user!.id, filename: fileName, status: 'validated',
          summary: { new: counts.new, changed: counts.update, unchanged: counts.unchanged, invalid: counts.invalid, removed: removed.length },
        })
        .select('id').single()
      if (bErr) throw bErr
      const batchId = (batch as { id: string }).id

      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500).map((r) => ({
          batch_id: batchId, row_number: r.rowNumber, external_ref: r.externalRef || null,
          student_name: r.name || null, class_label: r.classLabel || null,
          guardian_name: r.guardianName || null, guardian_phone: r.phone,
          guardian_email: r.email, guardian2_phone: r.phone2,
          validation_errors: r.errors, action: r.action,
        }))
        const { error: rErr } = await supabase.from('import_rows').insert(chunk)
        if (rErr) throw rErr
      }

      // Guardian lookup: phone -> guardian_id for the whole school.
      setProgress('Loading guardian directory…')
      const { data: cmRaw } = await supabase
        .from('contact_methods')
        .select('guardian_id, value, guardians!inner(school_id)')
      const phoneToGuardian = new Map<string, string>()
      for (const cm of (cmRaw as unknown as { guardian_id: string; value: string }[]) || []) {
        if (!phoneToGuardian.has(cm.value)) phoneToGuardian.set(cm.value, cm.guardian_id)
      }

      const ensureGuardian = async (name: string, phone: string | null, email: string | null): Promise<string> => {
        if (phone && phoneToGuardian.has(phone)) return phoneToGuardian.get(phone)!
        const { data: g, error: gErr } = await supabase
          .from('guardians').insert({ school_id: schoolId, full_name: name || null }).select('id').single()
        if (gErr) throw gErr
        const gid = (g as { id: string }).id
        const contacts: { guardian_id: string; channel: string; value: string }[] = []
        if (phone) {
          contacts.push({ guardian_id: gid, channel: 'whatsapp', value: phone })
          contacts.push({ guardian_id: gid, channel: 'sms', value: phone })
          phoneToGuardian.set(phone, gid)
        }
        if (email) contacts.push({ guardian_id: gid, channel: 'email', value: email })
        if (contacts.length) {
          const { error: cErr } = await supabase.from('contact_methods').insert(contacts)
          if (cErr) throw cErr
        }
        return gid
      }

      const linkGuardians = async (studentId: string, r: CsvRow) => {
        const links: { student_id: string; guardian_id: string; relation: string; is_primary: boolean }[] = []
        if (r.phone || r.email) {
          const gid = await ensureGuardian(r.guardianName, r.phone, r.email)
          links.push({ student_id: studentId, guardian_id: gid, relation: 'parent', is_primary: true })
        }
        if (r.phone2) {
          const gid2 = await ensureGuardian(r.guardianName, r.phone2, null)
          links.push({ student_id: studentId, guardian_id: gid2, relation: 'parent', is_primary: false })
        }
        if (links.length) {
          const { error: lErr } = await supabase
            .from('student_guardians')
            .upsert(links, { onConflict: 'student_id,guardian_id', ignoreDuplicates: true })
          if (lErr) throw lErr
        }
      }

      const result = { inserted: 0, updated: 0, deactivated: 0 }

      const newRows = rows.filter((r) => r.action === 'new')
      for (let i = 0; i < newRows.length; i++) {
        const r = newRows[i]
        setProgress(`Adding students… ${i + 1}/${newRows.length}`)
        const { data: s, error: sErr } = await supabase
          .from('students')
          .insert({
            school_id: schoolId, full_name: r.name, external_ref: r.externalRef,
            class_label: r.classLabel || null, parent_name: r.guardianName || null,
            parent_phone: r.phone, parent_email: r.email, is_active: true,
          })
          .select('id').single()
        if (sErr) throw sErr
        await linkGuardians((s as { id: string }).id, r)
        result.inserted++
      }

      const updateRows = rows.filter((r) => r.action === 'update' && r.studentId)
      for (let i = 0; i < updateRows.length; i++) {
        const r = updateRows[i]
        setProgress(`Updating students… ${i + 1}/${updateRows.length}`)
        const { error: uErr } = await supabase
          .from('students')
          .update({
            full_name: r.name, class_label: r.classLabel || null,
            parent_name: r.guardianName || null, parent_phone: r.phone,
            parent_email: r.email, is_active: true,
          })
          .eq('id', r.studentId!)
        if (uErr) throw uErr
        await linkGuardians(r.studentId!, r)
        result.updated++
      }

      if (removed.length) {
        setProgress(`Deactivating ${removed.length} students…`)
        const { error: dErr } = await supabase
          .from('students')
          .update({ is_active: false })
          .in('id', removed.map((s) => s.id))
        if (dErr) throw dErr
        result.deactivated = removed.length
      }

      await supabase.from('import_batches')
        .update({ status: 'applied', applied_at: new Date().toISOString() })
        .eq('id', batchId)

      setApplied(result)
      setStep('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStep('preview')
    }
  }

  return (
    <div className="max-w-4xl mx-auto">
      <Link href="/dashboard/alerts" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 mb-4">
        <ArrowLeft size={15} /> Back to Alerts
      </Link>
      <h1 className="text-xl font-bold text-slate-900 mb-1">Import students</h1>
      <p className="text-sm text-slate-500 mb-6">
        One CSV from your register or ERP. Required columns:{' '}
        <code className="text-xs bg-slate-100 px-1 py-0.5 rounded">student_id, student_name, class, guardian_phone</code>
        {' '}— optional <code className="text-xs bg-slate-100 px-1 py-0.5 rounded">guardian_name, guardian_email, guardian2_phone</code>
      </p>

      {error && (
        <div className="card mb-4 border-l-4 border-red-500 text-sm text-red-700 flex items-center gap-2">
          <AlertTriangle size={16} /> {error}
        </div>
      )}

      {step === 'upload' && (
        <label className="card flex flex-col items-center justify-center py-16 border-2 border-dashed border-slate-200 cursor-pointer hover:border-brand-300 transition-colors">
          <Upload size={28} className="text-slate-300 mb-3" />
          <span className="text-sm font-medium text-slate-700">Choose a CSV file</span>
          <span className="text-xs text-slate-400 mt-1">Nothing changes until you confirm the diff preview</span>
          <input
            type="file" accept=".csv,text/csv" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f) }}
          />
        </label>
      )}

      {(step === 'preview' || step === 'applying') && (
        <>
          {/* THE diff preview */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-4">
            <div className="stat-card"><p className="text-xs text-slate-500">New</p><p className="text-xl font-bold text-green-700">{counts.new}</p></div>
            <div className="stat-card"><p className="text-xs text-slate-500">Changed</p><p className="text-xl font-bold text-blue-700">{counts.update}</p></div>
            <div className="stat-card"><p className="text-xs text-slate-500">Unchanged</p><p className="text-xl font-bold text-slate-700">{counts.unchanged}</p></div>
            <div className="stat-card"><p className="text-xs text-slate-500">Removed</p><p className="text-xl font-bold text-yellow-600">{removed.length}</p></div>
            <div className="stat-card"><p className="text-xs text-slate-500">Invalid</p><p className={`text-xl font-bold ${counts.invalid ? 'text-red-600' : 'text-slate-700'}`}>{counts.invalid}</p></div>
          </div>

          {counts.invalid > 0 && (
            <div className="card mb-4">
              <h2 className="text-sm font-semibold text-red-700 mb-2">Invalid rows (skipped)</h2>
              <ul className="text-xs text-slate-600 space-y-1 max-h-40 overflow-y-auto">
                {rows.filter((r) => r.action === 'invalid').slice(0, 50).map((r) => (
                  <li key={r.rowNumber}>Row {r.rowNumber}: {r.errors.join('; ')}</li>
                ))}
              </ul>
            </div>
          )}

          {removed.length > 0 && (
            <div className="card mb-4">
              <h2 className="text-sm font-semibold text-yellow-700 mb-2">
                Will be DEACTIVATED (in the roster, missing from this file)
              </h2>
              <p className="text-xs text-slate-500 mb-2">
                Never deleted — attendance history stays. Re-upload them to reactivate.
              </p>
              <ul className="text-xs text-slate-600 space-y-1 max-h-40 overflow-y-auto">
                {removed.slice(0, 50).map((s) => (
                  <li key={s.id}>{s.full_name} ({s.external_ref})</li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              onClick={() => void apply()}
              disabled={step === 'applying' || (counts.new + counts.update === 0 && removed.length === 0)}
              className="btn-primary flex items-center gap-2 disabled:opacity-50"
            >
              <CheckCircle2 size={15} />
              {step === 'applying' ? progress || 'Applying…' : `Confirm: ${counts.new} new · ${counts.update} changed · ${removed.length} removed`}
            </button>
            <button
              onClick={() => { setStep('upload'); setRows([]); setRemoved([]) }}
              disabled={step === 'applying'}
              className="btn-secondary"
            >
              Cancel
            </button>
          </div>
        </>
      )}

      {step === 'done' && (
        <div className="card text-center py-12">
          <CheckCircle2 size={36} className="text-green-600 mx-auto mb-3" />
          <h2 className="text-lg font-bold text-slate-900">Import applied</h2>
          <p className="text-sm text-slate-500 mt-1">
            {applied.inserted} added · {applied.updated} updated · {applied.deactivated} deactivated
          </p>
          <div className="flex items-center justify-center gap-2 mt-6">
            <Link href="/dashboard/students" className="btn-secondary flex items-center gap-1.5">
              <FileText size={14} /> View students
            </Link>
            <button onClick={() => { setStep('upload'); setRows([]); setRemoved([]) }} className="btn-primary">
              Import another file
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
