// FILE: app/lib/alerts/adapters/resend.ts
//
// Email via Resend's HTTP API (https://resend.com). HTTP, not raw
// SMTP, so it works on Vercel serverless where outbound SMTP ports
// are blocked. Used for both modes:
//   - byog:    the school's own Resend key + verified from-address
//   - managed: Schoolium's Resend key + Schoolium from-address
//
// config:  { from: "Sunrise School <alerts@schoolium.app>", reply_to? }
// secret:  the Resend API key (bare string)
// vars:    { subject, text }  (rendered at enqueue by alerts_render_body)

import type { Adapter, AdapterSendArgs, DeliveryEvent, HealthResult, Json } from './types'
import { parseSecret, PermanentSendError } from './types'

function apiKey(secret: string): string {
  const parsed = parseSecret(secret)
  return typeof parsed.api_key === 'string' ? parsed.api_key : String(parsed.token ?? secret)
}

function fromAddress(config: Json): string | null {
  return typeof config.from === 'string' && config.from ? config.from : null
}

export const resendAdapter: Adapter = {
  id: 'resend',

  // Resend exposes /domains; a 401 means the key is bad.
  async verify({ secret, config }): Promise<HealthResult> {
    if (!fromAddress(config)) {
      return { health: 'auth_failed', detail: 'config.from is required (verified sender address)' }
    }
    const res = await fetch('https://api.resend.com/domains', {
      headers: { Authorization: `Bearer ${apiKey(secret)}` },
    })
    if (res.status === 401 || res.status === 403) {
      return { health: 'auth_failed', detail: `Resend rejected the API key (HTTP ${res.status})` }
    }
    return res.ok
      ? { health: 'ok' }
      : { health: 'unverified', detail: `Resend check failed (HTTP ${res.status})` }
  },

  async send(args: AdapterSendArgs) {
    const from = fromAddress(args.config)
    if (!from) {
      throw new PermanentSendError('RESEND_NO_FROM', 'config.from (verified sender) is missing')
    }
    const subject = args.vars.subject?.trim() || '(no subject)'
    const text = args.vars.text ?? ''

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey(args.secret)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [args.recipient],
        subject,
        text,
        ...(typeof args.config.reply_to === 'string' ? { reply_to: args.config.reply_to } : {}),
      }),
    })

    const body = await res.text()
    if (res.status === 401 || res.status === 403) {
      throw new PermanentSendError('RESEND_AUTH', `Resend: ${body.slice(0, 300)}`, true)
    }
    if (res.status === 422 || res.status === 400) {
      // Bad address / unverified domain - retrying will not help.
      throw new PermanentSendError(`RESEND_${res.status}`, `Resend: ${body.slice(0, 300)}`)
    }
    if (res.status === 429 || res.status >= 500) {
      throw new Error(`Resend ${res.status}: ${body.slice(0, 300)}`) // transient
    }
    if (!res.ok) {
      throw new PermanentSendError(`RESEND_${res.status}`, `Resend: ${body.slice(0, 300)}`)
    }

    let id: string | null = null
    try {
      id = (JSON.parse(body) as { id?: string }).id ?? null
    } catch {
      /* keep null */
    }
    return { providerMessageId: id }
  },

  // Resend webhook events: { type: 'email.delivered'|'email.opened'|
  // 'email.bounced'|'email.complained', data: { email_id } }.
  parseWebhook(raw: unknown): DeliveryEvent[] {
    const ev = raw as { type?: string; data?: { email_id?: string } } | null
    const id = ev?.data?.email_id
    if (!id || !ev?.type) return []
    if (ev.type === 'email.delivered') return [{ providerMessageId: id, status: 'delivered' }]
    if (ev.type === 'email.opened') return [{ providerMessageId: id, status: 'read' }]
    if (ev.type === 'email.bounced' || ev.type === 'email.complained') {
      return [{ providerMessageId: id, status: 'failed', errorCode: ev.type, errorMessage: ev.type }]
    }
    return []
  },
}
