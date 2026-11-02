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
  spec: { replicas: 2, template: { spec: { containers: [{ name: container, image: img }] } } },
});
const list = items => JSON.stringify({ apiVersion: "v1", kind: "List", items });
function hook(name = "cp-control-plane-migrate", events = ["pre-install", "pre-upgrade"]) {
  return { name, kind: "Job", events, manifest: JSON.stringify(resource("Job", name, {
    metadata: { name, annotations: { "helm.sh/hook": events.join(",") } },
    spec: { template: { spec: { containers: [{ name: "migrate", image: "cp:unchanged", command: ["node", "dist/db/migrate-cli.js"] }] } } },
  })) };
}
const baselineUids = () => [
  ["Deployment", "cp-control-plane"], ["Secret", "credentials"], ["PersistentVolumeClaim", "backups"],
  ["ConfigMap", "operational"], ["Service", "api"], ["NetworkPolicy", "ingress"], ["CronJob", "backup"],
].map(([kind, name]) => ({ kind, name, namespace: "dev", uid: `uid-${name}` }));
function renderedObjectUids(f, o) {
  f.live = structuredClone(f.current);
  for (const obj of f.live) {
    const namespace = obj.metadata.namespace ?? o.namespace;
    Object.assign(obj.metadata, { namespace, uid: `uid-${obj.kind}-${namespace}-${obj.metadata.name}`, resourceVersion: "1" });
  }
  // Service and NetworkPolicy can share the authorized Deployment's name.
  return f.live.filter(v => !(v.kind === "Deployment" && v.metadata.name === o.deployment && v.metadata.namespace === o.namespace))
    .map(v => ({ kind: v.kind, name: v.metadata.name, namespace: v.metadata.namespace, uid: v.metadata.uid }));
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
  const f = { current, target, live, rollback: structuredClone(current), hooks: [hook()], calls: [], output: [],
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
      return "applied";
    }
    assert.equal(file, "image-proof");
    assert.deepEqual(args, [image("a"), "/tmp/explicit-config", "lab", "dev"]);
    return "image exists on all eligible nodes";
  };
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

test("apply is explicit and is the final step after rollback and image proof", async () => {
  const f = fixture();
  await f.run({ ...options(), mode: "apply" });
  assert.equal(writes(f).length, 1);
  assert.equal(f.calls.at(-1).file, "helm");
  assert.ok(f.calls.some(c => c.file === "image-proof"));
  assert.ok(f.calls.at(-1).args.includes("--no-hooks"));
  assert.ok(f.calls.at(-1).args.includes("--post-renderer"));
});

