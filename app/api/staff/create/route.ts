// FILE: app/api/staff/create/route.ts
//
// Creates a staff member end-to-end (chat17 Staff Management Module):
//   1. Verifies the CALLER is an active school_admin or principal
//      (session cookie via @supabase/ssr - same auth as every page).
//   2. Creates the auth user with the service-role key
//      (handle_new_user trigger creates the profile row).
//   3. Calls create_staff_member() RPC (service_role-only) which claims
//      the profile, assigns EMP-NNNN atomically, and inserts the staff
//      row - all in one DB transaction.
//   4. If the RPC fails for any reason, the freshly created auth user
//      is DELETED so no orphan accounts are left behind.
//
// Node runtime (service-role key is server-only - never NEXT_PUBLIC_).

import { NextResponse } from 'next/server'
import { createClient as createServerClient } from '@/utils/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED_ROLES = ['principal', 'teacher', 'collector', 'receptionist', 'staff'] as const
type StaffRole = (typeof ALLOWED_ROLES)[number]

interface CreateStaffBody {
  email: string
  password: string
  role: StaffRole
  full_name: string
  mobile: string
  designation: string
  department?: string
  is_teaching?: boolean
  father_name?: string
  address?: string
  date_of_birth?: string
  gender?: string
  blood_group?: string
  qualification?: string
  experience_years?: number
  joining_date?: string
}

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status })
}

export async function POST(req: Request) {
  // -- 1. Verify caller ------------------------------------------------
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return bad('Not authenticated', 401)

  const { data: caller } = await supabase
    .from('profiles')
    .select('role, school_id, is_active')
    .eq('id', user.id)
    .single()

  if (!caller || !caller.is_active || !caller.school_id) {
    return bad('Profile not found', 403)
  }
  if (caller.role !== 'school_admin' && caller.role !== 'principal') {
    return bad('Only a school admin or principal can add staff', 403)
  }

  // -- 2. Validate body ------------------------------------------------
  let body: CreateStaffBody
  try {
    body = await req.json()
  } catch {
    return bad('Invalid request body')
  }

  const email = (body.email ?? '').trim().toLowerCase()
  const password = body.password ?? ''
  const fullName = (body.full_name ?? '').trim()
  const mobile = (body.mobile ?? '').replace(/\D/g, '')
  const designation = (body.designation ?? '').trim()

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad('A valid email is required')
  if (password.length < 8) return bad('Password must be at least 8 characters')
  if (fullName.length < 2) return bad('Full name is required')
  if (mobile.length !== 10) return bad('Mobile must be 10 digits')
  if (!designation) return bad('Designation is required')
  if (!ALLOWED_ROLES.includes(body.role)) return bad('Invalid role')

  // Principals may add staff but not other principals - only the
  // school admin can create principal-level accounts.
  if (body.role === 'principal' && caller.role !== 'school_admin') {
    return bad('Only the school admin can create a principal account', 403)
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceKey) return bad('Server is not configured (missing service key)', 500)

  const admin = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    serviceKey,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  // -- 3. Create auth user (profile row via handle_new_user trigger) ---
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName, role: body.role },
  })

  if (createError || !created?.user) {
    const msg = createError?.message ?? 'Failed to create account'
    if (/already( been)? registered/i.test(msg)) {
      return bad('An account with this email already exists')
    }
    return bad(msg, 500)
  }

  const newUserId = created.user.id

  // -- 4. Create HR record via the atomic RPC --------------------------
  const { data: staffResult, error: rpcError } = await admin.rpc('create_staff_member', {
    p_profile_id: newUserId,
    p_school_id: caller.school_id,
    p_role: body.role,
    p_full_name: fullName,
    p_mobile: mobile,
    p_email: email,
    p_designation: designation,
    p_department: body.department?.trim() || 'Teaching',
    p_is_teaching: body.is_teaching ?? body.role === 'teacher',
    p_father_name: body.father_name?.trim() || null,
    p_address: body.address?.trim() || null,
    p_date_of_birth: body.date_of_birth || null,
    p_gender: body.gender || null,
    p_blood_group: body.blood_group || null,
    p_qualification: body.qualification?.trim() || null,
    p_experience_years: body.experience_years ?? 0,
    p_joining_date: body.joining_date || null,
    p_photo_url: null,
    p_created_by: user.id,
  })

  if (rpcError) {
    // Roll back the auth user so no orphan login exists
    await admin.auth.admin.deleteUser(newUserId).catch(() => {})
    return bad(rpcError.message, 500)
  }

  const result = staffResult as { staff_id: string; employee_id: string }

  return NextResponse.json({
    staff_id: result.staff_id,
    employee_id: result.employee_id,
  })
}
