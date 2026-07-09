// FILE: app/lib/alerts/adapters/types.ts
//
// One interface, several implementations (blueprint section 6).
// Adapters NEVER retry internally - retries belong to the worker via
// complete_outbox_send() backoff. Adapters never touch the database.

import type { ChannelHealth, ChannelProvider } from '@/types'

export type Json = Record<string, unknown>

export interface AdapterSendArgs {
  // Decrypted vault secret. Providers that need more than one value
  // (e.g. Meta access token + app secret) store a JSON object string.
  secret: string
  // Non-secret provider config from school_channels.config
  // (waba_id, phone_number_id, base_url, sender, ...).
  config: Json
  providerTemplateId: string | null // DLT template id / Meta template name
  language: string | null
  recipient: string // E.164 (+91...) or email address
  vars: Record<string, string> // positional: {"1":"Aayush","2":"..."}
}

export interface AdapterSendResult {
  providerMessageId: string | null
}

export interface HealthResult {
  health: ChannelHealth
  balanceHintPaise?: number | null
  detail?: string
}

export interface DeliveryEvent {
  providerMessageId: string
  status: 'delivered' | 'read' | 'failed'
  errorCode?: string
  errorMessage?: string
}

// Thrown for errors that must NOT be retried: rejected template,
// invalid credentials, opted-out recipient at the provider side.
// The worker dead-letters the row immediately and, for auth errors,
// flips school_channels.health.
export class PermanentSendError extends Error {
  readonly code: string
  readonly authFailure: boolean
  constructor(code: string, message: string, authFailure = false) {
    super(message)
    this.name = 'PermanentSendError'
    this.code = code
    this.authFailure = authFailure
  }
}

export interface Adapter {
  readonly id: ChannelProvider

  // Cheap credential check used by the setup wizard's [Verify connection]
  // and the worker's periodic health pass.
  verify(args: { secret: string; config: Json }): Promise<HealthResult>

  send(args: AdapterSendArgs): Promise<AdapterSendResult>

  // Map a provider callback body to delivery ledger events. Signature
  // verification happens in the webhook route (it needs raw body and
  // headers); this only parses.
  parseWebhook(raw: unknown): DeliveryEvent[]
}

// Positional vars {"1":..,"2":..} -> ordered array. Missing indexes
// render as '' - providers reject null parameters, not empty strings.
export function orderedVars(vars: Record<string, string>): string[] {
  const keys = Object.keys(vars)
    .map((k) => Number(k))
    .filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => a - b)
  const max = keys.length ? keys[keys.length - 1] : 0
  const out: string[] = []
  for (let i = 1; i <= max; i++) out.push(vars[String(i)] ?? '')
  return out
}

// Secrets may be a bare token or a JSON object string.
export function parseSecret(secret: string): Json {
  const trimmed = secret.trim()
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed) as Json
    } catch {
      return { token: secret }
    }
  }
  return { token: secret }
}
