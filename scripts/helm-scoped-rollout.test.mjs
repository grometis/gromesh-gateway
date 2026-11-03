import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, mkdtempSync, writeFileSync, rmSync, cpSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { parseArgs, scopedRollout, assertUpgradeCommand } from "./helm-scoped-rollout.mjs";

const image = n => `registry.example/gromesh-ui@sha256:${n.repeat(64)}`;
const ca = Buffer.from("fixture CA").toString("base64");
const options = () => ({
  release: "cp", namespace: "dev", kubeContext: "lab", kubeconfig: "/tmp/explicit-config",
  expectedCluster: "lab-cluster", expectedUid: "cluster-uid",
  expectedCaSha256: createHash("sha256").update(Buffer.from(ca, "base64")).digest("hex"),
  chart: "deploy/helm/control-plane", deployment: "cp-control-plane-ui", container: "ui",
  image: image("b"), imageValuesPrefix: "ui.image", noHooks: true, authorizedHooks: [],
  objectUids: baselineUids(), rollbackRevision: 4, mode: "plan", overrides: [],
  verifyImageCommand: ["image-proof", "{image}", "{kubeconfig}", "{context}", "{namespace}"],
});
const resource = (kind, name, extra = {}) => ({
  apiVersion: kind === "Deployment" ? "apps/v1" : "v1", kind, metadata: { name }, ...extra,
});
const deployment = (name, container, img) => resource("Deployment", name, {
  spec: { replicas: 2, selector: { matchLabels: { app: name, "app.kubernetes.io/instance": "cp" } },
    template: { metadata: { labels: { app: name, "app.kubernetes.io/instance": "cp" } },
      spec: { containers: [{ name: container, image: img }] } } },
});
const list = items => JSON.stringify({ apiVersion: "v1", kind: "List", items });
function hook(name = "cp-control-plane-migrate", events = ["pre-install", "pre-upgrade"]) {
  return { name, kind: "Job", events, manifest: JSON.stringify(resource("Job", name, {
    metadata: { name, annotations: { "helm.sh/hook": events.join(",") } },
    spec: { template: { spec: { containers: [{ name: "migrate", image: "cp:unchanged", command: ["node", "dist/db/migrate-cli.js"] }] } } },
  })) };
}
const baselineUids = () => [
  ["Deployment", "cp-control-plane-ui"], ["Deployment", "cp-control-plane"], ["Secret", "credentials"], ["PersistentVolumeClaim", "backups"],
  ["ConfigMap", "operational"], ["Service", "api"], ["NetworkPolicy", "ingress"], ["CronJob", "backup"],
].map(([kind, name]) => ({ kind, name, namespace: "dev", uid: `uid-${name}` }));
function renderedObjectUids(f, o) {
  f.live = structuredClone(f.current);
  for (const obj of f.live) {
    const namespace = obj.metadata.namespace ?? o.namespace;
    Object.assign(obj.metadata, { namespace, uid: `uid-${obj.kind}-${namespace}-${obj.metadata.name}`, resourceVersion: "1" });
  }
  // Service and NetworkPolicy can share the authorized Deployment's name.
  return f.live.map(v => ({ kind: v.kind, name: v.metadata.name, namespace: v.metadata.namespace, uid: v.metadata.uid }));
}
const authorize = (h, classification = "migration/job") => ({ name: h.name, kind: h.kind, events: h.events,
  classification, manifestSha256: createHash("sha256").update(h.manifest).digest("hex") });
function fixture() {
  const current = [deployment("cp-control-plane-ui", "ui", image("a")), deployment("cp-control-plane", "control-plane", "cp:unchanged"),
    resource("Secret", "credentials", { data: { password: "PRIVATE_VALUE" } }),
    resource("PersistentVolumeClaim", "backups", { spec: { resources: { requests: { storage: "1Gi" } } } }),
    resource("ConfigMap", "operational", { data: { mode: "safe" } }),
    resource("Service", "api", { spec: { ports: [{ port: 3000 }] } }),
    resource("NetworkPolicy", "ingress", { spec: { ingress: [] } }),
    resource("CronJob", "backup", { spec: { schedule: "0 2 * * *" } }),
  ];
  const target = structuredClone(current);
  target[0].spec.template.spec.containers[0].image = image("b");
  const live = structuredClone(current);
  for (const obj of live) Object.assign(obj.metadata, { namespace: "dev", uid: `uid-${obj.metadata.name}`, resourceVersion: "42" });
  const f = { current, target, live, replicaSets: [], pods: [], rollback: structuredClone(current), hooks: [hook()], calls: [], output: [],
    config: { "current-context": "lab", contexts: [{ name: "lab", context: { cluster: "lab-cluster" } }],
      clusters: [{ name: "lab-cluster", cluster: { server: "https://cluster.example", "certificate-authority-data": ca } }] },
    uid: "cluster-uid", history: [{ revision: 4, status: "superseded" }, { revision: 5, status: "deployed" }],
  };
  f.execute = async (file, args, io = {}) => {
    f.calls.push({ file, args: [...args], input: io.input });
    if (f.failAt === f.calls.length) throw new Error("PRIVATE_VALUE subprocess stderr");
    if (file === "kubectl") {
      if (args.includes("config")) return JSON.stringify(f.config);
      if (args.includes("kube-system")) return JSON.stringify({ metadata: { name: "kube-system", uid: f.uid } });
      if (args.includes("get")) {
        const pos = args.indexOf("get");
        if (args[pos + 1] === "ReplicaSet") return list(f.replicaSets);
        if (args[pos + 1] === "Pod") return list(f.pods);
        const obj = f.live.find(v => v.kind === args[pos + 1] && v.metadata.name === args[pos + 2]);
        return JSON.stringify(obj ?? {});
      }
      assert.ok(args.includes("create") && args.includes("--dry-run=client") && args.includes("--validate=false"));
      return io.input;
    }
    if (file === "helm") {
      if (args[0] === "history") return JSON.stringify(f.history);
      if (args[0] === "get") return list(args.includes("--revision") ? f.rollback : f.current);
      if (args[0] === "rollback") {
        assert.ok(args.includes("--dry-run") && args.includes("--no-hooks"));
        return "Rollback was a success! Happy Helming!";
      }
      assert.equal(args[0], "upgrade");
      if (args.includes("--dry-run=server")) return JSON.stringify({ name: "cp", namespace: "dev", version: 6,
        manifest: list(f.target), hooks: f.hooks });
      assert.ok(args.includes("--post-renderer"));
      f.live.find(v => v.kind === "Deployment" && v.metadata.name === "cp-control-plane-ui")
        .spec.template.spec.containers.find(v => v.name === "ui").image = image("b");
      return "applied";
    }
    assert.equal(file, "image-proof");
    assert.deepEqual(args, [image("a"), "/tmp/explicit-config", "lab", "dev"]);
    return "image exists on all eligible nodes";
  };
  readyPods(f, image("b"));
  f.run = o => scopedRollout(o ?? options(), { execute: f.execute, emit: value => f.output.push(value) });
  return f;
}
const writes = f => f.calls.filter(c => c.file === "helm" && c.args[0] === "upgrade" && !c.args.includes("--dry-run=server"));

