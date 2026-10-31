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
owned=0 creating=0 failed=0 work="" sampler_pid=""
built=() trees=()

# The run id lives in the cluster itself and is read and written only through the kubeconfig kind exports for the named
# cluster on this host's (checked) Docker daemon, never through LAB_KUBECONFIG, whatever that file names. Any error
# reads as "not this run's".
kind_kc() { local f="$work/kind.kubeconfig"; kind get kubeconfig --name "$CLUSTER_NAME" >"$f" 2>/dev/null && echo "$f"; }
marker() { local f; f="$(kind_kc)" || return 0
  kubectl --kubeconfig "$f" -n kube-system get configmap gromesh-lab-run -o jsonpath='{.data.runId}' 2>/dev/null || true; }
# Defined before the EXIT trap: the image sampler (started per suite, further down) leads its own process group.
stop_sampler() { [[ -n "$sampler_pid" ]] || return 0
  kill -TERM -- "-$sampler_pid" 2>/dev/null || true; wait "$sampler_pid" 2>/dev/null || true; sampler_pid=""; }
cleanup() {
  local code=$? t id
  trap - EXIT
  stop_sampler
  for t in ${built[@]+"${built[@]}"}; do docker image rm "$t" >/dev/null 2>&1 || true; done
  for t in ${trees[@]+"${trees[@]}"}; do git -C "$root" worktree remove --force "$t" >/dev/null 2>&1 || true; done
  if (( owned )) && [[ "${LAB_KEEP:-}" != 1 ]]; then
    id="$(marker)"
    if [[ "$id" == "$RUN_ID" ]]; then bash "$n2/cluster.sh" down || code=1
    else echo "cluster $CLUSTER_NAME does not carry this run's id ($RUN_ID; read '${id}'): left alone" >&2; code=1; fi
  elif (( creating )) && kind get clusters 2>/dev/null | grep -qx "$CLUSTER_NAME"; then
    # `up` failed before the cluster was marked: deleting it would rest on an unproven ownership.
    echo "cluster $CLUSTER_NAME was not marked as this run's: left in place; remove it with 'kind delete cluster --name $CLUSTER_NAME' after checking it" >&2
    code=1
  fi
  [[ -z "$work" ]] || rm -rf "$work"
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

# Ownership is proven, not assumed: the cluster list must be readable and must not hold the lab cluster, and the run
# owns the cluster only once its id is written into it.
clusters="$(kind get clusters)" || { echo "kind cannot list clusters: refusing to create or delete anything" >&2; exit 1; }
if grep -qx "$CLUSTER_NAME" <<<"$clusters"; then
  echo "kind cluster $CLUSTER_NAME already exists: refusing to reuse or delete it (remove it yourself if it is a leftover)" >&2
  exit 1
fi
creating=1
bash "$n2/cluster.sh" up
kc="$(kind_kc)" || { echo "kind exported no kubeconfig for $CLUSTER_NAME" >&2; exit 1; }
kubectl --kubeconfig "$kc" -n kube-system create configmap gromesh-lab-run --from-literal=runId="$RUN_ID" >/dev/null
[[ "$(marker)" == "$RUN_ID" ]] || { echo "could not mark $CLUSTER_NAME with $RUN_ID" >&2; exit 1; }
owned=1 creating=0
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
for image in "$KONG_REF" "$PG_IMAGE" "${built[@]}"; do
  docker image inspect -f "$image {{.Id}} {{join .RepoDigests \",\"}} {{index .Config.Labels \"org.opencontainers.image.revision\"}}" "$image"
done >"$OUT/images.txt"
load "images loaded"
# What the cluster actually ran (ClickHouse, Vector and the fixtures are pulled there by digest): every container's
# image and resolved image id, sampled from the cluster itself while the suite runs, since the suites delete their pods
# before they return. A failed sample is recorded as ERROR, never dropped.
sample() { local f="$work/sampler.kubeconfig"
  kind get kubeconfig --name "$CLUSTER_NAME" >"$f" 2>/dev/null || { echo "ERROR kind get kubeconfig"; return; }
  kubectl --kubeconfig "$f" --request-timeout=10s get pods -A -o jsonpath='{range .items[*]}{range .status.containerStatuses[*]}{.image}{" "}{.imageID}{"\n"}{end}{range .status.initContainerStatuses[*]}{.image}{" "}{.imageID}{"\n"}{end}{end}' 2>/dev/null \
    || echo "ERROR kubectl get pods"; }
sampler() { while :; do sample >>"$1"; sleep 5; done; }
# setsid: stop_sampler then also stops the sampler's sleep, kind or kubectl.
start_sampler() { export -f sample sampler; export work CLUSTER_NAME
  setsid bash -c 'sampler "$1"' _ "$1" & sampler_pid=$!; }
# A suite passes only with evidence that each expected image ran (a name the run built or a pinned digest), counted
# only on lines that carry the resolved image id: a container not yet started has its image but no imageID.
ran() {
  local name="$1" raw="$2" seen="$2.resolved" want missing=(); shift 2
  awk '$1 != "ERROR" && NF >= 2' "$raw" | sort -u >"$seen"
  sed "s|^|$name |" "$seen" >>"$OUT/images-ran.txt"
  [[ -s "$seen" ]] || missing+=("any container")
  for want in "$@"; do grep -qF -- "$want" "$seen" || missing+=("$want"); done
  (( ${#missing[@]} == 0 )) && return 0
  echo "not observed running: ${missing[*]}; $(grep -c '^ERROR' "$raw" || true) failed samples"
  return 1
}

# One suite: its own OUT subdirectory, the load before and after (a run under saturation is not evidence), and the
# images it must be seen running ("a b c", then the command).
suite() {
  local name="$1" expected="$2" rc=0 evidence="" images=""; shift 2
  mkdir -p "$OUT/$name"
  load "$name start"
  : >"$OUT/$name/images-sampled.txt"
  start_sampler "$OUT/$name/images-sampled.txt"
  env LAB_OUT="$OUT/$name" KONG_IMAGE="$KONG_IMAGE" PG_IMAGE="$PG_LOCAL" "$@" >"$OUT/$name/run.log" 2>&1 || rc=$?
  stop_sampler
  sample >>"$OUT/$name/images-sampled.txt"
  # The lab servers' own connection logs (fixtures.mjs serve): the privileged destination's evidence for this suite.
  for role in backend nodecidr denied imds; do
    if ! docker logs "${CLUSTER_NAME}-fx-$role" >"$OUT/$name/fixture-$role.log" 2>/dev/null; then
      # Without the server's own log the suite's evidence is incomplete: never a pass.
      [[ "$rc" != 0 ]] || rc="fixture-log"
      evidence="${evidence:+$evidence; }the $role server's log could not be kept"
    fi
  done
  # shellcheck disable=SC2086 # the expected images are a word list
  images="$(ran "$name" "$OUT/$name/images-sampled.txt" $expected)" || { [[ "$rc" != 0 ]] || rc="evidence"; }
  evidence="${evidence:+$evidence; }$images"; evidence="${evidence%; }"
  if [[ "$rc" == 0 ]]; then echo "$name: pass" | tee -a "$OUT/summary.txt"
  elif [[ "$rc" == evidence ]]; then echo "$name: FAIL ($evidence)" | tee -a "$OUT/summary.txt"; failed=1
  elif [[ "$rc" == 2 ]]; then echo "$name: INCOMPLETE (a measurement was not exercised; see $name/results.json blocked${evidence:+; $evidence})" | tee -a "$OUT/summary.txt"; failed=1
  else echo "$name: FAIL (exit $rc; see $name/run.log${evidence:+; $evidence})" | tee -a "$OUT/summary.txt"; failed=1; fi
  load "$name end"
}

FIXTURE_DIGEST="${FIXTURE_IMAGE##*@}" CLICKHOUSE_DIGEST="${CLICKHOUSE_IMAGE##*@}" VECTOR_DIGEST="${VECTOR_IMAGE##*@}"
for s in $SUITES; do
  case "$s" in
    env) suite env "$FIXTURE_DIGEST" node "$n2/run.mjs" ;;
    components) suite components "$KONG_IMAGE $AGENT_admission" CP_IMAGE="$CP_admission" AGENT_IMAGE="$AGENT_admission" CP_REV="$REV_admission" AGENT_REV="$REV_admission" node "$n2/components/run.mjs" ;;
    f3) suite f3 "$KONG_IMAGE $AGENT_admission" CP_IMAGE="$CP_admission" AGENT_IMAGE="$AGENT_admission" CP_REV="$REV_admission" AGENT_REV="$REV_admission" node "$n2/components/f3.mjs" ;;
    f3-residual4) suite f3-residual4 "$KONG_IMAGE $AGENT_admission" RESIDUAL=4 LAB_STEPS=coldStart,secondPod,residualHeld CP_IMAGE="$CP_admission" AGENT_IMAGE="$AGENT_admission" node "$n2/components/f3.mjs" ;;
    f3-neg) suite f3-neg "$KONG_IMAGE $AGENT_neg" LAB_PHASE=neg CP_IMAGE="$CP_admission" AGENT_IMAGE="$AGENT_neg" CP_REV="$REV_admission" AGENT_REV="$REV_neg" node "$n2/components/f3.mjs" ;;
    collector)
      if [[ -f "$n2/collector.mjs" ]]; then suite collector "$KONG_IMAGE $AGENT_v2 $CLICKHOUSE_DIGEST $VECTOR_DIGEST" AGENT_IMAGE="$AGENT_v2" node "$n2/collector.mjs"
      else echo "collector: skipped (e2e/kind/n2/collector.mjs not in this tree)" | tee -a "$OUT/summary.txt"; fi ;;
    v2) suite v2 "$KONG_IMAGE $AGENT_v2 $CLICKHOUSE_DIGEST $VECTOR_DIGEST" CP_IMAGE="$CP_v2" AGENT_IMAGE="$AGENT_v2" CP_REV="$REV_v2" AGENT_REV="$REV_v2" node "$n2/components/v2.mjs" ;;
    *) echo "unknown suite $s" | tee -a "$OUT/summary.txt" >&2; failed=1 ;;
  esac
done
cat "$OUT/summary.txt"
