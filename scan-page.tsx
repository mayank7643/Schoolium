'use client'

// ─────────────────────────────────────────────────────────────
// FILE: app/scan/[school_id]/page.tsx
// Public route — no login required. Guard opens this on a tablet.
// Architecture: offline-first IndexedDB cache → instant <5ms scan
// feedback → background sync to Supabase every 5 seconds.
// ─────────────────────────────────────────────────────────────

import { useEffect, useRef, useState, useCallback } from 'react'
import { useParams } from 'next/navigation'
import { createClient } from '@/utils/supabase/client'
import { CheckCircle, AlertCircle, Clock, Wifi, WifiOff, Users, RefreshCw } from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────
interface CachedStudent {
  id: string
  full_name: string
  student_uid: string
  class_name: string
}

interface ScanQueueItem {
  student_id: string
  school_id: string
  scan_date: string    // YYYY-MM-DD
  scan_time: string    // ISO string
  gate: string
}

interface ScanResult {
  type: 'success' | 'already' | 'unknown'
  student?: CachedStudent
}

// ── IndexedDB helpers ─────────────────────────────────────────
const DB_NAME = 'schoolium_scan'
const DB_VERSION = 1

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains('students')) {
        db.createObjectStore('students', { keyPath: 'student_uid' })
      }
      if (!db.objectStoreNames.contains('queue')) {
        db.createObjectStore('queue', { autoIncrement: true })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function cacheStudents(students: CachedStudent[]): Promise<void> {
  const db = await openDB()
  const tx = db.transaction('students', 'readwrite')
  const store = tx.objectStore('students')
  store.clear()
  students.forEach(s => store.put(s))
  return new Promise((resolve) => { tx.oncomplete = () => resolve() })
}

async function lookupStudent(uid: string): Promise<CachedStudent | null> {
  const db = await openDB()
  return new Promise((resolve) => {
    const tx = db.transaction('students', 'readonly')
    const req = tx.objectStore('students').get(uid)
    req.onsuccess = () => resolve(req.result ?? null)
    req.onerror = () => resolve(null)
  })
}

async function addToQueue(item: ScanQueueItem): Promise<void> {
  const db = await openDB()
  return new Promise((resolve) => {
    const tx = db.transaction('queue', 'readwrite')
    tx.objectStore('queue').add(item)
    tx.oncomplete = () => resolve()
  })
}

async function getQueue(): Promise<{ key: number; item: ScanQueueItem }[]> {
  const db = await openDB()
  return new Promise((resolve) => {
    const results: { key: number; item: ScanQueueItem }[] = []
    const tx = db.transaction('queue', 'readonly')
    const req = tx.objectStore('queue').openCursor()
    req.onsuccess = (e) => {
      const cursor = (e.target as IDBRequest).result
      if (cursor) {
        results.push({ key: cursor.key as number, item: cursor.value })
        cursor.continue()
      } else {
        resolve(results)
      }
    }
    req.onerror = () => resolve([])
  })
}

async function removeFromQueue(keys: number[]): Promise<void> {
  const db = await openDB()
  return new Promise((resolve) => {
    const tx = db.transaction('queue', 'readwrite')
    keys.forEach(k => tx.objectStore('queue').delete(k))
    tx.oncomplete = () => resolve()
  })
}

// ── Audio — pre-created on mount, not inside handler ─────────
let audioCtx: AudioContext | null = null

function playBeep(type: 'success' | 'already' | 'unknown') {
  try {
    if (!audioCtx) audioCtx = new AudioContext()
    const osc = audioCtx.createOscillator()
    const gain = audioCtx.createGain()
    osc.connect(gain)
    gain.connect(audioCtx.destination)

    if (type === 'success') {
      osc.frequency.value = 880
      gain.gain.setValueAtTime(0.3, audioCtx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3)
      osc.start(); osc.stop(audioCtx.currentTime + 0.3)
    } else if (type === 'already') {
      osc.frequency.value = 440
      gain.gain.setValueAtTime(0.2, audioCtx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.4)
      osc.start(); osc.stop(audioCtx.currentTime + 0.4)
    } else {
      osc.frequency.value = 200
      gain.gain.setValueAtTime(0.2, audioCtx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.5)
      osc.start(); osc.stop(audioCtx.currentTime + 0.5)
    }
  } catch (_) { /* audio blocked on some devices — silent fail */ }
}

// ── Main component ────────────────────────────────────────────
export default function ScanPage() {
  const params = useParams()
  const schoolId = params.school_id as string

  const [cacheLoaded, setCacheLoaded]     = useState(false)
  const [cacheCount, setCacheCount]       = useState(0)
  const [scanResult, setScanResult]       = useState<ScanResult | null>(null)
  const [queueSize, setQueueSize]         = useState(0)
  const [online, setOnline]               = useState(true)
  const [scanCount, setScanCount]         = useState(0)
  const [gate, setGate]                   = useState('Main Gate')
  const [loadingCache, setLoadingCache]   = useState(true)
  const [scannerReady, setScannerReady]   = useState(false)
  const [cacheError, setCacheError]       = useState('')

  // In-memory set of today's scanned student IDs (for instant duplicate check)
  const scannedTodayRef = useRef<Set<string>>(new Set())
  const overlayTimerRef = useRef<NodeJS.Timeout | null>(null)
  const scannerRef      = useRef<any>(null)
  const videoRef        = useRef<HTMLDivElement>(null)
  const isScanningRef   = useRef(false) // debounce — ignore scans while overlay is visible

  // ── Load student cache from Supabase into IndexedDB ──────
  const loadCache = useCallback(async () => {
    setLoadingCache(true)
    setCacheError('')
    try {
      const supabase = createClient()
      const { data, error } = await supabase
        .from('students')
        .select('id, full_name, student_uid, classes(name)')
        .eq('school_id', schoolId)
        .eq('is_active', true)
        .not('student_uid', 'is', null)

      if (error) throw error

      const mapped: CachedStudent[] = (data ?? []).map((s: any) => ({
        id: s.id,
        full_name: s.full_name,
        student_uid: s.student_uid,
        class_name: s.classes?.name ?? '',
      }))

      await cacheStudents(mapped)
      setCacheCount(mapped.length)
      setCacheLoaded(true)
    } catch (err: any) {
      setCacheError('Could not load students. Check internet and retry.')
    } finally {
      setLoadingCache(false)
    }
  }, [schoolId])

  // ── Background sync — push queue to Supabase every 5s ────
  const syncQueue = useCallback(async () => {
    const items = await getQueue()
    if (items.length === 0) { setQueueSize(0); return }
    setQueueSize(items.length)

    try {
      const supabase = createClient()
      // Upsert all queued scans — ON CONFLICT DO NOTHING via ignoreDuplicates
      const rows = items.map(({ item }) => ({
        school_id: item.school_id,
        student_id: item.student_id,
        scan_date: item.scan_date,
        scan_time: item.scan_time,
        gate: item.gate,
      }))

      const { error } = await supabase
        .from('attendance')
        .upsert(rows, { onConflict: 'school_id,student_id,scan_date', ignoreDuplicates: true })

      if (!error) {
        await removeFromQueue(items.map(i => i.key))
        setQueueSize(0)
      }
    } catch (_) {
      // Network down — items stay in queue, will retry next interval
    }
  }, [])

  // ── Handle a decoded QR scan ──────────────────────────────
  const handleScan = useCallback(async (decodedText: string) => {
    if (isScanningRef.current) return // debounce — one scan at a time
    isScanningRef.current = true

    const uid = decodedText.trim()
    const student = await lookupStudent(uid)

    if (!student) {
      // Unknown QR code
      playBeep('unknown')
      setScanResult({ type: 'unknown' })
    } else if (scannedTodayRef.current.has(student.id)) {
      // Already scanned today
      playBeep('already')
      setScanResult({ type: 'already', student })
    } else {
      // Valid — mark locally + queue for sync
      scannedTodayRef.current.add(student.id)
      playBeep('success')
      setScanCount(c => c + 1)

      const now = new Date()
      const scanDate = now.toISOString().split('T')[0]

      await addToQueue({
        student_id: student.id,
        school_id: schoolId,
        scan_date: scanDate,
        scan_time: now.toISOString(),
        gate,
      })

      setScanResult({ type: 'success', student })
    }

    // Show overlay for 1.5s then clear and allow next scan
    if (overlayTimerRef.current) clearTimeout(overlayTimerRef.current)
    overlayTimerRef.current = setTimeout(() => {
      setScanResult(null)
      isScanningRef.current = false
    }, 1500)
  }, [schoolId, gate])

  // ── Start QR scanner ──────────────────────────────────────
  const startScanner = useCallback(async () => {
    if (scannerRef.current || !videoRef.current) return
    try {
      // Dynamically import html5-qrcode to avoid SSR issues
      const { Html5Qrcode } = await import('html5-qrcode')
      const scanner = new Html5Qrcode('qr-reader')
      scannerRef.current = scanner

      await scanner.start(
        { facingMode: 'environment' },
        {
          fps: 15,              // 15 frames/sec — good balance for tablet
          qrbox: { width: 260, height: 260 },
          aspectRatio: 1.0,
        },
        handleScan,
        () => {}              // ignore intermediate errors
      )
      setScannerReady(true)
    } catch (err) {
      console.error('Scanner failed to start:', err)
    }
  }, [handleScan])

  // ── Realtime broadcast — sync scans from other guards ─────
  useEffect(() => {
    const supabase = createClient()
    const channel = supabase.channel(`school:${schoolId}:scans`)
    channel.on('broadcast', { event: 'scan' }, ({ payload }: any) => {
      // Another guard scanned this student — mark locally
      if (payload?.studentId) {
        scannedTodayRef.current.add(payload.studentId)
      }
    }).subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [schoolId])

  // ── On mount: load cache, pre-init AudioContext, start scanner
  useEffect(() => {
    // Pre-create AudioContext so it's ready before first scan
    try { audioCtx = new AudioContext() } catch (_) {}

    loadCache().then(() => startScanner())

    // Online/offline detection
    const handleOnline  = () => setOnline(true)
    const handleOffline = () => setOnline(false)
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    // Background sync every 5 seconds
    const syncInterval = setInterval(syncQueue, 5000)

    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
      clearInterval(syncInterval)
      if (overlayTimerRef.current) clearTimeout(overlayTimerRef.current)
      scannerRef.current?.stop().catch(() => {})
    }
  }, [loadCache, startScanner, syncQueue])

  // ── Overlay colours ───────────────────────────────────────
  const overlayColor =
    scanResult?.type === 'success' ? 'bg-green-500' :
    scanResult?.type === 'already' ? 'bg-amber-400' :
    scanResult?.type === 'unknown' ? 'bg-red-500' : ''

  const overlayText =
    scanResult?.type === 'success' ? scanResult.student?.full_name ?? 'Present' :
    scanResult?.type === 'already' ? `Already in — ${scanResult.student?.full_name ?? ''}` :
    'Unknown card'

  const overlaySubtext =
    scanResult?.type === 'success' ? scanResult.student?.class_name ?? '' :
    scanResult?.type === 'already' ? 'Scanned earlier today' :
    'QR not recognised'

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col">

      {/* ── Top bar ── */}
      <div className="flex items-center justify-between px-4 py-3 bg-slate-800">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 bg-brand-600 rounded-lg flex items-center justify-center">
            <span className="text-white text-xs font-bold">S</span>
          </div>
          <span className="text-white font-semibold text-sm">Schoolium Scanner</span>
        </div>

        <div className="flex items-center gap-3">
          {/* Online indicator */}
          <div className="flex items-center gap-1">
            {online
              ? <Wifi size={14} className="text-green-400" />
              : <WifiOff size={14} className="text-red-400" />}
            {queueSize > 0 && (
              <span className="text-xs text-amber-300">{queueSize} pending</span>
            )}
          </div>

          {/* Scan counter */}
          <div className="flex items-center gap-1">
            <Users size={14} className="text-slate-400" />
            <span className="text-white text-sm font-semibold">{scanCount}</span>
          </div>
        </div>
      </div>

      {/* ── Gate selector ── */}
      <div className="flex gap-2 px-4 py-2 bg-slate-800 border-t border-slate-700">
        {['Main Gate', 'Side Gate', 'Back Gate'].map(g => (
          <button
            key={g}
            onClick={() => setGate(g)}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
              gate === g
                ? 'bg-brand-600 text-white'
                : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
            }`}
          >
            {g}
          </button>
        ))}
      </div>

      {/* ── Camera area ── */}
      <div className="flex-1 flex flex-col items-center justify-center px-4 py-6 relative">

        {loadingCache ? (
          <div className="flex flex-col items-center gap-4 text-white">
            <div className="w-12 h-12 border-4 border-brand-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-slate-300 text-sm">Loading {cacheCount > 0 ? cacheCount : ''} students…</p>
          </div>
        ) : cacheError ? (
          <div className="flex flex-col items-center gap-4 text-center max-w-xs">
            <AlertCircle size={40} className="text-red-400" />
            <p className="text-white font-medium">Could not load student list</p>
            <p className="text-slate-400 text-sm">{cacheError}</p>
            <button onClick={loadCache} className="btn-primary flex items-center gap-2 mt-2">
              <RefreshCw size={15} /> Retry
            </button>
          </div>
        ) : (
          <>
            {/* QR reader container — html5-qrcode mounts video here */}
            <div
              id="qr-reader"
              ref={videoRef}
              className="w-full max-w-sm rounded-2xl overflow-hidden bg-black"
              style={{ minHeight: 320 }}
            />

            {!scannerReady && (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="flex flex-col items-center gap-3 text-white">
                  <div className="w-10 h-10 border-4 border-white border-t-transparent rounded-full animate-spin" />
                  <p className="text-sm text-slate-300">Starting camera…</p>
                </div>
              </div>
            )}

            {/* Cache info pill */}
            <div className="mt-4 flex items-center gap-2 bg-slate-800 rounded-full px-4 py-2">
              <div className="w-2 h-2 rounded-full bg-green-400" />
              <span className="text-slate-300 text-xs">{cacheCount} students cached · {gate}</span>
            </div>
          </>
        )}

        {/* ── Scan result overlay — always in DOM, toggled by opacity ── */}
        {/* Pre-rendered so opacity transition is instant — no createElement mid-scan */}
        <div
          className={`absolute inset-0 flex flex-col items-center justify-center rounded-2xl transition-opacity duration-75 ${
            scanResult ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
          } ${overlayColor}`}
          style={{ zIndex: 10 }}
        >
          <div className="flex flex-col items-center gap-3 px-6 text-center">
            {scanResult?.type === 'success' && (
              <CheckCircle size={64} className="text-white drop-shadow" />
            )}
            {scanResult?.type === 'already' && (
              <Clock size={64} className="text-white drop-shadow" />
            )}
            {scanResult?.type === 'unknown' && (
              <AlertCircle size={64} className="text-white drop-shadow" />
            )}
            <p className="text-white text-2xl font-bold leading-tight">{overlayText}</p>
            <p className="text-white/80 text-base">{overlaySubtext}</p>
          </div>
        </div>
      </div>

      {/* ── Bottom status bar ── */}
      <div className="px-4 py-3 bg-slate-800 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${cacheLoaded ? 'bg-green-400' : 'bg-yellow-400'}`} />
          <span className="text-slate-400 text-xs">
            {cacheLoaded ? 'Offline ready' : 'Loading…'}
          </span>
        </div>
        <button
          onClick={loadCache}
          className="flex items-center gap-1 text-slate-400 hover:text-white text-xs transition-colors"
        >
          <RefreshCw size={12} /> Refresh list
        </button>
      </div>
    </div>
  )
}
