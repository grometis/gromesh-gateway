#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/common.sh"
compose_environment
[[ "${KONG_IMAGE:-}" =~ ^gromesh-ci-kong:sha-[a-f0-9]{40}$ ]] || exit 78
trap 'docker compose --profile "*" down' EXIT
pnpm install --frozen-lockfile --child-concurrency=1 --network-concurrency=2
docker compose --profile '*' pull --ignore-buildable --policy missing
docker compose --profile '*' build
node scripts/compose.mjs up -d --wait
docker compose --profile observability up -d --wait clickhouse
docker compose --profile observability run --rm --no-deps clickhouse-init
docker compose --profile observability up -d --wait --no-deps vector
node e2e/clickhouse-readiness.mjs
node scripts/smoke.mjs
