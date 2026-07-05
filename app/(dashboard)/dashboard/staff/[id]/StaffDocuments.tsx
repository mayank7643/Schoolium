'use client'

// FILE: app/(dashboard)/dashboard/staff/[id]/StaffDocuments.tsx
//
// HR document registry for one staff member (chat17 Module 6).
// Rendered on the staff detail page. Admin/principal can upload,
// view and delete; the staff member themself gets a read-only list
// (canManage=false). Files live in the private staff-docs bucket at
// {school_id}/{staff_id}/{doc_type}-<ts>.<ext>; the bucket enforces
// the 500 KB / mime-type limits server-side (chat17b), the UI
// validates first for a friendly message. Viewing always goes
// through short-lived signed URLs - never public links.
// Delete order: registry row first (authoritative), then a
// best-effort storage removal.

import { useState, useEffect, useCallback, useRef } from 'react'
import { createClient } from '@/utils/supabase/client'
import { FileText, Upload, Trash2, Eye } from 'lucide-react'
import type { StaffDocument, StaffDocType } from '@/types'
import {
  MAX_UPLOAD_KB, ALLOWED_UPLOAD_LABEL, UPLOAD_ACCEPT_ATTR, validateUpload,
} from '@/app/lib/uploadLimits'

const DOC_TYPES: { value: StaffDocType; label: string }[] = [
  { value: 'aadhaar',            label: 'Aadhaar Card' },
  { value: 'pan',                label: 'PAN Card' },
  { value: 'resume',             label: 'Resume' },
  { value: 'qualification',      label: 'Qualification Certificate' },
  { value: 'appointment_letter', label: 'Appointment Letter' },
  { value: 'other',              label: 'Other' },
]

const TYPE_LABEL: Record<string, string> = Object.fromEntries(
  DOC_TYPES.map(d => [d.value, d.label])
)

