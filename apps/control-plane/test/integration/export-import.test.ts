import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse, stringify } from "yaml";
import * as yaml from "yaml";
import { type ConfigDocument, type KongDeclarativeConfig } from "@gromesh/compiler";
import { basicAuthHashContext, certificateKeyContext, credentialContext, Encryptor, jwtSecretContext, pluginSecretContext, snapshotContext, ENCRYPTOR } from "../../src/crypto/crypto.js";
import { normalizedConfig, normalizedHash } from "./config-normalization.js";
import { selfSigned, expired } from "./certs.js";
import { ImportBodyPipe } from "../../src/config-transfer/document.js";
import { contracts } from "../../src/common/contract.js";
import { AutoPublisher, SnapshotsService } from "../../src/snapshots/snapshots.js";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { startHarness, uniq, type Harness } from "./harness.js";
vi.mock("yaml", async (importOriginal) => {
  const actual = await importOriginal<typeof import("yaml")>();
  return { ...actual, parseAllDocuments: vi.fn(actual.parseAllDocuments) };
});

let h: Harness;
beforeAll(async () => { h = await startHarness({ autoPublishPollMs: 0, platformHttpLogEndpoint: "http://collector.test:9000" }); });
afterAll(async () => { await h?.close(); });
test("exports the draft and imports into an empty environment, with no implicit publication", async () => {
  const env = await h.api("POST", "/environments", { name: uniq("export") });
  const base = `/environments/${env.body.id}`;
  await h.api("POST", `${base}/services`, { name: "echo", protocol: "http", host: "echo", port: 80 });
  const exported = await h.api("GET", `${base}/export?format=json`);
  expect(exported.status).toBe(200);
  expect(exported.body.apiVersion).toBe("gromesh/v1");
  const target = await h.api("POST", "/environments", { name: uniq("import"), publishMode: "auto" });
  const imported = await h.api("POST", `/environments/${target.body.id}/import`, { document: exported.body, mode: "replace", dryRun: false });
  expect(imported.status).toBe(200);
  expect(imported.body.errors).toEqual([]);
  expect(imported.body.added).toHaveLength(1);
  expect((await h.api("GET", `/environments/${target.body.id}`)).body.currentVersion).toBe(null);
});

// Each fixture goes through the existing write services, independently of the import implementation.

