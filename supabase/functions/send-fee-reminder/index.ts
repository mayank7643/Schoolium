// FILE: supabase/functions/send-fee-reminder/index.ts
//
// Sends WhatsApp fee reminder messages to parents via Meta Cloud API.
// Supports single student reminders and bulk reminders (defaulter list).
// Uses the same WA quota system as notify-attendance.
//
// DEPLOY:
//   supabase functions deploy send-fee-reminder
//
// SECRETS — set via Dashboard → Settings → Edge Functions → Secrets:
//   WHATSAPP_ACCESS_TOKEN       ← Meta System User token (never-expiring)
//   WHATSAPP_PHONE_NUMBER_ID    ← Meta Business → WhatsApp → Phone Numbers
//   WHATSAPP_TEST_MODE          ← "true" for testing, "false" for production
//   WHATSAPP_TEST_RECIPIENT     ← test number in E.164 without + e.g. "911234567890"
//   SERVICE_ROLE_KEY            ← same secret used by notify-attendance
//
// META TEMPLATES NEEDED (create in Meta Business → WhatsApp Manager):
//
//   Template 1: fee_due_reminder   (UTILITY)
//   Body: Dear Parent, this is a reminder that the fee of ₹{{1}} for {{2}} ({{3}})
//         is due on {{4}}. Please pay at the school office to avoid late charges.
//   Params: [amount_due, student_name, month, due_date]
//
//   Template 2: fee_overdue_reminder   (UTILITY)
//   Body: Dear Parent, the fee of ₹{{1}} for {{2}} ({{3}}) was due on {{4}} and
//         is now overdue. Please pay at the earliest to avoid additional late fees.
//   Params: [amount_due, student_name, month, due_date]
//
// IMPORTANT: No payment links — school admin collects in person only.
//
// FLOW:
//   1. Verify caller is authenticated school_admin
//   2. Accept single student_id or array of student_ids (bulk)
//   3. For each student: check opt-out → check quota → dedup → send
//   4. Log every attempt in wa_message_log
//   5. Never block on failure — fire-and-forget per student in bulk mode

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface SendFeeReminderBody {
  school_id:    string
  student_ids:  string[]          // one or many — bulk supported
  reminder_type: 'due' | 'overdue' // which template to use
  // Optional: if not provided, function fetches latest pending due automatically
  due_amount?:  number
  month?:       string            // 'YYYY-MM'
  due_date?:    string            // 'YYYY-MM-DD'
}

interface WaResult {
  student_id:  string
  success:     boolean
  skipped:     boolean
  skip_reason?: string
  error?:      string
}

function toE164(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  return digits.length === 10 ? `91${digits}` : digits
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-IN', {
    day:   '2-digit',
    month: 'short',
    year:  'numeric',
  })
}

