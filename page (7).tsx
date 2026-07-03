'use client'

// FILE: app/(dashboard)/dashboard/fees/summary/page.tsx
// School fee summary: whole-school / class / class-section, with insight cards,
// an on-screen table, and a print-ready PDF download. Admin or collector.
// Replaces the old summary that queried the dropped `fees` table.

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { createClient } from '@/utils/supabase/client'
import {
  ArrowLeft, Download, Users, AlertTriangle, CheckCircle2, IndianRupee, Loader2, AlertCircle,
} from 'lucide-react'

interface SummaryRow {
  student_id: string
  student_uid: string | null
  full_name: string
  father_name: string | null
  parent_phone: string | null
  class_name: string | null
  section: string | null
  due_count: number
  outstanding: number
}

function rupee(n: number) {
  return '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN')
}

export default function FeeSummaryPage() {
  const [classes, setClasses]   = useState<{ name: string; section: string | null }[]>([])
  const [selClass, setSelClass] = useState('')
  const [selSection, setSelSection] = useState('')

  const [rows, setRows]         = useState<SummaryRow[]>([])
  const [loading, setLoading]   = useState(true)
  const [denied, setDenied]     = useState(false)
  const [error, setError]       = useState('')
  const [downloading, setDownloading] = useState(false)

  useEffect(() => {
    (async () => {
      const supabase = createClient()
      const { data: profile } = await supabase.from('profiles').select('school_id').single()
      if (!profile) return
      const { data } = await supabase
        .from('classes')
        .select('name, section')
        .eq('school_id', (profile as any).school_id)
        .order('name')
      setClasses((data as any[]) || [])
    })()
  }, [])

  const fetchSummary = useCallback(async () => {
    setLoading(true); setError('')
    const supabase = createClient()
    const { data, error } = await supabase.rpc('get_fee_summary', {
      p_class_name: selClass || null,
      p_section:    selSection || null,
    })
    if (error) {
      if (error.message.includes('Access denied')) setDenied(true)
      else setError(error.message)
      setRows([]); setLoading(false); return
    }
    setRows((data as SummaryRow[]) || [])
    setLoading(false)
  }, [selClass, selSection])

  useEffect(() => { fetchSummary() }, [fetchSummary])

  async function downloadPdf() {
    setDownloading(true); setError('')
    try {
      const res = await fetch('/api/fee-summary-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ class_name: selClass || null, section: selSection || null }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setError(j.error || 'Could not generate PDF'); setDownloading(false); return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `fee-summary-${selClass || 'school'}${selSection ? '-' + selSection : ''}.pdf`
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(url)
    } catch { setError('Download failed') }
    setDownloading(false)
  }

  const classNames = Array.from(new Set(classes.map(c => c.name))).sort()
  const sections   = Array.from(new Set(classes.filter(c => c.name === selClass && c.section).map(c => c.section as string))).sort()

  const withDues = rows.filter(r => r.due_count > 0).length
  const cleared  = rows.length - withDues
  const totalOut = rows.reduce((s, r) => s + Number(r.outstanding || 0), 0)
  const totalDueCount = rows.reduce((s, r) => s + r.due_count, 0)

  if (denied) {
    return (
      <div className="max-w-2xl mx-auto py-16 text-center">
        <AlertCircle size={32} className="mx-auto text-red-400 mb-3" />
        <p className="font-semibold text-slate-700">Access denied</p>
        <p className="text-sm text-slate-400 mt-1">Only admins and collectors can view the fee summary.</p>
        <Link href="/dashboard/fees" className="btn-primary mt-4 inline-block text-sm">Back to fees</Link>
      </div>
    )
  }

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex items-center justify-between gap-3 mb-5 flex-wrap">
        <div className="flex items-center gap-3">
          <Link href="/dashboard/fees" className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 text-slate-500">
            <ArrowLeft size={18} />
          </Link>
          <div>
            <h1 className="text-xl font-bold text-slate-900">Fee Summary</h1>
            <p className="text-slate-400 text-xs mt-0.5">Live dues per student, ready to print or share</p>
          </div>
        </div>
        <button onClick={downloadPdf} disabled={downloading || loading} className="btn-primary flex items-center gap-2 text-sm">
          {downloading ? <><Loader2 size={15} className="animate-spin" /> Preparing…</> : <><Download size={15} /> Download PDF</>}
        </button>
      </div>

      <div className="card flex flex-wrap items-end gap-3 mb-4">
        <div className="w-40">
          <label className="label">Class</label>
          <select className="input" value={selClass}
            onChange={e => { setSelClass(e.target.value); setSelSection('') }}>
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
          {loading ? 'Loading…' : `${rows.length} student${rows.length === 1 ? '' : 's'}`}
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <div className="stat-card">
          <div className="flex items-center gap-2 text-slate-400 text-xs mb-1"><Users size={14} /> Students</div>
          <p className="text-xl font-bold text-slate-900">{rows.length}</p>
        </div>
        <div className="stat-card">
          <div className="flex items-center gap-2 text-amber-500 text-xs mb-1"><AlertTriangle size={14} /> With dues</div>
          <p className="text-xl font-bold text-slate-900">{withDues}<span className="text-xs font-normal text-slate-400"> · {totalDueCount} dues</span></p>
        </div>
        <div className="stat-card">
          <div className="flex items-center gap-2 text-green-500 text-xs mb-1"><CheckCircle2 size={14} /> Cleared</div>
          <p className="text-xl font-bold text-slate-900">{cleared}</p>
        </div>
        <div className="stat-card">
          <div className="flex items-center gap-2 text-slate-400 text-xs mb-1"><IndianRupee size={14} /> Outstanding</div>
          <p className="text-xl font-bold text-red-500">{rupee(totalOut)}</p>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg mb-3">
          <AlertCircle size={14} /> {error}
        </div>
      )}

      <div className="card p-0 overflow-x-auto">
        <table className="table w-full" style={{ tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: '26%' }} />
            <col style={{ width: '20%' }} />
            <col style={{ width: '16%' }} />
            <col style={{ width: '10%' }} />
            <col style={{ width: '8%' }} />
            <col style={{ width: '12%' }} />
            <col style={{ width: '8%' }} />
          </colgroup>
          <thead>
            <tr>
              <th className="text-left">Student</th>
              <th className="text-left">Father</th>
              <th className="text-left">Mobile</th>
              <th className="text-center">Class</th>
              <th className="text-center">Dues</th>
              <th className="text-right">Outstanding</th>
              <th className="text-center">Status</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              [1, 2, 3, 4, 5].map(i => (
                <tr key={i}><td colSpan={7}><div className="h-4 bg-slate-50 rounded animate-pulse my-1" /></td></tr>
              ))
            ) : rows.length === 0 ? (
              <tr><td colSpan={7} className="text-center text-slate-400 py-8">No students match this filter.</td></tr>
            ) : rows.map(r => {
              const cls = [r.class_name, r.section].filter(Boolean).join('-') || '—'
              const clearedRow = r.due_count === 0
              return (
                <tr key={r.student_id}>
                  <td className="truncate">
                    <span className="font-medium text-slate-800">{r.full_name}</span>
                    {r.student_uid && <span className="ml-2 font-mono text-[10px] text-slate-400">{r.student_uid}</span>}
                  </td>
                  <td className="truncate text-slate-600">{r.father_name || '—'}</td>
                  <td className="text-slate-600">{r.parent_phone || '—'}</td>
                  <td className="text-center text-slate-600">{cls}</td>
                  <td className="text-center">{r.due_count}</td>
                  <td className="text-right font-medium">{clearedRow ? '—' : rupee(r.outstanding)}</td>
                  <td className="text-center">
                    <span className={clearedRow ? 'badge-green' : 'badge-yellow'}>{clearedRow ? 'Cleared' : 'Pending'}</span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
