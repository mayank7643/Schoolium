# Schoolium Alerts — Development Blueprint

**Version 1.0 · BYOG (Bring Your Own Gateway) attendance & announcement layer**

---

## 0. What this is, and what it is not

**It is:** a QR gate-attendance capture system plus a message orchestration engine that sends alerts through *the school's own* WhatsApp Business Account, DLT-registered SMS header, and email — using credentials the school owns and bills the school directly.

**It is not:** an ERP. It does not store marks, fees, timetables, payroll, or admissions. It does not integrate with the school's ERP. It needs one CSV.

Write these two paragraphs on a wall. Every feature request for the next twelve months gets checked against them. The reason you failed the first time is that you built the first paragraph *inside* a product that was mostly the second.

**The one-sentence pitch:** *"Parents get a WhatsApp from your school's name the moment their child enters the gate — and you pay Meta directly, at cost."*

---

## 1. Tech stack

Keep almost everything. You are not rewriting; you are stripping.

| Layer | Choice | Rationale |
|---|---|---|
| Framework | Next.js 14 App Router, TypeScript strict | Already yours. No reason to move. |
| DB | Supabase Postgres, RLS on every table | Already yours. RLS discipline from chat19 transfers wholesale. |
| Auth | Supabase Auth + `@supabase/ssr` | Unchanged. Roles collapse to 4 (see §3). |
| Styling | Tailwind + your existing tokens | Unchanged. Don't add shadcn now. |
| Scanner | `html5-qrcode` + offline IndexedDB queue | Already built and battle-tested. |
| QR gen | `qrcode` v1.5.4 | Unchanged. |
| Worker | **Next.js API route, Node runtime, on Vercel** | You need the vault key in the process. Keep it where you already have Node. |
| Scheduler | `pg_cron` + `pg_net` → worker route with bearer secret | Already your pattern. |
| Crypto | Node `crypto` AES-256-GCM, key in env | See §5. Do not put the key in Postgres. |
| Errors | Sentry | Non-negotiable for a system that spends other people's money. |

### On Supabase Edge Functions

You mentioned invoking them per message. Don't. Two reasons:

1. **Your invocation math was wrong and it doesn't matter.** Verify Supabase's included invocation quota on their pricing page — I believe Pro includes 2 million, not 20 million. But if you batch correctly, a 2,000-student school generates ~1,760 invocations/month, not 88,000. Batching makes this line item disappear from your P&L entirely.
2. **Edge Functions are Deno.** Your vault crypto, your adapters, and your existing worker are Node. One runtime is better than two.

Use Edge Functions only if you later need something that must be geographically close to the DB.

### What to delete or freeze

Move these out of the v1 build, into a `legacy/` branch you don't deploy:

- Fee collection, receipts, reversals, EOD reconciliation
- Staff HR, leave, documents, ID cards, payroll schema
- Class attendance / teacher roll call
- Exam placeholders
- Principal and teacher dashboards

Keep: schools, students, classes, gate `attendance`, QR cards, scan page, `wa_outbox` worker skeleton, RLS patterns, `types/index.ts` discipline, local PG16 validation harness.

This is the hardest part of the project. It is also the whole project.

---

## 2. System shape

```
Gate scan ┐
Cutoff cron ├──► events ──► rules ──► render ──► GUARDS ──► message_outbox
Composer  ┘                                                       │
                                                                  ▼
                                          worker (batch, SKIP LOCKED)
                                                    │        ▲
                                          credential vault    │
                                                    │         │
                                                    ▼         │
                                         school's gateway ─► webhooks ─► delivery ledger
```

Three invariants:

1. **Nothing sends a message directly.** Capture code emits events. Only the worker sends.
2. **The guards run before the outbox insert, in the same transaction.** Not after.
3. **The worker never holds business logic.** It reads a row, decrypts a credential, calls an adapter, writes a status.

---

## 3. Data model

Roles collapse from nine to four: `super_admin` (you), `school_admin`, `operator` (front desk, sends notices), `guard` (scan only).

