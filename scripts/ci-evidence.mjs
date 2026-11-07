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

export const RejectionCode = Object.freeze({
  APK_ARCH: "APK_ARCH",
  APK_DISTRO: "APK_DISTRO",
  APK_EPOCH: "APK_EPOCH",
  APK_NAME: "APK_NAME",
  ARRAY_BUDGET: "ARRAY_BUDGET",
  CHECKSUM_ALGORITHM: "CHECKSUM_ALGORITHM",
  CHECKSUM_LENGTH: "CHECKSUM_LENGTH",
  CHECKSUM_UNIQUE: "CHECKSUM_UNIQUE",
  CLI_ARGUMENTS: "CLI_ARGUMENTS",
  CLI_COMMAND: "CLI_COMMAND",
  CLI_OPTIONS: "CLI_OPTIONS",
  COMMENT: "COMMENT",
  COPYRIGHT: "COPYRIGHT",
  CPE22_GRAMMAR: "CPE22_GRAMMAR",
  CPE23_GRAMMAR: "CPE23_GRAMMAR",
  CPE_CATEGORY: "CPE_CATEGORY",
  CPE_GRAMMAR: "CPE_GRAMMAR",
  CPE_PART: "CPE_PART",
  CPE_SENSITIVE: "CPE_SENSITIVE",
  CPE_TYPE: "CPE_TYPE",
  DIGEST_CONTENT: "DIGEST_CONTENT",
  DIGEST_FORMAT: "DIGEST_FORMAT",
  DIRECTORY_BUDGET: "DIRECTORY_BUDGET",
  DIRECTORY_COUNT: "DIRECTORY_COUNT",
  DIRECTORY_PATH: "DIRECTORY_PATH",
  DOCKER_COMMAND: "DOCKER_COMMAND",
  DOCUMENT_DESCRIBES: "DOCUMENT_DESCRIBES",
  DOWNLOAD_HOST: "DOWNLOAD_HOST",
  DOWNLOAD_HOST_ENTROPY: "DOWNLOAD_HOST_ENTROPY",
  DOWNLOAD_HOST_LABEL: "DOWNLOAD_HOST_LABEL",
  DOWNLOAD_HOST_SENSITIVE: "DOWNLOAD_HOST_SENSITIVE",
  DOWNLOAD_PATH: "DOWNLOAD_PATH",
  DOWNLOAD_PATH_SENSITIVE: "DOWNLOAD_PATH_SENSITIVE",
  DOWNLOAD_PORT: "DOWNLOAD_PORT",
  DOWNLOAD_REF_FORMAT: "DOWNLOAD_REF_FORMAT",
  DOWNLOAD_REF_SENSITIVE: "DOWNLOAD_REF_SENSITIVE",
  DOWNLOAD_SHORTHAND: "DOWNLOAD_SHORTHAND",
  DOWNLOAD_URL: "DOWNLOAD_URL",
  EVIDENCE_BLOCKED: "EVIDENCE_BLOCKED",
  EVIDENCE_CONTROL: "EVIDENCE_CONTROL",
  EVIDENCE_COUNTS: "EVIDENCE_COUNTS",
  EVIDENCE_EXECUTION: "EVIDENCE_EXECUTION",
  EVIDENCE_FAILURE: "EVIDENCE_FAILURE",
  EVIDENCE_FILENAME: "EVIDENCE_FILENAME",
  EVIDENCE_JOB_ID: "EVIDENCE_JOB_ID",
  EVIDENCE_MEASURED: "EVIDENCE_MEASURED",
  EVIDENCE_OUTCOME: "EVIDENCE_OUTCOME",
  EVIDENCE_PASS: "EVIDENCE_PASS",
  EVIDENCE_SUITE: "EVIDENCE_SUITE",
  EVIDENCE_SUITES: "EVIDENCE_SUITES",
  EVIDENCE_TOOLS: "EVIDENCE_TOOLS",
  EVIDENCE_TOTAL: "EVIDENCE_TOTAL",
  EXACT_FILE: "EXACT_FILE",
  EXTRACTED_LICENSE_ID: "EXTRACTED_LICENSE_ID",
  EXTRACTED_LICENSE_TEXT: "EXTRACTED_LICENSE_TEXT",
  FILES_ANALYZED: "FILES_ANALYZED",
  FILE_ACCESS: "FILE_ACCESS",
  FILE_BUDGET: "FILE_BUDGET",
  FILE_ENCODING: "FILE_ENCODING",
  FILE_SYMLINK: "FILE_SYMLINK",
  FILE_TYPES: "FILE_TYPES",
  GITHUB_REPOSITORY: "GITHUB_REPOSITORY",
  HOMEPAGE_PACKAGE: "HOMEPAGE_PACKAGE",
  IDENTIFIER_BUDGET: "IDENTIFIER_BUDGET",
  IMAGE_BLOB: "IMAGE_BLOB",
  IMAGE_CONFIG: "IMAGE_CONFIG",
  IMAGE_PATH_HOST: "IMAGE_PATH_HOST",
  IMAGE_PATH_ROOT: "IMAGE_PATH_ROOT",
  IMAGE_PATH_SEGMENTS: "IMAGE_PATH_SEGMENTS",
  IMAGE_PATH_SENSITIVE: "IMAGE_PATH_SENSITIVE",
  IMAGE_PLATFORM: "IMAGE_PLATFORM",
  IMAGE_PLATFORM_MATCH: "IMAGE_PLATFORM_MATCH",
  JOB_IMAGE_ARCH: "JOB_IMAGE_ARCH",
  JOB_MODE: "JOB_MODE",
  JOB_PR_KONG: "JOB_PR_KONG",
  JOB_RUNNER_ARCH: "JOB_RUNNER_ARCH",
  JSON_CANONICAL: "JSON_CANONICAL",
  JSON_SYNTAX: "JSON_SYNTAX",
  LICENSE_EXPRESSION: "LICENSE_EXPRESSION",
  LICENSE_PARENTHESES: "LICENSE_PARENTHESES",
  LICENSE_REFERENCE: "LICENSE_REFERENCE",
  LICENSE_SENSITIVE: "LICENSE_SENSITIVE",
  LICENSE_SENTINEL: "LICENSE_SENTINEL",
  LICENSE_TERM: "LICENSE_TERM",
  LICENSE_TOKENS: "LICENSE_TOKENS",
  LICENSE_TOKEN_BUDGET: "LICENSE_TOKEN_BUDGET",
  LOCAL_IDENTITY_KIND: "LOCAL_IDENTITY_KIND",
  MANIFEST_DIGEST: "MANIFEST_DIGEST",
  MANIFEST_SHAPE: "MANIFEST_SHAPE",
  NPM_NAME: "NPM_NAME",
  NUMERIC_ID: "NUMERIC_ID",
  OBJECT_FIELDS: "OBJECT_FIELDS",
  OBJECT_REQUIRED: "OBJECT_REQUIRED",
  OBJECT_TYPE: "OBJECT_TYPE",
  OCI_CHECKSUM: "OCI_CHECKSUM",
  OCI_ROOT_CHECKSUM: "OCI_ROOT_CHECKSUM",
  OCI_PURL_DIGEST: "OCI_PURL_DIGEST",
  OCI_SOURCE_NAME: "OCI_SOURCE_NAME",
  OCI_SOURCE_TAG: "OCI_SOURCE_TAG",
  OCI_PURL_ARCH: "OCI_PURL_ARCH",
  OCI_LOCATOR: "OCI_LOCATOR",
  OCI_PACKAGE: "OCI_PACKAGE",
  PACKAGE_ATTRIBUTION: "PACKAGE_ATTRIBUTION",
  PACKAGE_PURPOSE: "PACKAGE_PURPOSE",
  PROSE_CREDENTIAL: "PROSE_CREDENTIAL",
  PROSE_ENCODED_CREDENTIAL: "PROSE_ENCODED_CREDENTIAL",
  PROSE_LOCATION: "PROSE_LOCATION",
  PROSE_TERMINOLOGY: "PROSE_TERMINOLOGY",
  PROSE_WORD_BUDGET: "PROSE_WORD_BUDGET",
  PR_ARCH: "PR_ARCH",
  PUBLISHED_ARCH: "PUBLISHED_ARCH",
  PUBLISHED_CONFIG: "PUBLISHED_CONFIG",
  PUBLISHED_CONTEXT: "PUBLISHED_CONTEXT",
  PUBLISHED_IMAGE: "PUBLISHED_IMAGE",
  PUBLISHED_MANIFEST: "PUBLISHED_MANIFEST",
  PURL_CATEGORY: "PURL_CATEGORY",
  PURL_COMPONENT: "PURL_COMPONENT",
  PURL_ENCODING: "PURL_ENCODING",
  PURL_GRAMMAR: "PURL_GRAMMAR",
  PURL_NAME: "PURL_NAME",
  PURL_QUALIFIER: "PURL_QUALIFIER",
  PURL_QUALIFIER_KEY: "PURL_QUALIFIER_KEY",
  PURL_QUALIFIER_VALUE: "PURL_QUALIFIER_VALUE",
  PURL_SUBPATH: "PURL_SUBPATH",
  PURL_VERSION: "PURL_VERSION",
  RELATION_COMMENT: "RELATION_COMMENT",
  RELATION_REFERENCE: "RELATION_REFERENCE",
  RELATION_TYPE: "RELATION_TYPE",
  REPORTS: "REPORTS",
  REPORT_DURATION: "REPORT_DURATION",
  REPORT_PATH: "REPORT_PATH",
  REPORT_REQUIRED: "REPORT_REQUIRED",
  REPORT_STATS: "REPORT_STATS",
  REPORT_UNIT: "REPORT_UNIT",
  ROOT_CONTAINER: "ROOT_CONTAINER",
  ROOT_DESCRIBES: "ROOT_DESCRIBES",
  ROOT_PURL: "ROOT_PURL",
  ROOT_VERSION: "ROOT_VERSION",
  RUNTIME_PACKAGE: "RUNTIME_PACKAGE",
  RUNTIME_VERSION: "RUNTIME_VERSION",
  SAFE_TEXT_ENTROPY: "SAFE_TEXT_ENTROPY",
  SAFE_TEXT_LOCATION: "SAFE_TEXT_LOCATION",
  SAFE_TEXT_SENSITIVE: "SAFE_TEXT_SENSITIVE",
  SAFE_TEXT_WORD_BUDGET: "SAFE_TEXT_WORD_BUDGET",
  SCHEMA_CONTROL: "SCHEMA_CONTROL",
  SCHEMA_ENUM: "SCHEMA_ENUM",
  SCHEMA_INTEGER: "SCHEMA_INTEGER",
  SCHEMA_PATTERN: "SCHEMA_PATTERN",
  SCHEMA_STRING: "SCHEMA_STRING",
  SOURCE_INFO: "SOURCE_INFO",
  SPDX_CREATORS: "SPDX_CREATORS",
  SPDX_HEADER: "SPDX_HEADER",
  SPDX_ID_UNIQUE: "SPDX_ID_UNIQUE",
  SPDX_NAME: "SPDX_NAME",
  SPDX_NAMESPACE: "SPDX_NAMESPACE",
  STRUCTURED_TRAVERSAL: "STRUCTURED_TRAVERSAL",
  STRUCTURED_WORD_BUDGET: "STRUCTURED_WORD_BUDGET",
  SUPPLY_COMMAND: "SUPPLY_COMMAND",
  SYFT_COMMAND: "SYFT_COMMAND",
  TEMPORARY_REQUIRED: "TEMPORARY_REQUIRED",
  TEXT_BUDGET: "TEXT_BUDGET",
  TEXT_CHARACTERS: "TEXT_CHARACTERS",
  TEXT_PATTERN: "TEXT_PATTERN",
  TIMESTAMP: "TIMESTAMP",
  VERIFICATION_CODE: "VERIFICATION_CODE",
  WORKSPACE_REQUIRED: "WORKSPACE_REQUIRED",
});

