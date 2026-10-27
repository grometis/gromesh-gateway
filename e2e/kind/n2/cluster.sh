#!/usr/bin/env bash
# N2 reference lab (environment A): kind dual-stack without kindnet, kube-proxy kept, Cilium pinned in versions.env.
#   LAB_KUBECONFIG=<file> bash e2e/kind/n2/cluster.sh up|down|status
# Every kubectl/helm call uses only LAB_KUBECONFIG and the lab context: the user's kubeconfig is never read or written.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=versions.env
source "$here/versions.env"
: "${LAB_KUBECONFIG:?set LAB_KUBECONFIG to the lab kubeconfig file (never ~/.kube/config)}"
WORKERS="${WORKERS:-2}"
context="kind-$CLUSTER_NAME"
# One explicit file, never a list, never a link, never the user's kubeconfig (-ef also catches a hard link).
[[ "$LAB_KUBECONFIG" != *:* ]] || { echo "LAB_KUBECONFIG must be a single file, not a list" >&2; exit 1; }
[[ ! -L "$LAB_KUBECONFIG" ]] || { echo "LAB_KUBECONFIG must not be a symlink" >&2; exit 1; }
if [[ "$LAB_KUBECONFIG" -ef "$HOME/.kube/config" || "$(cd -P "$(dirname "$LAB_KUBECONFIG")" 2>/dev/null && pwd -P)/$(basename "$LAB_KUBECONFIG")" == "$(cd -P "$HOME/.kube" 2>/dev/null && pwd -P)/config" ]]; then
  echo "LAB_KUBECONFIG must not be ~/.kube/config" >&2
  exit 1
fi
# kind, kubectl and helm see only the lab file, whatever the caller's environment says.
export KUBECONFIG="$LAB_KUBECONFIG"
k() { kubectl --kubeconfig "$LAB_KUBECONFIG" --context "$context" "$@"; }
h() { helm --kubeconfig "$LAB_KUBECONFIG" --kube-context "$context" "$@"; }

# Refuses any mutation unless the lab context is the named kind cluster: same API endpoint and same CA as the
# kubeconfig kind itself exports for it (a loopback address alone could be a tunnel to any cluster).
identity() { kubectl --kubeconfig "$1" config view --raw --minify --flatten ${2:+--context "$2"} \
  -o jsonpath='{.clusters[0].cluster.server} {.clusters[0].cluster.certificate-authority-data}'; }
