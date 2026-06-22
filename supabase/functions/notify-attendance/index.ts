// FILE: supabase/functions/notify-attendance/index.ts

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface NotifyAttendanceBody {
  student_id:    string
  school_id:     string
  attendance_id: string
  entry_type:    'entry' | 'exit'
  scan_time:     string
  gate:          string
}

interface MetaTemplatePayload {
  messaging_product: 'whatsapp'
  to:                string
  type:              'template'
  template: {
    name:       string
    language:   { code: string }
    components: Array<{
      type:       'body'
      parameters: Array<{ type: 'text'; text: string }>
    }>
  }
}

function toE164(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  return digits.length === 10 ? `91${digits}` : digits
}

function formatTimeIST(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour:     '2-digit',
    minute:   '2-digit',
    hour12:   true,
  })
}

function json(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

async function sendWhatsAppTemplate(
  to:            string,
  templateName:  string,
  params:        string[],
  phoneNumberId: string,
  accessToken:   string,
): Promise<{ success: boolean; meta_message_id?: string; error?: string }> {

  const payload: MetaTemplatePayload = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name:     templateName,
      language: { code: 'en' },
      components: [
        {
          type: 'body',
          parameters: params.map(text => ({ type: 'text', text })),
        },
      ],
    },
  }

  let res: Response
  try {
    res = await fetch(
      `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
      {
        method:  'POST',
        headers: {
          Authorization:  `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      }
    )
  } catch (networkErr) {
    return { success: false, error: `Network error: ${String(networkErr)}` }
  }

  if (!res.ok) {
    const errText = await res.text()
    return { success: false, error: `Meta ${res.status}: ${errText}` }
  }

  const data = await res.json() as { messages?: Array<{ id: string }> }
  return { success: true, meta_message_id: data.messages?.[0]?.id }
}

