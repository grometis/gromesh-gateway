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
if [[ "$(cd "$(dirname "$LAB_KUBECONFIG")" 2>/dev/null && pwd)/$(basename "$LAB_KUBECONFIG")" == "$HOME/.kube/config" ]]; then
  echo "LAB_KUBECONFIG must not be ~/.kube/config" >&2
  exit 1
fi
k() { KUBECONFIG="$LAB_KUBECONFIG" kubectl --context "$context" "$@"; }
h() { KUBECONFIG="$LAB_KUBECONFIG" helm --kube-context "$context" "$@"; }

# Refuses any mutation unless the lab context points at a kind API server on loopback.
assert_lab() {
  local server
  server="$(KUBECONFIG="$LAB_KUBECONFIG" kubectl config view --minify --context "$context" -o jsonpath='{.clusters[0].cluster.server}')"
  [[ "$server" =~ ^https://127\.0\.0\.1:[0-9]+$ ]] || { echo "context $context points at '$server', not a local kind cluster" >&2; exit 1; }
  kind get clusters | grep -qx "$CLUSTER_NAME" || { echo "kind cluster $CLUSTER_NAME not found" >&2; exit 1; }
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

up() {
  check_kind
  local t0 t1 t2 workers="" i
  for ((i = 0; i < WORKERS; i++)); do workers+="  - role: worker
    image: $NODE_IMAGE
"; done
  t0=$(date +%s)
  # Resumable: an existing lab cluster is kept (only Cilium is installed if missing).
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
  local chart_dir digest
  chart_dir="$(mktemp -d)"
  trap 'rm -rf "$chart_dir"' RETURN
  if [[ -n "${CILIUM_CHART_TGZ:-}" ]]; then
    # Pre-pulled chart (e.g. a registry reachable only over a path helm does not try): verified by content.
    [[ "$( (sha256sum "$CILIUM_CHART_TGZ" 2>/dev/null || shasum -a 256 "$CILIUM_CHART_TGZ") | awk '{print $1}')" == "$CILIUM_CHART_TGZ_SHA256" ]] \
      || { echo "$CILIUM_CHART_TGZ is not the pinned chart" >&2; exit 1; }
    cp "$CILIUM_CHART_TGZ" "$chart_dir/cilium-$CILIUM_VERSION.tgz"
    digest="$CILIUM_CHART_DIGEST"
  else for i in 1 2 3 4; do
    digest="$(h pull "$CILIUM_CHART" --version "$CILIUM_VERSION" -d "$chart_dir" 2>&1 | awk '/^Digest:/ {print $2}')" && [[ -n "$digest" ]] && break
    sleep $((i * 5))
  done; fi
  [[ "$digest" == "$CILIUM_CHART_DIGEST" ]] || { echo "Cilium chart digest '$digest' != $CILIUM_CHART_DIGEST" >&2; exit 1; }
  h status cilium -n kube-system >/dev/null 2>&1 || h install cilium "$chart_dir/cilium-$CILIUM_VERSION.tgz" --namespace kube-system -f "$here/cilium-values.yaml" \
    --set image.digest="$CILIUM_IMAGE_DIGEST" --set operator.image.genericDigest="$CILIUM_OPERATOR_GENERIC_DIGEST"
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
  status
}

status() {
  assert_lab
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
