import { installedToolVersions } from "./ci-evidence.mjs";
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
  ...process.env, GITHUB_JOB: "e2e", GITHUB_RUN_ID: "1234", GITHUB_RUN_ATTEMPT: "2",
  GITHUB_SHA: "a".repeat(40), RUNNER_ARCH: "X64", EVIDENCE_OUTCOME: "success",
  SYNTHETIC_PASSWORD: secret, EVIDENCE_TOOL_VERSIONS: "{}",
};
const minimal = (suite = "product-e2e") => ({
  suite, jobId: "e2e:1234:2", runId: 1234, runAttempt: 2, sha: "a".repeat(40),
  status: "PASS", counts: { total: 1, passed: 1, failed: 0, skipped: 0, flaky: 0 }, durationMs: 1, countUnit: "tests", runnerArch: "amd64", toolVersions: { node: "26.13.0" },
});
function fixture(t, suite = "product-e2e") {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ci-evidence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "evidence");
  mkdirSync(directory);
  const report = join(root, 'results.json');
  writeFileSync(report, JSON.stringify({ stats: { expected: 1, unexpected: 0, skipped: 0, flaky: 0, duration: 1 } }));
  return { root, directory, report, file: join(directory, `${suite}.json`) };
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

test("generates deterministic measured evidence", t => {
  const { directory, file, report } = fixture(t);
  assert.equal(run(["generate", "product-e2e", "--directory", directory, "--report", report]).status, 0);
  const bytes = readFileSync(file);
  const evidence = JSON.parse(bytes);
  assert.deepEqual(evidence, { ...minimal(), toolVersions: { node: process.versions.node } });
  assert.equal(bytes.some(byte => byte < 32 || byte === 127), false);
  assert.equal(validate(directory).status, 0);
  rmSync(file);
  assert.equal(run(["generate", "product-e2e", "--directory", directory, "--report", report]).status, 0);
  assert.deepEqual(readFileSync(file), bytes);
});

for (const [outcome, status, failureCategory] of [
  ["success", "PASS", undefined], ["failure", "FAIL", "UNKNOWN"],
  ["skipped", "BLOCKED", "SETUP"], ["cancelled", "BLOCKED", "INFRA"],
]) {
  test(`generates and validates deterministic UI acceptance evidence for ${outcome}`, t => {
    const { root, directory, file, report } = fixture(t, "ui-acceptance");
    if (outcome === "failure") writeFileSync(report, JSON.stringify({ stats: { expected: 0, unexpected: 1, skipped: 0, flaky: 0, duration: 1 } }));
    const executed = ["success", "failure"].includes(outcome);
    const generate = () => run(["generate", "ui-acceptance", ...(executed ? ["--report", report] : [])], { EVIDENCE_OUTCOME: outcome }, root);
    assert.equal(generate().status, 0);
    assert.deepEqual(readdirSync(directory), ["ui-acceptance.json"]);
    const bytes = readFileSync(file);
    const expected = { ...minimal("ui-acceptance"), status, toolVersions: { node: process.versions.node },
      ...(failureCategory === undefined ? {} : { failureCategory }) };
    if (!executed) for (const key of ["counts", "durationMs", "countUnit"]) delete expected[key];
    else if (outcome === "failure") expected.counts = { total: 1, passed: 0, failed: 1, skipped: 0, flaky: 0 };
    assert.deepEqual(JSON.parse(bytes), expected);
    assert.equal(validate(directory, ["ui-acceptance"]).status, 0);
    rejected(validate(directory));
    rmSync(file);
    assert.equal(generate().status, 0);
    assert.deepEqual(readFileSync(file), bytes);
  });
}

test("UI acceptance validation rejects raw attachments and mismatched evidence", t => {
  const { directory, file } = fixture(t, "ui-acceptance");
  rejected(validate(directory, ["ui-acceptance"]));
  writeFileSync(file, JSON.stringify(minimal("ui-acceptance")));
  assert.equal(validate(directory, ["ui-acceptance"]).status, 0);
  for (const name of ["trace.zip", "screenshot.png", "report.html"]) {
    const attachment = join(directory, name);
    writeFileSync(attachment, secret);
    rejected(validate(directory, ["ui-acceptance"]));
    rmSync(file);
    rejected(run(["generate", "ui-acceptance", "--directory", directory]));
    assert.deepEqual(readdirSync(directory), [name]);
    rmSync(attachment);
    writeFileSync(file, JSON.stringify(minimal("ui-acceptance")));
  }
  writeFileSync(file, JSON.stringify(minimal()));
  rejected(validate(directory, ["ui-acceptance"]));
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
  ["failure", "BLOCKED", "SETUP"], ["skipped", "BLOCKED", "SETUP"], ["cancelled", "BLOCKED", "INFRA"],
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
  "missing jobId": JSON.stringify(Object.fromEntries(Object.entries(minimal()).filter(([key]) => key !== "jobId"))),
  "unscoped jobId": JSON.stringify({ ...minimal(), jobId: "e2e" }),
  "wrong job attempt": JSON.stringify({ ...minimal(), jobId: "e2e:1234:3" }),
  "empty tools": JSON.stringify({ ...minimal(), toolVersions: {} }),
  "missing counts": JSON.stringify(Object.fromEntries(Object.entries(minimal()).filter(([key]) => key !== "counts"))),
  "missing duration": JSON.stringify(Object.fromEntries(Object.entries(minimal()).filter(([key]) => key !== "durationMs"))),
  "missing count unit": JSON.stringify(Object.fromEntries(Object.entries(minimal()).filter(([key]) => key !== "countUnit"))),
  "blocked with counts": JSON.stringify({ ...minimal(), status: "BLOCKED", failureCategory: "SETUP" }),
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
  for (const suite of ["product-e2e", "ui-acceptance"]) {
    test(`${suite} validator refuses ${label} without echoing input`, t => {
      const { directory, file } = fixture(t, suite);
      writeFileSync(file, typeof bytes === "string" ? bytes.replaceAll("product-e2e", suite) : bytes);
      rejected(validate(directory, [suite]));
    });
  }
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
  const suites = ["product-e2e", "mvp-e2e", "kind-diagnostics", "kong-image-build", "ui-acceptance"];
  for (const suite of suites) {
    writeFileSync(join(directory, `${suite}.json`), JSON.stringify({
      ...minimal(), suite, counts: { total: 1, passed: 1, failed: 0, skipped: 0, flaky: 0 },
      durationMs: 1, toolVersions: { node: "26.13.0", kong: "3.9.4" },
    }));
  }
  assert.equal(validate(directory, suites).status, 0);
});