test("legitimate UI-only plan inventories the chart migration but suppresses all hooks", async () => {
  const f = fixture();
  const plan = await f.run();
  assert.equal(plan.mode, "plan");
  assert.deepEqual(plan.changes, [{ kind: "Deployment", name: "cp-control-plane-ui", namespace: "dev",
    path: ".spec.template.spec.containers[name=ui].image", before: image("a"), after: image("b") }]);
  assert.equal(plan.hooks[0].classification, "migration/job");
  assert.equal(plan.hooks[0].action, "suppressed");
  assert.ok(plan.command.args.includes("--no-hooks"));
  assert.ok(plan.rollback.args.includes("--no-hooks"));
  assert.equal(writes(f).length, 0);
  assert.equal(f.output.length, 1);
  assert.ok(!JSON.stringify(plan).includes("PRIVATE_VALUE"));
  for (const call of f.calls.filter(c => ["helm", "kubectl"].includes(c.file))) {
    assert.ok(call.args.includes("--kubeconfig") && call.args.includes("/tmp/explicit-config"));
    assert.ok(call.args.includes(call.file === "helm" ? "--kube-context" : "--context"));
  }
});

test("plan without --no-hooks inventories upgrade hooks for a separately authorized procedure", async () => {
  const f = fixture();
  const plan = await f.run({ ...options(), noHooks: false });
  assert.equal(plan.hooks[0].classification, "migration/job");
  assert.equal(plan.hooks[0].action, "requires-separate-authorization");
  assert.equal(plan.migrations, "none authorized");
  assert.ok(plan.command.args.includes("--no-hooks"));
  assert.equal(writes(f).length, 0);
});

test("apply is explicit after rollback and image proof, followed by live verification", async () => {
  const f = fixture();
  await f.run({ ...options(), mode: "apply" });
  assert.equal(writes(f).length, 1);
  assert.equal(f.calls.at(-1).file, "kubectl");
  assert.ok(f.calls.some(c => c.file === "image-proof"));
  assert.ok(writes(f)[0].args.includes("--no-hooks"));
  assert.ok(writes(f)[0].args.includes("--post-renderer"));
  const after = f.calls.slice(f.calls.indexOf(writes(f)[0]) + 1);
  assert.equal(after.length, f.current.length + 2);
  assert.ok(after.every(c => c.file === "kubectl" && c.args.includes("get")));
});

test("legacy hook authorization is refused before rendering a plan", async () => {
  const f = fixture();
  await assert.rejects(f.run({ ...options(), noHooks: false, authorizedHooks: [authorize(hook("backup"))] }), /hook|migration/i);
  assert.equal(f.calls.length, 0);
  assert.equal(writes(f).length, 0);
  assert.equal(f.output.length, 0);
});

for (const [name, mutate] of [
  ["additional Deployment modified", f => { f.target[1].spec.replicas = 3; }],
  ["control-plane image modified", f => { f.target[1].spec.template.spec.containers[0].image = "cp:changed"; }],
  ["Secret modified", f => { f.target[2].data.password = "PRIVATE_VALUE_CHANGED"; }],
  ["PVC modified", f => { f.target[3].spec.resources.requests.storage = "2Gi"; }],
  ["operational ConfigMap modified", f => { f.target[4].data.mode = "unsafe"; }],
  ["Service modified", f => { f.target[5].spec.ports[0].port = 80; }],
  ["NetworkPolicy modified", f => { f.target[6].spec.ingress.push({}); }],
  ["backup CronJob modified", f => { f.target[7].spec.schedule = "* * * * *"; }],
  ["new CRD", f => { f.target.push(resource("CustomResourceDefinition", "example.test")); }],
  ["new Job", f => { f.target.push(resource("Job", "migration")); }],
  ["deleted resource", f => { f.target.pop(); }],
  ["extra field in authorized Deployment", f => { f.target[0].spec.replicas = 4; }],
  ["wrong target digest", f => { f.target[0].spec.template.spec.containers[0].image = image("c"); }],
  ["duplicate object", f => { f.target.push(structuredClone(f.target[0])); }],
]) test(`fails closed: ${name}`, async () => {
  const f = fixture(); mutate(f);
  await assert.rejects(f.run({ ...options(), mode: "apply" }), error => !error.message.includes("PRIVATE_VALUE"));
  assert.equal(writes(f).length, 0);
  assert.equal(f.output.length, 0);
});

test("object property order and resource order do not produce changes", async () => {
  const f = fixture(); f.target.reverse();
  f.target[0] = Object.fromEntries(Object.entries(f.target[0]).reverse());
  await f.run();
});

for (const [name, mutate] of [
  ["context", f => { f.config["current-context"] = "wrong"; }],
  ["cluster name", f => { f.config.contexts[0].context.cluster = "other"; }],
  ["CA", f => { f.config.clusters[0].cluster["certificate-authority-data"] = Buffer.from("wrong").toString("base64"); }],
  ["UID", f => { f.uid = "other-uid"; }],
  ["insecure TLS", f => { f.config.clusters[0].cluster["insecure-skip-tls-verify"] = true; }],
]) test(`rejects wrong ${name}`, async () => {
  const f = fixture(); mutate(f);
  await assert.rejects(f.run(), /context|cluster|CA|UID|TLS/i);
  assert.ok(!f.calls.some(c => c.file === "helm"));
});

for (const [name, mutate] of [
  ["missing rollback revision", f => { f.history = [{ revision: 5, status: "deployed" }]; }],
  ["failed rollback revision", f => { f.history[0].status = "failed"; }],
  ["pending release", f => { f.history[1].status = "pending-upgrade"; }],
  ["rollback changes operational resources", f => { f.rollback[4].data.mode = "unsafe"; }],
  ["rollback image differs from baseline", f => { f.rollback[0].spec.template.spec.containers[0].image = image("d"); }],
]) test(name, async () => {
  const f = fixture(); mutate(f);
  await assert.rejects(f.run(), /rollback|revision|history|release/i);
  assert.equal(writes(f).length, 0);
  assert.equal(f.output.length, 0);
});

test("every failed executor stage aborts before any plan or apply, without leaking stderr", async () => {
  const baseline = fixture(); await baseline.run();
  for (let i = 1; i <= baseline.calls.length; i++) {
    const f = fixture(); f.failAt = i;
    await assert.rejects(f.run({ ...options(), mode: "apply" }), error => !error.message.includes("PRIVATE_VALUE"));
    assert.equal(f.calls.length, i);
    assert.equal(writes(f).length, 0);
    assert.equal(f.output.length, 0);
  }
});

test("apply refuses even an exactly authorized hook without --no-hooks", async () => {
  const f = fixture();
  await assert.rejects(f.run({ ...options(), mode: "apply", noHooks: false, authorizedHooks: [authorize(f.hooks[0])] }), /--no-hooks/);
  assert.equal(f.calls.length, 0);
  assert.equal(writes(f).length, 0);
});

test("legacy hook authorization cannot be combined with --no-hooks to authorize execution", async () => {
  const f = fixture();
  await assert.rejects(f.run({ ...options(), mode: "apply", authorizedHooks: [authorize(f.hooks[0])] }), /hook authorization is not supported/);
  assert.equal(f.calls.length, 0);
});

test("apply requires --no-hooks even when the chart has no hooks", async () => {
  const f = fixture(); f.hooks = [];
  await assert.rejects(f.run({ ...options(), mode: "apply", noHooks: false }), /--no-hooks/);
  assert.equal(f.calls.length, 0);
});

