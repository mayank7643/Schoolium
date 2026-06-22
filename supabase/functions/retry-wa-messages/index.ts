// FILE: supabase/functions/retry-wa-messages/index.ts
//
// Picks up failed WhatsApp messages from wa_message_log and retries them
// with exponential backoff: 30s → 2min → 5min (max 3 attempts total).
//
// TRIGGERED BY: pg_cron every 5 minutes (see SQL below).
// Also callable manually via HTTP POST for testing.
//
// DEPLOY:
//   supabase functions deploy retry-wa-messages
//
// pg_cron schedule (run in Supabase SQL Editor after deploying):
//   SELECT cron.schedule(
//     'retry-wa-messages',
//     '*/5 * * * *',
//     $$
//       SELECT net.http_post(
//         url     := '<YOUR_SUPABASE_URL>/functions/v1/retry-wa-messages',
//         headers := jsonb_build_object(
//           'Content-Type',  'application/json',
//           'Authorization', 'Bearer <YOUR_SUPABASE_ANON_KEY>'
//         ),
//         body    := '{}'::jsonb
//       );
//     $$
//   );
//
// SECRETS: same as notify-attendance — shares all 4 WA secrets.
// SUPABASE_URL + SERVICE_ROLE_KEY auto-injected.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const BACKOFF_MS = [
  30  * 1000,   // attempt 1 failed → retry after 30s
  2   * 60000,  // attempt 2 failed → retry after 2min
  5   * 60000,  // attempt 3 failed → retry after 5min (last attempt)
]
const MAX_ATTEMPTS = 3

interface WaLogRow {
  id:            string
  school_id:     string
  student_id:    string
  parent_phone:  string
  message_type:  string
  template_name: string
  log_date:      string
  attempt_count: number
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
      components: [{ type: 'body', parameters: params.map(text => ({ type: 'text', text })) }],
    },
  }
  let res: Response
  try {
    res = await fetch(`https://graph.facebook.com/v19.0/${phoneNumberId}/messages`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    })
  } catch (err) {
    return { success: false, error: `Network error: ${String(err)}` }
  }
  if (!res.ok) {
    const errText = await res.text()
    return { success: false, error: `Meta ${res.status}: ${errText}` }
  }
  const data = await res.json() as { messages?: Array<{ id: string }> }
  return { success: true, meta_message_id: data.messages?.[0]?.id }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SERVICE_ROLE_KEY')!,
    )

    const phoneNumberId = Deno.env.get('WHATSAPP_PHONE_NUMBER_ID')!
    const accessToken   = Deno.env.get('WHATSAPP_ACCESS_TOKEN')!
    const testMode      = Deno.env.get('WHATSAPP_TEST_MODE') === 'true'
    const testRecipient = Deno.env.get('WHATSAPP_TEST_RECIPIENT') ?? ''

    // Fetch rows due for retry
    const { data: rows, error: fetchErr } = await admin
      .from('wa_message_log')
      .select('id, school_id, student_id, parent_phone, message_type, template_name, log_date, attempt_count')
      .eq('status', 'failed')
      .lt('attempt_count', MAX_ATTEMPTS)
      .lte('next_retry_at', new Date().toISOString())
      .order('next_retry_at', { ascending: true })
      .limit(50)

    if (fetchErr) {
      console.error('Failed to fetch retry rows:', fetchErr)
      return json({ error: 'DB fetch failed' }, 500)
    }

    if (!rows || rows.length === 0) return json({ success: true, retried: 0 })

    let succeeded = 0
    let failed    = 0

    for (const row of rows as WaLogRow[]) {
      const newAttemptCount = row.attempt_count + 1

      // Check opt-out before retrying
      const { data: student } = await admin
        .from('students')
        .select('full_name, parent_phone_opted_out, school_id')
        .eq('id', row.student_id)
        .single()

      if (!student || student.parent_phone_opted_out) {
        await admin
          .from('wa_message_log')
          .update({ status: 'opted_out_skip', updated_at: new Date().toISOString() })
          .eq('id', row.id)
        continue
      }

      // Check monthly quota before retrying
      const { data: school } = await admin
        .from('schools')
        .select('name, wa_alerts_enabled, wa_monthly_quota, wa_messages_sent_month')
        .eq('id', row.school_id)
        .single()

      if (!school || !school.wa_alerts_enabled || school.wa_messages_sent_month >= school.wa_monthly_quota) {
        await admin
          .from('wa_message_log')
          .update({ status: 'quota_exceeded', updated_at: new Date().toISOString() })
          .eq('id', row.id)
        continue
      }

      // Build params — use current time as best approximation for retry
      const timeIST = new Date().toLocaleTimeString('en-IN', {
        timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true,
      })
      const params    = [student.full_name, school.name, timeIST]
      const rawPhone  = testMode ? testRecipient : row.parent_phone
      const recipient = toE164(rawPhone)

      const result = await sendWhatsAppTemplate(recipient, row.template_name, params, phoneNumberId, accessToken)

      if (result.success) {
        await Promise.all([
          admin.from('wa_message_log').update({
            status:          'sent',
            meta_message_id: result.meta_message_id ?? null,
            sent_at:         new Date().toISOString(),
            attempt_count:   newAttemptCount,
            next_retry_at:   null,
            error_message:   null,
            updated_at:      new Date().toISOString(),
          }).eq('id', row.id),
          admin.rpc('increment_wa_sent_count', { p_school_id: row.school_id }),
        ])
        succeeded++
      } else {
        const isLastAttempt = newAttemptCount >= MAX_ATTEMPTS
        await admin.from('wa_message_log').update({
          error_message: result.error ?? null,
          attempt_count: newAttemptCount,
          next_retry_at: isLastAttempt ? null : new Date(Date.now() + BACKOFF_MS[newAttemptCount]).toISOString(),
          updated_at:    new Date().toISOString(),
        }).eq('id', row.id)
        console.error(`Retry ${newAttemptCount}/${MAX_ATTEMPTS} failed for log ${row.id}:`, result.error)
        failed++
      }
    }

    return json({ success: true, retried: rows.length, succeeded, failed })

  } catch (err) {
    console.error('Unhandled error in retry-wa-messages:', err)
    return json({ error: 'Internal server error' }, 500)
  }
})