test("creates the default evidence directory and validates two independently generated kind files", t => {
  const { root, directory, report } = fixture(t);
  rmSync(directory, { recursive: true });
  writeFileSync(report, JSON.stringify({ stats: { expected: 0, unexpected: 1, skipped: 0, flaky: 0, duration: 1 } }));
  assert.equal(run(["generate", "mvp-e2e", "--report", report], { EVIDENCE_OUTCOME: "failure" }, root).status, 0);
  writeFileSync(report, JSON.stringify({ stats: { expected: 1, unexpected: 0, skipped: 0, flaky: 0, duration: 1 } }));
  assert.equal(run(["generate", "kind-diagnostics", "--report", report], {}, root).status, 0);
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

// A subset of the captured SBOM, retaining original package/file records and closed relationships.
// Only the job identity is rebound for deterministic negative tests on both architectures.
function bindSbomIdentity(doc, sourceName, sha, arch, manifestDigest) {
  const original = doc.name;
  const rebound = JSON.parse(JSON.stringify(doc).replaceAll(original, sourceName));
  rebound.name = sourceName;
  for (const pkg of rebound.packages) {
    if (pkg.name === sourceName) pkg.versionInfo = sha;
    for (const ref of pkg.externalRefs ?? []) {
      if (ref.referenceLocator.startsWith('pkg:oci/')) {
        const checksum = pkg.checksums.find(c => c.algorithm === 'SHA256').checksumValue;
        ref.referenceLocator = `pkg:oci/${sourceName}@sha256:${checksum}?arch=${arch}&tag=${manifestDigest.slice(7)}`;
      } else if (ref.referenceType === 'purl') {
        ref.referenceLocator = ref.referenceLocator.replace(/arch=(?:aarch64|x86_64)/, `arch=${arch === 'amd64' ? 'x86_64' : 'aarch64'}`);
      }
    }
  }
  return rebound;
}
const capturedSubset = JSON.parse(readFileSync(new URL('./fixtures/syft-1.18.1-minimal.fixture.spdx.json', import.meta.url), 'utf8'));
delete capturedSubset.comment; // Fixture provenance is not Syft-emitted SBOM metadata.
const sbomFixture = JSON.stringify(bindSbomIdentity(capturedSubset,
  `gromesh-ui-amd64-${env.GITHUB_SHA}-${'b'.repeat(64)}`, env.GITHUB_SHA, 'amd64', `sha256:${'b'.repeat(64)}`), null, 1);
const supplyScript = fileURLToPath(new URL('./ci-supply-chain.mjs', import.meta.url));
const digest = `sha256:${'b'.repeat(64)}`;
const supplyEnv = {
  ...env, IMAGE_NAME: 'ui', TARGET_ARCH: 'amd64', GITHUB_REPOSITORY_OWNER: 'Gromesh',
  LOCAL_IMAGE_ID: `sha256:${capturedSubset.packages.at(-1).checksums[0].checksumValue}`,
  LOCAL_SBOM_DIGEST: `sha256:${capturedSubset.packages.at(-1).checksums[0].checksumValue}`,
  LOCAL_IDENTITY_KIND: 'classic-config', PUBLISHED_CONFIG_ID: `sha256:${capturedSubset.packages.at(-1).checksums[0].checksumValue}`,
  EXPECTED_DIGEST: digest, PUBLISHED_SHA: env.GITHUB_SHA, PUBLISHED_ARCH: 'amd64',
  PUBLISHED_IMAGE: `ghcr.io/gromesh/gromesh-ui:${env.GITHUB_SHA}-amd64`,
};
function supplyFixture(t) {
  const { root } = fixture(t);
  const sbomDirectory = join(root, 'dist', 'sbom');
  const digestDirectory = join(root, 'temp', 'digests');
  mkdirSync(sbomDirectory, { recursive: true });
  mkdirSync(digestDirectory, { recursive: true });
  const sbomFile = join(sbomDirectory, 'gromesh-ui-amd64.spdx.json');
  const digestFile = join(digestDirectory, 'ui-amd64.txt');
  writeFileSync(sbomFile, sbomFixture);
  writeFileSync(digestFile, `${digest}\n`);
  const runSupply = (command = 'images', extraEnv = {}) => {
    const result = spawnSync(process.execPath, [supplyScript, command], {
      cwd: root, env: { ...supplyEnv, GITHUB_WORKSPACE: root, RUNNER_TEMP: join(root, 'temp'), ...extraEnv },
      encoding: 'utf8', timeout: 10_000,
    });
    assert.ifError(result.error);
    assert.equal(result.stdout, '');
    assert.ok(['', 'CI supply chain rejected.\n'].includes(result.stderr), 'constant rejection only');
    return result;
  };
  return { root, sbomDirectory, digestDirectory, sbomFile, digestFile, runSupply };
}
function rejectSupply(result) {
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'CI supply chain rejected.\n');
}
function changeSbom(f, mutate) {
  const doc = JSON.parse(sbomFixture);
  mutate(doc);
  writeFileSync(f.sbomFile, JSON.stringify(doc));
}

test('supply chain accepts the real-derived Syft fixture and the exact published digest', t => {
  const f = supplyFixture(t);
  assert.equal(f.runSupply().status, 0);
  writeFileSync(f.digestFile, digest);
  assert.equal(f.runSupply().status, 0);
});
for (const [label, value] of [
  ['uppercase', `sha256:${'B'.repeat(64)}`], ['63 hex', `sha256:${'b'.repeat(63)}`],
  ['65 hex', `sha256:${'b'.repeat(65)}`], ['prefix', `sha512:${'b'.repeat(64)}`],
  ['space', `${digest} `], ['extra line', `${digest}\n\n`], ['CRLF', `${digest}\r\n`],
  ['different published image', `sha256:${'c'.repeat(64)}`], ['JSON', JSON.stringify({ digest })],
  ['expected name with secret', secret], ['ZIP', Buffer.from('504b0304', 'hex')],
  ['binary', Buffer.from([0xff, 0xfe, 0])], ['base64', Buffer.from(digest).toString('base64')],
]) {
  test(`supply digest refuses ${label}`, t => {
    const f = supplyFixture(t);
    writeFileSync(f.digestFile, value);
    rejectSupply(f.runSupply());
  });
}
const sbomMutations = [
  ['unknown top field', d => { d.other = 'safe'; }],
  ['nested JSON', d => { d.packages[0].extra = { headers: { authorization: secret } }; }],
  ['arbitrary sensitive top field', d => { d.password = secret; }],
  ['sensitive nested field', d => { d.creationInfo.apiKey = 'short'; }],
  ['sensitive external field', d => { d.packages[0].externalRefs[0].token = 'short'; }],
  ['sensitive named annotation', d => { d.annotations = [{ annotationType: 'OTHER', comment: 'password=short' }]; }],
  ['credential in text', d => { d.comment = secret; }],
  ['credential assignment', d => { d.packages[0].comment = 'token=abc'; }],
  ['synthetic GitHub token', d => { d.packages[0].comment = `ghp_${'a'.repeat(36)}`; }],
  ['high entropy comment', d => { d.comment = '4Xq9Wp2Ma6Jd8Nb3Zt5Rk7Vc1Ys0'; }],
  ['long low entropy comment', d => { d.comment = 'a'.repeat(161); }],
  ['encoded base64 comment', d => { d.comment = Buffer.from(secret).toString('base64'); }],
  ['util.inspect comment', d => { d.comment = inspect({ password: secret }); }],
  ['free text object', d => { d.comment = { value: secret }; }],
  ['malformed SPDX version', d => { d.spdxVersion = 'SPDX-3.0'; }],
  ['license', d => { d.dataLicense = 'MIT'; }],
  ['missing creationInfo', d => { delete d.creationInfo; }],
  ['missing packages', d => { delete d.packages; }],
  ['invalid package version', d => { d.packages[0].versionInfo = secret; }],
  ['homepage outside npm', d => { d.packages[0].homepage = 'https://project.example'; }],
  ['download IP literal', d => { d.packages[0].downloadLocation = 'https://127.0.0.1/library'; }],
  ['namespace image mismatch', d => { d.documentNamespace = d.documentNamespace.replace('gromesh-ui', 'gromesh-agent'); }],
  ['namespace SHA mismatch', d => { d.documentNamespace = d.documentNamespace.replace('a'.repeat(40), 'd'.repeat(40)); }],
  ['namespace digest mismatch', d => { d.documentNamespace = d.documentNamespace.replace('b'.repeat(64), 'd'.repeat(64)); }],
  ['namespace arbitrary URL', d => { d.documentNamespace = 'https://evil.test/sbom'; }],
  ['name mismatch', d => { d.name = 'gromesh-ui'; }],
  ['arbitrary external URL', d => { d.packages[0].externalRefs[0].referenceLocator = 'https://evil.test'; }],
  ['unknown external ref', d => { d.packages[0].externalRefs[0].referenceType = 'website'; }],
  ['purl traversal', d => { d.packages[0].externalRefs[1].referenceLocator = 'pkg:apk/alpine/../musl@1'; }],
  ['purl encoded traversal', d => { d.packages[0].externalRefs[1].referenceLocator = 'pkg:apk/alpine/%2e%2e/musl@1'; }],
  ['purl URL qualifier', d => { d.packages[0].externalRefs[1].referenceLocator = 'pkg:apk/musl@1?repository_url=https%3A%2F%2Fevil.test'; }],
  ['purl wrong architecture', d => { d.packages[0].externalRefs[1].referenceLocator = 'pkg:apk/musl@1?arch=aarch64'; }],
  ['malformed cpe', d => { d.packages[0].externalRefs[0].referenceLocator = 'cpe:2.3:a:musl'; }],
  ['file traversal', d => { d.files[0].fileName = '/app/../etc/passwd'; }],
  ['file host path', d => { d.files[0].fileName = '/home/runner/work/repo/.env'; }],
  ['relative file host path', d => { d.files[0].fileName = '../../.env'; }],
  ['sourceInfo traversal', d => { d.packages[0].sourceInfo = 'acquired package info from APK DB: /lib/../etc'; }],
  ['sourceInfo host path', d => { d.packages[0].sourceInfo = 'acquired package info from APK DB: /Users/fabricio/.env'; }],
  ['unknown relationship', d => { d.relationships[0].relationshipType = secret; }],
  ['dangling relationship', d => { d.relationships[0].relatedSpdxElement = 'SPDXRef-unknown'; }],
  ['duplicate package ID', d => { d.packages.push(d.packages[0]); }],
  ['invalid checksum', d => { d.files[0].checksums[0].checksumValue = secret; }],
  ['invalid date', d => { d.creationInfo.created = '2026-02-31T00:00:00Z'; }],
  ['wrong tool', d => { d.creationInfo.creators = ['Tool: another-tool']; }],
];
for (const [label, mutate] of sbomMutations) {
  test(`SBOM refuses ${label}`, t => {
    const f = supplyFixture(t);
    changeSbom(f, mutate);
    rejectSupply(f.runSupply());
  });
}
// Coordinates intentionally absent from captured inventories prevent snapshot allowlists.
for (const [ecosystem, name, purl, locations] of [
  ['apk', 'future-library', 'pkg:apk/alpine/future-library@9.8.7-r1?arch=x86_64&distro=alpine-3.25',
    ['https://dl-cdn.alpinelinux.org/alpine/v3.25/main/x86_64/future-library-9.8.7-r1.apk']],
  ['npm', '@future/new-library', 'pkg:npm/%40future/new-library@9.8.7',
    ['https://registry.npmjs.org/@future/new-library/-/new-library-9.8.7.tgz']],
  ['golang', 'golang.org/x/future', 'pkg:golang/golang.org/x/future@v9.8.7',
    ['https://proxy.golang.org/golang.org/x/future/@v/v9.8.7.zip', 'https://github.com/future/new-module']],
]) {
  test(`SBOM accepts structural ${ecosystem} registry coordinates absent from fixtures`, t => {
    const f = supplyFixture(t);
    for (const location of locations) {
      changeSbom(f, d => {
        Object.assign(d.packages[0], { name, downloadLocation: location,
          externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: purl }] });
      });
      assert.equal(f.runSupply().status, 0, location);
    }
  });
}
test('SBOM accepts a versionless npm namespace emitted for package submanifests', t => {
  const f = supplyFixture(t);
  changeSbom(f, d => {
    d.packages[0].name = 'new-library/submodule';
    delete d.packages[0].versionInfo;
    d.packages[0].externalRefs = [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl',
      referenceLocator: 'pkg:npm/new-library/submodule' }];
  });
  assert.equal(f.runSupply().status, 0);
});
for (const [label, mutate] of [
  ['synthetic name', d => { d.packages[0].name = secret; }],
  ['synthetic versionInfo', d => { d.packages[0].versionInfo = secret; }],
  ['synthetic comment', d => { d.packages[0].comment = secret; }],
  ['description entropy', d => { d.packages[0].description = '4Xq9Wp2Ma6Jd8Nb3Zt5Rk7Vc1Ys0'; }],
  ['registry userinfo', d => { d.packages[0].downloadLocation = 'https://user:short@registry.npmjs.org/library'; }],
  ['registry query', d => { d.packages[0].downloadLocation = 'https://registry.npmjs.org/library?token=short'; }],
  ['registry fragment', d => { d.packages[0].downloadLocation = 'https://registry.npmjs.org/library#short'; }],
  ['registry encoded traversal', d => { d.packages[0].downloadLocation = 'https://registry.npmjs.org/%2e%2e/library'; }],
  ['registry invalid label', d => { d.packages[0].downloadLocation = 'https://registry.npmjs.-org/library'; }],
  ['unsupported purl ecosystem', d => { d.packages[0].externalRefs[1].referenceLocator = 'pkg:gem/library@1'; }],
  ['npm APK qualifier', d => { d.packages[0].externalRefs[1].referenceLocator = 'pkg:npm/library@1?distro=alpine-3.21'; }],
  ['purl subpath traversal', d => { d.packages[0].externalRefs[1].referenceLocator = 'pkg:golang/github.com/org/repo@v1#../secret'; }],
  ['purl escaped path separator', d => { d.packages[0].externalRefs[1].referenceLocator = 'pkg:npm/%40scope%2fpackage@1'; }],
  ['purl escaped qualifier separator', d => { d.packages[0].externalRefs[1].referenceLocator = 'pkg:apk/alpine/package@1?distro=alpine%26upstream=other'; }],
  ['CPE invalid escape', d => { d.packages[0].externalRefs[0].referenceLocator = 'cpe:2.3:a:vendor:product\\q:1:*:*:*:*:*:*:*'; }],
  ['sourceInfo unknown cataloger', d => { d.packages[0].sourceInfo = 'acquired package info from anything: /app/file'; }],
]) {
  test(`structural SBOM boundary: ${label}`, t => {
    const f = supplyFixture(t);
    changeSbom(f, mutate);
    rejectSupply(f.runSupply());
  });
}
for (const [label, bytes] of [
  ['nested JSON instead of SBOM', JSON.stringify({ document: JSON.parse(sbomFixture) })],
  ['plain text', secret], ['util.inspect', inspect(JSON.parse(sbomFixture))],
  ['ZIP', Buffer.concat([Buffer.from('504b0304', 'hex'), Buffer.from(secret)])],
  ['base64', Buffer.from(sbomFixture).toString('base64')], ['binary', Buffer.from([0xff, 0xfe, 0])],
  ['duplicate hidden secret', sbomFixture.replace('"spdxVersion": "SPDX-2.3"', `"spdxVersion":"${secret}","spdxVersion":"SPDX-2.3"`)],
  ['duplicate nested secret', sbomFixture.replace('"licenseDeclared": "MIT"', `"licenseDeclared":"${secret}","licenseDeclared":"MIT"`)],
  ['escaped hidden text', sbomFixture.replace('musl"', '\\u006dusl"')],
]) {
  test(`SBOM filename does not authorize ${label}`, t => {
    const f = supplyFixture(t);
    writeFileSync(f.sbomFile, bytes);
    rejectSupply(f.runSupply());
  });
}
test('SBOM rejects unrecognized prose comments and oversized files before parsing', t => {
  const f = supplyFixture(t);
  changeSbom(f, d => { d.comment = 'Generated image inventory.'; });
  rejectSupply(f.runSupply());
  truncateSync(f.sbomFile, 16 * 1024 * 1024 + 1);
  rejectSupply(f.runSupply());
});
for (const kind of ['sbom', 'digest']) {
  test(`${kind} refuses missing, extra, linked files and linked directories`, t => {
    const f = supplyFixture(t);
    const file = kind === 'sbom' ? f.sbomFile : f.digestFile;
    const directory = kind === 'sbom' ? f.sbomDirectory : f.digestDirectory;
    const original = readFileSync(file);
    rmSync(file);
    rejectSupply(f.runSupply());
    writeFileSync(file, original);
    const extra = join(directory, 'extra.json');
    writeFileSync(extra, '{}');
    rejectSupply(f.runSupply());
    rmSync(extra);
    const target = join(f.root, 'target');
    writeFileSync(target, original);
    rmSync(file);
    symlinkSync(target, file);
    rejectSupply(f.runSupply());
    rmSync(file);
    linkSync(target, file);
    rejectSupply(f.runSupply());
    rmSync(file);
    rmSync(directory, { recursive: true });
    const other = join(f.root, 'other');
    mkdirSync(other);
    writeFileSync(join(other, file.split('/').at(-1)), original);
    symlinkSync(other, directory);
    rejectSupply(f.runSupply());
  });
}
for (const [label, extraEnv] of [
  ['name traversal', { IMAGE_NAME: '../ui' }], ['architecture traversal', { TARGET_ARCH: '../amd64' }],
  ['wrong runner architecture', { RUNNER_ARCH: 'ARM64' }],
  ['wrong published architecture', { PUBLISHED_ARCH: 'arm64' }],
  ['wrong published SHA', { PUBLISHED_SHA: 'd'.repeat(40) }],
  ['wrong job SHA', { GITHUB_SHA: 'd'.repeat(40) }],
  ['wrong published image', { PUBLISHED_IMAGE: 'ghcr.io/elsewhere/gromesh-ui:latest' }],
  ['invalid expected digest', { EXPECTED_DIGEST: secret }],
  ['missing expected digest', { EXPECTED_DIGEST: '' }],
]) {
  test(`supply chain binds job identity: ${label}`, t => {
    const f = supplyFixture(t);
    rejectSupply(f.runSupply('images', extraEnv));
  });
}
test('kong digest keeps the existing arch.txt wire format on both native architectures', t => {
  for (const [arch, runner] of [['amd64', 'X64'], ['arm64', 'ARM64']]) {
    const f = supplyFixture(t);
    const directory = join(f.root, 'temp', 'kong-digests');
    mkdirSync(directory);
    writeFileSync(join(directory, `${arch}.txt`), digest);
    const extra = { IMAGE_NAME: 'kong', TARGET_ARCH: arch, RUNNER_ARCH: runner, PUBLISHED_ARCH: arch,
      PUBLISHED_IMAGE: `ghcr.io/gromesh/gromesh-kong:3.9.4-${env.GITHUB_SHA}-${arch}` };
    assert.equal(f.runSupply('kong-digest', extra).status, 0);
    writeFileSync(join(directory, `${arch}.txt`), `${digest}\n\n`);
    rejectSupply(f.runSupply('kong-digest', extra));
  }
});

