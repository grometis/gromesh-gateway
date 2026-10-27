#!/usr/bin/env bash
# The N2/N3 lab end to end on a dedicated Linux host, one suite at a time: host check, cluster, images built from the
# given git refs (labelled with their revision), N2-E1 environment, #173 components, F3 (fix, residual 4, negative
# control), collector sidecar, integrated v2. Each suite's results.json and log land in OUT; the cluster is removed at
# the end (LAB_KEEP=1 keeps it). Only LAB_KUBECONFIG is ever used; ~/.kube/config is refused by cluster.sh.
#   LAB_KUBECONFIG=<file> OUT=<dir> ADMISSION_REF=<ref> NEG_REF=<ref> V2_REF=<ref> KONG_REF=<image@sha256:…> \
#     [SUITES="env components f3 f3-residual4 f3-neg collector v2"] bash e2e/kind/n2/external/run-all.sh
#   ADMISSION_REF: main + the F3 fix (agent applies v1; what #173 and the F3 suite were written against).
#   NEG_REF:       the same without the F3 fix (F3 negative control).  V2_REF: main + the whole N3 minimal stack.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../../../.." && pwd)"
n2="$root/e2e/kind/n2"
# shellcheck source=../versions.env
source "$n2/versions.env"
: "${LAB_KUBECONFIG:?set LAB_KUBECONFIG to a lab-only kubeconfig file}"
: "${OUT:?set OUT to the evidence directory}" "${ADMISSION_REF:?}" "${NEG_REF:?}" "${V2_REF:?}" "${KONG_REF:?pinned Kong image by digest}"
[[ "$KONG_REF" == *@sha256:* ]] || { echo "KONG_REF must be pinned by digest" >&2; exit 1; }
SUITES="${SUITES:-env components f3 f3-residual4 f3-neg collector v2}"
mkdir -p "$OUT"
export LAB_KUBECONFIG
built=()
work="$(mktemp -d)"

cleanup() {
  local code=$?
  for t in "${built[@]}"; do docker image rm "$t" >/dev/null 2>&1 || true; done
  git -C "$root" worktree prune >/dev/null 2>&1 || true
  rm -rf "$work"
  [[ "${LAB_KEEP:-}" == 1 ]] || bash "$n2/cluster.sh" down || true
  exit "$code"
}
trap cleanup EXIT INT TERM

load() { echo "$(date -u +%FT%TZ) $(cut -d' ' -f1-3 /proc/loadavg) $*" | tee -a "$OUT/load.txt"; }

# Builds the control plane and the agent (which ships the isolation probe) of one ref, labelled with its revision.
build() {
  local name="$1" ref="$2" rev tree
  rev="$(git -C "$root" rev-parse --verify "$ref^{commit}")"
  tree="$work/$name"
  git -C "$root" worktree add --detach "$tree" "$rev" >/dev/null
  docker build -q -f "$tree/apps/control-plane/Dockerfile" --label "org.opencontainers.image.revision=$rev" -t "gromesh-lab-cp:$name-${rev:0:12}" "$tree" >/dev/null
  docker build -q -f "$tree/apps/agent/Dockerfile" --label "org.opencontainers.image.revision=$rev" -t "gromesh-lab-agent:$name-${rev:0:12}" "$tree" >/dev/null
  git -C "$root" worktree remove --force "$tree"
  built+=("gromesh-lab-cp:$name-${rev:0:12}" "gromesh-lab-agent:$name-${rev:0:12}")
  printf -v "CP_$name" '%s' "gromesh-lab-cp:$name-${rev:0:12}"
  printf -v "AGENT_$name" '%s' "gromesh-lab-agent:$name-${rev:0:12}"
  printf -v "REV_$name" '%s' "$rev"
}

bash "$here/host-check.sh"
load "host ready"
bash "$n2/cluster.sh" up
load "cluster up"

build admission "$ADMISSION_REF"
build neg "$NEG_REF"
build v2 "$V2_REF"
docker pull -q "$KONG_REF" >/dev/null
KONG_IMAGE="gromesh-lab-kong:${KONG_REF##*@sha256:}"; KONG_IMAGE="${KONG_IMAGE:0:31}"
docker tag "$KONG_REF" "$KONG_IMAGE"
built+=("$KONG_IMAGE")
for image in "${built[@]}" postgres:16-alpine; do
  docker image inspect "$image" >/dev/null 2>&1 || docker pull -q "$image" >/dev/null
  kind load docker-image --name "$CLUSTER_NAME" "$image" >/dev/null
done
load "images loaded"

# One suite: its own OUT subdirectory, the load before and after (a run under saturation is not evidence).
suite() {
  local name="$1"; shift
  mkdir -p "$OUT/$name"
  load "$name start"
  if env LAB_OUT="$OUT/$name" KONG_IMAGE="$KONG_IMAGE" "$@" >"$OUT/$name/run.log" 2>&1; then echo "$name: pass" | tee -a "$OUT/summary.txt"
  else echo "$name: FAIL (see $name/run.log)" | tee -a "$OUT/summary.txt"; fi
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
    *) echo "unknown suite $s" >&2; exit 1 ;;
  esac
done
cat "$OUT/summary.txt"
