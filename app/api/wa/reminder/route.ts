// FILE: app/api/wa/reminder/route.ts
//
// Manual "send reminder now" for the defaulters page. Routes through the SAME
// outbox + worker path as the automated sweep (single send path). It:
//   1. verifies the caller (admin session via cookies),
//   2. enqueues reminder rows via enqueue_fee_reminders_for() (which self-checks
//      the admin, the feature flag, phone/opt-out, and dedup guards),
//   3. asks the worker to process just those rows immediately, so the admin gets
//      an instant sent/skipped/failed summary instead of waiting for the cron.

import { NextResponse } from 'next/server'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  let body: { student_ids?: string[]; reminder_type?: 'due' | 'overdue' } = {}
  try { body = await req.json() } catch { return NextResponse.json({ error: 'bad_json' }, { status: 400 }) }

  const ids = (body.student_ids || []).filter(Boolean)
  const type = body.reminder_type
  if (!ids.length || (type !== 'due' && type !== 'overdue')) {
    return NextResponse.json({ error: 'student_ids and reminder_type are required' }, { status: 400 })
  }
  if (ids.length > 100) {
    return NextResponse.json({ error: 'Maximum 100 students per request' }, { status: 400 })
  }

  // Enqueue (RPC verifies admin + flag + dedup, runs as the caller).
  const { data, error } = await supabase.rpc('enqueue_fee_reminders_for', {
    p_student_ids: ids,
    p_type: type,
  })

  if (error) {
    const m = error.message || ''
    if (m.includes('feature_off')) {
      return NextResponse.json({ error: 'feature_off' }, { status: 409 })
    }
    if (m.includes('Access denied')) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
    return NextResponse.json({ error: m }, { status: 400 })
  }

  const outboxIds = ((data as Array<{ outbox_id: string }>) || []).map((r) => r.outbox_id).filter(Boolean)

  // Nothing new to send (all deduped / no dues / no phone).
  if (!outboxIds.length) {
    return NextResponse.json({ ok: true, enqueued: 0, worker: { processed: 0, sent: 0, skipped: 0, failed: 0 } })
  }

  // Trigger the worker to process exactly these rows now.
  let worker: unknown = null
  try {
    const origin = new URL(req.url).origin
    const res = await fetch(`${origin}/api/wa/worker`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-cron-secret': process.env.CRON_SECRET || '' },
      body: JSON.stringify({ outbox_ids: outboxIds, limit: Math.min(outboxIds.length, 50) }),
    })
    worker = await res.json().catch(() => null)
  } catch {
    // If the immediate trigger fails, the 2-minute cron will still drain them.
    worker = { deferred: true }
  }

  return NextResponse.json({ ok: true, enqueued: outboxIds.length, worker })
}
