# Schoolium — Exam Management Module: Architecture

Status: **Step 2 approved-pending** · Branch: `claude/exam-management-architecture-jks5si`
Scope: full digital examination lifecycle — sessions → exams → timetable → admit cards →
question papers → exam attendance → marks → verification → results → report cards →
analytics → AI insights.

Decisions locked with product owner (2026-07-08):

1. **Grading:** configurable per school (`grade_scales` + `grade_bands`), CBSE 8-point
   scale seeded as the default so schools work out of the box. Percentage, grade and
   CGPA computed simultaneously.
2. **Result access for parents:** WhatsApp report-card PDF via the existing `wa_outbox`
   pipeline + a public QR-verified result page (roll number + DOB, rate-limited).
   Parent-login portal deferred; schema designed so it bolts on without ALTERs.
3. **AI analysis:** schema is provider-agnostic (`ai_report_analyses` stores provider,
   model, prompt version, JSONB output). Provider chosen at Phase 10.

---

## Step 1 — Architecture Analysis (summary)

### Existing assets reused (never rewritten)

| Asset | Role in exam module |
|---|---|
| `get_my_school_id()`, `get_my_role()`, `get_my_staff_id()`, `has_permission()` | All new RLS policies and RPCs |
| `is_class_teacher_of()`, `teaches_in_class()` | Verification workflow + marks scoping (extended with `teaches_subject_in_class()`) |
| `classes` (row = class+section), `subjects`, `subject_assignments`, `class_teachers` | Exam configuration and teacher access control |
| `students` (`student_uid`, `photo_url`, parent phone) | Enrollment, admit cards, report cards |
| `attendance.exam_id` (reserved column, gate scans) | Optional gate-scan link on exam day; formal exam attendance is a new table |
| `wa_outbox` + worker edge function + per-school quota | All exam notifications (schedule, admit card ready, result published) |
| `fee_audit_trail` / `log_fee_audit_event` pattern | `exam_audit_log` + `marks_audit_log` |
| `staff-docs` bucket pattern (`{school_id}/...` folder RLS) | `question-papers`, `answer-sheets` buckets |
| `@react-pdf/renderer` API-route pattern | Admit cards (1/2/3/4-up A4), report cards, reports |
| `role_permissions` matrix + seeds | New `exam.*`, `marks.*`, `results.*` permission keys |
| `pg_cron` | Scheduled result publishing, log purges |
| Idempotent consolidated migrations in `Migration sql/` | Module ships as `chat21+_exam_*.sql` |

### House conventions followed

- TEXT + CHECK constraints instead of native Postgres enums (existing style; cheap to extend).
- Every table: `school_id uuid NOT NULL REFERENCES schools ON DELETE CASCADE` + RLS.
- Reads via RLS policies; **all lifecycle/state-machine writes via SECURITY DEFINER RPCs**
  (`SET search_path`, role+school validation, `REVOKE ALL FROM PUBLIC`, `GRANT EXECUTE TO authenticated`).
- Same-school integrity triggers as defense-in-depth beyond RLS.
- `tg_set_updated_at()` on mutable tables.
- Composite `(school_id, x)` indexes; FK indexes everywhere.

### Gaps being filled (greenfield)

Academic sessions/terms (today `academic_year` is free TEXT on fee tables — left untouched
for backward compatibility), the entire exam domain, exam roll numbers (session-scoped, so
they live on enrollments — `students` unchanged), grade scales, publishing, and
public QR verification.

---

## Step 2 — Database Design

**22 core tables + 3 future-ready tables, in 7 groups.** All names plural snake_case.
`(FK)` marks a foreign key; every FK gets an index; every table gets
`idx_<table>_school` unless the leading column of another index is `school_id`.

Legend for common columns (not repeated in every table):

- `id uuid PK DEFAULT uuid_generate_v4()`
- `school_id uuid NOT NULL → schools ON DELETE CASCADE`
- `created_at timestamptz NOT NULL DEFAULT now()`; mutable tables also
  `updated_at` + `trg_*_updated_at`
