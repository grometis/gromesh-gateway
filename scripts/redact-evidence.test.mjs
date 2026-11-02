import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import { redactEvidence } from "./redact-evidence.mjs";

const script = fileURLToPath(new URL("./redact-evidence.mjs", import.meta.url));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "redact-evidence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function run(directories, env = {}, args = [], input) {
  const result = spawnSync(process.execPath, [script, ...directories,
    "--env", "REDACT_EVIDENCE_TEST_UNUSED", ...Object.keys(env), ...args], {
    env: { ...process.env, ...env }, encoding: "utf8", input,
  });
  assert.ifError(result.error);
  assert.equal(result.stdout, "");
  for (const value of Object.values(env).filter(Boolean)) {
    assert.equal(result.stderr.includes(value), false, "stderr must not contain a secret");
  }
  return result;
}

test("replaces every literal occurrence, including special characters and UTF-8", t => {
  const root = fixture(t);
  const env = { TEST_PASSWORD: 'p.*[x](a)?^$|\\+$&/"\nç', TEST_TOKEN: "long-token-123" };
  const file = join(root, "compose.log");
  writeFileSync(file, `before ${env.TEST_PASSWORD} ${env.TEST_TOKEN} ${env.TEST_PASSWORD} after pZZx`);
  const result = run([root], env);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(readFileSync(file, "utf8"), "before REDACTED REDACTED REDACTED after pZZx");
});

// A complete single-entry ZIP, with DEFLATE, CRC and central directory (not a renamed buffer).
function zip(content) {
  const name = Buffer.from("trace.network");
  const data = Buffer.from(content);
  const compressed = deflateRawSync(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc32(data), 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(20, 4);
  local.copy(central, 6, 4, 30);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + compressed.length, 16);
  assert.equal(inflateRawSync(compressed).toString(), content);
  return Buffer.concat([local, name, compressed, central, name, end]);
}

test("refuses a real DEFLATE ZIP containing a nonliteral credential without modifying it", t => {
  const root = fixture(t);
  const secret = "credential-only-inside-deflated-entry-123456";
  const archive = zip(`Authorization: Bearer ${secret}\n`);
  assert.equal(archive.includes(Buffer.from(secret)), false);
  const file = join(root, "trace.zip");
  writeFileSync(file, archive);
  const result = run([root], { TEST_TOKEN: secret });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "Evidence redaction failed.\n");
  assert.deepEqual(readFileSync(file), archive);
});

test("refuses every compressed extension, including uppercase and nested files", t => {
  const root = fixture(t);
  mkdirSync(join(root, "nested"));
  for (const extension of ["zip", "gz", "tgz", "br", "zst", "7z", "ZIP", "TGZ"]) {
    const file = join(root, "nested", `credential.${extension}`);
    writeFileSync(file, "not safe to scan as literal bytes");
    assert.equal(run([root]).status, 1, extension);
    rmSync(file);
  }
  const disguised = join(root, "trace.bin");
  writeFileSync(disguised, zip("hidden credential"));
  assert.equal(run([root]).status, 1);
});

test("refuses Playwright HTML with its embedded base64 ZIP while allowing ordinary HTML", t => {
  const root = fixture(t);
  const file = join(root, "index.html");
  const html = `<html><template id="playwrightReportBase64">data:application/zip;base64,${zip("hidden-secret").toString("base64")}</template></html>`;
  writeFileSync(file, html);
  const result = run([root], { TEST_TOKEN: "hidden-secret" });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "Evidence redaction failed.\n");
  assert.equal(readFileSync(file, "utf8"), html);
  writeFileSync(file, "<html>ordinary evidence</html>");
  assert.equal(run([root]).status, 0);
});