test('images gate fails before either upload for an invalid SBOM OR digest', t => {
  const workflow = readFileSync(new URL('../.github/workflows/images.yml', import.meta.url), 'utf8');
  const steps = workflow.split(/^      - /m);
  const gateIndex = steps.findIndex(s => s.includes('id: validate-supply-chain'));
  const uploads = steps.map((s, i) => ({ s, i })).filter(({ s }) => s.includes('uses: actions/upload-artifact@'));
  assert.ok(gateIndex > 0);
  assert.equal(uploads.length, 2);
  for (const { s, i } of uploads) {
    assert.ok(i > gateIndex);
    assert.match(s, /if: success\(\) && steps\.validate-supply-chain\.outcome == 'success'/);
  }
  assert.match(steps[gateIndex], /run: node scripts\/ci-supply-chain\.mjs images/);
  for (const corrupt of ['sbomFile', 'digestFile']) {
    const f = supplyFixture(t);
    writeFileSync(f[corrupt], secret);
    // The job's single validation step must succeed before any artifact action is eligible.
    const result = f.runSupply();
    const eligible = uploads.filter(() => result.status === 0);
    assert.deepEqual(eligible, []);
  }
});
test('kong uploads each require their branch validation and cannot ignore another validation failure', () => {
  const workflow = readFileSync(new URL('../.github/workflows/kong-image-build.yml', import.meta.url), 'utf8');
  const steps = workflow.split(/^      - /m);
  const uploads = steps.filter(s => s.includes('uses: actions/upload-artifact@'));
  assert.equal(uploads.length, 2);
  assert.match(uploads[0], /steps\.validate-supply-chain\.outcome == 'success'/);
  assert.match(uploads[1], /steps\.validate-evidence\.outcome == 'success'/);
  assert.match(uploads[1], /steps\.validate-supply-chain\.outcome != 'failure'/);
});

