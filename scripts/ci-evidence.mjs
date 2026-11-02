import { spawnSync } from "node:child_process";
import { isUtf8 } from "node:buffer";
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const suites = ["product-e2e", "mvp-e2e", "kind-diagnostics", "kong-image-build", "ui-acceptance"];
const tools = ["node", "pnpm", "playwright", "helm", "kind", "kubectl", "kong", "trivy", "docker"];
const count = { type: "integer", minimum: 0, maximum: 1_000_000 };
const id = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const duration = { type: "integer", minimum: 0, maximum: 604_800_000 };
// Numeric release versions only: prerelease/build text would open another free-text channel.
const version = { type: "string", maxLength: 17, pattern: "^(0|[1-9][0-9]{0,4})\\.(0|[1-9][0-9]{0,4})\\.(0|[1-9][0-9]{0,4})$" };

export const evidenceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["suite", "jobId", "runId", "runAttempt", "sha", "status", "runnerArch", "toolVersions"],
  properties: {
    suite: { type: "string", enum: suites, maxLength: 16 },
    // GITHUB_JOB is not the numeric REST job ID. Scope it by run and attempt;
    // runnerArch disambiguates the architecture matrices that emit this evidence.
    jobId: { type: "string", maxLength: 160, pattern: "^[A-Za-z_][A-Za-z0-9_-]{0,99}:[1-9][0-9]{0,15}:[1-9][0-9]{0,15}$" },
    runId: id, runAttempt: id,
    countUnit: { type: "string", enum: ["tests", "commands"], maxLength: 8 },
    sha: { type: "string", pattern: "^[0-9a-fA-F]{40}$", maxLength: 40 },
    status: { type: "string", enum: ["PASS", "FAIL", "BLOCKED"], maxLength: 7 },
    counts: {
      type: "object", additionalProperties: false,
      required: ["total", "passed", "failed", "skipped", "flaky"],
      properties: { total: count, passed: count, failed: count, skipped: count, flaky: count },
    },
    durationMs: duration,
    failureCategory: { type: "string", enum: ["TIMEOUT", "ASSERTION", "INFRA", "SETUP", "UNKNOWN"], maxLength: 9 },
    runnerArch: { type: "string", enum: ["amd64", "arm64"], maxLength: 5 },
    toolVersions: {
      type: "object", additionalProperties: false,
      properties: Object.fromEntries(tools.map(tool => [tool, version])),
    },
  },
};

export function requireValid(condition) {
  // Never attach paths, field values or native/parser errors to a rejection.
  if (!condition) throw new Error("CI evidence rejected.");
}

function matchesSchema(value, schema) {
  if (schema.type === "object") {
    requireValid(value !== null && typeof value === "object" && !Array.isArray(value));
    requireValid(Object.keys(value).every(key => Object.hasOwn(schema.properties, key)));
    requireValid((schema.required ?? []).every(key => Object.hasOwn(value, key)));
    for (const key of Object.keys(value)) matchesSchema(value[key], schema.properties[key]);
  } else if (schema.type === "integer") {
    requireValid(Number.isSafeInteger(value) && value >= schema.minimum && value <= schema.maximum);
  } else if (schema.type === "string") {
    requireValid(typeof value === "string" && value.length <= schema.maxLength);
    requireValid(!/[\p{Cc}\p{Cf}]/u.test(value));
    if (schema.enum) requireValid(schema.enum.includes(value));
    if (schema.pattern) requireValid(new RegExp(schema.pattern, "u").test(value));
  } else {
    requireValid(false);
  }
}

export function validateEvidence(value) {
  matchesSchema(value, evidenceSchema);
  requireValid(Object.keys(value.toolVersions).length > 0);
  const identity = value.jobId.split(":");
  requireValid(identity[1] === String(value.runId) && identity[2] === String(value.runAttempt));
  if (value.status === "BLOCKED") {
    requireValid(value.counts === undefined && value.durationMs === undefined && value.countUnit === undefined);
  } else {
    requireValid(value.counts !== undefined && value.durationMs !== undefined && value.countUnit !== undefined);
    requireValid(value.counts.total > 0);
  }
  if (value.counts) {
    const { total, passed, failed, skipped, flaky } = value.counts;
    requireValid(total === passed + failed + skipped + flaky);
    requireValid(value.status !== "PASS" || failed === 0);
  }
  requireValid(value.status === "PASS" ? value.failureCategory === undefined : value.failureCategory !== undefined);
}

