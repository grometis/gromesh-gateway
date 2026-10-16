#!/usr/bin/env bash
# From repo root: tests/load/agents/run.sh
# Requires Go >=1.24 and compose CP on localhost:3000; optional CP_URL and
# BOOTSTRAP_ADMIN_EMAIL/BOOTSTRAP_ADMIN_PASSWORD. Writes result.json on success.
# Creates/deletes its own environment and cluster; does not change compose agent.
set -euo pipefail
cd "$(dirname "$0")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
# Build first so signals reach the actual driver, whose defer cleans up via API.
# Isolate the build cache by default (also avoids stale system-toolchain cache).
GOCACHE="${GOCACHE:-$work/go-cache}" go build -o "$work/agents" .
"$work/agents" > "$work/result.json" &
child=$!
trap 'kill -TERM "$child" 2>/dev/null || true; wait "$child" || true; exit 130' INT TERM
wait "$child"
cp "$work/result.json" result.json
cat result.json
