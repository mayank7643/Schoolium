# Exam Module — Steps 6+7: Folder Structure & UI Design

Companion to Steps 1–5. The page tree and the screen list are one decision, so these two
steps ship together. Conventions verified against the live codebase: pages are client
components under `app/(dashboard)/dashboard/<module>/`, components co-located in page
folders (shared ones only when reused across 3+ pages), sidebar `ROLE_NAV` mirrors
middleware `ROLE_ALLOW`, lucide icons, slate + `brand-*` Tailwind palette.

---

## Step 6 — Folder structure

```
app/
├─ (dashboard)/dashboard/
│  ├─ exams/                                # ADMIN / PRINCIPAL console
│  │  ├─ page.tsx                           # Exam list + KPIs (Phase 1)
│  │  ├─ sessions/page.tsx                  # Academic sessions & terms (Phase 1)
│  │  ├─ settings/page.tsx                  # Exam types · grade scales · rooms ·
│  │  │                                     #   holidays · admit-card templates (Ph 1/2/7)
│  │  ├─ new/page.tsx                       # Create-exam wizard → draft (Phase 1)
│  │  ├─ print-admit-cards/page.tsx         # Standalone front-desk print/reprint
│  │  │                                     #   (receptionist-reachable) (Phase 3)
│  │  ├─ analytics/page.tsx                 # School performance dashboard (Phase 9)
│  │  └─ [examId]/
│  │     ├─ page.tsx                        # Exam cockpit: status + lifecycle checklist
│  │     ├─ configure/page.tsx              # Classes + subjects + marks scheme (draft only)
│  │     ├─ timetable/page.tsx              # Editor + validator + calendar (Phase 2)
│  │     ├─ enrollments/page.tsx            # Rolls, rooms/seats, overrides (Phase 1)
│  │     ├─ admit-cards/page.tsx            # Generate / bulk print (Phase 3)
│  │     ├─ question-papers/page.tsx        # Papers status board (Phase 4)
│  │     ├─ attendance/page.tsx             # Paper × class matrix (Phase 5)
│  │     ├─ marks/page.tsx                  # Submission progress board (Phase 6)
│  │     ├─ marks/[examSubjectId]/page.tsx  # Review / verify / approve detail (Phase 6)
│  │     ├─ results/page.tsx                # Compute · ranks · publish controls (Ph 7/8)
│  │     └─ report-cards/page.tsx           # Generate · remarks status · download (Ph 7)
│  ├─ my-exams/                             # TEACHER workspace
│  │  ├─ page.tsx                           # My papers: entry queue, deadlines,
│  │  │                                     #   verification queue (CT), invigilation
│  │  ├─ marks/[examSubjectId]/page.tsx     # Marks entry grid, autosave (Phase 6)
│  │  ├─ verify/[examSubjectId]/page.tsx    # Class-teacher verification (Phase 6)
│  │  ├─ question-papers/page.tsx           # Upload/manage own papers (Phase 4)
│  │  └─ attendance/[examSubjectId]/page.tsx# QR scan + manual roll (Phase 5)
│  └─ students/[id]/page.tsx                # EXTENDED: exam history + report cards tab
├─ results/[school_id]/page.tsx             # PUBLIC result check (Phase 8)
├─ verify/report-card/[token]/page.tsx      # PUBLIC QR verification (Phase 8)
├─ api/exams/
│  ├─ admit-cards-pdf/route.ts              # (contracts: Step 5 §5.3)
│  ├─ report-cards-pdf/route.ts
│  ├─ report-pdf/route.ts
│  └─ ai-analysis/route.ts
└─ lib/
   ├─ admitCardPdf.tsx                      # N-up A4 layouts
   ├─ reportCardPdf.tsx                     # renders from snapshot JSONB
   ├─ examReportPdf.tsx                     # tabular analytics reports
   └─ grading.ts                            # shared % / grade-band lookup (UI preview only;
                                            #   DB is authoritative)
components/
└─ exams/                                   # shared across 3+ pages — otherwise co-locate
   ├─ ExamStatusBadge.tsx                   # exam + submission status pills
   ├─ MarksGrid.tsx                         # keyboard-first grid (entry + review modes)
   ├─ ExamCalendarGrid.tsx                  # timetable calendar (editor + read-only)
   └─ charts/                               # Recharts wrappers (Phase 9)
      ├─ SubjectPerformanceChart.tsx
      ├─ ProgressTrendChart.tsx
      ├─ GradeDistributionChart.tsx
      └─ ClassComparisonChart.tsx
types/exams.ts                              # re-exported from types/index.ts
supabase/functions/generate-report-analysis/# AI edge function (Phase 10)
Migration sql/chat21…chat25_exam_*.sql      # per Step 2 packaging
docs/exam-module/                           # this design set
```

