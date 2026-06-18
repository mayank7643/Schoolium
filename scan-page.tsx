'use client'

// FILE: app/scan/[school_id]/page.tsx
// Updated: entry/exit toggle — two rows per student per day (entry + exit)
// scannedTodayRef keyed by "studentId:entry_type" to allow both scans

import { useEffect, useRef, useState, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { createClient } from '@/utils/supabase/client'
import {
  CheckCircle, AlertCircle, Clock,
  Wifi, WifiOff, Users, RefreshCw,
  Camera, CameraOff, LogOut, ShieldAlert,
  LogIn, LogOut as LogOutIcon, PenLine, Search, X,
} from 'lucide-react'

interface CachedStudent {
  id: string
  full_name: string
  student_uid: string
  class_name: string
}

interface ScanQueueItem {
  student_id: string
  school_id: string
  scan_date: string
  scan_time: string
  gate: string
  guard_id: string
  entry_type: 'entry' | 'exit'   // NEW
}

interface ScanResult {
  type: 'success' | 'already' | 'unknown'
  student?: CachedStudent
  entry_type?: 'entry' | 'exit'  // shown in overlay
}

type CameraState = 'idle' | 'requesting' | 'denied' | 'error' | 'running'

// ── IndexedDB — keyed by student UUID ─────────────────────────
// DB name unchanged — same schema, queue items now include entry_type
const DB_NAME = 'schoolium_scan_v3'

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains('students'))
        db.createObjectStore('students', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('queue'))
        db.createObjectStore('queue', { autoIncrement: true })
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
  return new Promise(resolve => { tx.oncomplete = () => resolve() })
}

async function lookupByUUID(uuid: string): Promise<CachedStudent | null> {
  const db = await openDB()
  return new Promise(resolve => {
    const tx  = db.transaction('students', 'readonly')
    const req = tx.objectStore('students').get(uuid)
    req.onsuccess = () => resolve(req.result ?? null)
    req.onerror   = () => resolve(null)
  })
}

async function addToQueue(item: ScanQueueItem): Promise<void> {
  const db = await openDB()
  return new Promise(resolve => {
    const tx = db.transaction('queue', 'readwrite')
    tx.objectStore('queue').add(item)
    tx.oncomplete = () => resolve()
  })
}

async function getQueue(): Promise<{ key: number; item: ScanQueueItem }[]> {
  const db = await openDB()
  return new Promise(resolve => {
    const results: { key: number; item: ScanQueueItem }[] = []
    const tx  = db.transaction('queue', 'readonly')
    const req = tx.objectStore('queue').openCursor()
    req.onsuccess = (e) => {
      const cursor = (e.target as IDBRequest).result
      if (cursor) { results.push({ key: cursor.key as number, item: cursor.value }); cursor.continue() }
      else resolve(results)
    }
    req.onerror = () => resolve([])
  })
}

async function removeFromQueue(keys: number[]): Promise<void> {
  const db = await openDB()
  return new Promise(resolve => {
    const tx = db.transaction('queue', 'readwrite')
    keys.forEach(k => tx.objectStore('queue').delete(k))
    tx.oncomplete = () => resolve()
  })
}

// ── Audio ──────────────────────────────────────────────────────
let audioCtx: AudioContext | null = null