// Unique in the instance (decision H-5): other test files share the database, so these carry a suffix of this run.
const RUN = uniq("ei");
const ISSUER_HS = `issuer-hs-${RUN}`, ISSUER_RS = `issuer-rs-${RUN}`, LOGIN = `login-${RUN}`;
const SNI = `import-${RUN}.example.test`, ALIAS = `alias-${RUN}.example.test`, OTHER_SNI = `other-${RUN}.example.test`;
const secrets = { key: `fixture-key-auth-secret-12345-${RUN}`, jwt: "fixture-jwt-secret-".repeat(3), password: "fixture-basic-password", plugin: "fixture-plugin-password" };
const issuedCert = selfSigned("import.example.test");
// Omit the redundant public point: its base64 lines also occur in the public certificate.
const cert = { ...issuedCert, key: execFileSync("openssl", ["ec", "-no_public"], { input: issuedCert.key, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }) };
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();
async function createEnvironment(mode = "manual") {
  const response = await h.api("POST", "/environments", { name: uniq("transfer"), publishMode: mode });
  expect(response.status).toBe(201);
  return `/environments/${response.body.id}`;
}
// Credentials and server names are unique in the instance (decision H-5): each fixture holds the same ones, so the
// previous fixture's environment leaves the instance first (the tests of this file run in sequence).
const fixtures: string[] = [];
async function fixture() {
  for (const old of fixtures.splice(0)) await h.api("DELETE", old);
  const base = await createEnvironment();
  fixtures.push(base);
  const post = async (path: string, body: unknown) => { const res = await h.api("POST", base + path, body); expect(res.status, JSON.stringify(res.body)).toBe(201); return res.body; };
  const service = await post("/services", { name: "backend", protocol: "http", host: "pool.test", port: 80, path: "/", retries: 2, connectTimeoutMs: 1000, tags: ["team:test"] });
  const route = await post("/routes", { name: "public", serviceId: service.id, paths: ["/public"], methods: ["GET"] });
  const consumer = await post("/consumers", { username: "partner", customId: "partner-custom" });
  await post(`/consumers/${consumer.id}/key-auth`, { key: secrets.key });
  await post(`/consumers/${consumer.id}/jwt`, { key: ISSUER_HS, algorithm: "HS256", secret: secrets.jwt });
  await post(`/consumers/${consumer.id}/jwt`, { key: ISSUER_RS, algorithm: "RS256", rsaPublicKey: rsa });
  await post(`/consumers/${consumer.id}/basic-auth`, { username: LOGIN, password: secrets.password });
  expect((await h.api("PUT", `${base}/consumers/${consumer.id}/acl-groups`, { groups: ["partners", "readers"] })).status).toBe(200);
  await post("/plugins", { name: "key-auth", scope: { routeId: route.id }, config: { key_names: ["apikey"] } });
  await post("/plugins", { name: "rate-limiting", scope: { serviceId: service.id, consumerId: consumer.id }, config: { minute: 10, policy: "redis", redis: { host: "redis.test", port: 6379, password: secrets.plugin } } });
  const upstream = await post("/upstreams", { name: "pool.test", algorithm: "consistent-hashing", hashOn: "header", hashOnHeader: "X-Partner", healthchecks: { active: { type: "http", httpPath: "/health" }, passive: { unhealthyTimeouts: 4 } } });
  await post(`/upstreams/${upstream.id}/targets`, { target: "echo:80", weight: 100 });
  await post("/certificates", { cert: cert.cert, key: cert.key, snis: [SNI, ALIAS] });
  return base;
}
async function exportDocument(base: string): Promise<ConfigDocument> {
  const result = await h.api<ConfigDocument>("GET", `${base}/export?format=json`);
  expect(result.status).toBe(200);
  expect(contracts.validator("GromeshConfigV1Export")(structuredClone(result.body))).toBe(true);
  return result.body;
}
async function importDocument(base: string, document: unknown, overrides: Record<string, unknown> = {}) {
  return h.api("POST", `${base}/import`, { document, mode: "replace", dryRun: false, ...overrides });
}
async function published(base: string) {
  const response = await h.api("POST", `${base}/snapshots`, {});
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  const id = base.split("/").at(-1)!;
  const rows = await h.sql.query("select config from snapshots where environment_id=$1 and version=$2", [id, response.body.version]);
  return h.app.get<Encryptor>(ENCRYPTOR).openJson<KongDeclarativeConfig>(rows.rows[0].config, snapshotContext(id, response.body.version, "config"));
}
async function stateOf(base: string) {
  const id = base.split("/").at(-1)!;
  const tables = ["services", "routes", "consumers", "keyauth_credentials", "jwt_credentials", "basicauth_credentials", "plugins", "upstreams", "targets", "certificates", "certificate_snis", "snapshots", "audit_events"];
  const counts: Record<string, number> = {};
  for (const table of tables) counts[table] = Number((await h.sql.query(`select count(*) from ${table} where environment_id=$1`, [id])).rows[0].count);
  const env = (await h.sql.query("select * from environments where id=$1", [id])).rows[0];
  return { counts, env };
}
async function openedSecrets(base: string) {
  const id = base.split("/").at(-1)!;
  const enc = h.app.get<Encryptor>(ENCRYPTOR);
  const open = (sealed: string, context: Parameters<Encryptor["open"]>[1]) => {
    expect(sealed.startsWith("enc:v2:")).toBe(true);
    return enc.open(sealed, context);
  };
  const read = async (table: string) => (await h.sql.query(`select * from ${table} where environment_id=$1 order by id`, [id])).rows as Record<string, string>[];
  const key = (await read("keyauth_credentials")).map(r => open(r.key!, credentialContext(r.id!)));
  const jwt = (await read("jwt_credentials")).filter(r => r.secret).map(r => open(r.secret!, jwtSecretContext(r.id!)));
  const basic = (await read("basicauth_credentials")).map(r => open(r.password_hash!, basicAuthHashContext(r.id!)));
  const certificates = (await read("certificates")).map(r => open(r.key!, certificateKeyContext(r.id!)));
  const pluginRows = await h.sql.query("select id, config from plugins where environment_id=$1 and name='rate-limiting'", [id]);
  const plugin = pluginRows.rows.map(r => open(r.config.redis.password, pluginSecretContext(r.id, ["redis", "password"])));
  return { key, jwt, basic, certificates, plugin };
}

