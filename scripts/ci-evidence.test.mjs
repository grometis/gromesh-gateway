import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { linkSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, mkdirSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { test } from "node:test";

const script = fileURLToPath(new URL("./ci-evidence.mjs", import.meta.url));
const secret = "SYNTHETIC_SECRET_do_not_publish_9X7";
const env = {
  ...process.env, GITHUB_RUN_ID: "1234", GITHUB_RUN_ATTEMPT: "2",
  GITHUB_SHA: "a".repeat(40), RUNNER_ARCH: "X64", EVIDENCE_OUTCOME: "success",
  SYNTHETIC_PASSWORD: secret,
};
const minimal = () => ({
  suite: "product-e2e", runId: 1234, runAttempt: 2, sha: "a".repeat(40),
  status: "PASS", runnerArch: "amd64", toolVersions: { node: "26.13.0" },
});
function fixture(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ci-evidence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "evidence");
  mkdirSync(directory);
  return { root, directory, file: join(directory, "product-e2e.json") };
}
function run(args, extraEnv = {}, cwd) {
  const result = spawnSync(process.execPath, [script, ...args], {
    env: { ...env, ...extraEnv }, cwd, encoding: "utf8", timeout: 10_000,
  });
  assert.ifError(result.error);
  // Check every CLI result, including success, without printing its potentially hostile output.
  assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false, "CLI leaked synthetic input");
  assert.equal(result.stdout, "");
  assert.ok(["", "CI evidence rejected.\n"].includes(result.stderr), "CLI output must be constant");
  return result;
}
function validate(directory, suites = ["product-e2e"]) {
  return run(["validate", "--directory", directory, ...suites]);
}
function rejected(result) {
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "CI evidence rejected.\n");
}

test("generates deterministic minimal evidence from the step outcome without inventing counts", t => {
  const { directory, file } = fixture(t);
  assert.equal(run(["generate", "product-e2e", "--directory", directory]).status, 0);
  const bytes = readFileSync(file);
  const evidence = JSON.parse(bytes);
  assert.deepEqual(evidence, { ...minimal(), toolVersions: { node: process.versions.node } });
  assert.equal(bytes.some(byte => byte < 32 || byte === 127), false);
  assert.equal(validate(directory).status, 0);
  rmSync(file);
  assert.equal(run(["generate", "product-e2e", "--directory", directory]).status, 0);
  assert.deepEqual(readFileSync(file), bytes);
});

test("reads only numeric Playwright statistics, dropping all messages and attachments", t => {
  const { root, directory, file } = fixture(t);
  const report = join(root, "playwright.json");
  writeFileSync(report, JSON.stringify({
    stats: { expected: 2, unexpected: 1, skipped: 3, flaky: 1, duration: 12.7, startTime: secret },
    suites: [{ title: secret, specs: [{ title: secret, tests: [{ results: [{
      error: { message: secret, stack: secret }, stdout: [secret],
      attachments: [{ body: Buffer.from(secret).toString("base64") }],
    }] }] }] }], errors: [{ message: secret }], authorization: secret,
  }, null, 2));
  assert.equal(run(["generate", "product-e2e", "--directory", directory, "--report", report], {
    EVIDENCE_OUTCOME: "failure",
  }).status, 0);
  const evidence = JSON.parse(readFileSync(file));
  assert.deepEqual(evidence, {
    ...minimal(), status: "FAIL", toolVersions: { node: process.versions.node },
    counts: { total: 7, passed: 2, failed: 1, skipped: 3, flaky: 1 }, durationMs: 13,
    failureCategory: "UNKNOWN",
  });
  assert.equal(readFileSync(file, "utf8").includes(secret), false);
  assert.equal(readFileSync(file, "utf8").includes(Buffer.from(secret).toString("base64")), false);
  assert.equal(validate(directory).status, 0);
});

for (const [outcome, status, category] of [
  ["failure", "FAIL", "UNKNOWN"], ["skipped", "BLOCKED", "SETUP"], ["cancelled", "BLOCKED", "INFRA"],
]) {
  test(`handles ${outcome} without a result report`, t => {
    const { directory, file } = fixture(t);
    assert.equal(run(["generate", "product-e2e", "--directory", directory, "--report", join(directory, "absent")], {
      EVIDENCE_OUTCOME: outcome, RUNNER_ARCH: "ARM64",
    }).status, 0);
    const evidence = JSON.parse(readFileSync(file));
    assert.equal(evidence.status, status);
    assert.equal(evidence.failureCategory, category);
    assert.equal(evidence.runnerArch, "arm64");
    assert.equal("counts" in evidence, false);
    assert.equal(validate(directory).status, 0);
  });
}

