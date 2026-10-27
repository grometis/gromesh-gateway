#!/usr/bin/env node
// N2 environment acceptance (E §7, ENV-0..ENV-7 without our components): from a pod with the data plane's labels and
// the chart's NetworkPolicy, proves CAP-1..CAP-4 and that each protection is load-bearing (negative controls).
//   LAB_KUBECONFIG=<file> [LAB_OUT=<dir>] [DATA_PLANE_CHART=<chart dir>] node e2e/kind/n2/run.mjs
// Requires the cluster from cluster.sh. Only the lab context of LAB_KUBECONFIG is ever used.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { assertLabKubeconfig, conclusive, selects } from "./checks.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = fileURLToPath(new URL("../../../", import.meta.url));
const versions = Object.fromEntries(readFileSync(join(here, "versions.env"), "utf8").split("\n")
  .filter((line) => /^[A-Z0-9_]+=/.test(line)).map((line) => line.split(/=(.*)/s).slice(0, 2)));
const kubeconfig = process.env.LAB_KUBECONFIG;
assertLabKubeconfig(kubeconfig, homedir());
const cluster = versions.CLUSTER_NAME;
const context = `kind-${cluster}`;
const chart = process.env.DATA_PLANE_CHART ?? join(root, "deploy/helm/data-plane");
const out = process.env.LAB_OUT ?? mkdtempSync(join(tmpdir(), "gromesh-n2-lab-"));
const DP = "gromesh-dp";
const FX = "gromesh-n2-fixtures";
const ZONE = "lab.gromesh.test";
const env = { ...process.env, KUBECONFIG: kubeconfig };