test("(a,e) redacted YAML/JSON export, new environment import and explicit publish produce equivalent snapshots", async () => {
  const source = await fixture();
  const original = await published(source);
  expect(original.plugins.map(p => p.name)).toEqual(expect.arrayContaining(["http-log", "prometheus"]));
  const document = await exportDocument(source);
  const yaml = await h.api<string>("GET", `${source}/export`);
  expect(yaml.contentType).toContain("application/yaml");
  expect(parse(yaml.body)).toEqual(document);
  // A short last line of the PEM key (e.g. "AwEH") is not secret: the P-256 public key in the certificate starts the same way.
  const allSecrets = [...Object.values(secrets), ...(await openedSecrets(source)).basic, ...cert.key.split("\n").filter(l => l.length >= 16 && !l.startsWith("-----"))];
  for (const representation of [JSON.stringify(document), yaml.body]) for (const secret of allSecrets) expect(representation).not.toContain(secret);
  // The copy carries the same credentials and server names: in the same instance the source leaves first (H-5).
  expect((await h.api("DELETE", source)).status).toBe(204);
  fixtures.splice(0);
  const target = await createEnvironment("auto");
  fixtures.push(target);
  const empty = await stateOf(target);
  const missing = await importDocument(target, document);
  expect(missing.status).toBe(422);
  expect(await stateOf(target)).toEqual(empty);
  document.consumers[0]!.keyAuthCredentials[0]!.key = secrets.key;
  document.consumers[0]!.jwtCredentials.find(j => j.algorithm === "HS256")!.secret = secrets.jwt;
  document.consumers[0]!.basicAuthCredentials[0]!.password = secrets.password;
  document.plugins.find(p => p.name === "rate-limiting")!.config.redis = { host: "redis.test", port: 6379, password: secrets.plugin };
  document.certificates[0]!.key = cert.key;
  const imported = await importDocument(target, stringify(document));
  expect(imported.status, JSON.stringify(imported.body)).toBe(200);
  expect(imported.body.errors).toEqual([]);
  await h.app.get(AutoPublisher).tick();
  expect(await h.app.get(SnapshotsService).autoPublish(target.split("/").at(-1)!, 0)).toBe(true);
  expect((await stateOf(target)).counts.snapshots).toBe(0);
  // Ordinary edits cannot release the imported draft to the auto publisher either.
  const targetService = (await h.api("GET", `${target}/services`)).body.items[0];
  expect((await h.api("PUT", `${target}/services/${targetService.id}`, document.services[0])).status).toBe(200);
  await h.app.get(SnapshotsService).autoPublish(target.split("/").at(-1)!, 0);
  expect((await stateOf(target)).counts.snapshots).toBe(0);
  const copy = await published(target);
  const normalizedOriginal = normalizedConfig(original, secrets.password), normalizedCopy = normalizedConfig(copy, secrets.password);
  expect(normalizedCopy).toEqual(normalizedOriginal);
  expect(normalizedHash(normalizedCopy)).toEqual(normalizedHash(normalizedOriginal));
  const sourceIds = new Set(original.services.map(s => s.id));
  expect(copy.services.every(s => !sourceIds.has(s.id))).toBe(true);
  const auditRows = await h.sql.query("select action, after from audit_events where environment_id=$1 and action='environment.import'", [target.split("/").at(-1)]);
  expect(auditRows.rows).toHaveLength(1);
  for (const secret of allSecrets) expect(JSON.stringify(auditRows.rows)).not.toContain(secret);
});