### Directory (imported, never authoritative)

```sql
create table students (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools(id),
  external_ref text not null,          -- their ERP's student ID
  full_name text not null,
  class_label text,                    -- free text: "5-A". Do NOT model classes.
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (school_id, external_ref)
);

create table guardians (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools(id),
  full_name text,
  created_at timestamptz not null default now()
);

create table student_guardians (
  student_id uuid not null references students(id) on delete cascade,
  guardian_id uuid not null references guardians(id) on delete cascade,
  relation text,
  is_primary boolean not null default false,
  primary key (student_id, guardian_id)
);

create table contact_methods (
  id uuid primary key default gen_random_uuid(),
  guardian_id uuid not null references guardians(id) on delete cascade,
  channel text not null check (channel in ('sms','whatsapp','email')),
  value text not null,                 -- E.164 for phone: +919876543210
  opted_out boolean not null default false,
  unique (guardian_id, channel, value)
);
```

**`class_label` as free text is deliberate.** The moment you model classes properly you have sections, streams, promotions, and a mini-ERP. You need a string to filter announcements. That's all.

### Events (append-only)

```sql
create table events (
  id bigserial primary key,
  school_id uuid not null,
  type text not null,                  -- student.checked_in | student.checked_out
                                       -- student.absent_at_cutoff | notice.published
  subject_id uuid,                     -- student_id, or null for notices
  occurred_at timestamptz not null,    -- ORIGINAL scan time, never sync time
  payload jsonb not null default '{}',
  dedup_key text,
  created_at timestamptz not null default now(),
  unique (school_id, dedup_key)
);
```

`dedup_key` for a check-in is `checkin:{student_id}:{yyyy-mm-dd}`. An offline device that syncs the same scan twice inserts once. This is your first line of defence and it costs one index.

### Templates — two layers, never conflated

```sql
create table message_templates (        -- human-facing
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null,
  key text not null,                    -- 'checkin' | 'checkout' | 'absent' | 'notice'
  body text not null,                   -- "{{child}} entered {{school}} at {{time}}."
  unique (school_id, key)
);

create table channel_templates (        -- the APPROVED artifact
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null,
  message_template_id uuid not null references message_templates(id),
  channel text not null check (channel in ('sms','whatsapp','email')),
  category text not null check (category in ('utility','marketing','service','transactional')),
  provider_template_id text,            -- DLT template ID  /  Meta template name
  header text,                          -- DLT sender header, 6 chars
  language text default 'en',
  var_map jsonb not null,               -- {"1":"child","2":"school","3":"time"}
  approval_status text not null default 'draft'
    check (approval_status in ('draft','submitted','approved','rejected','paused')),
  approved_at timestamptz,
  unique (school_id, message_template_id, channel)
);
```

**`var_map` is the product.** DLT and Meta both use positional variables. The approved text must match character-for-character. Mapping `{{1}} → child.first_name` is the glue nobody else builds well, and it's why a school can't just do this themselves.

**`category` is where the money is.** A utility WhatsApp template costs roughly ₹0.115 in India; a marketing one runs about ₹0.86 — 7.5×. Same button in your UI. Enforce category at template creation, not at send time. "Your child arrived at 8:02" is utility. "Your child arrived — admissions for 2027 are open!" is marketing, and now every gate scan costs 7.5×. *(Verify current Meta rates before quoting; they change quarterly and India moved to INR billing in January 2026.)*

### Outbox

```sql
create table message_outbox (
  id bigserial primary key,
  school_id uuid not null,
  event_id bigint references events(id),
  channel_template_id uuid not null references channel_templates(id),
  channel text not null,
  recipient text not null,              -- E.164 or email
  vars jsonb not null,
  status text not null default 'queued'
    check (status in ('queued','sending','sent','delivered','read','failed','dead')),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  provider_message_id text,
  error_code text,
  error_message text,
  cost_estimate_paise int not null default 0,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  unique (school_id, idempotency_key)
);

create index on message_outbox (status, next_attempt_at)
  where status in ('queued','failed');
```

