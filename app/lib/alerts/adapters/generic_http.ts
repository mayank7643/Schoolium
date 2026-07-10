// FILE: app/lib/alerts/adapters/generic_http.ts
//
// The self-serve escape hatch (blueprint build order #3): a school
// arrives with a gateway we have never heard of and configures it
// without a code change.
//
// config:
//   {
//     "url":    "https://sms.example.com/send",        (required)
//     "method": "POST",                                 (default POST)
//     "headers": { "Authorization": "Bearer {{secret}}" },
//     "body":   { "to": "{{recipient}}", "tpl": "{{template_id}}",
//                 "text_vars": "{{vars_csv}}", "v1": "{{var1}}" },
//     "message_id_path": "data.id",                     (dot path in the JSON reply)
//     "verify_url": "https://sms.example.com/balance"   (optional GET for [Verify])
//   }
//
// Placeholders available in headers and body values:
//   {{secret}} {{recipient}} {{recipient_no_plus}} {{template_id}}
//   {{language}} {{var1}}..{{varN}} {{vars_csv}} {{vars_json}}

import type { Adapter, AdapterSendArgs, DeliveryEvent, HealthResult, Json } from './types'
import { orderedVars, PermanentSendError } from './types'

function substitute(value: string, ctx: Record<string, string>): string {
  return value.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_, name: string) => ctx[name.toLowerCase()] ?? '')
}

function substituteDeep(value: unknown, ctx: Record<string, string>): unknown {
  if (typeof value === 'string') return substitute(value, ctx)
  if (Array.isArray(value)) return value.map((v) => substituteDeep(v, ctx))
  if (value && typeof value === 'object') {
    const out: Json = {}
    for (const [k, v] of Object.entries(value as Json)) out[k] = substituteDeep(v, ctx)
    return out
  }
  return value
}

function dig(obj: unknown, path: string): unknown {
  let cur: unknown = obj
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Json)[part]
  }
  return cur
}

function buildContext(args: AdapterSendArgs): Record<string, string> {
  const vars = orderedVars(args.vars)
  const ctx: Record<string, string> = {
    secret: args.secret,
    recipient: args.recipient,
    recipient_no_plus: args.recipient.replace(/^\+/, ''),
    template_id: args.providerTemplateId ?? '',
    language: args.language ?? 'en',
    vars_csv: vars.join(','),
    vars_json: JSON.stringify(args.vars),
  }
  vars.forEach((v, i) => {
    ctx[`var${i + 1}`] = v
  })
  return ctx
}

export const genericHttpAdapter: Adapter = {
  id: 'generic_http',

  async verify({ secret, config }): Promise<HealthResult> {
    const url = typeof config.verify_url === 'string' ? config.verify_url : null
    if (!url) {
      // Nothing to call - config presence is all we can check.
      return typeof config.url === 'string' && config.url
        ? { health: 'unverified', detail: 'no verify_url configured; will verify on first send' }
        : { health: 'auth_failed', detail: 'config.url is missing' }
    }
    const headers = substituteDeep(config.headers ?? {}, {
      secret,
      recipient: '',
      recipient_no_plus: '',
      template_id: '',
      language: 'en',
      vars_csv: '',
      vars_json: '{}',
    }) as Record<string, string>
    const res = await fetch(url, { headers })
    if (res.status === 401 || res.status === 403) {
      return { health: 'auth_failed', detail: `gateway rejected credentials (HTTP ${res.status})` }
    }
    return res.ok
      ? { health: 'ok' }
      : { health: 'unverified', detail: `verify_url returned HTTP ${res.status}` }
  },

  async send(args: AdapterSendArgs) {
    const url = typeof args.config.url === 'string' ? args.config.url : null
    if (!url) {
      throw new PermanentSendError('GENERIC_NO_URL', 'generic_http: config.url is missing')
    }

    const ctx = buildContext(args)
    const method = typeof args.config.method === 'string' ? args.config.method.toUpperCase() : 'POST'
    const headers = {
      'Content-Type': 'application/json',
      ...(substituteDeep(args.config.headers ?? {}, ctx) as Record<string, string>),
    }
    const body = substituteDeep(args.config.body ?? {}, ctx)

    const res = await fetch(substitute(url, ctx), {
      method,
      headers,
      body: method === 'GET' ? undefined : JSON.stringify(body),
    })

    const text = await res.text()
    if (res.status === 401 || res.status === 403) {
      throw new PermanentSendError('GENERIC_AUTH', `gateway: ${text.slice(0, 300)}`, true)
    }
    if (res.status >= 400 && res.status < 500) {
      throw new PermanentSendError(`GENERIC_${res.status}`, `gateway: ${text.slice(0, 300)}`)
    }
    if (!res.ok) {
      throw new Error(`gateway ${res.status}: ${text.slice(0, 300)}`)
    }

    let providerMessageId: string | null = null
    const path = typeof args.config.message_id_path === 'string' ? args.config.message_id_path : null
    if (path) {
      try {
        const found = dig(JSON.parse(text), path)
        if (typeof found === 'string' || typeof found === 'number') {
          providerMessageId = String(found)
        }
      } catch {
        /* non-JSON reply - keep null */
      }
    }
    return { providerMessageId }
  },

  // Same echo contract as the fake adapter; schools whose gateway can
  // POST JSON callbacks map their payload to this shape (or skip
  // delivery receipts entirely - the ledger stays at 'sent').
  parseWebhook(raw: unknown): DeliveryEvent[] {
    const body = raw as { events?: DeliveryEvent[] } | null
    if (!body?.events?.length) return []
    return body.events.filter(
      (e) =>
        typeof e.providerMessageId === 'string' &&
        (e.status === 'delivered' || e.status === 'read' || e.status === 'failed'),
    )
  },
}