test("(b) imports the official Kong example entity by entity and reports original unknown paths", async () => {
  const base = await createEnvironment();
  const config = JSON.parse(readFileSync(new URL("../../../../contracts/examples/snapshot.example.json", import.meta.url), "utf8")).config;
  const imported = await importDocument(base, config, { sourceFormat: "kong-declarative-3.0" });
  expect(imported.status, JSON.stringify(imported.body)).toBe(200);
  const document = await exportDocument(base);
  expect(document.services[0]).toMatchObject({ name: "echo", host: "echo", protocol: "http", port: 80 });
  expect(document.routes[0]).toMatchObject({ name: "echo-public", service: "echo", methods: ["GET", "POST"], paths: ["/echo"], stripPath: true });
  expect(document.consumers[0]).toMatchObject({ username: "demo-app", keyAuthCredentials: [{ keyHint: "…-123" }] });
  expect(document.plugins).toEqual(expect.arrayContaining([expect.objectContaining({ name: "key-auth", scope: { route: "echo-public" }, config: { key_names: ["apikey"] } }), expect.objectContaining({ name: "rate-limiting", scope: { service: "echo" }, config: { minute: 60, policy: "local" } })]));
  config.vaults = [];
  config.services[0].client_certificate = null;
  config.plugins[0].config.unknown_nested = "not supported";
  const before = await stateOf(base);
  const bad = await importDocument(base, config, { sourceFormat: "kong-declarative-3.0" });
  expect(bad.status).toBe(422);
  expect(bad.body.errors.map((e: { path: string }) => e.path)).toEqual(expect.arrayContaining(["document.vaults", "document.services.0.client_certificate", "document.plugins.0.config.unknown_nested"]));
  expect(await stateOf(base)).toEqual(before);
  const dry = await importDocument(base, config, { sourceFormat: "kong-declarative-3.0", dryRun: true });
  expect(dry.status).toBe(200);
  expect(dry.body.errors).toEqual(bad.body.errors);
});

test("(c,d) any error writes nothing; REDACTED or omitted secrets preserve every decrypted slot", async () => {
  const base = await fixture();
  const document = await exportDocument(base);
  const originalSecrets = await openedSecrets(base);
  const before = await stateOf(base);
  const bad = structuredClone(document);
  bad.routes[0]!.service = "missing";
  bad.certificates[0]!.key = "invalid-private-key";
  const response = await importDocument(base, bad);
  expect(response.status).toBe(422);
  expect(response.contentType).toContain("application/problem+json");
  expect(contracts.validator("EnvironmentImportFailure")(response.body)).toBe(true);
  expect(response.body.errors.map((e: { path: string }) => e.path)).toEqual(expect.arrayContaining(["document.routes.0.service", "document.certificates.0.key"]));
  expect(await stateOf(base)).toEqual(before);
  const dry = await importDocument(base, document, { dryRun: true });
  expect(dry.body).toEqual({ added: [], modified: [], removed: [], errors: [] });
  expect(await stateOf(base)).toEqual(before);
  document.consumers[0]!.keyAuthCredentials[0]!.key = "REDACTED";
  document.consumers[0]!.basicAuthCredentials[0]!.password = "REDACTED";
  expect((await importDocument(base, document)).status).toBe(200);
  expect(await openedSecrets(base)).toEqual(originalSecrets);
  delete document.consumers[0]!.keyAuthCredentials[0]!.key;
  delete document.consumers[0]!.jwtCredentials.find(j => j.algorithm === "HS256")!.secret;
  delete document.consumers[0]!.basicAuthCredentials[0]!.password;
  delete document.certificates[0]!.key;
  delete (document.plugins.find(p => p.name === "rate-limiting")!.config.redis as Record<string, unknown>).password;
  const omitted = await importDocument(base, document, { mode: "merge" });
  expect(omitted.status, JSON.stringify(omitted.body)).toBe(200);
  expect(await openedSecrets(base)).toEqual(originalSecrets);
});

test("rejects malformed serialization, unknown Gromesh fields and UTF-8/decoded size limits with an empty 422 report, even in dry-run", async () => {
  const base = await createEnvironment();
  const document = await exportDocument(base);
  const before = await stateOf(base);
  const cases: unknown[] = ["a: 1\na: 2", "---\na: 1\n---\nb: 2", "x: &x [1]\ny: *x", "x: !custom 1", "{\"x\":1,\"x\":2}", "[1,2]", "apiVersion: [", { ...document, foreign: true }, { ...document, services: [{ name: "a", host: "echo", protocol: "http", port: 80, foreign: true }] }, JSON.stringify({ ...document, services: [{ name: "a", host: "é".repeat(3_000_000), protocol: "http", port: 80 }] }), { ...document, services: [{ name: "a", host: "é".repeat(3_000_000), protocol: "http", port: 80 }] }];
  for (const input of cases) {
    const result = await importDocument(base, input, { dryRun: true });
    expect(result.status).toBe(422);
    expect(contracts.validator("EnvironmentImportFailure")(result.body)).toBe(true);
  }
  // The serialized YAML fits, but its decoded JSON string escapes NUL to six bytes per character.
  const expanded = `apiVersion: gromesh/v1\nservices:\n- name: a\n  protocol: http\n  port: 80\n  host: "${"\\0".repeat(900_000)}"\nroutes: []\nconsumers: []\nplugins: []\nupstreams: []\ncertificates: []`;
  const decoded = await importDocument(base, expanded, { dryRun: true });
  expect(decoded.status).toBe(422);
  expect(decoded.body.errors).toEqual([{ path: "document", message: "decoded document exceeds the 5 MiB UTF-8 limit" }]);
  for (const invalid of [{ document, mode: "invalid", dryRun: false }, { document, mode: "merge" }, { document, mode: "merge", dryRun: false, unknown: true }]) {
    const result = await h.api("POST", `${base}/import`, invalid);
    expect(result.status).toBe(422);
    expect(contracts.validator("EnvironmentImportFailure")(result.body)).toBe(true);
  }
  expect(await stateOf(base)).toEqual(before);
});

