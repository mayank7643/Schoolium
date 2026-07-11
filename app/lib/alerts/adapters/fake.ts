// FILE: app/lib/alerts/adapters/fake.ts
//
// The first adapter (blueprint build order #1). The entire test suite
// runs against this. Behaviour is driven by school_channels.config so
// tests can exercise every worker path without a real gateway:
//
//   config.fail_with      = 'transient' | 'permanent' | 'auth'
//   config.fail_recipient = only fail for this recipient
//   config.balance_paise  = balance hint returned by verify()

import type { Adapter, AdapterSendArgs, DeliveryEvent, HealthResult, Json } from './types'
import { PermanentSendError } from './types'

function shouldFail(config: Json, recipient: string): string | null {
  const mode = typeof config.fail_with === 'string' ? config.fail_with : null
  if (!mode) return null
  const only = typeof config.fail_recipient === 'string' ? config.fail_recipient : null
  if (only && only !== recipient) return null
  return mode
}

export const fakeAdapter: Adapter = {
  id: 'fake',

  async verify({ config }): Promise<HealthResult> {
    if (config.fail_with === 'auth') {
      return { health: 'auth_failed', detail: 'fake: auth rejected' }
    }
    const balance = typeof config.balance_paise === 'number' ? config.balance_paise : null
    return { health: 'ok', balanceHintPaise: balance }
  },

  async send(args: AdapterSendArgs) {
    const mode = shouldFail(args.config, args.recipient)
    if (mode === 'auth') {
      throw new PermanentSendError('FAKE_401', 'fake: invalid credentials', true)
    }
    if (mode === 'permanent') {
      throw new PermanentSendError('FAKE_TEMPLATE', 'fake: template rejected')
    }
    if (mode === 'transient') {
      throw new Error('fake: gateway timeout')
    }
    return { providerMessageId: `fake-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` }
  },

  // Echo webhook: POST { events: [{ providerMessageId, status, ... }] }
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
