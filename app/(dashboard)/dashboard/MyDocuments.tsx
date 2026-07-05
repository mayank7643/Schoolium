'use client'

// FILE: app/(dashboard)/dashboard/MyDocuments.tsx
//
// Read-only "My documents" card on the staff personal dashboard
// (chat17 Module 6). RLS lets a staff member SELECT only their own
// staff_documents rows and read only their own storage folder, so
// this component physically cannot show anyone else's files.
// Viewing uses short-lived signed URLs.

import { useState, useEffect } from 'react'
import { createClient } from '@/utils/supabase/client'
import { FileText, Eye, FolderOpen } from 'lucide-react'
import type { StaffDocument } from '@/types'

const TYPE_LABEL: Record<string, string> = {
  aadhaar: 'Aadhaar Card',
  pan: 'PAN Card',
  resume: 'Resume',
  qualification: 'Qualification Certificate',
  appointment_letter: 'Appointment Letter',
  other: 'Other',
}

export default function MyDocuments() {
  const [docs, setDocs]       = useState<StaffDocument[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    (async () => {
      const supabase = createClient()
      const { data } = await supabase
        .from('staff_documents')
        .select('*')
        .order('created_at', { ascending: false })
      setDocs((data ?? []) as StaffDocument[])
      setLoading(false)
    })()
  }, [])

  async function handleView(doc: StaffDocument) {
    const supabase = createClient()
    const { data } = await supabase.storage
      .from('staff-docs')
      .createSignedUrl(doc.file_path, 300)
    if (data?.signedUrl) window.open(data.signedUrl, '_blank')
  }

  return (
    <div className="card">
      <h2 className="font-semibold text-slate-800 flex items-center gap-2 mb-3">
        <FolderOpen size={16} className="text-slate-400" /> My documents
      </h2>
      {loading ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="h-9 bg-slate-100 rounded-lg animate-pulse" />
          ))}
        </div>
      ) : docs.length > 0 ? (
        <div className="flex flex-col divide-y divide-slate-50">
          {docs.map(d => (
            <div key={d.id} className="flex items-center gap-3 py-2">
              <FileText size={15} className="text-slate-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-slate-800 truncate">{d.title}</p>
                <p className="text-xs text-slate-400">{TYPE_LABEL[d.doc_type] ?? d.doc_type}</p>
              </div>
              <button onClick={() => handleView(d)} title="View"
                className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 hover:text-brand-600 hover:bg-slate-50">
                <Eye size={15} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-slate-400">
          Documents your school uploads for you (Aadhaar, appointment letter, certificates) appear here.
        </p>
      )}
    </div>
  )
}
