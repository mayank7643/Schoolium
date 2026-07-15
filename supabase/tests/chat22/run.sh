#!/bin/bash
# Local PG16 validation for chat22_alerts_managed_mode.sql on top of
# the chat21 baseline. Requires a local PostgreSQL 16 cluster.
#   bash supabase/tests/chat22/run.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
C21="$REPO_ROOT/supabase/tests/chat21"
MIG21="$REPO_ROOT/Migration sql/chat21_alerts_byog_foundation.sql"
MIG22="$REPO_ROOT/Migration sql/chat22_alerts_managed_mode.sql"
DB="schoolium_chat22_test"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cp "$C21/00_baseline.sql" "$WORK/00_baseline.sql"
cp "$MIG21"              "$WORK/10_migration.sql"
cp "$C21/20_setup.sql"   "$WORK/20_setup.sql"
cp "$MIG22"              "$WORK/25_migration22.sql"
cp "$HERE/50_managed_mode.sql" "$WORK/50_managed_mode.sql"
chmod -R a+rX "$WORK"

sudo -u postgres dropdb --if-exists "$DB"
sudo -u postgres createdb "$DB"

for f in 00_baseline.sql 10_migration.sql 20_setup.sql 25_migration22.sql 50_managed_mode.sql; do
  echo "==== $f ===="
  sudo -u postgres psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$WORK/$f"
done

echo "==== re-run chat22 migration (idempotency) ===="
sudo -u postgres psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$WORK/25_migration22.sql" > /dev/null

echo "ALL GREEN"
