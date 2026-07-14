// FILE: app/api/alerts/platform-channels/route.ts
//
// Platform credential vault API (chat22) - Schoolium's OWN gateways
// used by schools on managed mode. super_admin only. Same crypto and
// UI-safe projection rules as /api/alerts/channels, but there is no
// school_id: these credentials are shared across every managed school.
//
//   GET     list platform gateways (fingerprint last-6 + health only)
//   POST    { action:'upsert', channel, provider, config?, secret?, is_active? }
//             verify-before-store; empty secret on an existing row is a
//             config/toggle-only update (keeps the stored credential)
//           { action:'verify', id }   re-run adapter.verify()
//   DELETE  { id }
//
// Plaintext never appears in a response body or a log line.

import { NextResponse } from 'next/server'
import { createClient as createServerClient } from '@/utils/supabase/server'
import { createClient as createServiceClient, SupabaseClient } from '@supabase/supabase-js'
import { bufferToBytea, byteaToBuffer, decryptSecret, encryptSecret } from '@/app/lib/alerts/vault'
import { getAdapter } from '@/app/lib/alerts/adapters'
import type { Json } from '@/app/lib/alerts/adapters/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CHANNELS = ['sms', 'whatsapp', 'email'] as const
const PROVIDERS = ['meta_cloud', 'msg91', 'gupshup', 'generic_http', 'smtp', 'resend', 'fake'] as const

interface VaultRow {
  id: string
  channel: string
  provider: string
  config: Json
  secret_ciphertext: string
  secret_iv: string
  secret_tag: string
  secret_fingerprint: string
  health: string
  is_active: boolean
  last_verified_at: string | null
  balance_hint_paise: number | null
}

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status })
}

function service(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createServiceClient(url, key, { auth: { persistSession: false } })
}

const ENV_ERROR =
  'Server is not configured: set SUPABASE_SERVICE_ROLE_KEY and ALERTS_VAULT_KEY in your deployment env vars.'

const SELECT = 'id, channel, provider, config, secret_ciphertext, secret_iv, secret_tag, secret_fingerprint, health, is_active, last_verified_at, balance_hint_paise'

function summarize(row: VaultRow) {
  return {
    id: row.id,
    channel: row.channel,
    provider: row.provider,
    config: row.config,
    health: row.health,
    is_active: row.is_active,
    last_verified_at: row.last_verified_at,
    balance_hint_paise: row.balance_hint_paise,
    secret_fingerprint_last6: row.secret_fingerprint.slice(-6),
  }
}

async function requireSuperAdmin(): Promise<true | NextResponse> {
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return bad('Not authenticated', 401)
  const { data: caller } = await supabase
    .from('profiles').select('role, is_active').eq('id', user.id).single()
  if (!caller || !caller.is_active) return bad('Profile not found', 403)
  if (caller.role !== 'super_admin') {
    return bad('Only Schoolium platform admins manage the shared gateways', 403)
  }
  return true
}

export async function GET() {
  const auth = await requireSuperAdmin()
  if (auth instanceof NextResponse) return auth
  const db = service()
  if (!db) return bad(ENV_ERROR, 500)

  const { data, error } = await db.from('platform_channels').select(SELECT).order('channel')
  if (error) return bad(error.message, 500)
  return NextResponse.json({ channels: ((data as VaultRow[]) || []).map(summarize) })
}

interface PostBody {
  action?: 'upsert' | 'verify'
  id?: string
  channel?: string
  provider?: string
  config?: Json
  secret?: string
  is_active?: boolean
}

