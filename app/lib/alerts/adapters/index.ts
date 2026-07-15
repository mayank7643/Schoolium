// FILE: app/lib/alerts/adapters/index.ts
//
// Adapter registry. Build order (blueprint section 6):
// fake -> msg91 -> generic_http -> meta_cloud -> resend (email).

import type { ChannelProvider } from '@/types'
import type { Adapter } from './types'
import { fakeAdapter } from './fake'
import { msg91Adapter } from './msg91'
import { genericHttpAdapter } from './generic_http'
import { metaCloudAdapter } from './meta_cloud'
import { resendAdapter } from './resend'

const registry: Partial<Record<ChannelProvider, Adapter>> = {
  fake: fakeAdapter,
  msg91: msg91Adapter,
  generic_http: genericHttpAdapter,
  meta_cloud: metaCloudAdapter,
  resend: resendAdapter,
}

export function getAdapter(provider: string): Adapter | null {
  return registry[provider as ChannelProvider] ?? null
}
