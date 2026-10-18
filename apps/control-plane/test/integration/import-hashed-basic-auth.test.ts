import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { EntityChange, KongDeclarativeConfig } from "@gromesh/compiler";
import { basicAuthHashContext, ENCRYPTOR, Encryptor } from "../../src/crypto/crypto.js";
import { startHarness, uniq, type Harness } from "./harness.js";

let h: Harness;
beforeAll(async () => { h = await startHarness({ autoPublishPollMs: 0 }); });
afterAll(async () => { await h?.close(); });

interface Report { added: EntityChange[]; modified: EntityChange[]; removed: EntityChange[]; errors: { path: string; message: string }[] }
const password = "original-import-password";
const hash = (id: string, value = password) => createHash("sha1").update(value + id).digest("hex");
const source = (id: string | undefined, suppliedHash = id ? hash(id) : "a".repeat(40)) => ({
  _format_version: "3.0", _transform: false,
  consumers: [{ id, username: "imported", basicauth_credentials: [{ username: "login", password: suppliedHash }] }],
});
async function environment() {
  const result = await h.api<{ id: string }>("POST", "/environments", { name: uniq("hashed-import") });
  expect(result.status).toBe(201);
  return result.body.id;
}
const imported = (envId: string, document: unknown, mode = "merge", dryRun = false) => h.api<Report>("POST", `/environments/${envId}/import`, { sourceFormat: "kong-declarative-3.0", document, mode, dryRun });
async function state(envId: string) {
  const counts: Record<string, number> = {};
  for (const table of ["consumers", "basicauth_credentials", "services", "routes", "plugins", "snapshots", "audit_events"]) {
    counts[table] = Number((await h.sql.query(`select count(*) from ${table} where environment_id=$1`, [envId])).rows[0].count);
  }
  return { counts, environment: (await h.sql.query("select * from environments where id=$1", [envId])).rows[0] };
}
async function stored(envId: string) {
  const { rows } = await h.sql.query<{ id: string; consumer_id: string; password_hash: string }>("select id, consumer_id, password_hash from basicauth_credentials where environment_id=$1 order by username", [envId]);
  return rows.map(row => {
    expect(row.password_hash).toMatch(/^enc:v2:/);
    return { ...row, opened: h.app.get<Encryptor>(ENCRYPTOR).open(row.password_hash, basicAuthHashContext(row.id)) };
  });
}

test("previews an exact source UUID without reserving it, then stores the unchanged sealed hash and serves it only to the agent", async () => {
  const envId = await environment();
  const id = randomUUID();
  const suppliedHash = hash(id);
  const document = {
    _format_version: "3.0", _transform: false,
    consumers: [{ id, username: "imported" }, { id: randomUUID(), username: "ordinary" }],
    basicauth_credentials: [{ consumer: { id }, username: "login", password: suppliedHash }],
  };
  const before = await state(envId);
  const preview = await imported(envId, document, "replace", true);
  expect(preview.status).toBe(200);
  expect(preview.body.errors).toEqual([]);
  expect(preview.body.added).toContainEqual(expect.objectContaining({ kind: "consumers", id }));
  expect(await state(envId)).toEqual(before);
  const result = await imported(envId, document, "replace");
  expect(result.status).toBe(200);
  expect(result.body.errors).toEqual([]);
  expect(result.body.added).toContainEqual(expect.objectContaining({ kind: "basicauth_credentials", after: expect.objectContaining({ password: "REDACTED" }) }));
  const rows = await stored(envId);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ consumer_id: id, opened: suppliedHash });
  expect(() => h.app.get<Encryptor>(ENCRYPTOR).open(rows[0]!.password_hash, basicAuthHashContext(randomUUID()))).toThrow();
  const consumers = await h.api<{ items: { id: string; username: string }[] }>("GET", `/environments/${envId}/consumers`);
  expect(consumers.body.items.find(c => c.username === "ordinary")!.id).not.toBe(document.consumers[1]!.id);
  const published = await h.api<{ version: number }>("POST", `/environments/${envId}/snapshots`, {});
  expect(published.status).toBe(201);
  const readable: unknown[] = [preview.body, result.body];
  for (const path of ["export?format=json", `consumers/${id}/basic-auth`, "publish-preview", `snapshots/${published.body.version}`]) {
    readable.push((await h.api("GET", `/environments/${envId}/${path}`)).body);
  }
  readable.push((await h.api("GET", `/audit-events?environmentId=${envId}&limit=200`)).body);
  const audit = await h.sql.query("select before, after from audit_events where environment_id=$1", [envId]);
  readable.push(audit.rows);
  for (const secret of [password, suppliedHash]) expect(JSON.stringify(readable)).not.toContain(secret);

  const cluster = await h.api<{ registrationToken: string }>("POST", `/environments/${envId}/clusters`, { name: uniq("hash-agent") });
  const base = `${await h.app.getUrl()}/agent/v1`;
  const registration = await fetch(`${base}/register`, {
    method: "POST", headers: { authorization: `Bearer ${cluster.body.registrationToken}`, "content-type": "application/json" },
    body: JSON.stringify({ nodeId: uniq("node"), hostname: "test", kongVersion: "3.9.4", agentVersion: "0.1.0" }),
  });
  expect(registration.status).toBe(200);
  const { nodeToken } = await registration.json() as { nodeToken: string };
  const snapshot = await fetch(`${base}/snapshots/current`, { headers: { authorization: `Bearer ${nodeToken}` } });
  expect(snapshot.status).toBe(200);
  const { config } = await snapshot.json() as { config: KongDeclarativeConfig };
  expect(config._transform).toBe(false);
  expect(config.basicauth_credentials).toContainEqual(expect.objectContaining({ consumer: id, password: suppliedHash }));
});

