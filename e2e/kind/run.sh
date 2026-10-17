#!/usr/bin/env bash
# Final MVP acceptance in kind: both charts, observability, then the Playwright scenario in e2e/kind/mvp.spec.ts,
# then a second data plane with the chart defaults.
# Prerequisites: a kind cluster with the images loaded (see the mvp-e2e job in .github/workflows/ci.yml:
# gromesh-control-plane:ci, gromesh-ui:ci, gromesh-agent:ci, ghcr.io/grometis/gromesh-kong:3.9.4-ac22d11c5ee912f9caeaf03a0305faca16aa5ca7, postgres:16-alpine, traefik/whoami:v1.10.3,
# clickhouse/clickhouse-server:25.8.16.34-alpine, timberio/vector:0.53.0-alpine), helm, kubectl, jq, pnpm with the
# e2e workspace installed and Chromium (`pnpm --filter @gromesh/e2e exec playwright install chromium`).
# Docker must reach the kind node containers: the restart step stops only the agent through crictl
# (the scratch agent image has no shell/kill), then waits for kubelet and checks the cluster's sole nodeId.
# From the repo root: bash e2e/kind/run.sh
set -euo pipefail
umask 077
namespace=gromesh-mvp
cp_chart=deploy/helm/control-plane
dp_chart=deploy/helm/data-plane
work="$(mktemp -d)"
forwards=()
cleanup() {
  local result=$?
  trap - EXIT
  if (( result != 0 )); then
    bash "$cp_chart/ci/diagnostics.sh" "$namespace" || true
  fi
  for pid in "${forwards[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  rm -rf "$work"
  exit "$result"
}
trap cleanup EXIT
k() { kubectl -n "$namespace" "$@"; }
mask() { if [[ "${GITHUB_ACTIONS:-}" == true ]]; then echo "::add-mask::$1"; fi; }
# Only the secret goes to stdout: the GitHub mask line must never end up inside the captured value.
secret() { local s; s="$(openssl rand -hex 24)"; mask "$s" >&2; printf '%s' "$s"; }

kubectl create namespace "$namespace"
db_password="$(secret)"
admin_password="$(secret)"
ch_admin="$(secret)"
ch_writer="$(secret)"
ch_reader="$(secret)"
encryption_key="mvp:$(openssl rand -base64 32)"
fingerprint_key="$(openssl rand -base64 32)"
mask "$encryption_key"; mask "$fingerprint_key"
k create secret generic ci-db-auth --from-literal="password=$db_password"
k create secret generic ci-database --from-literal="url=postgres://gromesh:$db_password@postgres:5432/gromesh"
k create secret generic ci-admin --from-literal=email=admin@example.test --from-literal="password=$admin_password"
k create secret generic ci-encryption --from-literal="key=$encryption_key" --from-literal="fingerprint-key=$fingerprint_key"
k create secret generic ci-clickhouse-admin --from-literal="password=$ch_admin"
k create secret generic ci-clickhouse-writer --from-literal="writer-password=$ch_writer"
k create secret generic ci-clickhouse-reader --from-literal="url=http://clickhouse:8123" --from-literal=user=gromesh_reader \
  --from-literal="password=$ch_reader" --from-literal=database=gromesh
k create configmap clickhouse-init-sql --from-file=deploy/observability/clickhouse/001-requests.sql
k create configmap clickhouse-init-users --from-file=deploy/observability/clickhouse-init/users.sh

k apply -f "$cp_chart/ci/kind-resources.yaml"
k apply -f e2e/kind/observability.yaml
k rollout status deployment/postgres --timeout=120s
k rollout status deployment/echo --timeout=90s
k rollout status deployment/clickhouse --timeout=180s
k wait --for=condition=complete job/clickhouse-init --timeout=120s

helm install cp "$cp_chart" -n "$namespace" -f "$cp_chart/ci/values-kind.yaml" \
  --set clickhouse.existingSecret=ci-clickhouse-reader \
  --set platform.httpLogEndpoint=http://gromesh-collector:8080/kong \
  --wait --timeout 4m
k wait --for=condition=Available deployment/cp-control-plane --timeout=60s
# Folded in from the former helm-e2e job: two API replicas ready, and the successful migration hook deleted
# (a failed or unfinished one would remain).
[[ "$(k get deployment cp-control-plane -o jsonpath='{.status.readyReplicas}')" == 2 ]]
[[ -z "$(k get jobs -l app.kubernetes.io/instance=cp -o name)" ]]

