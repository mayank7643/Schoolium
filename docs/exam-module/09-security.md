# Exam Module — Step 9: Security Design

Companion to Steps 1–8. Everything below compiles directly into the Step 10 migrations.
Layering order (a request must pass every layer that applies):

1. Middleware route gating (`ROLE_ALLOW`) — coarse UX-level fence
2. RLS policies — row visibility & direct-write limits
3. SECURITY DEFINER RPC guards — state machines, role checks, cross-entity rules
4. Same-school + behavioral triggers — last line, catches even service-role mistakes
5. Append-only audit — detection when prevention fails

---

## 9.1 Threat model

| # | Threat | Actor | Primary controls |
|---|---|---|---|
| T1 | Cross-tenant read/write (school A sees school B) | any authenticated user | `school_id = get_my_school_id()` in every policy; same-school triggers; RPCs resolve school from `auth.uid()`, **never** from client input |
| T2 | Teacher enters/edits marks outside assigned subjects | teacher | RLS via `teaches_subject_in_class()`; RPC re-checks; UI never determines scope |
| T3 | Marks tampering after submission/freeze | teacher, colluding CT | `tg_marks_frozen_guard` trigger (bypasses nothing, not even service role); workflow statuses only movable by the role that owns each transition; full audit |
| T4 | Question paper leak before exam | any staff, leaked link | private bucket; access only via `get_question_paper_url` (60 s signed URL, mandatory log row); storage RLS mirrors table RLS; access-log review UI |
| T5 | Result scraping / enumeration on public endpoints | anonymous internet | 4-factor match (school+exam+roll+dob); DB-side rate limit (IP-hash); minimal payloads; uniform "not found"; published-state check on every call |
| T6 | Privilege escalation via RPC parameter abuse | any authenticated user | every RPC derives role/school/staff from `auth.uid()`; client-supplied ids validated to belong to caller's school before use; `SET search_path = public` on all functions |
| T7 | Forged report cards / admit cards | outsiders | UUIDv4 QR tokens verified server-side; `is_revoked` / `version_status` on verify payloads |
| T8 | Grade/result manipulation by admin without trace | school_admin | admins CAN act (they own the school) but cannot act silently: audit tables have no UPDATE/DELETE policies for anyone; reopen/unlock require reason strings stored forever |
| T9 | Student PII exposure via public surface | anonymous | public RPCs return name/class/roll/result only — never phone, address, photo URL, DOB (DOB is an *input*, not an output) |
| T10 | Stolen session of low-privilege staff | attacker | role checks everywhere server-side; permission matrix (`has_permission`) allows per-school tightening; login history (existing) for forensics |

Out of scope (platform level, already handled or unchanged): Supabase auth hardening
(chat19 OTP + rate limits), transport security, backup policy.

## 9.2 RLS policy matrix

Notation: `SCH` = `school_id = get_my_school_id()` · `ADM` = `get_my_role() IN
('school_admin','principal')` · `TSC(es)` = caller `teaches_subject_in_class(es.subject_id,
es.class_id)` for the row's paper · `CTC(c)` = `is_class_teacher_of(c)`.
All tables: `ENABLE ROW LEVEL SECURITY`; no policy ⇒ no access (deny by default).
"RPC-only" = no INSERT/UPDATE/DELETE policies exist at all; writes happen inside
SECURITY DEFINER functions.

### Pattern P1 — school-read, admin-write, config tables
`academic_sessions, academic_terms, exam_types, exam_rooms, holidays,
admit_card_templates, grade_scales, grade_bands, exams, exam_classes, exam_subjects,
student_subject_overrides`

```sql
SELECT: SCH                       -- whole school reads (teachers need schedules/config)
ALL:    SCH AND ADM               -- direct writes for draft-stage config…
```
…but lifecycle columns are still safe: status transitions, locks and seeds go through
RPCs, and the guard triggers (`tg_session_not_locked`, `exam_is_mutable` checks,
term-overlap, band-overlap EXCLUDE) constrain even admin direct writes.

### Pattern P2 — school-read, RPC-only writes
`exam_enrollments, admit_cards, exam_attendance, marks_submissions, exam_results,
result_publications, report_cards, ai_report_analyses`

```sql
SELECT: SCH AND (ADM OR <role-scoped read below>)
-- no write policies: generate/scan/submit/compute/publish RPCs only
```
Role-scoped reads:
- `exam_enrollments`, `exam_attendance`: also readable by teachers where `TSC` on the
  paper or `CTC` on the class (they run exam day).
- `marks_submissions`: teacher sees own papers (`TSC`), CT sees class papers, ADM all.
- `exam_results`, `report_cards`: ADM + CT of the class; subject teachers see the
  subject rows through views, not raw tables.
- `ai_report_analyses`: ADM + CT of the student's class.

### Pattern P3 — the one teacher-writable table: `marks_entries`

```sql
SELECT: SCH AND ( ADM OR TSC(paper) OR CTC(paper.class_id) )
INSERT: SCH AND TSC(paper)
        AND submission_status(paper) IN ('pending','rejected')
        AND exam_status(paper) IN ('ongoing','completed')
UPDATE: same as INSERT (USING and WITH CHECK)
DELETE: none (rows are upserted, never deleted; absent/exempt are flags)
```
`submission_status()` / `exam_status()` are STABLE SECURITY DEFINER helpers so the
policy stays index-friendly and non-recursive. `tg_marks_frozen_guard` +
`tg_validate_marks` still run after the policy passes (belt and braces — the trigger
also stops service-role writes the policy never sees).

### Pattern P4 — question papers

```sql
question_papers / question_paper_versions:
  SELECT: SCH AND ( ADM OR TSC(paper) )
  writes: RPC-only (upload registers version; lock/unlock)
question_paper_access_logs:
  SELECT: SCH AND ADM          -- teachers do not see who else accessed
  INSERT: via RPC only; no UPDATE/DELETE policies (append-only)
```