- `created_by uuid → profiles ON DELETE SET NULL` where authorship matters

### Group A — Academic sessions

#### `academic_sessions`
| Column | Type / Constraint |
|---|---|
| name | text NOT NULL — e.g. `2026-27` |
| start_date / end_date | date NOT NULL, CHECK `end_date > start_date` |
| status | text CHECK (`upcoming`,`active`,`locked`,`archived`) DEFAULT `upcoming` |
| is_current | boolean DEFAULT false |

- `UNIQUE (school_id, name)`
- Partial unique index: **one current session per school** — `UNIQUE (school_id) WHERE is_current`
- Locking: `status='locked'` blocks all exam/marks mutations in that session
  (enforced in RPCs + trigger `tg_session_not_locked`). `archived` = locked + hidden
  from pickers.
- RPCs: `create_academic_session`, `set_current_session`, `lock_academic_session`,
  `archive_academic_session`.

#### `academic_terms`
| Column | Type / Constraint |
|---|---|
| session_id | uuid NOT NULL (FK academic_sessions ON DELETE CASCADE) |
| name | text NOT NULL — `Term 1`, `Semester 2` |
| term_type | text CHECK (`term`,`semester`) DEFAULT `term` |
| sort_order | int NOT NULL DEFAULT 1 |
| start_date / end_date | date NOT NULL, CHECK end ≥ start |
| weightage_percent | numeric(5,2) DEFAULT 100 — contribution to session-final aggregate |
| is_locked | boolean DEFAULT false |

- `UNIQUE (session_id, name)`; trigger validates term dates fall inside session dates
  and terms of one session don't overlap.

### Group B — Exam core

#### `exam_types` (per-school catalogue, seeded on session creation)
| Column | Type / Constraint |
|---|---|
| name / code | text NOT NULL — `Unit Test`, `UT` |
| category | text CHECK (`unit_test`,`monthly`,`quarterly`,`half_yearly`,`annual`,`practical`,`custom`) |
| default_weightage | numeric(5,2) DEFAULT 100 |
| is_active | boolean DEFAULT true |

- `UNIQUE (school_id, name)`. Seed function `seed_default_exam_types(school_id)` inserts
  the 6 standard types idempotently.

#### `exams`
| Column | Type / Constraint |
|---|---|
| session_id | uuid NOT NULL (FK academic_sessions) |
| term_id | uuid NULL (FK academic_terms) |
| exam_type_id | uuid NOT NULL (FK exam_types) |
| name | text NOT NULL — `Half Yearly Examination 2026-27` |
| status | text CHECK (`draft`,`published`,`ongoing`,`completed`,`locked`,`cancelled`) DEFAULT `draft` |
| start_date / end_date | date NULL (derived from timetable, denormalized for lists) |
| general_instructions | text |
| published_at / locked_at / cancelled_at | timestamptz |
| cancel_reason | text |

- `UNIQUE (school_id, session_id, name)`
- **State machine (RPC `change_exam_status` only):**
  `draft → published → ongoing → completed → locked`; `cancelled` reachable from
  draft/published/ongoing. Backward transitions: `published → draft` only while no
  marks exist; `locked` is terminal except super-controlled unlock (admin + audit row).
- Config editable only in `draft`; timetable editable until `ongoing`; marks entry only
  in `ongoing`/`completed`; everything read-only in `locked`/`cancelled`.

#### `exam_classes` — which class-sections sit the exam
`exam_id` (FK exams CASCADE), `class_id` (FK classes), `UNIQUE (exam_id, class_id)`.
Same-school trigger.

#### `exam_subjects` — the heart of configuration **and the timetable**
One row = one paper (exam × class × subject). The timetable is not a separate table —
date/time/room live here, eliminating sync bugs.