test('all application name/architecture pairs bind to the explicit Syft source name', t => {
  for (const name of ['control-plane', 'ui', 'agent']) {
    for (const [arch, runner] of [['amd64', 'X64'], ['arm64', 'ARM64']]) {
      const f = supplyFixture(t);
      const sourceName = `gromesh-${name}-${arch}-${env.GITHUB_SHA}-${digest.slice(7)}`;
      const d = bindSbomIdentity(JSON.parse(sbomFixture), sourceName, env.GITHUB_SHA, arch, digest);
      rmSync(f.sbomFile);
      writeFileSync(join(f.sbomDirectory, `gromesh-${name}-${arch}.spdx.json`), JSON.stringify(d));
      rmSync(f.digestFile);
      writeFileSync(join(f.digestDirectory, `${name}-${arch}.txt`), digest);
      assert.equal(f.runSupply('images', { IMAGE_NAME: name, TARGET_ARCH: arch, RUNNER_ARCH: runner,
        PUBLISHED_ARCH: arch, PUBLISHED_IMAGE: `ghcr.io/gromesh/gromesh-${name}:${env.GITHUB_SHA}-${arch}` }).status, 0);
    }
  }
});

test('SBOM accepts bounded Syft annotations, npm scopes, cpe22 and image-root agent binaries', t => {
  const f = supplyFixture(t);
  changeSbom(f, d => {
    d.packages[0].externalRefs.push({ referenceCategory: 'SECURITY', referenceType: 'cpe22Type',
      referenceLocator: 'cpe:/a:musl-libc:musl:1.2.5-r9' });
    d.packages[0].externalRefs.push({ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl',
      referenceLocator: 'pkg:npm/%40nestjs/core@11.1.0' });
    d.files[0].fileName = '/gromesh/isolation-bin/kong-supervisor';
  });
  assert.equal(f.runSupply().status, 0);
  changeSbom(f, d => { d.files[0].fileName = '/gromesh-agent'; });
  assert.equal(f.runSupply().status, 0);
});

for (const [label, mutate] of [
  ['short sensitive annotation name', d => { d.annotations = [{ password: 'x' }]; }],
  ['high entropy annotation', d => { d.annotations = [{ annotationDate: d.creationInfo.created, annotationType: 'OTHER',
    annotator: 'Tool: syft-1.18.1', comment: '4Xq9Wp2Ma6Jd8Nb3Zt5Rk7Vc1Ys0' }]; }],
  ['line break in text', d => { d.comment = 'hello\nworld'; }],
  ['Unicode text', d => { d.comment = 'hello\u202eworld'; }],
  ['purl spaces', d => { d.packages[0].externalRefs[1].referenceLocator = 'pkg:apk/musl @1'; }],
  ['purl duplicate qualifiers', d => { d.packages[0].externalRefs[1].referenceLocator = 'pkg:apk/musl@1?arch=amd64&arch=amd64'; }],
  ['purl invalid encoding', d => { d.packages[0].externalRefs[1].referenceLocator = 'pkg:apk/%QQ@1'; }],
  ['file sensitive name', d => { d.files[0].fileName = '/app/.env'; }],
  ['oversized package array', d => { d.packages = Array(20_001).fill(d.packages[0]); }],
  ['oversized files array', d => { d.files = Array(50_001).fill(d.files[0]); }],
  ['oversized relationships array', d => { d.relationships = Array(100_001).fill(d.relationships[0]); }],
  ['missing DESCRIBES', d => { d.relationships = d.relationships.slice(1); }],
  ['sensitive low value field', d => { d.packages[0].clientSecret = 'x'; }],
]) {
  test(`SBOM additional boundary: ${label}`, t => {
    const f = supplyFixture(t);
    changeSbom(f, mutate);
    rejectSupply(f.runSupply());
  });
}

test('real shell gate invokes no upload on either validation failure, and both on success', t => {
  for (const corrupt of [undefined, 'sbomFile', 'digestFile']) {
    const f = supplyFixture(t);
    if (corrupt) writeFileSync(f[corrupt], secret);
    const marker = join(f.root, 'uploads');
    const result = spawnSync('bash', ['-e', '-c',
      '"$NODE_BINARY" "$SUPPLY_SCRIPT" images\nprintf "sbom\\ndigest\\n" > "$UPLOAD_MARKER"'], {
      cwd: f.root, env: { ...supplyEnv, GITHUB_WORKSPACE: f.root, RUNNER_TEMP: join(f.root, 'temp'),
        NODE_BINARY: process.execPath, SUPPLY_SCRIPT: supplyScript, UPLOAD_MARKER: marker },
      encoding: 'utf8', timeout: 10_000,
    });
    assert.ifError(result.error);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, corrupt ? 'CI supply chain rejected.\n' : '');
    assert.equal(result.status, corrupt ? 1 : 0);
    if (corrupt) assert.equal(readdirSync(f.root).includes('uploads'), false);
    else assert.equal(readFileSync(marker, 'utf8'), 'sbom\ndigest\n');
  }
});

test('SBOM rejects a duplicate root even with matching source name and SHA', t => {
  const f = supplyFixture(t);
  changeSbom(f, d => {
    d.packages.push({ SPDXID: 'SPDXRef-Container', name: d.name, versionInfo: env.GITHUB_SHA,
      downloadLocation: 'NOASSERTION', filesAnalyzed: false, primaryPackagePurpose: 'CONTAINER' });
    d.relationships.push({ spdxElementId: d.SPDXID, relatedSpdxElement: 'SPDXRef-Container', relationshipType: 'DESCRIBES' });
  });
  rejectSupply(f.runSupply());
});
test('SPDX file checksum and explicit filesAnalyzed are required by the upload profile', t => {
  for (const mutate of [d => { delete d.files[0].checksums; }, d => { delete d.packages[0].filesAnalyzed; }]) {
    const f = supplyFixture(t);
    changeSbom(f, mutate);
    rejectSupply(f.runSupply());
  }
});
test('supply chain rejects missing job roots and all unrecognized CLI switches', t => {
  const f = supplyFixture(t);
  rejectSupply(f.runSupply('images', { GITHUB_WORKSPACE: '' }));
  rejectSupply(f.runSupply('images', { RUNNER_TEMP: '' }));
  rejectSupply(f.runSupply('anything'));
});