function playBeep(type: 'success' | 'already' | 'unknown') {
  try {
    if (!audioCtx) audioCtx = new AudioContext()
    if (audioCtx.state === 'suspended') audioCtx.resume()
    const osc = audioCtx.createOscillator()
    const gain = audioCtx.createGain()
    osc.connect(gain); gain.connect(audioCtx.destination)
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

// ── Main component ─────────────────────────────────────────────
export default function ScanPage() {
  const params   = useParams()
  const router   = useRouter()
  const urlSchoolId = params.school_id as string

  const [authChecked,  setAuthChecked]  = useState(false)
  const [guardId,      setGuardId]      = useState('')
  const [guardName,    setGuardName]    = useState('')
  const [guardGate,    setGuardGate]    = useState('Main Gate')
  const [schoolId,     setSchoolId]     = useState('')
  const [unauthorized, setUnauthorized] = useState(false)

  const [cacheLoaded,  setCacheLoaded]  = useState(false)
  const [cacheCount,   setCacheCount]   = useState(0)
  const [cacheError,   setCacheError]   = useState('')
  const [loadingCache, setLoadingCache] = useState(true)

  const [scanResult,   setScanResult]   = useState<ScanResult | null>(null)
  const [queueSize,    setQueueSize]    = useState(0)
  const [online,       setOnline]       = useState(true)
  const [scanCount,    setScanCount]    = useState(0)
  const [gate,         setGate]         = useState('Main Gate')
  const [entryType,    setEntryType]    = useState<'entry' | 'exit'>('entry')
  const [cameraState,  setCameraState]  = useState<CameraState>('idle')
  const [cameraError,  setCameraError]  = useState('')

  // Manual entry bottom sheet
  const [showManual,     setShowManual]     = useState(false)
  const [manualSearch,   setManualSearch]   = useState('')
  const [manualResults,  setManualResults]  = useState<CachedStudent[]>([])
  const [manualSelected, setManualSelected] = useState<CachedStudent | null>(null)
  const [manualLoading,  setManualLoading]  = useState(false)
  const searchTimerRef = useRef<NodeJS.Timeout | null>(null)

  // KEY CHANGE: scanned set keyed by "studentId:entry_type"
  // This allows same student to have both an entry and exit scan in same session
  const scannedTodayRef = useRef<Set<string>>(new Set())
  const overlayTimerRef = useRef<NodeJS.Timeout | null>(null)
  const scannerRef      = useRef<any>(null)
  const isScanningRef   = useRef(false)
  const entryTypeRef    = useRef<'entry' | 'exit'>('entry')  // ref so handleScan never needs to re-create

  // Keep ref in sync — handleScan reads from ref so camera never restarts on toggle
  useEffect(() => { entryTypeRef.current = entryType }, [entryType])

  // ── Step 1: Auth check ──────────────────────────────────────
  useEffect(() => {
    async function checkAuth() {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()

      if (!user) {
        router.replace('/login')
        return
      }

      const { data: profile } = await supabase
        .from('profiles')
        .select('id, full_name, role, school_id, gate, is_active')
        .eq('id', user.id)
        .single()

      if (!profile || !profile.is_active ||
          !['guard', 'school_admin'].includes(profile.role)) {
        setUnauthorized(true)
        setAuthChecked(true)
        return
      }

      if (profile.school_id !== urlSchoolId) {
        setUnauthorized(true)
        setAuthChecked(true)
        return
      }

      setGuardId(user.id)
      setGuardName(profile.full_name)
      setGuardGate(profile.gate ?? 'Main Gate')
      setGate(profile.gate ?? 'Main Gate')
      setSchoolId(profile.school_id)
      setAuthChecked(true)
    }
    checkAuth()
  }, [urlSchoolId, router])

  // ── Step 2: Load student cache ──────────────────────────────
  const loadCache = useCallback(async () => {
    if (!schoolId) return
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
        class_name:  Array.isArray(s.classes) ? s.classes[0]?.name ?? '' : s.classes?.name ?? '',
      }))

      await cacheStudents(mapped)
      setCacheCount(mapped.length)
      setCacheLoaded(true)
    } catch {
      setCacheError('Could not load students. Check connection and retry.')
    } finally {
      setLoadingCache(false)
    }
  }, [schoolId])

  // ── Step 3: Background sync ─────────────────────────────────
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
        guard_id:   item.guard_id,
        entry_type: item.entry_type ?? 'entry',   // NEW — default 'entry' for old queued items
      }))
      const { error } = await supabase
        .from('attendance')
        .upsert(rows, {
          onConflict: 'school_id,student_id,scan_date,entry_type',  // NEW conflict key
          ignoreDuplicates: true,
        })
      if (!error) { await removeFromQueue(items.map(i => i.key)); setQueueSize(0) }
    } catch (_) {}
  }, [])

  // ── Handle QR scan ──────────────────────────────────────────
  const handleScan = useCallback(async (decodedText: string) => {
    if (isScanningRef.current) return
    isScanningRef.current = true

    const uuid    = decodedText.trim()
    const student = await lookupByUUID(uuid)

    // Read from ref — not state — so this callback never needs to be recreated
    const currentEntryType = entryTypeRef.current
    const scanKey = student ? `${student.id}:${currentEntryType}` : ''

    if (!student) {
      playBeep('unknown')
      setScanResult({ type: 'unknown' })
    } else if (scannedTodayRef.current.has(scanKey)) {
      playBeep('already')
      setScanResult({ type: 'already', student, entry_type: currentEntryType })
    } else {
      scannedTodayRef.current.add(scanKey)
      playBeep('success')
      setScanCount(c => c + 1)
      const now = new Date()
      await addToQueue({
        student_id: student.id,
        school_id:  schoolId,
        scan_date:  now.toISOString().split('T')[0],
        scan_time:  now.toISOString(),
        gate,
        guard_id:   guardId,
        entry_type: currentEntryType,
      })
      setScanResult({ type: 'success', student, entry_type: currentEntryType })
    }

    if (overlayTimerRef.current) clearTimeout(overlayTimerRef.current)
    overlayTimerRef.current = setTimeout(() => {
      setScanResult(null)
      isScanningRef.current = false
    }, 1500)
  }, [schoolId, gate, guardId])  // entryType removed — read from ref instead

  // ── Start camera ────────────────────────────────────────────
  const startScanner = useCallback(async () => {
    if (scannerRef.current) return
    setCameraState('requesting')
    setCameraError('')
    try {
      await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
    } catch (err: any) {
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        setCameraState('denied')
        setCameraError('Camera permission denied. Tap the lock icon in the address bar → allow camera → refresh.')
      } else {
        setCameraState('error')
        setCameraError('Could not access camera. Try refreshing.')
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
    } catch {
      setCameraState('error')
      setCameraError('Scanner failed to start. Try refreshing.')
      scannerRef.current = null
    }
  }, [handleScan])

  // ── Realtime ────────────────────────────────────────────────
  useEffect(() => {
    if (!schoolId) return
    const supabase = createClient()
    const channel  = supabase.channel(`school:${schoolId}:scans`)
    channel.on('broadcast', { event: 'scan' }, ({ payload }: any) => {
      // payload now includes entry_type so we key correctly
      if (payload?.studentId && payload?.entryType) {
        scannedTodayRef.current.add(`${payload.studentId}:${payload.entryType}`)
      }
    }).subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [schoolId])

  // ── Mount ───────────────────────────────────────────────────
  useEffect(() => {
    if (!authChecked || !schoolId) return
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
  }, [authChecked, schoolId, loadCache, startScanner, syncQueue])

  async function handleLogout() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
  }

  // ── Manual entry: search students ─────────────────────────
  // Reads from IndexedDB first (<5ms). If cache is empty or
  // query has no results, falls back to Supabase.
  async function searchStudents(query: string) {
    if (!query.trim()) { setManualResults([]); return }
    setManualLoading(true)
    const q = query.trim().toLowerCase()

    // Try IndexedDB cache first
    try {
      const db = await openDB()
      const results: CachedStudent[] = []
      await new Promise<void>(resolve => {
        const tx  = db.transaction('students', 'readonly')
        const req = tx.objectStore('students').openCursor()
        req.onsuccess = (e) => {
          const cursor = (e.target as IDBRequest).result
          if (cursor) {
            const s = cursor.value as CachedStudent
            if (s.full_name.toLowerCase().includes(q) || s.student_uid.toLowerCase().includes(q))
              results.push(s)
            cursor.continue()
          } else resolve()
        }
        req.onerror = () => resolve()
      })
      if (results.length > 0) {
        setManualResults(results.slice(0, 8))
        setManualLoading(false)
        return
      }
    } catch (_) {}

    // Fallback: Supabase (if cache miss or empty)
    try {
      const supabase = createClient()
      const { data } = await supabase
        .from('students')
        .select('id, full_name, student_uid, classes(name)')
        .eq('school_id', schoolId)
        .eq('is_active', true)
        .ilike('full_name', `%${query.trim()}%`)
        .limit(8)
      const mapped: CachedStudent[] = (data ?? []).map((s: any) => ({
        id:          s.id,
        full_name:   s.full_name,
        student_uid: s.student_uid ?? '',
        class_name:  Array.isArray(s.classes) ? s.classes[0]?.name ?? '' : s.classes?.name ?? '',
      }))
      setManualResults(mapped)
    } catch (_) { setManualResults([]) }
    setManualLoading(false)
  }

  // Debounced search — 350ms, same as rest of app
  function handleManualSearchChange(value: string) {
    setManualSearch(value)
    setManualSelected(null)
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(() => searchStudents(value), 350)
  }

  // ── Manual entry: confirm ──────────────────────────────────
  // Goes through exact same path as a QR scan — same queue,
  // same scannedTodayRef, same overlay, same beep.
  async function confirmManualEntry() {
    if (!manualSelected || isScanningRef.current) return
    isScanningRef.current = true

    const student          = manualSelected
    const currentEntryType = entryTypeRef.current
    const scanKey          = `${student.id}:${currentEntryType}`

    // Close sheet first so overlay is visible
    setShowManual(false)
    setManualSearch('')
    setManualResults([])
    setManualSelected(null)

    if (scannedTodayRef.current.has(scanKey)) {
      playBeep('already')
      setScanResult({ type: 'already', student, entry_type: currentEntryType })
    } else {
      scannedTodayRef.current.add(scanKey)
      playBeep('success')
      setScanCount(c => c + 1)
      const now = new Date()
      await addToQueue({
        student_id: student.id,
        school_id:  schoolId,
        scan_date:  now.toISOString().split('T')[0],
        scan_time:  now.toISOString(),
        gate,
        guard_id:   guardId,
        entry_type: currentEntryType,
      })
      setScanResult({ type: 'success', student, entry_type: currentEntryType })
    }

    if (overlayTimerRef.current) clearTimeout(overlayTimerRef.current)
    overlayTimerRef.current = setTimeout(() => {
      setScanResult(null)
      isScanningRef.current = false
    }, 1500)
  }

  // ── Loading ─────────────────────────────────────────────────
  if (!authChecked) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-4 border-brand-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-slate-400 text-sm">Verifying access…</p>
        </div>
      </div>
    )
  }

  // ── Unauthorized ────────────────────────────────────────────
  if (unauthorized) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center px-6">
        <div className="flex flex-col items-center gap-4 text-center max-w-xs">
          <div className="w-16 h-16 bg-red-900/40 rounded-full flex items-center justify-center">
            <ShieldAlert size={32} className="text-red-400" />
          </div>
          <p className="text-white text-xl font-bold">Access denied</p>
          <p className="text-slate-400 text-sm">
            You don&apos;t have permission to access this school&apos;s scanner.
          </p>
          <button onClick={handleLogout} className="btn-primary flex items-center gap-2 mt-2">
            <LogOut size={15} /> Sign out
          </button>
        </div>
      </div>
    )
  }

  // ── Overlay content ─────────────────────────────────────────
  const entryLabel = scanResult?.entry_type === 'exit' ? 'Exit' : 'Entry'

  const overlayBg =
    scanResult?.type === 'success' ? (scanResult.entry_type === 'exit' ? 'bg-blue-500' : 'bg-green-500') :
    scanResult?.type === 'already' ? 'bg-amber-400' : 'bg-red-500'

  const overlayText =
    scanResult?.type === 'success' ? scanResult.student?.full_name ?? 'Present' :
    scanResult?.type === 'already' ? `Already ${entryLabel.toLowerCase()}ed — ${scanResult.student?.full_name}` :
    'Unknown card'

  const overlaySubtext =
    scanResult?.type === 'success' ? `${entryLabel} · ${scanResult.student?.class_name || scanResult.student?.student_uid || ''}` :
    scanResult?.type === 'already' ? `${entryLabel} already recorded today` :
    'QR not recognised'

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col">

      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-3 bg-slate-800">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 bg-brand-600 rounded-lg flex items-center justify-center">
            <span className="text-white text-xs font-bold">S</span>
          </div>
          <div>
            <p className="text-white text-sm font-semibold leading-tight">Schoolium Scanner</p>
            {guardName && <p className="text-slate-400 text-xs leading-tight">{guardName}</p>}
          </div>
        </div>
        <div className="flex items-center gap-3">
          {online
            ? <Wifi size={14} className="text-green-400" />
            : <WifiOff size={14} className="text-red-400" />}
          {queueSize > 0 && (
            <span className="text-xs text-amber-300">{queueSize} pending</span>
          )}
          <div className="flex items-center gap-1">
            <Users size={14} className="text-slate-400" />
            <span className="text-white text-sm font-semibold">{scanCount}</span>
          </div>
          <button onClick={handleLogout}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-slate-700 transition-colors">
            <LogOut size={14} className="text-slate-400" />
          </button>
        </div>
      </div>

      {/* Gate + Entry/Exit controls */}
      <div className="px-4 py-2 bg-slate-800 border-t border-slate-700 flex items-center justify-between gap-3">
        {/* Gate selector */}
        <div className="flex gap-1.5 flex-1">
          {['Main Gate', 'Side Gate', 'Back Gate'].map(g => (
            <button key={g} onClick={() => setGate(g)}
              className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                gate === g ? 'bg-brand-600 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
              }`}>
              {g.replace(' Gate', '')}
            </button>
          ))}
        </div>

        {/* Entry / Exit toggle */}
        <div className="flex items-center bg-slate-700 rounded-full p-0.5 shrink-0">
          <button
            onClick={() => setEntryType('entry')}
            className={`flex items-center gap-1 px-3 py-1 rounded-full text-xs font-semibold transition-all ${
              entryType === 'entry'
                ? 'bg-green-500 text-white shadow'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <LogIn size={11} />
            Entry
          </button>
          <button
            onClick={() => setEntryType('exit')}
            className={`flex items-center gap-1 px-3 py-1 rounded-full text-xs font-semibold transition-all ${
              entryType === 'exit'
                ? 'bg-blue-500 text-white shadow'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <LogOutIcon size={11} />
            Exit
          </button>
        </div>
      </div>

      {/* Camera area */}
      <div className="flex-1 flex flex-col items-center justify-center px-4 py-6 relative">

        {loadingCache ? (
          <div className="flex flex-col items-center gap-4">
            <div className="w-12 h-12 border-4 border-brand-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-slate-300 text-sm">Loading students…</p>
          </div>
        ) : cacheError ? (
          <div className="flex flex-col items-center gap-4 text-center max-w-xs">
            <AlertCircle size={40} className="text-red-400" />
            <p className="text-white font-medium">Could not load student list</p>
            <p className="text-slate-400 text-sm">{cacheError}</p>
            <button onClick={loadCache} className="btn-primary flex items-center gap-2">
              <RefreshCw size={15} /> Retry
            </button>
          </div>
        ) : cameraState === 'denied' ? (
          <div className="flex flex-col items-center gap-4 text-center max-w-xs px-4">
            <div className="w-16 h-16 bg-red-900/40 rounded-full flex items-center justify-center">
              <CameraOff size={32} className="text-red-400" />
            </div>
            <p className="text-white font-semibold text-lg">Camera blocked</p>
            <p className="text-slate-300 text-sm">{cameraError}</p>
            <button onClick={startScanner} className="btn-primary flex items-center gap-2">
              <Camera size={15} /> Try again
            </button>
          </div>
        ) : cameraState === 'error' ? (
          <div className="flex flex-col items-center gap-4 text-center max-w-xs">
            <CameraOff size={40} className="text-red-400" />
            <p className="text-white font-medium">{cameraError}</p>
            <button onClick={startScanner} className="btn-primary flex items-center gap-2">
              <RefreshCw size={15} /> Retry
            </button>
          </div>
        ) : (
          <>
            <div id="qr-reader"
              className="w-full max-w-sm rounded-2xl overflow-hidden bg-black"
              style={{ minHeight: 320 }} />
            {cameraState !== 'running' && (
              <div className="absolute inset-0 flex items-center justify-center bg-slate-900/80 rounded-2xl">
                <div className="flex flex-col items-center gap-3">
                  <div className="w-10 h-10 border-4 border-white border-t-transparent rounded-full animate-spin" />
                  <p className="text-white text-sm">Starting camera…</p>
                </div>
              </div>
            )}
            <div className="mt-4 flex items-center gap-2 bg-slate-800 rounded-full px-4 py-2">
              <div className={`w-2 h-2 rounded-full ${entryType === 'entry' ? 'bg-green-400' : 'bg-blue-400'}`} />
              <span className="text-slate-300 text-xs">
                {cacheCount} students · {gate} · {entryType === 'entry' ? 'Entry' : 'Exit'}
              </span>
            </div>
          </>
        )}

        {/* Scan overlay — always in DOM for instant opacity transition */}
        <div className={`absolute inset-0 flex flex-col items-center justify-center transition-opacity duration-75 ${
          scanResult ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        } ${scanResult ? overlayBg : ''}`} style={{ zIndex: 10 }}>
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
          <span className="text-slate-400 text-xs">{cacheLoaded ? 'Offline ready' : 'Loading…'}</span>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => { setShowManual(true); setManualSearch(''); setManualResults([]); setManualSelected(null) }}
            className="flex items-center gap-1.5 bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs font-medium px-3 py-1.5 rounded-full transition-colors">
            <PenLine size={12} /> Manual Entry
          </button>
          <button onClick={loadCache}
            className="flex items-center gap-1 text-slate-400 hover:text-white text-xs transition-colors">
            <RefreshCw size={12} /> Refresh
          </button>
        </div>
      </div>

      {/* Manual Entry bottom sheet */}
      {showManual && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => setShowManual(false)}
          />
          {/* Sheet */}
          <div className="relative bg-slate-800 rounded-t-2xl px-4 pt-4 pb-8 flex flex-col max-h-[80vh]">
            {/* Handle + header */}
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="text-white font-semibold text-base">Manual Entry</p>
                <p className="text-slate-400 text-xs mt-0.5">
                  {entryType === 'entry' ? 'Mark entry' : 'Mark exit'} · {gate}
                </p>
              </div>
              <button
                onClick={() => setShowManual(false)}
                className="w-8 h-8 flex items-center justify-center rounded-full bg-slate-700 text-slate-400 hover:text-white">
                <X size={16} />
              </button>
            </div>

            {/* Search input */}
            <div className="relative mb-3">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                autoFocus
                type="text"
                value={manualSearch}
                onChange={e => handleManualSearchChange(e.target.value)}
                placeholder="Search student name or UID…"
                className="w-full bg-slate-700 text-white text-sm rounded-xl pl-9 pr-4 py-2.5 placeholder:text-slate-500 outline-none focus:ring-2 focus:ring-brand-500"
              />
              {manualLoading && (
                <div className="absolute right-3 top-1/2 -translate-y-1/2">
                  <div className="w-3.5 h-3.5 border-2 border-brand-400 border-t-transparent rounded-full animate-spin" />
                </div>
              )}
            </div>

            {/* Results list */}
            <div className="flex-1 overflow-y-auto flex flex-col gap-1 min-h-0">
              {manualSearch.trim() === '' && (
                <p className="text-slate-500 text-sm text-center py-6">Type a student name to search</p>
              )}
              {manualSearch.trim() !== '' && !manualLoading && manualResults.length === 0 && (
                <p className="text-slate-500 text-sm text-center py-6">No students found</p>
              )}
              {manualResults.map(student => {
                const scanKey = `${student.id}:${entryType}`
                const alreadyScanned = scannedTodayRef.current.has(scanKey)
                const isSelected = manualSelected?.id === student.id
                return (
                  <button
                    key={student.id}
                    onClick={() => setManualSelected(isSelected ? null : student)}
                    disabled={alreadyScanned}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-colors ${
                      alreadyScanned
                        ? 'opacity-40 cursor-not-allowed bg-slate-700/30'
                        : isSelected
                          ? entryType === 'entry'
                            ? 'bg-green-500/20 border border-green-500/50'
                            : 'bg-blue-500/20 border border-blue-500/50'
                          : 'hover:bg-slate-700 border border-transparent'
                    }`}
                  >
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-sm font-bold ${
                      isSelected
                        ? entryType === 'entry' ? 'bg-green-500 text-white' : 'bg-blue-500 text-white'
                        : 'bg-slate-600 text-slate-200'
                    }`}>
                      {student.full_name.charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-white text-sm font-medium truncate">{student.full_name}</p>
                      <p className="text-slate-400 text-xs">{student.class_name} · <span className="font-mono">{student.student_uid}</span></p>
                    </div>
                    {alreadyScanned && (
                      <span className="text-xs text-slate-500 shrink-0">Already {entryType === 'entry' ? 'entered' : 'exited'}</span>
                    )}
                    {isSelected && !alreadyScanned && (
                      <CheckCircle size={16} className={entryType === 'entry' ? 'text-green-400 shrink-0' : 'text-blue-400 shrink-0'} />
                    )}
                  </button>
                )
              })}
            </div>

            {/* Confirm button */}
            {manualSelected && (
              <button
                onClick={confirmManualEntry}
                className={`mt-4 w-full py-3 rounded-xl font-semibold text-white flex items-center justify-center gap-2 transition-colors ${
                  entryType === 'entry' ? 'bg-green-500 hover:bg-green-600' : 'bg-blue-500 hover:bg-blue-600'
                }`}
              >
                {entryType === 'entry' ? <LogIn size={16} /> : <LogOutIcon size={16} />}
                Confirm {entryType === 'entry' ? 'Entry' : 'Exit'} — {manualSelected.full_name}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
