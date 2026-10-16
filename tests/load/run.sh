#!/usr/bin/env bash
# From repo root: tests/load/run.sh
# Requires Node >=24, Docker and the running compose stack. Owns its compose agent
# while running; refuses to replace an existing agent. Uses grafana/k6:0.57.0.
# If docker pull fails with EOF, import that image using skopeo as below:
# work=$(mktemp -d); docker run --rm -v "$work:/out" node:24-alpine sh -ec \
#   'apk add -q skopeo; skopeo --override-arch arm64 copy docker://docker.io/grafana/k6:0.57.0 docker-archive:/out/k6.tar:grafana/k6:0.57.0'
# docker load -i "$work/k6.tar"; rm -rf "$work"
set -euo pipefail
cd "$(dirname "$0")/../.."
export POSTGRES_PORT="${POSTGRES_PORT:-55433}"
exec node tests/load/run.mjs
