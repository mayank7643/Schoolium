# Supabase ↔ GitHub integration — setup guide

How Schoolium's database migrations reach production automatically, and how to
reconnect the integration correctly after it was removed.

## How it works (read once)

- The Supabase **GitHub integration** watches your repo. When you **merge into the
  production branch**, Supabase looks in **`supabase/migrations/`** and runs any
  timestamped `.sql` file it has not run before (tracked in the
  `supabase_migrations.schema_migrations` table in your database).
- It applies files in **filename order** (that's why the timestamp prefix matters).
- It does **not** look anywhere else. Files in `Migration sql/` are **never**
  auto-applied — that folder is the historical archive (chat02–chat20) plus the
  alerts feature's migration, all of which were run by hand.

## Repo facts (verified 2026-07-13)

- Default / production branch: **`Preview`** (NOT `main`).
- Auto-deployable migrations already in place: the 7 exam-module files in
  `supabase/migrations/` (`20260708120000_exam_sessions_core.sql` …
  `20260711150000_exam_results.sql`).
- Every exam migration is **idempotent** (`IF NOT EXISTS` / `CREATE OR REPLACE` /
  `DROP POLICY IF EXISTS`), so applying one that was already run by hand is a safe
  no-op — it will not error or duplicate anything.
- `Migration sql/chat21_alerts_byog_foundation.sql` (the alerts feature) is **not**
  in `supabase/migrations/`, so the integration will not deploy it. See "Alerts
  migration" below.

## Step-by-step: reconnect the integration

1. Supabase dashboard → your project (**Schoolium**, the `PRODUCTION` one) →
   **Settings → Integrations → GitHub → Connect / Configure**.
2. **GitHub repository:** `mayank7643/Schoolium`.
3. **Working directory:** `.` (a single dot — the `supabase/` folder is at the repo
   root, so the working directory is the root).
4. **Deploy to production:** ON.
5. **Production branch name:** `Preview`  ← the important fix. It previously said
   `main`, which does not exist in this repo, so nothing deployed.
6. Save. Branching / preview databases stay OFF (they need the Pro plan; you don't
   need them because every migration is validated on a local PostgreSQL first).

## First deploy

After connecting, the integration deploys when you **merge a PR into `Preview`**.
On the first qualifying merge it will run any of the 7 exam migrations not yet in
your migration-history table:

- If you already ran them by hand in the SQL editor: they are idempotent, so the
  run is a clean no-op (it just records them in the history table).
- If you have not: they apply in timestamp order. They depend only on objects from
  chat02–chat20, which already exist in production, so they apply cleanly.

Nothing deploys on a plain push to a feature branch — only on a merge into
`Preview`.

## Verify it worked

In the SQL editor after the first deploy:

```sql
-- migrations Supabase has recorded as applied
select version, name from supabase_migrations.schema_migrations order by version;

-- exam tables present (expect 20+)
select count(*) from information_schema.tables
where table_schema = 'public' and table_name like 'exam%';
```

## Alerts migration (decision for the alerts author)

`Migration sql/chat21_alerts_byog_foundation.sql` will not auto-deploy from that
folder. Two options — the alerts author picks one:

1. **Keep running it by hand** in the SQL editor (status quo). Simplest.
2. **Move it into `supabase/migrations/` with a timestamp name**, e.g.
   `git mv "Migration sql/chat21_alerts_byog_foundation.sql" \
     supabase/migrations/20260706000000_alerts_byog_foundation.sql`
   Pick a timestamp EARLIER than the exam migrations only if alerts has no
   dependency on them (it doesn't — the two feature sets are independent), so
   ordering does not actually matter here. After moving, verify it is idempotent
   before the first auto-deploy; if it is not, running it against a database where
   it was already applied by hand will error.

The historical chat02–chat20 files should **stay** in `Migration sql/` — they are
already in production and re-running some of them is not safe. Do not move those.

## `supabase/config.toml`

The dashboard GitHub integration deploys migrations without needing `config.toml`.
You only need it if you later adopt the **Supabase CLI** (`supabase db push`,
local `supabase start`). If/when you do, add it with your project ref:

```toml
project_id = "jrhddsjcbrudpjxddhve"
```

Until then it is optional.

## Ongoing workflow (exam module)

1. New migration is authored directly in `supabase/migrations/` with a fresh
   timestamp, validated on local PG16 (see `Migration sql/validation/README.md`).
2. Pushed on the feature branch → PR → merge into `Preview`.
3. Supabase applies it to production automatically.