test("merge retains omitted nested memberships; replace deletes them and references must resolve inside the document", async () => {
  const base = await fixture();
  const document = await exportDocument(base);
  const original = structuredClone(document);
  const consumer = document.consumers[0]!;
  consumer.aclGroups = ["new-group"];
  consumer.keyAuthCredentials = []; consumer.jwtCredentials = []; consumer.basicAuthCredentials = [];
  document.upstreams[0]!.targets = [];
  const merged = await importDocument(base, document, { mode: "merge" });
  expect(merged.status).toBe(200);
  expect(merged.body.removed).toEqual([]);
  const retained = await exportDocument(base);
  expect(retained.consumers[0]!.aclGroups).toEqual(expect.arrayContaining(["partners", "readers", "new-group"]));
  expect(retained.consumers[0]!.keyAuthCredentials).toHaveLength(1);
  expect(retained.upstreams[0]!.targets).toHaveLength(1);
  const replaced = await importDocument(base, document);
  expect(replaced.status).toBe(200);
  const exact = await exportDocument(base);
  expect(exact.consumers[0]!.aclGroups).toEqual(["new-group"]);
  expect(exact.consumers[0]!.keyAuthCredentials).toEqual([]);
  expect(exact.consumers[0]!.jwtCredentials).toEqual([]);
  expect(exact.consumers[0]!.basicAuthCredentials).toEqual([]);
  expect(exact.upstreams[0]!.targets).toEqual([]);
  const referenceOnly = { ...exact, services: [] };
  expect((await importDocument(base, referenceOnly, { dryRun: true, mode: "merge" })).body.errors).toEqual([]);
  const badReplace = await importDocument(base, referenceOnly, { dryRun: true });
  expect(badReplace.body.errors.map((e: { path: string }) => e.path)).toContain("document.routes.0.service");
  const defaults = { ...original, consumers: [], plugins: [], routes: [], upstreams: [], certificates: [] };
  delete defaults.services[0]!.tags;
  delete defaults.services[0]!.retries;
  delete defaults.services[0]!.path;
  expect((await importDocument(base, defaults)).status).toBe(200);
  const normalized = (await exportDocument(base)).services[0]!;
  expect(normalized.path).toBe(null);
  expect(normalized.tags).toEqual([]);
  expect(normalized.retries).toBeUndefined();
});

test("natural-key/id conflicts and hint-only new credentials are 422, without any writes", async () => {
  const base = await fixture();
  const second = await h.api("POST", `${base}/consumers`, { username: "other", customId: "other-custom" });
  await h.api("POST", `${base}/consumers/${second.body.id}/key-auth`, { key: "second-key-auth-123456" });
  await h.api("POST", `${base}/certificates`, { cert: cert.cert, key: cert.key, snis: [OTHER_SNI] });
  const document = await exportDocument(base);
  const before = await stateOf(base);
  const originalCertificate = document.certificates.find(c => c.snis.includes(ALIAS))!;
  const otherCertificate = document.certificates.find(c => c.snis.includes(OTHER_SNI))!;
  const partner = document.consumers.find(c => c.username === "partner")!;
  const other = document.consumers.find(c => c.username === "other")!;
  const cases: [string, (d: ConfigDocument) => void][] = [
    ["document.consumers.0", d => { d.consumers = [{ ...partner, customId: "other-custom" }]; }],
    ["document.consumers.0.keyAuthCredentials.0", d => { d.consumers = [{ ...partner, keyAuthCredentials: [{ id: other.keyAuthCredentials[0]!.id, key: secrets.key }] }]; }],
    ["document.consumers.0.keyAuthCredentials.0.key", d => { d.consumers = [{ ...partner, keyAuthCredentials: [{ keyHint: partner.keyAuthCredentials[0]!.keyHint }] }]; }],
    ["document.certificates.0", d => { d.certificates = [{ ...originalCertificate, id: otherCertificate.id }]; }],
    ["document.certificates.0.snis.0", d => { d.certificates = [{ ...originalCertificate, snis: [OTHER_SNI, ALIAS] }]; }],
  ];
  for (const [path, mutate] of cases) {
    const bad = structuredClone(document); mutate(bad);
    const response = await importDocument(base, bad, { mode: "merge" });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.errors.map((e: { path: string }) => e.path), JSON.stringify(response.body)).toContain(path);
    expect(await stateOf(base)).toEqual(before);
  }
});