`idempotency_key = sha256(event_id || recipient || channel_template_id)`.

That unique constraint is two lines of SQL. One day it will save you ₹40,000 of a customer's money when a worker crashes mid-batch and retries. There is no version of this system without it.

### Rate card and spend guard

```sql
create table rate_card (
  channel text not null,
  category text not null,
  paise int not null,                   -- e.g. whatsapp/utility = 12 (11.5 + rounding)
  gst_pct numeric not null default 18,
  effective_from date not null,
  primary key (channel, category, effective_from)
);

create table spend_guard (
  school_id uuid primary key,
  daily_cap_paise int not null default 500000,   -- ₹5,000/day default
  spent_today_paise int not null default 0,
  spent_date date not null default current_date
);
```

Checked in the **same transaction** as the outbox insert. If the cap would be exceeded, the insert fails and a `spend_cap_hit` row lands in a notifications table. The school gets an email. Nothing sends.

Default it low. A school that legitimately needs more will call you. A bug that needs more will not.

---

## 4. Guards (run before insert, in one transaction)

Order matters:

1. **Consent / opt-out.** `contact_methods.opted_out` → skip. Handle inbound `STOP` for SMS and Meta's opt-out signal for WhatsApp.
2. **Guardian dedupe.** For a check-in, one message per child is correct. For a *notice*, a guardian with three children gets **one** message. Dedupe key on notices is `(guardian_id, notice_id)`, not `(student_id, notice_id)`.
3. **Quiet hours.** No sends 21:00–06:30 IST. Queue for morning.
4. **Rate limit.** Token bucket per `(school_id, channel)`. Protects the school's Meta quality rating.
5. **Spend cap.** Last, because it's the one that fails loudly.

---

## 5. The credential vault

This table is the single most dangerous object in your system. It holds bearer credentials that spend other people's money.

```sql
create table school_channels (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools(id),
  channel text not null,
  provider text not null,               -- 'meta_cloud' | 'msg91' | 'gupshup' | 'generic_http' | 'smtp'
  config jsonb not null default '{}',   -- NON-secret: waba_id, phone_number_id, base_url
  secret_ciphertext bytea not null,     -- AES-256-GCM
  secret_iv bytea not null,
  secret_tag bytea not null,
  secret_fingerprint text not null,     -- sha256 of plaintext, for change detection
  health text not null default 'unverified'
    check (health in ('unverified','ok','auth_failed','low_balance','suspended')),
  last_verified_at timestamptz,
  balance_hint_paise int,
  unique (school_id, channel, provider)
);

revoke all on school_channels from anon, authenticated;
-- service_role only. Never reachable through PostgREST.
```

Rules, all of them absolute:

- The encryption key lives in the worker's environment variable. **Never in Postgres.** A database dump alone must be useless.
- Plaintext never leaves the server, never appears in a response body, never enters a log line, never appears in a Sentry breadcrumb. Add a Sentry `beforeSend` scrubber.
- The UI shows `secret_fingerprint` last-6 and `health`. Nothing else.
- Every send writes `sent_by_user_id` or `sent_by_automation_id`. The school must be able to audit who spent their money.
- Rotate on demand: a "replace credential" flow that re-encrypts and re-verifies before switching over.

**If you are ever doing done-for-you DLT registration:** you'll handle their PAN, GST certificate, incorporation proof, and authorised-signatory ID. Get a signed authorisation letter. **Delete the KYC documents once registration completes.** Do not let them sit in a bucket. Under DPDP that holding is what turns a good business into a liability.

---

## 6. Provider adapters

One interface. Four implementations. Build them in this order.

