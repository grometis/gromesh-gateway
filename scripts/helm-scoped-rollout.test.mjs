import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
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
  rollbackRevision: 4, mode: "plan", overrides: [],
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
  const f = { current, target, rollback: structuredClone(current), hooks: [hook()], calls: [], output: [],
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
  assert.equal(f.calls.at(-2).file, "image-proof");
  assert.ok(f.calls.at(-1).args.includes("--no-hooks"));
  assert.ok(f.calls.at(-1).args.includes("--post-renderer"));
});

test("hidden migration in chart hooks blocks an upgrade with hooks enabled", async () => {
  const f = fixture();
  await assert.rejects(f.run({ ...options(), noHooks: false, authorizedHooks: ["Job/backup"] }), /hook|migration/i);
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

test("only explicitly named non-migration upgrade hooks can run", async () => {
  const f = fixture();
  const backup = hook("backup", ["post-upgrade"]);
  const obj = JSON.parse(backup.manifest);
  obj.spec.template.spec.containers = [{ name: "pg-dump", image: "backup:fixed", command: ["pg_dump"] }];
  backup.manifest = JSON.stringify(obj);
  f.hooks = [backup, hook("smoke-test", ["test"])];
  const plan = await f.run({ ...options(), noHooks: false, authorizedHooks: ["Job/backup"] });
  assert.equal(plan.hooks[0].classification, "backup");
  assert.equal(plan.hooks[0].action, "authorized");
  assert.equal(plan.hooks[1].classification, "test");
  assert.equal(plan.hooks[1].action, "not-run-on-upgrade");
});

test("even explicit migration authorization cannot bypass the no-migrations invariant", async () => {
  const f = fixture();
  await assert.rejects(f.run({ ...options(), noHooks: false, authorizedHooks: ["Job/cp-control-plane-migrate"] }), /migration/i);
});

test("adding a test event to an upgrade migration cannot bypass migration detection", async () => {
  const f = fixture();
  f.hooks = [hook("cp-control-plane-migrate", ["pre-upgrade", "test"])];
  await assert.rejects(f.run({ ...options(), noHooks: false, authorizedHooks: ["Job/cp-control-plane-migrate"] }), /migration/i);
  assert.equal(writes(f).length, 0);
});

test("a backup-named Job running SQL cannot bypass the no-migrations invariant", async () => {
  const f = fixture();
  const backup = hook("backup", ["pre-upgrade"]), obj = JSON.parse(backup.manifest);
  obj.spec.template.spec.containers = [{ name: "pg-dump", image: "cp:unchanged", command: ["psql"], args: ["-c", "ALTER TABLE customers ADD COLUMN hidden text"] }];
  backup.manifest = JSON.stringify(obj); f.hooks = [backup];
  await assert.rejects(f.run({ ...options(), noHooks: false, authorizedHooks: ["Job/backup"] }), /migration|backup/i);
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

test("hook-enabled apply fails closed because Helm does not pass hooks to its post-renderer", async () => {
  const f = fixture();
  const backup = hook("backup", ["post-upgrade"]), obj = JSON.parse(backup.manifest);
  obj.spec.template.spec.containers = [{ name: "pg-dump", image: "backup:fixed", command: ["pg_dump"] }];
  backup.manifest = JSON.stringify(obj); f.hooks = [backup];
  await assert.rejects(f.run({ ...options(), noHooks: false, authorizedHooks: ["Job/backup"], mode: "apply" }), /hook.*apply|apply.*hook/i);
  assert.equal(writes(f).length, 0);
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
  else if (args.includes("create") && args.includes("--dry-run=client")) out = JSON.parse(readFileSync(0,"utf8"));
  else throw Error("unexpected kubectl call");
} else if (tool === "helm") {
  if (args[0] === "history") out = f.history;
  else if (args[0] === "get") out = list(args.includes("--revision") ? f.rollback : f.current);
  else if (args[0] === "upgrade" && args.includes("--dry-run=server")) out = {name:"cp", namespace:"dev", version:6, manifest:JSON.stringify(list(f.target)), hooks:f.hooks};
  else if (args[0] === "rollback" && args.includes("--dry-run")) out = "OK";
  else if (args[0] === "upgrade" && args.includes("--no-hooks")) {
    const renderer = args[args.indexOf("--post-renderer") + 1];
    const rendererArgs = args.filter(a => a.startsWith("--post-renderer-args=")).map(a => a.slice("--post-renderer-args=".length));
    const manifest = JSON.stringify(list(f.target)) + (process.env.DRIFT_RENDER ? "\\n# drift" : "");
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
      "--verify-image-command": JSON.stringify(o.verifyImageCommand) }).flat();
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
    "--chart", "deploy/helm/control-plane", "--deployment", "cp-control-plane-ui", "--container", "ui",
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