export default function StaffDocuments({
  staffId,
  schoolId,
  canManage,
}: {
  staffId: string
  schoolId: string
  canManage: boolean
}) {
  const [docs, setDocs]         = useState<StaffDocument[]>([])
  const [loading, setLoading]   = useState(true)
  const [docType, setDocType]   = useState<StaffDocType>('aadhaar')
  const [title, setTitle]       = useState('')
  const [file, setFile]         = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError]       = useState('')
  const [busyId, setBusyId]     = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const fetchDocs = useCallback(async () => {
    const supabase = createClient()
    const { data } = await supabase
      .from('staff_documents')
      .select('*')
      .eq('staff_id', staffId)
      .order('created_at', { ascending: false })
    setDocs((data ?? []) as StaffDocument[])
    setLoading(false)
  }, [staffId])

  useEffect(() => { fetchDocs() }, [fetchDocs])

  function handleFilePick(f: File | null) {
    setError('')
    if (!f) { setFile(null); return }
    const problem = validateUpload(f)
    if (problem) {
      setError(problem)
      if (fileInputRef.current) fileInputRef.current.value = ''
      return
    }
    setFile(f)
  }

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault()
    if (!file) { setError('Choose a file first'); return }

    setUploading(true)
    setError('')
    const supabase = createClient()

    const ext = file.name.split('.').pop()?.toLowerCase() ?? 'pdf'
    const path = `${schoolId}/${staffId}/${docType}-${Date.now()}.${ext}`

    const { error: upError } = await supabase.storage
      .from('staff-docs')
      .upload(path, file, { contentType: file.type, upsert: false })

    if (upError) {
      setError(
        /exceeded|too large|payload/i.test(upError.message)
          ? `Upload rejected - files must be under ${MAX_UPLOAD_KB} KB`
          : upError.message
      )
      setUploading(false)
      return
    }

    const { error: insError } = await supabase.from('staff_documents').insert({
      school_id: schoolId,
      staff_id: staffId,
      doc_type: docType,
      title: title.trim() || TYPE_LABEL[docType],
      file_path: path,
      file_size: file.size,
    })

    if (insError) {
      setError(insError.message)
      // roll back the orphan upload
      await supabase.storage.from('staff-docs').remove([path]).catch(() => {})
    } else {
      setTitle('')
      setFile(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
      await fetchDocs()
    }
    setUploading(false)
  }

  async function handleView(doc: StaffDocument) {
    const supabase = createClient()
    const { data } = await supabase.storage
      .from('staff-docs')
      .createSignedUrl(doc.file_path, 300)
    if (data?.signedUrl) window.open(data.signedUrl, '_blank')
  }

  async function handleDelete(doc: StaffDocument) {
    if (!window.confirm(`Delete "${doc.title}"? This cannot be undone.`)) return
    setBusyId(doc.id)
    setError('')
    const supabase = createClient()

    const { error: delError } = await supabase
      .from('staff_documents')
      .delete()
      .eq('id', doc.id)

    if (delError) {
      setError(delError.message)
    } else {
      await supabase.storage.from('staff-docs').remove([doc.file_path]).catch(() => {})
      await fetchDocs()
    }
    setBusyId('')
  }

  return (
    <div className="card">
      <h2 className="font-semibold text-slate-800 mb-3">Documents</h2>

      {/* List */}
      {loading ? (
        <div className="flex flex-col gap-2 mb-1">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="h-10 bg-slate-100 rounded-lg animate-pulse" />
          ))}
        </div>
      ) : docs.length > 0 ? (
        <div className="flex flex-col divide-y divide-slate-50 mb-1">
          {docs.map(d => (
            <div key={d.id} className="flex items-center gap-3 py-2.5">
              <FileText size={16} className="text-slate-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-slate-800 truncate">{d.title}</p>
                <p className="text-xs text-slate-400">
                  {TYPE_LABEL[d.doc_type] ?? d.doc_type}
                  {d.file_size ? ` · ${Math.round(d.file_size / 1024)} KB` : ''}
                  {' · '}{new Date(d.created_at).toLocaleDateString('en-IN')}
                </p>
              </div>
              <button onClick={() => handleView(d)} title="View"
                className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 hover:text-brand-600 hover:bg-slate-50">
                <Eye size={15} />
              </button>
              {canManage && (
                <button onClick={() => handleDelete(d)} disabled={busyId === d.id} title="Delete"
                  className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-50">
                  <Trash2 size={15} />
                </button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-slate-400 mb-1">
          {canManage ? 'No documents uploaded yet.' : 'No documents on file.'}
        </p>
      )}

      {/* Upload (managers only) */}
      {canManage && (
        <form onSubmit={handleUpload} className="border-t border-slate-100 pt-4 mt-3 flex flex-col gap-3">
          <p className="text-xs font-medium text-slate-500 flex items-center gap-1.5">
            <Upload size={13} /> Upload document
          </p>
          <div className="grid grid-cols-2 gap-3">
            <select className="input" value={docType}
              onChange={e => setDocType(e.target.value as StaffDocType)}>
              {DOC_TYPES.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
            </select>
            <input type="text" className="input" placeholder="Title (optional)"
              value={title} onChange={e => setTitle(e.target.value)} />
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept={UPLOAD_ACCEPT_ATTR}
            className="input"
            onChange={e => handleFilePick(e.target.files?.[0] ?? null)}
          />
          <p className="text-xs text-slate-400 -mt-1.5">
            {ALLOWED_UPLOAD_LABEL}, max {MAX_UPLOAD_KB} KB
          </p>
          {error && <p className="text-xs text-red-500">{error}</p>}
          <button type="submit" disabled={uploading || !file}
            className="btn-primary text-sm self-start px-5 disabled:opacity-50">
            {uploading ? 'Uploading...' : 'Upload'}
          </button>
        </form>
      )}
      {!canManage && error && <p className="text-xs text-red-500 mt-2">{error}</p>}
    </div>
  )
}