```ts
export interface Adapter {
  readonly id: 'meta_cloud' | 'msg91' | 'generic_http' | 'smtp' | 'fake';

  verify(cred: Credential, config: Json): Promise<HealthResult>;

  send(args: {
    cred: Credential;
    config: Json;
    tpl: ChannelTemplate;
    recipient: string;
    vars: Record<string, string>;
  }): Promise<{ providerMessageId: string }>;

  parseWebhook(
    raw: unknown,
    signature: string,
    cred: Credential
  ): DeliveryEvent[];
}
```

**Build order:**

1. `fake` — writes to a table. Your entire test suite runs against this. Build it first.
2. Your recommended SMS provider (MSG91 or Gupshup). Pick **one**, learn it deeply.
3. `generic_http` — school configures URL, method, headers, and a JSON body template. This is what lets a self-serve school arrive with a gateway you've never heard of, without a code change. Given you're offering a self-serve tier, this is not optional and it is not v2.
4. `meta_cloud` — WhatsApp. Last, because business verification takes calendar time you don't control.
5. `smtp` / SES — trivial, whenever.

**Never write an adapter that retries internally.** Retries belong to the worker.

---

## 7. The worker

```
pg_cron every minute
  → pg_net POST /api/worker  (Authorization: Bearer WORKER_SECRET)
    → loop for up to 50 seconds:
        SELECT ... FROM message_outbox
          WHERE status IN ('queued','failed') AND next_attempt_at <= now()
          ORDER BY next_attempt_at
          LIMIT 100
          FOR UPDATE SKIP LOCKED
        → group by (school_id, channel), decrypt credential once per group
        → send with concurrency 5
        → write status
        → if queue still deep, self-chain one more invocation
```

`FOR UPDATE SKIP LOCKED` is the entire concurrency story. Two workers can run simultaneously and neither will double-send.

**Backoff:** `next_attempt_at = now() + (2^attempts * 30s) * jitter(0.8..1.2)`. After 6 attempts → `dead`. Never retry a 4xx that means "template rejected" or "auth failed" — those are permanent; mark `dead` immediately and flip `school_channels.health`.

### The morning burst

2,000 students arriving across 25 minutes is ~80 messages/minute at peak. A message delivered at 08:35 for an 08:02 arrival is worse than useless — the parent has already worried.

`pg_cron` has one-minute granularity, so: **one invocation per minute that loops internally for ~50 seconds**, polling every 5 seconds. That gives you effective sub-10-second latency during the burst with a single cron entry. Outside 07:00–10:00 IST, exit after one batch.

Do not solve this with per-message invocations.

---

## 8. Capture

### Gate scan

Your existing offline flow is correct. One rule, in bold:

**A scan that queues offline at 08:02 and syncs at 09:47 must emit its event with `occurred_at = 08:02`.** Parents will notice. The message body renders from `occurred_at`, never from `now()`.

The message itself is still sent at 09:47, and that's fine — it should say "entered at 8:02 AM." Consider suppressing check-in messages that are more than 30 minutes stale and sending a batched digest instead. Make it a school setting.

### Absent-at-cutoff

This is the highest-value message in the entire product. Presence alerts are pleasant. **Absence alerts are what a principal will pay for**, because they get a parent informed before that parent calls the office in a panic.

```
pg_cron at */5 during 08:30-10:30 IST
  → for each school where school_local_time() >= schools.absent_cutoff_time
    and not exists (absent_run for today)
  → students active, no student.checked_in event today
  → emit student.absent_at_cutoff, one per student
  → record absent_run
```

Idempotent by `absent_run`. Run it once per school per day, never twice.

### Announcement composer

Schools **cannot free-type messages.** They pick an approved `channel_template` and fill variables. This will be your most common support ticket; the answer is that TRAI and Meta don't permit arbitrary content, and that constraint is precisely why they need you.

Confirm screen must show, before the send button is live:
- Recipient count
- Template preview with resolved variables
- **Estimated cost** from `rate_card`, including GST
- Channel and category badge

Give every school **six pre-written templates engineered to pass approval on the first submission**. Get them approved once against your own test entity. Hand schools the exact strings. This costs you one afternoon and saves every customer two weeks. Note: DLT operators reject templates that are almost entirely variables, so each needs enough fixed text to read as a real message.

