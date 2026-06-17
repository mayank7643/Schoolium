// FILE: supabase/functions/create-guard/index.ts
// Supabase Edge Function — creates guard auth user + profile server-side
// Uses service role key so no email confirmation needed
//
// DEPLOY:
//   supabase functions deploy create-guard
//   supabase secrets set SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
//
// The SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars are
// automatically available in Supabase Edge Functions environment.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface CreateGuardBody {
  email: string
  password: string
  full_name: string
  gate: string
  school_id: string
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  try {
    // ── 1. Verify the caller is an authenticated school_admin ──
    // The caller must send their session token in Authorization header
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing authorization' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Anon client — just to verify the caller's identity
    const anonClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    )

    const { data: { user: callerUser }, error: callerError } = await anonClient.auth.getUser()
    if (callerError || !callerUser) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── 2. Verify caller is school_admin for the given school ──
    const { data: callerProfile, error: profileError } = await anonClient
      .from('profiles')
      .select('role, school_id')
      .eq('id', callerUser.id)
      .single()

    if (profileError || !callerProfile) {
      return new Response(JSON.stringify({ error: 'Profile not found' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const body: CreateGuardBody = await req.json()
    const { email, password, full_name, gate, school_id } = body

    // Caller must be admin of the SAME school they're creating a guard for
    if (callerProfile.role !== 'school_admin' || callerProfile.school_id !== school_id) {
      return new Response(JSON.stringify({ error: 'Forbidden — not admin of this school' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── 3. Validate inputs ─────────────────────────────────────
    if (!email?.trim() || !password || !full_name?.trim() || !gate || !school_id) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    if (password.length < 8) {
      return new Response(JSON.stringify({ error: 'Password must be at least 8 characters' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── 4. Create auth user with service role (no email confirmation) ──
    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    const { data: newUser, error: createError } = await adminClient.auth.admin.createUser({
      email: email.trim(),
      password,
      email_confirm: true,   // auto-confirmed — no email sent
      user_metadata: { full_name: full_name.trim() },
    })

    if (createError) {
      // "User already registered" → surface cleanly
      return new Response(JSON.stringify({ error: createError.message }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── 5. Upsert profile row with role=guard ──────────────────
    const { error: upsertError } = await adminClient
      .from('profiles')
      .upsert({
        id:        newUser.user.id,
        full_name: full_name.trim(),
        role:      'guard',
        school_id,
        gate,
        is_active: true,
      })

    if (upsertError) {
      // Auth user created but profile failed — clean up auth user
      await adminClient.auth.admin.deleteUser(newUser.user.id)
      return new Response(JSON.stringify({ error: 'Failed to create guard profile' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    return new Response(
      JSON.stringify({
        success: true,
        guard_id: newUser.user.id,
        email: email.trim(),
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )

  } catch (err) {
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
