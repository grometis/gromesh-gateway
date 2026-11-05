#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/common.sh"
require_disposable_worker || exit 78
export GROMESH_DISPOSABLE_ID="$GROMESH_CI_RUN"
export KUBECONFIG="$GROMESH_CI_STATE/kind-kubeconfig"
export KIND_CLUSTER_NAME="$(node scripts/kind-stack-guard.mjs name)"
export KIND_EXPERIMENTAL_PROVIDER=docker
[[ ! -e "$KUBECONFIG" ]] || exit 78
pnpm --filter @gromesh/e2e exec playwright install chromium
for name in control-plane ui agent; do docker buildx build --load -t "gromesh-${name}:ci" -f "apps/$name/Dockerfile" .; done
read -r kong_ref kong_tag < <(node scripts/kong-image-ref.mjs)
docker pull "$kong_ref"; docker tag "$kong_ref" "$kong_tag"
images=(gromesh-control-plane:ci gromesh-ui:ci gromesh-agent:ci "$kong_tag" postgres:16-alpine traefik/whoami:v1.10.3)
for ref in \
  clickhouse/clickhouse-server:25.8.33.6-alpine@sha256:87e0a5b72f5465b18eacca7c76850e7ff551c9795c50e451f5646299e5e24146 \
  timberio/vector:0.57.0-alpine@sha256:19e3526faf4d4b1ed0c28a0d68d4cc3a1e13e437099986a5b7a768707907497c; do
  docker pull "$ref"; docker tag "$ref" "${ref%@*}"; images+=("${ref%@*}")
done
docker pull postgres:16-alpine
docker pull traefik/whoami:v1.10.3
kind create cluster --name "$KIND_CLUSTER_NAME" --kubeconfig "$KUBECONFIG" --image kindest/node:v1.32.2 --wait 120s
# This cluster was created in a validated dedicated rootless engine; no ambient kubeconfig is used.
trap 'kind delete cluster --name "$KIND_CLUSTER_NAME" --kubeconfig "$KUBECONFIG"' EXIT
kind load docker-image --name "$KIND_CLUSTER_NAME" "${images[@]}"
kubectl --kubeconfig "$KUBECONFIG" --context "kind-$KIND_CLUSTER_NAME" wait --for=condition=Ready nodes --all --timeout=60s
bash e2e/kind/run.sh
