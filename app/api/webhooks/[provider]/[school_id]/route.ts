// FILE: app/api/webhooks/[provider]/[school_id]/route.ts
//
// Delivery receipts for the BYOG alerts pipeline (chat21). Providers
// call back here; we verify the request really came from the school's
// gateway, map it to DeliveryEvents, and advance the ledger via
// apply_delivery_status() (forward-only: sent -> delivered -> read).
//
// Verification per provider:
//   meta_cloud    X-Hub-Signature-256 HMAC of the raw body with the
//                 school's app secret (from the vault). GET handles
//                 Meta's hub.challenge subscription handshake using
//                 the per-school webhook token as verify_token.
//   msg91 / generic_http / fake
//                 ?token=<hmac(school_id)> embedded in the URL the
//                 school configures at their gateway.
//
// "Delivered to 412 parents. Read by 388." starts here.

import { NextResponse } from 'next/server'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import {
  byteaToBuffer,
  decryptSecret,
  verifyMetaSignature,
  verifyWebhookToken,
  webhookToken,
} from '@/app/lib/alerts/vault'
import { getAdapter } from '@/app/lib/alerts/adapters'
import { metaAppSecret } from '@/app/lib/alerts/adapters/meta_cloud'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface RouteParams {
  params: { provider: string; school_id: string }
}

interface VaultRow {
  secret_ciphertext: string
  secret_iv: string
  secret_tag: string
}

function admin(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Meta subscription handshake. verify_token is the school's webhook
// token, shown in the channel setup wizard.
export async function GET(req: Request, { params }: RouteParams) {
  if (params.provider !== 'meta_cloud' || !UUID_RE.test(params.school_id)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  const url = new URL(req.url)
  const mode = url.searchParams.get('hub.mode')
  const token = url.searchParams.get('hub.verify_token')
  const challenge = url.searchParams.get('hub.challenge')
  if (mode === 'subscribe' && token && verifyWebhookToken(params.school_id, token) && challenge) {
    return new NextResponse(challenge, { status: 200 })
  }
  return NextResponse.json({ error: 'verification_failed' }, { status: 403 })
}

export async function POST(req: Request, { params }: RouteParams) {
  const { provider, school_id: schoolId } = params
  if (!UUID_RE.test(schoolId)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  const adapter = getAdapter(provider)
  if (!adapter) {
    return NextResponse.json({ error: 'unknown_provider' }, { status: 404 })
  }

  const rawBody = await req.text()
  const db = admin()

  // ---- authenticate the callback --------------------------------
  if (provider === 'meta_cloud') {
    const { data } = await db
      .from('school_channels')
      .select('secret_ciphertext, secret_iv, secret_tag')
      .eq('school_id', schoolId)
      .eq('provider', 'meta_cloud')
      .limit(1)
    const row = ((data as VaultRow[]) || [])[0]
    if (!row) return NextResponse.json({ error: 'no_channel' }, { status: 404 })

    let appSecret: string | null = null
    try {
      appSecret = metaAppSecret(
        decryptSecret({
          ciphertext: byteaToBuffer(row.secret_ciphertext),
          iv: byteaToBuffer(row.secret_iv),
          tag: byteaToBuffer(row.secret_tag),
        }),
      )
    } catch {
      appSecret = null
    }
    if (!appSecret || !verifyMetaSignature(rawBody, req.headers.get('x-hub-signature-256'), appSecret)) {
      return NextResponse.json({ error: 'bad_signature' }, { status: 401 })
    }
  } else {
    const token = new URL(req.url).searchParams.get('token')
    if (!verifyWebhookToken(schoolId, token)) {
      return NextResponse.json({ error: 'bad_token' }, { status: 401 })
    }
  }

  // ---- parse + apply ---------------------------------------------
  let parsed: unknown = null
  try {
    parsed = rawBody ? JSON.parse(rawBody) : null
  } catch {
    return NextResponse.json({ error: 'bad_json' }, { status: 400 })
  }

  const events = adapter.parseWebhook(parsed)
  let applied = 0
  for (const ev of events) {
    const { data } = await db.rpc('apply_delivery_status', {
      p_school_id: schoolId,
      p_provider_message_id: ev.providerMessageId,
      p_status: ev.status,
      p_error_code: ev.errorCode ?? null,
      p_error_message: ev.errorMessage ?? null,
    })
    applied += typeof data === 'number' ? data : 0
  }

  // Providers (Meta especially) retry on non-2xx; unknown message ids
  // are fine to acknowledge - they may belong to non-alert traffic.
  return NextResponse.json({ ok: true, received: events.length, applied })
}

// Expose the per-school token so the setup wizard can render the URL
// the school pastes into their gateway. Guarded by the worker secret -
// only our own server-side wizard code calls this.
export async function PUT(req: Request, { params }: RouteParams) {
  const auth = req.headers.get('authorization')
  if (!process.env.ALERTS_WORKER_SECRET || auth !== `Bearer ${process.env.ALERTS_WORKER_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  if (!UUID_RE.test(params.school_id)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  return NextResponse.json({ token: webhookToken(params.school_id) })
}