const hostile = {
  "nested JSON": JSON.stringify({ ...minimal(), nested: { headers: { authorization: secret } } }),
  "single quoted text": `{'authorization': '${secret}'}`,
  arrays: JSON.stringify([minimal(), secret]),
  "error messages": JSON.stringify({ ...minimal(), error: { message: secret, stack: secret } }),
  "util.inspect output": inspect({ ...minimal(), headers: { authorization: secret } }),
  "authentication fields": JSON.stringify({ ...minimal(), authorization: secret, cookie: secret, token: secret, key: secret }),
  "base64 data": JSON.stringify({ ...minimal(), body: Buffer.from(secret).toString("base64") }),
  ZIP: Buffer.concat([Buffer.from("504b0304", "hex"), Buffer.from(secret)]),
  binary: Buffer.from([0xff, 0xfe, 0x00, 0x01]),
  "allowed filename with invalid content": secret,
  "extra property": JSON.stringify({ ...minimal(), extra: secret }),
  "duplicate field hiding a secret": JSON.stringify(minimal()).replace('"status":"PASS"', `"status":"${secret}","status":"PASS"`),
  "duplicate nested field hiding a secret": JSON.stringify(minimal()).replace('"node":"26.13.0"', `"node":"${secret}","node":"26.13.0"`),
  "noncanonical numeric encoding": JSON.stringify(minimal()).replace('"runId":1234', '"runId":1234e0'),
  "free string in enum": JSON.stringify({ ...minimal(), status: secret }),
  "unknown suite": JSON.stringify({ ...minimal(), suite: secret }),
  "unknown architecture": JSON.stringify({ ...minimal(), runnerArch: secret }),
  "extra tool": JSON.stringify({ ...minimal(), toolVersions: { node: "26.13.0", authorization: secret } }),
  "non-semver tool version": JSON.stringify({ ...minimal(), toolVersions: { node: secret } }),
  "semver with arbitrary metadata": JSON.stringify({ ...minimal(), toolVersions: { node: `26.13.0+${secret}` } }),
  "numeric string": JSON.stringify({ ...minimal(), runId: "1234" }),
  "unsafe integer": JSON.stringify({ ...minimal(), runId: 1e30 }),
  "invalid sha": JSON.stringify({ ...minimal(), sha: secret }),
  "missing field": JSON.stringify({ suite: "product-e2e" }),
  "invalid counts": JSON.stringify({ ...minimal(), counts: { total: 1, passed: 1, failed: 0, skipped: 0, flaky: -1 } }),
  "extra nested count": JSON.stringify({ ...minimal(), counts: { total: 1, passed: 1, failed: 0, skipped: 0, flaky: 0, message: secret } }),
  "inconsistent counts": JSON.stringify({ ...minimal(), counts: { total: 3, passed: 1, failed: 0, skipped: 0, flaky: 0 } }),
  "oversized count": JSON.stringify({ ...minimal(), counts: { total: 1000001, passed: 1000001, failed: 0, skipped: 0, flaky: 0 } }),
  "fractional duration": JSON.stringify({ ...minimal(), durationMs: 1.5 }),
  "oversized duration": JSON.stringify({ ...minimal(), durationMs: 604800001 }),
  "unknown category": JSON.stringify({ ...minimal(), status: "FAIL", failureCategory: secret }),
  "missing failure category": JSON.stringify({ ...minimal(), status: "FAIL" }),
  "success with failures": JSON.stringify({ ...minimal(), counts: { total: 1, passed: 0, failed: 1, skipped: 0, flaky: 0 } }),
  "raw control byte": JSON.stringify(minimal()) + "\n",
  "escaped control byte": JSON.stringify({ ...minimal(), sha: "\u0000" }),
  "oversized file": " ".repeat(8193) + JSON.stringify(minimal()),
};
for (const [label, bytes] of Object.entries(hostile)) {
  test(`validator refuses ${label} without echoing input`, t => {
    const { directory, file } = fixture(t);
    writeFileSync(file, bytes);
    rejected(validate(directory));
  });
}

for (const extra of ["compose.log", "trace.zip", "report.html", "unknown.json", "product-e2e.JSON", secret]) {
  test(`refuses an extra file (${extra === secret ? "hostile name" : extra})`, t => {
    const { directory, file } = fixture(t);
    writeFileSync(file, JSON.stringify(minimal()));
    writeFileSync(join(directory, extra), secret);
    rejected(validate(directory));
  });
}
test("refuses unexpected canonical evidence, subdirectories, file links and directory links", t => {
  const { root, directory, file } = fixture(t);
  writeFileSync(file, JSON.stringify(minimal()));
  const other = join(directory, "mvp-e2e.json");
  writeFileSync(other, JSON.stringify({ ...minimal(), suite: "mvp-e2e" }));
  rejected(validate(directory));
  assert.equal(validate(directory, ["product-e2e", "mvp-e2e"]).status, 0);
  rmSync(other);
  mkdirSync(join(directory, "nested"));
  rejected(validate(directory));
  rmSync(join(directory, "nested"), { recursive: true });
  const target = join(root, secret);
  writeFileSync(target, JSON.stringify(minimal()));
  rmSync(file);
  symlinkSync(target, file);
  rejected(validate(directory));
  rmSync(file);
  writeFileSync(file, JSON.stringify(minimal()));
  const link = join(root, "link");
  symlinkSync(directory, link);
  for (const suffix of ["", "/", "/."]) rejected(validate(link + suffix));
  symlinkSync(root, join(root, "parent-link"));
  rejected(validate(join(root, "parent-link", "evidence")));
});
test("requires the expected file and matching suite", t => {
  const { directory, file } = fixture(t);
  rejected(validate(directory));
  writeFileSync(file, JSON.stringify({ ...minimal(), suite: "mvp-e2e" }));
  rejected(validate(directory));
});