for (const kind of ["Job", "Pod", "CronJob", "Deployment", "StatefulSet", "DaemonSet", "ReplicaSet"]) {
  for (const command of [["psql", "-c", "ALTER TABLE customers ADD COLUMN hidden text"], ["drizzle-kit", "push"],
    ["sh", "-c", "db:migrate"], ["mysql", "-e", "CREATE TABLE hidden (id int)"], ["sh", "-c", "DROP TABLE hidden"]]) {
    test(`migration content in ${kind}: ${command.join(" ")}`, async () => {
      const f = fixture(), h = hook("seed", ["pre-upgrade", "test"]), obj = JSON.parse(h.manifest);
      obj.kind = kind; h.kind = kind;
      const pod = { containers: [{ name: "seed", image: "tool:fixed", command }] };
      obj.spec = kind === "Pod" ? pod : kind === "CronJob" ? { jobTemplate: { spec: { template: { spec: pod } } } } : { template: { spec: pod } };
      h.manifest = JSON.stringify(obj); f.hooks = [h];
      const plan = await f.run();
      assert.equal(plan.hooks[0].classification, "migration/job");
      await assert.rejects(f.run({ ...options(), noHooks: false, authorizedHooks: [authorize(h, "test")] }), /hook|migration/i);
    });
  }
}
for (const event of ["pre-install", "post-install", "pre-upgrade", "post-upgrade", "pre-rollback", "post-rollback", "pre-delete", "post-delete", "test", "test-success", "test-failure"]) {
  test(`migration takes precedence over mixed test event: ${event}`, async () => {
    const f = fixture(); f.hooks = [hook("seed", [...new Set([event, "test"])])];
    assert.equal((await f.run()).hooks[0].classification, "migration/job");
  });
}
test("unknown hooks are inventoried but cannot be authorized through this guard", async () => {
  const f = fixture(), h = hook("seed", ["pre-upgrade"]), obj = JSON.parse(h.manifest);
  obj.kind = "Pod"; h.kind = "Pod"; obj.spec = { containers: [{ name: "seed", image: "tool:fixed", command: ["opaque-tool"] }] };
  h.manifest = JSON.stringify(obj); f.hooks = [h];
  assert.equal((await f.run()).hooks[0].classification, "unknown");
  await assert.rejects(f.run({ ...options(), noHooks: false, authorizedHooks: [authorize(h, "unknown")] }), /unknown|authorization/i);
});

for (const stage of ["initial", "immediate"]) for (const drift of ["missing", "recreated", "spec", "extra-container", "secret"]) {
  test(`live objects fail closed: ${stage} ${drift}`, async () => {
    const f = fixture(), execute = f.execute;
    const change = () => {
      if (drift === "missing") f.live.splice(5, 1);
      if (drift === "recreated") f.live[5].metadata.uid = "recreated";
      if (drift === "spec") f.live[5].spec.ports[0].port = 80;
      if (drift === "extra-container") f.live[1].spec.template.spec.containers.push({ name: "injected", image: "extra" });
      if (drift === "secret") f.live[2].data.password = "PRIVATE_VALUE_CHANGED";
    };
    if (stage === "initial") change();
    else f.execute = async (file, args, io) => { const out = await execute(file, args, io); if (file === "image-proof") change(); return out; };
    await assert.rejects(f.run({ ...options(), mode: "apply" }), error => /live|UID|effective/i.test(error.message) && !error.message.includes("PRIVATE_VALUE"));
    assert.equal(writes(f).length, 0);
  });
}
for (const stage of ["initial", "immediate"]) for (const drift of ["missing", "recreated", "replicas", "env", "sidecar", "annotation"]) {
  test(`authorized Deployment live proof fails closed: ${stage} ${drift}`, async () => {
    const f = fixture(), execute = f.execute;
    const change = () => {
      const live = f.live[0];
      if (drift === "missing") f.live.shift();
      if (drift === "recreated") live.metadata.uid = "new-workload-uid";
      if (drift === "replicas") live.spec.replicas = 3;
      if (drift === "env") live.spec.template.spec.containers[0].env = [{ name: "UNAPPROVED", value: "PRIVATE_VALUE" }];
      if (drift === "sidecar") live.spec.template.spec.containers.push({ name: "injected", image: "extra" });
      if (drift === "annotation") live.metadata.annotations = { unapproved: "true" };
    };
    if (stage === "initial") change();
    else f.execute = async (file, args, io) => { const out = await execute(file, args, io); if (file === "image-proof") change(); return out; };
    await assert.rejects(f.run({ ...options(), mode: "apply" }), error => /live object/.test(error.message) && !error.message.includes("PRIVATE_VALUE"));
    assert.equal(writes(f).length, 0);
  });
}
for (const stage of ["initial", "immediate"]) for (const unexpected of [image("b"), image("c")]) {
  test(`preparation refuses unexpected live image: ${stage} ${unexpected}`, async () => {
    const f = fixture(), execute = f.execute;
    const change = () => { f.live[0].spec.template.spec.containers[0].image = unexpected; };
    if (stage === "initial") change();
    else f.execute = async (file, args, io) => { const out = await execute(file, args, io); if (file === "image-proof") change(); return out; };
    await assert.rejects(f.run({ ...options(), mode: "apply" }), /live.*image/i);
    assert.equal(writes(f).length, 0);
  });
}
for (const unexpected of [image("a"), image("c")]) {
  test(`post-apply refuses a retained or third live image: ${unexpected}`, async () => {
    const f = fixture(), execute = f.execute;
    f.execute = async (file, args, io) => {
      const out = await execute(file, args, io);
      if (file === "helm" && args[0] === "upgrade" && !args.includes("--dry-run=server"))
        f.live[0].spec.template.spec.containers[0].image = unexpected;
      return out;
    };
    await assert.rejects(f.run({ ...options(), mode: "apply" }), /post-apply verification failed:.*live.*image.*\nRollback command/);
    assert.equal(writes(f).length, 1);
  });
}
function readyPods(f, imageID) {
  const owner = (kind, uid) => [{ kind, uid, controller: true }];
  const template = structuredClone(f.target[0].spec.template);
  template.metadata.labels["pod-template-hash"] = "new-hash";
  f.replicaSets = [{ metadata: { name: "ui-rs", namespace: "dev", uid: "ui-rs", ownerReferences: owner("Deployment", f.live[0].metadata.uid) }, spec: { template } }];
  f.pods = [{ metadata: { namespace: "dev", name: "ui-pod", uid: "ui-pod-uid", labels: { ...template.metadata.labels }, ownerReferences: owner("ReplicaSet", "ui-rs") },
    spec: { containers: [{ name: "ui", image: image("b") }] },
    status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }], containerStatuses: [{ name: "ui", ready: true, image: image("b"), imageID }] } }];
  const second = structuredClone(f.pods[0]); second.metadata.name = "ui-pod-2"; second.metadata.uid = "ui-pod-2-uid"; f.pods.push(second);
}
function oldPod(f) {
  const rs = structuredClone(f.replicaSets[0]);
  Object.assign(rs.metadata, { name: "old-rs", uid: "old-rs" });
  rs.spec.template.metadata.labels["pod-template-hash"] = "old-hash";
  rs.spec.template.spec.containers[0].image = image("a");
  f.replicaSets.push(rs);
  const pod = structuredClone(f.pods[0]);
  Object.assign(pod.metadata, { name: "old-pod", uid: "old-pod-uid", labels: { ...rs.spec.template.metadata.labels } });
  pod.metadata.ownerReferences[0].uid = "old-rs";
  pod.spec.containers[0].image = image("a");
  pod.status.containerStatuses[0].imageID = image("a");
  f.pods.push(pod);
  return pod;
}
for (const imageID of [image("b"), `docker-pullable://${image("b")}`, `containerd://sha256:${"b".repeat(64)}`]) {
  test(`post-apply accepts Ready container digest: ${imageID}`, async () => {
    const f = fixture(); readyPods(f, imageID);
    await f.run({ ...options(), mode: "apply" });
    assert.equal(writes(f).length, 1);
  });
}
for (const [name, mutate] of [
  ["old digest", p => { p.status.containerStatuses[0].imageID = image("a"); }],
  ["third digest", p => { p.status.containerStatuses[0].imageID = image("c"); }],
  ["missing imageID", p => { delete p.status.containerStatuses[0].imageID; }],
  ["digest suffix spoof", p => { p.status.containerStatuses[0].imageID += "extra"; }],
  ["missing status", p => { p.status.containerStatuses = []; }],
  ["wrong pod image", p => { p.spec.containers[0].image = image("c"); }],
]) test(`post-apply refuses Ready container image drift: ${name}`, async () => {
  const f = fixture(); readyPods(f, image("b")); mutate(f.pods[0]);
  await assert.rejects(f.run({ ...options(), mode: "apply" }), /post-apply verification failed:.*image.*\nRollback command/);
  assert.equal(writes(f).length, 1);
});
test("post-apply refuses missing Ready pod evidence when Deployment reports ready replicas", async () => {
  const f = fixture(); f.live[0].status = { readyReplicas: 2 }; f.pods = [];
  await assert.rejects(f.run({ ...options(), mode: "apply" }), /post-apply verification failed:.*Ready.*\nRollback command/);
});
test("post-apply accepts a correct rollout while an old Ready pod is terminating", async () => {
  const f = fixture(); readyPods(f, image("b"));
  f.live[0].status = { readyReplicas: 2 };
  const old = oldPod(f);
  old.metadata.deletionTimestamp = "2026-11-02T23:00:00Z";
  await f.run({ ...options(), mode: "apply" });
  assert.equal(writes(f).length, 1);
});

