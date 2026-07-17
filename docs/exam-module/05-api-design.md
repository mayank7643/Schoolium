# Exam Module — Step 5: API Design

Companion to Steps 1–4. Defines the complete server surface: which operations are direct
`supabase.rpc()` / table reads from client components (the house default), which need
Next.js route handlers, the public anonymous surface, and every contract's shape.

---

## 5.1 The three tiers (rule for placing any operation)

| Tier | When | Auth | Examples here |
|---|---|---|---|
| **T1 — direct supabase-js** (client component) | Everything the caller's own session can do under RLS/RPC guards. Default tier. | Session JWT; role + school enforced in DB | All CRUD reads, all lifecycle RPCs (`publish_exam`, `submit_marks`, …), autosave |
| **T2 — Next.js route handler** (`app/api/…`) | Server-only capability needed: PDF streaming, service-role key, secrets, external APIs | Session cookie verified first (staff/create pattern); then caller-session RPC — **never service-role unless unavoidable** | Admit-card PDF, report-card PDF, analytics PDFs, AI analysis trigger |
| **T3 — background** (pg_cron in DB, Supabase edge functions) | No user in the loop | `service_role` / SQL | Scheduled result publishing, exam status auto-flip, WA outbox worker (existing), AI batch |

Design consequence: **the exam module adds only 4 route handlers.** Everything else is
T1 against the 31 RPCs from Step 4 §4.11 — matching how fees/staff modules work today.

## 5.2 T1 contracts — the RPCs clients call directly

Signatures follow house style: `p_`-prefixed params, `jsonb` for bulk payloads,
`RETURNS TABLE` for lists, `RETURNS jsonb` for composite results, exceptions with
human-readable messages (`Access denied: …`) the UI surfaces verbatim.

Only non-obvious contracts are specified here; simple CRUD RPCs take scalar params
mirroring their table columns.

### `save_marks_bulk(p_exam_subject_id uuid, p_rows jsonb) → jsonb`

```jsonc
// p_rows
[ { "student_id": "…", "theory": 78.5, "practical": 18, "internal": 9,
    "grace": 0, "is_absent": false, "is_exempted": false } ]
// returns
{ "saved": 42, "rejected": [ { "student_id": "…", "reason": "theory 105 exceeds max 100" } ] }
```
Partial success allowed (autosave must never lose the valid rows); rejected rows carry
row-level reasons. Guard: caller `teaches_subject_in_class`, submission status
`pending|rejected`, exam `ongoing|completed`, session unlocked.

### `submit_marks / verify_marks / approve_marks / freeze_marks (p_exam_subject_id uuid) → jsonb`
Returns the new submission row `{ status, submitted_at, … }`.
`reject_marks(p_exam_subject_id, p_reason text)` — reason mandatory (≥ 10 chars).
`reopen_marks(p_exam_subject_id, p_reason text)` — PR/SA, invalidates results.
`submit_marks` failure modes (exception messages): incomplete entries (lists count),
attendance mismatch (absent-in-room but has marks), wrong state.

### `validate_exam_timetable(p_exam_id uuid) → TABLE`
`(severity text, code text, exam_subject_id uuid, class_label text, subject_name text, message text)` — codes per Step 4 §4.3. Empty result = publishable.

### `auto_generate_timetable(p_exam_id uuid, p_start date, p_end date, p_gap_days int DEFAULT 0, p_default_start time, p_default_duration_min int) → jsonb`
`{ "scheduled": 24, "unscheduled": 2, "issues": [...] }` — leaves existing manual dates
untouched unless `p_overwrite := true`.

### `publish_exam(p_exam_id uuid) → jsonb`
`{ "status": "published", "enrolled": 312, "notifications_enqueued": 298 }`
Runs validator; raises with the full issue list on any `error` severity.

### `generate_exam_enrollments(p_exam_id uuid) → jsonb`
`{ "enrolled": 12, "skipped": 300 }` — idempotent, appends late admissions.

### `generate_admit_cards(p_exam_id uuid, p_class_id uuid DEFAULT NULL, p_template_id uuid DEFAULT NULL) → jsonb`
`{ "generated": 312, "already_existed": 0 }`.

### `record_exam_attendance_scan(p_qr_token uuid, p_exam_subject_id uuid) → jsonb`
```jsonc
{ "student": { "full_name": "…", "photo_url": "…", "roll_number": 14, "seat_number": "B-07" },
  "status_set": "present",        // or "late"
  "already_marked": false,
  "warnings": [] }                 // e.g. "admit card revoked", "student exempted from this paper"
```

### `mark_exam_attendance_bulk(p_exam_subject_id uuid, p_rows jsonb) → jsonb`
`p_rows: [{ student_id, status, remarks? }]` → `{ "saved": 40 }`.

### `compute_exam_results(p_exam_id uuid) → jsonb`
`{ "computed": 312, "withheld": 2, "absent": 5, "class_summaries": [ { class_id, average_pct, pass_pct } ] }`
Raises listing unfrozen papers if any.

### `get_question_paper_url(p_question_paper_id uuid, p_version_id uuid DEFAULT NULL) → text`
Signed URL (60 s). Access-log row inserted before the URL is returned.

### Reporting reads (Phase 9, all `RETURNS TABLE`, permission-scoped)
`get_exam_attendance_report(p_exam_id)`, `get_class_result_summary(p_exam_id)`,
`get_topper_list(p_exam_id, p_class_id?, p_limit)`, `get_grade_distribution(p_exam_id, p_class_id?)`,
`get_subject_performance(p_exam_id, p_class_id?)`, `get_teacher_performance(p_session_id)`,
`get_student_progress(p_student_id, p_session_id)` (exam-over-exam trend, feeds charts + AI).