export async function POST(req: Request) {
  const auth = await requireSuperAdmin()
  if (auth instanceof NextResponse) return auth
  const db = service()
  if (!db) return bad(ENV_ERROR, 500)

  let body: PostBody
  try { body = (await req.json()) as PostBody } catch { return bad('Invalid JSON body') }

  // ---- re-verify a stored credential ----
  if (body.action === 'verify') {
    if (!body.id) return bad('id is required')
    const { data } = await db.from('platform_channels').select(SELECT).eq('id', body.id).single()
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
    } catch { return bad('Credential could not be decrypted; replace it', 500) }

    const health = await adapter.verify({ secret, config: row.config || {} })
    await db.from('platform_channels')
      .update({ health: health.health, last_verified_at: new Date().toISOString(), balance_hint_paise: health.balanceHintPaise ?? null })
      .eq('id', row.id)
    return NextResponse.json({ ok: true, health: health.health, detail: health.detail ?? null })
  }

  // ---- create / rotate / toggle ----
  const channel = body.channel as (typeof CHANNELS)[number] | undefined
  const provider = body.provider as (typeof PROVIDERS)[number] | undefined
  if (!channel || !CHANNELS.includes(channel)) return bad('channel must be sms | whatsapp | email')
  if (!provider || !PROVIDERS.includes(provider)) return bad('unknown provider')
  const adapter = getAdapter(provider)
  if (!adapter) return bad(`Provider '${provider}' is not implemented yet`)

  const config: Json = body.config && typeof body.config === 'object' ? body.config : {}
  const isActive = body.is_active !== false
  const newSecret = typeof body.secret === 'string' ? body.secret.trim() : ''

  // Config/toggle-only update on an existing row (no new secret).
  if (!newSecret) {
    const { data: existing } = await db
      .from('platform_channels')
      .select('id, secret_ciphertext, secret_iv, secret_tag')
      .eq('channel', channel).eq('provider', provider).maybeSingle()
    const row = existing as Pick<VaultRow, 'id' | 'secret_ciphertext' | 'secret_iv' | 'secret_tag'> | null
    if (!row) return bad('secret is required for a new gateway')

    let stored: string
    try {
      stored = decryptSecret({
        ciphertext: byteaToBuffer(row.secret_ciphertext),
        iv: byteaToBuffer(row.secret_iv),
        tag: byteaToBuffer(row.secret_tag),
      })
    } catch { return bad('Stored credential could not be decrypted; paste it again', 500) }

    const health = await adapter.verify({ secret: stored, config })
    const { data: updated, error } = await db
      .from('platform_channels')
      .update({ config, is_active: isActive, health: health.health, last_verified_at: new Date().toISOString(), balance_hint_paise: health.balanceHintPaise ?? null })
      .eq('id', row.id).select(SELECT).single()
    if (error) return bad(error.message, 500)
    return NextResponse.json({ ok: true, channel: summarize(updated as VaultRow), detail: health.detail ?? null })
  }

  const health = await adapter.verify({ secret: newSecret, config })
  const enc = encryptSecret(newSecret)
  const { data: upserted, error } = await db
    .from('platform_channels')
    .upsert({
      channel, provider, config, is_active: isActive,
      secret_ciphertext: bufferToBytea(enc.ciphertext),
      secret_iv: bufferToBytea(enc.iv),
      secret_tag: bufferToBytea(enc.tag),
      secret_fingerprint: enc.fingerprint,
      health: health.health,
      last_verified_at: new Date().toISOString(),
      balance_hint_paise: health.balanceHintPaise ?? null,
    }, { onConflict: 'channel,provider' })
    .select(SELECT).single()
  if (error) return bad(error.message, 500)
  return NextResponse.json({ ok: true, channel: summarize(upserted as VaultRow), detail: health.detail ?? null })
}

export async function DELETE(req: Request) {
  const auth = await requireSuperAdmin()
  if (auth instanceof NextResponse) return auth
  const db = service()
  if (!db) return bad(ENV_ERROR, 500)

  let body: { id?: string }
  try { body = (await req.json()) as { id?: string } } catch { return bad('Invalid JSON body') }
  if (!body.id) return bad('id is required')

  const { error, count } = await db
    .from('platform_channels').delete({ count: 'exact' }).eq('id', body.id)
  if (error) return bad(error.message, 500)
  if (!count) return bad('Channel not found', 404)
  return NextResponse.json({ ok: true })
}