for (const [phase, reason] of [["Failed", "Error"], ["Failed", "Evicted"], ["Succeeded", "Completed"]]) {
  test(`post-apply ignores retained terminal pods only from an old owned ReplicaSet: ${phase}/${reason}`, async () => {
    const f = fixture();
    const old = oldPod(f);
    old.status = { phase, reason, conditions: [{ type: "Ready", status: "False" }] };
    await f.run({ ...options(), mode: "apply" });
    assert.equal(writes(f).length, 1);
  });
}

for (const [name, mutate] of [
  ["old pod still Ready", () => {}],
  ["old pod Ready even with authorized digest", (f, p) => { p.spec.containers[0].image = image("b"); p.status.containerStatuses[0].imageID = image("b"); }],
  ["Evicted reason without terminal phase", (f, p) => { p.status.reason = "Evicted"; }],
  ["terminal pod from a recreated Deployment", (f, p) => { p.status.phase = "Failed"; f.replicaSets[1].metadata.ownerReferences[0].uid = "other-deployment"; }],
  ["terminal pod with spoofed RS UID", (f, p) => { p.status.phase = "Failed"; p.metadata.ownerReferences[0].uid = "unknown-rs"; }],
  ["terminal pod without controller ownership", (f, p) => { p.status.phase = "Failed"; p.metadata.ownerReferences[0].controller = false; }],
]) test(`post-apply refuses unexpected historical pod evidence: ${name}`, async () => {
  const f = fixture(), pod = oldPod(f);
  mutate(f, pod);
  await assert.rejects(f.run({ ...options(), mode: "apply" }), /post-apply verification failed:.*\nRollback command/);
  assert.equal(writes(f).length, 1);
});

for (const [name, mutate] of [
  ["another release", p => { p.metadata.labels["app.kubernetes.io/instance"] = "other-release"; }],
  ["wrong namespace", p => { p.metadata.namespace = "other-namespace"; }],
  ["unknown RS UID", p => { p.metadata.ownerReferences[0].uid = "unexpected-rs"; }],
  ["wrong owner kind", p => { p.metadata.ownerReferences[0].kind = "Job"; }],
  ["missing controller owner", p => { p.metadata.ownerReferences = []; }],
  ["missing pod UID", p => { delete p.metadata.uid; }],
  ["newly created Pending pod", p => { p.status = { phase: "Pending" }; }],
  ["terminal pod in new RS", p => { p.status.phase = "Failed"; }],
  ["Succeeded pod in new RS", p => { p.status.phase = "Succeeded"; }],
]) test(`post-apply refuses an extra unexpected pod even with enough Ready replicas: ${name}`, async () => {
  const f = fixture(), pod = structuredClone(f.pods[0]);
  Object.assign(pod.metadata, { name: "extra-pod", uid: "extra-pod-uid" });
  mutate(pod); f.pods.push(pod);
  await assert.rejects(f.run({ ...options(), mode: "apply" }), /post-apply verification failed:.*\nRollback command/);
  assert.equal(writes(f).length, 1);
});

test("post-apply requires exactly the desired number of Ready pods from the new ReplicaSet", async () => {
  const f = fixture(), extra = structuredClone(f.pods[0]);
  Object.assign(extra.metadata, { name: "extra-ready", uid: "extra-ready-uid" });
  f.pods.push(extra);
  await assert.rejects(f.run({ ...options(), mode: "apply" }), /post-apply verification failed:.*Ready/);
});

for (const field of ["pod", "container"]) test(`post-apply refuses a non-terminating new pod that is not Ready: ${field}`, async () => {
  const f = fixture(); readyPods(f, image("b"));
  if (field === "pod") f.pods[0].status.conditions[0].status = "False";
  else f.pods[0].status.containerStatuses[0].ready = false;
  await assert.rejects(f.run({ ...options(), mode: "apply" }), /post-apply verification failed:.*Ready/);
});

test("post-apply ignores pods outside the Deployment ownership chain", async () => {
  const f = fixture();
  const other = structuredClone(f.pods[0]);
  Object.assign(other.metadata, { name: "unrelated-pod", uid: "unrelated-pod-uid", labels: { app: "unrelated", "app.kubernetes.io/instance": "other-release" } });
  other.metadata.ownerReferences[0].uid = "unrelated-rs";
  other.spec.containers[0].image = image("a");
  other.status.containerStatuses[0].imageID = image("a");
  f.pods.push(other);
  await f.run({ ...options(), mode: "apply" });
});

for (const state of ["empty", "terminating", "below desired replicas"]) test(`post-apply requires active Ready pod evidence: ${state}`, async () => {
  const f = fixture();
  if (state === "empty") f.pods = [];
  else if (state === "terminating") f.pods.forEach(p => { p.metadata.deletionTimestamp = "2026-11-02T23:00:00Z"; });
  else f.pods.pop();
  await assert.rejects(f.run({ ...options(), mode: "apply" }), /post-apply verification failed:.*Ready pod image evidence missing/);
});