export class Rejection extends Error {
  constructor(code, artifact) {
    if (!Object.hasOwn(RejectionCode, code)) throw new TypeError("Invalid rejection code");
    super(code);
    Object.defineProperty(this, "code", { value: code, enumerable: true });
    this.artifact = artifact;
  }
}

export function requireValid(condition, code) {
  if (!condition) throw new Rejection(code);
}

export function checkedOperation(code, action) {
  try { return action(); } catch (error) {
    if (error instanceof Rejection) throw error;
    throw new Rejection(code);
  }
}

export function rejectionArtifact(artifact, action) {
  try { return action(); } catch (error) {
    if (error instanceof AggregateError) throw error;
    // Native failures outside a more specific checked operation are file/transport access failures.
    const rejection = error instanceof Rejection ? error : new Rejection(RejectionCode.FILE_ACCESS);
    rejection.artifact ??= artifact;
    throw rejection;
  }
}

export function rejectionLine(error, { artifact = "evidence", image, arch, mode, env = process.env } = {}) {
  const value = { code: error instanceof Rejection ? error.code : RejectionCode.FILE_ACCESS,
    artifact: ["sbom", "digest", "evidence"].includes(error?.artifact) ? error.artifact : artifact };
  if (!["sbom", "digest", "evidence"].includes(value.artifact)) value.artifact = "evidence";
  // Context comes from the job, never from the rejected document. Omit invalid context.
  if (["agent", "control-plane", "ui", "kong"].includes(image ?? env.IMAGE_NAME)) value.image = image ?? env.IMAGE_NAME;
  if (["amd64", "arm64"].includes(arch ?? env.TARGET_ARCH)) value.arch = arch ?? env.TARGET_ARCH;
  if (["images", "pr", "kong-digest"].includes(mode)) value.mode = mode;
  const jobId = `${env.GITHUB_JOB}:${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT}`;
  const publicJobs = ["changes", "checks", "ui-acceptance", "agent", "isolation", "e2e", "mvp-e2e", "image-scan",
    "migration-regression", "ci-ok", "build", "manifest", "build-scan-publish"];
  if (publicJobs.includes(env.GITHUB_JOB) && jobId.length <= 160 && !/[\p{Cc}\p{Cf}]/u.test(jobId) &&
      new RegExp(evidenceSchema.properties.jobId.pattern, "u").test(jobId) &&
      [env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT].every(id => Number.isSafeInteger(Number(id)))) value.jobId = jobId;
  return JSON.stringify(value);
}

