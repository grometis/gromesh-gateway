#!/usr/bin/env node
// Requires a trusted operator and a maintenance window with no concurrent writers to the release or its objects.
// Helm/Kubernetes provide no atomic precondition from live checks to writes. The late post-renderer check
// and post-apply verification detect drift but cannot eliminate TOCTOU. Rollback is printed, never executed.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isAbsolute, resolve, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { readFileSync, readdirSync, lstatSync } from "node:fs";

const refuse = message => { throw new Error(`Scoped rollout refused: ${message}`); };
const sha256 = value => createHash("sha256").update(value).digest("hex");
const scopedEnvironment = kubeconfig => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HELM_KUBE"))), KUBECONFIG: kubeconfig });
const namePattern = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const hookEvents = new Set(["pre-install", "post-install", "pre-delete", "post-delete", "pre-upgrade", "post-upgrade", "pre-rollback", "post-rollback", "test", "test-success", "test-failure"]);
const valueFlags = {
  "--release": "release", "--namespace": "namespace", "--kube-context": "kubeContext", "--kubeconfig": "kubeconfig",
  "--expected-cluster": "expectedCluster", "--expected-uid": "expectedUid", "--expected-ca-sha256": "expectedCaSha256",
  "--chart": "chart", "--deployment": "deployment", "--container": "container", "--image": "image",
  "--object-uids": "objectUids", "--image-values-prefix": "imageValuesPrefix", "--rollback-revision": "rollbackRevision", "--verify-image-command": "verifyImageCommand",
};

// The only writable path authorized by this operation is one named Deployment container's image.
// Example: --deployment cp-control-plane-ui --container ui --image repo@sha256:<64 hex>.
// --object-uids is a JSON array of {kind,name,namespace,uid} from the approved baseline.
// Include every release object, including the Deployment whose container image is authorized.
// Helm manifests normally omit UID: never trust a first live observation as proof against recreation.
// --authorize-hook is repeatable JSON: {kind,name,events,classification,manifestSha256}.
// manifestSha256 hashes the exact UTF-8 hook.manifest returned by Helm's JSON dry-run.
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
    if (flag === "--authorize-hook") options.authorizedHooks.push(json(value, "hook authorization"));
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
  if (options.objectUids !== undefined) options.objectUids = json(options.objectUids, "object UIDs");
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
  const authIds = new Set();
  for (const h of o.authorizedHooks) {
    if (!h || typeof h !== "object" || !namePattern.test(h.name ?? "") || !/^[A-Za-z][A-Za-z0-9]*$/.test(h.kind ?? "")
      || !Array.isArray(h.events) || !h.events.length || h.events.some(e => !hookEvents.has(e))
      || new Set(h.events).size !== h.events.length || !/^[a-f0-9]{64}$/.test(h.manifestSha256 ?? "")
      || !["migration/job", "backup", "test"].includes(h.classification)) refuse("invalid explicit hook authorization");
    const id = `${h.kind}/${h.name}`;
    if (authIds.has(id)) refuse("duplicate hook authorization");
    authIds.add(id);
  }
  if (!Array.isArray(o.objectUids) || !o.objectUids.length) refuse("explicit baseline object UIDs are required");
  const uidIds = new Set();
  for (const v of o.objectUids) {
    if (!v || !namePattern.test(v.name ?? "") || !/^[A-Za-z][A-Za-z0-9]*$/.test(v.kind ?? "")
      || v.namespace !== o.namespace || typeof v.uid !== "string" || !v.uid.trim()) refuse("invalid baseline object UID");
    const id = `${v.kind}/${v.namespace}/${v.name}`;
    if (uidIds.has(id)) refuse("duplicate baseline object UID");
    uidIds.add(id);
  }
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
  return ["upgrade", o.release, resolve(o.chart), ...helmScope(o), "--reuse-values", ...o.overrides.flatMap(v => ["--set-string", v]),
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
  // Inspect all workload shapes, including init containers, shell scripts and env values.
  const strings = [];
  const visit = v => {
    if (typeof v === "string") strings.push(v);
    else if (v && typeof v === "object") Object.values(v).forEach(visit);
  };
  visit(object);
  const text = strings.join("\n").toLowerCase();
  if (/migrat|db:migrate|drizzle|\bpsql\b|\bmysql\b|pg_restore|liquibase|flyway|\b(?:alter|create|drop|truncate)\s+(?:table|schema|database|index)\b/.test(text)) return "migration/job";
  if (readOnlyBackup(object)) return "backup";
  if (events.length && events.every(e => e.startsWith("test"))) return "test";
  return "unknown";
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
    if (!hook || !Array.isArray(hook.events) || !hook.events.length || hook.events.some(e => !hookEvents.has(e)) || new Set(hook.events).size !== hook.events.length) refuse("invalid/unknown chart hook events");
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
    const manifestSha256 = sha256(hook.manifest);
    if (!o.noHooks && upgrade) {
      const auth = o.authorizedHooks.find(h => h.kind === object.kind && h.name === object.metadata.name);
      if (!auth || auth.manifestSha256 !== manifestSha256 || auth.classification !== type
        || !isDeepStrictEqual([...auth.events].sort(), [...hook.events].sort())) refuse(`upgrade hook ${id} lacks matching explicit authorization`);
      if (type === "unknown") refuse(`unknown hook ${id} cannot run in a scoped rollout`);
    }
    result.push({ id, classification: type, events: [...hook.events].sort(), manifestSha256, action });
  }
  for (const auth of o.authorizedHooks)
    if (!result.some(h => h.id === `${auth.kind}/${auth.name}` && h.action === "authorized")) refuse("authorized hook does not run on upgrade");
  return result;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
