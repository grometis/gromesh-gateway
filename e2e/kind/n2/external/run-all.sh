#!/usr/bin/env bash
# The N2/N3 lab end to end on a dedicated Linux host, one suite at a time: host check, cluster, images built from the
# given git refs (labelled with their revision), N2-E1 environment, #173 components, F3 (fix, residual 4, negative
# control), collector sidecar, integrated v2. Each suite's results.json and log land in OUT; the cluster is removed at
# the end (LAB_KEEP=1 keeps it). Only LAB_KUBECONFIG is ever used; ~/.kube/config is refused by cluster.sh.
#   LAB_KUBECONFIG=<file> OUT=<dir> ADMISSION_REF=<ref> NEG_REF=<ref> V2_REF=<ref> [KONG_REF=<image@sha256:…>] \
#     [SUITES="env components f3 f3-residual4 f3-neg collector v2"] bash e2e/kind/n2/external/run-all.sh
#   ADMISSION_REF: main + the F3 fix (agent applies v1; what #173 and the F3 suite were written against).
#   NEG_REF:       the same without the F3 fix (F3 negative control).  V2_REF: main + the whole N3 minimal stack.
# Exits non-zero when any suite fails. Deletes only what this run created: an existing cluster is refused (never
# reused), and the cluster carries this run's id, checked again before it is deleted.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../../../.." && pwd)"
n2="$root/e2e/kind/n2"
# shellcheck source=../versions.env
source "$n2/versions.env"
: "${LAB_KUBECONFIG:?set LAB_KUBECONFIG to a lab-only kubeconfig file}"
: "${OUT:?set OUT to the evidence directory}" "${ADMISSION_REF:?}" "${NEG_REF:?}" "${V2_REF:?}"
KONG_REF="${KONG_REF:-$KONG_IMAGE_REF}"
[[ "$KONG_REF" =~ @sha256:[0-9a-f]{64}$ ]] || { echo "KONG_REF must be pinned by digest" >&2; exit 1; }
SUITES="${SUITES:-env components f3 f3-residual4 f3-neg collector v2}"
export LAB_KUBECONFIG
RUN_ID="run-$(date -u +%Y%m%dT%H%M%SZ)-$$"
owned=0 failed=0 work=""
built=() trees=()

# This run's cluster: absent before `up` and still carrying RUN_ID.
marker() { kubectl --kubeconfig "$LAB_KUBECONFIG" --context "kind-$CLUSTER_NAME" -n kube-system get configmap gromesh-lab-run \
  -o jsonpath='{.data.runId}' 2>/dev/null || true; }
