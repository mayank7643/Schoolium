// FILE: middleware.ts
// Updated: guards are redirected to scan page, blocked from dashboard

import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

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

    const isGuard = profile?.role === 'guard'
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

    // ── Logged in user on login/signup → redirect ─────────
    if (pathname === '/login' || pathname === '/signup') {
      const url = request.nextUrl.clone()
      // Guards go to scan page, admins go to dashboard
      url.pathname = isGuard ? `/scan/${schoolId}` : '/dashboard'
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
