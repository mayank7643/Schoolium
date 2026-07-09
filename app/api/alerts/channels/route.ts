// FILE: app/api/alerts/channels/route.ts
//
// Channel setup wizard backend (chat21, blueprint sections 5 and 10):
// paste credentials -> [Verify connection] -> health = ok. The vault
// table (school_channels) is service-role only, so this route is the
// ONLY path between the admin UI and a credential.
//
//   GET     list the caller's school channels - UI-safe projection
//           only: fingerprint last-6 + health. Never the secret.
//   POST    { action: 'upsert', channel, provider, config?, secret }
//             encrypt (AES-256-GCM, key in env), adapter.verify(),
//             then upsert on (school_id, channel, provider). This is
//             also the rotate flow: re-encrypts and re-verifies before
//             switching over.
//           { action: 'verify', id }
//             re-run adapter.verify() on the stored secret; refresh
//             health + balance hint.
//   DELETE  { id }  remove a credential (own school only).
//
// Plaintext never appears in a response body or a log line.

import { NextResponse } from 'next/server'
import { createClient as createServerClient } from '@/utils/supabase/server'
import { createClient as createServiceClient, SupabaseClient } from '@supabase/supabase-js'
import { bufferToBytea, byteaToBuffer, decryptSecret, encryptSecret, webhookToken } from '@/app/lib/alerts/vault'
import { getAdapter } from '@/app/lib/alerts/adapters'
import type { Json } from '@/app/lib/alerts/adapters/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CHANNELS = ['sms', 'whatsapp', 'email'] as const
const PROVIDERS = ['meta_cloud', 'msg91', 'gupshup', 'generic_http', 'smtp', 'fake'] as const

interface VaultRow {
  id: string
  school_id: string
  channel: string
  provider: string
  config: Json
  secret_ciphertext: string
  secret_iv: string
  secret_tag: string
  secret_fingerprint: string
  health: string
  last_verified_at: string | null
  balance_hint_paise: number | null
}

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status })
}

// Null when the deployment is missing its server env vars - callers
// return a clear JSON error instead of crashing into an HTML 500
// (which the settings page cannot parse).
function service(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createServiceClient(url, key, { auth: { persistSession: false } })
}

const ENV_ERROR =
  'Server is not configured: set SUPABASE_SERVICE_ROLE_KEY (and the ALERTS_* secrets from env.local.example) in your deployment env vars.'

// UI-safe projection - the only shape that ever leaves this route.
function summarize(row: VaultRow) {
  return {
    id: row.id,
    school_id: row.school_id,
    channel: row.channel,
    provider: row.provider,
    config: row.config,
    health: row.health,
    last_verified_at: row.last_verified_at,
    balance_hint_paise: row.balance_hint_paise,
    secret_fingerprint_last6: row.secret_fingerprint.slice(-6),
  }
}

async function requireAdmin(): Promise<{ schoolId: string } | NextResponse> {
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return bad('Not authenticated', 401)

  const { data: caller } = await supabase
    .from('profiles')
    .select('role, school_id, is_active')
    .eq('id', user.id)
    .single()

  if (!caller || !caller.is_active || !caller.school_id) return bad('Profile not found', 403)
  if (caller.role !== 'school_admin') {
    return bad('Only the school admin can manage gateway credentials', 403)
  }
  return { schoolId: caller.school_id as string }
}

export async function GET() {
  const auth = await requireAdmin()
  if (auth instanceof NextResponse) return auth

  const db = service()
  if (!db) return bad(ENV_ERROR, 500)

  const { data, error } = await db
    .from('school_channels')
    .select('id, school_id, channel, provider, config, secret_ciphertext, secret_iv, secret_tag, secret_fingerprint, health, last_verified_at, balance_hint_paise')
    .eq('school_id', auth.schoolId)
    .order('channel')
  if (error) return bad(error.message, 500)

  // Shown in the wizard: the callback URL the school pastes into their
  // gateway (Meta uses it as the verify_token too). Null (with a hint)
  // when ALERTS_WEBHOOK_SECRET is not set yet - never a crash.
  let token: string | null = null
  let tokenError: string | null = null
  try {
    token = webhookToken(auth.schoolId)
  } catch (e) {
    tokenError = e instanceof Error ? e.message : String(e)
  }

  return NextResponse.json({
    channels: ((data as VaultRow[]) || []).map(summarize),
    webhook_token: token,
    webhook_token_error: tokenError,
  })
}

