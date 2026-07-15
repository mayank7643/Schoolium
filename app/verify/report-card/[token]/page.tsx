'use client'

// FILE: app/verify/report-card/[token]/page.tsx
// PUBLIC QR verification (no auth). Returns a verdict, not the full
// document — verifies authenticity of a scanned report card.

import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'
import { createClient } from '@/utils/supabase/client'
import { ShieldCheck, ShieldX, ShieldAlert } from 'lucide-react'
import type { ReportCardVerify } from '@/types'

export default function VerifyReportCardPage() {
  const { token } = useParams<{ token: string }>()
  const [result, setResult] = useState<ReportCardVerify | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    (async () => {
      const supabase = createClient()
      const { data, error } = await supabase.rpc('verify_report_card', { p_qr_token: token })
      if (error) setResult({ valid: false, reason: 'not_found' })
      else setResult(data as ReportCardVerify)
      setLoading(false)
    })()
  }, [token])

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4">
      <div className="max-w-sm w-full">
        {loading ? (
          <div className="bg-white rounded-2xl shadow-sm h-64 animate-pulse" />
        ) : result?.valid ? (
          <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
            <div className={`px-6 py-6 text-center ${result.version_status === 'superseded' ? 'bg-amber-50' : 'bg-emerald-50'}`}>
              {result.version_status === 'superseded'
                ? <ShieldAlert size={40} className="text-amber-500 mx-auto mb-2" />
                : <ShieldCheck size={40} className="text-emerald-500 mx-auto mb-2" />}
              <p className={`font-bold ${result.version_status === 'superseded' ? 'text-amber-700' : 'text-emerald-700'}`}>
                {result.version_status === 'superseded' ? 'Superseded copy' : 'Authentic report card'}
              </p>
              {result.version_status === 'superseded' && (
                <p className="text-xs text-amber-600 mt-1">A newer revised version has been issued.</p>
              )}
            </div>
            <div className="px-6 py-4 text-sm">
              <Row label="Student" value={result.student_name} />
              <Row label="Class" value={result.class} />
              <Row label="Exam" value={result.exam_name} />
              <Row label="Percentage" value={result.percentage ? `${result.percentage}%` : undefined} />
              <Row label="Result" value={result.result?.toUpperCase()} />
              {result.generated_at && (
                <Row label="Issued" value={new Date(result.generated_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })} />
              )}
            </div>
          </div>
        ) : (
          <div className="bg-white rounded-2xl shadow-sm px-6 py-8 text-center">
            <ShieldX size={40} className="text-red-500 mx-auto mb-2" />
            <p className="font-bold text-red-600">
              {result?.reason === 'not_published' ? 'Not a published result' : 'Not verifiable'}
            </p>
            <p className="text-xs text-slate-500 mt-1">
              This code does not match a published report card.
            </p>
          </div>
        )}
        <p className="text-center text-xs text-slate-400 mt-4">Schoolium report-card verification</p>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value?: string }) {
  if (!value) return null
  return (
    <div className="flex justify-between py-1.5 border-b border-slate-50 last:border-0">
      <span className="text-slate-400">{label}</span>
      <span className="font-medium text-slate-800">{value}</span>
    </div>
  )
}
