'use client'

// FILE: app/(dashboard)/dashboard/my-exams/attendance/[examSubjectId]/page.tsx
// Invigilator exam-room attendance for one paper: QR scan (admit-card
// token, photo verification) OR manual roll. Both go through Phase 5
// RPCs. Reachable by admin/principal, assigned/class teachers.

import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { createClient } from '@/utils/supabase/client'
import { ArrowLeft, X, QrCode, ClipboardList, Check, Clock, UserX, HeartPulse, CameraOff } from 'lucide-react'
import type { ExamAttStatus, ExamAttendanceScanResult } from '@/types'
import { classLabel, formatDate, formatTime } from '@/components/exams/examUi'

interface RosterRow {
  student_id: string
  roll_number: number
  full_name: string
  photo_url: string | null
  status: ExamAttStatus | null
  source: 'qr' | 'manual' | null
  remarks: string | null
}

interface PaperMeta {
  exam_id: string
  exam_name: string
  class_label: string
  subject_name: string
  exam_date: string | null
  start_time: string | null
}

const STATUS_META: Record<ExamAttStatus, { label: string; cls: string; icon: React.ElementType }> = {
  present: { label: 'Present', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', icon: Check },
  late:    { label: 'Late',    cls: 'bg-amber-50 text-amber-700 border-amber-200',       icon: Clock },
  absent:  { label: 'Absent',  cls: 'bg-red-50 text-red-600 border-red-200',             icon: UserX },
  medical: { label: 'Medical', cls: 'bg-blue-50 text-blue-700 border-blue-200',          icon: HeartPulse },
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function ExamAttendancePage() {
  const { examSubjectId } = useParams<{ examSubjectId: string }>()
  const [meta, setMeta] = useState<PaperMeta | null>(null)
  const [roster, setRoster] = useState<RosterRow[]>([])
  const [mode, setMode] = useState<'roll' | 'scan'>('roll')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [scanResult, setScanResult] = useState<ExamAttendanceScanResult | null>(null)
  const [cameraError, setCameraError] = useState('')
  const scannerRef = useRef<any>(null)
  const lastScanRef = useRef<{ token: string; at: number }>({ token: '', at: 0 })

  const fetchAll = useCallback(async () => {
    const supabase = createClient()
    const { data: es } = await supabase
      .from('exam_subjects')
      .select('exam_id, class_id, exam_date, start_time, classes(name, section), subjects(name), exams(name)')
      .eq('id', examSubjectId).single()
    if (!es) { setError('Paper not found'); setLoading(false); return }
    const esa = es as any
    setMeta({
      exam_id: esa.exam_id,
      exam_name: esa.exams?.name ?? '—',
      class_label: classLabel(esa.classes),
      subject_name: esa.subjects?.name ?? '—',
      exam_date: esa.exam_date,
      start_time: esa.start_time,
    })

    const [enRes, attRes] = await Promise.all([
      supabase.from('exam_enrollments')
        .select('student_id, roll_number, status, students(full_name, photo_url)')
        .eq('exam_id', esa.exam_id).eq('class_id', esa.class_id).eq('status', 'enrolled')
        .order('roll_number'),
      supabase.from('exam_attendance').select('student_id, status, source, remarks')
        .eq('exam_subject_id', examSubjectId),
    ])
    const attMap = new Map((attRes.data ?? []).map((a: any) => [a.student_id, a]))
    setRoster(((enRes.data ?? []) as any[]).map(e => {
      const a = attMap.get(e.student_id)
      return {
        student_id: e.student_id,
        roll_number: e.roll_number,
        full_name: e.students?.full_name ?? '—',
        photo_url: e.students?.photo_url ?? null,
        status: a?.status ?? null,
        source: a?.source ?? null,
        remarks: a?.remarks ?? null,
      }
    }))
    setLoading(false)
  }, [examSubjectId])

  useEffect(() => { fetchAll() }, [fetchAll])

  async function setStatus(studentId: string, status: ExamAttStatus) {
    // optimistic
    setRoster(prev => prev.map(r => r.student_id === studentId ? { ...r, status, source: 'manual' } : r))
    const supabase = createClient()
    const { error } = await supabase.rpc('mark_exam_attendance_bulk', {
      p_exam_subject_id: examSubjectId,
      p_rows: [{ student_id: studentId, status }],
    })
    if (error) { setError(error.message); await fetchAll() }
  }

  async function markAllPresent() {
    const unmarked = roster.filter(r => r.status === null)
    if (unmarked.length === 0) return
    if (!confirm(`Mark ${unmarked.length} unmarked student(s) present?`)) return
    const supabase = createClient()
    const { error } = await supabase.rpc('mark_exam_attendance_bulk', {
      p_exam_subject_id: examSubjectId,
      p_rows: unmarked.map(r => ({ student_id: r.student_id, status: 'present' })),
    })
    if (error) setError(error.message)
    await fetchAll()
  }

  // ── QR scanning ────────────────────────────────────────────
  const handleScan = useCallback(async (raw: string) => {
    // admit-card QR encodes .../verify/admit-card/<token>
    const token = raw.trim().split('/').pop() ?? raw.trim()
    const now = Date.now()
    if (token === lastScanRef.current.token && now - lastScanRef.current.at < 3000) return
    lastScanRef.current = { token, at: now }

    const supabase = createClient()
    const { data, error } = await supabase.rpc('record_exam_attendance_scan', {
      p_qr_token: token, p_exam_subject_id: examSubjectId,
    })
    if (error) { setScanResult({ ok: false, reason: 'unknown_card' }); return }
    const r = data as ExamAttendanceScanResult
    setScanResult(r)
    if (r.ok) {
      try {
        const ctx = new AudioContext()
        const osc = ctx.createOscillator()
        osc.connect(ctx.destination)
        osc.frequency.value = r.status_set === 'late' ? 550 : 880
        osc.start(); osc.stop(ctx.currentTime + 0.15)
      } catch { /* no audio */ }
      // reflect in roster without a full refetch
      setRoster(prev => prev.map(x =>
        x.roll_number === r.roll_number ? { ...x, status: r.status_set ?? x.status, source: 'qr' } : x))
    }
  }, [examSubjectId])

  useEffect(() => {
    if (mode !== 'scan') return
    let cancelled = false
    ;(async () => {
      try {
        const { Html5Qrcode } = await import('html5-qrcode')
        if (cancelled) return
        const scanner = new Html5Qrcode('exam-qr-reader')
        scannerRef.current = scanner
        await scanner.start(
          { facingMode: 'environment' },
          { fps: 12, qrbox: { width: 240, height: 240 }, aspectRatio: 1.0 },
          handleScan, () => {},
        )
      } catch {
        setCameraError('Could not start the camera. Use manual roll instead.')
      }
    })()
    return () => {
      cancelled = true
      scannerRef.current?.stop().catch(() => {})
      scannerRef.current = null
    }
  }, [mode, handleScan])

  if (loading || !meta) {
    return <div className="max-w-2xl mx-auto"><div className="card h-96 animate-pulse bg-slate-50" /></div>
  }

  const counts = roster.reduce((acc, r) => {
    if (r.status) acc[r.status] = (acc[r.status] ?? 0) + 1
    else acc.unmarked++
    return acc
  }, { present: 0, late: 0, absent: 0, medical: 0, unmarked: 0 } as Record<string, number>)

  return (
    <div className="max-w-2xl mx-auto">
      <Link href="/dashboard/my-exams" className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600 mb-1">
        <ArrowLeft size={12} /> My Exams
      </Link>
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-slate-900">{meta.subject_name} — {meta.class_label}</h1>
        <p className="text-slate-500 text-sm mt-1">
          {meta.exam_name}{meta.exam_date ? ` · ${formatDate(meta.exam_date)} ${formatTime(meta.start_time)}` : ''}
        </p>
      </div>

      {error && (
        <div className="bg-red-50 text-red-600 text-sm px-4 py-3 rounded-lg mb-4 flex items-start justify-between gap-3">
          <span>{error}</span><button onClick={() => setError('')}><X size={14} /></button>
        </div>
      )}

      {/* mode toggle + counts */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex gap-1.5">
          <button onClick={() => setMode('roll')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 ${mode === 'roll' ? 'bg-brand-600 text-white' : 'bg-white border border-slate-200 text-slate-600'}`}>
            <ClipboardList size={13} /> Manual roll
          </button>
          <button onClick={() => setMode('scan')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 ${mode === 'scan' ? 'bg-brand-600 text-white' : 'bg-white border border-slate-200 text-slate-600'}`}>
            <QrCode size={13} /> Scan QR
          </button>
        </div>
        <div className="flex gap-2 text-xs">
          <span className="text-emerald-600 font-medium">{counts.present} present</span>
          <span className="text-amber-600 font-medium">{counts.late} late</span>
          <span className="text-red-500 font-medium">{counts.absent} absent</span>
          {counts.medical > 0 && <span className="text-blue-600 font-medium">{counts.medical} medical</span>}
          {counts.unmarked > 0 && <span className="text-slate-400">{counts.unmarked} unmarked</span>}
        </div>
      </div>

      {/* SCAN MODE */}
      {mode === 'scan' && (
        <div className="card p-4 mb-4">
          {cameraError ? (
            <div className="flex flex-col items-center py-8 text-center">
              <CameraOff size={28} className="text-slate-300 mb-2" />
              <p className="text-sm text-slate-500">{cameraError}</p>
            </div>
          ) : (
            <>
              <div id="exam-qr-reader" className="w-full max-w-xs mx-auto rounded-lg overflow-hidden" />
              <p className="text-xs text-slate-400 text-center mt-2">Point at the admit-card QR</p>
            </>
          )}

          {scanResult && (
            <div className={`mt-3 rounded-xl p-4 border ${scanResult.ok ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200'}`}>
              {scanResult.ok ? (
                <div className="flex items-center gap-3">
                  {scanResult.photo_url
                    ? <img src={scanResult.photo_url} alt="" className="w-14 h-16 object-cover rounded border border-slate-200" />
                    : <div className="w-14 h-16 rounded bg-slate-100 flex items-center justify-center text-slate-300 text-xs">no photo</div>}
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-900">{scanResult.student_name}</p>
                    <p className="text-xs text-slate-500">
                      {scanResult.class_label} · Roll {scanResult.roll_number}
                      {scanResult.seat_number ? ` · Seat ${scanResult.seat_number}` : ''}
                    </p>
                    <span className={`inline-block mt-1 text-xs font-medium px-2 py-0.5 rounded-full ${scanResult.status_set === 'late' ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}`}>
                      Marked {scanResult.status_set}
                    </span>
                    {scanResult.warnings?.map((w, i) => (
                      <p key={i} className="text-xs text-amber-600 mt-1">{w}</p>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-sm text-red-600 font-medium text-center">
                  {scanResult.reason === 'revoked_card' ? 'Admit card revoked'
                    : scanResult.reason === 'wrong_exam' ? 'This card is for a different exam'
                    : scanResult.reason === 'wrong_class' ? `Wrong class — ${scanResult.student_name ?? ''} (${scanResult.class_label ?? ''})`
                    : 'Card not recognised'}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* ROLL (always visible so scan results are cross-checkable) */}
      <div className="card overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-100">
          <span className="text-xs font-medium text-slate-500">{roster.length} enrolled</span>
          {counts.unmarked > 0 && (
            <button onClick={markAllPresent} className="text-xs text-brand-600 font-medium hover:text-brand-700">
              Mark remaining present
            </button>
          )}
        </div>
        <div className="divide-y divide-slate-50">
          {roster.map(r => (
            <div key={r.student_id} className="flex items-center justify-between gap-3 px-4 py-2.5">
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="text-sm font-semibold text-slate-500 w-6">{r.roll_number}</span>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-800 truncate">{r.full_name}</p>
                  {r.source === 'qr' && <p className="text-[10px] text-slate-400">scanned</p>}
                </div>
              </div>
              <div className="flex gap-1 shrink-0">
                {(Object.keys(STATUS_META) as ExamAttStatus[]).map(s => {
                  const M = STATUS_META[s]
                  const active = r.status === s
                  return (
                    <button key={s} onClick={() => setStatus(r.student_id, s)}
                      title={M.label}
                      className={`w-8 h-8 flex items-center justify-center rounded-lg border transition-colors ${active ? M.cls : 'border-slate-200 text-slate-300 hover:text-slate-500 hover:bg-slate-50'}`}>
                      <M.icon size={14} />
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