interface PostBody {
  action?: 'upsert' | 'verify'
  id?: string
  channel?: string
  provider?: string
  config?: Json
  secret?: string
}

export async function POST(req: Request) {
  const auth = await requireAdmin()
  if (auth instanceof NextResponse) return auth

  let body: PostBody
  try {
    body = (await req.json()) as PostBody
  } catch {
    return bad('Invalid JSON body')
  }

  const db = service()
  if (!db) return bad(ENV_ERROR, 500)

  // ---- re-verify a stored credential ------------------------------
  if (body.action === 'verify') {
    if (!body.id) return bad('id is required')
    const { data } = await db
      .from('school_channels')
      .select('id, school_id, channel, provider, config, secret_ciphertext, secret_iv, secret_tag, secret_fingerprint, health, last_verified_at, balance_hint_paise')
      .eq('id', body.id)
      .eq('school_id', auth.schoolId)
      .single()
    const row = data as VaultRow | null
    if (!row) return bad('Channel not found', 404)

    const adapter = getAdapter(row.provider)
    if (!adapter) return bad(`No adapter for provider '${row.provider}'`)

    let secret: string
    try {
      secret = decryptSecret({
        ciphertext: byteaToBuffer(row.secret_ciphertext),
        iv: byteaToBuffer(row.secret_iv),
        tag: byteaToBuffer(row.secret_tag),
      })
    } catch {
      return bad('Credential could not be decrypted; replace it', 500)
    }

    const health = await adapter.verify({ secret, config: row.config || {} })
    await db.rpc('set_channel_health', {
      p_school_channel_id: row.id,
      p_health: health.health,
      p_balance_hint_paise: health.balanceHintPaise ?? null,
      p_detail: health.detail ?? null,
    })
    return NextResponse.json({ ok: true, health: health.health, detail: health.detail ?? null })
  }

  // ---- create / rotate a credential --------------------------------
  const channel = body.channel as (typeof CHANNELS)[number] | undefined
  const provider = body.provider as (typeof PROVIDERS)[number] | undefined
  if (!channel || !CHANNELS.includes(channel)) return bad('channel must be sms | whatsapp | email')
  if (!provider || !PROVIDERS.includes(provider)) return bad('unknown provider')
  if (!body.secret || typeof body.secret !== 'string' || !body.secret.trim()) {
    return bad('secret is required')
  }
  const adapter = getAdapter(provider)
  if (!adapter) return bad(`Provider '${provider}' is not implemented yet`)

  const config: Json = body.config && typeof body.config === 'object' ? body.config : {}

  // Verify BEFORE storing (rotate flow: re-verify before switching over).
  const health = await adapter.verify({ secret: body.secret, config })

  const enc = encryptSecret(body.secret)
  const { data: upserted, error } = await db
    .from('school_channels')
    .upsert(
      {
        school_id: auth.schoolId,
        channel,
        provider,
        config,
        secret_ciphertext: bufferToBytea(enc.ciphertext),
        secret_iv: bufferToBytea(enc.iv),
        secret_tag: bufferToBytea(enc.tag),
        secret_fingerprint: enc.fingerprint,
        health: health.health,
        last_verified_at: new Date().toISOString(),
        balance_hint_paise: health.balanceHintPaise ?? null,
      },
      { onConflict: 'school_id,channel,provider' },
    )
    .select('id, school_id, channel, provider, config, secret_ciphertext, secret_iv, secret_tag, secret_fingerprint, health, last_verified_at, balance_hint_paise')
    .single()
  if (error) return bad(error.message, 500)

  return NextResponse.json({
    ok: true,
    channel: summarize(upserted as VaultRow),
    detail: health.detail ?? null,
  })
}

export async function DELETE(req: Request) {
  const auth = await requireAdmin()
  if (auth instanceof NextResponse) return auth

  let body: { id?: string }
  try {
    body = (await req.json()) as { id?: string }
  } catch {
    return bad('Invalid JSON body')
  }
  if (!body.id) return bad('id is required')

  const db = service()
  if (!db) return bad(ENV_ERROR, 500)
  const { error, count } = await db
    .from('school_channels')
    .delete({ count: 'exact' })
    .eq('id', body.id)
    .eq('school_id', auth.schoolId)
  if (error) return bad(error.message, 500)
  if (!count) return bad('Channel not found', 404)

  return NextResponse.json({ ok: true })
}
