#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/common.sh"
require_disposable_worker || exit 78
while read -r id; do
  [[ "$id" =~ ^[a-f0-9]{64}$ ]] || exit 78
  [[ "$(docker inspect --format '{{index .Config.Labels "gromesh.j5.run"}}' "$id")" == "$GROMESH_CI_RUN" ]] || exit 78
  docker rm -f "$id"
done < <(docker ps -a --no-trunc --filter "label=gromesh.j5.run=$GROMESH_CI_RUN" --format '{{.ID}}')
