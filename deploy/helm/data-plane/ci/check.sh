#!/usr/bin/env bash
set -euo pipefail
chart=deploy/helm/data-plane
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
helm lint "$chart" --strict --set-string agent.token=ci-placeholder
helm template dp "$chart" --set-string agent.token=ci-placeholder > "$work/default.yaml"
helm lint "$chart" --strict -f "$chart/ci/values-full.yaml"
helm template dp "$chart" -f "$chart/ci/values-full.yaml" > "$work/full.yaml"
helm lint "$chart" --strict -f "$chart/ci/values-homelab.yaml"
helm template dp "$chart" -f "$chart/ci/values-homelab.yaml" > "$work/homelab.yaml"
# Homelab: every container books its whole memory limit (same rule as the control-plane homelab values).
unbooked="$(docker run --rm -i mikefarah/yq:4.44.3 ea '[.. | select(tag == "!!map" and has("image")) | select(.resources.limits.memory == null or .resources.requests.memory != .resources.limits.memory) | .name] | join(",")' < "$work/homelab.yaml")"
[[ -z "$unbooked" ]] || { echo "Homelab containers whose memory request differs from the limit: $unbooked" >&2; exit 1; }
# kong.realIpHeader/kong.trustedIps: schema-checked, set together, passed to the Kong container.
refuse() {
  local expected="$1"
  shift
  if helm template dp "$chart" --set-string agent.token=ci-placeholder "$@" > /dev/null 2> "$work/real-ip.log"; then
    echo "Chart unexpectedly accepted: $*" >&2
    exit 1
  fi
  grep -Fq "$expected" "$work/real-ip.log"
}
refuse 'go together' --set-string kong.realIpHeader=CF-Connecting-IP
refuse 'go together' --set 'kong.trustedIps={10.244.0.0/16}'
refuse 'trustedIps' --set-string kong.realIpHeader=CF-Connecting-IP --set 'kong.trustedIps={0.0.0.0/0}'
refuse 'realIpHeader' --set-string 'kong.realIpHeader=Bad Header' --set 'kong.trustedIps={10.244.0.0/16}'
helm template dp "$chart" --set-string agent.token=ci-placeholder --set-string kong.realIpHeader=CF-Connecting-IP --set 'kong.trustedIps={10.244.0.0/16,2001:db8::/32}' > "$work/client-ip.yaml"
real_ip_env="$(docker run --rm -i mikefarah/yq:4.44.3 ea 'select(.kind == "Deployment") | .spec.template.spec.containers[] | select(.name == "kong") | [.env[] | select(.name == "KONG_REAL_IP_HEADER" or .name == "KONG_TRUSTED_IPS") | .name + "=" + .value] | sort | join(";")' < "$work/client-ip.yaml")"
[[ "$real_ip_env" == 'KONG_REAL_IP_HEADER=CF-Connecting-IP;KONG_TRUSTED_IPS=10.244.0.0/16,2001:db8::/32' ]]
pnpm --filter @gromesh/control-plane exec node --input-type=module - "$work/default.yaml" "$work/full.yaml" <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseAllDocuments } from 'yaml';
const read = path => parseAllDocuments(readFileSync(path, 'utf8')).map(doc => {
  assert.equal(doc.errors.length, 0);
  return doc.toJSON();
});
const [plain, full] = process.argv.slice(2).map(read);
assert.ok(!plain.some(resource => resource.kind === 'Job'));
const hook = full.find(resource => resource.kind === 'Job');
assert.equal(hook.metadata.annotations['helm.sh/hook'], 'pre-install,pre-upgrade');
assert.ok(hook.metadata.annotations['helm.sh/hook-delete-policy'].includes('before-hook-creation'));
assert.equal(hook.spec.backoffLimit, 0);
assert.equal(hook.spec.activeDeadlineSeconds, 60);
const pod = hook.spec.template;
assert.equal(pod.spec.automountServiceAccountToken, false);
const container = pod.spec.containers[0];
assert.deepEqual(container.command, ['sh', '-ec']);
assert.ok(container.args[0].includes('missing 001-requests.sql'));
assert.ok(container.args[0].includes('missing 002-retention.sql'));
assert.ok(container.args[0].includes('< deploy/observability/clickhouse/$1'));
assert.equal(container.env.find(env => env.name === 'CLICKHOUSE_PASSWORD').valueFrom.secretKeyRef.name, 'clickhouse-writer');
for (const service of full.filter(resource => resource.kind === 'Service')) {
  assert.ok(Object.entries(service.spec.selector).some(([key, value]) => pod.metadata.labels[key] !== value), 'Schema job must not receive live gateway or collector traffic');
}
console.log('Data-plane lint/render passed: collector disabled has no hook; enabled collector blocks install/upgrade before resources change, using only its writer secret');
JS
