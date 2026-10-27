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
refuse 'collector.environmentId' -f "$chart/ci/values-full.yaml" --set collector.environmentId=
refuse 'realIpHeader' --set-string 'kong.realIpHeader=Bad Header' --set 'kong.trustedIps={10.244.0.0/16}'
helm template dp "$chart" --set-string agent.token=ci-placeholder --set-string kong.realIpHeader=CF-Connecting-IP --set 'kong.trustedIps={10.244.0.0/16,2001:db8::/32}' > "$work/client-ip.yaml"
real_ip_env="$(docker run --rm -i mikefarah/yq:4.44.3 ea 'select(.kind == "Deployment") | .spec.template.spec.containers[] | select(.name == "kong") | [.env[] | select(.name == "KONG_REAL_IP_HEADER" or .name == "KONG_TRUSTED_IPS") | .name + "=" + .value] | sort | join(";")' < "$work/client-ip.yaml")"
[[ "$real_ip_env" == 'KONG_REAL_IP_HEADER=CF-Connecting-IP;KONG_TRUSTED_IPS=10.244.0.0/16,2001:db8::/32' ]]
# Workspaces mode: only on Kubernetes >= 1.33, with every capability covered and the probe on its own UID.
helm lint "$chart" --strict -f "$chart/ci/values-workspaces.yaml" --kube-version 1.33.0
helm template dp "$chart" -f "$chart/ci/values-workspaces.yaml" --kube-version 1.33.0 > "$work/workspaces.yaml"
refuse_ws() {
  local expected="$1"
  shift
  if helm template dp "$chart" -f "$chart/ci/values-workspaces.yaml" "$@" > /dev/null 2> "$work/ws.log"; then
    echo "Chart unexpectedly accepted Workspaces mode: $*" >&2
    exit 1
  fi
  grep -Fq "$expected" "$work/ws.log"
}
refuse_ws 'requires Kubernetes >= 1.33' --kube-version 1.32.9
refuse_ws 'start with the Kong version' --kube-version 1.33.0 --set kong.image.tag=latest
refuse_ws 'no forbidden target for CAP-3' --kube-version 1.33.0 --set 'workspaces.probe.checks[2].kind=tcp-open'
refuse_ws 'must differ from kong.runAsUser' --kube-version 1.33.0 --set workspaces.probe.runAsUser=1001
refuse_ws 'workspaces.clusterId' --kube-version 1.33.0 --set-string workspaces.clusterId=nope
refuse_ws 'positive control' --kube-version 1.33.0 --set 'workspaces.probe.checks[5].kind=tcp'
refuse_ws 'must list 1 to 3 instance signing keys' --kube-version 1.33.0 --set-json 'workspaces.instanceSigningKeys=[]'
refuse_ws 'instanceSigningKeys' --kube-version 1.33.0 --set-json 'workspaces.instanceSigningKeys=[{"kid":"a","publicKey":"b"}]'
refuse_ws 'duplicated kid or publicKey' --kube-version 1.33.0 --set-json \
  'workspaces.instanceSigningKeys=[{"kid":"LduU6YNgsIRbClfLYYXfg5VEWL3S5q8TsrvV01NRaic","publicKey":"vIeB87e8hCwQ5rBCgRDOAdhiVQhLPBJSuNoepr249V4"},{"kid":"LduU6YNgsIRbClfLYYXfg5VEWL3S5q8TsrvV01NRaic","publicKey":"eJruDCDhWRkOIQ6emzNVbcRU3eSRGM7oJ90NR5dQACU"}]'
# A kid that is not its key's RFC 7638 thumbprint renders (helm cannot hash to base64url), and the probe refuses it below.
helm template dp "$chart" -f "$chart/ci/values-workspaces.yaml" --kube-version 1.33.0 --set-json \
  'workspaces.instanceSigningKeys=[{"kid":"LduU6YNgsIRbClfLYYXfg5VEWL3S5q8TsrvV01NRaiX","publicKey":"vIeB87e8hCwQ5rBCgRDOAdhiVQhLPBJSuNoepr249V4"}]' > "$work/wrong-kid.yaml"
# The probe's own rules accept the rendered configuration and trust set (it would never issue a lease otherwise) and
# refuse the wrong kid.
probe_file() { docker run --rm -i mikefarah/yq:4.44.3 ea "select(.kind == \"ConfigMap\" and (.metadata.name | test(\"-isolation-probe\$\"))) | .data[\"$1\"]" < "$2"; }
probe_file probe.json "$work/workspaces.yaml" > "$work/probe.json"
probe_file instance-keys.json "$work/workspaces.yaml" > "$work/instance-keys.json"
probe_file instance-keys.json "$work/wrong-kid.yaml" > "$work/wrong-kid.json"
docker run --rm -v "$PWD/apps/isolation:/src:ro" -v "$work:/work:ro" -w /src -e GOTOOLCHAIN=local -e GOCACHE=/tmp/go-cache \
  golang:1.27.2-alpine sh -ec '
    go build -o /tmp/isolation-probe ./cmd/isolation-probe
    /tmp/isolation-probe check-config /work/probe.json
    /tmp/isolation-probe check-trust-set /work/instance-keys.json
    if /tmp/isolation-probe check-trust-set /work/wrong-kid.json 2> /tmp/wrong.log; then echo "probe accepted a kid that is not the thumbprint" >&2; exit 1; fi
    grep -Fq "is not the RFC 7638 thumbprint of its publicKey" /tmp/wrong.log'