function omitDefault(object, field, value) {
  if (object && isDeepStrictEqual(object[field], value)) delete object[field];
}
function omitEmpty(object, field) {
  if (object?.[field] && !Object.keys(object[field]).length) delete object[field];
}
function allocatedFields(object) {
  // Only fields absent from the stored manifest may be treated as server allocated.
  const paths = [];
  const add = path => {
    if (path.reduce((v, k) => v?.[k], object) === undefined) paths.push(path);
  };
  if (object.kind === "Service") {
    for (const field of ["clusterIP", "clusterIPs", "ipFamilies", "healthCheckNodePort"]) add(["spec", field]);
    object.spec?.ports?.forEach((_, i) => add(["spec", "ports", i, "nodePort"]));
  }
  if (object.kind === "PersistentVolumeClaim") for (const field of ["volumeName", "storageClassName"]) add(["spec", field]);
  return paths;
}
function relevantObject(object, namespace, ignoredPaths = []) {
  // Ignore server bookkeeping, never workload fields or added containers/env/Secret data.
  // Only known API defaults/allocations normalize; unknown added fields fail closed.
  const value = structuredClone(object);
  delete value.status;
  value.metadata = { ...value.metadata, namespace: object.metadata.namespace ?? namespace,
    labels: { ...object.metadata.labels }, annotations: { ...object.metadata.annotations } };
  for (const field of ["uid", "resourceVersion", "generation", "creationTimestamp", "managedFields", "selfLink"]) delete value.metadata[field];
  for (const annotation of ["kubectl.kubernetes.io/last-applied-configuration", "deployment.kubernetes.io/revision",
    "meta.helm.sh/release-name", "meta.helm.sh/release-namespace"]) delete value.metadata.annotations[annotation];
  delete value.metadata.labels["app.kubernetes.io/managed-by"];
  for (const path of ignoredPaths) {
    const parent = path.slice(0, -1).reduce((v, k) => v?.[k], value);
    if (parent) delete parent[path.at(-1)];
  }
  const spec = value.spec;
  if (value.kind === "Secret") omitDefault(value, "type", "Opaque");
  if (value.kind === "Deployment") {
    omitDefault(spec, "replicas", 1);
    omitDefault(spec, "revisionHistoryLimit", 10);
    omitDefault(spec, "progressDeadlineSeconds", 600);
    const strategy = spec?.strategy;
    omitDefault(strategy?.rollingUpdate, "maxSurge", "25%");
    omitDefault(strategy?.rollingUpdate, "maxUnavailable", "25%");
    omitEmpty(strategy, "rollingUpdate");
    omitDefault(strategy, "type", "RollingUpdate");
    omitEmpty(spec, "strategy");
  }
  if (value.kind === "Service") {
    for (const [field, fallback] of Object.entries({ type: "ClusterIP", sessionAffinity: "None", internalTrafficPolicy: "Cluster", ipFamilyPolicy: "SingleStack" })) omitDefault(spec, field, fallback);
    for (const port of spec?.ports ?? []) { omitDefault(port, "protocol", "TCP"); omitDefault(port, "targetPort", port.port); }
  }
  if (value.kind === "PersistentVolumeClaim") omitDefault(spec, "volumeMode", "Filesystem");
  if (value.kind === "CronJob") {
    for (const [field, fallback] of Object.entries({ concurrencyPolicy: "Allow", suspend: false, successfulJobsHistoryLimit: 3, failedJobsHistoryLimit: 1 })) omitDefault(spec, field, fallback);
    omitDefault(spec?.jobTemplate?.metadata, "creationTimestamp", null);
    omitEmpty(spec?.jobTemplate, "metadata");
  }
  const template = value.kind === "CronJob" ? spec?.jobTemplate?.spec?.template : spec?.template;
  omitDefault(template?.metadata, "creationTimestamp", null);
  omitEmpty(template, "metadata");
  const pod = value.kind === "Pod" ? spec : template?.spec;
  if (pod) {
    for (const [field, fallback] of Object.entries({ restartPolicy: "Always", terminationGracePeriodSeconds: 30,
      dnsPolicy: "ClusterFirst", schedulerName: "default-scheduler", enableServiceLinks: true })) omitDefault(pod, field, fallback);
    omitEmpty(pod, "securityContext");
    for (const c of [...pod.containers ?? [], ...pod.initContainers ?? [], ...pod.ephemeralContainers ?? []]) {
      omitDefault(c, "terminationMessagePath", "/dev/termination-log");
      omitDefault(c, "terminationMessagePolicy", "File");
      for (const port of c.ports ?? []) omitDefault(port, "protocol", "TCP");
      for (const probe of [c.livenessProbe, c.readinessProbe, c.startupProbe]) {
        for (const [field, fallback] of Object.entries({ timeoutSeconds: 1, periodSeconds: 10, successThreshold: 1, failureThreshold: 3, initialDelaySeconds: 0 })) omitDefault(probe, field, fallback);
        omitDefault(probe?.httpGet, "scheme", "HTTP");
      }
      for (const env of c.env ?? []) omitDefault(env.valueFrom?.fieldRef, "apiVersion", "v1");
    }
    for (const volume of pod.volumes ?? []) for (const source of [volume.configMap, volume.secret, volume.projected]) omitDefault(source, "defaultMode", 420);
  }
  return value;
}
function baselineObjects(current, o) {
  const authorized = authorizedObject(current, o);
  const result = [];
  for (const object of current.values()) {
    const expected = o.objectUids.find(v => v.kind === object.kind && v.name === object.metadata.name && v.namespace === o.namespace);
    if (!expected || (object.metadata.uid && object.metadata.uid !== expected.uid)) refuse("missing/mismatched baseline object UID");
    const ignoredPaths = allocatedFields(object);
    if (object === authorized) {
      const index = object.spec.template.spec.containers.indexOf(container(object, o.container));
      ignoredPaths.push(["spec", "template", "spec", "containers", index, "image"]);
    }
    result.push({ ignoredPaths, apiVersion: object.apiVersion, kind: object.kind, name: object.metadata.name, namespace: o.namespace,
      uid: expected.uid, specSha256: sha256(JSON.stringify(canonical(relevantObject(object, o.namespace, ignoredPaths)))) });
  }
  if (result.length !== o.objectUids.length) refuse("baseline object UIDs differ from release inventory");
  return result;
}
async function liveObjects(proofs, o, run) {
  if (!Array.isArray(proofs) || !proofs.length) refuse("live object proof missing");
  for (const expected of proofs) {
    const live = json(await run("live object", "kubectl", [...kubeScope(o), "get", expected.kind, expected.name, "-o", "json"]), "live object");
    if (live.apiVersion !== expected.apiVersion || live.kind !== expected.kind || live.metadata?.name !== expected.name
      || live.metadata.namespace !== expected.namespace || live.metadata.uid !== expected.uid || live.metadata.deletionTimestamp)
      refuse(`live object missing/recreated/deleting: ${expected.kind}/${expected.name}`);
    if (sha256(JSON.stringify(canonical(relevantObject(live, o.namespace, expected.ignoredPaths)))) !== expected.specSha256)
      refuse(`live object differs from stored manifest: ${expected.kind}/${expected.name}`);
  }
}
function templateTokens(text) {
  // Tokenize actions rather than splitting at }}: quoted strings can contain delimiters.
  // Only identifiers outside strings/comments can invoke functions; tpl is itself forbidden.
  const tokens = [];
  let cursor = 0;
  while ((cursor = text.indexOf("{{", cursor)) !== -1) {
    cursor += 2;
    if (text[cursor] === "-" && /\s/.test(text[cursor + 1] ?? "")) cursor++;
    while (/\s/.test(text[cursor] ?? "")) cursor++;
    if (text.startsWith("/*", cursor)) {
      const end = text.indexOf("*/", cursor + 2);
      if (end === -1) refuse("unterminated template comment; use --no-hooks");
      cursor = end + 2;
      while (/\s/.test(text[cursor] ?? "")) cursor++;
      if (text[cursor] === "-") cursor++;
      if (!text.startsWith("}}", cursor)) refuse("ambiguous template comment; use --no-hooks");
      cursor += 2;
      continue;
    }
    let closed = false;
    while (cursor < text.length) {
      if (text.startsWith("}}", cursor)) { cursor += 2; closed = true; break; }
      const char = text[cursor++];
      if (["\"", "'", "`"].includes(char)) {
        let quoted = false;
        while (cursor < text.length) {
          const next = text[cursor++];
          if (next === char) { quoted = true; break; }
          if (next === "\\" && char !== "`") cursor++;
        }
        if (!quoted) refuse("unterminated template string; use --no-hooks");
      } else if (/[A-Za-z_]/.test(char)) {
        const start = cursor - 1;
        while (/[A-Za-z0-9_]/.test(text[cursor] ?? "")) cursor++;
        const token = text.slice(start, cursor);
        // Fields/variables such as .Values.env cannot call Sprig functions. Time also pins .Release.Time.
        if (![".", "$"].includes(text[start - 1]) || token === "Time") tokens.push(token);
      }
    }
    if (!closed) refuse("unterminated template action; use --no-hooks");
  }
  return tokens;
}
function chartHash(path, deterministicHooks = false) {
  const entries = [];
  const visit = (dir, prefix = "") => {
    for (const name of readdirSync(dir).sort()) {
      const file = join(dir, name), rel = `${prefix}${name}`, stat = lstatSync(file);
      if (stat.isSymbolicLink()) refuse("chart symlinks are not supported");
      if (stat.isDirectory()) visit(file, `${rel}/`);
      else if (stat.isFile()) {
        const content = readFileSync(file);
        if (deterministicHooks) {
          if (/\.(?:tgz|gz)$/.test(name)) refuse("hook authorization requires unpacked deterministic chart dependencies");
          // Hooks bypass Helm's post-renderer. Re-render checks alone cannot pin lookup/random/tpl output.
          if (templateTokens(content.toString("utf8")).some(v => /^(?:lookup|rand\w*|uuid\w*|now|ago|date\w*|must_?[dD]ate\w*|htmlDate\w*|toDate|mustToDate|durationRound|gen\w*|encryptAES|bcrypt|htpasswd|shuffle|keys|values|getHostByName|tpl|env|expandenv|Time)$/.test(v)))
            refuse("volatile chart template: hook authorization requires deterministic local rendering; use --no-hooks");
        }
        entries.push([rel, sha256(content)]);
      }
      else refuse("invalid local chart entry");
    }
  };
  try { visit(path); }
  catch (error) { if (error.message?.startsWith("Scoped rollout refused:")) throw error; refuse("readable local chart required for pinned hook rendering"); }
  return sha256(JSON.stringify(entries));
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
  const liveProof = baselineObjects(current, o);
  await liveObjects(liveProof, o, run);
  o.chart = resolve(o.chart);
  const chartSha256 = chartHash(o.chart, !o.noHooks);
  const command = { file: "helm", args: upgradeArgs(o) };
  assertUpgradeCommand(command.args, o);
  // Helm's release JSON contains BOTH manifest and hooks. helm get manifest alone omits hooks.
  const rendered = json(await run("target render", "helm", [...command.args, "--dry-run=server", "--output", "json"]), "target render");
  if (rendered?.name !== o.release || rendered.namespace !== o.namespace || rendered.version !== latest.revision + 1) refuse("rendered release identity/revision mismatch");
  const inventory = await hooks(rendered.hooks, o, run);
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
    liveObjects: liveProof, chart: o.chart, chartSha256,
    hookOptions: Object.fromEntries(["noHooks", "authorizedHooks", "namespace", "kubeconfig", "kubeContext"].map(k => [k, o[k]])),
    hookInventory: inventory, hooksSha256: sha256(JSON.stringify(rendered.hooks)), upgradeArgs: upgradeArgs(o),
    scope: Object.fromEntries(["release", "namespace", "kubeContext", "kubeconfig", "expectedCluster", "expectedUid", "expectedCaSha256"].map(k => [k, o[k]])) };
  command.args.push(...postRendererArgs(renderProof));
  assertUpgradeCommand(command.args, o, renderProof);
  if (chartHash(o.chart, !o.noHooks) !== chartSha256) refuse("chart changed during preparation");
  if (!o.noHooks) {
    const finalRender = json(await run("hook render recheck", "helm", [...upgradeArgs(o), "--dry-run=server", "--output", "json"]), "hook render recheck");
    if (finalRender.manifest !== rendered.manifest || sha256(JSON.stringify(finalRender.hooks) ?? "") !== renderProof.hooksSha256
      || !isDeepStrictEqual(await hooks(finalRender.hooks, o, run), inventory)) refuse("hook render changed before apply");
  }
  await liveObjects(liveProof, o, run);
  const plan = { mode: o.mode, release: o.release, namespace: o.namespace, context: o.kubeContext,
    cluster: { name: o.expectedCluster, uid: o.expectedUid, caSha256: o.expectedCaSha256 },
    changes: [{ kind: "Deployment", name: o.deployment, namespace: o.namespace,
      path: `.spec.template.spec.containers[name=${o.container}].image`, before: previousImage, after: o.image }],
    liveObjects: liveProof, hooks: inventory,
    migrations: inventory.some(h => h.classification === "migration/job" && h.action === "authorized") ? "explicitly authorized hook migrations" : "none authorized", rollbackRevision: o.rollbackRevision,
    renderProof, command, rollback };
  emit(plan);
  if (o.mode === "apply") {
    await run("apply", command.file, command.args);
    try { await liveObjects(liveProof, o, run); }
    catch (error) {
      const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
      refuse(`post-apply verification failed: ${error.message}\nRollback command (not executed): ${[rollback.file, ...rollback.args].map(quote).join(" ")}`);
    }
  }
  return plan;
}

