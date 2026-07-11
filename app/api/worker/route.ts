// FILE: app/api/worker/route.ts
//
// THE message worker for the BYOG alerts pipeline (chat21). Nothing
// else in the system sends. It holds no business logic: claim a row,
// decrypt a credential, call an adapter, write a status. All guards
// (consent, dedupe, quiet hours, rate limit, spend cap) already ran
// inside alerts_enqueue_for_event() before the row ever existed.
//
// TRIGGERED BY:
//   pg_cron 'alerts-worker-tick' every minute ->
//     POST /api/worker  (Authorization: Bearer ALERTS_WORKER_SECRET)
//
// The morning burst (blueprint section 7): pg_cron is 1-minute
// granular, so during 07:00-10:00 IST one invocation loops for up to
// ~50s polling claim_outbox_batch() every 5s - effective sub-10s
// latency with a single cron entry. Outside the window it drains one
// batch and exits.
//
// Concurrency story: claim_outbox_batch() uses FOR UPDATE SKIP LOCKED,
// so overlapping invocations never double-send.
//
// Node runtime: the vault key (ALERTS_VAULT_KEY) lives here. Secrets
// are decrypted once per (school, channel) group and never logged.

import { NextResponse } from 'next/server'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { byteaToBuffer, decryptSecret } from '@/app/lib/alerts/vault'
import { getAdapter } from '@/app/lib/alerts/adapters'
import { PermanentSendError } from '@/app/lib/alerts/adapters/types'
import type { Json } from '@/app/lib/alerts/adapters/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const LOOP_DEADLINE_MS = 50_000
const POLL_INTERVAL_MS = 5_000
const BATCH_LIMIT = 100
const SEND_CONCURRENCY = 5

interface OutboxRow {
  id: number
  school_id: string
  channel: string
  channel_template_id: string
  recipient: string
  vars: Record<string, string>
}

interface ChannelTemplateRow {
  id: string
  provider_template_id: string | null
  language: string | null
}

interface SchoolChannelRow {
  id: string
  school_id: string
  channel: string
  provider: string
  config: Json
  secret_ciphertext: string
  secret_iv: string
  secret_tag: string
  health: string
}

function admin(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function inMorningBurstIST(): boolean {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' })
      .format(new Date()),
  )
  return hour >= 7 && hour < 10
}

// Pick the gateway for a (school, channel): healthy first. Rows that
// exist but are auth_failed/suspended cause a TRANSIENT failure so the
// message survives long enough for the school to fix its credential.
function pickChannel(rows: SchoolChannelRow[]): { row: SchoolChannelRow | null; unhealthy: boolean } {
  if (!rows.length) return { row: null, unhealthy: false }
  const order = ['ok', 'unverified', 'low_balance']
  for (const health of order) {
    const found = rows.find((r) => r.health === health)
    if (found) return { row: found, unhealthy: false }
  }
  return { row: null, unhealthy: true }
}

async function settle(
  db: SupabaseClient,
  id: number,
  outcome:
    | { kind: 'sent'; providerMessageId: string | null }
    | { kind: 'failed'; code: string; message: string; permanent: boolean },
): Promise<void> {
  if (outcome.kind === 'sent') {
    await db.rpc('complete_outbox_send', {
      p_id: id,
      p_status: 'sent',
      p_provider_message_id: outcome.providerMessageId,
    })
  } else {
    await db.rpc('complete_outbox_send', {
      p_id: id,
      p_status: 'failed',
      p_error_code: outcome.code,
      p_error_message: outcome.message,
      p_permanent: outcome.permanent,
    })
  }
}