**Dependency note:** the entire module adds **one** npm package — `recharts` (Phase 9
charts). PDF (`@react-pdf/renderer`), QR generation (`qrcode`) and QR scanning
(`html5-qrcode`) already exist.

### Navigation & gating changes (the two maps that must move together)

`middleware.ts → ROLE_ALLOW`:

```ts
teacher:      [...existing, '/dashboard/my-exams'],
receptionist: [...existing, '/dashboard/exams/print-admit-cards'],  // exact-prefix carve-out
// principal/school_admin: pass-through as today (full /dashboard/exams)
```

`Sidebar.tsx`: add `Exams` (`GraduationCap` icon) → `/dashboard/exams` for
admin/principal; `My Exams` → `/dashboard/my-exams` for teacher (next to existing
My Classes); receptionist sees `Admit Cards` → the print page. Mobile bottom nav gets the
same items via the existing role-filtered mechanism.

Public pages live **outside** `(dashboard)` — no session, `robots: noindex`, school
branding fetched via the anon RPCs only.

---

## Step 7 — UI design (screen by screen)

### Design language (inherited, not reinvented)

Cards `bg-white rounded-xl border border-slate-100`; tables with sticky headers +
`text-sm`; lucide 17px icons; existing toast/banner error pattern showing
`error.message`; skeleton `loading.tsx` per route group; every list gets an empty state
with a primary CTA. **Status pill palette** (used consistently across the module):

| Status | Pill |
|---|---|
| draft / pending | slate |
| published / submitted | blue |
| ongoing | amber (pulse dot) |
| completed / verified | emerald |
| approved | indigo |
| locked / frozen | purple + lock icon |
| cancelled / rejected | red |

### 7.1 `exams` — Exam list (landing)

KPI row (current session): ongoing exams · papers awaiting verification · results due to
publish · upcoming papers this week. Filter bar: session picker (defaults to current) +
status tabs. Table: name, type, term, classes count, date range, status pill, progress
meter (papers frozen / total). Row → cockpit. Primary CTA **New Exam**; secondary link
to Sessions when no active session exists (first-run funnel).

### 7.2 `exams/sessions`

Two-panel: sessions list (status, current-star, date range) + terms editor for the
selected session. Actions surface the RPCs: set current, lock (confirm dialog spelling
out consequences), archive. Creating the first session triggers exam-type + CBSE
grade-scale seeding — surfaced as a success note, not a form.

### 7.3 `exams/settings` (tabs)

**Exam types** (name/code/category, deactivate) · **Grade scales** (bands editor with
live preview bar showing 0–100 coverage; gaps/overlaps flagged inline before the DB
constraint ever fires) · **Rooms** (name/capacity) · **Holidays** (date list + session
picker) · **Admit-card template** (layout default, instructions, signature upload,
show-flags, live A4 preview).

### 7.4 `exams/new` — 3-step wizard (all steps = one draft exam)

1. Basics: name, type, term, tentative window.
2. Classes: checkbox grid of class-sections.
3. Subjects per class: matrix editor — rows = subjects, columns = theory/practical/
   internal max, pass marks, weightage, optional-flag; **copy-to-all-classes** action
   (the manual-work killer for 12-section schools).
Finish → draft cockpit. Everything editable later while draft.

### 7.5 `exams/[examId]` — the cockpit (automation home)

Header: name, status pill, date range, action button per state machine
(Publish / Start / Complete / Lock / Cancel — each disabled with tooltip reason when
preconditions fail; Publish shows validator issues inline before attempting).
Body: **lifecycle checklist** — Configure ✓ → Timetable (2 warnings) → Published →
Admit cards 312/312 → Question papers 8/24 → Attendance (live during exam) →
Marks 14/24 frozen → Results computed → Published. Each item deep-links to its page.
This one screen answers "what's left to do" for the whole exam.

### 7.6 `exams/[examId]/timetable`

Split view: left = paper list grouped by class (date/time/duration/room editors inline);
right = calendar grid (`ExamCalendarGrid`) with papers as blocks, holidays shaded.
Toolbar: **Auto-generate** (dialog: window, gap days, default time/duration, overwrite
toggle) · **Validate** → issue panel listing errors (red, block publish) and warnings
(amber, dismissible). Editing locked from `ongoing` (banner explains).

### 7.7 `exams/[examId]/enrollments`

Class tabs → student table: roll (auto), name, photo, status (enrolled/exempted/
withdrawn/transferred), room/seat, per-subject override chips. Actions:
re-run enrollment (late admissions — appends rolls), set overrides, assign rooms/seats
in bulk (auto-seating button reserved, disabled with "coming soon" — schema ready).

### 7.8 `exams/[examId]/admit-cards` + `exams/print-admit-cards`

