#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isAbsolute } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const refuse = message => { throw new Error(`Scoped rollout refused: ${message}`); };
const sha256 = value => createHash("sha256").update(value).digest("hex");
const scopedEnvironment = kubeconfig => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HELM_KUBE"))), KUBECONFIG: kubeconfig });
const namePattern = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const hookEvents = new Set(["pre-install", "post-install", "pre-delete", "post-delete", "pre-upgrade", "post-upgrade", "pre-rollback", "post-rollback", "test", "test-success", "test-failure"]);
const valueFlags = {
  "--release": "release", "--namespace": "namespace", "--kube-context": "kubeContext", "--kubeconfig": "kubeconfig",
  "--expected-cluster": "expectedCluster", "--expected-uid": "expectedUid", "--expected-ca-sha256": "expectedCaSha256",
  "--chart": "chart", "--deployment": "deployment", "--container": "container", "--image": "image",
  "--image-values-prefix": "imageValuesPrefix", "--rollback-revision": "rollbackRevision", "--verify-image-command": "verifyImageCommand",
};

// The only writable path authorized by this operation is one named Deployment container's image.
// Example: --deployment cp-control-plane-ui --container ui --image repo@sha256:<64 hex>.
// --verify-image-command is a JSON argv array; the four placeholders below must be whole arguments.
export function parseArgs(argv) {
  const options = { mode: "plan", noHooks: false, authorizedHooks: [], overrides: [], imageValuesPrefix: "ui.image" };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (["--plan", "--apply", "--no-hooks"].includes(flag)) {
      const key = flag === "--no-hooks" ? flag : "mode";
      if (seen.has(key)) refuse("duplicate/conflicting mode or --no-hooks flag");
      seen.add(key);
      if (flag === "--no-hooks") options.noHooks = true;
      else options.mode = flag.slice(2);
      continue;
    }
    if (!valueFlags[flag] && !["--authorize-hook", "--set-string"].includes(flag)) refuse("unknown argument");
    const value = argv[++i];
    if (!value || value.startsWith("-")) refuse(`missing value for ${flag}`);
    if (flag === "--authorize-hook") options.authorizedHooks.push(value);
    else if (flag === "--set-string") options.overrides.push(value);
    else {
      if (seen.has(flag)) refuse(`duplicate ${flag}`);
      seen.add(flag);
      options[valueFlags[flag]] = value;
    }
  }
  if (options.rollbackRevision !== undefined) {
    if (!/^[1-9][0-9]*$/.test(options.rollbackRevision)) refuse("invalid rollback revision");
    options.rollbackRevision = Number(options.rollbackRevision);
  }
  if (options.verifyImageCommand !== undefined) options.verifyImageCommand = json(options.verifyImageCommand, "image verification command");
  validateOptions(options);
  return options;
}

function imageParts(image) {
  const match = /^([a-z0-9.-]+(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+)@(sha256:[a-f0-9]{64})$/.exec(image ?? "");
  if (!match) refuse("image must be an immutable repo@sha256:64hex reference without a tag");
  return { repository: match[1], digest: match[2] };
}

function validateOptions(o) {
  for (const key of ["release", "namespace", "deployment", "container"])
    if (typeof o[key] !== "string" || !namePattern.test(o[key])) refuse(`explicit ${key} is required`);
  for (const key of ["kubeContext", "expectedCluster", "expectedUid", "chart"])
    if (typeof o[key] !== "string" || !o[key].trim() || o[key].startsWith("-") || /[\x00-\x1f]/.test(o[key])) refuse(`explicit ${key} is required`);
  if (typeof o.kubeconfig !== "string" || !isAbsolute(o.kubeconfig) || o.kubeconfig.includes("\0")) refuse("explicit absolute kubeconfig is required");
  if (!/^[a-f0-9]{64}$/.test(o.expectedCaSha256 ?? "")) refuse("expected CA SHA-256 is required (decoded certificate-authority-data bytes)");
  imageParts(o.image);
  if (!Number.isSafeInteger(o.rollbackRevision) || o.rollbackRevision < 1) refuse("explicit rollback revision is required");
  if (!["plan", "apply"].includes(o.mode)) refuse("invalid mode");
  if (typeof o.noHooks !== "boolean" || !Array.isArray(o.authorizedHooks) || !Array.isArray(o.overrides)) refuse("invalid hook/override policy");
  if (new Set(o.authorizedHooks).size !== o.authorizedHooks.length || o.authorizedHooks.some(h => !/^[A-Za-z][A-Za-z0-9]*\/[a-z0-9][a-z0-9.-]*$/.test(h))) refuse("authorize each hook explicitly as Kind/name");
  if (!o.authorizedHooks.length && !o.noHooks) refuse("--no-hooks is required without authorized hooks");
  if (o.authorizedHooks.length && o.noHooks) refuse("--no-hooks conflicts with authorized hooks");
  if (!/^[a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)*$/.test(o.imageValuesPrefix ?? "")) refuse("invalid image values prefix");
  for (const value of o.overrides) {
    // Helm interprets commas as extra assignments, even when passed in a single argv entry.
    if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_.]*=[^,\x00-\x1f]*$/.test(value)
      || /password|secret|token|credential|encryption|fingerprint/i.test(value.split("=", 1)[0])) refuse("invalid or sensitive --set-string override");
  }
  const command = o.verifyImageCommand;
  if (!Array.isArray(command) || !command.length || command.some(a => typeof a !== "string" || !a || /[\x00-\x1f]/.test(a))
    || command[0].startsWith("-") || ["{image}", "{kubeconfig}", "{context}", "{namespace}"].some(p => !command.slice(1).includes(p)))
    refuse("image verification requires a JSON argv command with {image}, {kubeconfig}, {context}, {namespace} arguments");
}

