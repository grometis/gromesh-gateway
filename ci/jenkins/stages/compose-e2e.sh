#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/common.sh"
compose_environment
trap 'docker compose --profile "*" down' EXIT
pnpm --filter @gromesh/e2e exec playwright install chromium
docker compose --profile '*' pull --ignore-buildable
docker compose --profile '*' build
node scripts/compose.mjs up -d --wait
docker compose --profile observability up -d --wait clickhouse
docker compose --profile observability run --rm --no-deps clickhouse-init
docker compose --profile observability up -d --wait --no-deps vector
node e2e/clickhouse-readiness.mjs
pnpm smoke
pnpm --filter @gromesh/control-plane test:e2e
pnpm test:e2e
