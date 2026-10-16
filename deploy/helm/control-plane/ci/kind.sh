#!/usr/bin/env bash
# Run after loading the repo-built :ci images and pinned fixture images into kind.
set -euo pipefail
umask 077
namespace=gromesh-helm
chart=deploy/helm/control-plane
work="$(mktemp -d)"
forwards=()
cleanup() {
  local result=$?
  trap - EXIT
  if (( result != 0 )); then
    bash "$chart/ci/diagnostics.sh" "$namespace" || true
  fi
  for pid in "${forwards[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  rm -rf "$work"
  exit "$result"
}
trap cleanup EXIT
kubectl create namespace "$namespace"
k() { kubectl -n "$namespace" "$@"; }
mask() { if [[ "${GITHUB_ACTIONS:-}" == true ]]; then echo "::add-mask::$1"; fi; }
db_password="$(openssl rand -hex 24)"
admin_password="$(openssl rand -hex 24)"
mask "$db_password"
mask "$admin_password"
k create secret generic ci-db-auth --from-literal="password=$db_password"
k create secret generic ci-database --from-literal="url=postgres://gromesh:$db_password@postgres:5432/gromesh"
k create secret generic ci-admin --from-literal=email=admin@example.test --from-literal="password=$admin_password"
encryption_key="ci:$(openssl rand -base64 32)"
mask "$encryption_key"
fingerprint_key="$(openssl rand -base64 32)"
mask "$fingerprint_key"
k create secret generic ci-encryption --from-literal="key=$encryption_key" --from-literal="fingerprint-key=$fingerprint_key"
k apply -f "$chart/ci/kind-resources.yaml"
k rollout status deployment/postgres --timeout=120s
k rollout status deployment/echo --timeout=90s
helm install cp "$chart" -n "$namespace" -f "$chart/ci/values-kind.yaml" --wait --timeout 4m
k wait --for=condition=Available deployment/cp-control-plane --timeout=60s
[[ "$(k get deployment cp-control-plane -o jsonpath='{.status.readyReplicas}')" == 2 ]]
# A successful pre-install hook is deleted; fail if a failed/unfinished hook remains.
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
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:18080/ | grep -q '<html'
# Exercise the image's hardcoded nginx upstream as well as static content.
curl --silent --show-error --max-time 10 http://127.0.0.1:18080/api/v1/environments \
  -o "$work/anonymous" -w '%{http_code}' > "$work/anonymous-status"
[[ "$(cat "$work/anonymous-status")" == 401 ]]
base=http://127.0.0.1:13000/api/v1
jq -n --arg password "$admin_password" '{email:"admin@example.test",password:$password}' > "$work/login.json"
curl --fail --silent --show-error --max-time 10 -c "$work/cookies" \
  -H 'Content-Type: application/json' -d @"$work/login.json" "$base/auth/login" > /dev/null
csrf="$(curl --fail --silent --show-error --max-time 10 -b "$work/cookies" "$base/auth/csrf" | jq -er .csrfToken)"
mask "$csrf"
api() {
  local method="$1" path="$2" expected="$3" body="${4:-}"
  local status
  status="$(curl --silent --show-error --max-time 15 -b "$work/cookies" \
    -H "X-CSRF-Token: $csrf" -H 'Content-Type: application/json' \
    -X "$method" ${body:+--data "$body"} "$base$path" -o "$work/response" -w '%{http_code}')"
  if [[ "$status" != "$expected" ]]; then
    echo "$method $path: expected $expected, got $status" >&2
    return 1
  fi
  cat "$work/response"
}
env_id="$(api POST /environments 201 '{"name":"kind-acceptance","publishMode":"manual"}' | jq -er .id)"
cluster="$(api POST "/environments/$env_id/clusters" 201 '{"name":"kind-edge"}')"
cluster_id="$(jq -er .id <<< "$cluster")"
registration_token="$(jq -er .registrationToken <<< "$cluster")"
mask "$registration_token"
k create secret generic ci-agent --from-literal="registration-token=$registration_token"
unset cluster registration_token
# --wait would deadlock here: Kong must stay NotReady until the first publication.
helm install dp deploy/helm/data-plane -n "$namespace" --timeout 2m \
  --set fullnameOverride=ci-data-plane --set replicaCount=1 \
  --set agent.image.repository=gromesh-agent --set agent.image.tag=ci --set agent.image.digest= --set agent.image.pullPolicy=Never \
  --set agent.existingSecret=ci-agent --set agent.controlPlaneUrl=http://control-plane:3000 \
  --set kong.image.digest= --set kong.image.pullPolicy=Never
k wait --for=jsonpath='{.status.phase}'=Running pod -l app.kubernetes.io/instance=dp --timeout=120s
registered=false
for ((attempt=0; attempt<60; attempt++)); do
  if api GET "/clusters/$cluster_id" 200 | jq -e '.nodes | length == 1' > /dev/null; then
    registered=true
    break
  fi
  sleep 2
done
[[ "$registered" == true ]]
k wait --for=condition=Ready=false pod -l app.kubernetes.io/instance=dp --timeout=30s
# Confirm NotReady reflects the empty snapshot, rather than a crashing container.
pod_ip="$(k get pod -l app.kubernetes.io/instance=dp -o jsonpath='{.items[0].status.podIP}')"
k exec deployment/cp-control-plane -- node -e \
  'fetch(process.argv[1]).then(r => { if (r.status !== 503) process.exit(1); console.log("Empty data plane: readiness HTTP 503"); }).catch(() => process.exit(1))' \
  "http://$pod_ip:8100/status/ready"
service_id="$(api POST "/environments/$env_id/services" 201 \
  '{"name":"echo","protocol":"http","host":"echo","port":80}' | jq -er .id)"
api POST "/environments/$env_id/routes" 201 \
  "$(jq -n --arg id "$service_id" '{name:"echo",serviceId:$id,paths:["/echo"]}')" > /dev/null
# This calls the separate validator, exercising more than the port health check.
api POST "/environments/$env_id/plugins" 201 \
  '{"name":"rate-limiting","config":{"minute":1000,"policy":"local"}}' > /dev/null
version="$(api POST "/environments/$env_id/snapshots" 201 \
  '{"message":"kind Helm acceptance","expectedCurrentVersion":null}' | jq -er .version)"
converged=false
for ((attempt=0; attempt<90; attempt++)); do
  if api GET "/clusters/$cluster_id" 200 | jq -e --argjson version "$version" \
    '.status == "converged" and (.nodes | length == 1) and all(.nodes[]; .online and .appliedVersion == $version)' > /dev/null; then
    converged=true
    break
  fi
  sleep 2
done
[[ "$converged" == true ]]
k wait --for=condition=Ready pod -l app.kubernetes.io/instance=dp --timeout=90s
k rollout status deployment/ci-data-plane --timeout=60s
forward ci-data-plane 18000 8000
curl --fail --silent --show-error --retry 10 --retry-all-errors --retry-delay 1 --max-time 10 \
  http://127.0.0.1:18000/echo > "$work/echo"
grep -q 'Hostname:' "$work/echo"
echo 'PASS: migration, 2 API replicas, UI, validator, registration, NotReady → publication → converged → Ready, proxy HTTP 200'
