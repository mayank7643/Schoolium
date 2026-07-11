// FILE: app/lib/alerts/adapters/msg91.ts
//
// DLT SMS via the school's own MSG91 account (Flow API v5).
//
// config:  { base_url? }                 - default https://control.msg91.com
// secret:  the school's MSG91 authkey (bare string)
// provider_template_id: the MSG91 flow id mapped to the approved DLT
//   template. Positional vars are sent as var1..varN, which the flow
//   maps onto the DLT template's {#var#} slots.

import type { Adapter, AdapterSendArgs, DeliveryEvent, HealthResult, Json } from './types'
import { orderedVars, parseSecret, PermanentSendError } from './types'

function baseUrl(config: Json): string {
  return typeof config.base_url === 'string' && config.base_url
    ? config.base_url.replace(/\/$/, '')
    : 'https://control.msg91.com'
}

function authkey(secret: string): string {
  const parsed = parseSecret(secret)
  return typeof parsed.authkey === 'string' ? parsed.authkey : String(parsed.token ?? secret)
}

export const msg91Adapter: Adapter = {
  id: 'msg91',

  // Balance endpoint doubles as a credential check.
  async verify({ secret, config }): Promise<HealthResult> {
    const res = await fetch(`${baseUrl(config)}/api/v5/user/balance`, {
      headers: { authkey: authkey(secret) },
    })
    if (res.status === 401 || res.status === 403) {
      return { health: 'auth_failed', detail: `MSG91 rejected the authkey (HTTP ${res.status})` }
    }
    if (!res.ok) {
      return { health: 'unverified', detail: `MSG91 balance check failed (HTTP ${res.status})` }
    }
    return { health: 'ok' }
  },

  async send(args: AdapterSendArgs) {
    if (!args.providerTemplateId) {
      throw new PermanentSendError('MSG91_NO_FLOW', 'channel template has no MSG91 flow id')
    }

    const recipient: Record<string, string> = {
      // MSG91 wants digits without '+'.
      mobiles: args.recipient.replace(/^\+/, ''),
    }
    orderedVars(args.vars).forEach((v, i) => {
      recipient[`var${i + 1}`] = v
    })

    const res = await fetch(`${baseUrl(args.config)}/api/v5/flow`, {
      method: 'POST',
      headers: { authkey: authkey(args.secret), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template_id: args.providerTemplateId,
        short_url: '0', // DLT drops shortened URLs; templates carry full URLs
        recipients: [recipient],
      }),
    })

    const text = await res.text()
    if (res.status === 401 || res.status === 403) {
      throw new PermanentSendError('MSG91_AUTH', `MSG91: ${text.slice(0, 300)}`, true)
    }
    if (res.status >= 400 && res.status < 500) {
      // 4xx = bad flow id / rejected template / bad number - retrying won't help.
      throw new PermanentSendError(`MSG91_${res.status}`, `MSG91: ${text.slice(0, 300)}`)
    }
    if (!res.ok) {
      throw new Error(`MSG91 ${res.status}: ${text.slice(0, 300)}`)
    }

    let requestId: string | null = null
    try {
      const data = JSON.parse(text) as { data?: string; request_id?: string; message?: string }
      requestId = data.request_id ?? data.data ?? data.message ?? null
    } catch {
      /* non-JSON success body - keep null */
    }
    return { providerMessageId: requestId }
  },

  // MSG91 delivery callbacks: configure the webhook URL (with ?token=)
  // in the MSG91 panel. Payload shapes vary by panel version; we accept
  // both the array form and the single-object form.
  parseWebhook(raw: unknown): DeliveryEvent[] {
    const items = Array.isArray(raw) ? raw : [raw]
    const out: DeliveryEvent[] = []
    for (const item of items) {
      const r = item as { requestId?: string; request_id?: string; status?: string; description?: string } | null
      if (!r) continue
      const id = r.requestId ?? r.request_id
      if (!id) continue
      const s = String(r.status ?? '').toLowerCase()
      if (s === 'delivered' || s === '1') {
        out.push({ providerMessageId: id, status: 'delivered' })
      } else if (s === 'failed' || s === 'rejected' || s === '2' || s === '16') {
        out.push({
          providerMessageId: id,
          status: 'failed',
          errorCode: s,
          errorMessage: r.description ?? 'delivery failed',
        })
      }
    }
    return out
  },
}
