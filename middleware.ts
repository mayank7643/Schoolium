// FILE: middleware.ts
// Guards are redirected to the scan page, blocked from dashboard.
// chat17 Module 7: role-based route gating for staff roles. The
// sidebar HIDES what this middleware BLOCKS - this is the actual
// enforcement (typing a URL directly gets redirected too). Data is
// additionally protected by RLS + RPC role checks; this layer keeps
// each role inside its own workspace:
//   school_admin  everything
//   principal     everything except Settings
//   teacher       dashboard, students, classes, attendance, my leave
//   collector     fees, students (needed to collect), my leave
//   receptionist  students, classes, my leave
//   staff         my leave only
//   guard         scan page only (unchanged)

import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

// Where each restricted role lands after login / when blocked
const ROLE_HOME: Record<string, string> = {
  teacher: '/dashboard',
  collector: '/dashboard/fees',
  receptionist: '/dashboard/students',
  staff: '/dashboard/leave',
  operator: '/dashboard/alerts',
}

// Allowed /dashboard route prefixes per restricted role. Roles not
// listed here (school_admin, super_admin, principal) pass through,
// except principal is blocked from /dashboard/settings below.
// chat17 Module 7b hotfix: teacher no longer gets /dashboard/classes
// or /dashboard/attendance - those pages expose admin controls
// (add class, scanner URL, guard management). The teacher-scoped
// My Classes + class attendance + read-only class fees arrive with
// the Teacher Workspace module and will be added back here.
const ROLE_ALLOW: Record<string, string[]> = {
  teacher: ['/dashboard/leave', '/dashboard/my-classes'],
  collector: ['/dashboard/fees', '/dashboard/leave'],
  // exam module phase 3: front-desk admit card printing is an exact
  // carve-out - receptionists never see the wider /dashboard/exams console
  receptionist: ['/dashboard/students', '/dashboard/classes', '/dashboard/leave', '/dashboard/exams/print-admit-cards'],
  staff: ['/dashboard/leave'],
  // chat21: operator = front desk for the alerts product. The alerts
  // settings page renders admin-only sections itself; credentials and
  // template writes are enforced by the API route + RLS regardless.
  operator: ['/dashboard/alerts', '/dashboard/students'],
}

function isAllowedPath(role: string, pathname: string): boolean {
  const allow = ROLE_ALLOW[role]
  if (!allow) return true
  // the bare dashboard home: only roles whose home IS /dashboard
  if (pathname === '/dashboard') return ROLE_HOME[role] === '/dashboard'
  return allow.some(p => pathname === p || pathname.startsWith(p + '/'))
}

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options as Parameters<typeof supabaseResponse.cookies.set>[2])
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()
  const pathname = request.nextUrl.pathname

  // ── Not logged in → block dashboard ──────────────────────
  if (!user && pathname.startsWith('/dashboard')) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  if (user) {
    // Fetch profile to get role + school_id
    const { data: profile } = await supabase
      .from('profiles')
      .select('role, school_id, is_active')
      .eq('id', user.id)
      .single()

    // ── Deactivated account → force logout ───────────────
    if (profile && !profile.is_active) {
      await supabase.auth.signOut()
      const url = request.nextUrl.clone()
      url.pathname = '/login'
      url.searchParams.set('error', 'account_disabled')
      return NextResponse.redirect(url)
    }

    const role = profile?.role ?? ''
    const isGuard = role === 'guard'
    const schoolId = profile?.school_id

    // ── Guard trying to access dashboard → redirect to scan
    if (isGuard && pathname.startsWith('/dashboard')) {
      const url = request.nextUrl.clone()
      url.pathname = `/scan/${schoolId}`
      return NextResponse.redirect(url)
    }

    // ── Guard on scan page for WRONG school → block ───────
    if (isGuard && pathname.startsWith('/scan/')) {
      const urlSchoolId = pathname.split('/')[2]
      if (urlSchoolId && urlSchoolId !== schoolId) {
        const url = request.nextUrl.clone()
        url.pathname = `/scan/${schoolId}`
        return NextResponse.redirect(url)
      }
    }

    // ── chat17: role route gating inside the dashboard ────
    if (!isGuard && pathname.startsWith('/dashboard')) {
      // principal: everything except school Settings
      if (role === 'principal' && pathname.startsWith('/dashboard/settings')) {
        const url = request.nextUrl.clone()
        url.pathname = '/dashboard'
        return NextResponse.redirect(url)
      }

      // Fee Structures is a management/config surface (defines fee
      // amounts) - admins & principals only, even for fee-enabled
      // roles like collector who otherwise have the fees section.
      if (pathname.startsWith('/dashboard/fees/structures') &&
          !['school_admin', 'principal', 'super_admin'].includes(role)) {
        const url = request.nextUrl.clone()
        url.pathname = ROLE_HOME[role] ?? '/dashboard'
        return NextResponse.redirect(url)
      }

      if (!isAllowedPath(role, pathname)) {
        const url = request.nextUrl.clone()
        url.pathname = ROLE_HOME[role] ?? '/dashboard'
        return NextResponse.redirect(url)
      }
    }

    // ── Logged in user on login/signup → redirect ─────────
    if (pathname === '/login' || pathname === '/signup') {
      const url = request.nextUrl.clone()
      // Guards → scan page; restricted roles → their home; rest → dashboard
      url.pathname = isGuard ? `/scan/${schoolId}` : (ROLE_HOME[role] ?? '/dashboard')
      return NextResponse.redirect(url)
    }
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
