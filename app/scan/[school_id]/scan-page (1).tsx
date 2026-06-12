'use client'

// ─────────────────────────────────────────────────────────────
// FILE: app/scan/[school_id]/page.tsx
// Public route — no login required.
// QR encodes student UUID (32-char unguessable Supabase ID).
// Offline-first: IndexedDB cache → <5ms lookup → background sync.
// ─────────────────────────────────────────────────────────────

import { useEffect, useRef, useState, useCallback } from 'react'
import { useParams } from 'next/navigation'
import { createClient } from '@/utils/supabase/client'
import { CheckCircle, AlertCircle, Clock, Wifi, WifiOff, Users, RefreshCw, Camera, CameraOff } from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────
interface CachedStudent {
  id: string          // Supabase UUID — this is what the QR encodes
  full_name: string
  student_uid: string // display only e.g. NA-26-0001
  class_name: string
}

interface ScanQueueItem {
  student_id: string
  school_id: string
  scan_date: string
  scan_time: string
  gate: string
}

interface ScanResult {
  type: 'success' | 'already' | 'unknown'
  student?: CachedStudent
}

type CameraState = 'idle' | 'requesting' | 'denied' | 'error' | 'running'

// ── IndexedDB — keyed by student UUID ─────────────────────────
const DB_NAME    = 'schoolium_scan_v2'  // v2 = UUID-keyed (different from old student_uid-keyed)
const DB_VERSION = 1

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains('students')) {
        // keyPath is 'id' — the Supabase UUID
        db.createObjectStore('students', { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains('queue')) {
        db.createObjectStore('queue', { autoIncrement: true })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror   = () => reject(req.error)
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

// Lookup by UUID — the value encoded in the QR code
async function lookupByUUID(uuid: string): Promise<CachedStudent | null> {
  const db = await openDB()
  return new Promise((resolve) => {
    const tx  = db.transaction('students', 'readonly')
    const req = tx.objectStore('students').get(uuid)
    req.onsuccess = () => resolve(req.result ?? null)
    req.onerror   = () => resolve(null)
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
    const tx  = db.transaction('queue', 'readonly')
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

// ── Audio — pre-created on mount ──────────────────────────────
let audioCtx: AudioContext | null = null

function playBeep(type: 'success' | 'already' | 'unknown') {
  try {
    if (!audioCtx) audioCtx = new AudioContext()
    if (audioCtx.state === 'suspended') audioCtx.resume()
    const osc  = audioCtx.createOscillator()
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
  } catch (_) {}
}

// ── Main component ────────────────────────────────────────────
export default function ScanPage() {
  const params   = useParams()
  const schoolId = params.school_id as string

  const [cacheLoaded,   setCacheLoaded]   = useState(false)
  const [cacheCount,    setCacheCount]    = useState(0)
  const [scanResult,    setScanResult]    = useState<ScanResult | null>(null)
  const [queueSize,     setQueueSize]     = useState(0)
  const [online,        setOnline]        = useState(true)
  const [scanCount,     setScanCount]     = useState(0)
  const [gate,          setGate]          = useState('Main Gate')
  const [loadingCache,  setLoadingCache]  = useState(true)
  const [cacheError,    setCacheError]    = useState('')
  const [cameraState,   setCameraState]   = useState<CameraState>('idle')
  const [cameraError,   setCameraError]   = useState('')

  const scannedTodayRef = useRef<Set<string>>(new Set())
  const overlayTimerRef = useRef<NodeJS.Timeout | null>(null)
  const scannerRef      = useRef<any>(null)
  const isScanningRef   = useRef(false)

  // ── Load student cache ────────────────────────────────────
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

      if (error) throw error

      const mapped: CachedStudent[] = (data ?? []).map((s: any) => ({
        id:          s.id,
        full_name:   s.full_name,
        student_uid: s.student_uid ?? '',
        class_name:  s.classes?.name ?? '',
      }))

      await cacheStudents(mapped)
      setCacheCount(mapped.length)
      setCacheLoaded(true)
    } catch {
      setCacheError('Could not load students. Check internet and retry.')
    } finally {
      setLoadingCache(false)
    }
  }, [schoolId])

  // ── Background sync every 5s ──────────────────────────────
  const syncQueue = useCallback(async () => {
    const items = await getQueue()
    if (items.length === 0) { setQueueSize(0); return }
    setQueueSize(items.length)
    try {
      const supabase = createClient()
      const rows = items.map(({ item }) => ({
        school_id:  item.school_id,
        student_id: item.student_id,
        scan_date:  item.scan_date,
        scan_time:  item.scan_time,
        gate:       item.gate,
      }))
      const { error } = await supabase
        .from('attendance')
        .upsert(rows, { onConflict: 'school_id,student_id,scan_date', ignoreDuplicates: true })
      if (!error) {
        await removeFromQueue(items.map(i => i.key))
        setQueueSize(0)
      }
    } catch (_) {}
  }, [])

  // ── Handle decoded QR — expects a Supabase UUID ───────────
  const handleScan = useCallback(async (decodedText: string) => {
    if (isScanningRef.current) return
    isScanningRef.current = true

    const uuid    = decodedText.trim()
    const student = await lookupByUUID(uuid)

    if (!student) {
      playBeep('unknown')
      setScanResult({ type: 'unknown' })
    } else if (scannedTodayRef.current.has(student.id)) {
      playBeep('already')
      setScanResult({ type: 'already', student })
    } else {
      scannedTodayRef.current.add(student.id)
      playBeep('success')
      setScanCount(c => c + 1)
      const now      = new Date()
      const scanDate = now.toISOString().split('T')[0]
      await addToQueue({
        student_id: student.id,
        school_id:  schoolId,
        scan_date:  scanDate,
        scan_time:  now.toISOString(),
        gate,
      })
      setScanResult({ type: 'success', student })
    }

    if (overlayTimerRef.current) clearTimeout(overlayTimerRef.current)
    overlayTimerRef.current = setTimeout(() => {
      setScanResult(null)
      isScanningRef.current = false
    }, 1500)
  }, [schoolId, gate])

  // ── Start scanner with full camera error handling ─────────
  const startScanner = useCallback(async () => {
    if (scannerRef.current) return
    setCameraState('requesting')
    setCameraError('')

    try {
      // Step 1: explicitly request permission first so we get a clear error
      await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
    } catch (err: any) {
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        setCameraState('denied')
        setCameraError('Camera permission denied. Tap the camera icon in your browser address bar and allow access, then refresh.')
      } else if (err.name === 'NotFoundError') {
        setCameraState('error')
        setCameraError('No camera found on this device.')
      } else {
        setCameraState('error')
        setCameraError(`Camera error: ${err.message}`)
      }
      return
    }

    try {
      const { Html5Qrcode } = await import('html5-qrcode')
      const scanner = new Html5Qrcode('qr-reader')
      scannerRef.current = scanner

      await scanner.start(
        { facingMode: 'environment' },
        { fps: 15, qrbox: { width: 260, height: 260 }, aspectRatio: 1.0 },
        handleScan,
        () => {}
      )
      setCameraState('running')
    } catch (err: any) {
      setCameraState('error')
      setCameraError('Could not start scanner. Try refreshing the page.')
      scannerRef.current = null
    }
  }, [handleScan])

  // ── Retry camera after denial ─────────────────────────────
  const retryCamera = useCallback(async () => {
    if (scannerRef.current) {
      await scannerRef.current.stop().catch(() => {})
      scannerRef.current = null
    }
    await startScanner()
  }, [startScanner])

  // ── Realtime broadcast from other guards ──────────────────
  useEffect(() => {
    const supabase = createClient()
    const channel  = supabase.channel(`school:${schoolId}:scans`)
    channel.on('broadcast', { event: 'scan' }, ({ payload }: any) => {
      if (payload?.studentId) scannedTodayRef.current.add(payload.studentId)
    }).subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [schoolId])

  // ── Mount ─────────────────────────────────────────────────
  useEffect(() => {
    try { audioCtx = new AudioContext() } catch (_) {}

    loadCache().then(() => startScanner())

    const onOnline  = () => setOnline(true)
    const onOffline = () => setOnline(false)
    window.addEventListener('online',  onOnline)
    window.addEventListener('offline', onOffline)

    const syncInterval = setInterval(syncQueue, 5000)

    return () => {
      window.removeEventListener('online',  onOnline)
      window.removeEventListener('offline', onOffline)
      clearInterval(syncInterval)
      if (overlayTimerRef.current) clearTimeout(overlayTimerRef.current)
      scannerRef.current?.stop().catch(() => {})
    }
  }, [loadCache, startScanner, syncQueue])

  // ── Overlay ───────────────────────────────────────────────
  const overlayBg =
    scanResult?.type === 'success' ? 'bg-green-500' :
    scanResult?.type === 'already' ? 'bg-amber-400' :
    'bg-red-500'

  const overlayText =
    scanResult?.type === 'success' ? scanResult.student?.full_name ?? 'Present' :
    scanResult?.type === 'already' ? `Already in — ${scanResult.student?.full_name}` :
    'Unknown card'

  const overlaySubtext =
    scanResult?.type === 'success' ? (scanResult.student?.class_name || scanResult.student?.student_uid || '') :
    scanResult?.type === 'already' ? 'Scanned earlier today' :
    'QR code not recognised'

  // ── Camera area content ───────────────────────────────────
  const renderCamera = () => {
    if (loadingCache) {
      return (
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-brand-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-slate-300 text-sm">Loading students…</p>
        </div>
      )
    }

    if (cacheError) {
      return (
        <div className="flex flex-col items-center gap-4 text-center max-w-xs">
          <AlertCircle size={40} className="text-red-400" />
          <p className="text-white font-medium">Could not load student list</p>
          <p className="text-slate-400 text-sm">{cacheError}</p>
          <button onClick={loadCache} className="btn-primary flex items-center gap-2 mt-2">
            <RefreshCw size={15} /> Retry
          </button>
        </div>
      )
    }

    if (cameraState === 'denied') {
      return (
        <div className="flex flex-col items-center gap-4 text-center max-w-xs px-4">
          <div className="w-16 h-16 bg-red-900/40 rounded-full flex items-center justify-center">
            <CameraOff size={32} className="text-red-400" />
          </div>
          <p className="text-white font-semibold text-lg">Camera blocked</p>
          <p className="text-slate-300 text-sm leading-relaxed">{cameraError}</p>
          <div className="bg-slate-700 rounded-xl p-4 text-left w-full">
            <p className="text-slate-300 text-xs font-medium mb-2">To fix on Android Chrome:</p>
            <p className="text-slate-400 text-xs">1. Tap the lock icon in the address bar</p>
            <p className="text-slate-400 text-xs">2. Tap Permissions → Camera → Allow</p>
            <p className="text-slate-400 text-xs">3. Refresh this page</p>
          </div>
          <button onClick={retryCamera} className="btn-primary flex items-center gap-2 w-full justify-center">
            <Camera size={15} /> Try again
          </button>
        </div>
      )
    }

    if (cameraState === 'error') {
      return (
        <div className="flex flex-col items-center gap-4 text-center max-w-xs">
          <CameraOff size={40} className="text-red-400" />
          <p className="text-white font-medium">Camera error</p>
          <p className="text-slate-400 text-sm">{cameraError}</p>
          <button onClick={retryCamera} className="btn-primary flex items-center gap-2 mt-2">
            <RefreshCw size={15} /> Retry
          </button>
        </div>
      )
    }

    return (
      <>
        {/* QR reader — html5-qrcode mounts the video element here */}
        <div
          id="qr-reader"
          className="w-full max-w-sm rounded-2xl overflow-hidden bg-black"
          style={{ minHeight: 320 }}
        />

        {cameraState !== 'running' && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-900/80 rounded-2xl">
            <div className="flex flex-col items-center gap-3">
              <div className="w-10 h-10 border-4 border-white border-t-transparent rounded-full animate-spin" />
              <p className="text-white text-sm">Starting camera…</p>
            </div>
          </div>
        )}

        <div className="mt-4 flex items-center gap-2 bg-slate-800 rounded-full px-4 py-2">
          <div className="w-2 h-2 rounded-full bg-green-400" />
          <span className="text-slate-300 text-xs">
            {cacheCount} students · {gate}
          </span>
        </div>
      </>
    )
  }

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col">

      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-3 bg-slate-800">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 bg-brand-600 rounded-lg flex items-center justify-center">
            <span className="text-white text-xs font-bold">S</span>
          </div>
          <span className="text-white font-semibold text-sm">Schoolium Scanner</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1">
            {online
              ? <Wifi size={14} className="text-green-400" />
              : <WifiOff size={14} className="text-red-400" />}
            {queueSize > 0 && (
              <span className="text-xs text-amber-300">{queueSize} pending</span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Users size={14} className="text-slate-400" />
            <span className="text-white text-sm font-semibold">{scanCount}</span>
          </div>
        </div>
      </div>

      {/* Gate selector */}
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

      {/* Camera area */}
      <div className="flex-1 flex flex-col items-center justify-center px-4 py-6 relative">
        {renderCamera()}

        {/* Scan result overlay — always in DOM, opacity toggled for instant transition */}
        <div
          className={`absolute inset-0 flex flex-col items-center justify-center transition-opacity duration-75 ${
            scanResult ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
          } ${scanResult ? overlayBg : ''}`}
          style={{ zIndex: 10 }}
        >
          <div className="flex flex-col items-center gap-3 px-6 text-center">
            {scanResult?.type === 'success' && <CheckCircle size={72} className="text-white" />}
            {scanResult?.type === 'already'  && <Clock       size={72} className="text-white" />}
            {scanResult?.type === 'unknown'  && <AlertCircle size={72} className="text-white" />}
            <p className="text-white text-3xl font-bold leading-tight">{overlayText}</p>
            <p className="text-white/80 text-lg">{overlaySubtext}</p>
          </div>
        </div>
      </div>

      {/* Bottom bar */}
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