Deno.serve(async (req) => {

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  try {

    // ── STEP 1: Verify caller is authenticated ────────────────────────────────
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Missing authorization' }, 401)

    const anonClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    )

    const { data: { user }, error: authErr } = await anonClient.auth.getUser()
    if (authErr || !user) return json({ error: 'Unauthorized' }, 401)

    // ── STEP 2: Verify caller role — guard or school_admin only ───────────────
    const { data: caller, error: callerErr } = await anonClient
      .from('profiles')
      .select('role, school_id, is_active')
      .eq('id', user.id)
      .single()

    if (callerErr || !caller)        return json({ error: 'Profile not found' }, 403)
    if (!caller.is_active)           return json({ error: 'Account deactivated' }, 403)
    if (!['guard', 'school_admin'].includes(caller.role)) {
      return json({ error: 'Forbidden' }, 403)
    }

    // ── STEP 3: Parse body ────────────────────────────────────────────────────
    let body: NotifyAttendanceBody
    try {
      body = await req.json()
    } catch {
      return json({ error: 'Invalid JSON' }, 400)
    }

    const { student_id, school_id, attendance_id, entry_type, scan_time, gate } = body

    if (!student_id || !school_id || !attendance_id || !entry_type || !scan_time || !gate) {
      return json({ error: 'Missing required fields' }, 400)
    }

    if (!['entry', 'exit'].includes(entry_type)) {
      return json({ error: 'Invalid entry_type' }, 400)
    }

    if (caller.school_id !== school_id) {
      return json({ error: 'Forbidden — school mismatch' }, 403)
    }

    // ── STEP 4: Service role client for privileged reads/writes ───────────────
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SERVICE_ROLE_KEY')!,   // NOTE: SERVICE_ROLE_KEY not SUPABASE_SERVICE_ROLE_KEY
    )

    // ── STEP 5: Fetch student + school in parallel ────────────────────────────
    const [studentRes, schoolRes] = await Promise.all([
      admin
        .from('students')
        .select('id, full_name, parent_phone, parent_phone_opted_out, school_id')
        .eq('id', student_id)
        .eq('school_id', school_id)
        .single(),
      admin
        .from('schools')
        .select('id, name, wa_alerts_enabled, wa_monthly_quota, wa_messages_sent_month, wa_quota_reset_date')
        .eq('id', school_id)
        .single(),
    ])

    if (studentRes.error || !studentRes.data) {
      return json({ error: 'Student not found' }, 404)
    }
    if (schoolRes.error || !schoolRes.data) {
      return json({ error: 'School not found' }, 404)
    }

    const student = studentRes.data
    const school  = schoolRes.data

    // ── STEP 5.5: Feature gate — WA alerts must be enabled for this school ────
    if (!school.wa_alerts_enabled) {
      return json({ success: true, skipped: true, reason: 'feature_not_enabled' })
    }

    // ── STEP 6: Skip if no parent phone ──────────────────────────────────────
    if (!student.parent_phone?.trim()) {
      return json({ success: true, skipped: true, reason: 'no_parent_phone' })
    }

    // ── STEP 7: Opt-out check ─────────────────────────────────────────────────
    if (student.parent_phone_opted_out === true) {
      return json({ success: true, skipped: true, reason: 'opted_out' })
    }

    // ── STEP 8: Monthly quota check ───────────────────────────────────────────
    const today     = new Date()
    const resetDate = new Date(school.wa_quota_reset_date)
    const isNewMonth = (
      today.getFullYear() > resetDate.getFullYear() ||
      today.getMonth()    > resetDate.getMonth()
    )

    if (isNewMonth) {
      await admin
        .from('schools')
        .update({
          wa_messages_sent_month: 0,
          wa_quota_reset_date:    `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`,
        })
        .eq('id', school_id)
      school.wa_messages_sent_month = 0
    }

    if (school.wa_messages_sent_month >= school.wa_monthly_quota) {
      await admin.from('wa_message_log').insert({
        school_id,
        student_id,
        parent_phone:  student.parent_phone,
        message_type:  entry_type === 'entry' ? 'entry_alert' : 'exit_alert',
        template_name: entry_type === 'entry' ? 'student_entry_alert' : 'student_exit_alert',
        log_date:      scan_time.slice(0, 10),
        status:        'quota_exceeded',
      }).on('conflict', () => {})
      return json({ success: true, skipped: true, reason: 'quota_exceeded' })
    }

    // ── STEP 9: Dedup — INSERT log row BEFORE API call ────────────────────────
    const logDate      = scan_time.slice(0, 10)
    const messageType  = entry_type === 'entry' ? 'entry_alert' : 'exit_alert'
    const templateName = entry_type === 'entry' ? 'student_entry_alert' : 'student_exit_alert'

    const { error: insertErr } = await admin
      .from('wa_message_log')
      .insert({
        school_id,
        student_id,
        parent_phone:  student.parent_phone,
        message_type:  messageType,
        template_name: templateName,
        log_date:      logDate,
        status:        'pending',
        attempt_count: 0,
      })

    if (insertErr) {
      if (insertErr.code === '23505') {
        return json({ success: true, skipped: true, reason: 'already_sent_today' })
      }
      console.error('wa_message_log insert error:', insertErr)
      return json({ success: true, skipped: true, reason: 'log_error' })
    }

    // ── STEP 10: Build template params ────────────────────────────────────────
    const timeIST = formatTimeIST(scan_time)
    const params  = [student.full_name, school.name, timeIST]

    // ── STEP 11: Resolve recipient ────────────────────────────────────────────
    const testMode = Deno.env.get('WHATSAPP_TEST_MODE') === 'true'
    const rawPhone = testMode
      ? Deno.env.get('WHATSAPP_TEST_RECIPIENT')!
      : student.parent_phone
    const recipient = toE164(rawPhone)

    // ── STEP 12: Send via Meta Cloud API ──────────────────────────────────────
    const result = await sendWhatsAppTemplate(
      recipient,
      templateName,
      params,
      Deno.env.get('WHATSAPP_PHONE_NUMBER_ID')!,
      Deno.env.get('WHATSAPP_ACCESS_TOKEN')!,
    )

    // ── STEP 13: Update log row with result ───────────────────────────────────
    if (result.success) {
      await Promise.all([
        admin
          .from('wa_message_log')
          .update({
            status:          'sent',
            meta_message_id: result.meta_message_id ?? null,
            sent_at:         new Date().toISOString(),
            attempt_count:   1,
          })
          .eq('school_id',    school_id)
          .eq('student_id',   student_id)
          .eq('log_date',     logDate)
          .eq('message_type', messageType),

        admin.rpc('increment_wa_sent_count', { p_school_id: school_id }),
      ])

      return json({
        success:         true,
        meta_message_id: result.meta_message_id,
        test_mode:       testMode,
      })

    } else {
      await admin
        .from('wa_message_log')
        .update({
          status:         'failed',
          error_message:  result.error ?? null,
          attempt_count:  1,
          next_retry_at:  new Date(Date.now() + 30_000).toISOString(),
        })
        .eq('school_id',    school_id)
        .eq('student_id',   student_id)
        .eq('log_date',     logDate)
        .eq('message_type', messageType)

      console.error('WhatsApp send failed:', result.error)
      return json({ success: false, wa_error: result.error })
    }

  } catch (err) {
    console.error('Unhandled error in notify-attendance:', err)
    return json({ error: 'Internal server error' }, 500)
  }
})