function run(command, args, { input, timeout = 180_000, allowFail = false, env: extra = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { ...env, ...extra }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 || allowFail) resolve({ code, stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}: ${stderr || stdout}`));
    });
    child.stdin.end(input ?? "");
  });
}
const kubectl = (args, options) => run("kubectl", ["--kubeconfig", kubeconfig, "--context", context, ...args], options);
const docker = (args, options) => run("docker", args, options);
const json = async (args) => JSON.parse((await kubectl([...args, "-o", "json"])).stdout);
const apply = (objects) => kubectl(["apply", "-f", "-"], { input: JSON.stringify({ apiVersion: "v1", kind: "List", items: objects }) });

// cluster.sh status proves, read-only, that the context is the named kind cluster (endpoint and CA as kind exports
// them) and that it runs the pins (Kubernetes, node and Cilium digests, Cilium's effective config); it aborts otherwise.
async function assertLab() {
  const { code, stdout, stderr } = await run("bash", [join(here, "cluster.sh"), "status"], { allowFail: true, env: { LAB_KUBECONFIG: kubeconfig } });
  assert.equal(code, 0, `the lab is not the pinned kind cluster: ${stderr.trim()}`);
  return stdout;
}

// --- topology -----------------------------------------------------------------------------------------------------
async function topology() {
  const nodes = (await json(["get", "nodes"])).items.map((n) => {
    const ips = n.status.addresses.filter((a) => a.type === "InternalIP").map((a) => a.address);
    return { name: n.metadata.name, v4: ips.find((ip) => !ip.includes(":")), v6: ips.find((ip) => ip.includes(":")),
      arch: n.status.nodeInfo.architecture, kernel: n.status.nodeInfo.kernelVersion, kubelet: n.status.nodeInfo.kubeletVersion };
  });
  const workers = nodes.filter((n) => /-worker\d*$/.test(n.name)).sort((a, b) => a.name.localeCompare(b.name));
  // With one worker (WORKERS=1, a small Docker VM) the control plane is the "other node".
  const controlPlane = nodes.find((n) => n.name.endsWith("-control-plane"));
  assert.ok(workers.length >= 1 && controlPlane, "the lab needs a worker and a control plane");
  for (const n of nodes) assert.ok(n.v4 && n.v6, `node ${n.name} must have IPv4 and IPv6`);
  const network = JSON.parse((await docker(["network", "inspect", "kind"])).stdout)[0];
  const v4net = network.IPAM.Config.map((c) => c.Subnet).find((s) => !s.includes(":"));
  const v6net = network.IPAM.Config.map((c) => c.Subnet).find((s) => s.includes(":"));
  const [v4base, v4len] = v4net.split("/");
  assert.ok(Number(v4len) <= 24 && v6net.endsWith("::/64"), `unexpected kind network ${v4net} ${v6net}`);
  const p4 = v4base.split(".").slice(0, 3).join(".");
  const p6 = v6net.slice(0, -"::/64".length);
  const ip4 = (n) => `${p4}.${n}`;
  const ip6 = (n) => `${p6}::${n.toString(16)}`;
  // The declared nodeCidrs cover the first 64 addresses (where Docker places the kind nodes) and nothing else of
  // the network, so the allowed external backend can live on the same network outside them.
  const net = {
    nodeCidrs: [`${p4}.0/26`, `${p6}::/122`],
    deniedCidrs: [`${p4}.192/27`, `${p6}::c0/123`],
    nodeCidrTarget: { v4: ip4(50), v6: ip6(50) },
    imdsHost: { v4: ip4(70), v6: ip6(70) },
    backend: { v4: ip4(100), v6: ip6(100) },
    deniedTarget: { v4: ip4(200), v6: ip6(200) },
  };
  for (const n of nodes) {
    assert.ok(n.v4.startsWith(`${p4}.`) && Number(n.v4.split(".")[3]) < 64, `node ${n.name} ${n.v4} outside nodeCidrs`);
    assert.ok(parseInt(n.v6.split(":").at(-1), 16) < 64, `node ${n.name} ${n.v6} outside nodeCidrs`);
  }
  return { nodes, resident: workers[0], other: workers[1] ?? controlPlane, net };
}

// --- fixtures -----------------------------------------------------------------------------------------------------
const IMDS = { v4: ["169.254.169.254", "169.254.170.2"], v6: ["fd00:ec2::254"] };

async function externalFixtures(topo) {
  const { net } = topo;
  const fixtures = [
    { role: "backend", ip: net.backend, setup: "" },
    { role: "nodecidr", ip: net.nodeCidrTarget, setup: "" },
    { role: "denied", ip: net.deniedTarget, setup: "" },
    // The IMDS aliases live off the nodes: a target on a node interface would be the `host` entity and CAP-3's
    // negative control would really test CAP-2 (E §4.2).
    { role: "imds", ip: net.imdsHost, cap: true,
      setup: [...IMDS.v4.map((a) => `ip addr add ${a}/32 dev eth0`), ...IMDS.v6.map((a) => `ip -6 addr add ${a}/128 dev eth0`)].join(" && ") + " && " },
  ];
  for (const f of fixtures) {
    const name = `${cluster}-fx-${f.role}`;
    await docker(["rm", "-f", name], { allowFail: true });
    await docker(["run", "-d", "--name", name, "--network", "kind", "--ip", f.ip.v4, "--ip6", f.ip.v6,
      ...(f.cap ? ["--cap-add", "NET_ADMIN"] : []), "-v", `${join(here, "fixtures.mjs")}:/lab/fixtures.mjs:ro`,
      versions.FIXTURE_IMAGE, "sh", "-c", `${f.setup}exec node /lab/fixtures.mjs serve ext:${f.role} 8080 80`]);
  }
  for (const n of topo.nodes) {
    const node = n.name;
    for (const a of IMDS.v4) await docker(["exec", node, "ip", "route", "replace", `${a}/32`, "via", net.imdsHost.v4]);
    for (const a of IMDS.v6) await docker(["exec", node, "ip", "-6", "route", "replace", `${a}/128`, "via", net.imdsHost.v6]);
  }
}

function pod(namespace, name, labels, { node, command, hostNetwork = false, user } = {}) {
  return {
    apiVersion: "v1", kind: "Pod", metadata: { name, namespace, labels },
    spec: {
      nodeName: node, hostNetwork, terminationGracePeriodSeconds: 1,
      tolerations: [{ operator: "Exists" }],
      securityContext: user ? { runAsUser: user, runAsGroup: user, runAsNonRoot: true } : undefined,
      containers: [{
        name: "main", image: versions.FIXTURE_IMAGE, command,
        env: [{ name: "NODE_NAME", valueFrom: { fieldRef: { fieldPath: "spec.nodeName" } } }],
        volumeMounts: [{ name: "lab", mountPath: "/lab" }],
        securityContext: user ? { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } } : undefined,
      }],
      volumes: [{ name: "lab", configMap: { name: "n2-lab-fixtures" } }],
    },
  };
}

function service(name, selector, port, protocol = "TCP") {
  return { apiVersion: "v1", kind: "Service", metadata: { name, namespace: FX },
    spec: { selector, ipFamilyPolicy: "PreferDualStack", ports: [{ port, targetPort: port, protocol }] } };
}

async function clusterFixtures(topo) {
  await apply([DP, FX].map((name) => ({ apiVersion: "v1", kind: "Namespace", metadata: { name } })));
  for (const ns of [DP, FX]) {
    const cm = await kubectl(["-n", ns, "create", "configmap", "n2-lab-fixtures", `--from-file=fixtures.mjs=${join(here, "fixtures.mjs")}`, "--dry-run=client", "-o", "json"]);
    await kubectl(["apply", "-f", "-"], { input: cm.stdout });
  }
  const fx = (...args) => ["node", "/lab/fixtures.mjs", ...args];
  const servePod = (name, node) => pod(FX, name, { app: `n2-${name}` }, { node, command: fx("serve", name, "8080") });
  const objects = [
    servePod("outside-same", topo.resident.name),
    servePod("outside-other", topo.other.name),
    servePod("backend-ipblock", topo.other.name),
    servePod("backend-selected", topo.other.name),
    pod(FX, "dns", { app: "n2-dns" }, { node: topo.other.name, command: fx("dns", "/tmp/zone.json", "53") }),
    pod(FX, "observer", { app: "n2-observer" }, { node: topo.resident.name, command: fx("serve", "observer", "8080") }),
    service("outside-other", { app: "n2-outside-other" }, 8080),
    service("dns", { app: "n2-dns" }, 53, "UDP"),
    ...topo.nodes.map((n) => pod(FX, `hostnet-${n.name}`, { app: "n2-hostnet" },
      { node: n.name, hostNetwork: true, command: ["sh", "-c", "exec node /lab/fixtures.mjs serve hostnet:$NODE_NAME 18080"] })),
    // The probe pod: the chart's selector labels, on the resident node, non-root like the kong container.
    pod(DP, "probe", { "app.kubernetes.io/name": "data-plane", "app.kubernetes.io/instance": "dp" },
      { node: topo.resident.name, user: 1000, command: ["node", "-e", "setInterval(() => {}, 1 << 30)"] }),
  ];
  await apply(objects);
  for (const ns of [FX, DP]) await kubectl(["-n", ns, "wait", "--for=condition=Ready", "pod", "--all", "--timeout=300s"], { timeout: 320_000 });

  const podIps = async (ns, name) => (await json(["-n", ns, "get", "pod", name])).status.podIPs.map((p) => p.ip);
  const split = (ips) => ({ v4: ips.find((ip) => !ip.includes(":")), v6: ips.find((ip) => ip.includes(":")) });
  const ips = {};
  for (const name of ["outside-same", "outside-other", "backend-ipblock", "backend-selected"]) ips[name] = split(await podIps(FX, name));
  ips.probe = split(await podIps(DP, "probe"));
  ips.outsideSvc = split((await json(["-n", FX, "get", "service", "outside-other"])).spec.clusterIPs);
  ips.dnsSvc = split((await json(["-n", FX, "get", "service", "dns"])).spec.clusterIPs);
  const ciliumNode = await json(["get", "ciliumnode", topo.resident.name]);
  ips.residentCiliumHost = split(ciliumNode.spec.addresses.filter((a) => a.type === "CiliumInternalIP").map((a) => a.ip));
  for (const [key, value] of Object.entries(ips)) assert.ok(value.v4 && value.v6, `${key} must be dual-stack: ${JSON.stringify(value)}`);

  // Cluster DNS forwards the lab zone, uncached, to the lab's DNS pod: a rebinding is visible on the next lookup.
  const coredns = await json(["-n", "kube-system", "get", "configmap", "coredns"]);
  const block = `${ZONE}:53 {\n    errors\n    forward . ${ips.dnsSvc.v4}\n}\n`;
  const corefile = coredns.data.Corefile.replace(new RegExp(`${ZONE.replaceAll(".", "\\.")}:53 \\{[^}]*\\}\\n`), "");
  coredns.data.Corefile = `${corefile.trimEnd()}\n${block}`;
  await kubectl(["apply", "-f", "-"], { input: JSON.stringify(coredns) });
  await kubectl(["-n", "kube-system", "rollout", "restart", "deployment/coredns"]);
  await kubectl(["-n", "kube-system", "rollout", "status", "deployment/coredns", "--timeout=180s"]);
  return ips;
}

async function setZone(records) {
  const zone = Object.fromEntries(Object.entries(records).map(([name, value]) => [`${name}.${ZONE}`, value]));
  await kubectl(["-n", FX, "exec", "-i", "dns", "--", "sh", "-c", "cat > /tmp/zone.new && mv /tmp/zone.new /tmp/zone.json"], { input: JSON.stringify(zone) });
}

// --- targets ------------------------------------------------------------------------------------------------------
// Every target belongs to one group; a scenario says which groups are open. `allowed` groups are what the
// installation lists (the probe expects them reachable); every other group is forbidden (expected blocked).
const ALLOWED = new Set(["backendExt", "backendSelected", "backendIpblock", "dns"]);
// backendIpblock is listed the only way the chart can list an upstream (ipBlock of the pod IP); measured, not
// counted in CAP-1, because whether a CNI matches pod IPs by ipBlock is CNI-specific.
const MEASURED = new Set(["backendIpblock"]);

function targets(topo, ips) {
  const t = [];
  const both = (id, cap, group, pair, port, extra = {}) => {
    t.push({ id: `${id}.v4`, cap, group, ip: pair.v4, port, ...extra });
    t.push({ id: `${id}.v6`, cap, group, ip: pair.v6, port, ...extra });
  };
  both("cap1.pod-outside-same-node", "CAP-1", "outsidePod", ips["outside-same"], 8080, { server: "outside-same" });
  both("cap1.pod-outside-other-node", "CAP-1", "outsidePod", ips["outside-other"], 8080, { server: "outside-other" });
  both("cap1.service-outside", "CAP-1", "outsideSvc", ips.outsideSvc, 8080, { server: "outside-other" });
  both("cap1.backend-external", "CAP-1", "backendExt", topo.net.backend, 8080, { server: "ext:backend" });
  both("cap1.backend-pod-selected", "CAP-1", "backendSelected", ips["backend-selected"], 8080, { server: "backend-selected" });
  both("cap1.backend-pod-ipblock", "CAP-1", "backendIpblock", ips["backend-ipblock"], 8080, { server: "backend-ipblock" });
  for (const n of topo.nodes) {
    const role = n.name === topo.resident.name ? "resident" : n.name === topo.other.name ? "other" : "third";
    both(`cap2.node-${role}.hostnet`, "CAP-2", "node", n, 18080, { server: `hostnet:${n.name}` });
    both(`cap2.node-${role}.kubelet`, "CAP-2", "node", n, 10250, { proof: "handshake" });
  }
  both("cap2.node-resident.cilium-host", "CAP-2", "node", ips.residentCiliumHost, 18080, { server: `hostnet:${topo.resident.name}` });
  for (const family of [4, 6]) {
    t.push({ id: `cap2.node-resident.by-name.v${family}`, cap: "CAP-2", group: "node", name: `node.${ZONE}`, family, port: 18080,
      expectAddresses: [family === 4 ? topo.resident.v4 : topo.resident.v6], server: `hostnet:${topo.resident.name}` });
  }
  both("cap2.node-cidr", "CAP-2", "nodeCidr", topo.net.nodeCidrTarget, 8080, { server: "ext:nodecidr" });
  both("cap2.denied-cidr", "CAP-2", "denied", topo.net.deniedTarget, 8080, { server: "ext:denied" });
  for (const ip of [...IMDS.v4, ...IMDS.v6]) t.push({ id: `cap3.imds.${ip}`, cap: "CAP-3", group: "imds", ip, port: 80, server: "ext:imds" });
  for (const family of [4, 6]) {
    t.push({ id: `cap3.imds.by-name.v${family}`, cap: "CAP-3", group: "imds", name: `imds.${ZONE}`, family, port: 80,
      expectAddresses: family === 4 ? IMDS.v4 : IMDS.v6, server: "ext:imds" });
    // The kubernetes Service stays single-stack in a dual-stack kind cluster; a dual-stack lab Service proves both families.
    t.push({ id: `cap4.dns.cluster-service.v${family}`, cap: "CAP-4", group: "dns", kind: "dns", name: `outside-other.${FX}.svc.cluster.local`, family,
      expectAddresses: [family === 4 ? ips.outsideSvc.v4 : ips.outsideSvc.v6] });
    t.push({ id: `cap4.dns.lab-zone.v${family}`, cap: "CAP-4", group: "dns", kind: "dns", name: `backend.${ZONE}`, family,
      expectAddresses: [family === 4 ? topo.net.backend.v4 : topo.net.backend.v6] });
  }
  return t;
}

// Self-checks of the probe's classification: a failed lookup and a local error are never counted as a block.
const selfChecks = () => [
  { id: "self.dns-failure-is-not-a-block", cap: "self", group: "self", name: `nx.${ZONE}`, family: 4, port: 8080, expect: "blocked" },
  // TCP to the limited broadcast fails in the pod's own stack (ENETUNREACH); fe80::1 without a scope just times out
  // under Cilium, which would not exercise the classifier.
  { id: "self.local-error-is-not-a-block", cap: "self", group: "self", ip: "255.255.255.255", port: 8080, expect: "blocked" },
];

function zoneRecords(topo, rebind) {
  return {
    backend: { A: [topo.net.backend.v4], AAAA: [topo.net.backend.v6] },
    imds: { A: IMDS.v4, AAAA: IMDS.v6 },
    node: { A: [topo.resident.v4], AAAA: [topo.resident.v6] },
    rebind: { A: [rebind.v4], AAAA: [rebind.v6] },
  };
}

// --- policies -----------------------------------------------------------------------------------------------------
const dpSelector = { "app.kubernetes.io/name": "data-plane", "app.kubernetes.io/instance": "dp" };
const ccnpSelector = { matchLabels: { ...dpSelector, "k8s:io.kubernetes.pod.namespace": DP } };
const ccnp = (name, egressDeny) => ({
  apiVersion: "cilium.io/v2", kind: "CiliumClusterwideNetworkPolicy", metadata: { name },
  // Deny-only policies must not switch the pod to default deny: each layer is tested on its own.
  spec: { endpointSelector: ccnpSelector, enableDefaultDeny: { egress: false, ingress: false }, egressDeny },
});

async function chartPolicy(topo, ips, { dns = true } = {}) {
  const upstreams = [
    [topo.net.backend.v4, 32], [topo.net.backend.v6, 128], [ips["backend-ipblock"].v4, 32], [ips["backend-ipblock"].v6, 128],
  ].flatMap(([ip, len], i) => ["--set", `networkPolicy.upstreams[${i}].cidr=${ip}/${len}`, "--set", `networkPolicy.upstreams[${i}].ports={8080}`]);
  const rendered = await run("helm", ["template", "dp", chart, "-f", join(here, "values-netpol.yaml"), ...upstreams,
    ...(dns ? [] : ["--set", "networkPolicy.dnsPeers=null"]), "--show-only", "templates/networkpolicy.yaml"]);
  return { yaml: rendered.stdout.replace(/^---\n/, "").replace(/^# Source.*\n/m, "") };
}

function policies(topo) {
  const net = topo.net;
  return {
    labNp: { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: { name: "n2-lab-backend-selected", namespace: DP },
      spec: { podSelector: { matchLabels: dpSelector }, policyTypes: ["Egress"],
        egress: [{ to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": FX } }, podSelector: { matchLabels: { app: "n2-backend-selected" } } }],
          ports: [{ protocol: "TCP", port: 8080 }] }] } },
    denyHost: ccnp("n2-deny-host", [{ toEntities: ["host", "remote-node"] }]),
    denyImds: ccnp("n2-deny-imds", [{ toCIDR: ["169.254.169.254/32", "169.254.170.2/32", "fd00:ec2::254/128"] }]),
    denyCidrs: ccnp("n2-deny-cidrs", [{ toCIDR: [...net.nodeCidrs, ...net.deniedCidrs] }]),
    // An operator's additive allow-everything: the denies must still win (R5).
    additiveCnp: { apiVersion: "cilium.io/v2", kind: "CiliumNetworkPolicy", metadata: { name: "n2-additive-allow-all", namespace: DP },
      spec: { endpointSelector: { matchLabels: dpSelector }, egress: [{ toEntities: ["all"] }] } },
    additiveNp: { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: { name: "n2-additive-allow-all", namespace: DP },
      spec: { podSelector: { matchLabels: dpSelector }, policyTypes: ["Egress"], egress: [{ to: [{ ipBlock: { cidr: "0.0.0.0/0" } }, { ipBlock: { cidr: "::/0" } }] }] } },
  };
}

async function setPolicies(topo, ips, set) {
  const all = policies(topo);
  const wanted = Object.entries(all).filter(([key]) => set.includes(key)).map(([, o]) => o);
  for (const [key, o] of Object.entries(all)) {
    if (set.includes(key)) continue;
    const kind = o.kind === "NetworkPolicy" ? "networkpolicy" : o.kind === "CiliumNetworkPolicy" ? "ciliumnetworkpolicy" : "ciliumclusterwidenetworkpolicy";
    await kubectl([...(o.metadata.namespace ? ["-n", o.metadata.namespace] : []), "delete", kind, o.metadata.name, "--ignore-not-found", "--wait"]);
  }
  if (set.includes("chartNp") || set.includes("chartNpNoDns")) {
    await kubectl(["apply", "-f", "-", "-n", DP], { input: (await chartPolicy(topo, ips, { dns: set.includes("chartNp") })).yaml });
  } else {
    await kubectl(["-n", DP, "delete", "networkpolicy", "dp-data-plane", "--ignore-not-found", "--wait"]);
  }
  if (wanted.length) await apply(wanted);
}

// --- probing ------------------------------------------------------------------------------------------------------
async function probe(list) {
  const { stdout } = await kubectl(["-n", DP, "exec", "-i", "probe", "--", "node", "/lab/fixtures.mjs", "probe"], { input: JSON.stringify(list), timeout: 60_000 });
  // The probe pod answers per target id; the scenario's view of a target (its group) stays on this side.
  const byId = new Map(list.map((t) => [t.id, t]));
  return JSON.parse(stdout).map((r) => ({ ...r, group: r.group ?? byId.get(r.id)?.group }));
}

const reached = (r) => r.results?.some((x) => ["reach", "handshake", "connected-no-reply", "connected-bad-reply", "reset-after-connect"].includes(x.outcome))
  || (r.outcome === "resolved");

function capVerdicts(results) {
  const caps = {};
  for (const r of results) {
    if (r.cap === "self" || MEASURED.has(r.group)) continue;
    const prev = caps[r.cap] ?? "pass";
    caps[r.cap] = prev === "fail" || r.verdict === "fail" ? "fail" : prev === "inconclusive" || r.verdict === "inconclusive" ? "inconclusive" : "pass";
  }
  return caps;
}

// Runs the probe until two consecutive rounds match the scenario (policy changes are asynchronous), at most 60 s.
async function converge(list, matches) {
  const started = Date.now();
  let streak = 0;
  let rounds = 0;
  let last;
  while (Date.now() - started < 60_000) {
    rounds++;
    last = await probe(list);
    const mismatches = matches(last);
    if (mismatches.length === 0) {
      if (++streak === 2) return { ok: true, rounds, ms: Date.now() - started, results: last, mismatches };
    } else streak = 0;
    await sleep(1_000);
  }
  return { ok: false, rounds, ms: Date.now() - started, results: last, mismatches: matches(last) };
}

const groupsOf = (list) => [...new Set(list.map((t) => t.group))];
const ALL_FORBIDDEN = ["outsidePod", "outsideSvc", "node", "nodeCidr", "denied", "imds"];
const SCENARIOS = [
  { id: "S0-no-policy", what: "baseline without any policy: every fixture is live and reachable",
    policies: [], open: [...ALL_FORBIDDEN, "backendExt", "backendSelected", "backendIpblock"], caps: { "CAP-1": "fail", "CAP-2": "fail", "CAP-3": "fail", "CAP-4": "pass" },
    rebind: ["outsidePod", "imds", "nodeCidr"] },
  { id: "S1-protected", what: "chart NetworkPolicy + lab selector NP + host/IMDS/CIDR denies",
    policies: ["chartNp", "labNp", "denyHost", "denyImds", "denyCidrs"], open: ["backendExt", "backendSelected"],
    caps: { "CAP-1": "pass", "CAP-2": "pass", "CAP-3": "pass", "CAP-4": "pass" }, rebind: ["outsidePod", "imds", "nodeCidr"] },
  { id: "S2-additive-allow", what: "S1 + an additive allow-all (CNP toEntities all + NP 0.0.0.0/0, ::/0): denies still win (R5)",
    policies: ["chartNp", "labNp", "denyHost", "denyImds", "denyCidrs", "additiveCnp", "additiveNp"],
    open: ["outsidePod", "outsideSvc", "backendExt", "backendSelected", "backendIpblock"],
    caps: { "CAP-1": "fail", "CAP-2": "pass", "CAP-3": "pass", "CAP-4": "pass" }, rebind: ["imds", "nodeCidr"] },
  { id: "S3-control-no-host-deny", what: "S2 without only the host deny: nodes and hostNetwork reachable",
    policies: ["chartNp", "labNp", "denyImds", "denyCidrs", "additiveCnp", "additiveNp"],
    open: ["outsidePod", "outsideSvc", "backendExt", "backendSelected", "backendIpblock", "node"], caps: { "CAP-2": "fail", "CAP-3": "pass" } },
  { id: "S4-control-no-imds-deny", what: "S2 without only the IMDS deny: the off-node IMDS aliases reachable (by IP and name)",
    policies: ["chartNp", "labNp", "denyHost", "denyCidrs", "additiveCnp", "additiveNp"],
    open: ["outsidePod", "outsideSvc", "backendExt", "backendSelected", "backendIpblock", "imds"], caps: { "CAP-2": "pass", "CAP-3": "fail" },
    rebind: ["imds"] },
  { id: "S5-control-no-cidr-deny", what: "S2 without only the nodeCidrs/deniedCidrs deny",
    policies: ["chartNp", "labNp", "denyHost", "denyImds", "additiveCnp", "additiveNp"],
    open: ["outsidePod", "outsideSvc", "backendExt", "backendSelected", "backendIpblock", "nodeCidr", "denied"], caps: { "CAP-2": "fail", "CAP-3": "pass" } },
  { id: "S6-control-no-networkpolicy", what: "denies only, without the chart NetworkPolicy: pods outside the list reachable",
    policies: ["denyHost", "denyImds", "denyCidrs"], open: ["outsidePod", "outsideSvc", "backendExt", "backendSelected", "backendIpblock"],
    caps: { "CAP-1": "fail", "CAP-2": "pass", "CAP-3": "pass" } },
  { id: "S7-dns-denied", what: "S1 with the chart's DNS peers removed: name targets are inconclusive, never a pass",
    policies: ["chartNpNoDns", "labNp", "denyHost", "denyImds", "denyCidrs"], open: ["backendExt", "backendSelected"],
    caps: { "CAP-1": "pass", "CAP-2": "inconclusive", "CAP-3": "inconclusive", "CAP-4": "inconclusive" }, names: "dns-error" },
  { id: "S8-measure-standard-np-only", what: "measured: chart NP + NP 0.0.0.0/0, ::/0, no Cilium deny (what a standard allow opens)",
    policies: ["chartNp", "labNp", "additiveNp"], measure: true },
];

// A target the probe could not even attempt carries its outcome (and the reason) on the target itself.
const outcomes = (r) => r.results?.map((x) => x.outcome).join(",") ?? `${r.outcome ?? r.verdict}${r.error ? ` (${r.error})` : ""}`;

function scenarioMatcher(scenario, list) {
  const open = new Set(scenario.open);
  const byId = new Map(list.map((t) => [t.id, t]));
  return (results) => results.filter((r) => r.cap !== "self" && !MEASURED.has(r.group) && r.group !== "dns").flatMap((r) => {
    if (scenario.names === "dns-error" && r.id.includes("by-name")) {
      return r.results[0].outcome === "dns-error" ? [] : [`${r.id}: expected a DNS failure, got ${r.results[0].outcome}`];
    }
    return conclusive(byId.get(r.id), r, open.has(r.group)) ? [] : [`${r.id}: ${open.has(r.group) ? "expected reachable" : "expected blocked"}, got ${outcomes(r)}`];
  });
}

async function rebinding(topo, ips, scenario) {
  const phases = [{ group: "backendExt", pair: topo.net.backend, server: "ext:backend" },
    ...scenario.rebind.map((group) => ({
      outsidePod: { group, pair: ips["outside-other"], server: "outside-other" },
      imds: { group, pair: { v4: IMDS.v4[0], v6: IMDS.v6[0] }, server: "ext:imds" },
      nodeCidr: { group, pair: topo.net.nodeCidrTarget, server: "ext:nodecidr" },
    })[group])];
  const open = new Set(scenario.open);
  const report = [];
  for (const phase of phases) {
    await setZone(zoneRecords(topo, phase.pair));
    const list = [4, 6].map((family) => ({ id: `cap4.rebind-to-${phase.group}.v${family}`, cap: phase.group === "backendExt" ? "CAP-1" : "CAP-4", group: phase.group,
      name: `rebind.${ZONE}`, family, port: phase.group === "imds" ? 80 : 8080, expectAddresses: [family === 4 ? phase.pair.v4 : phase.pair.v6],
      server: phase.server, expect: ALLOWED.has(phase.group) ? "reach" : "blocked" }));
    // Every round must resolve to the new answer (a stale one is a mismatch) and then be conclusive for the group:
    // a DNS failure or a local error never stands in for a block, in a protected scenario or a negative control.
    const result = await converge(list, (rs) => rs.flatMap((r) => r.results[0].outcome === "dns-unexpected" ? [`${r.id}: stale answer`]
      : conclusive(list.find((t) => t.id === r.id), r, open.has(phase.group)) ? [] : [`${r.id}: ${open.has(phase.group) ? "expected reachable" : "expected blocked"}, got ${outcomes(r)}`]));
    const verdicts = Object.fromEntries(result.results.map((r) => [r.id, r.verdict]));
    report.push({ phase: phase.group, open: open.has(phase.group), ok: result.ok, rounds: result.rounds, ms: result.ms, verdicts, results: result.results, mismatches: result.mismatches });
  }
  await setZone(zoneRecords(topo, topo.net.backend));
  return report;
}

// ENV-7: time from the policy change (client clock, before kubectl) to the first probe attempt in the new state.
async function effectLatency(target, removePolicy, restorePolicy, repetitions = 5) {
  const watch = async (state, action) => {
    const child = spawn("kubectl", ["--kubeconfig", kubeconfig, "--context", context, "-n", DP, "exec", "probe", "--", "node", "/lab/fixtures.mjs", "watch", target.ip, String(target.port), state, "60000", ...(target.server ? [target.server] : [])], { env });
    let text = "";
    const done = new Promise((resolve) => child.on("close", resolve));
    const ready = new Promise((resolve) => child.stdout.on("data", (d) => { text += d; if (text.includes("ready\n")) resolve(); }));
    // The watch only says ready once the opposite state is confirmed; otherwise it exits saying what it saw.
    await Promise.race([ready, done]);
    assert.ok(text.includes("ready\n"), `watch ${state} on ${target.ip}:${target.port}: the initial state is not the opposite one: ${text.trim()}`);
    const t0 = Date.now();
    await action();
    const t1 = Date.now();
    await done;
    const last = text.trim().split("\n").at(-1);
    assert.ok(/^\d+$/.test(last), `watch ${state} on ${target.ip}:${target.port} did not observe the change: ${text}`);
    return { ms: Number(last) - t0, kubectlMs: t1 - t0 };
  };
  const samples = [];
  for (let i = 0; i < repetitions; i++) {
    const open = await watch("reach", removePolicy);
    const close = await watch("blocked", restorePolicy);
    samples.push({ openMs: open.ms, closeMs: close.ms, kubectlOpenMs: open.kubectlMs, kubectlCloseMs: close.kubectlMs });
  }
  const stats = (key) => { const v = samples.map((s) => s[key]).sort((a, b) => a - b); return { p50: v[Math.floor(v.length / 2)], max: v.at(-1), min: v[0] }; };
  return { target, samples, open: stats("openMs"), close: stats("closeMs") };
}

// --- main ---------------------------------------------------------------------------------------------------------
const environment = await assertLab();
const startedAt = new Date().toISOString();
const topo = await topology();
const bootIds = {};
for (const n of topo.nodes) bootIds[n.name] = (await docker(["exec", n.name, "cat", "/proc/sys/kernel/random/boot_id"])).stdout.trim();
await externalFixtures(topo);
const ips = await clusterFixtures(topo);
await setZone(zoneRecords(topo, topo.net.backend));
const base = targets(topo, ips).map((t) => ({ ...t, expect: ALLOWED.has(t.group) ? "reach" : "blocked" }));
// versions are the pins; environment is what cluster.sh status observed after checking the cluster against them.
const report = { startedAt, versions, environment, topology: topo, ips, bootIds, scenarios: [], failures: [] };

// Every forbidden target must be live from a pod without any policy: an "unreachable" must never be mere absence.
await setPolicies(topo, ips, []);
{
  const live = base.filter((t) => !t.kind).map((t) => ({ ...t, expect: "reach" }));
  const { stdout } = await kubectl(["-n", FX, "exec", "-i", "observer", "--", "node", "/lab/fixtures.mjs", "probe"], { input: JSON.stringify(live), timeout: 60_000 });
  const results = JSON.parse(stdout);
  const dead = results.filter((r) => r.verdict !== "pass").map((r) => `${r.id}: ${r.results.map((x) => x.outcome).join(",")}`);
  report.liveness = { ok: dead.length === 0, dead };
  if (dead.length) report.failures.push(`liveness from the unrestricted observer: ${dead.join("; ")}`);
}

for (const scenario of SCENARIOS) {
  await setPolicies(topo, ips, scenario.policies);
  const list = [...base, ...selfChecks()];
  const entry = { id: scenario.id, what: scenario.what, policies: scenario.policies };
  if (scenario.measure) {
    await sleep(5_000);
    const results = await probe(list);
    entry.measured = Object.fromEntries(groupsOf(base).map((g) => [g, results.filter((r) => r.group === g).map((r) => `${r.id}=${reached(r) ? "reach" : r.results?.map((x) => x.outcome).join(",") ?? r.outcome}`)]));
    entry.results = results;
  } else {
    const result = await converge(list, scenarioMatcher(scenario, list));
    entry.converged = result.ok;
    entry.rounds = result.rounds;
    entry.ms = result.ms;
    entry.mismatches = result.mismatches;
    entry.caps = capVerdicts(result.results);
    entry.results = result.results;
    entry.measuredIpblock = result.results.filter((r) => MEASURED.has(r.group)).map((r) => `${r.id}=${reached(r) ? "reach" : outcomes(r)}`);
    if (!result.ok) report.failures.push(`${scenario.id}: did not converge: ${result.mismatches.join("; ")}`);
    for (const [cap, expected] of Object.entries(scenario.caps)) {
      if (entry.caps[cap] !== expected) report.failures.push(`${scenario.id}: ${cap} verdict ${entry.caps[cap]}, expected ${expected}`);
    }
    for (const s of result.results.filter((r) => r.cap === "self")) {
      const outcome = s.results[0].outcome;
      const expected = s.id.includes("dns") ? "dns-error" : "local-error";
      if (s.verdict !== "inconclusive" || outcome !== expected) report.failures.push(`${scenario.id}: ${s.id} gave ${outcome}/${s.verdict}`);
    }
    if (scenario.rebind) {
      entry.rebinding = await rebinding(topo, ips, scenario);
      for (const phase of entry.rebinding.filter((p) => !p.ok)) report.failures.push(`${scenario.id}: rebinding to ${phase.phase}: ${phase.mismatches.join("; ")}`);
    }
  }
  report.scenarios.push(entry);
  console.log(`${scenario.id}: ${scenario.measure ? "measured" : entry.converged ? `ok in ${entry.rounds} rounds/${entry.ms} ms` : "MISMATCH"} ${JSON.stringify(entry.caps ?? entry.measured)}`);
  for (const m of entry.mismatches ?? []) console.log(`  ${m}`);
  // Written after every scenario: a later failure keeps the evidence gathered so far.
  writeFileSync(join(out, "results.json"), JSON.stringify(report, null, 2));
}

// ENV-7 on the protected state: the chart NetworkPolicy (CAP-1) and the IMDS deny with the additive allow on (CAP-3).
// Only the chart NetworkPolicy selects the pod here: with the lab's own NP also selecting it, deleting the chart's
// would leave the pod isolated and nothing would open.
await setPolicies(topo, ips, ["chartNp", "denyHost", "denyImds", "denyCidrs"]);
// What opens on delete must be the chart policy's doing: it is the only NetworkPolicy here, it is an Egress policy,
// and its selector, as applied, selects the probe pod (same namespace, labels as the API returns them).
{
  const probePod = await json(["-n", DP, "get", "pod", "probe"]);
  const applied = (await json(["-n", DP, "get", "networkpolicy"])).items;
  assert.deepEqual(applied.map((p) => p.metadata.name), ["dp-data-plane"], "ENV-7 needs the chart NetworkPolicy alone");
  const [chartNp] = applied;
  assert.ok(chartNp.spec.policyTypes.includes("Egress"), "the chart NetworkPolicy is not an Egress policy");
  assert.ok(selects(chartNp.spec.podSelector, probePod.metadata.labels),
    `the chart NetworkPolicy selector ${JSON.stringify(chartNp.spec.podSelector)} does not select the probe ${JSON.stringify(probePod.metadata.labels)}`);
  report.chartSelector = { podSelector: chartNp.spec.podSelector, probeLabels: probePod.metadata.labels, selects: true };
}
const np = (await chartPolicy(topo, ips)).yaml;
report.latency = [await effectLatency({ ip: ips["outside-other"].v4, port: 8080, server: "outside-other", what: "delete/apply chart NetworkPolicy, pod outside the list" },
  () => kubectl(["-n", DP, "delete", "networkpolicy", "dp-data-plane"]), () => kubectl(["-n", DP, "apply", "-f", "-"], { input: np }))];
await setPolicies(topo, ips, ["chartNp", "labNp", "denyHost", "denyImds", "denyCidrs", "additiveCnp", "additiveNp"]);
assert.ok((await converge(base, scenarioMatcher(SCENARIOS[2], base))).ok, "S2 state did not converge before ENV-7");
const imdsDeny = policies(topo).denyImds;
report.latency.push(await effectLatency({ ip: IMDS.v4[0], port: 80, server: "ext:imds", what: "delete/apply the IMDS deny with an additive allow-all present" },
  () => kubectl(["delete", "ciliumclusterwidenetworkpolicy", "n2-deny-imds"]), () => apply([imdsDeny])));

// Leave the lab in the protected state, the zone pointing at the allowed backend.
await setPolicies(topo, ips, ["chartNp", "labNp", "denyHost", "denyImds", "denyCidrs"]);
report.finishedAt = new Date().toISOString();
writeFileSync(join(out, "results.json"), JSON.stringify(report, null, 2));
for (const l of report.latency) console.log(`ENV-7 ${l.target.what}: open p50 ${l.open.p50} ms max ${l.open.max} ms; close p50 ${l.close.p50} ms max ${l.close.max} ms`);
console.log(`results: ${join(out, "results.json")}`);
if (report.failures.length) {
  console.error(report.failures.join("\n"));
  process.exit(1);
}
console.log("N2 lab: every guarantee held and every negative control failed as required");
