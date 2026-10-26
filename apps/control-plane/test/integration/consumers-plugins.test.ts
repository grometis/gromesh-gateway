import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { kongFieldErrors } from "../../src/plugins/kong-validator.js";
import { KONG_VALIDATOR_URL, startHarness, uniq, type Harness } from "./harness.js";

let h: Harness;
beforeAll(async () => {
  const kong = await fetch(`${KONG_VALIDATOR_URL}/status`).catch(() => null);
  if (!kong?.ok) throw new Error(`These tests validate plugins against a real Kong at ${KONG_VALIDATOR_URL}: run \`pnpm dev:up\` (validator on 127.0.0.1:8011) or set KONG_VALIDATOR_URL`);
  h = await startHarness();
});
afterAll(async () => {
  await h?.close();
});

async function newEnv() {
  const res = await h.api("POST", "/environments", { name: uniq("env") });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function create(path: string, body: unknown) {
  const res = await h.api("POST", path, body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

/** The current snapshot as the agent protocol serves it: the only read that carries secrets in clear. */
async function agentConfig(envId: string) {
  const cluster = await create(`/environments/${envId}/clusters`, { name: uniq("edge") });
  const base = `${await h.app.getUrl()}/agent/v1`;
  const registered = await fetch(`${base}/register`, {
    method: "POST",
    headers: { authorization: `Bearer ${cluster.registrationToken}`, "content-type": "application/json" },
    body: JSON.stringify({ nodeId: uniq("node"), hostname: "host", kongVersion: "3.9.4", agentVersion: "0.1.0" }),
  });
  const { nodeToken } = (await registered.json()) as { nodeToken: string };
  const res = await fetch(`${base}/snapshots/current`, { headers: { authorization: `Bearer ${nodeToken}` } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { config: { plugins: { id: string; config: Record<string, any> }[]; keyauth_credentials: { key: string }[] } }).config;
}

/** env + service + route + consumer. */
async function fixture() {
  const envId = await newEnv();
  const svc = await create(`/environments/${envId}/services`, { name: uniq("svc"), protocol: "http", host: "echo", port: 80 });
  const route = await create(`/environments/${envId}/routes`, { name: uniq("route"), serviceId: svc.id, paths: ["/echo"] });
  const consumer = await create(`/environments/${envId}/consumers`, { username: uniq("alice") });
  return { envId, svc, route, consumer };
}

describe("consumers", () => {
  it("creates, reads, replaces, searches and deletes", async () => {
    const envId = await newEnv();
    const username = uniq("bob");
    const c = await create(`/environments/${envId}/consumers`, { username, tags: ["team-a"] });
    expect(c).toMatchObject({ username, customId: null, tags: ["team-a"] });

    const put = await h.api("PUT", `/environments/${envId}/consumers/${c.id}`, { username, customId: "crm-42" });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ username, customId: "crm-42", tags: [] });

    await create(`/environments/${envId}/consumers`, { customId: uniq("only-custom") });
    const search = await h.api("GET", `/environments/${envId}/consumers?q=crm-4`);
    expect(search.body.items.map((i: { id: string }) => i.id)).toEqual([c.id]);
    const page = await h.api("GET", `/environments/${envId}/consumers?limit=1`);
    expect(page.body.items).toHaveLength(1);
    const next = await h.api("GET", `/environments/${envId}/consumers?limit=1&cursor=${page.body.nextCursor}`);
    expect(next.body.items).toHaveLength(1);
    expect(next.body.items[0].id).not.toBe(page.body.items[0].id);

    expect((await h.api("DELETE", `/environments/${envId}/consumers/${c.id}`)).status).toBe(204);
    expect((await h.api("GET", `/environments/${envId}/consumers/${c.id}`)).status).toBe(404);
  });

  it("requires username or customId and keeps them unique", async () => {
    const envId = await newEnv();
    const empty = await h.api("POST", `/environments/${envId}/consumers`, { tags: [] });
    expect(empty.status).toBe(422);
    expect(empty.body.errors).toEqual([expect.objectContaining({ path: "(body)" })]);

    const username = uniq("dup");
    await create(`/environments/${envId}/consumers`, { username });
    expect((await h.api("POST", `/environments/${envId}/consumers`, { username })).status).toBe(409);
  });
});

describe("key-auth credentials", () => {
  it("shows the full key only in the creation response", async () => {
    const { envId, consumer } = await fixture();
    const created = await create(`/environments/${envId}/consumers/${consumer.id}/key-auth`, {});
    expect(created.key).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes, base64url
    expect(created.keyHint).toBe(`…${created.key.slice(-4)}`);

    const list = await h.api("GET", `/environments/${envId}/consumers/${consumer.id}/key-auth`);
    expect(list.body.items).toEqual([{ id: created.id, consumerId: consumer.id, keyHint: created.keyHint, status: "active", tags: [], createdAt: created.createdAt }]);

    const { rows } = await h.sql.query("select action, before, after from audit_events where environment_id = $1", [envId]);
    expect(rows.map((r) => r.action)).toContain("keyauth.create");
    expect(JSON.stringify(rows)).not.toContain(created.key);

    const preview = await h.api("GET", `/environments/${envId}/publish-preview`);
    expect(JSON.stringify(preview.body)).not.toContain(created.key);
    expect(preview.body.changes).toContainEqual(expect.objectContaining({ kind: "keyauth_credentials", change: "added", after: expect.objectContaining({ key: "REDACTED" }) }));
  });

  it("refuses a chosen key, short or not, at key (decision H-14), and writes nothing", async () => {
    const { envId, consumer } = await fixture();
    const path = `/environments/${envId}/consumers/${consumer.id}/key-auth`;
    for (const key of ["too-short", `chosen-${uniq("key")}`]) {
      const res = await h.api("POST", path, { key });
      expect(res.status).toBe(422);
      expect(res.body.errors).toEqual([expect.objectContaining({ path: "key" })]);
    }
    expect((await h.api("GET", path)).body.items).toEqual([]);
  });

  it("deletes a credential, and all of them with their consumer", async () => {
    const { envId, consumer, route } = await fixture();
    const base = `/environments/${envId}/consumers/${consumer.id}`;
    const k1 = await create(`${base}/key-auth`, {});
    await create(`${base}/key-auth`, {});
    await create(`/environments/${envId}/plugins`, { name: "rate-limiting", scope: { consumerId: consumer.id }, config: { minute: 5 } });
    await create(`/environments/${envId}/plugins`, { name: "key-auth", scope: { routeId: route.id }, config: {} });

    expect((await h.api("DELETE", `${base}/key-auth/${k1.id}`)).status).toBe(204);
    expect((await h.api("DELETE", `${base}/key-auth/${k1.id}`)).status).toBe(404);
    expect((await h.api("GET", `${base}/key-auth`)).body.items).toHaveLength(1);

    expect((await h.api("DELETE", base)).status).toBe(204);
    const state = await h.sql.query(
      "select (select count(*) from keyauth_credentials where environment_id = $1)::int as keys, (select count(*) from plugins where environment_id = $1)::int as plugins",
      [envId],
    );
    expect(state.rows[0]).toEqual({ keys: 0, plugins: 1 });
  });
});

describe("plugins", () => {
  it("creates a valid rate-limiting plugin", async () => {
    const { envId, svc } = await fixture();
    const p = await create(`/environments/${envId}/plugins`, { name: "rate-limiting", scope: { serviceId: svc.id }, config: { minute: 5, policy: "local" } });
    expect(p).toMatchObject({ name: "rate-limiting", enabled: true, scope: { serviceId: svc.id, routeId: null, consumerId: null }, config: { minute: 5, policy: "local" } });
    expect((await h.api("GET", `/environments/${envId}/plugins/${p.id}`)).body).toEqual(p);
    expect((await h.api("GET", `/environments/${envId}`)).body.hasUnpublishedChanges).toBe(true);
  });

  it("returns Kong's validation errors as 422 with paths", async () => {
    const { envId } = await fixture();
    const res = await h.api("POST", `/environments/${envId}/plugins`, { name: "rate-limiting", config: { minute: "abc" } });
    expect(res.status).toBe(422);
    expect(res.body.errors).toContainEqual({ path: "config.minute", message: "expected a number" });

    const entity = await h.api("POST", `/environments/${envId}/plugins`, { name: "rate-limiting", config: {} });
    expect(entity.status).toBe(422);
    expect(entity.body.errors[0].path).toBe("(body)");

    // key-auth cannot be scoped to a consumer: Kong's schema says so, the path maps back to our body.
    const f = await fixture();
    const scoped = await h.api("POST", `/environments/${f.envId}/plugins`, { name: "key-auth", scope: { consumerId: f.consumer.id }, config: {} });
    expect(scoped.status).toBe(422);
    expect(scoped.body.errors).toEqual([{ path: "scope.consumerId", message: "value must be null" }]);
  });

  it("refuses a second key-auth on the same route with 409", async () => {
    const { envId, route } = await fixture();
    const body = { name: "key-auth", scope: { routeId: route.id }, config: { key_names: ["apikey"] } };
    await create(`/environments/${envId}/plugins`, body);
    expect((await h.api("POST", `/environments/${envId}/plugins`, body)).status).toBe(409);
    // Same name, different scope is fine; a second global one is not.
    await create(`/environments/${envId}/plugins`, { name: "key-auth", config: {} });
    expect((await h.api("POST", `/environments/${envId}/plugins`, { name: "key-auth", config: {} })).status).toBe(409);
  });

  it("refuses unknown plugins, plugins that need a database and foreign scopes", async () => {
    const { envId } = await fixture();
    const other = await fixture();
    const cases: [unknown, string][] = [
      [{ name: "no-such-plugin", config: {} }, "name"],
      [{ name: "oauth2", config: { scopes: ["a"], mandatory_scope: true, enable_authorization_code: true } }, "name"],
      [{ name: "rate-limiting", scope: { routeId: other.route.id }, config: { minute: 1 } }, "scope.routeId"],
    ];
    for (const [body, path] of cases) {
      const res = await h.api("POST", `/environments/${envId}/plugins`, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(res.body.errors).toEqual([expect.objectContaining({ path })]);
    }
  });

  it("replaces, filters by scope and deletes", async () => {
    const { envId, svc, route } = await fixture();
    const global = await create(`/environments/${envId}/plugins`, { name: "cors", config: {} });
    const onRoute = await create(`/environments/${envId}/plugins`, { name: "rate-limiting", scope: { routeId: route.id }, config: { minute: 5 } });

    const put = await h.api("PUT", `/environments/${envId}/plugins/${onRoute.id}`, {
      name: "rate-limiting",
      enabled: false,
      scope: { routeId: route.id },
      config: { minute: 10 },
    });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ enabled: false, config: { minute: 10 } });
    const bad = await h.api("PUT", `/environments/${envId}/plugins/${onRoute.id}`, { name: "rate-limiting", config: { minute: "x" } });
    expect(bad.status).toBe(422);

    const ids = async (q: string) => (await h.api("GET", `/environments/${envId}/plugins?${q}`)).body.items.map((p: { id: string }) => p.id);
    expect(await ids("global=true")).toEqual([global.id]);
    expect(await ids(`routeId=${route.id}`)).toEqual([onRoute.id]);
    expect(await ids(`serviceId=${svc.id}`)).toEqual([]);

    expect((await h.api("DELETE", `/environments/${envId}/plugins/${global.id}`)).status).toBe(204);
    expect((await h.api("GET", `/environments/${envId}/plugins/${global.id}`)).status).toBe(404);
  });

  it("answers 502 when the validator is unreachable", async () => {
    const offline = await startHarness({ kongValidatorUrl: "http://127.0.0.1:9" });
    try {
      const res = await offline.api("POST", "/environments", { name: uniq("env") });
      const out = await offline.api("POST", `/environments/${res.body.id}/plugins`, { name: "cors", config: {} });
      expect(out.status).toBe(502);
    } finally {
      await offline.close();
    }
  });
});

describe("publishing consumers, credentials and plugins", () => {
  it("compiles them, and a rollback restores them", async () => {
    const { envId, consumer, route } = await fixture();
    await create(`/environments/${envId}/consumers/${consumer.id}/key-auth`, {});
    const plugin = await create(`/environments/${envId}/plugins`, { name: "key-auth", scope: { routeId: route.id }, config: {} });
    const v1 = await create(`/environments/${envId}/snapshots`, {});
    const snap = (await h.api("GET", `/environments/${envId}/snapshots/${v1.version}`)).body;
    expect(snap.config.consumers).toHaveLength(1);
    expect(snap.config.keyauth_credentials).toHaveLength(1);
    expect(snap.config.plugins).toEqual([expect.objectContaining({ id: plugin.id, name: "key-auth", route: route.id })]);

    expect((await h.api("DELETE", `/environments/${envId}/consumers/${consumer.id}`)).status).toBe(204);
    expect((await h.api("DELETE", `/environments/${envId}/plugins/${plugin.id}`)).status).toBe(204);
    await create(`/environments/${envId}/snapshots`, {});

    expect((await h.api("POST", `/environments/${envId}/snapshots/${v1.version}/rollback`)).status).toBe(201);
    expect((await h.api("GET", `/environments/${envId}/plugins/${plugin.id}`)).status).toBe(200);
    expect((await h.api("GET", `/environments/${envId}/consumers/${consumer.id}/key-auth`)).body.items).toHaveLength(1);
  });
});

describe("plugin secrets", () => {
  const redis = (password: string, minute = 5) => ({ minute, policy: "redis", redis: { host: "redis.internal", password } });

  it("are write-only: every read shows REDACTED, which a PUT may send back to keep the stored value", async () => {
    const { envId, svc } = await fixture();
    const password = `redis-${uniq("pw")}`;
    const p = await create(`/environments/${envId}/plugins`, { name: "rate-limiting", scope: { serviceId: svc.id }, config: redis(password) });
    expect(p.config.redis.password).toBe("REDACTED");
    expect(JSON.stringify((await h.api("GET", `/environments/${envId}/plugins/${p.id}`)).body)).not.toContain(password);
    expect(JSON.stringify((await h.api("GET", `/environments/${envId}/plugins?serviceId=${svc.id}`)).body)).not.toContain(password);

    // Editing another field without retyping the secret keeps it: the published snapshot carries the real value.
    const keep = await h.api("PUT", `/environments/${envId}/plugins/${p.id}`, { name: "rate-limiting", scope: { serviceId: svc.id }, config: redis("REDACTED", 6) });
    expect(keep.status, JSON.stringify(keep.body)).toBe(200);
    expect(keep.body.config).toEqual(redis("REDACTED", 6));
    await create(`/environments/${envId}/snapshots`, {});
    expect((await agentConfig(envId)).plugins).toEqual([expect.objectContaining({ id: p.id, config: expect.objectContaining({ minute: 6, redis: { host: "redis.internal", password } }) })]);

    // Typing a new secret replaces it.
    const rotated = `redis-${uniq("pw2")}`;
    expect((await h.api("PUT", `/environments/${envId}/plugins/${p.id}`, { name: "rate-limiting", scope: { serviceId: svc.id }, config: redis(rotated) })).status).toBe(200);
    const { rows } = await h.sql.query("select config from plugins where id = $1", [p.id]);
    expect(rows[0]!.config.redis.password).toMatch(/^enc:v2:k1:/); // sealed at rest; the agent gets it in clear
    expect(JSON.stringify(rows)).not.toContain(rotated);
    await create(`/environments/${envId}/snapshots`, {});
    expect((await agentConfig(envId)).plugins[0]!.config.redis.password).toBe(rotated);

    // Leaving the field out removes the secret, as any other field in a PUT.
    const without = await h.api("PUT", `/environments/${envId}/plugins/${p.id}`, { name: "rate-limiting", scope: { serviceId: svc.id }, config: { minute: 5, policy: "redis", redis: { host: "redis.internal" } } });
    expect(without.status, JSON.stringify(without.body)).toBe(200);
    expect(without.body.config.redis).toEqual({ host: "redis.internal" });
    const gone = await h.api("PUT", `/environments/${envId}/plugins/${p.id}`, { name: "rate-limiting", scope: { serviceId: svc.id }, config: redis("REDACTED") });
    expect(gone.status).toBe(422);
    expect(gone.body.errors).toEqual([{ path: "config.redis.password", message: expect.stringContaining("placeholder") }]);
  });

  it("refuse the placeholder on a new plugin, before asking Kong", async () => {
    const { envId } = await fixture();
    const res = await h.api("POST", `/environments/${envId}/plugins`, { name: "rate-limiting", config: redis("REDACTED") });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual([{ path: "config.redis.password", message: expect.stringContaining("placeholder") }]);
  });

  it("never reach the audit log or diffs", async () => {
    const { envId, svc } = await fixture();
    const password = `redis-${uniq("pw")}`;
    const config = redis(password);
    const p = await create(`/environments/${envId}/plugins`, { name: "rate-limiting", scope: { serviceId: svc.id }, config });

    const put = await h.api("PUT", `/environments/${envId}/plugins/${p.id}`, { name: "rate-limiting", scope: { serviceId: svc.id }, config: { ...config, minute: 6 } });
    expect(put.status).toBe(200);
    const preview = await h.api("GET", `/environments/${envId}/publish-preview`);
    expect(preview.body.changes).toContainEqual(
      expect.objectContaining({ kind: "plugins", after: expect.objectContaining({ config: expect.objectContaining({ redis: expect.objectContaining({ password: "REDACTED" }) }) }) }),
    );
    expect(JSON.stringify(preview.body)).not.toContain(password);

    const v1 = await create(`/environments/${envId}/snapshots`, {});
    expect(JSON.stringify((await h.api("GET", `/environments/${envId}/snapshots/${v1.version}/diff`)).body)).not.toContain(password);
    expect((await h.api("DELETE", `/environments/${envId}/plugins/${p.id}`)).status).toBe(204);

    const { rows } = await h.sql.query("select action, before, after from audit_events where environment_id = $1 and entity_type = 'plugin'", [envId]);
    expect(rows.map((r) => r.action).sort()).toEqual(["plugin.create", "plugin.delete", "plugin.update"]);
    expect(JSON.stringify(rows)).not.toContain(password);
    expect(rows.find((r) => r.action === "plugin.create").after.config.redis).toEqual({ host: "redis.internal", password: "REDACTED" });
  });
});

describe("plugin catalog", () => {
  it("lists the pinned Kong's plugins with display metadata", async () => {
    const res = await h.api("GET", "/plugin-schemas");
    expect(res.status).toBe(200);
    expect(res.body.kongVersion).toMatch(/^3\.9\./);
    expect(res.body.items).toContainEqual({ name: "rate-limiting", category: "traffic-control", source: "bundled", supportedInDbless: true });
    expect(res.body.items).toContainEqual(expect.objectContaining({ name: "oauth2", supportedInDbless: false }));
  });

  it("serves one raw Kong schema, 404 for unknown names", async () => {
    const res = await h.api("GET", "/plugin-schemas/rate-limiting");
    expect(res.status).toBe(200);
    expect(res.body.fields).toEqual(expect.arrayContaining([expect.objectContaining({ config: expect.any(Object) })]));
    expect((await h.api("GET", "/plugin-schemas/..%2F_catalog")).status).toBe(404);
    expect((await h.api("GET", "/plugin-schemas/nope")).status).toBe(404);
  });
});

describe("kongFieldErrors", () => {
  it("flattens nested fields and maps Kong's foreign keys to our scope", () => {
    expect(
      kongFieldErrors({ config: { minute: "expected a number", "@entity": ["x"] }, consumer: "value must be null", "@entity": ["y"] }),
    ).toEqual([
      { path: "config.minute", message: "expected a number" },
      { path: "config", message: "x" },
      { path: "scope.consumerId", message: "value must be null" },
      { path: "(body)", message: "y" },
    ]);
  });
});
