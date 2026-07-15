# Exam Module — Step 8: Edge Cases

Companion to Steps 1–7. Format per case: **Scenario → Mechanism (DB truth) → Flow
(who does what) → Audit**. "Mechanism" always names the constraint/trigger/RPC from
Steps 2–4 — nothing here relies on UI discipline alone.

---

## 8.1 The twelve specified cases

### 1. Absent student

- **Mechanism:** `exam_attendance.status ∈ (absent, medical)` +
  `marks_entries.is_absent = true`; `tg_validate_marks` forces all mark components NULL
  when absent; `submit_marks` cross-checks the two tables and refuses on mismatch
  ("absent in room but has marks" / "present in room but marked absent").
- **Flow:** invigilator marks absent (scan never happens / manual) → teacher's grid
  pre-flags the row absent (editable, in case of data-entry error on either side) →
  submit reconciles. Result computation: subject contributes 0;
  `exam_results.result_status = 'absent'` when the student missed **all** papers,
  else pass/fail computed normally with the miss counted.
- **Report card:** shows `AB` in the subject cell, footnote automatic. Medical absences
  render `AB(M)` — schools commonly need the distinction for promotion committees.
- **Audit:** attendance row (marked_by) + marks row + submission completeness check all
  independently recorded.

### 2. Exam cancelled

- **Mechanism:** `cancel_exam(exam_id, reason)` — allowed from draft/published/ongoing;
  status `cancelled` is terminal (state machine has no exit edge); every write RPC
  checks `exam_is_mutable()`; validator/marks/results RPCs refuse outright.
- **Flow:** SA/PR cancels with mandatory reason → WA notification to affected parents
  (`exam_schedule_change` template) → admit cards auto-revoked (single UPDATE inside the
  RPC) so gate QR scans answer "revoked". Marks already entered stay readable forever
  (history), excluded from every aggregate (`WHERE e.status != 'cancelled'` in all
  reporting RPCs/views).
- **Partial cancellation** (one paper cancelled, exam continues): remove/zero-weight the
  `exam_subjects` row is wrong (loses history) — instead `exam_subjects.is_cancelled`
  flag (added to Step 2 spec): paper excluded from completeness checks, totals and
  result computation; timetable shows it struck through.
- **Audit:** `exam_audit_log` (`exam`, `cancel`, reason) + notification log.

### 3. Teacher replaced mid-exam

- **Mechanism:** every access check resolves **live** through `subject_assignments`
  (`teaches_subject_in_class()`); marks rows carry `entered_by` but ownership is the
  paper, not the person.
- **Flow:** admin updates the assignment (existing staff module, untouched) → old
  teacher instantly loses write RLS on the paper's marks + question-paper access; new
  teacher instantly gains it, sees the grid exactly as left (autosaved), continues.
  Submission workflow state is unaffected — a paper `submitted` by the old teacher can
  be verified/approved normally; a rejection routes to whoever is *currently* assigned.
- **Audit:** old rows keep `entered_by` = old teacher; new edits stamp the new teacher;
  `marks_audit_log` shows the seam precisely.

### 4. Marks edited before freeze

- **Mechanism:** RLS + `tg_marks_frozen_guard`: writable only while the paper's
  submission status is `pending`/`rejected`, and only by the assigned teacher.
  Between `submitted` and `frozen`, even the teacher is read-only — corrections require
  a `reject_marks` bounce (CT/PR) which is itself recorded.
- **Audit:** `tg_marks_audit` writes old→new JSONB on every UPDATE — there is no
  unaudited edit window at any point in the lifecycle.

### 5. Marks edited after freeze

- **Mechanism:** freeze is enforced by trigger (not policy alone) — even a
  service-role script tripping over it gets an exception. The single legitimate path is
  `reopen_marks(exam_subject_id, reason)` (PR/SA): flips status to `pending`, stamps
  the audit log, sets dependent `exam_results.is_final = false` (stale), and **refuses
  to run at all** once `result_publications.status = 'locked'`.