test("matches the target UUID before natural identifiers in merge and replace, and preserves omitted or REDACTED matched hashes", async () => {
  for (const mode of ["merge", "replace"]) {
    const envId = await environment();
    const consumer = await h.api<{ id: string }>("POST", `/environments/${envId}/consumers`, { username: "before", customId: "stable-custom" });
    const id = consumer.body.id;
    const document = source(id);
    expect((await imported(envId, document, mode)).status).toBe(200);
    const first = (await stored(envId))[0]!;
    expect(first.consumer_id).toBe(id);
    expect(first.opened).toBe(hash(id));
    const renamed = await h.api<{ username: string }>("GET", `/environments/${envId}/consumers/${id}`);
    expect(renamed.body.username).toBe("imported");
    for (const marker of ["REDACTED", undefined]) {
      const preserved = { ...document, consumers: [{ ...document.consumers[0], basicauth_credentials: [{ username: "login", password: marker }] }] };
      const result = await imported(envId, preserved, mode);
      expect(result.status).toBe(200);
      expect((await stored(envId))[0]).toMatchObject({ id: first.id, opened: first.opened });
    }
  }
});

test("rejects missing or invalid source UUIDs and malformed hashes at original password paths without writing or echoing secrets", async () => {
  const envId = await environment();
  const before = await state(envId);
  for (const document of [source(undefined), source("invalid"), source(randomUUID(), "A".repeat(40)), source(randomUUID(), "too-short"), source(randomUUID(), "REDACTED"), source("AAAAAAAA-0000-4000-8000-000000000016")]) {
    const result = await imported(envId, document);
    expect(result.status).toBe(422);
    expect(result.body.errors).toContainEqual(expect.objectContaining({ path: "document.consumers.0.basicauth_credentials.0.password" }));
    for (const error of result.body.errors.filter(e => e.path.endsWith(".password") && document.consumers[0]?.id !== undefined && document.consumers[0].basicauth_credentials[0]!.password !== "REDACTED")) expect(error.message).toContain("salted");
    expect(await state(envId)).toEqual(before);
    const submitted = document.consumers[0]!.basicauth_credentials[0]!.password;
    if (submitted !== "REDACTED") expect(JSON.stringify(result.body)).not.toContain(submitted);
    const dry = await imported(envId, document, "merge", true);
    expect(dry.status).toBe(200);
    expect(dry.body).toEqual({ added: [], modified: [], removed: [], errors: result.body.errors });
    expect(await state(envId)).toEqual(before);
  }
  const invalid = await imported(envId, source("invalid"));
  expect(invalid.body.errors).toContainEqual(expect.objectContaining({ path: "document.consumers.0.id" }));
});

