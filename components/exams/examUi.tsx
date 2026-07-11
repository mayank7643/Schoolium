// FILE: components/exams/examUi.tsx
// Shared exam-module UI atoms: status badges + date/time formatting.
// Status colour system is fixed module-wide (docs/exam-module Step 7).

import type { ExamStatus, SessionStatus } from '@/types'

export const EXAM_STATUS_STYLE: Record<ExamStatus, string> = {
  draft:     'bg-slate-100 text-slate-600',
  published: 'bg-blue-50 text-blue-700',
  ongoing:   'bg-amber-50 text-amber-700',
  completed: 'bg-emerald-50 text-emerald-700',
  locked:    'bg-purple-50 text-purple-700',
  cancelled: 'bg-red-50 text-red-600',
}

export const SESSION_STATUS_STYLE: Record<SessionStatus, string> = {
  upcoming: 'bg-blue-50 text-blue-700',
  active:   'bg-emerald-50 text-emerald-700',
  locked:   'bg-purple-50 text-purple-700',
  archived: 'bg-slate-100 text-slate-500',
}

export function ExamStatusBadge({ status }: { status: ExamStatus }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium capitalize ${EXAM_STATUS_STYLE[status]}`}>
      {status === 'ongoing' && <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />}
      {status}
    </span>
  )
}

export function SessionStatusBadge({ status }: { status: SessionStatus }) {
  return (
    <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium capitalize ${SESSION_STATUS_STYLE[status]}`}>
      {status}
    </span>
  )
}

export function formatDate(d: string | null | undefined): string {
  if (!d) return '—'
  return new Date(d + 'T00:00:00').toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
  })
}

export function formatTime(t: string | null | undefined): string {
  if (!t) return '—'
  const [h, m] = t.split(':').map(Number)
  const am = h < 12
  const hr = h % 12 === 0 ? 12 : h % 12
  return `${hr}:${String(m).padStart(2, '0')} ${am ? 'AM' : 'PM'}`
}

export function classLabel(c: { name: string; section: string | null } | undefined | null): string {
  if (!c) return '—'
  return c.section ? `${c.name}-${c.section}` : c.name
}