test("authorized Deployment proof permits only its named image path, with API defaults normalized", async () => {
  const f = fixture(), execute = f.execute, live = f.live[0];
  Object.assign(live.spec, { revisionHistoryLimit: 10, progressDeadlineSeconds: 600 });
  live.spec.template.metadata.creationTimestamp = null;
  live.spec.template.spec.dnsPolicy = "ClusterFirst";
  f.execute = async (file, args, io) => {
    const out = await execute(file, args, io);
    if (file === "helm" && args[0] === "upgrade" && !args.includes("--dry-run=server")) live.spec.template.spec.containers[0].image = image("b");
    return out;
  };
  const plan = await f.run({ ...options(), mode: "apply" });
  const proof = plan.liveObjects.find(v => v.name === options().deployment);
  assert.equal(proof.uid, "uid-cp-control-plane-ui");
  assert.deepEqual(proof.ignoredPaths, [["spec", "template", "spec", "containers", 0, "image"]]);
  assert.equal(live.spec.template.spec.containers[0].image, image("b"));
});
for (const drift of ["missing", "recreated", "spec", "unreadable", "authorized-deployment"]) {
  test(`post-apply check refuses drift and prints rollback without executing it: ${drift}`, async () => {
    const f = fixture(), execute = f.execute;
    let applied = false;
    f.execute = async (file, args, io) => {
      if (applied && drift === "unreadable" && file === "kubectl" && args.includes("get")) throw new Error("PRIVATE_VALUE");
      const out = await execute(file, args, io);
      if (file === "helm" && args[0] === "upgrade" && !args.includes("--dry-run=server")) {
        applied = true;
        f.live[0].spec.template.spec.containers[0].image = image("b");
        if (drift === "missing") f.live.splice(5, 1);
        if (drift === "recreated") f.live[5].metadata.uid = "new-service-uid";
        if (drift === "spec") f.live[5].spec.ports[0].port = 80;
        if (drift === "authorized-deployment") f.live[0].metadata.uid = "new-workload-uid";
      }
      return out;
    };
    await assert.rejects(f.run({ ...options(), mode: "apply" }), error => /post-apply verification failed/.test(error.message)
      && /Rollback command \(not executed\): 'helm' 'rollback' 'cp' '4'/.test(error.message)
      && /'--no-hooks'/.test(error.message) && !error.message.includes("PRIVATE_VALUE"));
    assert.equal(writes(f).length, 1);
    assert.ok(f.calls.filter(c => c.file === "helm" && c.args[0] === "rollback").every(c => c.args.includes("--dry-run")));
  });
}
test("all release objects are read by identity twice, with normalized proof", async () => {
  const f = fixture(); f.live[1].status = { readyReplicas: 2 }; f.live[1].metadata.managedFields = [{ manager: "controller" }];
  const plan = await f.run();
  assert.equal(plan.liveObjects.length, f.current.length);
  for (const proof of plan.liveObjects) {
    assert.equal(proof.uid, `uid-${proof.name}`);
    assert.match(proof.specSha256, /^[a-f0-9]{64}$/);
    assert.equal(f.calls.filter(c => c.file === "kubectl" && c.args.includes("get") && c.args.includes(proof.name)).length, 2);
  }
});

test("changed release state during preparation fails before apply", async () => {
  const f = fixture(), execute = f.execute;
  let reads = 0;
  f.execute = async (file, args, io) => {
    if (file === "helm" && args[0] === "history" && ++reads === 2) f.history.push({ revision: 6, status: "deployed" });
    return execute(file, args, io);
  };
  await assert.rejects(f.run({ ...options(), mode: "apply" }), /release|history|changed/i);
  assert.equal(writes(f).length, 0);
  assert.equal(f.output.length, 0);
});