test("redacts generated credentials in raw headers, JSON fields, header arrays and cookies", t => {
  const root = fixture(t);
  const file = join(root, "traffic.log");
  const session = "S".repeat(43);
  const csrf = "C".repeat(43);
  const token = `ggt_${"aZ0_-".repeat(8)}abc`;
  const entries = [
    "Authorization: Bearer application-node-token",
    "authorization: Basic dXNlcjpwYXNz",
    "Cookie: other=private-cookie; gromesh_session=" + session,
    "Set-Cookie: gromesh_session=" + session + "; HttpOnly; Path=/",
    "X-CSRF-Token: " + csrf,
    JSON.stringify({ Authorization: "Bearer application-node-token", cookie: "other=private-cookie", "set-cookie": "other=private-cookie", "x-csrf-token": csrf, status: 200 }),
    JSON.stringify({ headers: [{ name: "Authorization", value: "Bearer application-node-token" }, { value: "other=private-cookie", name: "Cookie" }, { name: "X-CSRF-Token", value: csrf }, { name: "Cookie", value: 'other=private{cookie}; quoted="private-quoted"' }] }),
    JSON.stringify({ cookies: [{ name: "gromesh_session", value: session, httpOnly: true }], csrfToken: csrf }),
    `session: gromesh_session=${session}; path=/`,
    `issued token ${token}`,
    `const headers = { Authorization: 'Bearer application-node-token', 'X-CSRF-Token': '${csrf}' };`,
    JSON.stringify({ headers: [{ name: "Authorization", value: "Bearer application-node-token" }], "X-CSRF-Token": csrf }, null, 2),
  ];
  const control = 'authorizationEnabled=true; cookieCount=2; ggt_short; ggt_' + "a".repeat(44);
  writeFileSync(file, [...entries, control].join("\n"));
  assert.equal(run([root]).status, 0);
  const saved = readFileSync(file, "utf8");
  for (const secret of [session, csrf, token, "application-node-token", "dXNlcjpwYXNz", "private-cookie", "private{cookie}", "private-quoted"]) {
    assert.equal(saved.includes(secret), false, secret);
  }
  assert.ok(saved.includes(control));
  assert.equal(JSON.parse(saved.split("\n")[5]).status, 200);
  assert.equal(JSON.parse(saved.split("\n")[6]).headers[1].value, "REDACTED");
  assert.equal(JSON.parse(saved.split("\n")[7]).cookies[0].httpOnly, true);
  assert.equal(run([root]).status, 0, "redaction is idempotent");
});

test("redacts authentication before literals can change credential field names", t => {
  const root = fixture(t);
  const file = join(root, "session.json");
  writeFileSync(file, JSON.stringify({ cookies: [{ name: "gromesh_session", value: "S".repeat(43) }] }));
  redactEvidence([root], [], {}, [Buffer.from("gromesh")]);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).cookies[0].value, "REDACTED");
});

test("collects only credential-like kind Secret values and preserves deployment evidence", t => {
  const root = fixture(t);
  const file = join(root, "kind.log");
  const data = {
    database: "gromesh", namespace: "gromesh-mvp", image: "ghcr.io/gromesh/gromesh-control-plane:ci@sha256:abcd",
    user: "gromesh_reader", url: "http://clickhouse:8123", password: "kind-admin-password-123",
    "writer-password": "writer-password-123", token: "kind-token-12345", key: "kind-key-1234567",
    secret: "kind-secret-12345", encryption: "kind-encryption-123", "fingerprint-key": "fingerprint-123456",
    apikey: "kind-apikey-12345", "short-token": "short",
  };
  const payload = JSON.stringify({ items: [{ metadata: { namespace: "gromesh-mvp" }, type: "Opaque",
    data: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, Buffer.from(value).toString("base64")])) }] });
  const evidence = { database: data.database, namespace: data.namespace, image: data.image,
    cookies: [{ name: "gromesh_session", value: "S".repeat(43) }], values: Object.values(data) };
  writeFileSync(file, JSON.stringify(evidence));
  assert.equal(run([root], {}, ["--secrets-stdin", "gromesh-mvp"], payload).status, 0);
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(saved.database, "gromesh");
  assert.equal(saved.namespace, "gromesh-mvp");
  assert.equal(saved.image, data.image);
  assert.equal(saved.cookies[0].name, "gromesh_session");
  assert.equal(saved.cookies[0].value, "REDACTED");
  assert.deepEqual(saved.values, [...Object.values(data).slice(0, 5), ...Array(8).fill("REDACTED"), "short"]);
});