function matchesSchema(value, schema) {
  if (schema.type === "object") {
    requireValid(value !== null && typeof value === "object" && !Array.isArray(value), RejectionCode.OBJECT_TYPE);
    requireValid(Object.keys(value).every(key => Object.hasOwn(schema.properties, key)), RejectionCode.OBJECT_FIELDS);
    requireValid((schema.required ?? []).every(key => Object.hasOwn(value, key)), RejectionCode.OBJECT_REQUIRED);
    for (const key of Object.keys(value)) matchesSchema(value[key], schema.properties[key]);
  } else if (schema.type === "integer") {
    requireValid(Number.isSafeInteger(value) && value >= schema.minimum && value <= schema.maximum, RejectionCode.SCHEMA_INTEGER);
  } else if (schema.type === "string") {
    requireValid(typeof value === "string" && value.length <= schema.maxLength, RejectionCode.SCHEMA_STRING);
    requireValid(!/[\p{Cc}\p{Cf}]/u.test(value), RejectionCode.SCHEMA_CONTROL);
    if (schema.enum) requireValid(schema.enum.includes(value), RejectionCode.SCHEMA_ENUM);
    if (schema.pattern) requireValid(new RegExp(schema.pattern, "u").test(value), RejectionCode.SCHEMA_PATTERN);
  } else {
    requireValid(false, RejectionCode.OBJECT_TYPE);
  }
}