test("actual CLI runs only simulated helm/kubectl and applies only with --apply", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scoped-rollout-test-"));
  try {
    const f = fixture();
    const snapshot = join(dir, "fixture.json"), calls = join(dir, "calls.jsonl");
    writeFileSync(snapshot, JSON.stringify(f));
    const shim = `#!${process.execPath}
import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { spawnSync } from "node:child_process";
const f = JSON.parse(readFileSync(process.env.SCOPED_FIXTURE, "utf8"));
const tool = basename(process.argv[1]), args = process.argv.slice(2);
if (Object.keys(process.env).some(k => k.startsWith("HELM_KUBE"))) throw Error("inherited Helm cluster override");
appendFileSync(process.env.SCOPED_CALLS, JSON.stringify({tool, args}) + "\\n");
const list = items => ({apiVersion: "v1", kind: "List", items});
let out;
if (tool === "kubectl") {
  if (args.includes("config")) out = f.config;
  else if (args.includes("kube-system")) out = {metadata:{name:"kube-system", uid:f.uid}};
  else if (args.includes("get")) { const pos = args.indexOf("get"); out = args[pos+1] === "ReplicaSet" ? list(f.replicaSets) : args[pos+1] === "Pod" ? list(f.pods) : f.live.find(v => v.kind === args[pos+1] && v.metadata.name === args[pos+2]) ?? {}; }
  else if (args.includes("create") && args.includes("--dry-run=client")) out = JSON.parse(readFileSync(0,"utf8"));
  else throw Error("unexpected kubectl call");
} else if (tool === "helm") {
  if (args[0] === "history") out = f.history;
  else if (args[0] === "get") out = list(args.includes("--revision") ? f.rollback : f.current);
  else if (args[0] === "upgrade" && args.includes("--dry-run=server")) out = {name:"cp", namespace:"dev", version:6, manifest:JSON.stringify(list(f.target)), hooks:f.hooks};
  else if (args[0] === "rollback" && args.includes("--dry-run")) out = "OK";
  else if (args[0] === "upgrade") {
    const renderer = args[args.indexOf("--post-renderer") + 1];
    const rendererArgs = args.filter(a => a.startsWith("--post-renderer-args=")).map(a => a.slice("--post-renderer-args=".length));
    const manifest = JSON.stringify(list(f.target)) + (process.env.DRIFT_RENDER ? "\\n# drift" : "");
    if (process.env.DRIFT_LIVE) {
      if (process.env.DRIFT_LIVE === "missing") f.live.splice(5, 1);
      if (process.env.DRIFT_LIVE === "recreated") f.live[5].metadata.uid = "new-uid";
      if (process.env.DRIFT_LIVE === "spec") f.live[5].spec.ports[0].port = 80;
      if (process.env.DRIFT_LIVE === "image") f.live[0].spec.template.spec.containers[0].image = f.target[0].spec.template.spec.containers[0].image;
      writeFileSync(process.env.SCOPED_FIXTURE, JSON.stringify(f));
    }
    if (process.env.DRIFT_BASELINE) {
      if (process.env.DRIFT_BASELINE === "history") f.history.push({revision:6, status:"deployed"});
      else f.current[4].data.mode = "concurrently-changed";
      writeFileSync(process.env.SCOPED_FIXTURE, JSON.stringify(f));
    }
    const checked = spawnSync(renderer, rendererArgs, {input: manifest, encoding: "utf8"});
    if (checked.status !== 0) { console.error(checked.stderr); process.exit(1); }
    if (checked.stdout !== manifest) throw Error("post-renderer changed manifest");
    f.live[0].spec.template.spec.containers[0].image = f.target[0].spec.template.spec.containers[0].image;
    if (process.env.DRIFT_AFTER_APPLY === "missing") f.live.splice(5, 1);
    if (process.env.DRIFT_AFTER_APPLY === "recreated") f.live[5].metadata.uid = "recreated-after-apply";
    if (process.env.DRIFT_AFTER_APPLY === "spec") f.live[5].spec.ports[0].port = 80;
    if (process.env.DRIFT_AFTER_APPLY === "old-image") f.live[0].spec.template.spec.containers[0].image = f.current[0].spec.template.spec.containers[0].image;
    if (process.env.DRIFT_AFTER_APPLY === "third-image") f.live[0].spec.template.spec.containers[0].image = "registry.example/gromesh-ui@sha256:" + "c".repeat(64);
    writeFileSync(process.env.SCOPED_FIXTURE, JSON.stringify(f));
    out = "simulated apply";
  }
  else throw Error("unexpected helm call");
} else if (tool === "image-proof") {
  if (args[0] !== f.current[0].spec.template.spec.containers[0].image) throw Error("image unavailable");
  if (process.env.FAIL_IMAGE_PROOF) { console.error("PRIVATE_VALUE"); process.exit(1); }
  out = "present";
} else throw Error("unexpected tool");
console.log(typeof out === "string" ? out : JSON.stringify(out));
`;
    for (const tool of ["helm", "kubectl", "image-proof"]) writeFileSync(join(dir, tool), shim, { mode: 0o700 });
    const o = options();
    const argv = Object.entries({ "--release": o.release, "--namespace": o.namespace, "--kube-context": o.kubeContext,
      "--kubeconfig": o.kubeconfig, "--expected-cluster": o.expectedCluster, "--expected-uid": o.expectedUid,
      "--expected-ca-sha256": o.expectedCaSha256, "--chart": o.chart, "--deployment": o.deployment,
      "--container": o.container, "--image": o.image, "--rollback-revision": String(o.rollbackRevision),
      "--object-uids": JSON.stringify(o.objectUids), "--verify-image-command": JSON.stringify(o.verifyImageCommand) }).flat();
    const env = { PATH: dir, SCOPED_FIXTURE: snapshot, SCOPED_CALLS: calls, HELM_KUBEAPISERVER: "https://wrong.example", HELM_KUBEINSECURE_SKIP_TLS_VERIFY: "true" };
    const script = new URL("./helm-scoped-rollout.mjs", import.meta.url).pathname;
    for (const mode of [[], ["--apply"]]) {
      writeFileSync(snapshot, JSON.stringify(f));
      writeFileSync(calls, "");
      const result = await promisify(execFile)(process.execPath, [script, ...argv, "--no-hooks", ...mode], { env });
      const plan = JSON.parse(result.stdout);
      assert.equal(plan.mode, mode.length ? "apply" : "plan");
      assert.equal(result.stderr, "");
      const trace = readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse);
      const upgrades = trace.filter(c => c.tool === "helm" && c.args[0] === "upgrade" && !c.args.includes("--dry-run=server"));
      assert.equal(upgrades.length, mode.length);
      assert.ok(trace.some(c => c.tool === "kubectl" && c.args.includes("create")));
    }
    writeFileSync(snapshot, JSON.stringify(f));
    writeFileSync(calls, "");
    await assert.rejects(promisify(execFile)(process.execPath, [script, ...argv, "--no-hooks", "--apply"], {
      env: { ...env, FAIL_IMAGE_PROOF: "1" },
    }), error => error.code === 1 && error.stdout === "" && !error.stderr.includes("PRIVATE_VALUE"));
    const trace = readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(trace.at(-1).tool, "image-proof");
    await assert.rejects(promisify(execFile)(process.execPath, [script, ...argv, "--no-hooks", "--apply"], {
      env: { ...env, DRIFT_RENDER: "1" },
    }), error => error.code === 1 && /apply command failed/.test(error.stderr));
    writeFileSync(snapshot, JSON.stringify(f));
    const hookArgv = [...argv, "--authorize-hook", JSON.stringify(authorize(f.hooks[0])), "--apply"];
    await assert.rejects(promisify(execFile)(process.execPath, [script, ...hookArgv], { env }),
      error => error.code === 1 && /--apply requires --no-hooks/.test(error.stderr));
    writeFileSync(snapshot, JSON.stringify(f));
    for (const drift of ["missing", "recreated", "spec", "image"]) {
      writeFileSync(snapshot, JSON.stringify(f));
      await assert.rejects(promisify(execFile)(process.execPath, [script, ...argv, "--no-hooks", "--apply"], {
        env: { ...env, DRIFT_LIVE: drift },
      }), error => error.code === 1 && /apply command failed/.test(error.stderr));
    }
    for (const drift of ["history", "manifest"]) {
      writeFileSync(snapshot, JSON.stringify(f));
      await assert.rejects(promisify(execFile)(process.execPath, [script, ...argv, "--no-hooks", "--apply"], {
        env: { ...env, DRIFT_BASELINE: drift },
      }), error => error.code === 1 && /apply command failed/.test(error.stderr));
    }
    for (const drift of ["missing", "recreated", "spec", "old-image", "third-image"]) {
      writeFileSync(snapshot, JSON.stringify(f));
      writeFileSync(calls, "");
      await assert.rejects(promisify(execFile)(process.execPath, [script, ...argv, "--no-hooks", "--apply"], {
        env: { ...env, DRIFT_AFTER_APPLY: drift },
      }), error => error.code === 1 && /post-apply verification failed/.test(error.stderr)
        && /Rollback command \(not executed\): 'helm' 'rollback' 'cp' '4'/.test(error.stderr)
        && /'--no-hooks'/.test(error.stderr) && !error.stderr.includes("PRIVATE_VALUE"));
      const postTrace = readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse);
      assert.equal(postTrace.filter(c => c.tool === "helm" && c.args[0] === "upgrade" && !c.args.includes("--dry-run=server")).length, 1);
      assert.ok(postTrace.filter(c => c.args[0] === "rollback").every(c => c.args.includes("--dry-run")));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("missing hook inventory, malformed hooks and unknown events fail closed", async () => {
  for (const mutate of [f => { f.hooks = undefined; }, f => { f.hooks[0].events = ["mystery"]; },
    f => { f.hooks[0].manifest = ""; }, f => { f.hooks.push(structuredClone(f.hooks[0])); }]) {
    const f = fixture(); mutate(f);
    await assert.rejects(f.run(), /hook/i);
    assert.equal(writes(f).length, 0);
  }
});

test("tagged or malformed image and absent explicit scope fail before executors", async () => {
  for (const change of [
    { image: "registry.example/ui:latest" }, { image: "registry.example/ui:v1@sha256:" + "a".repeat(64) },
    { image: "registry.example/ui@sha256:abc" }, { release: "" }, { namespace: "" }, { kubeContext: "" },
    { kubeconfig: "" }, { expectedUid: "" }, { expectedCaSha256: "" }, { expectedCluster: "" },
    { mode: "apply", noHooks: false }, { mode: "unknown" }, { verifyImageCommand: [] },
    { noHooks: true, authorizedHooks: ["Job/backup"] },
  ]) {
    const f = fixture();
    await assert.rejects(f.run({ ...options(), ...change }));
    assert.equal(f.calls.length, 0);
  }
});

test("the final command is independently checked for --no-hooks and scoped flags", async () => {
  const f = fixture(); const plan = await f.run();
  assert.doesNotThrow(() => assertUpgradeCommand(plan.command.args, options(), plan.renderProof));
  for (const flag of ["--no-hooks", "--reuse-values", "--kubeconfig", "--kube-context", "--namespace"])
    assert.throws(() => assertUpgradeCommand(plan.command.args.filter(a => a !== flag), options(), plan.renderProof), /command/i);
  assert.throws(() => assertUpgradeCommand([...plan.command.args, "--no-hooks=false"], options(), plan.renderProof), /command/i);
});

test("CLI parsing is strict, plan is default, apply requires its own flag", () => {
  const argv = ["--release", "cp", "--namespace", "dev", "--kube-context", "lab", "--kubeconfig", "/tmp/config",
    "--expected-cluster", "cluster", "--expected-uid", "uid", "--expected-ca-sha256", "a".repeat(64),
    "--object-uids", JSON.stringify(baselineUids()), "--chart", "deploy/helm/control-plane", "--deployment", "cp-control-plane-ui", "--container", "ui",
    "--image", image("b"), "--rollback-revision", "4", "--no-hooks", "--verify-image-command",
    JSON.stringify(options().verifyImageCommand)];
  assert.equal(parseArgs(argv).mode, "plan");
  assert.equal(parseArgs([...argv, "--apply"]).mode, "apply");
  for (const extra of [["--plan", "--apply"], ["--release", "other"], ["--bogus"], ["--set-string", "--no-hooks=false"]])
    assert.throws(() => parseArgs([...argv, ...extra]));
});

test("guard is included in test:guard and actual chart migration is not conditional", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(pkg.scripts["test:guard"].includes("scripts/helm-scoped-rollout.test.mjs"));
  const migration = readFileSync(new URL("../deploy/helm/control-plane/templates/migration.yaml", import.meta.url), "utf8");
  assert.match(migration, /helm.sh\/hook: pre-install,pre-upgrade/);
});