### Pattern P5 — append-only audits
`marks_audit_log, exam_audit_log`

```sql
SELECT: SCH AND ADM
INSERT: trigger/RPC only (SECURITY DEFINER paths)
UPDATE/DELETE: no policy for anyone — immutable by construction
```

### Public (anon) surface
No table has an `anon` policy. The three public RPCs (`list_public_result_exams`,
`check_result_public`, `verify_report_card`) are SECURITY DEFINER with
`GRANT EXECUTE TO anon, authenticated` and internal rate-limit + publication-state
checks. Everything else: `REVOKE ALL FROM PUBLIC; GRANT EXECUTE TO authenticated;`.

## 9.3 RPC guard specification (uniform preamble)

Every exam-module RPC begins with the same audited preamble — identical in spirit to
`record_bulk_fee_payment` / `review_leave_request`:

```sql
-- 1. Identity: who is calling — never trusted from parameters
SELECT role, school_id, is_active INTO v_role, v_school, v_active
FROM profiles WHERE id = auth.uid();
IF NOT v_active OR v_school IS NULL THEN RAISE EXCEPTION 'Access denied: no active profile'; END IF;

-- 2. Role gate (per-RPC, from the Step 4 catalog)
IF NOT (v_role IN (...) OR has_permission('marks.enter')) THEN RAISE EXCEPTION 'Access denied: %', ...; END IF;

-- 3. Tenancy: every id parameter must resolve inside v_school
--    (SELECT ... WHERE id = p_x AND school_id = v_school → else 'not found')

-- 4. State gates: session unlocked, exam status allows the action,
--    submission status allows the transition (exact rows FOR UPDATE to
--    serialize concurrent state changes)

-- 5. Do the work in one transaction; write audit row(s); return new state.
```

Rules: `SECURITY DEFINER SET search_path = public` on every function; row locks
(`FOR UPDATE`) on the state row before checking+flipping status (no TOCTOU);
exceptions carry operator-readable messages, uniform `Access denied:` /
`not found` prefixes; **tenancy failures and nonexistence return the identical
message** (T1/T5 anti-enumeration).

## 9.4 Storage policies

| Bucket | Visibility | Limits | Policies |
|---|---|---|---|
| `question-papers` | private | 10 MB, `application/pdf` only | ADM full within `{school_id}/…` prefix; **no teacher SELECT policy** — teachers get 60 s signed URLs from the logging RPC only; uploads via RPC-issued path (teacher INSERT allowed where `TSC` resolves from the path's exam_subject segment) |
| `exam-assets` | private | 1 MB, png/jpeg/webp | ADM manage within school prefix (signatures, template art); referenced by PDFs server-side |
| `answer-sheets` (future) | private | 20 MB, pdf/jpeg | policies ship disabled-by-default with Phase F |

Path convention everywhere: `{school_id}/{exam_id}/…` — first folder segment is always
the tenant check, matching `staff-docs`.

## 9.5 Audit coverage map (what is provably reconstructible)

| Question an auditor asks | Answered by |
|---|---|
| Who changed this student's Maths mark, from what, to what, when, why | `marks_audit_log` (trigger-written old/new JSONB) |
| Who approved/froze/reopened this paper | `marks_audit_log` workflow actions + `marks_submissions` stamps |
| Who published/unpublished/locked this result | `exam_audit_log` (`publication`) + `result_publications` stamps |
| Who saw/downloaded question paper vN before the exam | `question_paper_access_logs` (no unlogged path exists) |
| Who generated/reprinted this admit card, how many copies | `admit_cards.print_count` + `exam_audit_log` |
| Who cancelled the exam and why | `exams.cancel_reason` + `exam_audit_log` |
| Which WhatsApp messages went out for this exam | existing `wa_message_log` / `wa_outbox` |
| Who logged in when (forensics) | existing `login_history` |

Retention: audit tables cascade only with tenant deletion; `question_paper_access_logs`
purged after 2 years (pg_cron, §5.5); marks/exam audit logs are kept indefinitely
(they are small relative to their value).

## 9.6 Rate limiting (public surface)

Reuses the chat19 `auth_rate_limit` table + helper pattern:

| Endpoint | Key | Rule |
|---|---|---|
| `check_result_public` | `result_check:` + IP-hash + school | 3 failed matches / 10 min → `Too many attempts, try again later`; 30 successes / hour (a parent checking siblings is fine; scraping is not) |
| `verify_report_card` | `rc_verify:` + IP-hash | 20 / min (QR scans are bursty but human) |
| `list_public_result_exams` | `result_list:` + IP-hash | 30 / min |

IP arrives via the platform's `x-forwarded-for` (hashed with a server salt before
storage — raw IPs are never persisted, consistent with existing practice).

## 9.7 Permission-matrix seeds

Exact `role_permissions` global rows shipped (Step 2 table, repeated here as the
authoritative list for the migration): principal gets every `exam.* / marks.verify|
approve|reopen / results.* / reports.exam / sessions.manage`; teacher gets `exams.view,
marks.enter, marks.verify (CT-constrained), exam.attendance.mark,
question_papers.upload, admit_cards.print, reports.exam`; receptionist gets
`exams.view, admit_cards.print`. `school_admin`/`super_admin` bypass via
`has_permission()`'s built-in short-circuit. Schools can tighten any of these per-school
(existing override mechanism) — e.g. revoke teachers' `admit_cards.print`.

---

*Next: Step 10 — SQL migrations, delivered per phase starting with
`chat21_exam_sessions_core.sql` (Groups A+B, helpers, seeds, audit, RLS), each validated
before the next.*