test("redacts key-auth headers, queries and creation responses while preserving generic keys", t => {
  const root = fixture(t);
  const file = join(root, "key-auth.log");
  const credential = { id: "credential-id", consumerId: "consumer-id", keyHint: "…KKKK", status: "active",
    tags: [], createdAt: "2026-11-02T12:00:00.000Z", key: "K".repeat(43) };
  const entries = [JSON.stringify({ response: credential, generic: { key: "sort-order", label: "Sort" } }),
    JSON.stringify({ response: { key: "K".repeat(43) } })];
  for (const name of ["apikey", "api-key", "x-api-key"]) {
    entries.push(`${name}: private-header-value\nstatus=503`);
    entries.push(`GET /echo?${name}=private-query-value&limit=5 HTTP/1.1`);
    entries.push(JSON.stringify({ headers: { [name]: "private-header-value" },
      queryString: [{ name, value: "private-query-value" }], headersArray: [{ value: "private-header-value", name }] }));
  }
  writeFileSync(file, entries.join("\n"));
  assert.equal(run([root]).status, 0);
  const saved = readFileSync(file, "utf8");
  for (const secret of [credential.key, "private-header-value", "private-query-value"]) assert.equal(saved.includes(secret), false);
  const response = JSON.parse(saved.split("\n")[0]);
  assert.deepEqual(response.response, { ...credential, key: "REDACTED" });
  assert.deepEqual(response.generic, { key: "sort-order", label: "Sort" });
  assert.match(saved, /apikey=REDACTED&limit=5 HTTP\/1\.1/);
  assert.match(saved, /status=503/);
  assert.equal(run([root]).status, 0);
});

test("preserves JSON delimiters, arrays, scalars and following evidence during redaction", t => {
  const root = fixture(t);
  const file = join(root, "fallback.log");
  const entries = [
    { headers: { Authorization: ["Bearer private", "Basic private"] }, status: 502, requestId: "req-123" },
    { Authorization: null, cookie: 42, csrfToken: false, status: 502 },
    { headers: { Authorization: "Bearer private", Cookie: ["private-cookie"], "Set-Cookie": [] }, status: 502 },
    { message: 'Authorization: Bearer private\nstatus=503', status: 502, requestId: "req-123" },
    { message: 'request failed: Authorization: Bearer private\nstatus=503', status: 502, requestId: "req-123" },
    { message: `request failed: 'Authorization': ["Bearer private"], status=503`, status: 502 },
  ];
  writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join("\n")
    + '\nAuthorization: Bearer private\r\nstatus=503\nCookie: "private-cookie"; other=private-cookie\r\nstatus=504');
  assert.equal(run([root]).status, 0);
  const lines = readFileSync(file, "utf8").split("\n");
  assert.deepEqual(JSON.parse(lines[0]), { headers: { Authorization: ["REDACTED", "REDACTED"] }, status: 502, requestId: "req-123" });
  assert.deepEqual(JSON.parse(lines[1]), entries[1]);
  assert.deepEqual(JSON.parse(lines[2]), { headers: { Authorization: "REDACTED", Cookie: ["REDACTED"], "Set-Cookie": [] }, status: 502 });
  assert.deepEqual(JSON.parse(lines[3]), { ...entries[3], message: "Authorization: REDACTED\nstatus=503" });
  assert.deepEqual(JSON.parse(lines[4]), { ...entries[4], message: "request failed: Authorization: REDACTED\nstatus=503" });
  assert.deepEqual(JSON.parse(lines[5]), { message: `request failed: 'Authorization': ["REDACTED"], status=503`, status: 502 });
  assert.equal(lines[6], "Authorization: REDACTED\r");
  assert.equal(lines[7], "status=503");
  assert.equal(lines[8], "Cookie: REDACTED\r");
  assert.equal(lines[9], "status=504");
});

test("redacts escaped authentication names inside serialized JSON strings", t => {
  const root = fixture(t);
  const file = join(root, "escaped.json");
  const nested = { csrfToken: "C".repeat(43), Authorization: ["Bearer private"],
    cookies: [{ name: "gromesh_session", value: "S".repeat(43) }],
    headers: [{ name: "api-key", value: "private-key" }], response: { key: "K".repeat(43) }, status: 502 };
  writeFileSync(file, JSON.stringify({ message: JSON.stringify(nested), deeper: JSON.stringify({ message: JSON.stringify(nested) }), requestId: "req-123" }));
  assert.equal(run([root]).status, 0);
  const saved = JSON.parse(readFileSync(file, "utf8"));
  const expected = { csrfToken: "REDACTED", Authorization: ["REDACTED"], cookies: [{ name: "gromesh_session", value: "REDACTED" }],
    headers: [{ name: "api-key", value: "REDACTED" }], response: { key: "REDACTED" }, status: 502 };
  assert.deepEqual(JSON.parse(saved.message), expected);
  assert.deepEqual(JSON.parse(JSON.parse(saved.deeper).message), expected);
  assert.equal(saved.requestId, "req-123");
  const fragment = join(root, "fragment.log");
  writeFileSync(fragment, "request failed: " + JSON.stringify(JSON.stringify(nested)).slice(1, -1) + " status=503");
  assert.equal(run([root]).status, 0);
  assert.equal(readFileSync(fragment, "utf8"), "request failed: " + JSON.stringify(JSON.stringify(expected)).slice(1, -1) + " status=503");
  assert.equal(run([root]).status, 0);
});