test("a direct pg_dump backup hook is classified in a plan for separate authorization", async () => {
  const f = fixture(), h = hook("backup", ["post-upgrade"]), obj = JSON.parse(h.manifest);
  obj.spec.template.spec.containers = [{ name: "pg-dump", image: "backup:fixed", command: ["pg_dump"] }];
  h.manifest = JSON.stringify(obj); f.hooks = [h];
  const plan = await f.run({ ...options(), noHooks: false });
  assert.equal(plan.hooks[0].classification, "backup");
  assert.equal(plan.hooks[0].action, "requires-separate-authorization");
  assert.equal(writes(f).length, 0);
});

test("migration env content also overrides test classification", async () => {
  const f = fixture(), h = hook("seed", ["test"]), obj = JSON.parse(h.manifest);
  obj.spec.template.spec.containers = [{ name: "seed", image: "tool:fixed", env: [{ name: "STARTUP_SQL", value: "ALTER TABLE hidden ADD id int" }] }];
  h.manifest = JSON.stringify(obj); f.hooks = [h];
  assert.equal((await f.run()).hooks[0].classification, "migration/job");
});

test("live UID baseline must cover exactly all release objects including the authorized Deployment", async () => {
  for (const objectUids of [undefined, [], baselineUids().slice(1), [...baselineUids(), { kind: "Service", name: "extra", namespace: "dev", uid: "extra" }]]) {
    const f = fixture();
    await assert.rejects(f.run({ ...options(), objectUids }), /UID/i);
    assert.equal(writes(f).length, 0);
  }
});

test("rendered UID baseline includes Service and NetworkPolicy sharing the authorized Deployment name", async () => {
  const f = fixture(), o = options();
  for (const objects of [f.current, f.target, f.rollback]) {
    objects.push(resource("Service", o.deployment, { spec: { ports: [{ port: 80 }] } }),
      resource("NetworkPolicy", o.deployment, { spec: { ingress: [] } }));
  }
  const objectUids = renderedObjectUids(f, o);
  const plan = await f.run({ ...o, objectUids });
  assert.equal(plan.liveObjects.length, f.current.length);
  assert.deepEqual(plan.liveObjects.filter(v => v.name === o.deployment).map(v => ({ kind: v.kind, uid: v.uid })), [
    { kind: "Deployment", uid: "uid-Deployment-dev-cp-control-plane-ui" },
    { kind: "Service", uid: "uid-Service-dev-cp-control-plane-ui" },
    { kind: "NetworkPolicy", uid: "uid-NetworkPolicy-dev-cp-control-plane-ui" },
  ]);
  assert.equal(new Set(f.live.map(v => v.metadata.uid)).size, f.live.length);
  await assert.rejects(f.run({ ...o, mode: "apply",
    objectUids: objectUids.filter(v => !(v.kind === "Service" && v.name === o.deployment)),
  }), /missing\/mismatched baseline object UID/);
  assert.equal(writes(f).length, 0);
});