test("rejects globally used UUIDs without disclosure, preserving row counts and draft state in both environments", async () => {
  const owner = await environment();
  const envId = await environment();
  const consumer = await h.api<{ id: string }>("POST", `/environments/${owner}/consumers`, { username: uniq("private-owner") });
  const document = source(consumer.body.id);
  for (const mode of ["merge", "replace"]) {
    const before = await state(envId), ownerBefore = await state(owner);
    const result = await imported(envId, document, mode);
    expect(result.status).toBe(422);
    expect(result.body.errors).toContainEqual(expect.objectContaining({ path: "document.consumers.0.id" }));
    expect(result.body.errors).toContainEqual(expect.objectContaining({ path: "document.consumers.0.basicauth_credentials.0.password", message: expect.stringContaining("salted") }));
    expect(JSON.stringify(result.body)).not.toContain(owner);
    expect(JSON.stringify(result.body)).not.toContain(hash(consumer.body.id));
    expect(await state(envId)).toEqual(before);
    expect(await state(owner)).toEqual(ownerBefore);
    const dry = await imported(envId, document, mode, true);
    expect(dry.status).toBe(200);
    expect(dry.body.errors).toEqual(result.body.errors);
  }
});

test("never falls back to a natural match with another id, even when replace would delete it", async () => {
  const envId = await environment();
  const existing = await h.api<{ id: string }>("POST", `/environments/${envId}/consumers`, { username: "imported", customId: "taken" });
  const other = await h.api<{ id: string }>("POST", `/environments/${envId}/consumers`, { username: "other" });
  const before = await state(envId);
  for (const mode of ["merge", "replace"]) for (const id of [randomUUID(), other.body.id]) {
    const document = source(id);
    const result = await imported(envId, document, mode);
    expect(result.status).toBe(422);
    expect(result.body.errors).toContainEqual(expect.objectContaining({ path: "document.consumers.0.username" }));
    expect(result.body.errors).toContainEqual(expect.objectContaining({ path: "document.consumers.0.basicauth_credentials.0.password", message: expect.stringContaining("salted") }));
    const customIdConflict = { ...document, consumers: [{ ...document.consumers[0], username: "new-name", custom_id: "taken" }] };
    const custom = await imported(envId, customIdConflict, mode);
    expect(custom.status).toBe(422);
    expect(custom.body.errors).toContainEqual(expect.objectContaining({ path: "document.consumers.0.custom_id" }));
    expect(await state(envId)).toEqual(before);
  }
  expect(existing.body.id).not.toBe(other.body.id);
});

test("keeps absent/true transform passwords as plaintext and generates consumer ids, including 40 hex passwords", async () => {
  for (const transform of [undefined, true]) {
    const envId = await environment();
    const requested = randomUUID();
    const suppliedPassword = "b".repeat(40);
    const document = { ...source(requested, suppliedPassword), _transform: transform };
    const result = await imported(envId, document);
    expect(result.status).toBe(200);
    const row = (await stored(envId))[0]!;
    expect(row.consumer_id).not.toBe(requested);
    expect(row.opened).toBe(hash(row.consumer_id, suppliedPassword));
    expect(row.opened).not.toBe(suppliedPassword);
  }
});

test("concurrent imports cannot claim the same globally free UUID in different environments", async () => {
  const ids = await Promise.all([environment(), environment()]);
  const id = randomUUID();
  const results = await Promise.all(ids.map(envId => imported(envId, source(id))));
  expect(results.map(r => r.status).sort()).toEqual([200, 422]);
  const rejected = results.find(r => r.status === 422)!;
  expect(rejected.body.errors).toContainEqual(expect.objectContaining({ path: "document.consumers.0.id" }));
  const loser = ids[results.findIndex(r => r.status === 422)]!;
  expect((await state(loser)).counts).toEqual({ consumers: 0, basicauth_credentials: 0, services: 0, routes: 0, plugins: 0, snapshots: 0, audit_events: 1 });
});

test("rechecks a UUID after a successful dry-run if another environment claimed it meanwhile", async () => {
  const previewed = await environment(), owner = await environment();
  const id = randomUUID();
  const document = source(id);
  const before = await state(previewed);
  const dry = await imported(previewed, document, "merge", true);
  expect(dry.status).toBe(200);
  expect(dry.body.errors).toEqual([]);
  expect((await imported(owner, document)).status).toBe(200);
  const result = await imported(previewed, document);
  expect(result.status).toBe(422);
  expect(result.body.errors).toContainEqual(expect.objectContaining({ path: "document.consumers.0.id" }));
  expect(await state(previewed)).toEqual(before);
});