cleanup() {
  local code=$? t id
  trap - EXIT
  for t in ${built[@]+"${built[@]}"}; do docker image rm "$t" >/dev/null 2>&1 || true; done
  for t in ${trees[@]+"${trees[@]}"}; do git -C "$root" worktree remove --force "$t" >/dev/null 2>&1 || true; done
  [[ -z "$work" ]] || rm -rf "$work"
  if (( owned )) && [[ "${LAB_KEEP:-}" != 1 ]]; then
    id="$(marker)"
    # Empty: `up` failed before the marker was written; the cluster did not exist before this run.
    if [[ -z "$id" || "$id" == "$RUN_ID" ]]; then bash "$n2/cluster.sh" down || code=1
    else echo "cluster $CLUSTER_NAME carries run id $id, not $RUN_ID: left alone" >&2; code=1; fi
  fi
  (( code != 0 || ! failed )) || code=1
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# Nothing is created before the host (and its local Docker daemon) passes.
bash "$here/host-check.sh"
mkdir -p "$OUT"
work="$(mktemp -d)"
load() { echo "$(date -u +%FT%TZ) $(cut -d' ' -f1-3 /proc/loadavg) $*" | tee -a "$OUT/load.txt"; }
load "host ready ($RUN_ID)"

if kind get clusters 2>/dev/null | grep -qx "$CLUSTER_NAME"; then
  echo "kind cluster $CLUSTER_NAME already exists: refusing to reuse or delete it (remove it yourself if it is a leftover)" >&2
  exit 1
fi
owned=1
bash "$n2/cluster.sh" up
kubectl --kubeconfig "$LAB_KUBECONFIG" --context "kind-$CLUSTER_NAME" -n kube-system create configmap gromesh-lab-run \
  --from-literal=runId="$RUN_ID" >/dev/null
load "cluster up"

# Builds the control plane and the agent (which ships the isolation probe) of one ref, labelled with its revision.
build() {
  local name="$1" ref="$2" rev tree
  rev="$(git -C "$root" rev-parse --verify "$ref^{commit}")"
  tree="$work/$name"
  trees+=("$tree")
  git -C "$root" worktree add --detach "$tree" "$rev" >/dev/null
  docker build -q -f "$tree/apps/control-plane/Dockerfile" --label "org.opencontainers.image.revision=$rev" -t "gromesh-lab-cp:$name-${rev:0:12}" "$tree" >/dev/null
  built+=("gromesh-lab-cp:$name-${rev:0:12}")
  docker build -q -f "$tree/apps/agent/Dockerfile" --label "org.opencontainers.image.revision=$rev" -t "gromesh-lab-agent:$name-${rev:0:12}" "$tree" >/dev/null
  built+=("gromesh-lab-agent:$name-${rev:0:12}")
  git -C "$root" worktree remove --force "$tree"
  printf -v "CP_$name" '%s' "gromesh-lab-cp:$name-${rev:0:12}"
  printf -v "AGENT_$name" '%s' "gromesh-lab-agent:$name-${rev:0:12}"
  printf -v "REV_$name" '%s' "$rev"
}

build admission "$ADMISSION_REF"
build neg "$NEG_REF"
build v2 "$V2_REF"
docker pull -q "$KONG_REF" >/dev/null
KONG_IMAGE="gromesh-lab-kong:${KONG_REF##*@sha256:}"; KONG_IMAGE="${KONG_IMAGE:0:31}"
docker tag "$KONG_REF" "$KONG_IMAGE"
built+=("$KONG_IMAGE")
# By digest, never whatever postgres:16-alpine the host already has; re-tagged locally because the suites run it with
# imagePullPolicy Never and kind loads images by name.
docker pull -q "$PG_IMAGE" >/dev/null
PG_LOCAL="gromesh-lab-pg:${PG_IMAGE##*@sha256:}"; PG_LOCAL="${PG_LOCAL:0:28}"
docker tag "$PG_IMAGE" "$PG_LOCAL"
built+=("$PG_LOCAL")
for image in "${built[@]}"; do kind load docker-image --name "$CLUSTER_NAME" "$image" >/dev/null; done
# What actually ran: each image by id, repo digests and source revision (ClickHouse, Vector and the fixtures are
# pulled by digest inside the cluster).
for image in "$KONG_REF" "$PG_IMAGE" "${built[@]}" "$CLICKHOUSE_IMAGE" "$VECTOR_IMAGE" "$FIXTURE_IMAGE"; do
  docker image inspect -f "$image {{.Id}} {{join .RepoDigests \",\"}} {{index .Config.Labels \"org.opencontainers.image.revision\"}}" "$image" 2>/dev/null \
    || echo "$image (pinned by digest, pulled in the cluster)"
done >"$OUT/images.txt"
load "images loaded"

# One suite: its own OUT subdirectory, the load before and after (a run under saturation is not evidence).
suite() {
  local name="$1" rc=0; shift
  mkdir -p "$OUT/$name"
  load "$name start"
  env LAB_OUT="$OUT/$name" KONG_IMAGE="$KONG_IMAGE" PG_IMAGE="$PG_LOCAL" "$@" >"$OUT/$name/run.log" 2>&1 || rc=$?
  if (( rc == 0 )); then echo "$name: pass" | tee -a "$OUT/summary.txt"
  else echo "$name: FAIL (exit $rc; see $name/run.log)" | tee -a "$OUT/summary.txt"; failed=1; fi
  load "$name end"
}

for s in $SUITES; do
  case "$s" in
    env) suite env node "$n2/run.mjs" ;;
    components) suite components CP_IMAGE="$CP_admission" AGENT_IMAGE="$AGENT_admission" CP_REV="$REV_admission" AGENT_REV="$REV_admission" node "$n2/components/run.mjs" ;;
    f3) suite f3 CP_IMAGE="$CP_admission" AGENT_IMAGE="$AGENT_admission" CP_REV="$REV_admission" AGENT_REV="$REV_admission" node "$n2/components/f3.mjs" ;;
    f3-residual4) suite f3-residual4 RESIDUAL=4 LAB_STEPS=coldStart,secondPod,residualHeld CP_IMAGE="$CP_admission" AGENT_IMAGE="$AGENT_admission" node "$n2/components/f3.mjs" ;;
    f3-neg) suite f3-neg LAB_PHASE=neg CP_IMAGE="$CP_admission" AGENT_IMAGE="$AGENT_neg" CP_REV="$REV_admission" AGENT_REV="$REV_neg" node "$n2/components/f3.mjs" ;;
    collector)
      if [[ -f "$n2/collector.mjs" ]]; then suite collector AGENT_IMAGE="$AGENT_v2" node "$n2/collector.mjs"
      else echo "collector: skipped (e2e/kind/n2/collector.mjs not in this tree)" | tee -a "$OUT/summary.txt"; fi ;;
    v2) suite v2 CP_IMAGE="$CP_v2" AGENT_IMAGE="$AGENT_v2" CP_REV="$REV_v2" AGENT_REV="$REV_v2" node "$n2/components/v2.mjs" ;;
    *) echo "unknown suite $s" | tee -a "$OUT/summary.txt" >&2; failed=1 ;;
  esac
done
cat "$OUT/summary.txt"