pnpm --filter @gromesh/control-plane exec node --input-type=module - "$work/workspaces.yaml" <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseAllDocuments } from 'yaml';
const docs = parseAllDocuments(readFileSync(process.argv[2], 'utf8')).map(doc => doc.toJSON());
const pod = docs.find(r => r.kind === 'Deployment').spec.template.spec;
// Native sidecars, in this order, before the only main container (B §3.5.3, decision R9-2).
assert.deepEqual(pod.initContainers.map(c => [c.name, c.restartPolicy ?? null]), [['seed-config', null], ['isolation-install', null], ['agent', 'Always'], ['isolation-probe', 'Always']]);
assert.deepEqual(pod.containers.map(c => c.name), ['kong']);
const kong = pod.containers[0];
const probe = pod.initContainers.find(c => c.name === 'isolation-probe');
const agent = pod.initContainers.find(c => c.name === 'agent');
assert.equal(kong.command[0], '/gromesh/isolation-bin/kong-supervisor');
assert.deepEqual(kong.livenessProbe, { exec: { command: ['/gromesh/isolation-bin/kong-liveness'] }, periodSeconds: 1, timeoutSeconds: 1, failureThreshold: 1, terminationGracePeriodSeconds: 1 });
assert.equal(kong.startupProbe.periodSeconds, 1);
assert.equal(kong.env.find(e => e.name === 'KONG_PLUGINS').value, 'bundled,gromesh-workspace,gromesh-route-guard');
assert.equal(kong.env.find(e => e.name === 'GROMESH_POD_UID').valueFrom.fieldRef.fieldPath, 'metadata.uid');
assert.equal(kong.env.find(e => e.name === 'KONG_NGINX_MAIN_ENV').value, 'GROMESH_POD_UID');
// The lease: written only by the probe on its own UID, read-only in kong, absent from the agent.
const mount = (c, name) => c.volumeMounts.find(m => m.name === name);
assert.equal(mount(kong, 'isolation').readOnly, true);
assert.equal(mount(kong, 'isolation-bin').readOnly, true);
assert.ok(!mount(probe, 'isolation').readOnly);
assert.equal(mount(agent, 'isolation'), undefined);
assert.equal(mount(probe, 'kong-admin'), undefined);
assert.equal(mount(probe, 'agent-state'), undefined);
assert.notEqual(probe.securityContext.runAsUser, kong.securityContext.runAsUser);
// The trust set comes only from the chart, read-only; the old single key is gone; kong's stop record is read-only.
const env = (c, name) => c.env.find(e => e.name === name);
assert.equal(env(probe, 'GROMESH_INSTANCE_PUBLIC_KEY'), undefined);
assert.equal(env(probe, 'GROMESH_INSTANCE_KEYS').value, '/etc/gromesh/instance-keys.json');
assert.equal(env(probe, 'GROMESH_PROBE_CONFIG').value, '/etc/gromesh/probe.json');
assert.deepEqual(mount(probe, 'isolation-probe-config'), { name: 'isolation-probe-config', mountPath: '/etc/gromesh', readOnly: true });
assert.deepEqual(mount(probe, 'kong-state'), { name: 'kong-state', mountPath: '/gromesh/kong-state', readOnly: true });
assert.equal(mount(agent, 'isolation-probe-config'), undefined, 'the agent never sees the trust set it could swap');
assert.equal(mount(agent, 'kong-state'), undefined);
assert.equal(env(agent, 'GROMESH_HANDOFF_DIR').value, '/gromesh/handoff');
// Registration cannot wait for Kong in this mode: the agent declares the pinned image's version.
assert.equal(env(agent, 'GROMESH_KONG_VERSION').value, '3.9.4');
assert.equal(env(agent, 'GROMESH_POD_UID').valueFrom.fieldRef.fieldPath, 'metadata.uid');
assert.equal(env(agent, 'GROMESH_NODE_NAME').valueFrom.fieldRef.fieldPath, 'spec.nodeName');
const volume = name => pod.volumes.find(v => v.name === name);
assert.equal(volume('isolation').emptyDir.sizeLimit, '80Mi');
assert.equal(volume('isolation-handoff').emptyDir.sizeLimit, '80Mi');
assert.equal(probe.ports, undefined, 'the probe never listens');
assert.deepEqual(probe.readinessProbe, { exec: { command: ['/gromesh/isolation-bin/isolation-probe', 'ready'] }, periodSeconds: 1, timeoutSeconds: 1, failureThreshold: 1 });
assert.equal(pod.terminationGracePeriodSeconds, 30);
assert.equal(pod.shareProcessNamespace, undefined);
const probeConfigMap = docs.find(r => r.kind === 'ConfigMap' && r.metadata.name.endsWith('-isolation-probe'));
assert.equal(volume('isolation-probe-config').configMap.name, probeConfigMap.metadata.name);
assert.deepEqual(JSON.parse(probeConfigMap.data['instance-keys.json']), { keys: [{ kid: 'LduU6YNgsIRbClfLYYXfg5VEWL3S5q8TsrvV01NRaic', publicKey: 'vIeB87e8hCwQ5rBCgRDOAdhiVQhLPBJSuNoepr249V4' }] });
const config = JSON.parse(probeConfigMap.data['probe.json']);
assert.equal(new Set(config.checks.filter(c => ['tcp', 'http'].includes(c.kind)).map(c => c.capability)).size, 7);
console.log('Workspaces mode render passed: native sidecars before kong, supervisor and liveness, lease read-only in kong and absent from the agent, trust set from the chart only');
JS
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