| Column | Type / Constraint |
|---|---|
| exam_id / class_id / subject_id | uuid NOT NULL (FKs), `UNIQUE (exam_id, class_id, subject_id)` |
| max_marks_theory | numeric(6,2) NOT NULL DEFAULT 100 |
| max_marks_practical | numeric(6,2) NOT NULL DEFAULT 0 |
| max_marks_internal | numeric(6,2) NOT NULL DEFAULT 0 |
| total_max_marks | numeric(6,2) GENERATED ALWAYS AS (theory+practical+internal) STORED |
| pass_marks | numeric(6,2) NOT NULL, CHECK `pass_marks <= total_max_marks` |
| weightage_percent | numeric(5,2) DEFAULT 100 — contribution to exam aggregate |
| is_optional | boolean DEFAULT false — optional subjects counted only for takers |
| exam_date | date NULL (null until scheduled) |
| start_time | time NULL |
| reporting_time | time NULL, CHECK `reporting_time <= start_time` |
| duration_minutes | int CHECK > 0 |
| room_id | uuid NULL (FK exam_rooms) — default room; per-student override on enrollment |
| instructions | text — paper-specific |

- Index `(exam_id, exam_date)` for calendar; `(class_id, exam_date, start_time)` for
  conflict detection.
- **Conflict detection** (`validate_exam_timetable(exam_id)` RPC returning issue rows):
  same class two papers overlapping in time; same room double-booked beyond capacity;
  paper on a `holidays` date; paper outside exam date range; missing date/time on publish.
- **Auto-generation** (`auto_generate_timetable` RPC): fills dates across the exam window,
  skipping holidays/Sundays, one paper per class per day (configurable gap), manual edit after.

#### `exam_enrollments` — who sits, with exam roll number
| Column | Type / Constraint |
|---|---|
| exam_id / student_id / class_id | uuid NOT NULL (FKs), `UNIQUE (exam_id, student_id)` |
| roll_number | int NOT NULL, `UNIQUE (exam_id, class_id, roll_number)` |
| room_id / seat_number | uuid NULL / text NULL — per-student seating (future auto-seating) |
| status | text CHECK (`enrolled`,`exempted`,`withdrawn`,`transferred`) DEFAULT `enrolled` |
| remarks | text |

- Generated in bulk by `generate_exam_enrollments(exam_id)` at publish (roll numbers
  alphabetical per class, deterministic, re-runnable for late admissions — appends next
  roll number, never renumbers issued admit cards).
- `withdrawn`/`transferred` (TC before result) keeps the row for audit; results marked
  `withheld`.

#### `student_subject_overrides` — optional subjects & exemptions (session-scoped)
| Column | Type / Constraint |
|---|---|
| session_id / student_id / subject_id | uuid NOT NULL (FKs) |
| kind | text CHECK (`exempted`,`optional_selected`) |
| reason | text |

- `UNIQUE (session_id, student_id, subject_id)`. Marks entry and result computation
  consult this: exempted ⇒ subject excluded from totals; optional subject without
  `optional_selected` ⇒ not expected to appear.

### Group C — Logistics

#### `exam_rooms`
`name` text NOT NULL, `capacity` int CHECK > 0, `location` text, `is_active` bool.
`UNIQUE (school_id, name)`.

#### `holidays`
`session_id` (FK), `holiday_date` date NOT NULL, `name` text NOT NULL.
`UNIQUE (school_id, holiday_date)`. Consumed by timetable generation/validation.

#### `admit_card_templates` (per school; exam can override)
`name`, `layout` text CHECK (`single`,`two_per_a4`,`three_per_a4`,`four_per_a4`),
`instructions` text, `principal_signature_path` text (storage), `show_photo` /
`show_qr` / `show_seat` booleans, `is_default` bool (partial unique per school).

