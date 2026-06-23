// FILE: supabase/functions/generate-fee-dues/index.ts
//
// Triggers the fee dues automation engine.
// Called by the UI when admin saves/activates a fee structure,
// or when a new student is added to a class that has an active structure.
//
// DEPLOY:
//   supabase functions deploy generate-fee-dues
//
// SECRETS — auto-injected by Supabase, no manual setup needed:
//   SUPABASE_URL
//   SUPABASE_ANON_KEY
//   SERVICE_ROLE_KEY   ← set this in Dashboard → Settings → Edge Functions → Secrets
//                         (same secret already used by notify-attendance)
//
// WHY THIS NEEDS AN EDGE FUNCTION:
//   generate_fee_dues() writes fee_due rows for ALL students in a class.
//   RLS blocks school_admin from mass-inserting across students directly.
//   Edge Function uses service role key to bypass RLS for the bulk insert,
//   but still verifies the caller is an authenticated school_admin first.
//
// FLOW:
//   1. Verify caller is authenticated school_admin
//   2. Verify fee_structure belongs to caller's school
//   3. Call generate_fee_dues() DB function with service role
//   4. Return count of generated + skipped dues

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface GenerateFeesDuesBody {
  fee_structure_id: string   // UUID of the fee structure to generate dues for
  from_month?:      string   // 'YYYY-MM' — only generate from this month. Optional.
                             // Use this when adding a mid-year student:
                             // pass their admission month so you don't backdate dues
}

function json(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  try {

    // ── STEP 1: Verify caller is authenticated ────────────────────────────────
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return json({ error: 'Missing authorization header' }, 401)
    }

    // Use anon client to verify the user's JWT
    const anonClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    )

    const { data: { user }, error: authErr } = await anonClient.auth.getUser()
    if (authErr || !user) {
      return json({ error: 'Unauthorized' }, 401)
    }

    // ── STEP 2: Verify caller is an active school_admin ───────────────────────
    const { data: caller, error: callerErr } = await anonClient
      .from('profiles')
      .select('role, school_id, is_active')
      .eq('id', user.id)
      .single()

    if (callerErr || !caller) {
      return json({ error: 'Profile not found' }, 403)
    }
    if (!caller.is_active) {
      return json({ error: 'Account deactivated' }, 403)
    }
    if (caller.role !== 'school_admin') {
      return json({ error: 'Only school admins can generate fee dues' }, 403)
    }

    // ── STEP 3: Parse request body ────────────────────────────────────────────
    let body: GenerateFeesDuesBody
    try {
      body = await req.json()
    } catch {
      return json({ error: 'Invalid JSON body' }, 400)
    }

    const { fee_structure_id, from_month } = body

    if (!fee_structure_id) {
      return json({ error: 'fee_structure_id is required' }, 400)
    }

    // Validate from_month format if provided: must be 'YYYY-MM'
    if (from_month && !/^\d{4}-\d{2}$/.test(from_month)) {
      return json({ error: 'from_month must be in YYYY-MM format e.g. 2025-06' }, 400)
    }

    // ── STEP 4: Service role client for privileged DB access ──────────────────
    // NOTE: Secret is SERVICE_ROLE_KEY — not SUPABASE_SERVICE_ROLE_KEY
    // SUPABASE_ prefix is reserved and will error
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SERVICE_ROLE_KEY')!,
    )

    // ── STEP 5: Verify the fee_structure belongs to caller's school ───────────
    // Security check: admin cannot trigger generation for another school's structure
    const { data: structure, error: structureErr } = await admin
      .from('fee_structures')
      .select('id, name, school_id, class_id, academic_year, is_active')
      .eq('id', fee_structure_id)
      .single()

    if (structureErr || !structure) {
      return json({ error: 'Fee structure not found' }, 404)
    }

    if (structure.school_id !== caller.school_id) {
      return json({ error: 'Forbidden — structure does not belong to your school' }, 403)
    }

    if (!structure.is_active) {
      return json({ error: 'Fee structure is not active. Activate it before generating dues.' }, 400)
    }

    // ── STEP 6: Call the DB automation function ───────────────────────────────
    // generate_fee_dues() is a SECURITY DEFINER function in the DB.
    // It handles: all students in class, all items, all months,
    // discount calculation, dedup via ON CONFLICT DO NOTHING.
    const { data: result, error: generateErr } = await admin.rpc('generate_fee_dues', {
      p_fee_structure_id: fee_structure_id,
      p_from_month:       from_month ?? null,
    })

    if (generateErr) {
      console.error('generate_fee_dues RPC error:', generateErr)
      return json({
        error:   'Failed to generate fee dues',
        details: generateErr.message,
      }, 500)
    }

    // result is the first row from the RETURNS TABLE — { generated_count, skipped_count }
    const { generated_count, skipped_count } = result?.[0] ?? { generated_count: 0, skipped_count: 0 }

    // ── STEP 7: Return result ─────────────────────────────────────────────────
    return json({
      success:         true,
      fee_structure:   structure.name,
      academic_year:   structure.academic_year,
      generated_count,  // new dues created
      skipped_count,    // already existed (idempotent — safe to call again)
      message: generated_count === 0
        ? 'No new dues generated — all dues already exist for this structure'
        : `Generated ${generated_count} new dues. ${skipped_count} already existed.`,
    })

  } catch (err) {
    console.error('Unhandled error in generate-fee-dues:', err)
    return json({ error: 'Internal server error' }, 500)
  }
})