test('synthetic credential patterns are rejected even in structured SPDX IDs', t => {
  const f = supplyFixture(t);
  changeSbom(f, d => {
    const original = d.packages[0].SPDXID;
    const hostileId = 'SPDXRef-AKIA0123456789ABCDEF';
    d.packages[0].SPDXID = hostileId;
    for (const r of d.relationships) {
      if (r.spdxElementId === original) r.spdxElementId = hostileId;
      if (r.relatedSpdxElement === original) r.relatedSpdxElement = hostileId;
    }
  });
  rejectSupply(f.runSupply());
});

test('structured package names and pnpm paths do not use free-comment limits', t => {
  const f = supplyFixture(t);
  for (const [name, purl] of [
    ['github.com/gromesh/gromeshgateway/apps/agent', 'pkg:golang/github.com/gromesh/gromeshgateway/apps/agent@v1.0.0'],
    ['@opentelemetry/instrumentation-http', 'pkg:npm/%40opentelemetry/instrumentation-http@0.70.0'],
  ]) {
    changeSbom(f, d => {
      d.packages[0].name = name;
      d.packages[0].externalRefs = [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: purl }];
      d.files[0].fileName = '/app/node_modules/.pnpm/@opentelemetry+instrumentation-http@0.70.0/package.json';
    });
    assert.equal(f.runSupply().status, 0);
  }
});

test('CPE profile rejects embedded wildcards and invalid language tags', t => {
  for (const locator of [
    'cpe:2.3:a:musl*:musl:1.2.5-r9:*:*:*:*:*:*:*',
    'cpe:2.3:a:musl-libc:musl:1.2.5-r9:*:*:arbitrary-language:*:*:*:*',
  ]) {
    const f = supplyFixture(t);
    changeSbom(f, d => { d.packages[0].externalRefs[0].referenceLocator = locator; });
    rejectSupply(f.runSupply());
  }
});

// All six unmodified Syft inventories total 2,639,586 bytes (2.52 MiB).
// The small excess over ~2.5 MB buys complete cross-architecture npm/Go/APK regressions.
function fixtureInspection(doc) {
  const id = `sha256:${doc.packages.find(pkg => pkg.primaryPackagePurpose === 'CONTAINER').checksums[0].checksumValue}`;
  return { LOCAL_IMAGE_ID: id, LOCAL_SBOM_DIGEST: id, LOCAL_IDENTITY_KIND: 'classic-config', PUBLISHED_CONFIG_ID: id };
}
const realFixtureDirectory = new URL('./fixtures/sbom/b43bee3/', import.meta.url);
function realContext(name, arch) {
  const context = Object.fromEntries(readFileSync(new URL(`gromesh-${name}-${arch}.context.env`, realFixtureDirectory), 'utf8')
    .trim().split(/\s+/).map(pair => {
      const separator = pair.indexOf('=');
      assert.ok(separator > 0);
      return [pair.slice(0, separator), pair.slice(separator + 1)];
    }));
  return { ...context, ...fixtureInspection(JSON.parse(readFileSync(new URL(`gromesh-${name}-${arch}.spdx.json`, realFixtureDirectory)))) };
}
for (const name of ['control-plane', 'ui', 'agent']) {
  for (const arch of ['amd64', 'arm64']) {
    test(`unmodified Syft inventory ${name} ${arch} passes CLI with simulated config inspection`, t => {
      const f = supplyFixture(t);
      rmSync(f.sbomFile);
      rmSync(f.digestFile);
      const context = realContext(name, arch);
      writeFileSync(join(f.sbomDirectory, `gromesh-${name}-${arch}.spdx.json`),
        readFileSync(new URL(`gromesh-${name}-${arch}.spdx.json`, realFixtureDirectory)));
      writeFileSync(join(f.digestDirectory, `${name}-${arch}.txt`), `${context.EXPECTED_DIGEST}\n`);
      assert.equal(f.runSupply('images', context).status, 0);
    });
  }
}
const realSbom = readFileSync(new URL('gromesh-ui-arm64.spdx.json', realFixtureDirectory));
const realSha = 'b43bee3d26f9ef0add1260fc5e317c01fb5f066f';
const realDigest = 'sha256:f753a886d77b52bb56cdff2ab23cb09d64aa2e710af0a8c0a8d642d5c8c0d4bd';
function realSupplyFixture(t) {
  const f = supplyFixture(t);
  rmSync(f.sbomFile);
  rmSync(f.digestFile);
  f.sbomFile = join(f.sbomDirectory, 'gromesh-ui-arm64.spdx.json');
  f.digestFile = join(f.digestDirectory, 'ui-arm64.txt');
  writeFileSync(f.sbomFile, realSbom);
  writeFileSync(f.digestFile, `${realDigest}\n`);
  const run = f.runSupply;
  f.runSupply = () => run('images', { ...fixtureInspection(JSON.parse(realSbom)), TARGET_ARCH: 'arm64', RUNNER_ARCH: 'ARM64', GITHUB_SHA: realSha,
    PUBLISHED_SHA: realSha, PUBLISHED_ARCH: 'arm64', EXPECTED_DIGEST: realDigest,
    GITHUB_REPOSITORY_OWNER: 'grometis', PUBLISHED_IMAGE: `ghcr.io/grometis/gromesh-ui:${realSha}-arm64` });
  return f;
}
test('unmodified UI arm64 inventory passes gate with simulated independent inspection', t => {
  const f = realSupplyFixture(t);
  assert.equal(f.runSupply().status, 0);
});

function replaceSbomId(doc, element, id) {
  const original = element.SPDXID;
  element.SPDXID = id;
  for (const relation of doc.relationships) {
    if (relation.spdxElementId === original) relation.spdxElementId = id;
    if (relation.relatedSpdxElement === original) relation.relatedSpdxElement = id;
  }
}