assert_lab() {
  local exported lab want got
  kind get clusters | grep -qx "$CLUSTER_NAME" || { echo "kind cluster $CLUSTER_NAME not found" >&2; exit 1; }
  exported="$(mktemp)"
  kind get kubeconfig --name "$CLUSTER_NAME" >"$exported"
  want="$(identity "$exported")"
  rm -f "$exported"
  got="$(identity "$LAB_KUBECONFIG" "$context" 2>/dev/null || true)"
  [[ "$want" =~ ^https://127\.0\.0\.1:[0-9]+\ [A-Za-z0-9+/=]{100,}$ ]] || { echo "kind exported no usable kubeconfig for $CLUSTER_NAME" >&2; exit 1; }
  [[ "$got" == "$want" ]] || { echo "context $context (${got%% *}) is not kind cluster $CLUSTER_NAME (${want%% *}): endpoint or CA differ" >&2; exit 1; }
}

# A reused cluster or release must be the pinned one: Kubernetes, node and Cilium images, and Cilium's effective config.
die() { echo "pin mismatch: $*" >&2; exit 1; }
# The node containers, before anything is installed: pinned node image (by digest), node count, API server version.
assert_nodes() {
  local node want_nodes="${1:-}" image server nodes
  server="$(k version -o json | awk -F'"' '/"serverVersion"/ {s = 1} s && /gitVersion/ {print $4; exit}')"
  [[ "$server" == "$KUBERNETES_VERSION" ]] || die "Kubernetes server $server, pinned $KUBERNETES_VERSION"
  nodes="$(kind get nodes --name "$CLUSTER_NAME" | sort)"
  [[ -z "$want_nodes" || "$(wc -l <<<"$nodes" | tr -d ' ')" == "$want_nodes" ]] || die "$(wc -l <<<"$nodes" | tr -d ' ') nodes, expected $want_nodes"
  for node in $nodes; do
    [[ "$(docker inspect -f '{{.Config.Image}}' "$node")" == "$NODE_IMAGE" ]] || die "node $node runs $(docker inspect -f '{{.Config.Image}}' "$node")"
    image="$(docker inspect -f '{{.Image}}' "$node")"
    docker image inspect -f '{{join .RepoDigests "\n"}}' "$image" | grep -qx "kindest/node@${NODE_IMAGE#*@}" || die "node $node image $image is not ${NODE_IMAGE#*@}"
  done
}

# The Cilium release as installed: chart version, image digests in the spec.
# Also its content against the pinned chart file: a release keeping the version and the images may run other
# templates or defaults.
assert_cilium_release() {
  local release chart="${1:-}" want got
  release="$(h list -n kube-system --filter '^cilium$' -o json)"
  [[ "$release" == *'"chart":"cilium-'"$CILIUM_VERSION"'"'* && "$release" == *'"status":"deployed"'* ]] || die "Cilium release $release, pinned cilium-$CILIUM_VERSION"
  [[ "$(k -n kube-system get daemonset cilium -o jsonpath='{.spec.template.spec.containers[?(@.name=="cilium-agent")].image}')" == *"@$CILIUM_IMAGE_DIGEST" ]] || die "cilium-agent image is not $CILIUM_IMAGE_DIGEST"
  [[ "$(k -n kube-system get deployment cilium-operator -o jsonpath='{.spec.template.spec.containers[0].image}')" == *"@$CILIUM_OPERATOR_GENERIC_DIGEST" ]] || die "cilium-operator image is not $CILIUM_OPERATOR_GENERIC_DIGEST"
  [[ -n "$chart" ]] || die "no pinned chart file to compare the installed release with"
  # The pinned chart as a release would carry it (client-side dry run: nothing reaches the cluster).
  want="$(h install cilium "$chart" --namespace kube-system --dry-run=client -o json -f "$here/cilium-values.yaml" \
    --set image.digest="$CILIUM_IMAGE_DIGEST" --set operator.image.genericDigest="$CILIUM_OPERATOR_GENERIC_DIGEST" | node "$here/chart-fingerprint.mjs")"
  got="$(k -n kube-system get secret -l owner=helm,name=cilium,status=deployed -o jsonpath='{.items[0].data.release}' | base64 -d | base64 -d | gunzip | node "$here/chart-fingerprint.mjs")"
  [[ "$want" =~ ^[0-9a-f]{64}$ && "$got" == "$want" ]] || die "the installed Cilium chart ($got) is not the pinned chart ($want): templates, defaults, schema or files differ"
}

# Everything, once Ready: registered nodes, the kind config this script writes, running Cilium images and config.
assert_pins() {
  local kubelets id pair key value actual
  assert_nodes "${1:-}"
  kubelets="$(k get nodes -o jsonpath='{range .items[*]}{.status.nodeInfo.kubeletVersion}{"\n"}{end}' | sort -u)"
  [[ "$kubelets" == "$KUBERNETES_VERSION" ]] || die "kubelets $kubelets, pinned $KUBERNETES_VERSION"
  [[ "$(k get nodes -o name | wc -l | tr -d ' ')" == "$(kind get nodes --name "$CLUSTER_NAME" | wc -l | tr -d ' ')" ]] || die "not every node is registered"
  ! k -n kube-system get daemonset kindnet >/dev/null 2>&1 || die "kindnet is installed"
  k -n kube-system get daemonset kube-proxy >/dev/null || die "kube-proxy is missing"
  [[ -z "$(k get nodes -o jsonpath='{range .items[*]}{.spec.podCIDRs}{"\n"}{end}' | grep -v ':' || true)" ]] || die "a node has no IPv6 pod CIDR"
  assert_cilium_release "$chart"
  for id in $(k -n kube-system get pods -l k8s-app=cilium -o jsonpath='{range .items[*]}{.status.containerStatuses[?(@.name=="cilium-agent")].imageID}{"\n"}{end}'); do
    [[ "$id" == *"@$CILIUM_IMAGE_DIGEST" ]] || die "a cilium-agent pod runs $id"
  done
  for id in $(k -n kube-system get pods -l name=cilium-operator -o jsonpath='{range .items[*]}{.status.containerStatuses[0].imageID}{"\n"}{end}'); do
    [[ "$id" == *"@$CILIUM_OPERATOR_GENERIC_DIGEST" ]] || die "a cilium-operator pod runs $id"
  done
  # What every running agent uses, not the ConfigMap (a changed ConfigMap takes effect only when an agent restarts).
  local pod config status
  for pod in $(k -n kube-system get pods -l k8s-app=cilium -o jsonpath='{.items[*].metadata.name}'); do
    config="$(k -n kube-system exec "$pod" -c cilium-agent -- cilium-dbg config --all)"
    for pair in IPAM=kubernetes EnableIPv4=true EnableIPv6=true RoutingMode=tunnel EnableL7Proxy=false ExternalEnvoyProxy=false; do
      key="${pair%%=*}"; value="${pair#*=}"
      actual="$(awk -v k="$key" '$1 == k {print $3; exit}' <<<"$config")"
      [[ "$actual" == "$value" ]] || die "agent $pod runs $key=$actual, expected $value"
    done
    status="$(k -n kube-system exec "$pod" -c cilium-agent -- cilium-dbg status)"
    grep -qE '^KubeProxyReplacement:[[:space:]]+False' <<<"$status" || die "agent $pod runs kube-proxy replacement"
    grep -qE '^Routing:.*Tunnel \[vxlan\]' <<<"$status" || die "agent $pod does not route through a vxlan tunnel"
  done
}

check_kind() {
  local version binary sum expected os arch
  version="$(kind version | awk '{print $2}')"
  [[ "$version" == "$KIND_VERSION" ]] || { echo "kind $KIND_VERSION required, found $version" >&2; exit 1; }
  binary="$(command -v kind)"
  binary="$(readlink -f "$binary" 2>/dev/null || echo "$binary")"
  sum="$( (sha256sum "$binary" 2>/dev/null || shasum -a 256 "$binary") | awk '{print $1}')"
  os="$(uname -s | tr '[:lower:]' '[:upper:]')"
  arch="$(uname -m)"; arch="${arch/x86_64/AMD64}"; arch="${arch/aarch64/ARM64}"; arch="${arch/arm64/ARM64}"
  expected="KIND_SHA256_${os}_${arch}"
  if [[ "$sum" == "${!expected:-}" ]]; then echo "kind $version: release binary ($sum)"
  elif [[ "${CI:-}" == true ]]; then echo "kind binary $sum is not the $KIND_VERSION release binary" >&2; exit 1
  else echo "kind $version: not the release binary ($sum), accepted outside CI"; fi
}

# The pinned chart, verified by digest (pulled) or by content (CILIUM_CHART_TGZ, pre-pulled), into $chart; the caller
# removes $chart_dir.
pinned_chart() {
  local digest i
  chart_dir="$(mktemp -d)"
  chart="$chart_dir/cilium-$CILIUM_VERSION.tgz"
  if [[ -n "${CILIUM_CHART_TGZ:-}" ]]; then
    [[ "$( (sha256sum "$CILIUM_CHART_TGZ" 2>/dev/null || shasum -a 256 "$CILIUM_CHART_TGZ") | awk '{print $1}')" == "$CILIUM_CHART_TGZ_SHA256" ]] \
      || { echo "$CILIUM_CHART_TGZ is not the pinned chart" >&2; exit 1; }
    cp "$CILIUM_CHART_TGZ" "$chart"
    digest="$CILIUM_CHART_DIGEST"
  else for i in 1 2 3 4; do
    digest="$(h pull "$CILIUM_CHART" --version "$CILIUM_VERSION" -d "$chart_dir" 2>&1 | awk '/^Digest:/ {print $2}')" && [[ -n "$digest" ]] && break
    sleep $((i * 5))
  done; fi
  [[ "$digest" == "$CILIUM_CHART_DIGEST" ]] || { echo "Cilium chart digest '$digest' != $CILIUM_CHART_DIGEST" >&2; exit 1; }
}

up() {
  check_kind
  local t0 t1 t2 workers="" i
  for ((i = 0; i < WORKERS; i++)); do workers+="  - role: worker
    image: $NODE_IMAGE
"; done
  t0=$(date +%s)
  # Resumable: an existing lab cluster is kept (only Cilium is installed if missing), if it is the pinned one.
  kind get clusters | grep -qx "$CLUSTER_NAME" || kind create cluster --name "$CLUSTER_NAME" --kubeconfig "$LAB_KUBECONFIG" --wait 0s --config - <<EOF
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
networking:
  ipFamily: dual
  disableDefaultCNI: true
nodes:
  - role: control-plane
    image: $NODE_IMAGE
$workers
EOF
  t1=$(date +%s)
  assert_lab
  assert_nodes $((WORKERS + 1))
  local chart chart_dir
  pinned_chart
  trap 'rm -rf "$chart_dir"' RETURN
  if h status cilium -n kube-system >/dev/null 2>&1; then assert_cilium_release "$chart"
  else h install cilium "$chart" --namespace kube-system -f "$here/cilium-values.yaml" \
    --set image.digest="$CILIUM_IMAGE_DIGEST" --set operator.image.genericDigest="$CILIUM_OPERATOR_GENERIC_DIGEST"
  fi
  k -n kube-system rollout status daemonset/cilium --timeout=600s
  k -n kube-system rollout status deployment/cilium-operator --timeout=300s
  k wait --for=condition=Ready nodes --all --timeout=300s
  k -n kube-system rollout status deployment/coredns --timeout=300s
  # Ready pods are not enough: each agent must report a healthy datapath and see every node.
  local pod deadline=$((SECONDS + 300))
  for pod in $(k -n kube-system get pods -l k8s-app=cilium -o name); do
    until k -n kube-system exec "$pod" -c cilium-agent -- cilium-dbg status --brief >/dev/null 2>&1; do
      (( SECONDS < deadline )) || { k -n kube-system exec "$pod" -c cilium-agent -- cilium-dbg status || true; exit 1; }
      sleep 2
    done
  done
  t2=$(date +%s)
  echo "timing: kind create $((t1 - t0))s, cilium ready $((t2 - t1))s"
  assert_pins $((WORKERS + 1))
  status
}

status() {
  assert_lab
  local chart chart_dir
  pinned_chart
  trap 'rm -rf "$chart_dir"' RETURN
  assert_pins
  echo "pins: Kubernetes $KUBERNETES_VERSION, node ${NODE_IMAGE#*@}, Cilium $CILIUM_VERSION agent $CILIUM_IMAGE_DIGEST operator $CILIUM_OPERATOR_GENERIC_DIGEST, chart templates and every running agent as pinned"
  k version -o json | awk -F'"' '/gitVersion/ {print "server " $4; exit}'
  k get nodes -o custom-columns='NAME:.metadata.name,READY:.status.conditions[?(@.type=="Ready")].status,ARCH:.status.nodeInfo.architecture,KERNEL:.status.nodeInfo.kernelVersion,IPS:.status.addresses[?(@.type=="InternalIP")].address,PODCIDRS:.spec.podCIDRs'
  k -n kube-system get pods -o custom-columns='POD:.metadata.name,NODE:.spec.nodeName,IMAGE:.status.containerStatuses[0].imageID' | grep -E 'cilium|NAME|POD'
  local pod
  pod="$(k -n kube-system get pods -l k8s-app=cilium -o name | head -1)"
  k -n kube-system exec "$pod" -c cilium-agent -- cilium-dbg status | grep -E 'KubeProxyReplacement|Cilium:|IPAM|Routing|Masquerading|Cluster health|Host Routing|Kubernetes:' || true
  docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' | grep "^$CLUSTER_NAME-" || true
}

down() {
  kind delete cluster --name "$CLUSTER_NAME" --kubeconfig "$LAB_KUBECONFIG"
  local id
  for id in $(docker ps -aq --filter "name=^$CLUSTER_NAME-fx-"); do docker rm -f "$id"; done
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  status) status ;;
  *) echo "usage: $0 up|down|status" >&2; exit 2 ;;
esac
