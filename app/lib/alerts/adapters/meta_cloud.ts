// FILE: app/lib/alerts/adapters/meta_cloud.ts
//
// WhatsApp via the SCHOOL'S OWN Meta Cloud API account (BYOG): the
// school's WABA, the school's phone number id, the school's billing.
//
// config:  { phone_number_id, waba_id?, graph_version? }
// secret:  JSON string { "access_token": "...", "app_secret": "..." }
//          access_token: never-expiring System User token for the WABA
//          app_secret:   used only to verify X-Hub-Signature-256 webhooks
// provider_template_id: the approved Meta template NAME.

import type { Adapter, AdapterSendArgs, DeliveryEvent, HealthResult, Json } from './types'
import { orderedVars, parseSecret, PermanentSendError } from './types'

function graphUrl(config: Json): string {
  const version = typeof config.graph_version === 'string' ? config.graph_version : 'v19.0'
  return `https://graph.facebook.com/${version}`
}

function accessToken(secret: string): string {
  const parsed = parseSecret(secret)
  return typeof parsed.access_token === 'string' ? parsed.access_token : String(parsed.token ?? secret)
}

export function metaAppSecret(secret: string): string | null {
  const parsed = parseSecret(secret)
  return typeof parsed.app_secret === 'string' ? parsed.app_secret : null
}

interface MetaError {
  error?: { message?: string; code?: number; error_subcode?: number }
}

export const metaCloudAdapter: Adapter = {
  id: 'meta_cloud',

  // GET the phone number object - cheapest call that proves the token
  // is valid and scoped to the configured number.
  async verify({ secret, config }): Promise<HealthResult> {
    const phoneId = typeof config.phone_number_id === 'string' ? config.phone_number_id : null
    if (!phoneId) return { health: 'auth_failed', detail: 'config.phone_number_id is missing' }

    const res = await fetch(`${graphUrl(config)}/${phoneId}?fields=display_phone_number,quality_rating`, {
      headers: { Authorization: `Bearer ${accessToken(secret)}` },
    })
    if (res.ok) return { health: 'ok' }

    const body = (await res.json().catch(() => null)) as MetaError | null
    const msg = body?.error?.message ?? `HTTP ${res.status}`
    if (res.status === 401 || body?.error?.code === 190) {
      return { health: 'auth_failed', detail: `Meta rejected the token: ${msg}` }
    }
    return { health: 'unverified', detail: `Meta verify failed: ${msg}` }
  },

  async send(args: AdapterSendArgs) {
    const phoneId = typeof args.config.phone_number_id === 'string' ? args.config.phone_number_id : null
    if (!phoneId) {
      throw new PermanentSendError('META_NO_PHONE', 'config.phone_number_id is missing')
    }
    if (!args.providerTemplateId) {
      throw new PermanentSendError('META_NO_TEMPLATE', 'channel template has no Meta template name')
    }

    const params = orderedVars(args.vars).map((text) => ({ type: 'text', text }))
    const res = await fetch(`${graphUrl(args.config)}/${phoneId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken(args.secret)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: args.recipient.replace(/^\+/, ''),
        type: 'template',
        template: {
          name: args.providerTemplateId,
          language: { code: args.language || 'en' },
          components: params.length ? [{ type: 'body', parameters: params }] : [],
        },
      }),
    })

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as MetaError | null
      const code = body?.error?.code ?? res.status
      // Surface Meta's own error string verbatim - the school's
      // conversation is then with Meta, not with us.
      const msg = `Meta rejected this: ${body?.error?.message ?? `HTTP ${res.status}`}`
      if (code === 190 || res.status === 401) {
        throw new PermanentSendError(`META_${code}`, msg, true)
      }
      // 131026 unsupported recipient, 132001 template missing, 131047
      // re-engagement window, 100 invalid parameter: never retryable.
      if ([100, 131026, 131047, 132000, 132001, 132005, 132007, 132012].includes(code)) {
        throw new PermanentSendError(`META_${code}`, msg)
      }
      if (res.status >= 500 || code === 80007 /* rate limit */ || code === 4) {
        throw new Error(msg) // transient - worker backs off
      }
      throw new PermanentSendError(`META_${code}`, msg)
    }

    const data = (await res.json()) as { messages?: Array<{ id: string }> }
    return { providerMessageId: data.messages?.[0]?.id ?? null }
  },

  // Meta statuses webhook: entry[].changes[].value.statuses[].
  parseWebhook(raw: unknown): DeliveryEvent[] {
    const body = raw as {
      entry?: Array<{
        changes?: Array<{
          value?: {
            statuses?: Array<{
              id?: string
              status?: string
              errors?: Array<{ code?: number; title?: string; message?: string }>
            }>
          }
        }>
      }>
    } | null

    const out: DeliveryEvent[] = []
    for (const entry of body?.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const s of change.value?.statuses ?? []) {
          if (!s.id) continue
          if (s.status === 'delivered') {
            out.push({ providerMessageId: s.id, status: 'delivered' })
          } else if (s.status === 'read') {
            out.push({ providerMessageId: s.id, status: 'read' })
          } else if (s.status === 'failed') {
            const err = s.errors?.[0]
            out.push({
              providerMessageId: s.id,
              status: 'failed',
              errorCode: err?.code != null ? String(err.code) : undefined,
              errorMessage: err?.message ?? err?.title ?? 'delivery failed',
            })
          }
          // 'sent' is ignored - complete_outbox_send already set it.
        }
      }
    }
    return out
  },
}