Generate panel (template, class scope) → per-class card counts + revoked count.
Print panel: layout picker (1/2/3/4-up) with thumbnail previews, class multi-select,
**Download PDF** per class (≤500/request per Step 5). Front-desk page
(`print-admit-cards`) is the same print panel standalone: search student → reprint
single card (increments `print_count`, shows reprint history).

### 7.9 Question papers — two views

Admin board (`exams/[examId]/question-papers`): paper × class matrix of status chips
(none/draft vN/final), lock buttons, access-log drawer per paper (who viewed/downloaded
when). Teacher page (`my-exams/question-papers`): only own assigned papers; upload
(drag-drop, PDF ≤ bucket cap), version history list, "final" state clearly marked
read-only.

### 7.10 Exam attendance

Teacher (`my-exams/attendance/[examSubjectId]`): toggle **Scan QR** (html5-qrcode camera
view → on scan shows photo + name + roll large for visual verification, auto-marks
present/late, sound cue) / **Manual roll** (P/A/M/L quick-tap rows, same grid layout as
existing class attendance). Admin matrix (`exams/[examId]/attendance`): papers × status
counts, drill into any paper, export via report-pdf.

### 7.11 Marks entry (`my-exams/marks/[examSubjectId]`) — the most-used screen

`MarksGrid`: sticky student column (photo, roll, name); columns theory/practical/internal
(only those with max > 0), grace (permission-gated), absent/exempt toggles.
**Keyboard-first**: Enter/arrows move cells, type-through numbers.
**Autosave**: 800 ms debounce → `save_marks_bulk`; per-row saved tick / red outline +
tooltip for rejected rows (server reason verbatim). Header: progress `38/42 entered`,
attendance cross-check chip (`3 absent in room — 1 missing here`), **Submit for
verification** CTA → preflight dialog listing gaps before calling `submit_marks`.
Read-only mode (post-submit) is the same grid with a status banner — teachers always see
what they submitted.

### 7.12 Verification & approval

CT (`my-exams/verify/[examSubjectId]`): read-only grid + distribution sparkline +
outlier flags (>95 / <5 / all-same) to make eyeballing effective. Verify ✓ or Reject
with mandatory reason. PR (`exams/[examId]/marks`): board of all papers by submission
status with aging (submitted 2d ago); bulk-approve verified papers; freeze-all when
everything approved; reopen (frozen paper → dialog: reason, consequences: results
invalidated). Every action lands in the audit drawer (right panel, per paper:
timeline of submit/verify/approve/freeze/reopen + marks edits with old→new).

### 7.13 Results & publishing (`exams/[examId]/results`)

Step rail: **Compute** (disabled until all frozen; shows blocking papers) → results
table per class (total, %, grade, rank, pass/fail pill; withheld/absent flagged) →
**Report cards** (generate; CT-remarks completion meter; sample preview) → **Publish
panel**: Publish now / Schedule (datetime, IST) / Unpublish / Lock — each with the
notification consequence spelled out ("298 WhatsApp messages will be enqueued").

### 7.14 Report cards (`exams/[examId]/report-cards` + student profile tab)

Class grid of generated cards: student, remarks status, version, download, regenerate
(new version, audited). Student profile (`students/[id]`) gains an **Exams** tab:
exam history, results, report-card downloads, AI analysis panel (Phase 10 — summary,
strengths/weaknesses chips, trend chart, suggestions accordion).

### 7.15 Analytics (`exams/analytics`) — Phase 9

Session-scoped dashboard: school KPI tiles (avg %, pass %, exams conducted) ·
`ClassComparisonChart` (avg by class, exam-over-exam) · `SubjectPerformanceChart`
(weakest subjects surfaced) · top performers table · grade distribution ·
teacher performance (avg class result per subject teacher — framed as "subject outcomes",
PR/SA only). Every chart has a **PDF** export via report-pdf route.

### 7.16 Public pages

`/results/[school_id]`: school logo/name header, exam picker (anon RPC), roll + DOB
form, result card (subjects table, %, grade, pass pill) with **Print** (browser print
stylesheet — authenticated users get the PDF; public gets print view), rate-limit error
state with retry-after. `/verify/report-card/[token]`: single verdict card — VALID
(emerald, student/exam/%/generated-at) / REVOKED / NOT FOUND (red) — deliberately
minimal, it verifies rather than discloses.

### 7.17 Existing dashboards — additive widgets only

`PrincipalDashboard`: "Ongoing exams" card + "Awaiting your approval" count →
deep links. Teacher home (`my-exams` doubles as it): deadline list ("Maths 7B marks due
in 2 days"). No existing widget is modified — cards are appended, matching the
chat17/18 additive pattern.

---

*Next: Step 8 — Edge cases (end-to-end resolution walkthroughs for all 12 identified
cases, plus failure modes: concurrent edits, partial publishes, quota exhaustion).*