test("reuses JWT key types, ACL/hash rules, certificate expiry/matching and plugin catalog/Kong validation", async () => {
  const base = await fixture();
  const document = await exportDocument(base);
  const before = await stateOf(base);
  const rsaIndex = document.consumers[0]!.jwtCredentials.findIndex(j => j.algorithm === "RS256");
  const wrongEc = generateKeyPairSync("ec", { namedCurve: "secp384r1" }).publicKey.export({ type: "spki", format: "pem" }).toString();
  const expiredCert = expired("expired.import.test");
  const cases: [string, (d: ConfigDocument) => void][] = [
    [`document.consumers.0.jwtCredentials.${rsaIndex}.rsaPublicKey`, d => { d.consumers[0]!.jwtCredentials.find(j => j.algorithm === "RS256")!.rsaPublicKey = wrongEc; }],
    ["document.consumers.0.aclGroups.0", d => { d.consumers[0]!.aclGroups = ["invalid group"]; }],
    ["document.upstreams.0.hashOnHeader", d => { delete d.upstreams[0]!.hashOnHeader; }],
    ["document.certificates.0.cert", d => { d.certificates = [{ cert: expiredCert.cert, key: expiredCert.key, snis: ["expired.import.test"] }]; }],
    ["document.certificates.0.key", d => { d.certificates[0]!.key = expiredCert.key; }],
    ["document.plugins.0.config.minute", d => { d.plugins = [{ name: "rate-limiting", config: { minute: "invalid" } }]; }],
    ["document.plugins.0.config.redis.unknown", d => { d.plugins = [{ name: "rate-limiting", config: { minute: 10, redis: { unknown: 1 } } }]; }],
    ["document.plugins.0.name", d => { d.plugins = [{ name: "oauth2", config: {} }]; }],
    ["document.plugins.0.config.redis.password", d => { d.plugins = [{ name: "rate-limiting", config: { minute: 10, redis: { password: "REDACTED" } } }]; }],
  ];
  for (const [path, mutate] of cases) {
    const bad = structuredClone(document); mutate(bad);
    const response = await importDocument(base, bad);
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.errors.map((e: { path: string }) => e.path), JSON.stringify(response.body)).toContain(path);
    expect(await stateOf(base)).toEqual(before);
  }
});

test("Kong merge resolves existing natural references, supports nested additions and requires ids for prehashed basic-auth", async () => {
  const base = await fixture();
  const before = await stateOf(base);
  // A key that cannot occur by chance: "abc" (hex) showed up inside the export's random UUIDs and PEMs (~4% of runs).
  const key = uniq("merge-key");
  const source = { _format_version: "3.0", routes: [{ name: "second", service: { name: "backend" }, paths: ["/second"] }], plugins: [{ name: "key-auth", route: "second", config: {} }], keyauth_credentials: [{ consumer: { username: "partner" }, key }], targets: [{ upstream: "pool.test", target: "echo-2:80" }] };
  const dry = await importDocument(base, source, { mode: "merge", dryRun: true, sourceFormat: "kong-declarative-3.0" });
  expect(dry.status, JSON.stringify(dry.body)).toBe(200);
  expect(dry.body.errors).toEqual([]);
  expect(await stateOf(base)).toEqual(before);
  const imported = await importDocument(base, source, { mode: "merge", sourceFormat: "kong-declarative-3.0" });
  expect(imported.status, JSON.stringify(imported.body)).toBe(200);
  const doc = await exportDocument(base);
  expect(JSON.stringify(doc)).not.toContain(key);
  expect(doc.consumers[0]!.keyAuthCredentials).toHaveLength(2);
  expect(doc.consumers[0]!.keyAuthCredentials.some(k => k.keyHint === `…${key.slice(-4)}`)).toBe(true);
  expect(doc.upstreams[0]!.targets).toHaveLength(2);
  expect(doc.routes).toHaveLength(2);
  const baseAfter = await stateOf(base);
  const prehashed = await importDocument(base, { _format_version: "3.0", _transform: false, consumers: [{ username: "partner", basicauth_credentials: [{ username: "hashed", password: "a".repeat(40) }] }] }, { sourceFormat: "kong-declarative-3.0", mode: "merge" });
  expect(prehashed.status).toBe(422);
  expect(prehashed.body.errors).toContainEqual(expect.objectContaining({ path: "document.consumers.0.basicauth_credentials.0.password" }));
  expect(await stateOf(base)).toEqual(baseAfter);
});