function formatAmount(amount: number): string {
  return amount.toLocaleString('en-IN')
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

  let res: Response
  try {
    res = await fetch(
      `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization:  `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'template',
          template: {
            name:     templateName,
            language: { code: 'en' },
            components: [{
              type:       'body',
              parameters: params.map(text => ({ type: 'text', text })),
            }],
          },
        }),
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

async function processOneStudent(
  admin:         ReturnType<typeof createClient>,
  schoolId:      string,
  studentId:     string,
  school:        { name: string; wa_alerts_enabled: boolean; wa_monthly_quota: number; wa_messages_sent_month: number; wa_quota_reset_date: string },
  reminderType:  'due' | 'overdue',
  dueAmount?:    number,
  month?:        string,
  dueDate?:      string,
): Promise<WaResult> {

  // ── Feature gate ─────────────────────────────────────────────────────────
  if (!school.wa_alerts_enabled) {
    return { student_id: studentId, success: false, skipped: true, skip_reason: 'feature_not_enabled' }
  }

  // ── Load student ──────────────────────────────────────────────────────────
  const { data: student, error: studentErr } = await admin
    .from('students')
    .select('id, full_name, parent_phone, parent_phone_opted_out')
    .eq('id', studentId)
    .eq('school_id', schoolId)
    .single()

  if (studentErr || !student) {
    return { student_id: studentId, success: false, skipped: true, skip_reason: 'student_not_found' }
  }

  // ── Opt-out check ─────────────────────────────────────────────────────────
  if (student.parent_phone_opted_out) {
    return { student_id: studentId, success: false, skipped: true, skip_reason: 'opted_out' }
  }

  if (!student.parent_phone?.trim()) {
    return { student_id: studentId, success: false, skipped: true, skip_reason: 'no_parent_phone' }
  }

  // ── If due details not passed, fetch the latest pending due ──────────────
  let finalAmount  = dueAmount
  let finalMonth   = month
  let finalDueDate = dueDate

  if (!finalAmount || !finalMonth || !finalDueDate) {
    const { data: latestDue } = await admin
      .from('fee_dues')
      .select('balance, month, due_date')
      .eq('student_id', studentId)
      .eq('school_id', schoolId)
      .in('status', ['unpaid', 'partial'])
      .gt('balance', 0)
      .order('due_date', { ascending: true })
      .limit(1)
      .single()

    if (!latestDue) {
      return { student_id: studentId, success: false, skipped: true, skip_reason: 'no_pending_dues' }
    }

    finalAmount  = latestDue.balance
    finalMonth   = latestDue.month
    finalDueDate = latestDue.due_date
  }

  // ── Monthly quota check ───────────────────────────────────────────────────
  const today     = new Date()
  const resetDate = new Date(school.wa_quota_reset_date)
  const isNewMonth = (
    today.getFullYear() > resetDate.getFullYear() ||
    today.getMonth()    > resetDate.getMonth()
  )

  if (isNewMonth) {
    await admin.from('schools').update({
      wa_messages_sent_month: 0,
      wa_quota_reset_date: `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`,
    }).eq('id', schoolId)
    school.wa_messages_sent_month = 0
  }

  if (school.wa_messages_sent_month >= school.wa_monthly_quota) {
    return { student_id: studentId, success: false, skipped: true, skip_reason: 'quota_exceeded' }
  }

  // ── Dedup — INSERT log before API call ────────────────────────────────────
  // Message type for fee reminders uses the month as part of dedup key
  const messageType  = `fee_reminder_${reminderType}_${finalMonth}` // e.g. fee_reminder_due_2025-06
  const templateName = reminderType === 'due' ? 'fee_due_reminder' : 'fee_overdue_reminder'
  const logDate      = today.toISOString().slice(0, 10)

  const { error: insertErr } = await admin
    .from('wa_message_log')
    .insert({
      school_id:     schoolId,
      student_id:    studentId,
      parent_phone:  student.parent_phone,
      message_type:  messageType,
      template_name: templateName,
      log_date:      logDate,
      status:        'pending',
      attempt_count: 0,
    })

  if (insertErr) {
    if (insertErr.code === '23505') {
      // Unique constraint hit — already sent this reminder today for this month
      return { student_id: studentId, success: false, skipped: true, skip_reason: 'already_sent_today' }
    }
    return { student_id: studentId, success: false, skipped: true, skip_reason: 'log_error' }
  }

  // ── Build template params ─────────────────────────────────────────────────
  // Template params order matches approved Meta template:
  // [amount_due, student_name, month_display, due_date_display]
  const params = [
    `₹${formatAmount(finalAmount!)}`,
    student.full_name,
    finalMonth!,       // e.g. "2025-06"
    formatDate(finalDueDate!),
  ]

  // ── Resolve recipient ─────────────────────────────────────────────────────
  const testMode = Deno.env.get('WHATSAPP_TEST_MODE') === 'true'
  const rawPhone = testMode
    ? Deno.env.get('WHATSAPP_TEST_RECIPIENT')!
    : student.parent_phone
  const recipient = toE164(rawPhone)

  // ── Send via Meta API ─────────────────────────────────────────────────────
  const result = await sendWhatsAppTemplate(
    recipient,
    templateName,
    params,
    Deno.env.get('WHATSAPP_PHONE_NUMBER_ID')!,
    Deno.env.get('WHATSAPP_ACCESS_TOKEN')!,
  )

  // ── Update log row ────────────────────────────────────────────────────────
  if (result.success) {
    await Promise.all([
      admin.from('wa_message_log').update({
        status:          'sent',
        meta_message_id: result.meta_message_id ?? null,
        sent_at:         new Date().toISOString(),
        attempt_count:   1,
      })
      .eq('school_id',    schoolId)
      .eq('student_id',   studentId)
      .eq('log_date',     logDate)
      .eq('message_type', messageType),

      admin.rpc('increment_wa_sent_count', { p_school_id: schoolId }),
    ])

    // Update in-memory quota counter so bulk sends respect the quota
    school.wa_messages_sent_month += 1

    return { student_id: studentId, success: true, skipped: false }

  } else {
    await admin.from('wa_message_log').update({
      status:        'failed',
      error_message: result.error ?? null,
      attempt_count: 1,
      next_retry_at: new Date(Date.now() + 30_000).toISOString(),
    })
    .eq('school_id',    schoolId)
    .eq('student_id',   studentId)
    .eq('log_date',     logDate)
    .eq('message_type', messageType)

    return { student_id: studentId, success: false, skipped: false, error: result.error }
  }
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

    // ── STEP 2: Verify caller is active school_admin ──────────────────────────
    const { data: caller, error: callerErr } = await anonClient
      .from('profiles')
      .select('role, school_id, is_active')
      .eq('id', user.id)
      .single()

    if (callerErr || !caller)           return json({ error: 'Profile not found' }, 403)
    if (!caller.is_active)              return json({ error: 'Account deactivated' }, 403)
    if (caller.role !== 'school_admin') return json({ error: 'Only school admins can send fee reminders' }, 403)

    // ── STEP 3: Parse body ────────────────────────────────────────────────────
    let body: SendFeeReminderBody
    try {
      body = await req.json()
    } catch {
      return json({ error: 'Invalid JSON body' }, 400)
    }

    const { school_id, student_ids, reminder_type, due_amount, month, due_date } = body

    if (!school_id || !student_ids?.length || !reminder_type) {
      return json({ error: 'school_id, student_ids (array), and reminder_type are required' }, 400)
    }

    if (!['due', 'overdue'].includes(reminder_type)) {
      return json({ error: 'reminder_type must be "due" or "overdue"' }, 400)
    }

    if (caller.school_id !== school_id) {
      return json({ error: 'Forbidden — school mismatch' }, 403)
    }

    // Cap bulk sends at 100 per request to prevent runaway
    if (student_ids.length > 100) {
      return json({ error: 'Maximum 100 students per request. Split into batches.' }, 400)
    }

    // ── STEP 4: Service role client ───────────────────────────────────────────
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SERVICE_ROLE_KEY')!,
    )

    // ── STEP 5: Load school once (shared across all students in bulk) ─────────
    const { data: school, error: schoolErr } = await admin
      .from('schools')
      .select('id, name, wa_alerts_enabled, wa_monthly_quota, wa_messages_sent_month, wa_quota_reset_date')
      .eq('id', school_id)
      .single()

    if (schoolErr || !school) return json({ error: 'School not found' }, 404)

    // ── STEP 6: Process each student ──────────────────────────────────────────
    // Run sequentially (not parallel) to respect quota counter accurately.
    // For 100 students this takes ~2-3 seconds which is fine for a background action.
    const results: WaResult[] = []

    for (const studentId of student_ids) {
      const result = await processOneStudent(
        admin,
        school_id,
        studentId,
        school,        // passed by reference — quota counter updates in-loop
        reminder_type,
        due_amount,
        month,
        due_date,
      )
      results.push(result)

      // Stop sending if quota hit mid-bulk
      if (result.skip_reason === 'quota_exceeded') {
        // Mark remaining as skipped
        const remaining = student_ids.slice(results.length)
        for (const id of remaining) {
          results.push({ student_id: id, success: false, skipped: true, skip_reason: 'quota_exceeded' })
        }
        break
      }
    }

    // ── STEP 7: Summary response ──────────────────────────────────────────────
    const sent    = results.filter(r => r.success).length
    const skipped = results.filter(r => r.skipped).length
    const failed  = results.filter(r => !r.success && !r.skipped).length

    return json({
      success: true,
      summary: { sent, skipped, failed, total: results.length },
      results,
    })

  } catch (err) {
    console.error('Unhandled error in send-fee-reminder:', err)
    return json({ error: 'Internal server error' }, 500)
  }
})