for (const [label, mutate] of [
  ['description credential', d => { d.packages[0].description = secret; }],
  ['description sensitive assignment', d => { d.packages[0].description = 'password=short'; }],
  ['supplier credential', d => { d.packages[0].supplier = `Person: ${secret}`; }],
  ['originator credential', d => { d.packages[0].originator = 'Person: token=short'; }],
  ['description URL', d => { d.packages[0].description = 'https://evil.test'; }],
  ['description oversized', d => { d.packages[0].description = 'a'.repeat(161); }],
  ['supplier object', d => { d.packages[0].supplier = { password: 'short' }; }],
  ['verification unknown field', d => { d.packages[0].packageVerificationCode.password = 'short'; }],
  ['verification missing', d => { delete d.packages[0].packageVerificationCode; }],
  ['verification credential', d => { d.packages[0].packageVerificationCode.packageVerificationCodeValue = secret; }],
  ['verification wrong length', d => { d.packages[0].packageVerificationCode.packageVerificationCodeValue = 'a'.repeat(41); }],
  ['verification for unanalyzed package', d => { d.packages[0].filesAnalyzed = false; }],
  ['filesAnalyzed nonboolean', d => { d.packages[0].filesAnalyzed = 'true'; }],
  ['upstream credential path', d => { d.packages[0].downloadLocation = 'https://musl.libc.org/password/short'; }],
  ['upstream query', d => { d.packages[0].downloadLocation = 'https://musl.libc.org/?token=short'; }],
  ['upstream userinfo', d => { d.packages[0].downloadLocation = 'https://user:short@musl.libc.org/'; }],
  ['upstream fragment', d => { d.packages[0].downloadLocation = 'https://musl.libc.org/#short'; }],
  ['upstream traversal', d => { d.packages[0].downloadLocation = 'https://musl.libc.org/../'; }],
  ['extracted unknown field', d => { d.hasExtractedLicensingInfos[0].password = 'short'; }],
  ['extracted arbitrary text', d => { d.hasExtractedLicensingInfos[0].extractedText = 'safe but unrelated'; }],
  ['extracted credential', d => { d.hasExtractedLicensingInfos[0].extractedText = secret; }],
  ['extracted sensitive identifier', d => { d.hasExtractedLicensingInfos.push({ licenseId: 'LicenseRef-password', extractedText: 'password' }); }],
  ['extracted duplicate ID', d => { d.hasExtractedLicensingInfos.push(d.hasExtractedLicensingInfos[0]); }],
  ['extracted oversized array', d => { d.hasExtractedLicensingInfos = Array(257).fill(d.hasExtractedLicensingInfos[0]); }],
  ['license unbalanced', d => { d.packages[0].licenseDeclared = '(MIT AND GPL-2.0-only'; }],
  ['license invalid operator', d => { d.packages[0].licenseDeclared = 'MIT XOR GPL-2.0-only'; }],
  ['license missing operand', d => { d.packages[0].licenseDeclared = 'MIT AND'; }],
  ['license ignored punctuation', d => { d.packages[0].licenseDeclared = 'MIT++++'; }],
  ['license invalid WITH grouping', d => { d.packages[0].licenseDeclared = 'MIT WITH (MIT OR BSD-2-Clause)'; }],
  ['license sentinel in expression', d => { d.packages[0].licenseDeclared = 'NOASSERTION AND MIT'; }],
  ['license undefined reference', d => { d.packages[0].licenseDeclared = 'LicenseRef-missing'; }],
  ['license credential', d => { d.packages[0].licenseDeclared = secret; }],
  ['file license credential', d => { d.files[0].licenseInfoInFiles = [secret]; }],
  ['file license type', d => { d.files[0].licenseInfoInFiles = 'MIT'; }],
  ['file license oversized array', d => { d.files[0].licenseInfoInFiles = Array(65).fill('MIT'); }],
  ['file layer credential', d => { d.files[0].comment = `layerID: sha256:${secret}`; }],
  ['file layer arbitrary hash', d => { d.files[0].comment = `layerID: sha256:${'a'.repeat(63)}`; }],
  ['file layer appended text', d => { d.files[0].comment += ' extra'; }],
  ['file layer unknown field', d => { d.files[0].layerID = 'short'; }],
  ['file Unicode bidi', d => { d.files[0].fileName = 'usr/share/hello\u202eworld'; }],
  ['file Unicode control', d => { d.files[0].fileName = 'usr/share/hello\u0000world'; }],
  ['sourceInfo shadow', d => { d.packages[0].sourceInfo = 'acquired package info from APK DB: /etc/shadow'; }],
  ['file nonstandard shadow path', d => { d.files[0].fileName = '/app/shadow'; }],
  ['file shadow content field', d => { d.files.find(f => f.fileName === 'etc/shadow').content = 'short'; }],
  ['file symlink field', d => { d.files[0].symlink = '/etc/shadow'; }],
  ['file credential in ID', d => { replaceSbomId(d, d.files[0], `SPDXRef-File-sk-${'a'.repeat(16)}`); }],
  ['file credential in filename and matching ID', d => {
    d.files[0].fileName = `usr/share/sk-${'a'.repeat(16)}`;
    replaceSbomId(d, d.files[0], `SPDXRef-File-${d.files[0].fileName.replaceAll('/', '-')}-${'b'.repeat(16)}`);
  }],
  ['package credential in ID', d => { replaceSbomId(d, d.packages[0], `SPDXRef-sk-${'a'.repeat(16)}`); }],
  ['CPE sensitive value', d => { d.packages[0].externalRefs[0].referenceLocator = 'cpe:2.3:a:password:musl:1:*:*:*:*:*:*:*'; }],
  ['relationship arbitrary comment', d => { d.relationships.find(r => r.comment).comment = 'safe but unrelated'; }],
  ['relationship sensitive field', d => { d.relationships[0].password = 'short'; }],
  ['OCI wrong tag', d => { d.packages.at(-1).externalRefs[0].referenceLocator = d.packages.at(-1).externalRefs[0].referenceLocator.replace(`tag=${digest.slice(7)}`, `tag=${'c'.repeat(64)}`); }],
  ['OCI wrong local config digest', d => { d.packages.at(-1).externalRefs[0].referenceLocator = d.packages.at(-1).externalRefs[0].referenceLocator.replace(/@sha256:[a-f0-9]{64}/, `@sha256:${'c'.repeat(64)}`); }],
  ['OCI wrong arch', d => { d.packages.at(-1).externalRefs[0].referenceLocator = d.packages.at(-1).externalRefs[0].referenceLocator.replace('arch=amd64', 'arch=arm64'); }],
  ['OCI unknown qualifier', d => { d.packages.at(-1).externalRefs[0].referenceLocator += '&token=short'; }],
  ['OCI external URL', d => { d.packages.at(-1).externalRefs[0].referenceLocator += '&repository_url=https%3A%2F%2Fevil.test'; }],
  ['OCI wrong source name', d => { d.packages.at(-1).externalRefs[0].referenceLocator = d.packages.at(-1).externalRefs[0].referenceLocator.replace('pkg:oci/gromesh-ui', 'pkg:oci/elsewhere'); }],
  ['OCI checksum missing', d => { delete d.packages.at(-1).checksums; }],
  ['container wrong job SHA', d => { d.packages.at(-1).versionInfo = 'd'.repeat(40); }],
]) {
  test(`real-derived Syft boundary: ${label}`, t => {
    const f = supplyFixture(t);
    changeSbom(f, mutate);
    rejectSupply(f.runSupply());
  });
}