## 5.3 T2 — the four route handlers

All: `runtime='nodejs'`, `dynamic='force-dynamic'`, session verified via
`utils/supabase/server`, errors as `{ error: string }` with 400/401/403/404, PDF success
as `application/pdf` stream with `Content-Disposition: attachment`.

### `POST /api/exams/admit-cards-pdf`
```jsonc
// body
{ "exam_id": "…", "class_id": "…"?, "student_ids": ["…"]?,   // omit both = whole exam
  "layout": "single" | "2up" | "3up" | "4up" }               // default from template
```
Caller session → RLS-guarded reads (enrollments + admit_cards + timetable + school
branding) → `app/lib/admitCardPdf.tsx` renders N-up A4. `maxDuration = 60`; requests
capped at 500 cards — larger sets are paged by class from the UI (bulk-print flow
iterates classes).

### `POST /api/exams/report-cards-pdf`
```jsonc
{ "exam_id": "…", "student_id": "…"? , "class_id": "…"? }    // single or class batch
```
Renders **from the `report_cards.snapshot` JSONB** (never recomputes — the PDF must
match the issued document forever). Embeds QR of `qr_token`. Teachers: allowed only for
their classes (RLS does the filtering; empty result → 404).

### `POST /api/exams/report-pdf`
```jsonc
{ "report": "class_result" | "subject_performance" | "topper_list" | "fail_list"
            | "grade_distribution" | "exam_attendance",
  "exam_id": "…", "class_id": "…"?, "subject_id": "…"? }
```
Thin wrapper: calls the matching Phase-9 RPC, renders table-style PDF
(`app/lib/examReportPdf.tsx`), mirrors `staff-report-pdf` route structure.

### `POST /api/exams/ai-analysis`
```jsonc
{ "exam_id": "…", "student_id": "…" }        // or { "exam_id", "class_id" } for batch
// 202 → { "queued": 38 }   (rows created status='pending')
```
Verifies caller (PR/SA/CT-of-class), inserts `pending` rows, invokes the
`generate-report-analysis` edge function (fire-and-forget; function holds the provider
key in Supabase secrets). UI polls `ai_report_analyses.status`. Provider choice is
isolated inside the edge function — swapping providers touches one file.

## 5.4 Public (anonymous) surface

Follows the `/scan/[school_id]` precedent: public URL carries the school UUID; anon
Supabase client calls SECURITY DEFINER RPCs granted to `anon`; DB-side rate limiting via
the existing `auth_rate_limit` mechanism (keyed on IP-hash + school). No route handlers
needed. **Exactly three anon RPCs:**

| RPC | Contract |
|---|---|
| `list_public_result_exams(p_school_id)` | Published+unlocked-visibility exams for the picker: `(exam_id, exam_name)` — name/session only, nothing else |
| `check_result_public(p_school_id, p_exam_id, p_roll_number int, p_dob date)` | All four must match an enrollment → `{ student_name, class_label, roll_number, result_status, percentage, grade, subjects: [{name, obtained, max, grade}] }`. 3 mismatches / 10 min / IP-hash → `Too many attempts`. Returns data **only if** `result_publications.status='published'` |
| `verify_report_card(p_qr_token)` | `{ valid: true, student_name, class_label, exam_name, result_status, percentage, generated_at }` or `{ valid: false, reason: "revoked" \| "not found" }` — verification, not the full document |

Pages: `/results/[school_id]` (check form) and `/verify/report-card/[token]` — both
outside `(dashboard)`, no session required, `noindex`.

## 5.5 T3 — background jobs

| Job | Mechanism | Schedule |
|---|---|---|
| Publish due scheduled results + enqueue WA | pg_cron → `fn_publish_due_results()` | every 5 min |
| Exam status auto-flip (published→ongoing→completed by dates) | pg_cron → `fn_roll_exam_statuses()` | hourly |
| Marks-deadline teacher reminders | pg_cron → enqueue `wa_outbox` | daily 07:00 IST |
| WA delivery | **existing** `retry-wa-messages` / worker — untouched, new template keys only | existing |
| AI batch analysis | edge function `generate-report-analysis` | invoked by T2 route |
| Purge `question_paper_access_logs` > 2 years | pg_cron | daily (quiet hours) |

## 5.6 Error & response conventions (unchanged from house style)

- RPC failures: Postgres `RAISE EXCEPTION 'message'`; client components show
  `error.message` in the existing toast/banner pattern. Access failures always read
  `Access denied: <reason>`.
- Route handlers: `{ error: string }` + status (400 validation, 401 no session,
  403 role/scope, 404 empty-by-RLS, 429 rate-limited pass-through).
- Never leak other-tenant existence: cross-school ids yield the same `not found`
  as nonexistent ids (RLS makes this automatic on reads; RPCs check school first).
- Mutating RPCs return the new state (row or `jsonb` summary) so the UI updates without
  a refetch where practical.

## 5.7 TypeScript contracts

New file **`types/exams.ts`** (keeps the 600-line `types/index.ts` from doubling;
re-exported from `types/index.ts` for a single import surface). Contains: table row
interfaces for all 25 tables, the literal-union status types
(`ExamStatus`, `SubmissionStatus`, `ExamAttStatus`, …), and RPC payload/return
interfaces exactly matching §5.2 (same discipline as the existing
"RPC RETURN TYPES match RETURNS TABLE exactly" section).

---

*Next: Step 6 — Folder structure + Step 7 — UI design (proposed as one combined step:
the page tree and the screens are the same decision).*