export function validateEvidence(value) {
  matchesSchema(value, evidenceSchema);
  requireValid(Object.keys(value.toolVersions).length > 0, RejectionCode.EVIDENCE_TOOLS);
  const identity = value.jobId.split(":");
  requireValid(identity[1] === String(value.runId) && identity[2] === String(value.runAttempt), RejectionCode.EVIDENCE_JOB_ID);
  if (value.status === "BLOCKED") {
    requireValid(value.counts === undefined && value.durationMs === undefined && value.countUnit === undefined, RejectionCode.EVIDENCE_BLOCKED);
  } else {
    requireValid(value.counts !== undefined && value.durationMs !== undefined && value.countUnit !== undefined, RejectionCode.EVIDENCE_MEASURED);
    requireValid(value.counts.total > 0, RejectionCode.EVIDENCE_TOTAL);
  }
  if (value.counts) {
    const { total, passed, failed, skipped, flaky } = value.counts;
    requireValid(total === passed + failed + skipped + flaky, RejectionCode.EVIDENCE_COUNTS);
    requireValid(value.status !== "PASS" || failed === 0, RejectionCode.EVIDENCE_PASS);
  }
  requireValid(value.status === "PASS" ? value.failureCategory === undefined : value.failureCategory !== undefined, RejectionCode.EVIDENCE_FAILURE);
}