#### `admit_cards`
| Column | Type / Constraint |
|---|---|
| exam_id / enrollment_id | uuid NOT NULL (FKs), `UNIQUE (enrollment_id)` |
| qr_token | uuid NOT NULL DEFAULT uuid_generate_v4(), UNIQUE — public verify + QR attendance |
| template_id | uuid NULL (FK admit_card_templates) |
| generated_at / generated_by | timestamptz / uuid |
| print_count | int DEFAULT 0; `last_printed_at` timestamptz |
| is_revoked | boolean DEFAULT false — revoke + regenerate on data fix |

- Bulk generation RPC per exam/class; PDF rendered on demand by API route (no stored
  PDFs — data is the source of truth; snapshot only for report cards where legal
  immutability matters).

#### `question_papers`
| Column | Type / Constraint |
|---|---|
| exam_subject_id | uuid NOT NULL (FK exam_subjects CASCADE), UNIQUE |
| status | text CHECK (`draft`,`final`) DEFAULT `draft` |
| current_version_id | uuid NULL (FK question_paper_versions, DEFERRABLE) |
| locked_by / locked_at | uuid / timestamptz — set when `final` |

#### `question_paper_versions`
`question_paper_id` (FK CASCADE), `version_no` int NOT NULL (`UNIQUE (question_paper_id,
version_no)`), `file_path` text NOT NULL (bucket `question-papers`,
`{school_id}/{exam_id}/{exam_subject_id}/v{n}.pdf`), `file_size`, `note`, `uploaded_by`.
Upload blocked once parent is `final`.

#### `question_paper_access_logs`
`question_paper_id`, `version_id`, `profile_id`, `action` CHECK
(`upload`,`view`,`download`,`lock`,`unlock`), `created_at`. Inserted by the signed-URL
RPC (`get_question_paper_url`) — downloads are impossible without a log row.
Access: assigned subject teacher(s) + admin/principal only, enforced in RPC **and**
storage RLS.

### Group D — Exam attendance (separate from daily attendance)

#### `exam_attendance`
| Column | Type / Constraint |
|---|---|
| exam_subject_id / student_id | uuid NOT NULL (FKs), `UNIQUE (exam_subject_id, student_id)` |
| status | text CHECK (`present`,`absent`,`medical`,`late`) |
| source | text CHECK (`qr`,`manual`) DEFAULT `manual` |
| marked_by / marked_at | uuid / timestamptz |
| remarks | text |

- QR flow: scanning the admit-card `qr_token` at the room resolves enrollment → verifies
  student (photo shown) → upserts `present`/`late` (late if after `start_time`).
- Marks validation: `absent`/`medical` here ⇒ `marks_entries.is_absent` must be true
  (cross-checked at submission).

### Group E — Marks & verification

#### `marks_entries`
| Column | Type / Constraint |
|---|---|
| exam_subject_id / student_id | uuid NOT NULL (FKs), `UNIQUE (exam_subject_id, student_id)` |
| enrollment_id | uuid NOT NULL (FK exam_enrollments) |
| theory_marks / practical_marks / internal_marks | numeric(6,2) NULL, CHECK ≥ 0 |
| grace_marks | numeric(5,2) NOT NULL DEFAULT 0 |
| is_absent / is_exempted | boolean DEFAULT false |
| total_marks | numeric(7,2) GENERATED (COALESCE sums + grace) STORED |
| entered_by / updated_by | uuid |
| — future-ready — | `evaluation_source` text CHECK (`manual`,`digital`,`omr`) DEFAULT `manual`; `moderation_status` text NULL |

- Trigger `tg_validate_marks`: each component ≤ its max in `exam_subjects`;
  absent/exempted ⇒ all components NULL; grace ≤ school-configurable cap.
- Trigger `tg_marks_frozen_guard`: UPDATE/DELETE rejected when the linked
  `marks_submissions.status` ∈ (`submitted`,`verified`,`approved`,`frozen`) — teacher
  edits only in `pending`/`rejected`. **After freeze, read-only, period** (only
  `reopen_marks` RPC by principal/admin flips state, with mandatory reason → audit).