- **Flow after reopen:** teacher corrects → full re-chain (submit → verify → approve →
  freeze) → recompute results → re-publish. No shortcut exists by design; the workflow
  states are the proof the correction was reviewed.

### 6. Duplicate marks

- **Mechanism:** `UNIQUE (exam_subject_id, student_id)` on `marks_entries`;
  `save_marks_bulk` upserts on that key, so double-submit/refresh/two-tab races
  converge on one row. Duplicate *enrollment* is equally impossible:
  `UNIQUE (exam_id, student_id)`.
- **Concurrent editors** (two teachers co-assigned, same paper, same student):
  last-write-wins on the row, both writes audited. The grid subscribes to
  autosave responses and refreshes stale cells — a visible "updated by <name> just now"
  chip rather than silent overwrite.

### 7. Transfer Certificate before result

- **Mechanism:** enrollment status `transferred` (or `withdrawn`); the student row
  itself is soft-deactivated by the existing TC flow (untouched).
  `compute_exam_results` marks them `result_status = 'withheld'`; publication excludes
  withheld rows from the public check ("result withheld — contact school"), report
  cards are not generated.
- **Data retention:** enrollment + marks rows persist (FK `RESTRICT` philosophy §3.1) —
  if the TC is reversed or the new school requests marks, everything is intact;
  flipping enrollment back to `enrolled` + recompute restores the student fully.
- **Class aggregates:** withheld students excluded from denominator of class average /
  pass % (consistent treatment in every Phase-9 RPC).

### 8. Multiple exams in one day

- **Same class:** timetable validator `CLASS_OVERLAP` (time overlap = error, blocks
  publish) and `SAME_DAY_LOAD` (two non-overlapping papers same day = warning —
  legitimate for practical+theory days, so allowed but flagged).
- **Different exams overlapping** (e.g. Class 5 unit test during Class 10 half-yearly):
  fully supported — papers are independent rows; room conflicts across exams are caught
  because `ROOM_DOUBLE_BOOKED` checks by room+slot across the school, not per exam.
- **Invigilator double-booking:** out of scope until invigilator assignment exists
  (future column on `exam_subjects`); noted for the seating/invigilation phase.

### 9. Late admission

- **Mechanism:** `generate_exam_enrollments` is idempotent-append: existing enrollments
  untouched, new students get `MAX(roll_number)+1` per class (issued admit cards never
  renumber). Runs any time between publish and exam end.
- **Flow:** receptionist admits student (existing flow) → admin opens
  enrollments page → "1 unenrolled student" banner → re-run → generate that student's
  admit card → done. If papers were already sat: teacher enters marks for the papers
  the student took; earlier papers marked absent or the subject exempted (case 10) —
  school's academic call, both paths supported.

### 10. Subject exemption

- **Mechanism:** `student_subject_overrides (kind='exempted')`, session-scoped so it
  applies to every exam in the session automatically; per-exam nuance handled by
  `marks_entries.is_exempted` (single-exam exemption).
- **Computation:** exempted subject excluded from the student's `total_max` **and**
  `total_obtained` (percentage stays fair), excluded from completeness check at
  submit, excluded from fail-count. Report card prints `EX` in that subject.

### 11. Grace marks

- **Mechanism:** dedicated `grace_marks` column (never mixed into raw components),
  capped by school setting (`schools.exam_grace_marks_cap`, default 5), included in the
  generated `total_marks`. Grant-time guard: only during `pending`/`rejected` states by
  the assigned teacher, or by PR at approval time (`approve_marks` accepts an optional
  grace-adjustments array — the common "principal lifts borderline students" flow).
- **Transparency:** report card can render `78 (+2)` or plain `80` — school template
  flag; the audit log always has the split regardless of display choice.

### 12. Optional subjects

- **Mechanism:** `exam_subjects.is_optional = true` + `student_subject_overrides
  (kind='optional_selected')` defines the taker set.