export function directoryPath(directory) {
  const path = checkedOperation(RejectionCode.DIRECTORY_PATH, () => resolve(directory));
  // Check parents too: an ordinary file underneath a linked directory is still unsafe to upload.
  checkedOperation(RejectionCode.DIRECTORY_PATH, () => {
    requireValid(realpathSync(path) === path && lstatSync(path).isDirectory(), RejectionCode.DIRECTORY_PATH);
  });
  return path;
}

export function readRegularFile(file, maximum) {
  return checkedOperation(RejectionCode.FILE_ACCESS, () => {
    requireValid(!lstatSync(file).isSymbolicLink(), RejectionCode.FILE_SYMLINK);
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      requireValid(stat.isFile() && stat.nlink === 1 && stat.size > 0 && stat.size <= maximum, RejectionCode.FILE_BUDGET);
      const bytes = readFileSync(fd);
      requireValid(bytes.length <= maximum && isUtf8(bytes), RejectionCode.FILE_ENCODING);
      return bytes;
    } finally {
      closeSync(fd);
    }
  });
}

function scan(directory, allowedSuites, exact) {
  requireValid(allowedSuites.length > 0 && new Set(allowedSuites).size === allowedSuites.length, RejectionCode.EVIDENCE_SUITES);
  requireValid(allowedSuites.every(suite => suites.includes(suite)), RejectionCode.EVIDENCE_SUITE);
  const root = directoryPath(directory);
  const names = checkedOperation(RejectionCode.FILE_ACCESS, () => readdirSync(root));
  requireValid(names.length <= allowedSuites.length, RejectionCode.DIRECTORY_BUDGET);
  if (exact) requireValid(names.length === allowedSuites.length, RejectionCode.DIRECTORY_COUNT);
  const failures = [];
  for (const name of names) {
    try {
      requireValid(allowedSuites.some(suite => name === `${suite}.json`), RejectionCode.EVIDENCE_FILENAME);
      const bytes = readRegularFile(join(root, name), 8192);
      // Evidence is compact JSON, with no raw control bytes, including whitespace controls.
      requireValid(!bytes.some(byte => byte < 32 || byte === 127), RejectionCode.EVIDENCE_CONTROL);
      const text = bytes.toString("utf8");
      const value = checkedOperation(RejectionCode.JSON_SYNTAX, () => JSON.parse(text));
      validateEvidence(value);
      // JSON.parse drops duplicate keys. Require the canonical bytes too, or a discarded value could leak.
      requireValid(JSON.stringify(value) === text, RejectionCode.JSON_CANONICAL);
      requireValid(name === `${value.suite}.json`, RejectionCode.EVIDENCE_FILENAME);
    } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures);
  return root;
}

export function validateDirectory(directory, allowedSuites) {
  scan(directory, allowedSuites, true);
}

function numericId(value) {
  requireValid(typeof value === "string" && /^[1-9][0-9]{0,15}$/.test(value), RejectionCode.NUMERIC_ID);
  const number = Number(value);
  matchesSchema(number, id);
  return number;
}