async function execute(file, args, { input, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout: 360000, maxBuffer: 32 * 1024 * 1024, encoding: "utf8", env },
      (error, stdout) => error ? reject(new Error("executor failed")) : resolve(stdout));
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}
function json(raw, stage) {
  try { return JSON.parse(raw); }
  catch { refuse(`invalid JSON from ${stage}`); }
}
const helmScope = o => ["--namespace", o.namespace, "--kube-context", o.kubeContext, "--kubeconfig", o.kubeconfig];
const kubeScope = o => ["--namespace", o.namespace, "--context", o.kubeContext, "--kubeconfig", o.kubeconfig];
function upgradeArgs(o) {
  const { repository, digest } = imageParts(o.image);
  return ["upgrade", o.release, o.chart, ...helmScope(o), "--reuse-values", ...o.overrides.flatMap(v => ["--set-string", v]),
    "--set-string", `${o.imageValuesPrefix}.repository=${repository}`, "--set-string", `${o.imageValuesPrefix}.digest=${digest}`,
    "--set-string", `${o.imageValuesPrefix}.tag=`, ...(o.noHooks ? ["--no-hooks"] : []), "--wait", "--timeout", "5m"];
}

function postRendererArgs(proof) {
  return ["--post-renderer", process.execPath, `--post-renderer-args=${fileURLToPath(import.meta.url)}`,
    "--post-renderer-args=--check-render", `--post-renderer-args=${JSON.stringify(proof)}`];
}

export function assertUpgradeCommand(args, o, proof) {
  const expected = [...upgradeArgs(o), ...(proof ? postRendererArgs(proof) : [])];
  if (!isDeepStrictEqual(args, expected) || (!o.authorizedHooks.length && !args.includes("--no-hooks")))
    refuse("final upgrade command differs from validated command or lacks --no-hooks");
}