- Autosave-friendly: RPC `save_marks_bulk(exam_subject_id, jsonb rows)` upserts;
  UI calls it debounced.

#### `marks_submissions` — one per paper, drives the workflow
| Column | Type / Constraint |
|---|---|
| exam_subject_id | uuid NOT NULL UNIQUE (FK) |
| status | text CHECK (`pending`,`submitted`,`verified`,`approved`,`frozen`,`rejected`) DEFAULT `pending` |
| submitted_by/at, verified_by/at, approved_by/at, frozen_at | uuid / timestamptz |
| rejection_reason | text |

- **Workflow (RPCs only):** subject teacher `submit_marks` (validates completeness:
  every enrolled, non-exempt student has marks or is_absent) → class teacher
  `verify_marks` → principal `approve_marks` → `freeze_marks` (auto after approval or
  explicit) → result generation eligible. `reject_marks` at verify/approve steps returns
  to teacher with reason.

#### `marks_audit_log` (append-only; INSERT via trigger on `marks_entries` + workflow RPCs)
`marks_entry_id`, `exam_subject_id`, `student_id`, `action` CHECK
(`insert`,`update`,`delete`,`submit`,`verify`,`approve`,`freeze`,`reject`,`reopen`),
`old_values` jsonb, `new_values` jsonb, `changed_by`, `reason`, `created_at`.
No UPDATE/DELETE policies — append-only even for admins.

### Group F — Grades, results, report cards

#### `grade_scales`
`name` text NOT NULL, `session_id` uuid NULL (null = school default across sessions),
`is_default` boolean (partial unique per school), `is_active` bool.
Seed: `seed_cbse_grade_scale(school_id)` → A1 91–100 (10.0), A2 81–90 (9.0),
B1 71–80 (8.0), B2 61–70 (7.0), C1 51–60 (6.0), C2 41–50 (5.0), D 33–40 (4.0),
E 0–32 (fail).

#### `grade_bands`
`grade_scale_id` (FK CASCADE), `min_percent` / `max_percent` numeric(5,2),
`grade_label` text, `grade_point` numeric(4,2), `is_fail` boolean DEFAULT false,
`description` text. **EXCLUDE USING gist** on
`(grade_scale_id WITH =, numrange(min_percent, max_percent, '[]') WITH &&)` —
overlapping bands are impossible at the DB level.

#### `exam_results` (computed snapshot per student per exam)
| Column | Type / Constraint |
|---|---|
| exam_id / student_id / enrollment_id | uuid NOT NULL, `UNIQUE (exam_id, student_id)` |
| total_max / total_obtained | numeric(8,2) |
| percentage | numeric(5,2) |
| grade_label / grade_point | text / numeric(4,2) |
| subjects_failed | int DEFAULT 0 |
| result_status | text CHECK (`pass`,`fail`,`withheld`,`absent`) |
| rank_in_class | int NULL |
| attendance_percent | numeric(5,2) — from `class_attendance` over the term |
| computed_at / computed_by | timestamptz / uuid |

- `compute_exam_results(exam_id)` RPC: requires **all** papers frozen; weightage-aware;
  optional/exempt subjects excluded per overrides; grace included; ranks dense-ranked
  per class; re-runnable until results locked.

#### `report_cards`
`exam_id` NULL / `term_id` NULL / `session_id` NOT NULL (exam-wise, term-wise or
consolidated), `student_id`, `snapshot` jsonb NOT NULL (marks, grades, attendance,
remarks, school branding at generation time — legally immutable), `qr_token` uuid UNIQUE,
`class_teacher_remarks` text, `generated_by/at`, `version` int.
`UNIQUE (student_id, exam_id)` partial where exam_id not null.
Public RPC `verify_report_card(qr_token)` → minimal verification payload (no PII beyond
name/class/result), SECURITY DEFINER, rate-limited via existing `auth_rate_limit` pattern.

