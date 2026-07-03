// FILE: app/api/wa/worker/route.ts
//
// The single WhatsApp send worker for all fee messages. It drains the wa_outbox
// queue: for reminders it sends a text template; for payment confirmations it
// renders a single-page PDF receipt, uploads it to the private 'fee-receipts'
// bucket, mints a 30-day signed URL, and sends a document template.
//
// TRIGGERED BY:
//   - pg_cron 'drain-wa-outbox' every 2 min  (POST with x-cron-secret header)
//   - the manual "send now" route (step 4)   (same header, optional outbox_ids)
//
// This runs in the Node.js runtime (NOT Edge) because @react-pdf/renderer needs
// Node. Secrets live in Vercel env vars (server-only, never shipped to client):
//   NEXT_PUBLIC_SUPABASE_URL       (already set)
//   SUPABASE_SERVICE_ROLE_KEY      (add - service role; server-only)
//   WHATSAPP_ACCESS_TOKEN          (add - Meta System User token, never-expiring)
//   WHATSAPP_PHONE_NUMBER_ID       (add)
//   WHATSAPP_TEST_MODE             (add - "true" while testing)
//   WHATSAPP_TEST_RECIPIENT        (add - E.164 without +, e.g. "919999999999")
//   CRON_SECRET                    (add - shared secret; must match pg_cron)
//
// Idempotency + safety:
//   - claim_wa_outbox() hands each row to exactly one worker run (SKIP LOCKED).
//   - Before any send we check wa_message_log for an existing 'sent' row on the
//     same dedup key; if present we mark the outbox row sent WITHOUT re-sending.
//   - Confirmations bypass the monthly quota (transactional); reminders respect it.
//   - Failures back off exponentially and retry up to max_attempts, then 'failed'.

import { NextResponse } from 'next/server'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { renderReceiptPdfBuffer } from '@/app/lib/receiptPdf'
import type { ReceiptInput, ReceiptLineInput } from '@/app/lib/receipt'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const GRAPH_URL = 'https://graph.facebook.com/v19.0'
const BUCKET = 'fee-receipts'
const SIGNED_URL_TTL = 60 * 60 * 24 * 30 // 30 days

type OutboxKind = 'fee_due_reminder' | 'fee_overdue_reminder' | 'fee_payment_confirmation'

interface OutboxRow {
  id: string
  school_id: string
  student_id: string
  kind: OutboxKind
  ref_id: string | null
  ref_text: string | null
  attempt_count: number
  max_attempts: number
}

interface SchoolRow {
  id: string
  name: string
  phone: string | null
  wa_fee_reminders_enabled: boolean
  wa_payment_confirmation_enabled: boolean
  wa_monthly_quota: number
  wa_messages_sent_month: number
  wa_quota_reset_date: string
}

interface StudentRow {
  id: string
  full_name: string
  student_uid: string | null
  father_name: string | null
  address: string | null
  parent_phone: string | null
  parent_phone_opted_out: boolean
}

type Outcome =
  | { kind: 'sent' }
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; error: string }

// ---- helpers ----------------------------------------------------------------

