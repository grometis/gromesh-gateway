import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AtRestService, LOCK_KEY } from "../../src/crypto/at-rest.js";
import { Encryptor, parseFingerprintKey, parseKey } from "../../src/crypto/crypto.js";
import { createHash } from "node:crypto";
import { ENCRYPTION_KEYS, startHarness, uniq, type Harness } from "./harness.js";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h?.close();
});

/** Other test files start replicas (which take the re-seal lock) in parallel: wait for our turn. */
async function untilNotSkipped<T extends { skipped: boolean }>(run: () => Promise<T>): Promise<T> {
  for (let i = 0; i < 50; i++) {
    const report = await run();
    if (!report.skipped) return report;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("re-seal lock never became free");
}

/** Every text and json column of every table, as one string: the acceptance scans it for secrets in clear. */
async function dump(server: Harness): Promise<string> {
  const { rows } = await server.sql.query<{ table_name: string; column_name: string }>(
    "select table_name, column_name from information_schema.columns where table_schema = 'public' and data_type in ('text', 'jsonb', 'character varying', 'ARRAY')",
  );
  const parts: string[] = [];
  for (const { table_name, column_name } of rows) {
    const { rows: values } = await server.sql.query(`select "${column_name}"::text as v from "${table_name}"`);
    parts.push(...values.map((r: { v: string | null }) => r.v ?? ""));
  }
  return parts.join("\n");
}

async function agentConfig(server: Harness, envId: string) {
  const cluster = await server.api("POST", `/environments/${envId}/clusters`, { name: uniq("edge") });
  const base = `${await server.app.getUrl()}/agent/v1`;
  const registered = await fetch(`${base}/register`, {
    method: "POST",
    headers: { authorization: `Bearer ${cluster.body.registrationToken}`, "content-type": "application/json" },
    body: JSON.stringify({ nodeId: uniq("node"), hostname: "host", kongVersion: "3.9.4", agentVersion: "0.1.0" }),
  });
  const { nodeToken } = (await registered.json()) as { nodeToken: string };
  const res = await fetch(`${base}/snapshots/current`, { headers: { authorization: `Bearer ${nodeToken}` } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { hash: string; config: { keyauth_credentials: { key: string }[]; plugins: { name: string; config: Record<string, any> }[] } });
}

/** The sealed columns of one environment's rows, as one string (other test files write their own rows meanwhile). */
async function rowsOf(server: Harness, envId: string): Promise<string> {
  const [keys, configs, snaps] = await Promise.all([
    server.sql.query("select key from keyauth_credentials where environment_id = $1", [envId]),
    server.sql.query("select config::text as v from plugins where environment_id = $1", [envId]),
    server.sql.query("select config::text as c, state::text as s from snapshots where environment_id = $1", [envId]),
  ]);
  return [...keys.rows.map((r) => r.key), ...configs.rows.map((r) => r.v), ...snaps.rows.flatMap((r) => [r.c, r.s])].join("\n");
}

/** A consumer with a chosen key and a rate-limiting plugin with a redis password, published. */
async function secrets(server: Harness) {
  const env = await server.api("POST", "/environments", { name: uniq("enc") });
  const envId = env.body.id as string;
  const svc = await server.api("POST", `/environments/${envId}/services`, { name: uniq("svc"), protocol: "http", host: "echo", port: 80 });
  await server.api("POST", `/environments/${envId}/routes`, { name: uniq("route"), serviceId: svc.body.id, paths: ["/echo"] });
  const consumer = await server.api("POST", `/environments/${envId}/consumers`, { username: uniq("alice") });
  const key = `chosen-${uniq("key")}-${"x".repeat(20)}`;
  const credential = await server.api("POST", `/environments/${envId}/consumers/${consumer.body.id}/key-auth`, { key });
  expect(credential.status).toBe(201);
  const password = `redis-${uniq("pw")}`;
  const plugin = await server.api("POST", `/environments/${envId}/plugins`, { name: "rate-limiting", scope: { serviceId: svc.body.id }, config: { minute: 5, policy: "redis", redis: { host: "redis.internal", password } } });
  expect(plugin.status, JSON.stringify(plugin.body)).toBe(201);
  const published = await server.api("POST", `/environments/${envId}/snapshots`, {});
  expect(published.status).toBe(201);
  return { envId, consumerId: consumer.body.id as string, credentialId: credential.body.id as string, key, password, version: published.body.version as number };
}

describe("secrets at rest", () => {
  it("never stores a credential key, a plugin secret or a snapshot in clear, yet serves them to agents", async () => {
    const { envId, consumerId, key, password, version } = await secrets(h);
    const all = await dump(h);
    expect(all).not.toContain(key);
    expect(all).not.toContain(password);
    expect(all).toContain("enc:v1:k1:");
    // The API shows hints and placeholders only.
    expect((await h.api("GET", `/environments/${envId}/consumers/${consumerId}/key-auth`)).body.items[0].keyHint).toBe(`…${key.slice(-4)}`);
    expect(JSON.stringify((await h.api("GET", `/environments/${envId}/snapshots/${version}`)).body)).not.toContain(key);
    expect(JSON.stringify((await h.api("GET", `/environments/${envId}/snapshots/${version}`)).body)).not.toContain(password);
    // The agent gets the real values, opened at serve time.
    const served = await agentConfig(h, envId);
    expect(served.config.keyauth_credentials[0]!.key).toBe(key);
    expect(served.config.plugins[0]!.config.redis.password).toBe(password);
    // Publishing again and rolling back keep working on sealed rows.
    await h.api("PUT", `/environments/${envId}/consumers/${consumerId}`, { username: uniq("alice2") });
    expect((await h.api("POST", `/environments/${envId}/snapshots`, {})).status).toBe(201);
    const rollback = await h.api("POST", `/environments/${envId}/snapshots/${version}/rollback`);
    expect(rollback.status).toBe(201);
    expect((await agentConfig(h, envId)).config.keyauth_credentials[0]!.key).toBe(key);
    expect(await dump(h)).not.toContain(key);
  });

  it("keeps keys unique per environment through a keyed fingerprint, never a plain hash", async () => {
    const { envId, consumerId, key } = await secrets(h);
    expect((await h.api("POST", `/environments/${envId}/consumers/${consumerId}/key-auth`, { key })).status).toBe(409);
    const { rows } = await h.sql.query("select key_hash from keyauth_credentials where consumer_id = $1", [consumerId]);
    expect(rows[0].key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].key_hash).not.toBe(createHash("sha256").update(key).digest("hex"));
    const { rows: indexes } = await h.sql.query("select indexname from pg_indexes where tablename = 'keyauth_credentials'");
    expect(indexes.map((i) => i.indexname)).toContain("keyauth_env_key_hash_uq");
    expect(indexes.map((i) => i.indexname)).not.toContain("keyauth_env_key_uq");
  });

  it("re-seals one replica at a time and never overwrites an edit made meanwhile", async () => {
    const { envId, password } = await secrets(h);
    const plugin = (await h.api("GET", `/environments/${envId}/plugins`)).body.items[0];
    const svcId = plugin.scope.serviceId as string;
    const rotating = await startHarness({ encryption: { writeKey: ENCRYPTION_KEYS.k2, readKeys: [ENCRYPTION_KEYS.k1], fingerprintKey: ENCRYPTION_KEYS.fingerprint } });
    try {
      // Another replica holds the lock: this one skips.
      const holder = await h.sql.connect();
      try {
        await holder.query("select pg_advisory_lock($1)", [LOCK_KEY]);
        expect((await rotating.app.get(AtRestService).rotate()).skipped).toBe(true);
        await holder.query("select pg_advisory_unlock($1)", [LOCK_KEY]);
      } finally {
        holder.release();
      }
      // An edit between the read and the write of a plugin row wins; the re-seal re-reads and seals the new value.
      const edited = `redis-${uniq("edited")}`;
      let interposed = 0;
      const report = await untilNotSkipped(() => rotating.app.get(AtRestService).rotate({
        beforeWrite: async (table, id) => {
          if (table !== "plugins" || id !== plugin.id || interposed++ > 0) return;
          const put = await h.api("PUT", `/environments/${envId}/plugins/${plugin.id}`, { name: "rate-limiting", scope: { serviceId: svcId }, config: { minute: 7, policy: "redis", redis: { host: "redis.internal", password: edited } } });
          expect(put.status, JSON.stringify(put.body)).toBe(200);
        },
      }));
      expect(report.skipped).toBe(false);
      expect(interposed).toBe(2); // first write refused and interposed, second one re-read and succeeded
      const { rows } = await h.sql.query("select config from plugins where id = $1", [plugin.id]);
      expect(rows[0].config.minute).toBe(7);
      expect(rows[0].config.redis.password).toMatch(/^enc:v1:k2:/);
      expect((await h.api("POST", `/environments/${envId}/snapshots`, {})).status).toBe(201);
      const served = await agentConfig(h, envId);
      expect(served.config.plugins[0]!.config.redis.password).toBe(edited);
      expect(served.config.plugins[0]!.config.redis.password).not.toBe(password);
    } finally {
      await rotating.close();
    }
  });

  it("seals rows written in clear before the migration, on the next start", async () => {
    const { envId, consumerId, key, password, version } = await secrets(h);
    // Simulate pre-encryption rows: put the clear values back directly in the database.
    await h.sql.query("update keyauth_credentials set key = $1 where consumer_id = $2", [key, consumerId]);
    await h.sql.query("update plugins set config = jsonb_set(config, '{redis,password}', to_jsonb($1::text)) where environment_id = $2", [password, envId]);
    const enc = Encryptor.fromConfig({ writeKey: ENCRYPTION_KEYS.k1, readKeys: [], fingerprintKey: ENCRYPTION_KEYS.fingerprint });
    const { rows } = await h.sql.query("select config, state from snapshots where environment_id = $1 and version = $2", [envId, version]);
    await h.sql.query("update snapshots set config = $1, state = $2 where environment_id = $3 and version = $4", [
      JSON.stringify(enc.openJson(rows[0].config)), JSON.stringify(enc.openJson(rows[0].state)), envId, version,
    ]);
    // (Not asserted in clear here: any replica starting meanwhile, e.g. another test file's harness, seals it.)
    const restarted = await startHarness(); // createApp runs encryptExisting (unless another replica held the lock)
    try {
      await untilNotSkipped(() => restarted.app.get(AtRestService).encryptExisting());
      const all = await dump(restarted);
      expect(all).not.toContain(key);
      expect(all).not.toContain(password);
      expect((await agentConfig(restarted, envId)).config.keyauth_credentials[0]!.key).toBe(key);
    } finally {
      await restarted.close();
    }
  });

  it("rotates keys without downtime: new write key, old key still readable, everything re-sealed", async () => {
    const { envId, key, password } = await secrets(h);
    // Replicas restarted with the new key as write key and the old one for reading can serve everything.
    const rotating = await startHarness({ encryption: { writeKey: ENCRYPTION_KEYS.k2, readKeys: [ENCRYPTION_KEYS.k1], fingerprintKey: ENCRYPTION_KEYS.fingerprint } });
    try {
      expect((await agentConfig(rotating, envId)).config.plugins[0]!.config.redis.password).toBe(password);
      const report = await untilNotSkipped(() => rotating.app.get(AtRestService).rotate());
      expect(report.credentials).toBeGreaterThan(0);
      expect(report.snapshots).toBeGreaterThan(0);
      const mine = await rowsOf(rotating, envId);
      expect(mine).not.toContain("enc:v1:k1:");
      expect(mine).toContain("enc:v1:k2:");
      expect(mine).not.toContain(key);
      expect(await dump(rotating)).not.toContain(key);
    } finally {
      await rotating.close();
    }
    // Afterwards the old key can be dropped.
    const after = await startHarness({ encryption: { writeKey: ENCRYPTION_KEYS.k2, readKeys: [], fingerprintKey: ENCRYPTION_KEYS.fingerprint } });
    try {
      const served = await agentConfig(after, envId);
      expect(served.config.keyauth_credentials[0]!.key).toBe(key);
      expect(served.config.plugins[0]!.config.redis.password).toBe(password);
      expect((await after.api("GET", `/environments/${envId}/snapshots/1`)).status).toBe(200);
    } finally {
      await after.close();
    }
  });

  it("refuses to start without a key and rejects malformed keys", () => {
    expect(() => parseKey("short:AAAA")).toThrow();
    expect(() => parseKey("no-colon")).toThrow();
    expect(() => new Encryptor("k9", [parseKey(ENCRYPTION_KEYS.k1)], parseFingerprintKey(ENCRYPTION_KEYS.fingerprint))).toThrow(/k9/);
    const enc = Encryptor.fromConfig({ writeKey: ENCRYPTION_KEYS.k1, readKeys: [], fingerprintKey: ENCRYPTION_KEYS.fingerprint });
    const sealed = enc.seal("hello");
    expect(sealed).toMatch(/^enc:v1:k1:/);
    expect(enc.open(sealed)).toBe("hello");
    expect(enc.open("plain")).toBe("plain");
    expect(() => Encryptor.fromConfig({ writeKey: ENCRYPTION_KEYS.k2, readKeys: [], fingerprintKey: ENCRYPTION_KEYS.fingerprint }).open(sealed)).toThrow(/unknown key k1/);
    expect(() => parseFingerprintKey("c2hvcnQ=")).toThrow(/32 bytes/);
  });
});