test("rejects duplicate keys in raw JSON envelopes and accepts standard JSON media-type variations", async () => {
  const base = await fixture();
  const before = await stateOf(base);
  for (const contentType of ["Application/JSON", "application/json ; charset=utf-8"]) {
    const response = await h.api("POST", `${base}/import`, { document: await exportDocument(base), mode: "merge", dryRun: true }, { "content-type": contentType });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  }
  const session = await h.login(h.admin.email, h.admin.password);
  const csrf = await session.api("GET", "/auth/csrf");
  const document = JSON.stringify(await exportDocument(base));
  const duplicate = document.replace('"services":', '"services":[],"services":');
  for (const raw of [`{"document":${duplicate},"mode":"replace","dryRun":false}`, `{"document":${document},"mode":"merge","mode":"replace","dryRun":false}`, '{"document":']) {
    for (const suffix of ["import", "import/", "IMPORT/"]) {
    const response = await fetch(`${await h.app.getUrl()}/api/v1${base}/${suffix}`, { method: "POST", headers: { cookie: session.cookie!, "x-csrf-token": csrf.body.csrfToken, "content-type": "application/json" }, body: raw });
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(contracts.validator("EnvironmentImportFailure")(body)).toBe(true);
    }
  }
  expect(await stateOf(base)).toEqual(before);
});

test("an import can repair a current draft that cannot compile", async () => {
  const base = await createEnvironment();
  expect((await h.api("POST", `${base}/services`, { name: "repair", protocol: "http", host: "", port: 80 })).status).toBe(201);
  const document = await exportDocument(base);
  document.services[0]!.host = "echo";
  const imported = await importDocument(base, document);
  expect(imported.status, JSON.stringify(imported.body)).toBe(200);
  expect(imported.body.errors).toEqual([]);
  expect(imported.body.modified).toHaveLength(1);
});

test("concurrent merge imports serialize without losing committed draft changes", async () => {
  const base = await createEnvironment();
  const empty = await exportDocument(base);
  const results = await Promise.all(["one", "two", "three"].map(name => importDocument(base, { ...empty, services: [{ name, protocol: "http", host: "echo", port: 80 }] }, { mode: "merge" })));
  expect(results.map(r => r.status), JSON.stringify(results.map(r => r.body))).toEqual([200, 200, 200]);
  expect((await exportDocument(base)).services.map(s => s.name).sort()).toEqual(["one", "three", "two"]);
});


test("the object byte limit measures submitted content before write-schema defaults are applied", () => {
  const document = { apiVersion: "gromesh/v1", services: [{ name: "boundary", protocol: "http", host: "", port: 80 }], routes: [], consumers: [], plugins: [], upstreams: [], certificates: [] };
  document.services[0]!.host = "x".repeat(5_242_880 - Buffer.byteLength(JSON.stringify(document)));
  expect(Buffer.byteLength(JSON.stringify(document))).toBe(5_242_880);
  expect(() => new ImportBodyPipe().transform({ document, mode: "merge", dryRun: true })).not.toThrow();
});