async function identity(o, run) {
  const config = json(await run("context/CA", "kubectl", [...kubeScope(o), "config", "view", "--raw", "--flatten", "--minify", "-o", "json"]), "context");
  const context = config?.contexts?.[0], cluster = config?.clusters?.[0];
  if (config?.["current-context"] !== o.kubeContext || config.contexts?.length !== 1 || context?.name !== o.kubeContext
    || context.context?.cluster !== o.expectedCluster || config.clusters?.length !== 1 || cluster?.name !== o.expectedCluster)
    refuse("context/cluster does not match explicit expected identity");
  const tls = cluster.cluster;
  if (!tls || tls["insecure-skip-tls-verify"] || !/^https:\/\//.test(tls.server ?? "") || !tls["certificate-authority-data"])
    refuse("cluster TLS/CA proof missing");
  const encoded = tls["certificate-authority-data"];
  if (typeof encoded !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
    || createHash("sha256").update(Buffer.from(encoded, "base64")).digest("hex") !== o.expectedCaSha256) refuse("cluster CA mismatch");
  const ns = json(await run("cluster UID", "kubectl", [...kubeScope(o), "get", "namespace", "kube-system", "-o", "json"]), "cluster UID");
  if (ns?.metadata?.name !== "kube-system" || ns.metadata.uid !== o.expectedUid) refuse("kube-system UID mismatch");
}

function key(object, namespace) {
  if (!object || typeof object !== "object" || typeof object.apiVersion !== "string" || !object.apiVersion
    || typeof object.kind !== "string" || !object.kind || !namePattern.test(object.metadata?.name ?? "")) refuse("invalid manifest object identity");
  if (object.metadata.namespace !== undefined && object.metadata.namespace !== namespace) refuse("manifest object outside authorized namespace");
  return JSON.stringify([object.apiVersion, object.kind, object.metadata.namespace ?? namespace, object.metadata.name]);
}

async function objects(raw, o, run, stage) {
  if (typeof raw !== "string" || !raw.trim()) refuse(`empty ${stage} manifest`);
  // Reuse kubectl's YAML decoder, including multi-document YAML and block scalars; never apply.
  const parsed = json(await run(`${stage} decode`, "kubectl", [...kubeScope(o), "create", "--dry-run=client", "--validate=false", "-f", "-", "-o", "json"], raw), `${stage} decode`);
  const items = parsed?.kind === "List" ? parsed.items : [parsed];
  if (!Array.isArray(items) || !items.length) refuse(`empty/invalid ${stage} objects`);
  const map = new Map();
  for (const object of items) {
    const id = key(object, o.namespace);
    if (map.has(id)) refuse(`duplicate object in ${stage}`);
    map.set(id, object);
  }
  return map;
}

function container(object, name) {
  const containers = object?.spec?.template?.spec?.containers;
  const matches = Array.isArray(containers) ? containers.filter(c => c.name === name) : [];
  if (matches.length !== 1 || typeof matches[0].image !== "string") refuse("missing/ambiguous authorized Deployment container image");
  return matches[0];
}
function authorizedObject(map, o) {
  const matches = [...map.values()].filter(v => v.apiVersion === "apps/v1" && v.kind === "Deployment" && v.metadata.name === o.deployment);
  if (matches.length !== 1) refuse("authorized Deployment is missing/ambiguous");
  return matches[0];
}
function compare(current, target, o, stage) {
  if (current.size !== target.size) refuse(`${stage}: object added or removed outside image scope`);
  const oldDeployment = authorizedObject(current, o), newDeployment = authorizedObject(target, o);
  const previousImage = container(oldDeployment, o.container).image;
  if (container(newDeployment, o.container).image !== o.image) refuse(`${stage}: target image does not match authorized digest`);
  for (const [id, before] of current) {
    const after = target.get(id);
    if (!after) refuse(`${stage}: object identity changed outside image scope`);
    const expected = structuredClone(before);
    if (before === oldDeployment) container(expected, o.container).image = o.image;
    if (!isDeepStrictEqual(expected, after)) refuse(`${stage}: ${before.kind}/${before.metadata.name} changed outside authorized image path`);
  }
  return previousImage;
}
function classification(object, events = []) {
  if (events.some(e => e.startsWith("test")) && !events.some(e => ["pre-upgrade", "post-upgrade"].includes(e))) return "test";
  const text = JSON.stringify(object).toLowerCase();
  if (/migrat|db:migrate/.test(text)) return "migration/job";
  if (/backup|pg_dump|pg-dump|pg_restore/.test(text)) return "backup";
  return object.kind === "Job" ? "migration/job" : "other";
}

function readOnlyBackup(object) {
  const pod = object.kind === "Job" ? object.spec?.template?.spec : object.kind === "Pod" ? object.spec : undefined;
  if (!pod || pod.initContainers?.length || pod.ephemeralContainers?.length || pod.containers?.length !== 1) return false;
  const c = pod.containers[0];
  return isDeepStrictEqual(c.command, ["pg_dump"]) && !c.lifecycle && !c.livenessProbe && !c.readinessProbe && !c.startupProbe;
}

async function hooks(inventory, o, run) {
  if (!Array.isArray(inventory)) refuse("chart hook inventory missing from Helm JSON dry-run output");
  const seen = new Set(), result = [];
  for (const hook of inventory) {
    if (!hook || !Array.isArray(hook.events) || !hook.events.length || hook.events.some(e => !hookEvents.has(e))) refuse("invalid/unknown chart hook events");
    const map = await objects(hook.manifest, o, run, "hook");
    if (map.size !== 1) refuse("hook manifest must contain exactly one object");
    const object = [...map.values()][0], id = `${object.kind}/${object.metadata.name}`;
    const annotation = object.metadata.annotations?.["helm.sh/hook"];
    if (object.kind !== hook.kind || object.metadata.name !== hook.name || typeof annotation !== "string"
      || !isDeepStrictEqual(annotation.split(",").map(e => e.trim()).sort(), [...hook.events].sort()) || seen.has(id)) refuse("inconsistent/duplicate hook inventory");
    seen.add(id);
    const type = classification(object, hook.events);
    const upgrade = hook.events.some(e => ["pre-upgrade", "post-upgrade"].includes(e));
    const action = o.noHooks ? "suppressed" : upgrade ? "authorized" : "not-run-on-upgrade";
    if (!o.noHooks && upgrade) {
      if (!o.authorizedHooks.includes(id)) refuse(`upgrade hook ${id} lacks explicit authorization`);
      if (type === "migration/job") refuse(`migration/unknown Job hook ${id} cannot run in a scoped rollout`);
      if (type === "backup" && !readOnlyBackup(object)) refuse(`backup hook ${id} is not a direct read-only pg_dump operation`);
    }
    result.push({ id, classification: type, events: hook.events, action });
  }
  for (const id of o.authorizedHooks)
    if (!result.some(h => h.id === id && h.action === "authorized")) refuse(`authorized hook ${id} does not run on upgrade`);
  return result;
}

export async function scopedRollout(input, { execute: executor = execute, emit = value => console.log(JSON.stringify(value, null, 2)) } = {}) {
  const o = structuredClone(input);
  validateOptions(o);
  const env = scopedEnvironment(o.kubeconfig);
  const run = async (stage, file, args, stdin) => {
    try {
      const output = await executor(file, args, { input: stdin, env });
      if (typeof output !== "string") refuse("executor returned no stdout");
      return output;
    } catch { refuse(`${stage} command failed`); }
  };
  await identity(o, run);
  const history = json(await run("release history", "helm", ["history", o.release, ...helmScope(o), "--max", "1024", "--output", "json"]), "history");
  if (!Array.isArray(history) || !history.length || history.some(h => !Number.isSafeInteger(h.revision) || h.revision < 1)
    || new Set(history.map(h => h.revision)).size !== history.length) refuse("invalid release history");
  const latest = history.reduce((a, b) => a.revision > b.revision ? a : b);
  const rollbackRevision = history.find(h => h.revision === o.rollbackRevision);
  if (latest.status !== "deployed" || !rollbackRevision || !["deployed", "superseded"].includes(rollbackRevision.status)) refuse("rollback revision unavailable or release not deployed");
  const currentRaw = await run("current manifest", "helm", ["get", "manifest", o.release, ...helmScope(o)]);
  const current = await objects(currentRaw, o, run, "current");
  const command = { file: "helm", args: upgradeArgs(o) };
  assertUpgradeCommand(command.args, o);
  // Helm's release JSON contains BOTH manifest and hooks. helm get manifest alone omits hooks.
  const rendered = json(await run("target render", "helm", [...command.args, "--dry-run=server", "--output", "json"]), "target render");
  if (rendered?.name !== o.release || rendered.namespace !== o.namespace || rendered.version !== latest.revision + 1) refuse("rendered release identity/revision mismatch");
  const inventory = await hooks(rendered.hooks, o, run);
  if (o.mode === "apply" && !o.noHooks) refuse("hook-enabled apply cannot be verified by Helm's post-renderer; --no-hooks is required for apply");
  const target = await objects(rendered.manifest, o, run, "target");
  const previousImage = compare(current, target, o, "upgrade");
  imageParts(previousImage);
  if (previousImage === o.image) refuse("target image is already deployed");
  for (const object of target.values()) {
    if (object.metadata.annotations?.["helm.sh/hook"]) refuse("hook hidden in ordinary target manifest");
    if (object.kind === "Job") refuse("Job/migration present in scoped target manifest");
  }
  // The whole-object comparison above also pins the CP image, env, init containers and command.
  const cp = [...current.values()].find(v => v.kind === "Deployment" && v.metadata.name === `${o.release}-control-plane`);
  if (!cp || cp === authorizedObject(current, o)) refuse("unchanged control-plane Deployment proof missing");
  container(cp, "control-plane");
  const rollbackManifest = await objects(await run("rollback manifest", "helm", ["get", "manifest", o.release, ...helmScope(o), "--revision", String(o.rollbackRevision)]), o, run, "rollback");
  // A rollback of a UI-only upgrade must restore the full baseline, not older operational configuration.
  compare(current, rollbackManifest, { ...o, image: previousImage }, "rollback");
  const rollback = { file: "helm", args: ["rollback", o.release, String(o.rollbackRevision), ...helmScope(o), "--no-hooks", "--wait", "--timeout", "5m"] };
  await run("rollback dry-run", "helm", [...rollback.args, "--dry-run"]);
  await identity(o, run);
  const finalHistory = json(await run("release history recheck", "helm", ["history", o.release, ...helmScope(o), "--max", "1024", "--output", "json"]), "history recheck");
  if (!isDeepStrictEqual(finalHistory, history)) refuse("release history changed during preparation");
  const finalCurrent = await objects(await run("current manifest recheck", "helm", ["get", "manifest", o.release, ...helmScope(o)]), o, run, "current recheck");
  compare(current, finalCurrent, { ...o, image: previousImage }, "release recheck");
  const substitutions = { "{image}": previousImage, "{kubeconfig}": o.kubeconfig, "{context}": o.kubeContext, "{namespace}": o.namespace };
  const [verifyFile, ...verifyArgs] = o.verifyImageCommand.map(a => substitutions[a] ?? a);
  await run("previous image availability", verifyFile, verifyArgs);
  const renderProof = { manifestSha256: sha256(rendered.manifest), baselineSha256: sha256(currentRaw), revision: latest.revision,
    scope: Object.fromEntries(["release", "namespace", "kubeContext", "kubeconfig", "expectedCluster", "expectedUid", "expectedCaSha256"].map(k => [k, o[k]])) };
  command.args.push(...postRendererArgs(renderProof));
  assertUpgradeCommand(command.args, o, renderProof);
  const plan = { mode: o.mode, release: o.release, namespace: o.namespace, context: o.kubeContext,
    cluster: { name: o.expectedCluster, uid: o.expectedUid, caSha256: o.expectedCaSha256 },
    changes: [{ kind: "Deployment", name: o.deployment, namespace: o.namespace,
      path: `.spec.template.spec.containers[name=${o.container}].image`, before: previousImage, after: o.image }],
    hooks: inventory, migrations: "none executed; control-plane unchanged", rollbackRevision: o.rollbackRevision,
    renderProof, command, rollback };
  emit(plan);
  if (o.mode === "apply") await run("apply", command.file, command.args);
  return plan;
}

async function checkRender(proof) {
  if (!proof || !/^[a-f0-9]{64}$/.test(proof.manifestSha256 ?? "") || !/^[a-f0-9]{64}$/.test(proof.baselineSha256 ?? "")
    || !Number.isSafeInteger(proof.revision) || proof.revision < 1 || !proof.scope) refuse("invalid post-render proof");
  const raw = readFileSync(0);
  if (sha256(raw) !== proof.manifestSha256) refuse("final Helm render differs from validated target");
  const o = proof.scope;
  const run = async (stage, file, args) => {
    try { return await execute(file, args, { env: scopedEnvironment(o.kubeconfig) }); }
    catch { refuse(`${stage} command failed`); }
  };
  // This runs inside Helm after it loaded its baseline, before it creates the pending revision or executes hooks.
  await identity(o, run);
  const history = json(await run("post-render history", "helm", ["history", o.release, ...helmScope(o), "--max", "1024", "--output", "json"]), "post-render history");
  if (!Array.isArray(history) || !history.length || history.some(h => !Number.isSafeInteger(h.revision))) refuse("invalid post-render history");
  const latest = history.reduce((a, b) => a.revision > b.revision ? a : b);
  if (latest.revision !== proof.revision || latest.status !== "deployed") refuse("release changed before final render");
  const baseline = await run("post-render baseline", "helm", ["get", "manifest", o.release, ...helmScope(o)]);
  if (sha256(baseline) !== proof.baselineSha256) refuse("release baseline changed before final render");
  process.stdout.write(raw);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === "--check-render" && process.argv.length === 4) await checkRender(json(process.argv[3], "post-render proof"));
    else await scopedRollout(parseArgs(process.argv.slice(2)));
  }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