---

## 9. CSV import

```
upload → parse (Papa) → stage in import_rows
  → normalise phones to E.164 (+91 default, strip spaces/dashes/leading 0)
  → validate: name present, at least one contact
  → DIFF PREVIEW: "32 new · 4 removed · 7 phone numbers changed"
  → user confirms → upsert on (school_id, external_ref)
  → removed students: is_active = false. NEVER hard delete.
```

The diff preview is not a nicety. Without it, a school re-uploads a CSV with a changed ID column and you silently duplicate 2,000 students and message every parent twice.

Sample CSV, exactly four required columns:

```csv
student_id,student_name,class,guardian_phone
S1042,Aayush Ray,5-A,+919876543210
```

Optional: `guardian_name`, `guardian_email`, `guardian2_phone`.

---

## 10. Onboarding: the only flow that matters

A school is not onboarded when they sign. **A school is onboarded when the principal's own phone buzzes with a message from his own school's name.** Design everything backwards from that moment.

```
1. Create school, invite school_admin
2. Choose tier:  self-serve  |  done-for-you (₹7,500)
3. Channel setup wizard, per channel:
     - paste credentials
     - [Verify connection]  → adapter.verify() → health = ok
     - templates: submit to DLT / Meta, poll approval_status
4. [Send test message to my phone]   ← THE MOMENT
5. Upload CSV → diff preview → confirm
6. Print QR cards
7. Toggle: check-in only  |  check-in + check-out
8. Go live
```

**Qualify on call one, not after you've built their dashboard:** many Indian private schools are registered as trusts or societies with no GST registration, and Meta business verification wants incorporation documents. Some will not pass, or will take six weeks. Have an **SMS-only tier** ready and ask the question early.

The check-in-only toggle halves their messaging bill and puts the cost lever in their hands. It will close deals.

---

## 11. Delivery ledger and the support surface

Webhooks: `POST /api/webhooks/:provider/:school_id`, signature-verified per provider (Meta uses `X-Hub-Signature-256` against the app secret; for others, embed an HMAC token in the URL).

They update `message_outbox.status` → `delivered` / `read` / `failed`.

**"Delivered to 412 parents. Read by 388."** — that screen is your entire sales demo. WhatsApp read rates run roughly 85–95% against 15–25% for SMS. No incumbent ERP shows a principal that number. Build the screen before you build anything cosmetic.

### The support problem you have now inherited

When messages stop at 08:05, it is *their* credential, *their* balance, *their* template — and *your* phone that rings.

- Check balance on every worker run where the provider exposes it. Store `balance_hint_paise`.
- Red banner in the dashboard below a threshold. Email at 20% remaining.
- When a send fails, **surface the gateway's own error string verbatim**: *"Meta rejected this: account has insufficient funds."* Now the conversation is between the school and Meta, and you are holding the flashlight rather than the bag.
- Internal ops console (`super_admin`): every school's `health`, queue depth, dead-letter count, last successful send. One screen. You will live in it.

### Monthly reconciliation export

The school pays Meta directly, so when the invoice lands they will ask you why. Give them a CSV: date, recipient (masked), template, channel, category, status, cost estimate, triggered-by. They must be able to reconcile your dashboard against their Meta invoice in five minutes.

**This export is what makes a principal comfortable handing you the keys to his messaging account.** It is a feature, not a report.

---

## 12. Security & compliance checklist

