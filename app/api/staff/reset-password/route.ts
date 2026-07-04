// FILE: app/api/staff/reset-password/route.ts
//
// Admin/principal sets a new password for a staff member (chat17).
// Rules:
//   - caller must be an active school_admin or principal
//   - target must be a staff record in the CALLER'S school
//   - a principal cannot reset another principal or the school admin
//   - nobody resets their own password here (use normal auth flow)
//
// Node runtime - the service-role key never leaves the server.

import { NextResponse } from 'next/server'
import { createClient as createServerClient } from '@/utils/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status })
}

export async function POST(req: Request) {
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return bad('Not authenticated', 401)

  const { data: caller } = await supabase
    .from('profiles')
    .select('role, school_id, is_active')
    .eq('id', user.id)
    .single()

  if (!caller || !caller.is_active || !caller.school_id) return bad('Profile not found', 403)
  if (caller.role !== 'school_admin' && caller.role !== 'principal') {
    return bad('Only a school admin or principal can reset staff passwords', 403)
  }

  let body: { staff_id?: string; new_password?: string }
  try {
    body = await req.json()
  } catch {
    return bad('Invalid request body')
  }

  const staffId = body.staff_id
  const newPassword = body.new_password ?? ''
  if (!staffId) return bad('staff_id is required')
  if (newPassword.length < 8) return bad('Password must be at least 8 characters')

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceKey) return bad('Server is not configured (missing service key)', 500)

  const admin = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    serviceKey,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  // Target must belong to the caller's school
  const { data: target } = await admin
    .from('staff')
    .select('id, school_id, profile_id')
    .eq('id', staffId)
    .single()

  if (!target || target.school_id !== caller.school_id) {
    return bad('Staff member not found', 404)
  }
  if (target.profile_id === user.id) {
    return bad('Use the normal password change flow for your own account')
  }

  const { data: targetProfile } = await admin
    .from('profiles')
    .select('role')
    .eq('id', target.profile_id)
    .single()

  if (caller.role === 'principal' &&
      (targetProfile?.role === 'principal' || targetProfile?.role === 'school_admin')) {
    return bad('A principal cannot reset this account', 403)
  }

  const { error: updateError } = await admin.auth.admin.updateUserById(
    target.profile_id,
    { password: newPassword }
  )

  if (updateError) return bad(updateError.message, 500)

  return NextResponse.json({ ok: true })
}