// Opt-in preserves offline/sandbox runs. No Docker, kubectl or cluster is used even when enabled.
test("real Helm renders both shipped charts as subcharts, values conditionals and hook event matrix", async t => {
  if (process.env.GROMESH_TEST_REAL_HELM !== "1") {
    t.skip("real Helm not authorized in this run; outside sandbox use GROMESH_TEST_REAL_HELM=1 node --test scripts/helm-scoped-rollout.test.mjs (requires helm and pnpm install)");
    return;
  }
  const helm = process.env.GROMESH_TEST_HELM || "helm";
  try { await promisify(execFile)(helm, ["version", "--short"]); }
  catch (error) { if (error.code === "ENOENT") { t.skip("real Helm unavailable: install helm and rerun with GROMESH_TEST_REAL_HELM=1"); return; } throw error; }
  const require = createRequire(new URL("../apps/control-plane/package.json", import.meta.url));
  const yaml = require("yaml");
  const dir = mkdtempSync(join(tmpdir(), "scoped-real-chart-"));
  try {
    const umbrella = join(dir, "umbrella");
    mkdirSync(join(umbrella, "charts"), { recursive: true });
    for (const chart of ["control-plane", "data-plane"]) cpSync(resolve("deploy/helm", chart), join(umbrella, "charts", chart), { recursive: true });
    const matrix = join(umbrella, "charts", "hook-matrix");
    mkdirSync(join(matrix, "templates"), { recursive: true });
    writeFileSync(join(matrix, "Chart.yaml"), "apiVersion: v2\nname: hook-matrix\nversion: 0.1.0\n");
    const events = ["pre-install", "post-install", "pre-upgrade", "post-upgrade", "pre-rollback", "post-rollback", "pre-delete", "post-delete", "test"];
    // The extra local subchart exercises hooks hidden in dependencies; shipped charts are copied verbatim.
    for (const event of events) for (const mixed of [false, true]) {
      const name = `${event}${mixed ? "-mixed" : ""}`;
      writeFileSync(join(matrix, "templates", `${name}.yaml`), yaml.stringify({ apiVersion: "v1", kind: "Pod",
        metadata: { name, annotations: { "helm.sh/hook": [...new Set([event, ...(mixed ? ["test"] : [])])].join(",") } },
        spec: { restartPolicy: "Never", containers: [{ name: "seed", image: "tool:fixed", command: ["psql", "-c", "ALTER TABLE example ADD id int"] }] } }));
    }
    writeFileSync(join(umbrella, "Chart.yaml"), yaml.stringify({ apiVersion: "v2", name: "scoped-umbrella", version: "0.1.0",
      dependencies: ["control-plane", "data-plane", "hook-matrix"].map(name => ({ name, version: "0.1.0", repository: `file://charts/${name}`, ...(name === "hook-matrix" ? { condition: "matrix.enabled" } : {}) })) }));
    const cp = yaml.parse(readFileSync("deploy/helm/control-plane/ci/values-full.yaml", "utf8"));
    const dp = yaml.parse(readFileSync("deploy/helm/data-plane/ci/values-full.yaml", "utf8"));
    const helmEnv = { ...process.env, HELM_CACHE_HOME: join(dir, "cache"), HELM_CONFIG_HOME: join(dir, "config"), HELM_DATA_HOME: join(dir, "data") };
    for (const enabled of [false, true]) await t.test(`effective values ${enabled ? "on" : "off"}`, async () => {
      const valuesFile = join(dir, "values.yaml");
      const values = { "control-plane": { ...cp, ui: { image: { repository: "registry.example/gromesh-ui", tag: "", digest: `sha256:${"a".repeat(64)}` } },
        backup: { enabled }, ingress: { ...cp.ingress, enabled }, networkPolicy: { ...cp.networkPolicy, enabled }, pdb: { enabled } },
        "data-plane": { ...dp, collector: { ...dp.collector, enabled, auth: { existingSecret: "collector-auth" } },
          networkPolicy: { ...dp.networkPolicy, enabled }, autoscaling: { ...dp.autoscaling, enabled }, pdb: { enabled }, metrics: { enabled, prometheusRule: { enabled } } }, matrix: { enabled } };
      writeFileSync(valuesFile, yaml.stringify(values));
      const render = async target => {
        const { stdout } = await promisify(execFile)(helm, ["template", "cp", umbrella, "--namespace", "dev", "--is-upgrade", "--kube-version", "1.33.0", "-f", valuesFile,
          ...(target ? ["--set-string", `control-plane.ui.image.digest=sha256:${"b".repeat(64)}`] : [])], { env: helmEnv, maxBuffer: 32 * 1024 * 1024 });
        return yaml.parseAllDocuments(stdout).map(doc => ({ object: doc.toJSON(), manifest: doc.toString() })).filter(v => v.object);
      };
      const before = await render(false), after = await render(true);
      const ordinary = docs => docs.filter(v => !v.object.metadata?.annotations?.["helm.sh/hook"]).map(v => v.object);
      const renderedHooks = after.filter(v => v.object.metadata?.annotations?.["helm.sh/hook"]).map(v => ({ name: v.object.metadata.name, kind: v.object.kind,
        events: v.object.metadata.annotations["helm.sh/hook"].split(","), manifest: v.manifest }));
      const kinds = new Set(ordinary(after).map(v => v.kind));
      for (const kind of ["Ingress", "CronJob", "PersistentVolumeClaim", "NetworkPolicy", "HorizontalPodAutoscaler", "PodDisruptionBudget", "PrometheusRule"]) assert.equal(kinds.has(kind), enabled, kind);
      assert.ok(renderedHooks.some(h => h.name === "cp-control-plane-migrate"));
      assert.equal(renderedHooks.some(h => h.name.endsWith("collector-schema")), enabled);
      for (const event of events) assert.equal(renderedHooks.some(h => h.events.includes(event) && h.kind === "Pod"), enabled, event);
      const f = fixture(); f.current = ordinary(before); f.target = ordinary(after); f.rollback = structuredClone(f.current); f.hooks = renderedHooks;
      const objectUids = renderedObjectUids(f, options());
      const execute = f.execute;
      f.execute = async (file, args, io) => file === "kubectl" && args.includes("create")
        ? list(yaml.parseAllDocuments(io.input).flatMap(doc => { const v = doc.toJSON(); return v?.kind === "List" ? v.items : v ? [v] : []; }))
        : execute(file, args, io);
      await assert.rejects(f.run({ ...options(), chart: umbrella, mode: "apply",
        objectUids: objectUids.filter(v => !(v.kind === "Service" && v.name === "cp-control-plane-ui")),
      }), /missing\/mismatched baseline object UID/);
      assert.equal(writes(f).length, 0);
      const plan = await f.run({ ...options(), chart: umbrella, objectUids });
      assert.equal(plan.liveObjects.length, f.current.length);
      assert.ok(plan.liveObjects.some(v => v.kind === "Service" && v.name === "cp-control-plane-ui"));
      assert.equal(plan.liveObjects.some(v => v.kind === "NetworkPolicy" && v.name === "cp-control-plane-ui"), enabled);
      assert.equal(plan.hooks.length, renderedHooks.length);
      assert.ok(plan.hooks.every(h => h.action === "suppressed"));
      assert.ok(plan.hooks.filter(h => h.id.startsWith("Pod/")).every(h => h.classification === "migration/job"));
      const unauthorized = { ...options(), chart: umbrella, objectUids, mode: "apply", noHooks: false, authorizedHooks: [authorize(renderedHooks.find(h => h.name === "cp-control-plane-migrate"))] };
      await assert.rejects(f.run(unauthorized), /--no-hooks/);
      assert.equal(writes(f).length, 0);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("API defaults and allocated Service fields normalize without hiding workload drift", async () => {
  const f = fixture(), cp = f.live[1], svc = f.live[5];
  Object.assign(cp.spec, { revisionHistoryLimit: 10, progressDeadlineSeconds: 600, strategy: { type: "RollingUpdate", rollingUpdate: { maxSurge: "25%", maxUnavailable: "25%" } } });
  cp.spec.template.metadata.creationTimestamp = null;
  Object.assign(cp.spec.template.spec, { restartPolicy: "Always", terminationGracePeriodSeconds: 30, dnsPolicy: "ClusterFirst", schedulerName: "default-scheduler", securityContext: {} });
  Object.assign(cp.spec.template.spec.containers[0], { terminationMessagePath: "/dev/termination-log", terminationMessagePolicy: "File" });
  Object.assign(svc.spec, { clusterIP: "10.96.1.2", clusterIPs: ["10.96.1.2"], ipFamilies: ["IPv4"], ipFamilyPolicy: "SingleStack", type: "ClusterIP", sessionAffinity: "None", internalTrafficPolicy: "Cluster" });
  svc.spec.ports[0].protocol = "TCP";
  f.live[2].type = "Opaque";
  await f.run();
  cp.spec.template.spec.containers[0].env = [{ name: "UNAUTHORIZED", value: "true" }];
  await assert.rejects(f.run({ ...options(), mode: "apply" }), /live object differs/);
  assert.equal(writes(f).length, 0);
});

for (const [kind, name, field, before, after] of [
  ["Service", "api", "clusterIP", "10.96.1.2", "10.96.1.3"],
  ["PersistentVolumeClaim", "backups", "storageClassName", "durable", "ephemeral"],
]) test(`explicit ${kind} ${field} remains part of the baseline hash`, async () => {
  const f = fixture();
  for (const collection of [f.current, f.target, f.rollback, f.live]) collection.find(v => v.kind === kind && v.metadata.name === name).spec[field] = before;
  await f.run();
  f.live.find(v => v.kind === kind && v.metadata.name === name).spec[field] = after;
  await assert.rejects(f.run({ ...options(), mode: "apply" }), /live object differs/);
  assert.equal(writes(f).length, 0);
});

test("a terminating object and an object in another namespace are refused", async () => {
  for (const mutate of [v => { v.metadata.deletionTimestamp = "2026-11-02T00:00:00Z"; }, v => { v.metadata.namespace = "other"; }]) {
    const f = fixture(); mutate(f.live[5]);
    await assert.rejects(f.run({ ...options(), mode: "apply" }), /live object/);
    assert.equal(writes(f).length, 0);
  }
});

test("chart content, including a dependency, is pinned until apply", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scoped-chart-pin-"));
  try {
    cpSync(resolve("deploy/helm/control-plane"), dir, { recursive: true });
    mkdirSync(join(dir, "charts", "nested", "templates"), { recursive: true });
    const nested = join(dir, "charts", "nested", "templates", "hook.yaml");
    writeFileSync(nested, "# approved dependency");
    const f = fixture(), execute = f.execute;
    f.execute = async (file, args, io) => { const out = await execute(file, args, io); if (file === "image-proof") writeFileSync(nested, "# changed dependency"); return out; };
    await assert.rejects(f.run({ ...options(), chart: dir, mode: "apply" }), /chart changed/);
    assert.equal(writes(f).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("indirect Capabilities templates cannot enable hooks through apply", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scoped-chart-capabilities-"));
  try {
    writeFileSync(join(dir, "hook.tpl"), '{{ $c := index . "Capabilities" }}{{ if lt (first $c.APIVersions) "m" }}approved{{ else }}unapproved{{ end }}');
    const f = fixture();
    await assert.rejects(f.run({ ...options(), chart: dir, mode: "apply", noHooks: false, authorizedHooks: [authorize(f.hooks[0])] }), /--no-hooks/);
    assert.equal(f.calls.length, 0);
    const plan = await f.run({ ...options(), chart: dir, mode: "apply" });
    assert.ok(plan.command.args.includes("--no-hooks"));
    assert.equal(plan.hooks[0].action, "suppressed");
    assert.equal(writes(f).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