// New coordinates and refs catch regressions to exact captured-location allowlists.
for (const location of [
  'NOASSERTION', 'NONE',
  'https://github.com/future/new-repo', 'http://github.com/future/new-repo.git',
  'git://github.com/future/new-repo.git#abcdef1234567',
  'git+https://github.com/future/new-repo.git#v9.8.7',
  'git+https://github.com/future/new-repo.git#v9.8.7-rc.1+build.2',
  'git+ssh://github.com/future/new-repo.git#release-9.8.7',
  'github:future/new-repo#v9.8.7', 'future/new-repo#abcdef1234567',
  'https://github.com:443/future/new-repo', 'http://github.com:80/future/new-repo',
  'git://github.com:9418/future/new-repo', 'git+https://github.com:443/future/new-repo',
  'git+ssh://github.com:22/future/new-repo',
  'https://gitlab.com/future/group/new-repo/-/tree/v9.8.7',
  'https://bitbucket.org/future/new-repo',
  'https://go.googlesource.com/future', 'https://pkg.go.dev/golang.org/x/future',
  'https://golang.org/x/future', 'https://musl.libc.org/releases/musl-9.8.7.tar.gz',
  'https://www.gnu.org/software/libidn#libidn2',
]) {
  test(`downloadLocation accepts restricted grammar: ${location}`, t => {
    const f = supplyFixture(t);
    changeSbom(f, d => { d.packages[0].downloadLocation = location; });
    assert.equal(f.runSupply().status, 0);
  });
}
for (const location of [
  secret, `https://github.com/future/${secret}`, `github:future/repo#${secret}`,
  'git+https://user:short@github.com/future/repo',
  'git+ssh://git@github.com/future/repo', 'https://github.com@evil.example/repo',
  'github:future/../repo', 'github:../repo', 'future/../repo',
  'github:future/%2e%2e', 'github:-future/repo', 'github:future-/repo',
  'github:future/repo/extra', 'github:future/.', 'github:future/..',
  'https://127.0.0.1/future/repo', 'https://[::1]/future/repo',
  'https://github.com./future/repo', 'https://GITHUB.com/future/repo',
  'https://github.com:444/future/repo', 'git+https://github.com:22/future/repo',
  'https://github.com:0443/future/repo', 'http://github.com:443/future/repo',
  'https://github.com/future/repo?token=short', 'https://github.com/future/repo?',
  'https://github.com/future/repo#', 'https://github.com/future/repo#token-short',
  'https://github.com/future/repo#password-1', 'https://github.com/future/repo#short',
  'https://github.com/future/repo#4Xq9Wp2Ma6Jd8Nb3Zt5Rk7Vc1Ys0',
  'github:future/repo#token-1', 'github:future/repo#../v1.2.3',
  'https://github.com/future/../repo', 'https://github.com/future/%2e%2e/repo',
  'https://github.com/future/repo%3ftoken=short', 'https://github.com/future/repo\\extra',
  'https://github.com/future//repo', 'https://github.com/future/./repo', 'https://github.com/future/token/short',
  'https://host with-space.example/docs/future',
  'ssh://github.com/future/repo', 'file:///app/repo',
]) {
  test(`downloadLocation rejects unsafe grammar: ${location === secret ? 'synthetic credential' : location}`, t => {
    const f = supplyFixture(t);
    changeSbom(f, d => { d.packages[0].downloadLocation = location; });
    rejectSupply(f.runSupply());
  });
}
for (const version of ['26.13.0', '99.2.3', '26.13.0-rc.1+build.2']) {
  test(`purl accepts embedded node runtime semver ${version}`, t => {
    const f = supplyFixture(t);
    changeSbom(f, d => {
      Object.assign(d.packages[0], { name: 'node', versionInfo: version,
        externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: `pkg:generic/node@${version}` }] });
    });
    assert.equal(f.runSupply().status, 0);
  });
}
for (const locator of [
  'pkg:generic/arbitrary@26.13.0', 'pkg:generic/namespace/node@26.13.0',
  'pkg:generic/node', 'pkg:generic/node@latest', 'pkg:generic/node@26.13',
  'pkg:generic/node@026.13.0', 'pkg:generic/node@26.13.0-01',
  'pkg:generic/node@26.13.0?arch=amd64', 'pkg:generic/node@26.13.0#src',
  `pkg:generic/node@${secret}`, 'pkg:npm/lib@1?arch=amd64',
  'pkg:golang/example.com/lib@v1?goos=linux',
  'pkg:apk/alpine/lib@1?arch=x86_64&arch=x86_64',
  'pkg:apk/alpine/lib@1?distro=arbitrary',
]) {
  test(`purl rejects unsafe runtime or qualifier: ${locator}`, t => {
    const f = supplyFixture(t);
    changeSbom(f, d => {
      if (locator.startsWith('pkg:generic/')) {
        d.packages[0].name = 'node';
        d.packages[0].versionInfo = locator.split('@')[1]?.split(/[?#]/)[0] ?? '26.13.0';
      }
      d.packages[0].externalRefs[1].referenceLocator = locator;
    });
    rejectSupply(f.runSupply());
  });
}

for (const homepage of ['https://github.com/future/new-library#readme', 'https://clickhouse.com/docs/future', 'https://new-project.example/docs']) {
  test(`npm homepage accepts bounded Syft project metadata: ${homepage}`, t => {
    const f = supplyFixture(t);
    changeSbom(f, d => {
      d.packages[0].externalRefs = [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: 'pkg:npm/future@1.2.3' }];
      d.packages[0].homepage = homepage;
    });
    assert.equal(f.runSupply().status, 0);
  });
}
for (const homepage of ['https://127.0.0.1/repo', 'https://user:short@github.com/future/repo',
  'https://github.com/future/repo?token=short', 'https://github.com/future/repo#password-1',
  'https://github.com/future/repo#readme?token=short', 'git+https://github.com/future/repo',
  'NOASSERTION', 'github:future/repo', `https://github.com/future/${secret}`]) {
  test(`npm homepage rejects unsafe project metadata: ${homepage}`, t => {
    const f = supplyFixture(t);
    changeSbom(f, d => {
      d.packages[0].externalRefs = [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: 'pkg:npm/future@1.2.3' }];
      d.packages[0].homepage = homepage;
    });
    rejectSupply(f.runSupply());
  });
}

for (const mismatch of ['name', 'versionInfo']) {
  test(`generic runtime purl must match package ${mismatch}`, t => {
    const f = supplyFixture(t);
    changeSbom(f, d => {
      Object.assign(d.packages[0], { name: 'node', versionInfo: '26.13.0',
        externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: 'pkg:generic/node@26.13.0' }] });
      d.packages[0][mismatch] = mismatch === 'name' ? 'other' : '26.14.0';
    });
    rejectSupply(f.runSupply());
  });
}

// A base/dependency bump must not require curating the upstream project's host.
test('unmodified 431e1fe UI arm64 inventory passes CLI with simulated config inspection', t => {
  const f = supplyFixture(t);
  const directory = new URL('./fixtures/sbom/431e1fe/', import.meta.url);
  const context = Object.fromEntries(readFileSync(new URL('gromesh-ui-arm64.context.env', directory), 'utf8')
    .trim().split(/\s+/).map(pair => { const i = pair.indexOf('='); return [pair.slice(0, i), pair.slice(i + 1)]; }));
  rmSync(f.sbomFile);
  rmSync(f.digestFile);
  writeFileSync(join(f.sbomDirectory, 'gromesh-ui-arm64.spdx.json'), readFileSync(new URL('gromesh-ui-arm64.spdx.json', directory)));
  writeFileSync(join(f.digestDirectory, 'ui-arm64.txt'), `${context.EXPECTED_DIGEST}\n`);
  assert.equal(f.runSupply('images', { ...context, ...fixtureInspection(JSON.parse(readFileSync(new URL('gromesh-ui-arm64.spdx.json', directory)))) }).status, 0);
});

for (const host of ['chromium.googlesource.com', 'new-upstream.example', 'a.b', 'release-2.project.example',
  'github.com.evil.example', 'a'.repeat(63) + '.example']) {
  test(`download host grammar accepts unseen FQDN ${host}`, t => {
    const f = supplyFixture(t);
    changeSbom(f, d => { d.packages[0].downloadLocation = `https://${host}/project/v1.2.3`; });
    assert.equal(f.runSupply().status, 0);
  });
}
for (const host of ['localhost', '127.1', '2130706433', '0x7f000001', '0x7f.0.0.1', '[::1]',
  '127.0.0.1', 'host.123', 'bad..example', '-bad.example', 'bad-.example', 'bad_host.example',
  'bad host.example', 'café.example', 'xn--caf-dma.example', 'a'.repeat(64) + '.example',
  Array(4).fill('a'.repeat(63)).join('.'), 'password.example', 'token.example', 'token-short.example', 'secret-project.example', 'api-key-short.example',
  `${secret}.example`, '4Xq9Wp2Ma6Jd8Nb3Zt5Rk7Vc1Ys0.example']) {
  test(`download host grammar rejects ${host}`, t => {
    const f = supplyFixture(t);
    changeSbom(f, d => { d.packages[0].downloadLocation = `https://${host}/project`; });
    rejectSupply(f.runSupply());
  });
}
for (const location of ['https://new-upstream.example:8443/project', 'https://user@new-upstream.example/project',
  'https://new-upstream.example/project?q=release', 'https://new-upstream.example/project?',
  'https://new-upstream.example/' + 'a'.repeat(401), 'ftp://new-upstream.example/project']) {
  test(`unseen host still enforces URL grammar: ${location}`, t => {
    const f = supplyFixture(t);
    changeSbom(f, d => { d.packages[0].downloadLocation = location; });
    rejectSupply(f.runSupply());
  });
}

const localImageId = `sha256:${JSON.parse(sbomFixture).packages.at(-1).checksums.find(c => c.algorithm === 'SHA256').checksumValue}`;
function prSupplyFixture(t) {
  const f = supplyFixture(t);
  const sourceName = `gromesh-ui-amd64-${env.GITHUB_SHA}-${localImageId.slice(7)}`;
  writeFileSync(f.sbomFile, JSON.stringify(bindSbomIdentity(JSON.parse(sbomFixture), sourceName, env.GITHUB_SHA, 'amd64', localImageId)));
  rmSync(f.digestDirectory, { recursive: true });
  const run = f.runSupply;
  f.runSupply = (extra = {}) => run('pr', { EXPECTED_DIGEST: '', PUBLISHED_SHA: '', PUBLISHED_ARCH: '',
    PUBLISHED_IMAGE: '', GITHUB_REPOSITORY_OWNER: '', RUNNER_TEMP: '', LOCAL_IMAGE_ID: localImageId, LOCAL_SBOM_DIGEST: localImageId, LOCAL_IDENTITY_KIND: 'classic-config', ...extra });
  return f;
}
test('PR mode validates SHA, arch and local image without publication or digest artifact', t => {
  assert.equal(prSupplyFixture(t).runSupply().status, 0);
});
for (const [label, extra] of [
  ['wrong SHA', { GITHUB_SHA: 'd'.repeat(40) }], ['wrong arch', { TARGET_ARCH: 'arm64' }],
  ['wrong runner', { RUNNER_ARCH: 'ARM64' }], ['no local ID', { LOCAL_IMAGE_ID: '' }],
  ['wrong local ID', { LOCAL_IMAGE_ID: `sha256:${'d'.repeat(64)}` }],
]) {
  test(`PR mode refuses ${label}`, t => { rejectSupply(prSupplyFixture(t).runSupply(extra)); });
}
for (const [label, mutate] of [
  ['short encoded comment', d => { d.packages[0].comment = 'dG9rZW49YWJjMTIz'; }],
  ['password phrase', d => { d.packages[0].description = 'The password is hunter2'; }],
  ['short encoded description', d => { d.packages[0].description = 'dG9rZW49YWJjMTIz'; }],
  ['unknown field', d => { d.password = 'short'; }],
  ['credential', d => { d.packages[0].comment = secret; }],
  ['missing root purl', d => { delete d.packages.at(-1).externalRefs; }],
  ['missing container', d => { delete d.packages.at(-1).primaryPackagePurpose; }],
  ['wrong local config checksum', d => { d.packages.at(-1).checksums[0].checksumValue = 'e'.repeat(64); }],
]) {
  test(`PR mode content refuses ${label}`, t => {
    const f = prSupplyFixture(t);
    const doc = JSON.parse(readFileSync(f.sbomFile));
    mutate(doc);
    writeFileSync(f.sbomFile, JSON.stringify(doc));
    rejectSupply(f.runSupply());
  });
}