for (const [label, extraEnv] of [
  ["sha", { GITHUB_SHA: secret }], ["run ID", { GITHUB_RUN_ID: secret }],
  ["attempt", { GITHUB_RUN_ATTEMPT: "1.5" }], ["outcome", { EVIDENCE_OUTCOME: secret }],
  ["architecture", { RUNNER_ARCH: secret }],
]) {
  test(`generator refuses invalid ${label} and produces no artifact`, t => {
    const { directory } = fixture(t);
    rejected(run(["generate", "product-e2e", "--directory", directory], extraEnv));
    assert.deepEqual(readdirSync(directory), []);
  });
}
for (const [label, data] of [
  ["invalid JSON", secret], ["invalid UTF-8", Buffer.from([0xff])],
  ["missing stats", { errors: [{ message: secret }] }],
  ["secret in count", { stats: { expected: secret, unexpected: 0, skipped: 0, flaky: 0, duration: 1 } }],
  ["secret in duration", { stats: { expected: 1, unexpected: 0, skipped: 0, flaky: 0, duration: secret } }],
  ["inconsistent success", { stats: { expected: 0, unexpected: 1, skipped: 0, flaky: 0, duration: 1 } }],
]) {
  test(`generator refuses ${label} in report without echoing content`, t => {
    const { root, directory } = fixture(t);
    const report = join(root, secret + ".json");
    writeFileSync(report, typeof data === "object" && !Buffer.isBuffer(data) ? JSON.stringify(data) : data);
    rejected(run(["generate", "product-e2e", "--directory", directory, "--report", report]));
    assert.deepEqual(readdirSync(directory), []);
  });
}
test("generator refuses dirty directories, existing outputs and symlink reports", t => {
  const { root, directory, file } = fixture(t);
  writeFileSync(join(directory, "compose.log"), secret);
  rejected(run(["generate", "product-e2e", "--directory", directory]));
  assert.equal(readdirSync(directory).length, 1);
  rmSync(join(directory, "compose.log"));
  writeFileSync(file, JSON.stringify(minimal()));
  rejected(run(["generate", "product-e2e", "--directory", directory]));
  rmSync(file);
  writeFileSync(join(root, "target.json"), JSON.stringify({ stats: { expected: 1, unexpected: 0, skipped: 0, flaky: 0, duration: 1 } }));
  symlinkSync(join(root, "target.json"), join(root, "report.json"));
  rejected(run(["generate", "product-e2e", "--directory", directory, "--report", join(root, "report.json")]));
});
test("all canonical suites and controlled optional fields validate", t => {
  const { directory } = fixture(t);
  const suites = ["product-e2e", "mvp-e2e", "kind-diagnostics", "kong-image-build"];
  for (const suite of suites) {
    writeFileSync(join(directory, `${suite}.json`), JSON.stringify({
      ...minimal(), suite, jobId: 123, counts: { total: 1, passed: 1, failed: 0, skipped: 0, flaky: 0 },
      durationMs: 1, toolVersions: { node: "26.13.0", kong: "3.9.4" },
    }));
  }
  assert.equal(validate(directory, suites).status, 0);
});

test("creates the default evidence directory and validates two independently generated kind files", t => {
  const { root, directory } = fixture(t);
  rmSync(directory, { recursive: true });
  assert.equal(run(["generate", "mvp-e2e"], { EVIDENCE_OUTCOME: "failure" }, root).status, 0);
  assert.equal(run(["generate", "kind-diagnostics"], {}, root).status, 0);
  assert.equal(validate(directory, ["mvp-e2e", "kind-diagnostics"]).status, 0);
});
test("refuses hard links and oversized reports before reading their contents", t => {
  const { root, directory, file } = fixture(t);
  const target = join(root, "target.json");
  writeFileSync(target, JSON.stringify(minimal()));
  linkSync(target, file);
  rejected(validate(directory));
  rmSync(file);
  truncateSync(target, 64 * 1024 * 1024 + 1);
  rejected(run(["generate", "product-e2e", "--directory", directory, "--report", target]));
  assert.deepEqual(readdirSync(directory), []);
});
test("refuses invalid CLI commands and generator roots without leaking arguments", t => {
  const { root, directory } = fixture(t);
  for (const args of [
    [secret], ["generate", secret], ["validate", secret],
    ["generate", "product-e2e", "--unknown", secret],
    ["generate", "product-e2e", "--directory"],
    ["generate", "product-e2e", "--directory", directory, "--directory", directory],
    ["validate", "product-e2e", "product-e2e"],
    ["validate", "product-e2e", "--report", secret],
  ]) rejected(run(args));
  symlinkSync(directory, join(root, "link"));
  rejected(run(["generate", "product-e2e", "--directory", join(root, "link")]));
  assert.deepEqual(readdirSync(directory), []);
});