function reportStats(file) {
  // Missing reports mean setup failed before the reporter started. Invalid reports always fail closed.
  try { lstatSync(file); } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw new Rejection(RejectionCode.FILE_ACCESS);
  }
  checkedOperation(RejectionCode.REPORT_PATH, () => {
    requireValid(realpathSync(file) === resolve(file), RejectionCode.REPORT_PATH);
  });
  const report = checkedOperation(RejectionCode.JSON_SYNTAX, () => JSON.parse(readRegularFile(file, 64 * 1024 * 1024).toString("utf8")));
  const stats = report?.stats;
  requireValid(stats !== null && typeof stats === "object" && !Array.isArray(stats), RejectionCode.REPORT_STATS);
  for (const key of ["expected", "unexpected", "skipped", "flaky"]) matchesSchema(stats[key], count);
  requireValid(typeof stats.duration === "number" && Number.isFinite(stats.duration) && stats.duration >= 0, RejectionCode.REPORT_DURATION);
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
  requireValid(suites.includes(suite), RejectionCode.EVIDENCE_SUITE);
  const outcome = env.EVIDENCE_OUTCOME;
  requireValid(["success", "failure", "skipped", "cancelled"].includes(outcome), RejectionCode.EVIDENCE_OUTCOME);
  const runnerArch = { X64: "amd64", ARM64: "arm64" }[env.RUNNER_ARCH];
  const value = {
    suite, jobId: `${env.GITHUB_JOB}:${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT}`, runId: numericId(env.GITHUB_RUN_ID), runAttempt: numericId(env.GITHUB_RUN_ATTEMPT),
    sha: env.GITHUB_SHA, status: outcome === "success" ? "PASS" : outcome === "failure" ? "FAIL" : "BLOCKED",
    runnerArch, toolVersions: env.EVIDENCE_TOOL_VERSIONS === undefined ? installedToolVersions(suite) : { node: process.versions.node },
  };
  const reports = report === undefined ? [] : Array.isArray(report) ? report : [report];
  requireValid(reports.length <= 16 && new Set(reports).size === reports.length, RejectionCode.REPORTS);
  const measured = reports.map(file => reportStats(file));
  if (outcome === "success") requireValid(measured.length > 0 && measured.every(Boolean), RejectionCode.REPORT_REQUIRED);
  const results = measured.filter(Boolean);
  const statistics = results.length === 0 ? undefined : results.reduce((sum, item) => {
    requireValid(sum.countUnit === item.countUnit, RejectionCode.REPORT_UNIT);
    return { countUnit: sum.countUnit, durationMs: sum.durationMs + item.durationMs,
      counts: Object.fromEntries(Object.keys(sum.counts).map(key => [key, sum.counts[key] + item.counts[key]])) };
  });
  // A successful step without measured results must fail closed, never become PASS.
  if (outcome === "success") requireValid(statistics !== undefined, RejectionCode.REPORT_REQUIRED);
  if (statistics === undefined || statistics.counts.total === 0) value.status = "BLOCKED";
  else {
    requireValid(!["skipped", "cancelled"].includes(outcome), RejectionCode.EVIDENCE_EXECUTION);
    Object.assign(value, statistics);
  }
  if (env.EVIDENCE_TOOL_VERSIONS !== undefined) {
    const versions = checkedOperation(RejectionCode.JSON_SYNTAX, () => JSON.parse(env.EVIDENCE_TOOL_VERSIONS));
    matchesSchema(versions, evidenceSchema.properties.toolVersions);
    Object.assign(value.toolVersions, versions);
  }
  if (value.status !== "PASS") {
    // Aggregate statistics cannot distinguish assertion failures from timeouts or infrastructure failures.
    value.failureCategory = outcome === "cancelled" ? "INFRA" : value.status === "BLOCKED" ? "SETUP" : "UNKNOWN";
  }
  validateEvidence(value);
  const bytes = Buffer.from(JSON.stringify(value));
  requireValid(bytes.length <= 8192, RejectionCode.FILE_BUDGET);
  const root = resolve(directory);
  try { lstatSync(root); } catch (error) {
    if (error.code !== "ENOENT") throw new Rejection(RejectionCode.FILE_ACCESS);
    directoryPath(dirname(root));
    checkedOperation(RejectionCode.FILE_ACCESS, () => mkdirSync(root, { mode: 0o700 }));
  }
  scan(root, suites, false);
  // Exclusive creation refuses stale outputs and links; validation is a separate mandatory CI gate.
  checkedOperation(RejectionCode.FILE_ACCESS, () => writeFileSync(join(root, `${suite}.json`), bytes, { flag: "wx", mode: 0o600 }));
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
        requireValid((arg === "--report" || !options.has(arg)) && index + 1 < args.length, RejectionCode.CLI_OPTIONS);
        options.add(arg);
        if (arg === "--directory") directory = args[++index];
        else { report ??= []; report.push(args[++index]); }
      } else {
        requireValid(!arg.startsWith("--"), RejectionCode.CLI_OPTIONS);
        names.push(arg);
      }
    }
    if (command === "generate") {
      requireValid(names.length === 1, RejectionCode.CLI_ARGUMENTS);
      generateEvidence({ suite: names[0], directory, report });
    } else {
      requireValid(command === "validate" && report === undefined, RejectionCode.CLI_COMMAND);
      validateDirectory(directory, names);
    }
  } catch (error) {
    for (const rejection of error instanceof AggregateError ? error.errors : [error]) console.error(rejectionLine(rejection));
    process.exitCode = 1;
  }
}