export function directoryPath(directory) {
  const path = resolve(directory);
  // Check parents too: an ordinary file underneath a linked directory is still unsafe to upload.
  requireValid(realpathSync(path) === path && lstatSync(path).isDirectory());
  return path;
}

export function readRegularFile(file, maximum) {
  requireValid(!lstatSync(file).isSymbolicLink());
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    requireValid(stat.isFile() && stat.nlink === 1 && stat.size > 0 && stat.size <= maximum);
    const bytes = readFileSync(fd);
    requireValid(bytes.length <= maximum && isUtf8(bytes));
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function scan(directory, allowedSuites, exact) {
  requireValid(allowedSuites.length > 0 && new Set(allowedSuites).size === allowedSuites.length);
  requireValid(allowedSuites.every(suite => suites.includes(suite)));
  const root = directoryPath(directory);
  const names = readdirSync(root);
  requireValid(names.length <= allowedSuites.length);
  if (exact) requireValid(names.length === allowedSuites.length);
  for (const name of names) {
    requireValid(allowedSuites.some(suite => name === `${suite}.json`));
    const bytes = readRegularFile(join(root, name), 8192);
    // Evidence is compact JSON, with no raw control bytes, including whitespace controls.
    requireValid(!bytes.some(byte => byte < 32 || byte === 127));
    const text = bytes.toString("utf8");
    const value = JSON.parse(text);
    validateEvidence(value);
    // JSON.parse drops duplicate keys. Require the canonical bytes too, or a discarded value could leak.
    requireValid(JSON.stringify(value) === text);
    requireValid(name === `${value.suite}.json`);
  }
  return root;
}

export function validateDirectory(directory, allowedSuites) {
  scan(directory, allowedSuites, true);
}

function numericId(value) {
  requireValid(typeof value === "string" && /^[1-9][0-9]{0,15}$/.test(value));
  const number = Number(value);
  matchesSchema(number, id);
  return number;
}

function reportStats(file) {
  // Missing reports mean setup failed before the reporter started. Invalid reports always fail closed.
  try { lstatSync(file); } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  requireValid(realpathSync(file) === resolve(file));
  const report = JSON.parse(readRegularFile(file, 64 * 1024 * 1024).toString("utf8"));
  const stats = report?.stats;
  requireValid(stats !== null && typeof stats === "object" && !Array.isArray(stats));
  for (const key of ["expected", "unexpected", "skipped", "flaky"]) matchesSchema(stats[key], count);
  requireValid(typeof stats.duration === "number" && Number.isFinite(stats.duration) && stats.duration >= 0);
  const durationMs = Math.round(stats.duration);
  matchesSchema(durationMs, duration);
  const counts = {
    total: stats.expected + stats.unexpected + stats.skipped + stats.flaky,
    passed: stats.expected, failed: stats.unexpected, skipped: stats.skipped, flaky: stats.flaky,
  };
  // No traversal of specs, titles, errors, stdout, attachments, config or environment.
  return { counts, durationMs, countUnit: report.countUnit ?? "tests" };
}

// Read installed executable versions, never arbitrary report/tool output. Failed setup
// may leave only Node available; the artifact still identifies that real tool version.
export function installedToolVersions(suite, execute = spawnSync) {
  const commands = suite === "ui-acceptance" || suite === "product-e2e" ? [
    ["pnpm", "pnpm", ["--version"]],
    ["playwright", "pnpm", ["--filter", suite === "ui-acceptance" ? "@gromesh/ui" : "@gromesh/e2e", "exec", "playwright", "--version"]],
  ] : suite === "kind-diagnostics" ? [["kubectl", "kubectl", ["version", "--client", "-o", "json"]]] : suite === "mvp-e2e" ? [
    ["helm", "helm", ["version", "--template", "{{.Version}}"]],
    ["kind", "kind", ["version"]], ["kubectl", "kubectl", ["version", "--client", "-o", "json"]],
  ] : [["docker", "docker", ["version", "--format", "{{.Client.Version}}"]]];
  const versions = { node: process.versions.node };
  for (const [tool, command, args] of commands) {
    const result = execute(command, args, { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 });
    if (result.status !== 0) continue;
    let output = result.stdout;
    if (tool === "kubectl") {
      try { output = JSON.parse(output).clientVersion.gitVersion; } catch { continue; }
    }
    // A vendor suffix is not uploaded; the observed numeric release is sufficient.
    const match = /(?:^|[ v])((?:0|[1-9][0-9]{0,4})\.(?:0|[1-9][0-9]{0,4})\.(?:0|[1-9][0-9]{0,4}))(?:$|[ +\n-])/.exec(output);
    if (match) versions[tool] = match[1];
  }
  return versions;
}

export function generateEvidence({ suite, directory = "evidence", report, env = process.env }) {
  requireValid(suites.includes(suite));
  const outcome = env.EVIDENCE_OUTCOME;
  requireValid(["success", "failure", "skipped", "cancelled"].includes(outcome));
  const runnerArch = { X64: "amd64", ARM64: "arm64" }[env.RUNNER_ARCH];
  const value = {
    suite, jobId: `${env.GITHUB_JOB}:${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT}`, runId: numericId(env.GITHUB_RUN_ID), runAttempt: numericId(env.GITHUB_RUN_ATTEMPT),
    sha: env.GITHUB_SHA, status: outcome === "success" ? "PASS" : outcome === "failure" ? "FAIL" : "BLOCKED",
    runnerArch, toolVersions: env.EVIDENCE_TOOL_VERSIONS === undefined ? installedToolVersions(suite) : { node: process.versions.node },
  };
  const reports = report === undefined ? [] : Array.isArray(report) ? report : [report];
  requireValid(reports.length <= 16 && new Set(reports).size === reports.length);
  const measured = reports.map(file => reportStats(file));
  if (outcome === "success") requireValid(measured.length > 0 && measured.every(Boolean));
  const results = measured.filter(Boolean);
  const statistics = results.length === 0 ? undefined : results.reduce((sum, item) => {
    requireValid(sum.countUnit === item.countUnit);
    return { countUnit: sum.countUnit, durationMs: sum.durationMs + item.durationMs,
      counts: Object.fromEntries(Object.keys(sum.counts).map(key => [key, sum.counts[key] + item.counts[key]])) };
  });
  // A successful step without measured results must fail closed, never become PASS.
  if (outcome === "success") requireValid(statistics !== undefined);
  if (statistics === undefined || statistics.counts.total === 0) value.status = "BLOCKED";
  else {
    requireValid(!["skipped", "cancelled"].includes(outcome));
    Object.assign(value, statistics);
  }
  if (env.EVIDENCE_TOOL_VERSIONS !== undefined) {
    const versions = JSON.parse(env.EVIDENCE_TOOL_VERSIONS);
    matchesSchema(versions, evidenceSchema.properties.toolVersions);
    Object.assign(value.toolVersions, versions);
  }
  if (value.status !== "PASS") {
    // Aggregate statistics cannot distinguish assertion failures from timeouts or infrastructure failures.
    value.failureCategory = outcome === "cancelled" ? "INFRA" : value.status === "BLOCKED" ? "SETUP" : "UNKNOWN";
  }
  validateEvidence(value);
  const bytes = Buffer.from(JSON.stringify(value));
  requireValid(bytes.length <= 8192);
  const root = resolve(directory);
  try { lstatSync(root); } catch (error) {
    if (error.code !== "ENOENT") throw error;
    directoryPath(dirname(root));
    mkdirSync(root, { mode: 0o700 });
  }
  scan(root, suites, false);
  // Exclusive creation refuses stale outputs and links; validation is a separate mandatory CI gate.
  writeFileSync(join(root, `${suite}.json`), bytes, { flag: "wx", mode: 0o600 });
}

if (import.meta.main) {
  try {
    const [command, ...args] = process.argv.slice(2);
    let directory = "evidence";
    let report;
    const names = [];
    const options = new Set();
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg === "--directory" || arg === "--report") {
        requireValid((arg === "--report" || !options.has(arg)) && index + 1 < args.length);
        options.add(arg);
        if (arg === "--directory") directory = args[++index];
        else { report ??= []; report.push(args[++index]); }
      } else {
        requireValid(!arg.startsWith("--"));
        names.push(arg);
      }
    }
    if (command === "generate") {
      requireValid(names.length === 1);
      generateEvidence({ suite: names[0], directory, report });
    } else {
      requireValid(command === "validate" && report === undefined);
      validateDirectory(directory, names);
    }
  } catch {
    console.error("CI evidence rejected.");
    process.exitCode = 1;
  }
}
