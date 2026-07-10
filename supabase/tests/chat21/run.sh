#!/bin/bash
# Local PG16 validation for chat21_alerts_byog_foundation.sql
# (standing rule: every migration validated on local PG16 with
# Supabase stubs + functional and exploit tests before delivery).
#
# Requires a local PostgreSQL 16 cluster and a 'postgres' superuser.
# Run:  bash supabase/tests/chat21/run.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
MIG="$REPO_ROOT/Migration sql/chat21_alerts_byog_foundation.sql"
DB="schoolium_chat21_test"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cp "$HERE/00_baseline.sql" "$WORK/00_baseline.sql"
cp "$MIG"                  "$WORK/10_migration.sql"
cp "$HERE/20_setup.sql"    "$WORK/20_setup.sql"
cp "$HERE/30_tests.sql"    "$WORK/30_tests.sql"
cp "$HERE/40_exploits.sql" "$WORK/40_exploits.sql"
chmod -R a+rX "$WORK"

sudo -u postgres dropdb --if-exists "$DB"
sudo -u postgres createdb "$DB"

for f in 00_baseline.sql 10_migration.sql 20_setup.sql 30_tests.sql 40_exploits.sql; do
  echo "==== $f ===="
  sudo -u postgres psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$WORK/$f"
done

# Idempotency: the migration must re-apply cleanly.
echo "==== re-run migration (idempotency) ===="
sudo -u postgres psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$WORK/10_migration.sql" > /dev/null

echo "ALL GREEN"