forward() {
  local service="$1" port="$2" remote="$3" pid
  k port-forward "svc/$service" "$port:$remote" > "$work/forward-$port.log" 2>&1 &
  pid=$!
  forwards+=("$pid")
  for ((attempt=0; attempt<30; attempt++)); do
    if grep -q 'Forwarding from' "$work/forward-$port.log"; then return; fi
    kill -0 "$pid" 2>/dev/null || { cat "$work/forward-$port.log"; return 1; }
    sleep 1
  done
  cat "$work/forward-$port.log"
  return 1
}
forward control-plane 13000 3000
forward cp-control-plane-ui 18080 8080
# The UI image serves its static files and proxies /api to the API through its hardcoded nginx upstream.
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:18080/ | grep -q '<html'
[[ "$(curl --silent --max-time 10 -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/api/v1/environments)" == 401 ]]
base=http://127.0.0.1:13000/api/v1
jq -n --arg password "$admin_password" '{email:"admin@example.test",password:$password}' > "$work/login.json"
curl --fail --silent --show-error --max-time 10 -c "$work/cookies" -H 'Content-Type: application/json' -d @"$work/login.json" "$base/auth/login" > /dev/null
csrf="$(curl --fail --silent --show-error --max-time 10 -b "$work/cookies" "$base/auth/csrf" | jq -er .csrfToken)"
mask "$csrf"
api() {
  local method="$1" path="$2" expected="$3" body="${4:-}" status
  status="$(curl --silent --show-error --max-time 15 -b "$work/cookies" -H "X-CSRF-Token: $csrf" -H 'Content-Type: application/json' \
    -X "$method" ${body:+--data "$body"} "$base$path" -o "$work/response" -w '%{http_code}')"
  if [[ "$status" != "$expected" ]]; then echo "$method $path: expected $expected, got $status" >&2; return 1; fi
  cat "$work/response"
}
env_id="$(api POST /environments 201 '{"name":"mvp","publishMode":"manual"}' | jq -er .id)"
cluster="$(api POST "/environments/$env_id/clusters" 201 '{"name":"mvp-edge"}')"
cluster_id="$(jq -er .id <<< "$cluster")"
registration_token="$(jq -er .registrationToken <<< "$cluster")"
mask "$registration_token"
k create secret generic ci-agent --from-literal="registration-token=$registration_token"
unset cluster registration_token

# The data plane with its own collector: --wait would deadlock, Kong stays NotReady until the first publication.
helm install dp "$dp_chart" -n "$namespace" --timeout 2m \
  --set fullnameOverride=mvp-data-plane --set replicaCount=1 \
  --set agent.image.repository=gromesh-agent --set agent.image.tag=ci --set agent.image.digest= --set agent.image.pullPolicy=Never \
  --set agent.existingSecret=ci-agent --set agent.controlPlaneUrl=http://control-plane:3000 \
  --set kong.image.digest= --set kong.image.pullPolicy=Never \
  --set collector.enabled=true --set "collector.clusterId=$cluster_id" \
  --set collector.image.digest= --set collector.image.pullPolicy=Never \
  --set collector.clickhouse.endpoint=http://clickhouse:8123 --set collector.clickhouse.existingSecret=ci-clickhouse-writer
k rollout status deployment/mvp-data-plane-collector --timeout=120s
for ((attempt=0; attempt<60; attempt++)); do
  if api GET "/clusters/$cluster_id" 200 | jq -e '.nodes | length == 1' > /dev/null; then break; fi
  sleep 2
done
api GET "/clusters/$cluster_id" 200 | jq -e '.nodes | length == 1' > /dev/null
k wait --for=condition=Ready=false pod -l app.kubernetes.io/instance=dp,app.kubernetes.io/name=data-plane --timeout=30s
# NotReady because the snapshot is empty (readiness answers 503), not because a container is crashing.
pod_ip="$(k get pod -l app.kubernetes.io/instance=dp,app.kubernetes.io/name=data-plane -o jsonpath='{.items[0].status.podIP}')"
k exec deployment/cp-control-plane -- node -e \
  'fetch(process.argv[1]).then(r => { if (r.status !== 503) process.exit(1); console.log("Empty data plane: readiness HTTP 503"); }).catch(() => process.exit(1))' \
  "http://$pod_ip:8100/status/ready"
forward mvp-data-plane 18000 8000