test("checks raw import YAML only after auth, CSRF and RBAC, with a 6 MiB envelope ceiling", async () => {
  const base = await createEnvironment();
  const document = await exportDocument(base);
  const viewer = await h.as("viewer");
  const session = await h.login(h.admin.email, h.admin.password);
  const check = vi.mocked(yaml.parseAllDocuments);
  check.mockClear();
  try {
    const anonymous = await h.anonymous("POST", `${base}/import`, { document: "x".repeat(5_000_000), mode: "merge", dryRun: true });
    expect(anonymous.status).toBe(401);
    expect(check.mock.calls.length).toBe(0);
    const deniedCsrf = await h.anonymous("POST", `${base}/import`, { document, mode: "merge", dryRun: true }, { cookie: session.cookie! });
    expect(deniedCsrf.status).toBe(403);
    const deniedRole = await viewer.api("POST", `${base}/import`, { document, mode: "merge", dryRun: true });
    expect(deniedRole.status).toBe(403);
    expect(check.mock.calls.length).toBe(0);
    const allowed = await importDocument(base, document, { dryRun: true });
    expect(allowed.status).toBe(200);
    expect(check.mock.calls.length).toBe(1);
    check.mockClear();
    const oversized = await importDocument(base, "x".repeat(6 * 1024 * 1024), { dryRun: true });
    expect(oversized.status).toBe(422);
    expect(oversized.contentType).toContain("application/problem+json");
    expect(oversized.body.errors).toEqual([{ path: "document", message: "invalid JSON envelope or document size limit exceeded" }]);
    expect(contracts.validator("EnvironmentImportFailure")(oversized.body)).toBe(true);
    expect(check.mock.calls.length).toBe(0);
  } finally { check.mockClear(); }
});

test("unchanged real imports audit without changing the draft or blocking later auto publication", async () => {
  const base = await createEnvironment("auto");
  expect((await h.api("POST", `${base}/services`, { name: "unchanged", protocol: "http", host: "echo", port: 80 })).status).toBe(201);
  await published(base);
  const document = await exportDocument(base);
  for (const mode of ["merge", "replace"]) {
    const before = await stateOf(base);
    expect(before.env.has_unpublished_changes).toBe(false);
    expect(before.env.draft_requires_publish).toBe(false);
    const imported = await importDocument(base, document, { mode });
    expect(imported.status, JSON.stringify(imported.body)).toBe(200);
    expect(imported.body).toEqual({ added: [], modified: [], removed: [], errors: [] });
    const after = await stateOf(base);
    expect(after.env).toEqual(before.env);
    expect(after.counts).toEqual({ ...before.counts, audit_events: before.counts.audit_events! + 1 });
  }
  expect((await h.api("POST", `${base}/services`, { name: "ordinary-edit", protocol: "http", host: "echo", port: 80 })).status).toBe(201);
  await h.app.get(SnapshotsService).autoPublish(base.split("/").at(-1)!, 0);
  const afterEdit = await stateOf(base);
  expect(afterEdit.env.current_version).toBe(2);
  expect(afterEdit.env.has_unpublished_changes).toBe(false);
  expect(afterEdit.env.draft_requires_publish).toBe(false);
});

test("autoPublishPausedReason is import while an imported draft waits in auto mode, and null after an explicit publish or in manual mode", async () => {
  const auto = await createEnvironment("auto");
  const source = await createEnvironment("manual");
  expect((await h.api("POST", `${source}/services`, { name: "paused", protocol: "http", host: "echo", port: 80 })).status).toBe(201);
  const document = await exportDocument(source);
  const env = async (base: string) => (await h.api("GET", base)).body as { autoPublishPausedReason: string | null; hasUnpublishedChanges: boolean };
  expect((await env(auto)).autoPublishPausedReason).toBeNull();

  expect((await importDocument(auto, document, { mode: "replace" })).status).toBe(200);
  expect(await env(auto)).toMatchObject({ autoPublishPausedReason: "import", hasUnpublishedChanges: true });
  // The list carries it too, and auto-publication leaves the imported draft alone.
  const listed = (await h.api("GET", "/environments")).body.items.find((e: { id: string }) => auto.endsWith(e.id));
  expect(listed.autoPublishPausedReason).toBe("import");
  await h.app.get(SnapshotsService).autoPublish(auto.split("/").at(-1)!, 0);
  expect((await env(auto)).autoPublishPausedReason).toBe("import");

  expect((await h.api("POST", `${auto}/snapshots`, {})).status).toBe(201);
  expect((await env(auto)).autoPublishPausedReason).toBeNull();

  // Manual mode never auto-publishes: nothing to pause.
  const manual = await createEnvironment("manual");
  expect((await importDocument(manual, document, { mode: "replace" })).status).toBe(200);
  expect((await env(manual)).autoPublishPausedReason).toBeNull();
});
