import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { EntityChange, KongDeclarativeConfig } from "@gromesh/compiler";
import { basicAuthHashContext, ENCRYPTOR, Encryptor } from "../../src/crypto/crypto.js";
import { DB, type Db } from "../../src/db/db.js";
import { startHarness, uniq, type Harness } from "./harness.js";

let h: Harness;
beforeAll(async () => { h = await startHarness({ autoPublishPollMs: 0 }); });
afterAll(async () => { await h?.close(); });

interface Report { added: EntityChange[]; modified: EntityChange[]; removed: EntityChange[]; errors: { path: string; message: string }[] }
const password = "original-import-password";
const hash = (id: string, value = password) => createHash("sha1").update(value + id).digest("hex");
// A basic-auth username is unique in the instance (decision H-5): each test has its own, so the files sharing the
// database never collide, and two environments importing one document collide only where a test says so.
let LOGIN = "";
beforeEach(() => { LOGIN = uniq("login"); });
const source = (id: string | undefined, suppliedHash = id ? hash(id) : "a".repeat(40), username = LOGIN) => ({
  _format_version: "3.0", _transform: false,
  consumers: [{ id, username: "imported", basicauth_credentials: [{ username, password: suppliedHash }] }],
});
async function environment() {
  const result = await h.api<{ id: string }>("POST", "/environments", { name: uniq("hashed-import") });
  expect(result.status).toBe(201);
  return result.body.id;
}
const imported = (envId: string, document: unknown, mode = "merge", dryRun = false) => h.api<Report>("POST", `/environments/${envId}/import`, { sourceFormat: "kong-declarative-3.0", document, mode, dryRun });
const saltReason = "Kong's hash is salted with the consumer id; a source consumer UUID must be preserved exactly";
const unavailableSalt = "Kong's hash is salted with the consumer id; the source consumer UUID cannot be preserved";
const passwordPath = "document.consumers.0.basicauth_credentials.0.password";
async function expectErrors(envId: string, document: unknown, errors: Report["errors"], mode = "merge") {
  const before = await state(envId);
  const secrets = [password];
  function collect(value: unknown) {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "password" && typeof child === "string" && child !== "REDACTED") secrets.push(child);
      else collect(child);
    }
  }
  collect(document);
  const ordered = (values: Report["errors"]) => [...values].sort((a, b) => a.path.localeCompare(b.path));
  for (const dryRun of [false, true]) {
    const result = await imported(envId, document, mode, dryRun);
    expect(result.status).toBe(dryRun ? 200 : 422);
    expect(ordered(result.body.errors)).toEqual(ordered(errors));
    for (const name of ["added", "modified", "removed"] as const) expect(result.body[name]).toEqual([]);
    for (const secret of secrets) expect(JSON.stringify(result.body)).not.toContain(secret);
    expect(await state(envId)).toEqual(before);
  }
}
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
    basicauth_credentials: [{ consumer: { id }, username: LOGIN, password: suppliedHash }],
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
    LOGIN = uniq("login"); // a new environment per mode, so a username of its own
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
      const preserved = { ...document, consumers: [{ ...document.consumers[0], basicauth_credentials: [{ username: LOGIN, password: marker }] }] };
      const result = await imported(envId, preserved, mode);
      expect(result.status).toBe(200);
      expect((await stored(envId))[0]).toMatchObject({ id: first.id, opened: first.opened });
    }
  }
});

test("rejects missing or invalid source UUIDs and malformed hashes at original password paths without writing or echoing secrets", async () => {
  const envId = await environment();
  await expectErrors(envId, source(undefined), [{ path: passwordPath, message: saltReason }]);
  for (const id of ["invalid", "AAAAAAAA-0000-4000-8000-000000000016", randomUUID().replaceAll("-", ""), randomUUID() + "\n"]) {
    await expectErrors(envId, source(id), [
      { path: passwordPath, message: saltReason },
      { path: "document.consumers.0.id", message: "must be a lowercase canonical UUID" },
    ]);
  }
  for (const suppliedHash of ["A".repeat(40), "g".repeat(40), "a".repeat(39), "a".repeat(40) + "\n", "Q7", "too-short"]) {
    await expectErrors(envId, source(randomUUID(), suppliedHash), [{ path: passwordPath, message: `must be a 40-character lowercase hex hash; ${saltReason}` }]);
  }
  for (const suppliedHash of [23, null, [], { toString: null }]) {
    const document = source(randomUUID());
    await expectErrors(envId, { ...document, consumers: [{ ...document.consumers[0], basicauth_credentials: [{ username: LOGIN, password: suppliedHash }] }] }, [{ path: passwordPath, message: `must be a 40-character lowercase hex hash; ${saltReason}` }]);
  }
  await expectErrors(envId, source(undefined, "invalid-hash"), [{ path: passwordPath, message: saltReason }]);
  await expectErrors(envId, source(randomUUID(), "REDACTED"), [{ path: passwordPath, message: "a real secret is required for a new secret slot" }]);
});

test.each(["nested", "flat"])("repeated source ids report every affected %s password and only the repeated consumer id", async layout => {
  const envId = await environment();
  const id = randomUUID();
  const credentials = ["first-login", "second-login", "third-login"].map(username => ({ username, password: hash(id) }));
  const document = {
    _format_version: "3.0", _transform: false,
    consumers: [
      { id, username: "first", ...(layout === "nested" ? { basicauth_credentials: credentials.slice(0, 2) } : {}) },
      { id, username: "second", ...(layout === "nested" ? { basicauth_credentials: credentials.slice(2) } : {}) },
    ],
    ...(layout === "flat" ? { basicauth_credentials: credentials.map((credential, i) => ({ ...credential, consumer: i < 2 ? { id } : { username: "second" } })) } : {}),
  };
  const paths = layout === "nested" ? [passwordPath, "document.consumers.0.basicauth_credentials.1.password", "document.consumers.1.basicauth_credentials.0.password"] : credentials.map((_credential, i) => `document.basicauth_credentials.${i}.password`);
  for (const mode of ["merge", "replace"]) await expectErrors(envId, document, [
    ...paths.map(path => ({ path, message: saltReason })),
    { path: "document.consumers.1.id", message: "consumer id is repeated in the source document" },
  ], mode);
});

