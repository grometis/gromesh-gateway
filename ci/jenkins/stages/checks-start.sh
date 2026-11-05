#!/usr/bin/env bash
# Sourced by integration stages; only temporary test credentials, never Jenkins or registry credentials.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
require_disposable_worker || exit 78
umask 077
mkdir -p "$GROMESH_CI_STATE"
if [[ ! -f "$GROMESH_CI_STATE/checks.env" ]]; then
  pg="$(openssl rand -hex 24)"; ch="$(openssl rand -hex 24)"
  printf 'export TEST_DATABASE_URL=%q\n' "postgres://gromesh:${pg}@127.0.0.1:5432/gromesh" > "$GROMESH_CI_STATE/checks.env"
  printf 'export TEST_CLICKHOUSE_URL=%q TEST_CLICKHOUSE_ADMIN_USER=gromesh TEST_CLICKHOUSE_ADMIN_PASSWORD=%q KONG_VALIDATOR_URL=%q\n' http://127.0.0.1:8123 "$ch" http://127.0.0.1:8011 >> "$GROMESH_CI_STATE/checks.env"
  export POSTGRES_PASSWORD="$pg" CLICKHOUSE_PASSWORD="$ch"
  printf '%s\n' "$pg" "$ch" >> "$GROMESH_CI_STATE/redactions.txt"
  docker run -d --name "gromesh-j5-${GROMESH_CI_RUN}-postgres" --label "gromesh.j5.run=$GROMESH_CI_RUN" --memory=512m --cpus=1 \
    --tmpfs /var/lib/postgresql/data:rw,size=512m -p 127.0.0.1:5432:5432 -e POSTGRES_USER=gromesh -e POSTGRES_DB=gromesh -e POSTGRES_PASSWORD \
    postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea
  docker run -d --name "gromesh-j5-${GROMESH_CI_RUN}-clickhouse" --label "gromesh.j5.run=$GROMESH_CI_RUN" --memory=2g --cpus=2 \
    --tmpfs /var/lib/clickhouse:rw,size=1g -p 127.0.0.1:8123:8123 -e CLICKHOUSE_USER=gromesh -e CLICKHOUSE_DB=gromesh -e CLICKHOUSE_PASSWORD -e CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 \
    clickhouse/clickhouse-server:25.8.33.6-alpine@sha256:87e0a5b72f5465b18eacca7c76850e7ff551c9795c50e451f5646299e5e24146
  read -r kong_ref _ < <(node scripts/kong-image-ref.mjs)
  [[ "$kong_ref" =~ ^ghcr.io/grometis/gromesh-kong@sha256:[a-f0-9]{64}$ ]] || exit 78
  docker run -d --name "gromesh-j5-${GROMESH_CI_RUN}-validator" --label "gromesh.j5.run=$GROMESH_CI_RUN" --memory=512m --cpus=1 \
    -p 127.0.0.1:8011:8001 -e KONG_DATABASE=off -e KONG_ADMIN_LISTEN=0.0.0.0:8001 -e KONG_PLUGINS=bundled "$kong_ref"
fi
source "$GROMESH_CI_STATE/checks.env"
ready=false
for _ in $(seq 1 60); do
  if docker exec "gromesh-j5-${GROMESH_CI_RUN}-postgres" pg_isready -U gromesh >/dev/null 2>&1 \
     && curl -fsS http://127.0.0.1:8123/ping >/dev/null \
     && docker exec "gromesh-j5-${GROMESH_CI_RUN}-validator" kong health >/dev/null 2>&1; then ready=true; break; fi
  sleep 2
done
[[ "$ready" == true ]]
