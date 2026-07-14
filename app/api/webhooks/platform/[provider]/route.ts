// FILE: app/api/webhooks/platform/[provider]/route.ts
//
// Delivery receipts for MANAGED mode (chat22). When schools send
// through Schoolium's own gateway, the provider posts callbacks to
// one platform endpoint (not per-school), so we resolve each message's
// school from its provider_message_id, then advance the ledger.
//
// Verification:
//   meta_cloud   X-Hub-Signature-256 against the PLATFORM app secret
//                (from platform_channels). GET handles the hub.challenge
//                handshake using ALERTS_WEBHOOK_SECRET-derived token.
//   resend / msg91 / generic_http / fake
//                ?token=<hmac('platform')> in the URL.

import { NextResponse } from 'next/server'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import {
  byteaToBuffer, decryptSecret, verifyMetaSignature, verifyWebhookToken, webhookToken,
} from '@/app/lib/alerts/vault'
import { getAdapter } from '@/app/lib/alerts/adapters'
import { metaAppSecret } from '@/app/lib/alerts/adapters/meta_cloud'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface RouteParams { params: { provider: string } }

interface VaultRow { secret_ciphertext: string; secret_iv: string; secret_tag: string }

// The platform webhook is not school-scoped; we mint/verify a token
// over the fixed string 'platform'.
const PLATFORM_SCOPE = 'platform'

function admin(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

// Meta subscription handshake (verify_token = platform webhook token).
export async function GET(req: Request, { params }: RouteParams) {
  if (params.provider !== 'meta_cloud') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  const url = new URL(req.url)
  const mode = url.searchParams.get('hub.mode')
  const token = url.searchParams.get('hub.verify_token')
  const challenge = url.searchParams.get('hub.challenge')
  if (mode === 'subscribe' && token && verifyWebhookToken(PLATFORM_SCOPE, token) && challenge) {
    return new NextResponse(challenge, { status: 200 })
  }
  return NextResponse.json({ error: 'verification_failed' }, { status: 403 })
}

export async function POST(req: Request, { params }: RouteParams) {
  const { provider } = params
  const adapter = getAdapter(provider)
  if (!adapter) return NextResponse.json({ error: 'unknown_provider' }, { status: 404 })

  const rawBody = await req.text()
  const db = admin()

  // ---- authenticate ----
  if (provider === 'meta_cloud') {
    const { data } = await db
      .from('platform_channels')
      .select('secret_ciphertext, secret_iv, secret_tag')
      .eq('provider', 'meta_cloud').eq('channel', 'whatsapp').limit(1)
    const row = ((data as VaultRow[]) || [])[0]
    if (!row) return NextResponse.json({ error: 'no_channel' }, { status: 404 })
    let appSecret: string | null = null
    try {
      appSecret = metaAppSecret(decryptSecret({
        ciphertext: byteaToBuffer(row.secret_ciphertext),
        iv: byteaToBuffer(row.secret_iv),
        tag: byteaToBuffer(row.secret_tag),
      }))
    } catch { appSecret = null }
    if (!appSecret || !verifyMetaSignature(rawBody, req.headers.get('x-hub-signature-256'), appSecret)) {
      return NextResponse.json({ error: 'bad_signature' }, { status: 401 })
    }
  } else {
    const token = new URL(req.url).searchParams.get('token')
    if (!verifyWebhookToken(PLATFORM_SCOPE, token)) {
      return NextResponse.json({ error: 'bad_token' }, { status: 401 })
    }
  }

  // ---- parse + apply (resolve school per message id) ----
  let parsed: unknown = null
  try { parsed = rawBody ? JSON.parse(rawBody) : null } catch {
    return NextResponse.json({ error: 'bad_json' }, { status: 400 })
  }

  const events = adapter.parseWebhook(parsed)
  let applied = 0
  for (const ev of events) {
    const { data: hit } = await db
      .from('message_outbox')
      .select('school_id')
      .eq('provider_message_id', ev.providerMessageId)
      .eq('mode', 'managed')
      .limit(1)
      .maybeSingle()
    const schoolId = (hit as { school_id: string } | null)?.school_id
    if (!schoolId) continue
    const { data } = await db.rpc('apply_delivery_status', {
      p_school_id: schoolId,
      p_provider_message_id: ev.providerMessageId,
      p_status: ev.status,
      p_error_code: ev.errorCode ?? null,
      p_error_message: ev.errorMessage ?? null,
    })
    applied += typeof data === 'number' ? data : 0
  }

  return NextResponse.json({ ok: true, received: events.length, applied })
}

// Expose the platform webhook token (super-admin wizard renders the URL
// providers post to). Guarded by the worker secret - server-side only.
export async function PUT(req: Request) {
  const auth = req.headers.get('authorization')
  if (!process.env.ALERTS_WORKER_SECRET || auth !== `Bearer ${process.env.ALERTS_WORKER_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  return NextResponse.json({ token: webhookToken(PLATFORM_SCOPE) })
}
