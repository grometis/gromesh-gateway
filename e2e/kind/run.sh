#!/usr/bin/env bash
# Final MVP acceptance in kind: both charts, observability, then the Playwright scenario in e2e/kind/mvp.spec.ts.
# Prerequisites: a kind cluster with the images loaded (see the mvp-e2e job in .github/workflows/ci.yml:
# gromesh-control-plane:ci, gromesh-ui:ci, gromesh-agent:ci, ghcr.io/grometis/gromesh-kong:3.9.4-48960afbeba04b0eea81dd44a6079ee0e1c647a5, postgres:16-alpine, traefik/whoami:v1.10.3,
# clickhouse/clickhouse-server:25.8.16.34-alpine, timberio/vector:0.53.0-alpine), helm, kubectl, jq, pnpm with the
# e2e workspace installed and Chromium (`pnpm --filter @gromesh/e2e exec playwright install chromium`).
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
  --set agent.image.tag=ci --set agent.image.pullPolicy=Never \
  --set agent.existingSecret=ci-agent --set agent.controlPlaneUrl=http://control-plane:3000 \
  --set kong.image.digest= --set kong.image.pullPolicy=Never \
  --set collector.enabled=true --set "collector.clusterId=$cluster_id" \
  --set collector.image.pullPolicy=Never \
  --set collector.clickhouse.endpoint=http://clickhouse:8123 --set collector.clickhouse.existingSecret=ci-clickhouse-writer
k rollout status deployment/mvp-data-plane-collector --timeout=120s
for ((attempt=0; attempt<60; attempt++)); do
  if api GET "/clusters/$cluster_id" 200 | jq -e '.nodes | length == 1' > /dev/null; then break; fi
  sleep 2
done
api GET "/clusters/$cluster_id" 200 | jq -e '.nodes | length == 1' > /dev/null
k wait --for=condition=Ready=false pod -l app.kubernetes.io/instance=dp,app.kubernetes.io/name=data-plane --timeout=30s
forward mvp-data-plane 18000 8000

# Log out the shell session; the scenario logs in through the UI with the same admin.
curl --silent --max-time 10 -b "$work/cookies" -H "X-CSRF-Token: $csrf" -X POST "$base/auth/logout" > /dev/null || true
export UI_URL=http://127.0.0.1:18080 CP_URL="$base" KONG_PROXY_URL=http://127.0.0.1:18000
export E2E_ADMIN_EMAIL=admin@example.test E2E_ADMIN_PASSWORD="$admin_password" E2E_ENV_ID="$env_id" E2E_CLUSTER_ID="$cluster_id"
pnpm --filter @gromesh/e2e exec playwright test --config kind/playwright.config.ts
echo 'PASS: MVP acceptance in kind (install → login → publish → converge → traffic → dashboard → rollback → audit)'
