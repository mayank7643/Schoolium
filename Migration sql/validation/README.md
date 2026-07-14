# Migration validation harness

Validates exam-module migrations against a real local PostgreSQL 16 before they touch
Supabase. The shim stands in for Supabase-managed schemas (`auth`, `storage`, `cron`)
and roles (`authenticated`, `anon`, `service_role`).

## How to run

```bash
# 1. Start a scratch cluster (any local PG16 works)
initdb -D /tmp/pgv/data -U postgres --auth=trust
pg_ctl -D /tmp/pgv/data -o '-p 54329 -k /tmp/pgv -c listen_addresses=' start
export PGHOST=/tmp/pgv PGPORT=54329 PGUSER=postgres PGDATABASE=postgres

# 2. Shim + dependencies
psql -v ON_ERROR_STOP=1 -f "Migration sql/validation/00_supabase_shim.sql"
psql -v ON_ERROR_STOP=1 -f "Migration sql/chat02_schoolium_initial_schema.sql"
PGOPTIONS="-c check_function_bodies=off" \
  psql -v ON_ERROR_STOP=1 -f "Migration sql/chat17_staff_management_full_consolidated.sql"
psql -v ON_ERROR_STOP=1 -f "Migration sql/validation/01_baseline_patch.sql"
psql -c "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
         GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;
         ALTER DEFAULT PRIVILEGES IN SCHEMA public
           GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;"

# 3. Migration under test (run twice - second run proves idempotency)
#    Exam-module migrations live in supabase/migrations/ (Supabase GitHub
#    integration format); older chats remain in "Migration sql/" as archive.
psql -v ON_ERROR_STOP=1 -f "supabase/migrations/20260708120000_exam_sessions_core.sql"
psql -v ON_ERROR_STOP=1 -f "supabase/migrations/20260708120000_exam_sessions_core.sql"

# 4. Smoke tests (self-contained, rolls itself back)
psql -f "Migration sql/validation/chat21_smoke_tests.sql"

# 5. Phase 2 (exam_logistics): apply + smoke
psql -v ON_ERROR_STOP=1 -f "supabase/migrations/20260711090000_exam_logistics.sql"
psql -f "Migration sql/validation/exam_logistics_smoke_tests.sql"

# 6. Phase 3 (exam_admit_cards): apply + smoke
psql -v ON_ERROR_STOP=1 -f "supabase/migrations/20260711110000_exam_admit_cards.sql"
psql -f "Migration sql/validation/exam_admit_cards_smoke_tests.sql"

# 7. Phase 4 (exam_question_papers): apply + smoke
psql -v ON_ERROR_STOP=1 -f "supabase/migrations/20260711120000_exam_question_papers.sql"
psql -f "Migration sql/validation/exam_question_papers_smoke_tests.sql"

# 8. Phase 5 (exam_attendance): apply + smoke
psql -v ON_ERROR_STOP=1 -f "supabase/migrations/20260711130000_exam_attendance.sql"
psql -f "Migration sql/validation/exam_attendance_smoke_tests.sql"

# 9. Phase 6 (exam_marks): apply + smoke
psql -v ON_ERROR_STOP=1 -f "supabase/migrations/20260711140000_exam_marks.sql"
psql -f "Migration sql/validation/exam_marks_smoke_tests.sql"

# 10. Phase 7 (exam_results): apply + smoke
psql -v ON_ERROR_STOP=1 -f "supabase/migrations/20260711150000_exam_results.sql"
psql -f "Migration sql/validation/exam_results_smoke_tests.sql"

# 11. Phase 8 (exam_publishing): apply + smoke
psql -v ON_ERROR_STOP=1 -f "supabase/migrations/20260711160000_exam_publishing.sql"
psql -f "Migration sql/validation/exam_publishing_smoke_tests.sql"
```

Every `T*` line must print its expected value and every `DO` block must print
`... : OK`; the script aborts on the first failure. `chat17` needs
`check_function_bodies=off` because two of its functions reference fee-module tables
from chats 11-16 that the harness does not install.

## chat21 coverage (T1-T12)

session create/seed/current - term window+overlap - exam config - timetable validator
(clean + CLASS_OVERLAP) - publish (enrollments, roll numbers, denormalized dates) -
post-publish guards (RPC + direct-write trigger) - schedule-only edits - late-admission
roll append - overrides - TC transfer - partial paper cancellation - full lifecycle to
locked - locked-exam and locked-session write blocks - unlock with reason - draft
delete - teacher RLS (sees exams, no enrollments, no config writes, no create_exam) -
audit-log action coverage.