- **Computation:** non-takers: subject entirely absent from their result (not a zero,
  not an `AB`). Takers: counted per school policy flag on the exam type —
  `optional_counts_in_total` (CBSE-style "best of" rules are a Phase-7 computation
  setting, schema already carries what's needed).
- **Completeness:** `submit_marks` expects marks only for the taker set.

---

## 8.2 Operational failure modes (beyond the specified list)

### F1. Concurrent autosave races (one teacher, two tabs)
Upsert on the unique key + `updated_at` in the response; the grid discards responses
older than the cell's last local edit. Worst case: last write wins, both audited.

### F2. Publish fails halfway
`publish_exam` is a single transaction (status flip + enrollments + notification
enqueue) — it either completes or the exam stays `draft` with the exception surfaced.
WA sending itself is *already* async (outbox pattern) so a WhatsApp outage can never
half-publish an exam.

### F3. WhatsApp quota exhausted mid-batch
Existing outbox worker behavior: messages stay queued (`wa_outbox.status`), quota
resets monthly, retry worker drains. Result publication is **not** blocked — the portal
and public page are live even when messages wait. Publish dialog shows quota headroom
("298 to send, 120 quota left this month") before confirming.

### F4. Result published, then error discovered
`unpublish_results` (hides portal/public immediately) → `reopen_marks` (reason) →
correct → re-chain → recompute → re-publish. Already-delivered WhatsApp PDFs cannot be
recalled: the re-publish template says "revised result issued"; report-card regeneration
bumps `version` and old QR tokens keep verifying but respond "superseded by v2"
(verification payload carries version status).

### F5. Session locked while an exam is mid-flight
`lock_academic_session` refuses while any exam in the session is `published/ongoing/
completed` but not `locked/cancelled` — listing the blockers. Lock order is enforced:
exams first, then the session.

### F6. Grade scale edited after results computed
Bands of a scale referenced by any `exam_results` row are immutable
(`RESTRICT` on delete per §3.4 #40 + update-guard trigger on `grade_bands`).
Changing grading mid-year = create new scale version, select it on the next exam;
past results keep their scale.

### F7. Class or section restructured mid-session
`exam_subjects.class_id` / `exam_enrollments.class_id` are `RESTRICT` — classes with
exam history cannot be deleted. Students moved between sections: past enrollments keep
the class they actually sat in (historically correct); the next exam enrolls them under
the new class. Report cards always print the class from the enrollment, not the current
student row.

### F8. Storage upload succeeded, row insert failed (question papers)
Upload RPC order: insert version row first (transaction), then client uploads to the
returned storage path; a failed upload leaves a version row with no object — flagged in
UI as "upload incomplete, re-upload", and re-upload targets the same path. No orphan
objects; orphan rows are harmless and re-usable.

### F9. QR token leakage
Tokens are UUIDv4 (122 bits, unguessable), verify endpoints return minimal payloads and
are rate-limited; a leaked admit-card token exposes name/roll/photo at the gate scanner
only to **authenticated staff** (verify RPC requires session); the public report-card
verify returns the verdict card only. Revocation (`is_revoked`) kills a token instantly.

### F10. Clock skew on exam-day scans
`record_exam_attendance_scan` computes late from **DB time** (`now() AT TIME ZONE`
school tz), never the device clock — a mis-set tablet cannot mark everyone late.

---

## 8.3 Spec deltas introduced by this step

Two small additions folded back into the Step 2 schema (will appear in Step 10 DDL):

1. `exam_subjects.is_cancelled boolean NOT NULL DEFAULT false` — partial cancellation
   (case 2).
2. `schools.exam_grace_marks_cap numeric(4,1) NOT NULL DEFAULT 5` — grace cap
   (case 11), following the existing per-school settings-column pattern
   (`late_fee_waiver_max_pct` precedent).
3. Report-card verification payload gains `version_status: current | superseded` (F4).

---

*Next: Step 9 — Security design (threat model, full RLS policy matrix per table,
RPC guard specifications, storage policies, audit coverage map, rate limiting).*