# Log out the shell session; the scenario logs in through the UI with the same admin.
curl --silent --max-time 10 -b "$work/cookies" -H "X-CSRF-Token: $csrf" -X POST "$base/auth/logout" > /dev/null || true
export UI_URL=http://127.0.0.1:18080 CP_URL="$base" KONG_PROXY_URL=http://127.0.0.1:18000
export E2E_ADMIN_EMAIL=admin@example.test E2E_ADMIN_PASSWORD="$admin_password" E2E_ENV_ID="$env_id" E2E_CLUSTER_ID="$cluster_id"
export E2E_NAMESPACE="$namespace" E2E_DATA_PLANE_SELECTOR=app.kubernetes.io/instance=dp,app.kubernetes.io/name=data-plane
pnpm --filter @gromesh/e2e exec playwright test --config kind/playwright.config.ts
echo 'PASS: MVP acceptance in kind (install → login → publish → converge → agent restart with one node → traffic → dashboard → rollback → audit)'

# A second data plane with the chart's defaults (no collector, two replicas), in its own namespace and cluster: the
# default install path the former helm-e2e job covered. Only what kind needs is set (local images, the control
# plane in the other namespace, and a smaller CPU request); every feature keeps its default. It runs last, after the
# scenario's data plane is gone: the single kind node has no CPU left for two more gateways next to it.
ns2="${namespace}-defaults"
helm uninstall dp -n "$namespace" --wait --timeout 2m > /dev/null
curl --fail --silent --show-error --max-time 10 -c "$work/cookies" -H 'Content-Type: application/json' -d @"$work/login.json" "$base/auth/login" > /dev/null
csrf="$(curl --fail --silent --show-error --max-time 10 -b "$work/cookies" "$base/auth/csrf" | jq -er .csrfToken)"
kubectl create namespace "$ns2"
env2_id="$(api POST /environments 201 '{"name":"chart-defaults","publishMode":"manual"}' | jq -er .id)"
cluster2="$(api POST "/environments/$env2_id/clusters" 201 '{"name":"defaults-edge"}')"
cluster2_id="$(jq -er .id <<< "$cluster2")"
token2="$(jq -er .registrationToken <<< "$cluster2")"
mask "$token2"
kubectl -n "$ns2" create secret generic dp-agent --from-literal="registration-token=$token2"
unset cluster2 token2
helm install dp-defaults "$dp_chart" -n "$ns2" --timeout 2m \
  --set agent.existingSecret=dp-agent --set agent.controlPlaneUrl="http://control-plane.$namespace.svc.cluster.local:3000" \
  --set agent.image.repository=gromesh-agent --set agent.image.tag=ci --set agent.image.digest= --set agent.image.pullPolicy=Never \
  --set kong.image.digest= --set kong.image.pullPolicy=Never --set kong.resources.requests.cpu=50m
service2_id="$(api POST "/environments/$env2_id/services" 201 \
  "$(jq -n --arg host "echo.$namespace.svc.cluster.local" '{name:"echo",protocol:"http",host:$host,port:80}')" | jq -er .id)"
api POST "/environments/$env2_id/routes" 201 "$(jq -n --arg id "$service2_id" '{name:"echo",serviceId:$id,paths:["/defaults"]}')" > /dev/null
version2="$(api POST "/environments/$env2_id/snapshots" 201 '{}' | jq -er .version)"
converged2=false
for ((attempt=0; attempt<90; attempt++)); do
  if api GET "/clusters/$cluster2_id" 200 | jq -e --argjson version "$version2" \
    '.status == "converged" and (.nodes | length == 2) and all(.nodes[]; .online and .appliedVersion == $version)' > /dev/null; then
    converged2=true
    break
  fi
  sleep 2
done
[[ "$converged2" == true ]]
kubectl -n "$ns2" wait --for=condition=Ready pod -l app.kubernetes.io/instance=dp-defaults --timeout=90s
kubectl -n "$ns2" port-forward svc/dp-defaults-data-plane 18001:8000 > "$work/forward-18001.log" 2>&1 &
forwards+=("$!")
curl --fail --silent --show-error --retry 15 --retry-all-errors --retry-delay 1 --max-time 10 \
  http://127.0.0.1:18001/defaults > "$work/defaults"
grep -q 'Hostname:' "$work/defaults"
helm uninstall dp-defaults -n "$ns2" --wait --timeout 2m > /dev/null
api DELETE "/clusters/$cluster2_id" 204 > /dev/null
echo 'PASS: data plane with the chart defaults (no collector, 2 replicas) converged, Ready and proxying'