async function processBatch(
  db: SupabaseClient,
  rows: OutboxRow[],
  summary: { sent: number; failed: number; dead_lettered: number },
): Promise<void> {
  // Look up the channel templates once per batch.
  const tplIds = Array.from(new Set(rows.map((r) => r.channel_template_id)))
  const { data: tplData } = await db
    .from('channel_templates')
    .select('id, provider_template_id, language')
    .in('id', tplIds)
  const templates = new Map<string, ChannelTemplateRow>(
    ((tplData as ChannelTemplateRow[]) || []).map((t) => [t.id, t]),
  )

  // Group by (school, channel) and decrypt each credential once.
  const groups = new Map<string, OutboxRow[]>()
  for (const row of rows) {
    const key = `${row.school_id}:${row.channel}`
    const list = groups.get(key)
    if (list) list.push(row)
    else groups.set(key, [row])
  }

  for (const [key, groupRows] of Array.from(groups.entries())) {
    const [schoolId, channel] = key.split(':')

    const { data: chData } = await db
      .from('school_channels')
      .select('id, school_id, channel, provider, config, secret_ciphertext, secret_iv, secret_tag, health')
      .eq('school_id', schoolId)
      .eq('channel', channel)
    const { row: channelRow, unhealthy } = pickChannel((chData as SchoolChannelRow[]) || [])

    if (!channelRow) {
      const outcome = unhealthy
        ? { kind: 'failed' as const, code: 'CHANNEL_UNHEALTHY', message: 'Gateway credential is auth_failed/suspended. Fix it in channel settings.', permanent: false }
        : { kind: 'failed' as const, code: 'NO_GATEWAY', message: `No ${channel} gateway configured for this school.`, permanent: true }
      for (const row of groupRows) {
        await settle(db, row.id, outcome)
        if (outcome.permanent) summary.dead_lettered++
        else summary.failed++
      }
      continue
    }

    const adapter = getAdapter(channelRow.provider)
    if (!adapter) {
      for (const row of groupRows) {
        await settle(db, row.id, {
          kind: 'failed', code: 'NO_ADAPTER',
          message: `No adapter for provider '${channelRow.provider}'.`, permanent: true,
        })
        summary.dead_lettered++
      }
      continue
    }

    let secret: string
    try {
      secret = decryptSecret({
        ciphertext: byteaToBuffer(channelRow.secret_ciphertext),
        iv: byteaToBuffer(channelRow.secret_iv),
        tag: byteaToBuffer(channelRow.secret_tag),
      })
    } catch {
      // Wrong vault key or corrupt row - never log the details.
      for (const row of groupRows) {
        await settle(db, row.id, {
          kind: 'failed', code: 'VAULT_DECRYPT',
          message: 'Credential could not be decrypted. Re-enter it in channel settings.', permanent: false,
        })
        summary.failed++
      }
      continue
    }

    // Send with bounded concurrency inside the group.
    let cursor = 0
    let sawAuthFailure = false
    const workers = Array.from({ length: Math.min(SEND_CONCURRENCY, groupRows.length) }, async () => {
      while (cursor < groupRows.length) {
        const row = groupRows[cursor++]
        const tpl = templates.get(row.channel_template_id)
        try {
          const result = await adapter.send({
            secret,
            config: channelRow.config || {},
            providerTemplateId: tpl?.provider_template_id ?? null,
            language: tpl?.language ?? null,
            recipient: row.recipient,
            vars: row.vars || {},
          })
          await settle(db, row.id, { kind: 'sent', providerMessageId: result.providerMessageId })
          summary.sent++
        } catch (err) {
          if (err instanceof PermanentSendError) {
            await settle(db, row.id, {
              kind: 'failed', code: err.code, message: err.message, permanent: true,
            })
            summary.dead_lettered++
            if (err.authFailure) sawAuthFailure = true
          } else {
            await settle(db, row.id, {
              kind: 'failed', code: 'SEND_ERROR', message: String(err).slice(0, 500), permanent: false,
            })
            summary.failed++
          }
        }
      }
    })
    await Promise.all(workers)

    if (sawAuthFailure) {
      await db.rpc('set_channel_health', {
        p_school_channel_id: channelRow.id,
        p_health: 'auth_failed',
        p_detail: 'Gateway rejected the credential during send. Replace it in channel settings.',
      })
    }
  }
}

export async function POST(req: Request) {
  const auth = req.headers.get('authorization')
  if (!process.env.ALERTS_WORKER_SECRET || auth !== `Bearer ${process.env.ALERTS_WORKER_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const db = admin()
  const startedAt = Date.now()
  const summary = { batches: 0, claimed: 0, sent: 0, failed: 0, dead_lettered: 0 }

  // Loop for ~50s during the IST morning burst; single pass otherwise.
  // Overlapping invocations are safe (SKIP LOCKED), so the 1-minute
  // cron plus this loop yields sub-10s latency when it matters.
  for (;;) {
    const { data, error } = await db.rpc('claim_outbox_batch', { p_limit: BATCH_LIMIT })
    if (error) {
      return NextResponse.json({ error: `claim failed: ${error.message}`, ...summary }, { status: 500 })
    }
    const rows = (data as OutboxRow[]) || []

    if (rows.length) {
      summary.batches++
      summary.claimed += rows.length
      await processBatch(db, rows, summary)
      // Queue still deep? Claim again immediately while time remains.
      if (rows.length === BATCH_LIMIT && Date.now() - startedAt < LOOP_DEADLINE_MS) continue
    }

    if (!inMorningBurstIST()) break
    if (Date.now() - startedAt + POLL_INTERVAL_MS >= LOOP_DEADLINE_MS) break
    await sleep(POLL_INTERVAL_MS)
  }

  return NextResponse.json({ ok: true, ...summary })
}
