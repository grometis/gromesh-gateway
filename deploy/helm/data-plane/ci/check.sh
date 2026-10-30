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
# No registration credentials at all: refused, never rendered without them.
if helm template dp "$chart" > /dev/null 2> "$work/missing-token.log"; then
  echo 'Chart unexpectedly accepted missing registration credentials' >&2
  exit 1
fi
grep -q 'Set agent.existingSecret' "$work/missing-token.log"
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
refuse_ws 'no forbidden target for CAP-3' --kube-version 1.33.0 --set 'workspaces.probe.checks[2].kind=tcp-open'
refuse_ws 'must differ from kong.runAsUser' --kube-version 1.33.0 --set workspaces.probe.runAsUser=1001
refuse_ws 'workspaces.clusterId' --kube-version 1.33.0 --set-string workspaces.clusterId=nope
refuse_ws 'workspaces.instanceId' --kube-version 1.33.0 --set-string workspaces.instanceId=
refuse_ws 'workspaces.instanceId' --kube-version 1.33.0 --set-string workspaces.instanceId=6A1F3C2E-0B7D-4C1A-9F10-0000000000A1
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
// One instance id for both: the agent refuses another instance's deployment, the probe binds applied.json to it.
assert.equal(env(agent, 'GROMESH_INSTANCE_ID').value, '6a1f3c2e-0b7d-4c1a-9f10-0000000000a1');
assert.equal(env(probe, 'GROMESH_INSTANCE_ID').value, '6a1f3c2e-0b7d-4c1a-9f10-0000000000a1');
// Registration cannot wait for Kong in this mode: seed-config (the Kong image) writes the version Kong reports, and
// only the agent reads it; no chart value feeds it.
const seed = pod.initContainers.find(c => c.name === 'seed-config');
assert.match(seed.args[0], /luajit -e 'io\.write\(dofile\("\/usr\/local\/share\/lua\/5\.1\/kong\/meta\.lua"\)\._VERSION\)' > \/gromesh\/kong-version\/version/);
assert.equal(seed.image, kong.image);
assert.deepEqual(mount(seed, 'kong-version'), { name: 'kong-version', mountPath: '/gromesh/kong-version' });
assert.deepEqual(mount(agent, 'kong-version'), { name: 'kong-version', mountPath: '/gromesh/kong-version', readOnly: true });
assert.equal(mount(kong, 'kong-version'), undefined);
assert.equal(mount(probe, 'kong-version'), undefined);
assert.equal(env(agent, 'GROMESH_KONG_VERSION_FILE').value, '/gromesh/kong-version/version');
assert.equal(env(agent, 'GROMESH_KONG_VERSION'), undefined);
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
# Workspaces mode with the analytics collector: only as the pod's own sidecar (N2-X4, B §3.5.2).
collector_sidecar=(--kube-version 1.33.0 --set collector.enabled=true --set collector.mode=sidecar
  --set-string collector.clusterId=6a1f3c2e-0b7d-4c1a-9f10-0000000000c1 --set-string collector.environmentId=6a1f3c2e-0b7d-4c1a-9f10-0000000000e1
  --set-string collector.clickhouse.existingSecret=clickhouse-writer)