#### `result_publications`
`exam_id` UNIQUE, `status` CHECK (`unpublished`,`scheduled`,`published`,`locked`)
DEFAULT `unpublished`, `scheduled_for` timestamptz, `published_at/by`,
`unpublished_at/by`, `notes`. pg_cron job publishes due scheduled rows and enqueues
`wa_outbox` messages. `locked` prevents unpublish.

#### `ai_report_analyses` (provider-agnostic)
`student_id`, `exam_id`, `report_card_id` NULL, `provider` text, `model` text,
`prompt_version` text, `analysis` jsonb (summary, strengths[], weaknesses[],
subject_comparison, trends, attendance_analysis, parent_suggestions[],
teacher_suggestions[], study_recommendations[]), `input_tokens`/`output_tokens` int,
`status` CHECK (`pending`,`completed`,`failed`), `generated_at`.
`UNIQUE (exam_id, student_id, prompt_version)` — cached, regenerate = new prompt_version.

### Group G — Cross-cutting & future-ready

#### `exam_audit_log` (module-wide lifecycle audit, append-only)
`entity_type` text (`exam`,`timetable`,`admit_card`,`question_paper`,`enrollment`,
`result`,`publication`,`session`), `entity_id` uuid, `action` text, `old_values` /
`new_values` jsonb, `actor_id`, `reason`, `created_at`.
Index `(school_id, entity_type, entity_id, created_at DESC)`.

#### Future-ready (schema shipped, no UI — Phase F)
- `answer_sheets`: `exam_subject_id`, `student_id`, `file_path`, `status`
  (`uploaded`,`assigned`,`evaluated`,`moderated`), `evaluator1_id`/`marks1`,
  `evaluator2_id`/`marks2` (double evaluation), `final_marks`, `omr_payload` jsonb.
- `reevaluation_requests`: `exam_subject_id`, `student_id`, `request_type`
  (`recheck`,`reevaluation`), `status` (`requested`,`in_progress`,`completed`,`rejected`),
  `old_marks`/`new_marks`, `decided_by/at`, `remarks`.
- Auto-seating: already supported by `exam_rooms.capacity` +
  `exam_enrollments.room_id/seat_number`; the optimizer is a pure RPC later.

### Views & materialized views

- `v_exam_calendar` — papers with class/subject/room names for calendar UI.
- `v_marks_entry_status` — per exam: papers × submission status (admin progress board).
- `v_class_result_summary` — per exam × class: average %, pass %, topper, grade histogram.
- `mv_school_performance` — materialized, refreshed by `compute_exam_results` /
  publication; feeds the school dashboard without hot aggregation.
- All views `security_invoker = true` so RLS of the caller applies (Postgres 15+).

### New helper functions

- `teaches_subject_in_class(p_subject_id, p_class_id)` — SECURITY DEFINER STABLE;
  true if caller's staff row has a matching `subject_assignments` row. Backbone of
  marks-entry and question-paper RLS.
- `get_current_session_id()` — caller's school's `is_current` session.
- `exam_is_mutable(p_exam_id)` — status ∉ (locked, cancelled) AND session not locked.

### New permission keys (seeded into `role_permissions`)

| Key | principal | teacher | others |
|---|---|---|---|
| `sessions.manage` | ✓ | — | school_admin implicit |
| `exams.view` | ✓ | ✓ | receptionist ✓ |
| `exams.manage` / `exams.publish` / `exams.lock` | ✓ | — | |
| `exam.timetable.manage`, `exam.rooms.manage` | ✓ | — | |
| `admit_cards.generate` / `admit_cards.print` | ✓ | — / print ✓ | receptionist print ✓ |
| `question_papers.upload` | ✓ | ✓ (assigned only, enforced by RLS) | |
| `exam.attendance.mark` | ✓ | ✓ (assigned/invigilating) | |
| `marks.enter` | — | ✓ (assigned subjects only) | |
| `marks.verify` | ✓ | ✓ (class-teacher only, enforced by `is_class_teacher_of`) | |
| `marks.approve`, `marks.reopen` | ✓ | — | |
| `results.compute` / `results.publish` | ✓ | — | |
| `results.view` | ✓ | ✓ (own classes) | |
| `reports.exam` | ✓ | ✓ (scoped) | |

