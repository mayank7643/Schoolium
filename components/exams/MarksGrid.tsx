'use client'

// FILE: components/exams/MarksGrid.tsx
// Keyboard-first marks grid, used in entry mode (autosave via
// save_marks_bulk) and read-only review mode (verify/approve).

import { useState, useEffect, useRef, useCallback } from 'react'
import { createClient } from '@/utils/supabase/client'
import type { MarksGridData, MarksGridRow, SubmissionStatus } from '@/types'

interface Props {
  examSubjectId: string
  reload: number             // bump to force refetch
  onStatus?: (s: SubmissionStatus) => void
  onProgress?: (entered: number, total: number) => void
}

type Draft = Record<string, Partial<MarksGridRow>>

const COMP_KEYS = ['theory', 'practical', 'internal', 'grace'] as const
type CompKey = (typeof COMP_KEYS)[number]

export default function MarksGrid({ examSubjectId, reload, onStatus, onProgress }: Props) {
  const [data, setData] = useState<MarksGridData | null>(null)
  const [draft, setDraft] = useState<Draft>({})
  const [saving, setSaving] = useState(false)
  const [rejected, setRejected] = useState<Record<string, string>>({})
  const [savedTick, setSavedTick] = useState<Record<string, number>>({})
  const [error, setError] = useState('')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<Set<string>>(new Set())

  const fetchGrid = useCallback(async () => {
    const supabase = createClient()
    const { data: d, error } = await supabase.rpc('get_marks_grid', { p_exam_subject_id: examSubjectId })
    if (error) { setError(error.message); return }
    const grid = d as MarksGridData
    setData(grid)
    setDraft({})
    onStatus?.(grid.status)
    const entered = grid.rows.filter(r => r.is_absent || r.is_exempted || r.total !== null
      || r.theory !== null || r.practical !== null || r.internal !== null).length
    onProgress?.(entered, grid.rows.length)
  }, [examSubjectId, onStatus, onProgress])

  useEffect(() => { fetchGrid() }, [fetchGrid, reload])

  const cols: CompKey[] = data
    ? COMP_KEYS.filter(k => k === 'grace'
        ? true
        : k === 'theory' ? data.max_theory > 0
        : k === 'practical' ? data.max_practical > 0
        : data.max_internal > 0)
    : []

  function maxFor(k: CompKey): number | null {
    if (!data) return null
    return k === 'theory' ? data.max_theory : k === 'practical' ? data.max_practical
      : k === 'internal' ? data.max_internal : null
  }

  function effective(r: MarksGridRow): Partial<MarksGridRow> {
    return { ...r, ...draft[r.student_id] }
  }

  function scheduleSave(studentId: string) {
    pending.current.add(studentId)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(flush, 800)
  }

  async function flush() {
    if (!data || pending.current.size === 0) return
    const ids = Array.from(pending.current)
    pending.current.clear()
    const rowsPayload = ids.map(id => {
      const eff = effective(data.rows.find(r => r.student_id === id)!)
      return {
        student_id: id,
        theory: eff.theory ?? null,
        practical: eff.practical ?? null,
        internal: eff.internal ?? null,
        grace: eff.grace ?? 0,
        is_absent: eff.is_absent ?? false,
        is_exempted: eff.is_exempted ?? false,
      }
    })
    setSaving(true)
    const supabase = createClient()
    const { data: res, error } = await supabase.rpc('save_marks_bulk', {
      p_exam_subject_id: examSubjectId, p_rows: rowsPayload,
    })
    setSaving(false)
    if (error) { setError(error.message); return }
    const result = res as { saved: number; rejected: Array<{ student_id: string; reason: string }> }
    const rej: Record<string, string> = {}
    result.rejected.forEach(r => { rej[r.student_id] = r.reason })
    setRejected(prev => {
      const next = { ...prev }
      ids.forEach(id => { if (rej[id]) next[id] = rej[id]; else delete next[id] })
      return next
    })
    const now = Date.now()
    setSavedTick(prev => {
      const next = { ...prev }
      ids.forEach(id => { if (!rej[id]) next[id] = now })
      return next
    })
    // reflect saved values into base data; drop drafts that succeeded
    setData(prev => {
      if (!prev) return prev
      const rows = prev.rows.map(r => ids.includes(r.student_id) && !rej[r.student_id]
        ? { ...r, ...draft[r.student_id] } as MarksGridRow
        : r)
      const entered = rows.filter(r => r.is_absent || r.is_exempted
        || r.theory !== null || r.practical !== null || r.internal !== null).length
      onProgress?.(entered, rows.length)
      return { ...prev, rows }
    })
    setDraft(prev => {
      const next = { ...prev }
      ids.forEach(id => { if (!rej[id]) delete next[id] })
      return next
    })
  }

  function update(studentId: string, patch: Partial<MarksGridRow>) {
    setDraft(prev => ({ ...prev, [studentId]: { ...prev[studentId], ...patch } }))
    scheduleSave(studentId)
  }

  function onCell(studentId: string, k: CompKey, raw: string) {
    const val = raw === '' ? null : Number(raw)
    update(studentId, { [k]: val } as Partial<MarksGridRow>)
  }

  function toggleAbsent(r: MarksGridRow) {
    const eff = effective(r)
    const next = !eff.is_absent
    update(r.student_id, next
      ? { is_absent: true, is_exempted: false, theory: null, practical: null, internal: null, grace: 0 }
      : { is_absent: false })
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>, rowIdx: number, colIdx: number) {
    const move = (dr: number, dc: number) => {
      e.preventDefault()
      const sel = `[data-cell="${rowIdx + dr}-${colIdx + dc}"]`
      const el = document.querySelector<HTMLInputElement>(sel)
      el?.focus(); el?.select()
    }
    if (e.key === 'Enter' || e.key === 'ArrowDown') move(1, 0)
    else if (e.key === 'ArrowUp') move(-1, 0)
    else if (e.key === 'ArrowRight' && (e.target as HTMLInputElement).selectionStart === (e.target as HTMLInputElement).value.length) move(0, 1)
    else if (e.key === 'ArrowLeft' && (e.target as HTMLInputElement).selectionStart === 0) move(0, -1)
  }

  if (!data) return <div className="card h-64 animate-pulse bg-slate-50" />

  const editable = data.can_edit

  return (
    <div>
      {error && <div className="bg-red-50 text-red-600 text-sm px-4 py-2 rounded-lg mb-3">{error}</div>}
      <div className="flex items-center justify-between mb-2 text-xs text-slate-400">
        <span>Max: theory {data.max_theory}{data.max_practical > 0 ? ` · practical ${data.max_practical}` : ''}{data.max_internal > 0 ? ` · internal ${data.max_internal}` : ''} · pass {data.pass_marks}</span>
        <span>{saving ? 'Saving…' : editable ? 'Autosaves as you type' : 'Read-only'}</span>
      </div>
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[560px]">
            <thead>
              <tr className="text-left text-xs text-slate-400 border-b border-slate-100">
                <th className="px-3 py-2.5 font-medium w-12 sticky left-0 bg-white">Roll</th>
                <th className="px-3 py-2.5 font-medium sticky left-12 bg-white">Student</th>
                {cols.map(k => <th key={k} className="px-2 py-2.5 font-medium text-center capitalize">{k}</th>)}
                <th className="px-2 py-2.5 font-medium text-center">Total</th>
                <th className="px-2 py-2.5 font-medium text-center">Abs</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {data.rows.map((r, ri) => {
                const eff = effective(r)
                const isRej = !!rejected[r.student_id]
                const total = eff.is_absent || eff.is_exempted ? null
                  : (Number(eff.theory ?? 0) + Number(eff.practical ?? 0) + Number(eff.internal ?? 0) + Number(eff.grace ?? 0))
                const fail = total !== null && total < data.pass_marks
                return (
                  <tr key={r.student_id} className={isRej ? 'bg-red-50/40' : ''}>
                    <td className="px-3 py-1.5 font-semibold text-slate-600 sticky left-0 bg-white">{r.roll_number}</td>
                    <td className="px-3 py-1.5 sticky left-12 bg-white">
                      <span className="text-slate-800">{r.full_name}</span>
                      {r.session_exempted && <span className="ml-1 text-[10px] text-blue-500">EX</span>}
                      {r.room_status === 'absent' && !eff.is_absent && (
                        <span className="ml-1 text-[10px] text-amber-500">absent in room</span>
                      )}
                      {isRej && <p className="text-[10px] text-red-600">{rejected[r.student_id]}</p>}
                    </td>
                    {cols.map((k, ci) => {
                      const mx = maxFor(k)
                      const disabled = !editable || eff.is_absent || eff.is_exempted
                      return (
                        <td key={k} className="px-1 py-1 text-center">
                          <input
                            data-cell={`${ri}-${ci}`}
                            type="number" min={0} max={mx ?? undefined}
                            disabled={disabled}
                            value={eff[k] ?? ''}
                            onChange={e => onCell(r.student_id, k, e.target.value)}
                            onKeyDown={e => onKey(e, ri, ci)}
                            onFocus={e => e.target.select()}
                            className={`w-14 text-center rounded border px-1 py-1 text-sm ${disabled ? 'bg-slate-50 text-slate-300 border-slate-100' : 'border-slate-200 focus:border-brand-400 focus:ring-1 focus:ring-brand-200'}`}
                          />
                        </td>
                      )
                    })}
                    <td className={`px-2 py-1.5 text-center font-semibold ${total === null ? 'text-slate-300' : fail ? 'text-red-500' : 'text-slate-700'}`}>
                      {eff.is_absent ? 'AB' : eff.is_exempted ? 'EX' : total ?? '—'}
                      {savedTick[r.student_id] && Date.now() - savedTick[r.student_id] < 2000 && (
                        <span className="ml-1 text-emerald-500 text-xs">✓</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      <input type="checkbox" checked={eff.is_absent ?? false}
                        disabled={!editable}
                        onChange={() => toggleAbsent(r)} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