helm lint "$chart" --strict -f "$chart/ci/values-workspaces.yaml" "${collector_sidecar[@]}"
helm template dp "$chart" -f "$chart/ci/values-workspaces.yaml" "${collector_sidecar[@]}" > "$work/workspaces-collector.yaml"
refuse_ws 'only as the pod' "${collector_sidecar[@]}" --set collector.mode=deployment
refuse_ws 'must equal workspaces.clusterId' "${collector_sidecar[@]}" --set-string collector.clusterId=6a1f3c2e-0b7d-4c1a-9f10-0000000000c2
refuse_ws 'clickhousePeers' "${collector_sidecar[@]}" --set networkPolicy.enabled=true --set-json 'networkPolicy.controlPlanePeers=[{"ipBlock":{"cidr":"10.0.0.0/8"}}]'
refuse_ws '/collector/mode' "${collector_sidecar[@]}" --set collector.mode=daemonset
refuse 'Workspaces-mode layout' -f "$chart/ci/values-full.yaml" --set collector.mode=sidecar
pnpm --filter @gromesh/control-plane exec node --input-type=module - "$work/workspaces-collector.yaml" "$work/workspaces.yaml" "$work/full.yaml" "$work/default.yaml" <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseAllDocuments } from 'yaml';
const read = path => parseAllDocuments(readFileSync(path, 'utf8')).map(doc => doc.toJSON()).filter(Boolean);
const [docs, ...others] = process.argv.slice(2).map(read);
const pod = docs.find(r => r.kind === 'Deployment').spec.template.spec;
// Started last of the sidecars, so on deletion it is signalled only after kong exited and drains its events.
assert.deepEqual(pod.initContainers.map(c => [c.name, c.restartPolicy ?? null]), [['seed-config', null], ['isolation-install', null], ['agent', 'Always'], ['isolation-probe', 'Always'], ['collector', 'Always']]);
assert.deepEqual(docs.filter(r => ['Deployment', 'Service'].includes(r.kind)).map(r => r.metadata.name).sort(), ['dp-data-plane', 'dp-data-plane'], 'no collector Deployment nor gromesh-collector Service');
const collector = pod.initContainers.find(c => c.name === 'collector');
const kong = pod.containers[0];
const env = (c, name) => (c.env ?? []).find(e => e.name === name);
assert.equal(env(collector, 'GROMESH_COLLECTOR_ADDRESS').value, '127.0.0.1:8080');
assert.equal(env(collector, 'GROMESH_COLLECTOR_METRICS_ADDRESS').value, '127.0.0.1:9598');
assert.equal(env(collector, 'GROMESH_POD_UID').valueFrom.fieldRef.fieldPath, 'metadata.uid');
assert.equal(env(collector, 'GROMESH_CLUSTER_ID').value, '6a1f3c2e-0b7d-4c1a-9f10-0000000000c1');
assert.equal(collector.ports, undefined, 'nothing to publish: it listens on loopback only');
assert.equal(collector.readinessProbe, undefined, 'analytics never takes the gateway out of service');
assert.deepEqual(collector.livenessProbe.exec.command, ['wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:9598/metrics']);
assert.ok(![1001, 1002].includes(collector.securityContext.runAsUser), 'the collector shares no UID with kong, agent or probe');
assert.equal(pod.shareProcessNamespace, undefined);
// Credentials: the token only in kong and the collector, the ClickHouse writer password only in the collector.
const holders = name => [...pod.initContainers, ...pod.containers].filter(c => env(c, name)).map(c => c.name).sort();
assert.deepEqual(holders('GROMESH_COLLECTOR_TOKEN'), ['collector', 'kong']);
assert.deepEqual(holders('CLICKHOUSE_PASSWORD'), ['collector']);
// Kong's nginx workers see both the pod uid (route guard) and the token (http-log vault reference), in one variable.
for (const [index, render] of [docs, ...others].entries()) {
  const main = render.find(r => r.kind === 'Deployment' && r.spec.template.spec.containers[0].name === 'kong').spec.template.spec.containers[0].env.filter(e => e.name === 'KONG_NGINX_MAIN_ENV');
  assert.ok(main.length <= 1, `render ${index}: at most one KONG_NGINX_MAIN_ENV (a second would replace the first)`);
}
assert.equal(env(kong, 'KONG_NGINX_MAIN_ENV').value, 'GROMESH_POD_UID; env GROMESH_COLLECTOR_TOKEN');
const checks = JSON.parse(docs.find(r => r.kind === 'ConfigMap' && r.metadata.name.endsWith('-isolation-probe')).data['probe.json']).checks;
assert.deepEqual(checks.find(c => c.capability === 'CAP-7'), { capability: 'CAP-7', kind: 'http', name: 'collector token', url: 'http://127.0.0.1:8080/kong', expectStatus: 401, method: 'POST' });
const volume = name => pod.volumes.find(v => v.name === name);
assert.equal(volume('collector-config').configMap.name, 'dp-data-plane-collector');
assert.equal(volume('collector-data').emptyDir.sizeLimit, '64Mi');
console.log('Collector sidecar render passed: last native sidecar, loopback only, no Service, token in kong and collector only, writer password in the collector only');
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
# Privileged destinations (N2-E9, control 1): no shipped values and no rendered NetworkPolicy allow egress that
# reaches the cloud metadata service or link-local (overlap computed, not a text prefix), nor any address; the lab's
# IMDS exception lives only in the kind suite. The Workspaces render enables the policy and must contain it.
privileged_overlap() {
  node -e '
    const { BlockList } = require("node:net");
    // Two CIDRs overlap iff one contains the network address of the other.
    const forbidden = ["169.254.0.0/16", "fe80::/10", "fd00:ec2::254/128"];
    const parse = (cidr) => { const [addr, bits] = cidr.split("/"); const v6 = addr.includes(":"); return { addr, bits: Number(bits ?? (v6 ? 128 : 32)), type: v6 ? "ipv6" : "ipv4" }; };
    const contains = (outer, inner) => { const list = new BlockList(); list.addSubnet(outer.addr, outer.bits, outer.type); return list.check(inner.addr, inner.type); };
    const bad = [];
    for (const cidr of process.argv.slice(1)) {
      const c = parse(cidr);
      if (c.bits === 0 || forbidden.map(parse).some((f) => f.type === c.type && (contains(f, c) || contains(c, f)))) bad.push(cidr);
    }
    if (bad.length) { console.error(bad.join(" ")); process.exit(1); }' -- "$@"
}
for values in "$chart"/values.yaml "$chart"/ci/*.yaml; do
  allowed="$(docker run --rm -i mikefarah/yq:4.44.3 ea '[.networkPolicy | .. | select(has("cidr")) | .cidr] | join(" ")' < "$values")"
  # shellcheck disable=SC2086
  privileged_overlap $allowed || { echo "$values allows egress to a metadata, link-local or any address" >&2; exit 1; }
done
peers='[{"namespaceSelector":{"matchLabels":{"kubernetes.io/metadata.name":"gromesh"}}}]'
helm template dp "$chart" -f "$chart/ci/values-workspaces.yaml" --set networkPolicy.enabled=true --set-json "networkPolicy.controlPlanePeers=$peers" \
  --set-json "networkPolicy.clickhousePeers=$peers" --set-json "networkPolicy.collectorPeers=$peers" --kube-version 1.33.0 > "$work/workspaces-np.yaml"
[[ "$(docker run --rm -i mikefarah/yq:4.44.3 ea '[select(.kind == "NetworkPolicy")] | length' < "$work/workspaces-np.yaml")" -ge 1 ]] || { echo 'Workspaces render without a NetworkPolicy' >&2; exit 1; }
for render in full homelab workspaces-np; do
  cidrs="$(docker run --rm -i mikefarah/yq:4.44.3 ea '[select(.kind == "NetworkPolicy") | .spec.egress[]?.to[]?.ipBlock.cidr | select(. != null)] | join(" ")' < "$work/$render.yaml")"
  # shellcheck disable=SC2086
  privileged_overlap $cidrs || { echo "NetworkPolicy ($render) allows egress to a metadata, link-local or any address" >&2; exit 1; }
done