async function checkRender(proof) {
  if (!proof || !/^[a-f0-9]{64}$/.test(proof.manifestSha256 ?? "") || !/^[a-f0-9]{64}$/.test(proof.baselineSha256 ?? "")
    || !Number.isSafeInteger(proof.revision) || proof.revision < 1 || !proof.scope) refuse("invalid post-render proof");
  const raw = readFileSync(0);
  if (sha256(raw) !== proof.manifestSha256) refuse("final Helm render differs from validated target");
  const o = proof.scope;
  const run = async (stage, file, args, input) => {
    try { return await execute(file, args, { input, env: scopedEnvironment(o.kubeconfig) }); }
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
  if (chartHash(proof.chart, !proof.hookOptions.noHooks) !== proof.chartSha256) refuse("chart changed before final render");
  // Helm omits hooks from post-renderer stdin. Re-inventory the pinned local chart before any hook runs.
  if (!proof.hookOptions.noHooks) {
    const rendered = json(await run("post-render hooks", "helm", [...proof.upgradeArgs, "--dry-run=server", "--output", "json"]), "post-render hooks");
    if (sha256(rendered.manifest ?? "") !== proof.manifestSha256
      || sha256(JSON.stringify(rendered.hooks) ?? "") !== proof.hooksSha256
      || !isDeepStrictEqual(await hooks(rendered.hooks, proof.hookOptions, run), proof.hookInventory)) refuse("hooks changed before final render");
  }
  if (chartHash(proof.chart, !proof.hookOptions.noHooks) !== proof.chartSha256) refuse("chart changed during final hook render");
  await liveObjects(proof.liveObjects, o, run);
  process.stdout.write(raw);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === "--check-render" && process.argv.length === 4) await checkRender(json(process.argv[3], "post-render proof"));
    else await scopedRollout(parseArgs(process.argv.slice(2)));
  }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