test('success without a result report is rejected rather than inventing evidence', t => {
  const { directory } = fixture(t);
  rejected(run(["generate", "product-e2e", "--directory", directory]));
  assert.deepEqual(readdirSync(directory), []);
});
for (const outcome of ['success', 'failure']) {
  test(`zero executed tests are explicitly BLOCKED for ${outcome}`, t => {
    const { directory, file, report } = fixture(t);
    writeFileSync(report, JSON.stringify({ stats: { expected: 0, unexpected: 0, skipped: 0, flaky: 0, duration: 0 } }));
    assert.equal(run(['generate', 'product-e2e', '--directory', directory, '--report', report], { EVIDENCE_OUTCOME: outcome }).status, 0);
    const value = JSON.parse(readFileSync(file));
    assert.equal(value.status, 'BLOCKED');
    for (const key of ['counts', 'durationMs', 'countUnit']) assert.equal(key in value, false);
  });
}
for (const [key, value] of [['LOCAL_IMAGE_ID', ''], ['LOCAL_SBOM_DIGEST', ''], ['LOCAL_IDENTITY_KIND', ''],
  ['PUBLISHED_CONFIG_ID', ''], ['PUBLISHED_CONFIG_ID', `sha256:${'e'.repeat(64)}`]]) {
  test(`images requires independent build identity ${key} ${value ? 'mismatch' : 'missing'}`, t => {
    rejectSupply(supplyFixture(t).runSupply('images', { [key]: value }));
  });
}
for (const [label, mutate] of [
  ['missing root', doc => { doc.packages = doc.packages.filter(pkg => pkg.primaryPackagePurpose !== 'CONTAINER'); }],
  ['missing root purl', doc => { delete doc.packages.at(-1).externalRefs; }],
  ['missing root purpose', doc => { delete doc.packages.at(-1).primaryPackagePurpose; }],
  ['describes another package', doc => { for (const r of doc.relationships) if (r.relationshipType === 'DESCRIBES') r.relatedSpdxElement = doc.packages[0].SPDXID; }],
  ['self-consistent false checksum', doc => {
    const root = doc.packages.at(-1);
    root.checksums[0].checksumValue = 'e'.repeat(64);
    root.externalRefs[0].referenceLocator = root.externalRefs[0].referenceLocator.replace(/@sha256:[a-f0-9]{64}/, `@sha256:${'e'.repeat(64)}`);
  }],
]) test(`images independently rejects ${label}`, t => {
  const f = supplyFixture(t); changeSbom(f, mutate); rejectSupply(f.runSupply());
});


// The config ID and manifest digest here are the two distinct observations supplied
// with the blocker report. No production identity is learned from the SBOM itself.
const capturedPrContext = {
  GITHUB_SHA: '820bb3a2c5c7563c4ed16824db94fd5c2b979457', IMAGE_NAME: 'agent', TARGET_ARCH: 'arm64', RUNNER_ARCH: 'ARM64',
  LOCAL_IMAGE_ID: 'sha256:4085cdfd221d3cbc588ef61757a8dc5f8e7f9c7956add9c746a18cfd6353cf27',
  LOCAL_SBOM_DIGEST: 'sha256:4a86506b873e98e8872ee5e61682682752cdbc6a415ee26423caf2195928f6f3',
  LOCAL_IDENTITY_KIND: 'containerd-manifest',
};
for (const [label, extra] of [
  ['reported distinct config and manifest', {}],
  ['missing manifest', { LOCAL_SBOM_DIGEST: '' }],
  ['config substituted for manifest', { LOCAL_SBOM_DIGEST: capturedPrContext.LOCAL_IMAGE_ID }],
  ['wrong manifest', { LOCAL_SBOM_DIGEST: `sha256:${'e'.repeat(64)}` }],
  ['wrong config', { LOCAL_IMAGE_ID: `sha256:${'e'.repeat(64)}` }],
  ['unproven store', { LOCAL_IDENTITY_KIND: '' }],
]) test(`unmodified real pr-agent CLI: ${label}`, t => {
  const f = supplyFixture(t);
  rmSync(f.sbomFile);
  writeFileSync(join(f.sbomDirectory, 'gromesh-agent-arm64.spdx.json'),
    readFileSync(new URL('./fixtures/sbom/pr-agent/gromesh-agent-arm64.spdx.json', import.meta.url)));
  const result = f.runSupply('pr', { ...capturedPrContext, ...extra });
  if (label === 'reported distinct config and manifest') assert.equal(result.status, 0);
  else rejectSupply(result);
});


test('tool versions come from bounded installed executable versions without uploading output', () => {
  const execute = (command, args) => {
    if (command === 'pnpm' && args[0] === '--version') return { status: 0, stdout: '10.28.0\n' };
    if (command === 'pnpm') return { status: 0, stdout: 'Version 1.58.2\n' };
    if (command === 'helm') return { status: 0, stdout: 'v3.17.1+g123abc' };
    if (command === 'kind') return { status: 0, stdout: 'kind v0.27.0 go1.24.0 linux/amd64\n' };
    if (command === 'kubectl') return { status: 0, stdout: JSON.stringify({ clientVersion: { gitVersion: 'v1.32.2' }, secret }) };
    return { status: 0, stdout: secret };
  };
  assert.deepEqual(installedToolVersions('ui-acceptance', execute), { node: process.versions.node, pnpm: '10.28.0', playwright: '1.58.2' });
  assert.deepEqual(installedToolVersions('mvp-e2e', execute), { node: process.versions.node, helm: '3.17.1', kind: '0.27.0', kubectl: '1.32.2' });
  assert.deepEqual(installedToolVersions('kong-image-build', execute), { node: process.versions.node });
  assert.deepEqual(installedToolVersions('product-e2e', () => ({ status: 1, stdout: secret })), { node: process.versions.node });
});
test('aggregates measured command reports and permits absent unexecuted commands only on failure', t => {
  const { root, report, directory, file } = fixture(t, 'kong-image-build');
  const second = join(root, 'second.json');
  writeFileSync(report, JSON.stringify({ countUnit: 'commands', stats: { expected: 1, unexpected: 0, skipped: 0, flaky: 0, duration: 10 } }));
  writeFileSync(second, JSON.stringify({ countUnit: 'commands', stats: { expected: 0, unexpected: 1, skipped: 0, flaky: 0, duration: 20 } }));
  const args = ['generate', 'kong-image-build', '--directory', directory, '--report', report, '--report', second, '--report', join(root, 'unexecuted.json')];
  assert.equal(run(args, { EVIDENCE_OUTCOME: 'failure' }).status, 0);
  const evidence = JSON.parse(readFileSync(file));
  assert.equal(evidence.countUnit, 'commands');
  assert.equal(evidence.durationMs, 30);
  assert.deepEqual(evidence.counts, { total: 2, passed: 1, failed: 1, skipped: 0, flaky: 0 });
  rmSync(file);
  rejected(run(args));
  rejected(run(['generate', 'kong-image-build', '--directory', directory, '--report', report, '--report', report]));
});