test("refuses authentication patterns reintroduced into the file after writing", t => {
  const root = fixture(t);
  const file = join(root, "log");
  const preload = join(fixture(t), "alter-write.mjs");
  writeFileSync(preload, `
import { createRequire, syncBuiltinESMExports } from "node:module";
const fs = createRequire(import.meta.url)("node:fs");
const original = fs.writeFileSync;
fs.writeFileSync = (file, data) => original(file, Buffer.concat([Buffer.from(data), Buffer.from(process.env.REDACTION_RESIDUE)]));
syncBuiltinESMExports();
`);
  for (const residue of ["\nX-CSRF-Token: residual-token", "\nx-api-key: residual-token",
    '\n{"headers":{"Authorization":["Bearer residual-token"]},"status":502}',
    "\n" + JSON.stringify({ message: JSON.stringify({ csrfToken: "residual-token" }) }),
    "\n" + JSON.stringify({ key: "K".repeat(43) })]) {
    writeFileSync(file, "Authorization: Bearer original-token");
    const result = spawnSync(process.execPath, ["--import", preload, script, root], {
      encoding: "utf8", env: { ...process.env, REDACTION_RESIDUE: residue },
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "Evidence redaction failed.\n");
    assert.ok(readFileSync(file, "utf8").endsWith(residue));
  }
});

test("recovers Secrets with kubectl in the redactor process, capturing both streams and failures", t => {
  const root = fixture(t);
  const tools = fixture(t);
  const envFile = join(tools, "github-env");
  writeFileSync(envFile, "unchanged=value\n");
  const file = join(root, "log");
  const secret = "recovered-only-from-kubectl";
  writeFileSync(join(tools, "kubectl"), `#!/usr/bin/env node
import assert from "node:assert/strict";
assert.deepEqual(process.argv.slice(2), ["--context", "kind-disposable", "get", "secrets", "--all-namespaces", "-o", "json"]);
console.error(process.env.FIXTURE_SECRET);
console.log(JSON.stringify({ items: [{ metadata: { namespace: "gromesh-mvp" }, type: "Opaque", data: { key: Buffer.from(process.env.FIXTURE_SECRET).toString("base64") } }] }));
process.exitCode = Number(process.env.FIXTURE_STATUS);
`, { mode: 0o755 });
  for (const status of [0, 1]) {
    writeFileSync(file, secret);
    const result = spawnSync(process.execPath, [script, root, "--kube-secrets", "kind-disposable", "gromesh-mvp"], {
      env: { ...process.env, PATH: `${tools}:${process.env.PATH}`, FIXTURE_SECRET: secret, FIXTURE_STATUS: String(status), GITHUB_ENV: envFile }, encoding: "utf8",
    });
    assert.ifError(result.error);
    assert.equal(result.status, status);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, status === 0 ? "" : "Evidence redaction failed.\n");
    assert.equal(readFileSync(file, "utf8"), status === 0 ? "REDACTED" : secret);
    assert.equal(readFileSync(envFile, "utf8"), "unchanged=value\n");
  }
});

test("consumes Kubernetes Secret JSON via stdin without exporting values or writing a secret file", t => {
  const root = fixture(t);
  const file = join(root, "diagnostics.log");
  const envFile = join(fixture(t), "github-env");
  writeFileSync(envFile, "existing=value\n");
  const value = 'kind-secret.*[x]"\nç';
  const payload = JSON.stringify({ items: [
    { metadata: { namespace: "gromesh-mvp" }, type: "Opaque", data: { password: Buffer.from(value).toString("base64") } },
    { metadata: { namespace: "foreign" }, type: "Opaque", data: { password: Buffer.from("foreign-value").toString("base64") } },
    { metadata: { namespace: "gromesh-mvp" }, type: "kubernetes.io/service-account-token", data: { token: Buffer.from("service-account-value").toString("base64") } },
  ] });
  writeFileSync(file, `${value}\nforeign-value\nservice-account-value`);
  const result = run([root], { GITHUB_ENV: envFile }, ["--secrets-stdin", "gromesh-mvp", "gromesh-mvp-defaults"], payload);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(readFileSync(file, "utf8"), "REDACTED\nforeign-value\nservice-account-value");
  assert.equal(readFileSync(envFile, "utf8"), "existing=value\n");
});