### RLS strategy (detailed policies land with each phase's migration)

- **Default:** school-wide SELECT (`school_id = get_my_school_id()`) for non-sensitive
  config (exam_types, exams, exam_classes, exam_subjects, rooms, holidays); writes
  admin/principal or RPC-only.
- **Teacher-scoped:** `marks_entries` SELECT/INSERT/UPDATE only where
  `teaches_subject_in_class(subject, class)` of the parent `exam_subjects` row AND
  submission status permits (frozen guard trigger is the second lock).
  `question_papers`/versions likewise. Class teachers additionally read all
  `marks_entries` of their class (verification).
- **Append-only audits:** INSERT via triggers/RPCs; SELECT admin/principal; no
  UPDATE/DELETE policies at all.
- **Public surface:** exactly two SECURITY DEFINER RPCs callable by `anon` —
  `verify_report_card(qr_token)` and `check_result_public(school_code, roll, dob)` —
  both rate-limited (existing `auth_rate_limit` mechanism), returning minimal payloads.
- **Storage:** `question-papers` bucket private; object RLS mirrors table RLS
  (`{school_id}/…` prefix + role/assignment checks); downloads only through the
  logging RPC's signed URLs.

### Migration packaging (Step 10 will emit these)

| File | Contents |
|---|---|
| `chat21_exam_sessions_core.sql` | Groups A + B, helpers, permission seeds, exam audit log |
| `chat22_exam_logistics.sql` | Group C + timetable RPCs + buckets |
| `chat23_exam_attendance_marks.sql` | Groups D + E + workflow RPCs + audit triggers |
| `chat24_exam_results.sql` | Group F + compute/publish RPCs + views + cron |
| `chat25_exam_future_ready.sql` | Group G future tables |

Each idempotent (`IF NOT EXISTS` / `DROP POLICY IF EXISTS` / `CREATE OR REPLACE`),
pure ASCII, single PostgREST schema reload at the end — matching chat17's format.

---

## Edge-case decisions baked into the schema (full treatment in Step 8)

| Edge case | Where it's solved |
|---|---|
| Absent student | `exam_attendance.status` + `marks_entries.is_absent`, cross-validated at submit; result computes with 0 but `result_status` can show `absent` |
| Exam cancelled | `exams.status='cancelled'` — terminal, everything read-only, excluded from results |
| Teacher replaced | Marks tied to `exam_subject_id`, not teacher; new teacher inherits via `subject_assignments`; audit log preserves who entered what |
| Edit before freeze | Allowed in `pending`/`rejected` only; every change audited |
| Edit after freeze | Blocked by trigger; only `reopen_marks` (principal, mandatory reason, audited) |
| Duplicate marks | `UNIQUE (exam_subject_id, student_id)` — impossible |
| TC before result | Enrollment `withdrawn/transferred`; result `withheld`; row retained for audit |
| Multiple exams same day | Conflict validator blocks same-class overlap; different classes fine |
| Late admission | `generate_exam_enrollments` re-run appends next roll number; existing admit cards untouched |
| Subject exemption | `student_subject_overrides.kind='exempted'` — excluded from totals & completeness check |
| Grace marks | Explicit `grace_marks` column, capped, in generated total, visible in audit |
| Optional subjects | `exam_subjects.is_optional` + `optional_selected` override |

---

*Step 3: `03-relationships.md` · Step 4: `04-workflows.md` · Step 5: `05-api-design.md` · Steps 6+7: `06-07-folders-ui.md`.*