function admin(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

function toE164(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  return digits.length === 10 ? `91${digits}` : digits
}

function fmtAmount(n: number): string {
  return 'Rs. ' + Math.round(n).toLocaleString('en-IN')
}

function fmtDate(d: string): string {
  return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

function utcDate(): string {
  return new Date().toISOString().slice(0, 10)
}

function recipientPhone(studentPhone: string): string {
  const testMode = process.env.WHATSAPP_TEST_MODE === 'true'
  const raw = testMode ? (process.env.WHATSAPP_TEST_RECIPIENT || studentPhone) : studentPhone
  return toE164(raw)
}

// One place that talks to Meta. Returns the message id on success.
async function sendTemplate(to: string, name: string, components: unknown[]) {
  const res = await fetch(`${GRAPH_URL}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: { name, language: { code: 'en' }, components },
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Meta ${res.status}: ${text.slice(0, 400)}`)
  }
  const data = (await res.json()) as { messages?: Array<{ id: string }> }
  return data.messages?.[0]?.id ?? null
}

// Monthly quota reset (mirrors notify-attendance / send-fee-reminder).
async function ensureQuotaWindow(db: SupabaseClient, school: SchoolRow) {
  const today = new Date()
  const reset = new Date(school.wa_quota_reset_date)
  const newMonth =
    today.getFullYear() > reset.getFullYear() || today.getMonth() > reset.getMonth()
  if (newMonth) {
    const first = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`
    await db.from('schools').update({ wa_messages_sent_month: 0, wa_quota_reset_date: first }).eq('id', school.id)
    school.wa_messages_sent_month = 0
  }
}

// Has this exact message already been logged as sent? (idempotency guard)
async function alreadySent(
  db: SupabaseClient,
  schoolId: string,
  messageType: string,
  refId: string | null,
  refText: string | null,
  logDate: string,
): Promise<boolean> {
  let q = db.from('wa_message_log').select('id').eq('school_id', schoolId).eq('message_type', messageType).eq('status', 'sent').limit(1)
  if (messageType === 'fee_payment_confirmation') {
    q = q.eq('ref_text', refText)
  } else {
    q = q.eq('ref_id', refId).eq('log_date', logDate)
  }
  const { data } = await q
  return !!(data && data.length)
}

// Write / refresh the audit row in wa_message_log.
async function writeLog(
  db: SupabaseClient,
  row: {
    school_id: string; student_id: string; parent_phone: string;
    message_type: string; template_name: string; log_date: string;
    ref_id: string | null; ref_text: string | null;
    status: 'sent' | 'failed'; meta_message_id?: string | null; error_message?: string | null;
  },
) {
  // Find an existing row for this dedup key; update it if present, else insert.
  let sel = db.from('wa_message_log').select('id').eq('school_id', row.school_id).eq('message_type', row.message_type)
  if (row.message_type === 'fee_payment_confirmation') sel = sel.eq('ref_text', row.ref_text)
  else sel = sel.eq('ref_id', row.ref_id).eq('log_date', row.log_date)
  const { data: existing } = await sel.limit(1)

  const payload = {
    ...row,
    attempt_count: 1,
    sent_at: row.status === 'sent' ? new Date().toISOString() : null,
  }
  if (existing && existing.length) {
    await db.from('wa_message_log').update(payload).eq('id', (existing[0] as { id: string }).id)
  } else {
    await db.from('wa_message_log').insert(payload)
  }
}

// ---- reminders --------------------------------------------------------------

async function processReminder(
  db: SupabaseClient, row: OutboxRow, school: SchoolRow, student: StudentRow,
): Promise<Outcome> {
  if (!school.wa_fee_reminders_enabled) return { kind: 'skipped', reason: 'feature_off' }
  if (student.parent_phone_opted_out) return { kind: 'skipped', reason: 'opted_out' }
  if (!student.parent_phone?.trim()) return { kind: 'skipped', reason: 'no_phone' }
  if (!row.ref_id) return { kind: 'skipped', reason: 'missing_due' }

  const { data: due } = await db
    .from('fee_dues')
    .select('id, balance, month, due_date, status')
    .eq('id', row.ref_id)
    .eq('school_id', row.school_id)
    .single()

  // If the due was paid/cleared since enqueue, don't nag.
  if (!due || Number(due.balance) <= 0 || !['unpaid', 'partial'].includes(due.status)) {
    return { kind: 'skipped', reason: 'due_cleared' }
  }

  const messageType = row.kind // 'fee_due_reminder' | 'fee_overdue_reminder'
  const templateName = row.kind
  const logDate = utcDate()

  if (await alreadySent(db, row.school_id, messageType, row.ref_id, null, logDate)) {
    return { kind: 'sent' } // treat as done; do not double-send
  }

  // Quota (reminders respect it)
  await ensureQuotaWindow(db, school)
  if (school.wa_messages_sent_month >= school.wa_monthly_quota) {
    return { kind: 'skipped', reason: 'quota_exceeded' }
  }

  const params = [
    fmtAmount(Number(due.balance)),
    student.full_name,
    due.month ?? '',
    fmtDate(due.due_date),
  ].map((text) => ({ type: 'text', text }))

  try {
    const metaId = await sendTemplate(recipientPhone(student.parent_phone), templateName, [
      { type: 'body', parameters: params },
    ])
    await writeLog(db, {
      school_id: row.school_id, student_id: row.student_id, parent_phone: student.parent_phone,
      message_type: messageType, template_name: templateName, log_date: logDate,
      ref_id: row.ref_id, ref_text: null, status: 'sent', meta_message_id: metaId,
    })
    await db.rpc('increment_wa_sent_count', { p_school_id: row.school_id })
    school.wa_messages_sent_month += 1
    return { kind: 'sent' }
  } catch (err) {
    await writeLog(db, {
      school_id: row.school_id, student_id: row.student_id, parent_phone: student.parent_phone,
      message_type: messageType, template_name: templateName, log_date: logDate,
      ref_id: row.ref_id, ref_text: null, status: 'failed', error_message: String(err),
    })
    return { kind: 'failed', error: String(err) }
  }
}

// ---- payment confirmation (PDF) --------------------------------------------

// Rebuild a ReceiptInput from the stored payment rows for one receipt number.
async function buildReceiptFromReceiptNo(
  db: SupabaseClient, school: SchoolRow, student: StudentRow, receiptNo: string,
): Promise<ReceiptInput | null> {
  const { data: rowsRaw } = await db
    .from('fee_payments')
    .select('amount_paid, payment_method, paid_date, created_at, fee_dues!inner(label, month, due_date, source, discount_amount, late_fee_amount)')
    .eq('school_id', school.id)
    .eq('student_id', student.id)
    .eq('receipt_number', receiptNo)

  const rows = (rowsRaw as any[]) || []
  if (!rows.length) return null

  const now = new Date()
  const curYm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`

  const lines: ReceiptLineInput[] = rows.map((r) => {
    const d = Array.isArray(r.fee_dues) ? r.fee_dues[0] : r.fee_dues
    const isExtra = d?.source === 'manual'
    const isArrear = !isExtra && typeof d?.month === 'string' && d.month < curYm
    return {
      label: d?.label ?? 'Fee',
      amount: Number(r.amount_paid),
      is_arrear: isArrear,
      is_extra: isExtra,
      discount_amount: d?.discount_amount ?? null,
      late_fee_amount: d?.late_fee_amount ?? null,
    }
  })

  const amountPaid = rows.reduce((s, r) => s + Number(r.amount_paid), 0)
  const method = rows[0].payment_method as string
  const generatedAt = (rows[0].created_at as string) || new Date().toISOString()

  // Live outstanding across the student's unpaid/partial dues.
  const { data: balRows } = await db
    .from('fee_dues').select('balance').eq('student_id', student.id).eq('school_id', school.id)
    .in('status', ['unpaid', 'partial'])
  const grandBalance = (balRows || []).reduce((s, b: any) => s + Number(b.balance), 0)

  return {
    school: { name: school.name, phone: school.phone },
    student: {
      full_name: student.full_name, student_uid: student.student_uid,
      father_name: student.father_name, address: student.address,
    },
    lines, amountPaid, method, grandBalance, generatedAt, receiptNumber: receiptNo,
  }
}

async function processConfirmation(
  db: SupabaseClient, row: OutboxRow, school: SchoolRow, student: StudentRow,
): Promise<Outcome> {
  if (!school.wa_payment_confirmation_enabled) return { kind: 'skipped', reason: 'feature_off' }
  if (student.parent_phone_opted_out) return { kind: 'skipped', reason: 'opted_out' }
  if (!student.parent_phone?.trim()) return { kind: 'skipped', reason: 'no_phone' }
  if (!row.ref_text) return { kind: 'skipped', reason: 'missing_receipt' }

  const receiptNo = row.ref_text
  const messageType = 'fee_payment_confirmation'
  const templateName = 'fee_payment_confirmation'
  const logDate = utcDate()

  if (await alreadySent(db, row.school_id, messageType, null, receiptNo, logDate)) {
    return { kind: 'sent' }
  }

  // (Confirmations bypass the quota - a parent who paid must get their receipt.)

  try {
    const receipt = await buildReceiptFromReceiptNo(db, school, student, receiptNo)
    if (!receipt) return { kind: 'skipped', reason: 'receipt_not_found' }

    // 1) Render the single-page PDF.
    const pdf = await renderReceiptPdfBuffer(receipt)

    // 2) Upload to the private bucket (overwrite on re-send).
    const path = `${school.id}/${receiptNo}.pdf`
    const up = await db.storage.from(BUCKET).upload(path, pdf, {
      contentType: 'application/pdf', upsert: true,
    })
    if (up.error) throw new Error(`Storage upload: ${up.error.message}`)

    // 3) Sign it for 30 days.
    const signed = await db.storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_TTL)
    if (signed.error || !signed.data?.signedUrl) {
      throw new Error(`Sign URL: ${signed.error?.message ?? 'unknown'}`)
    }

    // 4) Send the document template.
    const metaId = await sendTemplate(recipientPhone(student.parent_phone), templateName, [
      {
        type: 'header',
        parameters: [{
          type: 'document',
          document: { link: signed.data.signedUrl, filename: `Fee Receipt ${receiptNo}.pdf` },
        }],
      },
      {
        type: 'body',
        parameters: [
          { type: 'text', text: student.full_name },
          { type: 'text', text: fmtAmount(receipt.amountPaid) },
          { type: 'text', text: receiptNo },
        ],
      },
    ])

    await writeLog(db, {
      school_id: row.school_id, student_id: row.student_id, parent_phone: student.parent_phone,
      message_type: messageType, template_name: templateName, log_date: logDate,
      ref_id: null, ref_text: receiptNo, status: 'sent', meta_message_id: metaId,
    })
    return { kind: 'sent' }
  } catch (err) {
    await writeLog(db, {
      school_id: row.school_id, student_id: row.student_id, parent_phone: student.parent_phone,
      message_type: messageType, template_name: templateName, log_date: logDate,
      ref_id: null, ref_text: receiptNo, status: 'failed', error_message: String(err),
    })
    return { kind: 'failed', error: String(err) }
  }
}

// ---- outbox row settle ------------------------------------------------------

async function settle(db: SupabaseClient, row: OutboxRow, outcome: Outcome) {
  if (outcome.kind === 'sent') {
    await db.from('wa_outbox').update({ status: 'sent', sent_at: new Date().toISOString(), last_error: null }).eq('id', row.id)
    return
  }
  if (outcome.kind === 'skipped') {
    await db.from('wa_outbox').update({ status: 'skipped', last_error: outcome.reason }).eq('id', row.id)
    return
  }
  // failed -> retry with exponential backoff, or give up after max_attempts
  const nextAttempt = row.attempt_count + 1
  if (nextAttempt >= row.max_attempts) {
    await db.from('wa_outbox').update({ status: 'failed', attempt_count: nextAttempt, last_error: outcome.error }).eq('id', row.id)
  } else {
    const backoffMin = Math.min(2 ** nextAttempt, 60) // 2,4,8,16,32,60 min
    const next = new Date(Date.now() + backoffMin * 60_000).toISOString()
    await db.from('wa_outbox').update({ status: 'pending', attempt_count: nextAttempt, next_attempt_at: next, last_error: outcome.error }).eq('id', row.id)
  }
}

// ---- route ------------------------------------------------------------------

export async function POST(req: Request) {
  // Auth: shared secret from pg_cron / the manual-send route.
  if (req.headers.get('x-cron-secret') !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const db = admin()

  // Optional targeted drain: { outbox_ids?: string[], limit?: number }
  let body: { outbox_ids?: string[]; limit?: number } = {}
  try { body = await req.json() } catch { /* empty body is fine */ }
  const limit = Math.min(Math.max(body.limit ?? 10, 1), 50)

  // Claim a batch (concurrency-safe). Targeted ids still go through the claim so
  // they are marked 'processing' and locked.
  let rows: OutboxRow[] = []
  const claimed = await db.rpc('claim_wa_outbox', { p_limit: limit })
  if (claimed.error) {
    return NextResponse.json({ error: `claim failed: ${claimed.error.message}` }, { status: 500 })
  }
  rows = (claimed.data as OutboxRow[]) || []
  if (body.outbox_ids?.length) {
    const set = new Set(body.outbox_ids)
    rows = rows.filter((r) => set.has(r.id))
  }

  // Cache schools + students across the batch to cut round-trips.
  const schoolCache = new Map<string, SchoolRow | null>()
  const studentCache = new Map<string, StudentRow | null>()

  async function getSchool(id: string): Promise<SchoolRow | null> {
    if (schoolCache.has(id)) return schoolCache.get(id)!
    const { data } = await db.from('schools')
      .select('id, name, phone, wa_fee_reminders_enabled, wa_payment_confirmation_enabled, wa_monthly_quota, wa_messages_sent_month, wa_quota_reset_date')
      .eq('id', id).single()
    const row = (data as SchoolRow) ?? null
    schoolCache.set(id, row)
    return row
  }
  async function getStudent(id: string): Promise<StudentRow | null> {
    if (studentCache.has(id)) return studentCache.get(id)!
    const { data } = await db.from('students')
      .select('id, full_name, student_uid, father_name, address, parent_phone, parent_phone_opted_out')
      .eq('id', id).single()
    const row = (data as StudentRow) ?? null
    studentCache.set(id, row)
    return row
  }

  const summary = { processed: 0, sent: 0, skipped: 0, failed: 0 }

  for (const row of rows) {
    summary.processed++
    try {
      const school = await getSchool(row.school_id)
      const student = await getStudent(row.student_id)
      if (!school) { await settle(db, row, { kind: 'skipped', reason: 'school_missing' }); summary.skipped++; continue }
      if (!student) { await settle(db, row, { kind: 'skipped', reason: 'student_missing' }); summary.skipped++; continue }

      const outcome = row.kind === 'fee_payment_confirmation'
        ? await processConfirmation(db, row, school, student)
        : await processReminder(db, row, school, student)

      await settle(db, row, outcome)
      if (outcome.kind === 'sent') summary.sent++
      else if (outcome.kind === 'skipped') summary.skipped++
      else summary.failed++
    } catch (err) {
      // Unexpected error - let the row retry via backoff.
      await settle(db, row, { kind: 'failed', error: `unhandled: ${String(err)}` })
      summary.failed++
    }
  }

  return NextResponse.json({ ok: true, ...summary })
}
