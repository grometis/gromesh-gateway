#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/common.sh"
require_disposable_worker || exit 78
ids=()
owned() {
  local labels run project
  labels="$(docker inspect --format '{{index .Config.Labels "gromesh.j5.run"}}|{{index .Config.Labels "com.docker.compose.project"}}' "$1")" || return 78
  IFS='|' read -r run project <<< "$labels"
  [[ "$run" == "$GROMESH_CI_RUN" || "$project" == "gromesh-test-${GROMESH_CI_RUN}" ]]
}
for filter in "label=gromesh.j5.run=$GROMESH_CI_RUN" "label=com.docker.compose.project=gromesh-test-${GROMESH_CI_RUN}"; do
rows="$(docker ps -a --no-trunc --filter "$filter" --format '{{.ID}}')"
while read -r id; do
  [[ -n "$id" ]] || continue
  [[ "$id" =~ ^[a-f0-9]{64}$ ]] || exit 78
  owned "$id" || exit 78
  [[ " ${ids[*]:-} " == *" $id "* ]] || ids+=("$id")
done <<< "$rows"
done
if ((${#ids[@]})); then
 docker stop --time 10 "${ids[@]}"
 for id in "${ids[@]}"; do owned "$id" || exit 78; docker rm "$id"; done
fi