- [ ] `school_channels` revoked from `anon` and `authenticated`. Service role only.
- [ ] Vault key in worker env, not Postgres. DB dump alone is useless.
- [ ] Sentry `beforeSend` scrubs anything matching credential fingerprints.
- [ ] `unique(school_id, idempotency_key)` on `message_outbox`.
- [ ] `spend_guard` checked inside the insert transaction.
- [ ] Rate limiter per `(school_id, channel)`.
- [ ] Every send attributed to a user or automation.
- [ ] RLS on every tenant table, scoped by `school_id`. Reuse your chat19 patterns.
- [ ] All URLs in SMS templates are full URLs, pre-whitelisted on DLT. Shorteners are silently dropped in scrubbing.
- [ ] **Data Processing Agreement signed with every school.** The school is the Data Fiduciary; you are the Processor. This is the structural gift of BYOG — the school owns the sender identity, the consent record, and the telco relationship. Say it in the sales meeting.
- [ ] Retention policy: message bodies purged after 12 months; `events` after 24.
- [ ] Never train anything on this data. Never use it for anything but sending.
- [ ] Stay on QR. Facial recognition for attendance sharply raises DPDP exposure for children's data.
- [ ] KYC documents deleted after registration completes.

DPDP substantive obligations become enforceable **13 May 2027**. Educational institutions have a carve-out from verifiable parental consent for processing in the interest of child safety — but *you are not the school*. Your protection is the processor relationship. Get the DPA signed.

---

## 13. Six-week build order

**Week 1 — Directory.** Guardians, contacts, students with `external_ref`, CSV import with diff preview, phone normalisation. Nothing sends yet. Every downstream bug is born here.

**Week 2 — Spine.** `events` table. Gate scan emits `student.checked_in`. `message_outbox` with idempotency. `spend_guard`. `fake` adapter. Full test suite green on the fake adapter.

**Week 3 — Worker + one real channel.** pg_cron → worker route, `SKIP LOCKED`, backoff, dead-lettering. Vault. One SMS adapter. Delivery webhooks. Test message flow.

**Week 4 — The two features that sell.** `absent_at_cutoff` cron. Delivery ledger screen with read receipts. Reconciliation CSV export.

**Week 5 — Announcements.** `channel_templates` with approval state. Composer with recipient count and cost estimate. Quiet hours. Guardian dedupe for notices. Six pre-approved template strings.

**Week 6 — Onboarding + Meta.** Channel setup wizard. Connection health. Send-test-message. `meta_cloud` adapter. Ops console.

Then stop. Ship to one school. Do not build the parent app, the generic HTTP adapter, or anything else until a real principal has used this for a month.

---

## 14. Standing rules

Carry these forward from Chat 17 — they were hard-won and they still apply:

- Every migration validated on local PG16 with Supabase stubs, with functional and exploit tests, **before** delivery.
- Every module passes `tsc --noEmit` and a full `next build` against the real repo, with a baseline build first.
- SECURITY DEFINER functions: set `search_path`, verify `auth.uid()` role and school, `REVOKE ALL FROM PUBLIC` then `GRANT EXECUTE`.
- plpgsql: `RETURNS TABLE` OUT params shadow column names. Alias every table, qualify every column.
- SQL is pure ASCII. `CREATE OR REPLACE` for same-signature functions. `NOTIFY pgrst, 'reload schema'` after.
- Unused imports fail the Vercel build. No `[...new Set()]` — use `Array.from`.
- Every new DB column goes into `types/index.ts`.
- Service-role key is server-only. Never `NEXT_PUBLIC_`.
- Scope every query by `school_id`.

New rules for this system:

- **Nothing sends a message except the worker.**
- **Guards run before the outbox insert, in the same transaction.**
- **`occurred_at` is the scan time, never the sync time.**
- **Template category is set at creation, enforced at send.**
- **Credential plaintext never leaves the worker process.**

---

## 15. The kill criterion

Write this down before you write more code.

Give one school a free term. Do their DLT and Meta registration yourself, at your cost. In exchange you want two things: their honest usage after eight weeks, and permission to show the delivery dashboard to the next principal.

**If parents are reading the messages and the principal renews at your quoted annual number, you have a company.**

**If he quietly stops using it by week four, you have your answer** — and you've lost one term, not one year.

Founders rarely fail because the idea was wrong. They fail because they never wrote down what "wrong" would look like, so they kept building.