test("malformed or empty Secret input refuses generically before rewriting evidence", t => {
  const root = fixture(t);
  const file = join(root, "log");
  writeFileSync(file, "unchanged");
  for (const input of ["private-malformed-json", "{}", '{"items":[]}', '{"items":[{"metadata":{"namespace":"gromesh-mvp"},"type":"Opaque","data":{"key":"not-base64!"}}]}']) {
    const result = run([root], {}, ["--secrets-stdin", "gromesh-mvp"], input);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "Evidence redaction failed.\n");
    assert.equal(readFileSync(file, "utf8"), "unchanged");
  }
});

test("refuses a symlink root with or without trailing slashes", t => {
  const root = fixture(t);
  const target = fixture(t);
  const file = join(target, "private.log");
  writeFileSync(file, "linked-secret");
  const link = join(root, "linked-root");
  symlinkSync(target, link);
  for (const suffix of ["", "/", "///", "/./", "//.//", "/././"]) {
    const result = run([link + suffix], { TEST_TOKEN: "linked-secret" });
    assert.equal(result.status, 1, suffix);
    assert.equal(result.stderr, "Evidence redaction failed.\n");
    assert.equal(readFileSync(file, "utf8"), "linked-secret");
  }
});

test("preserves binary bytes around secrets and files without matches", t => {
  const root = fixture(t);
  const prefix = Buffer.from([0, 255, 128, 1]);
  const suffix = Buffer.from([254, 0, 192]);
  const file = join(root, "attachment.bin");
  const untouched = join(root, "screenshot.png");
  writeFileSync(file, Buffer.concat([prefix, Buffer.from("binary-secret"), suffix]));
  writeFileSync(untouched, Buffer.concat([prefix, suffix]));
  assert.equal(run([root], { TEST_PASSWORD: "binary-secret" }).status, 0);
  assert.deepEqual(readFileSync(file), Buffer.concat([prefix, Buffer.from("REDACTED"), suffix]));
  assert.deepEqual(readFileSync(untouched), Buffer.concat([prefix, suffix]));
});

test("visits nested directories and multiple roots, ignoring absent roots", t => {
  const root = fixture(t);
  const first = join(root, "test-results");
  const second = join(root, "report");
  mkdirSync(join(first, "nested", "attachments"), { recursive: true });
  mkdirSync(second);
  const paths = [join(first, "nested", "attachments", "log"), join(second, "index.html")];
  for (const file of paths) writeFileSync(file, "token-value");
  assert.equal(run([first, join(root, "missing"), second], { TEST_TOKEN: "token-value" }).status, 0);
  for (const file of paths) assert.equal(readFileSync(file, "utf8"), "REDACTED");
});

test("empty and unset values, empty files, empty and absent directories are harmless", t => {
  const root = fixture(t);
  const file = join(root, "empty.log");
  writeFileSync(file, "");
  const unchanged = join(root, "nonempty.log");
  writeFileSync(unchanged, "unchanged evidence");
  const result = run([root, join(root, "missing")], { TEST_EMPTY: "", TEST_UNSET: undefined });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(readFileSync(file).length, 0);
  assert.equal(readFileSync(unchanged, "utf8"), "unchanged evidence");
  mkdirSync(join(root, "empty"));
  assert.equal(run([join(root, "empty")], { TEST_TOKEN: "unused-token" }).status, 0);
});

test("redacts overlapping values longest first regardless of argument order", t => {
  const root = fixture(t);
  const file = join(root, "log");
  writeFileSync(file, "prefix-secret-suffix secret");
  assert.equal(run([root], { TEST_SHORT: "secret", TEST_LONG: "prefix-secret-suffix" }).status, 0);
  assert.equal(readFileSync(file, "utf8"), "REDACTED REDACTED");
});

test("exits 1 if replacement leaves a secret on disk, without disclosing it", t => {
  const root = fixture(t);
  writeFileSync(join(root, "log"), "private-value");
  const result = run([root], { TEST_FIRST: "private-value", TEST_RESIDUE: "REDACTED" });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "Evidence redaction failed.\n");
  assert.equal(readFileSync(join(root, "log"), "utf8"), "REDACTED");
});

test("refuses symlinks rather than allowing an unscanned upload", t => {
  const root = fixture(t);
  const outside = fixture(t);
  const file = join(outside, "secret.log");
  writeFileSync(file, "linked-secret");
  symlinkSync(file, join(root, "link.log"));
  assert.equal(run([root], { TEST_PASSWORD: "linked-secret" }).status, 1);
  assert.equal(readFileSync(file, "utf8"), "linked-secret");
});