test("hidden migration in chart hooks blocks an upgrade with hooks enabled", async () => {
  const f = fixture();
  await assert.rejects(f.run({ ...options(), noHooks: false, authorizedHooks: [authorize(hook("backup"))] }), /hook|migration/i);
  assert.ok(f.calls.some(c => c.args.includes("--dry-run=server")));
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

test("authorized migration hooks can apply with exact manifest, identity, events and classification", async () => {
  const f = fixture();
  const plan = await f.run({ ...options(), mode: "apply", noHooks: false, authorizedHooks: [authorize(f.hooks[0])] });
  assert.equal(writes(f).length, 1);
  assert.equal(plan.hooks[0].action, "authorized");
  assert.ok(!plan.command.args.includes("--no-hooks"));
});

for (const field of ["name", "kind", "events", "manifestSha256", "classification"]) test(`hook authorization pins ${field}`, async () => {
  const f = fixture(), auth = authorize(f.hooks[0]);
  auth[field] = field === "events" ? ["pre-upgrade"] : field === "manifestSha256" ? "c".repeat(64) : "test";
  await assert.rejects(f.run({ ...options(), mode: "apply", noHooks: false, authorizedHooks: [auth] }), /hook|authorization|migration/i);
  assert.equal(writes(f).length, 0);
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
test("unknown hooks remain blocking even with matching unknown authorization", async () => {
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
test("all out-of-scope objects are read by identity twice, with normalized proof", async () => {
  const f = fixture(); f.live[1].status = { readyReplicas: 2 }; f.live[1].metadata.managedFields = [{ manager: "controller" }];
  const plan = await f.run();
  assert.equal(plan.liveObjects.length, f.current.length - 1);
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
  else if (args.includes("get")) { const pos = args.indexOf("get"); out = f.live.find(v => v.kind === args[pos+1] && v.metadata.name === args[pos+2]) ?? {}; }
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
      writeFileSync(process.env.SCOPED_FIXTURE, JSON.stringify(f));
    }
    if (process.env.DRIFT_HOOKS) {
      const h = JSON.parse(f.hooks[0].manifest);
      h.spec.template.spec.containers[0].command.push("--changed");
      f.hooks[0].manifest = JSON.stringify(h);
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
    const appliedHooks = await promisify(execFile)(process.execPath, [script, ...hookArgv], { env });
    assert.equal(JSON.parse(appliedHooks.stdout).hooks[0].action, "authorized");
    await assert.rejects(promisify(execFile)(process.execPath, [script, ...hookArgv], {
      env: { ...env, DRIFT_HOOKS: "1" },
    }), error => error.code === 1 && /apply command failed/.test(error.stderr));
    for (const drift of ["missing", "recreated", "spec"]) {
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
    { noHooks: false }, { mode: "unknown" }, { verifyImageCommand: [] },
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

for (const change of ["body", "events", "added"]) test(`hook inventory rechecked immediately before apply: ${change}`, async () => {
  const f = fixture(), execute = f.execute, auth = authorize(f.hooks[0]);
  f.execute = async (file, args, io) => {
    const out = await execute(file, args, io);
    if (file === "image-proof") {
      if (change === "body") { const obj = JSON.parse(f.hooks[0].manifest); obj.spec.template.spec.containers[0].args = ["--changed"]; f.hooks[0].manifest = JSON.stringify(obj); }
      if (change === "events") f.hooks[0] = hook(undefined, ["post-upgrade"]);
      if (change === "added") f.hooks.push(hook("additional"));
    }
    return out;
  };
  await assert.rejects(f.run({ ...options(), mode: "apply", noHooks: false, authorizedHooks: [auth] }), /hook|authorization/i);
  assert.equal(writes(f).length, 0);
});

test("a direct pg_dump backup hook can apply when fully authorized", async () => {
  const f = fixture(), h = hook("backup", ["post-upgrade"]), obj = JSON.parse(h.manifest);
  obj.spec.template.spec.containers = [{ name: "pg-dump", image: "backup:fixed", command: ["pg_dump"] }];
  h.manifest = JSON.stringify(obj); f.hooks = [h];
  const plan = await f.run({ ...options(), mode: "apply", noHooks: false, authorizedHooks: [authorize(h, "backup")] });
  assert.equal(plan.hooks[0].classification, "backup");
  assert.equal(writes(f).length, 1);
});

test("migration env content also overrides test classification", async () => {
  const f = fixture(), h = hook("seed", ["test"]), obj = JSON.parse(h.manifest);
  obj.spec.template.spec.containers = [{ name: "seed", image: "tool:fixed", env: [{ name: "STARTUP_SQL", value: "ALTER TABLE hidden ADD id int" }] }];
  h.manifest = JSON.stringify(obj); f.hooks = [h];
  assert.equal((await f.run()).hooks[0].classification, "migration/job");
});

test("live UID baseline must cover exactly the release objects outside image scope", async () => {
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
  assert.equal(plan.liveObjects.length, f.current.length - 1);
  assert.deepEqual(plan.liveObjects.filter(v => v.name === o.deployment).map(v => ({ kind: v.kind, uid: v.uid })), [
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
      assert.equal(plan.liveObjects.length, f.current.length - 1);
      assert.ok(plan.liveObjects.some(v => v.kind === "Service" && v.name === "cp-control-plane-ui"));
      assert.equal(plan.liveObjects.some(v => v.kind === "NetworkPolicy" && v.name === "cp-control-plane-ui"), enabled);
      assert.equal(plan.hooks.length, renderedHooks.length);
      assert.ok(plan.hooks.every(h => h.action === "suppressed"));
      assert.ok(plan.hooks.filter(h => h.id.startsWith("Pod/")).every(h => h.classification === "migration/job"));
      const unauthorized = { ...options(), chart: umbrella, objectUids, mode: "apply", noHooks: false, authorizedHooks: [authorize(renderedHooks.find(h => h.name === "cp-control-plane-migrate"))] };
      if (enabled) { await assert.rejects(f.run(unauthorized), /hook|authorization|volatile|deterministic/i); assert.equal(writes(f).length, 0); }
      else await assert.rejects(f.run(unauthorized), /volatile|deterministic/i);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("API defaults and allocated Service fields normalize without hiding workload drift", async () => {
  const f = fixture(), cp = f.live[1], svc = f.live[5];
  Object.assign(cp.spec, { revisionHistoryLimit: 10, progressDeadlineSeconds: 600, strategy: { type: "RollingUpdate", rollingUpdate: { maxSurge: "25%", maxUnavailable: "25%" } } });
  cp.spec.template.metadata = { creationTimestamp: null };
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

test("hook-enabled apply refuses volatile chart templates that could evade re-render hashes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scoped-chart-volatile-"));
  try {
    cpSync(resolve("deploy/helm/control-plane"), dir, { recursive: true });
    writeFileSync(join(dir, "templates", "_dynamic.tpl"), '{{ define "dynamic" }}{{ lookup "v1" "ConfigMap" "dev" "sql" }}{{ end }}');
    const f = fixture();
    await assert.rejects(f.run({ ...options(), chart: dir, mode: "apply", noHooks: false, authorizedHooks: [authorize(f.hooks[0])] }), /volatile|deterministic/i);
    assert.equal(writes(f).length, 0);
    // Suppressed hooks retain the ordinary full-manifest and live-object checks.
    await f.run({ ...options(), chart: dir });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
