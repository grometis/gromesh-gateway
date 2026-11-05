#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/checks-start.sh"
pg_dump --version | grep -E '^pg_dump \(PostgreSQL\) 16\.'
psql --version | grep -E '^psql \(PostgreSQL\) 16\.'
export MIGRATION_REGRESSION=1 MIGRATION_SCALE=500
pnpm --filter '@gromesh/control-plane^...' build
cd apps/control-plane
pnpm exec vitest run --config vitest.config.ts --project integration test/integration/migration-regression.test.ts test/integration/workspaces-migration.test.ts
