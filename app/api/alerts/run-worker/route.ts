// FILE: app/api/alerts/run-worker/route.ts
//
// "Send now" - lets a signed-in school admin / operator drain the
// alert queue on demand (for live demos, and before pg_cron is set
// up). The worker bearer secret never leaves the server: this route
// authenticates the user session, then calls /api/worker with the
// secret from env, single-batch mode.

import { NextResponse } from 'next/server'
import { createClient as createServerClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { data: caller } = await supabase
    .from('profiles').select('role, is_active').eq('id', user.id).single()
  if (!caller || !caller.is_active) return NextResponse.json({ error: 'Profile not found' }, { status: 403 })
  if (!['school_admin', 'operator', 'super_admin'].includes(caller.role)) {
    return NextResponse.json({ error: 'Not allowed' }, { status: 403 })
  }

  if (!process.env.ALERTS_WORKER_SECRET) {
    return NextResponse.json(
      { error: 'ALERTS_WORKER_SECRET is not set in the deployment env vars.' },
      { status: 500 },
    )
  }

  const origin = new URL(req.url).origin
  try {
    const res = await fetch(`${origin}/api/worker`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.ALERTS_WORKER_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ once: true }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      return NextResponse.json({ error: body.error ?? 'Worker run failed' }, { status: 502 })
    }
    return NextResponse.json({ ok: true, ...body })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