test("a repeated source id is rejected even when the repeated consumer carries no credentials", async () => {
  const envId = await environment();
  const id = randomUUID();
  const document = source(id);
  document.consumers.push({ id, username: "second", basicauth_credentials: [] });
  await expectErrors(envId, document, [
    { path: passwordPath, message: saltReason },
    { path: "document.consumers.1.id", message: "consumer id is repeated in the source document" },
  ]);
});

test("unresolved flat consumer references produce one reference diagnostic and one password diagnostic", async () => {
  const envId = await environment();
  const consumer = await h.api<{ id: string }>("POST", `/environments/${envId}/consumers`, { username: "target-only" });
  for (const id of [randomUUID(), consumer.body.id]) {
    await expectErrors(envId, { _format_version: "3.0", _transform: false, basicauth_credentials: [{ consumer: { id }, username: "flat-login", password: hash(id) }] }, [
      { path: "document.basicauth_credentials.0.consumer", message: "unknown source reference" },
      { path: "document.basicauth_credentials.0.password", message: saltReason },
    ]);
  }
});

test("REDACTED and omitted passwords still require a preserved source id on matched credentials", async () => {
  const envId = await environment();
  const id = `a${randomUUID().slice(1)}`;
  expect((await imported(envId, source(id))).status).toBe(200);
  for (const marker of ["REDACTED", undefined]) {
    for (const sourceId of [undefined, id.toUpperCase()]) {
      const document = { ...source(sourceId), consumers: [{ ...source(sourceId).consumers[0], basicauth_credentials: [{ username: LOGIN, password: marker }] }] };
      await expectErrors(envId, document, [
        { path: passwordPath, message: saltReason },
        ...(sourceId ? [{ path: "document.consumers.0.id", message: "must be a lowercase canonical UUID" }] : []),
      ]);
    }
  }
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
    await expectErrors(envId, document, [
      { path: passwordPath, message: unavailableSalt },
      { path: "document.consumers.0.id", message: "consumer id cannot be preserved because it is already in use" },
    ], mode);
  }
});

test("never falls back to a natural match with another id, even when replace would delete it", async () => {
  const envId = await environment();
  const existing = await h.api<{ id: string }>("POST", `/environments/${envId}/consumers`, { username: "imported", customId: "taken" });
  expect((await h.api("POST", `/environments/${envId}/consumers/${existing.body.id}/basic-auth`, { username: LOGIN, password })).status).toBe(201);
  const other = await h.api<{ id: string }>("POST", `/environments/${envId}/consumers`, { username: "other" });
  const before = await state(envId);
  for (const mode of ["merge", "replace"]) for (const id of [randomUUID(), other.body.id]) {
    const document = source(id);
    await expectErrors(envId, document, [
      { path: passwordPath, message: unavailableSalt },
      { path: "document.consumers.0.username", message: "consumer identifier conflicts with the consumer id to preserve" },
    ], mode);
    const customIdConflict = { ...document, consumers: [{ ...document.consumers[0], username: "new-name", custom_id: "taken" }] };
    await expectErrors(envId, customIdConflict, [
      { path: passwordPath, message: unavailableSalt },
      { path: "document.consumers.0.custom_id", message: "consumer identifier conflicts with the consumer id to preserve" },
    ], mode);
    expect(await state(envId)).toEqual(before);
  }
  expect(existing.body.id).not.toBe(other.body.id);
});

test("keeps absent/true transform passwords as plaintext and generates consumer ids, including 40 hex passwords", async () => {
  for (const transform of [undefined, true]) {
    LOGIN = uniq("login"); // a new environment per variant, so a username of its own
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
  // Force the insert race before allowing real transactions: a missing consumers_pkey retry returns a
  // generic document error, so the exact error-array assertion below must fail without that branch.
  // The import's own (serializable) transaction, not the one of the conflict limit that wraps it.
  const db = h.app.get<Db>(DB);
  const original = db.transaction.bind(db);
  let raced = false;
  const transaction = vi.spyOn(db, "transaction").mockImplementation(((work, config) => {
    if (!raced && config?.isolationLevel === "serializable") {
      raced = true;
      return Promise.reject({ cause: { code: "23505", constraint: "consumers_pkey" } });
    }
    return original(work, config);
  }) as Db["transaction"]);
  try {
    // Each environment its own username: the two imports collide on the consumer UUID only.
    const results = await Promise.all(ids.map(envId => imported(envId, source(id, undefined, uniq("login")))));
    expect(results.map(r => r.status).sort()).toEqual([200, 422]);
    expect(transaction.mock.calls.length).toBeGreaterThanOrEqual(3);
    const rejected = results.find(r => r.status === 422)!;
    expect([...rejected.body.errors].sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: passwordPath, message: unavailableSalt },
      { path: "document.consumers.0.id", message: "consumer id cannot be preserved because it is already in use" },
    ]);
    expect(JSON.stringify(rejected.body)).not.toContain(hash(id));
    const loser = ids[results.findIndex(r => r.status === 422)]!;
    expect((await state(loser)).counts).toEqual({ consumers: 0, basicauth_credentials: 0, services: 0, routes: 0, plugins: 0, snapshots: 0, audit_events: 1 });
  } finally { transaction.mockRestore(); }
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
