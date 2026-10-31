import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DB, type Db } from "../../src/db/db.js";
import { pgCode, CONCURRENCY_ABORTS } from "../../src/common/retry.js";
import { ENCRYPTOR, Encryptor, pluginSecretContext } from "../../src/crypto/crypto.js";
import { startHarness, uniq, type ApiClient, type Harness } from "./harness.js";

const v2 = (api: ApiClient, method: string, ws: string, suffix = "", body?: unknown) => api(method, `/../v2/workspaces/${ws}/plugins${suffix}`, body);
const plugin = (serviceId: string, over: Record<string, unknown> = {}) => ({ name: "cors", scope: { serviceId }, config: {}, ...over });

interface WorkspaceState {
  environment: { name: string; publish_mode: string; current_version: number | null; has_unpublished_changes: boolean };
  workspace: Record<string, unknown>;
  plugins: Record<string, unknown>[];
  audits: { id: string; action: string }[];
  snapshots: Record<string, unknown>[];
  releases: Record<string, unknown>[];
  deployments: Record<string, unknown>[];
}

describe("workspace plugin writes (WS-P1), real PostgreSQL and Kong", () => {
  let h: Harness;
  let a: string;
  let b: string;
  let sa: string;
  let sb: string;
  const aborts: string[] = [];
  let observed: { mockRestore(): void };
  beforeAll(async () => {
    h = await startHarness({ platformHttpLogEndpoint: "http://collector:8080/kong", autoPublishPollMs: 0 });
    const db = h.app.get<Db>(DB);
    const transaction = db.transaction.bind(db);
    // Observe failures of real transactions, including deadlocks hidden by a successful retry.
    observed = vi.spyOn(db, "transaction").mockImplementation(((work, config) =>
      transaction(work, config).catch((error: unknown) => {
        const code = pgCode(error);
        if (code && CONCURRENCY_ABORTS.has(code)) aborts.push(code);
        throw error;
      })) as Db["transaction"]);
    a = (await h.api("POST", "/environments", { name: uniq("plugins-a") })).body.id;
    b = (await h.api("POST", "/environments", { name: uniq("plugins-b") })).body.id;
    const service = async (ws: string) => (await h.api("POST", `/environments/${ws}/services`, { name: uniq("svc"), protocol: "http", host: "echo", port: 80 })).body.id as string;
    sa = await service(a); sb = await service(b);
  });
  afterAll(async () => { observed?.mockRestore(); await h?.close(); });

  it("creates, replaces, lists and deletes only A's draft, audited without snapshots or deployments", async () => {
    const made = await v2(h.api, "POST", a, "", plugin(sa));
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body).toMatchObject({ name: "cors", scope: { serviceId: sa } });
    expect((await v2(h.api, "GET", a, `/${made.body.id}`)).body).toEqual(made.body);
    expect((await v2(h.api, "GET", b, `/${made.body.id}`)).status).toBe(404);
    expect((await v2(h.api, "GET", b)).body.items).toEqual([]);
    expect((await v2(h.api, "PUT", b, `/${made.body.id}`, plugin(sb))).status).toBe(404);
    expect((await v2(h.api, "DELETE", b, `/${made.body.id}`)).status).toBe(404);
    expect((await v2(h.api, "GET", a, `/${made.body.id}`)).body).toEqual(made.body);
    const changed = await v2(h.api, "PUT", a, `/${made.body.id}`, plugin(sa, { enabled: false }));
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body.enabled).toBe(false);
    expect((await v2(h.api, "DELETE", a, `/${made.body.id}`)).status).toBe(204);
    expect((await h.sql.query("select action from audit_events where entity_id = $1 order by at", [made.body.id])).rows.map(r => r.action)).toEqual(["plugin.create", "plugin.update", "plugin.delete"]);
    expect((await h.sql.query("select has_unpublished_changes from environments where id = $1", [a])).rows[0].has_unpublished_changes).toBe(true);
    expect((await h.sql.query("select count(*)::int n from snapshots where environment_id = $1", [a])).rows[0].n).toBe(0);
    expect((await h.sql.query("select count(*)::int n from deployments where members @> jsonb_build_array(jsonb_build_object('workspaceId', $1::text))", [a])).rows[0].n).toBe(0);
  });

  it.each(["v1", "v2"] as const)("replaces a %s-created plugin preserving identity and creation metadata, with PUT defaults", async (api) => {
    const body = plugin(sa, { enabled: false, config: { origins: ["https://old.example"] }, tags: ["old"], protocols: ["http"] });
    const made = api === "v1" ? await h.api("POST", `/environments/${a}/plugins`, body) : await v2(h.api, "POST", a, "", body);
    expect(made.status).toBe(201);
    const changed = await v2(h.api, "PUT", a, `/${made.body.id}`, plugin(sa, { config: { origins: ["https://new.example"] } }));
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body).toMatchObject({ id: made.body.id, createdAt: made.body.createdAt, name: "cors", enabled: true,
      scope: { serviceId: sa, routeId: null, consumerId: null }, config: { origins: ["https://new.example"] }, tags: [], protocols: ["grpc", "grpcs", "http", "https"] });
    expect(Date.parse(changed.body.updatedAt)).toBeGreaterThan(Date.parse(made.body.updatedAt));
    const row = (await h.sql.query("select environment_id from plugins where id = $1", [made.body.id])).rows[0];
    expect(row.environment_id).toBe(a);
    const events = (await h.sql.query("select before, after from audit_events where entity_id = $1 and action = 'plugin.update'", [made.body.id])).rows;
    expect(events).toEqual([{ before: made.body, after: changed.body }]);
    expect((await v2(h.api, "DELETE", a, `/${made.body.id}`)).status).toBe(204);
  });

  it("moves service to route to consumer inside one Workspace, clearing the previous scope", async () => {
    const route = await h.api("POST", `/environments/${a}/routes`, { name: uniq("move"), serviceId: sa, paths: ["/move"] });
    const consumer = await h.api("POST", `/environments/${a}/consumers`, { username: uniq("move") });
    expect([route.status, consumer.status]).toEqual([201, 201]);
    const body = plugin(sa, { name: "rate-limiting", config: { minute: 10, policy: "local" } });
    const made = await v2(h.api, "POST", a, "", body);
    expect(made.status).toBe(201);
    for (const scope of [{ serviceId: null, routeId: route.body.id, consumerId: null }, { serviceId: null, routeId: null, consumerId: consumer.body.id }]) {
      const input = Object.fromEntries(Object.entries(scope).filter(([, value]) => value !== null));
      const changed = await v2(h.api, "PUT", a, `/${made.body.id}`, { ...body, scope: input });
      expect(changed.status, JSON.stringify(changed.body)).toBe(200);
      expect(changed.body).toMatchObject({ id: made.body.id, createdAt: made.body.createdAt, scope });
      expect((await v2(h.api, "GET", a, `/${made.body.id}`)).body).toEqual(changed.body);
    }
    expect((await v2(h.api, "DELETE", a, `/${made.body.id}`)).status).toBe(204);
  });

  it("rejects foreign service, route, consumer and anonymous references on POST and PUT", async () => {
    const route = (await h.api("POST", `/environments/${b}/routes`, { name: uniq("route"), serviceId: sb, paths: ["/b"] })).body.id;
    const consumer = (await h.api("POST", `/environments/${b}/consumers`, { username: uniq("foreign") })).body.id;
    const own = await v2(h.api, "POST", a, "", plugin(sa));
    expect(own.status).toBe(201);
    const before = await state(a);
    const foreignBefore = await state(b);
    for (const [path, body] of [
      ["scope.serviceId", plugin(sb)],
      ["scope.routeId", plugin(sa, { scope: { routeId: route } })],
      ["scope.consumerId", plugin(sa, { scope: { consumerId: consumer } })],
      ["config.anonymous", plugin(sa, { name: "key-auth", config: { anonymous: consumer } })],
    ] as const) {
      for (const method of ["POST", "PUT"]) {
        const res = await v2(h.api, method, a, method === "PUT" ? `/${own.body.id}` : "", body);
        expect(res.status, JSON.stringify(res.body)).toBe(422);
        expect(res.body.errors).toContainEqual(expect.objectContaining({ path }));
        expect(await state(a)).toEqual(before);
        expect(await state(b)).toEqual(foreignBefore);
      }
    }
    await v2(h.api, "DELETE", a, `/${own.body.id}`);
  });

  it("enforces server RBAC and privileged capabilities including replacing/deleting an existing privileged plugin", async () => {
    const editor = await h.as("editor");
    const viewer = await h.as("viewer");
    const workspaceAdmin = await h.as("viewer");
    expect((await h.api("PUT", `/users/${workspaceAdmin.id}/environment-roles`, { items: [{ environmentId: a, role: "admin" }] })).status).toBe(200);
    const body = plugin(sa, { name: "pre-function", config: { access: ["return"] } });
    expect((await v2(viewer.api, "POST", a, "", plugin(sa))).status).toBe(403);
    expect((await v2(editor.api, "POST", a, "", body)).status).toBe(403);
    const made = await v2(h.api, "POST", a, "", body);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const before = await state(a);
    for (const actor of [editor, workspaceAdmin]) {
      for (const replacement of [plugin(sa), { ...body, enabled: false }, { ...body, config: { access: ["return true"] } }]) {
        expect((await v2(actor.api, "PUT", a, `/${made.body.id}`, replacement)).status).toBe(403);
      }
      expect((await v2(actor.api, "DELETE", a, `/${made.body.id}`)).status).toBe(403);
      expect(await state(a)).toEqual(before);
    }
    for (const method of ["PUT", "DELETE"]) {
      expect((await v2(viewer.api, method, a, `/${made.body.id}`, method === "PUT" ? plugin(sa) : undefined)).status).toBe(403);
      expect((await v2(h.anonymous, method, a, `/${made.body.id}`, method === "PUT" ? plugin(sa) : undefined)).status).toBe(401);
    }
    expect(await state(a)).toEqual(before);
    expect((await v2(h.api, "DELETE", a, `/${made.body.id}`)).status).toBe(204);
  });

  it("authorizes ordinary writes from the server's workspace permission and refuses viewers, strangers and anonymous callers", async () => {
    const actor = await h.as("viewer");
    expect((await h.api("PUT", `/users/${actor.id}/environment-roles`, { items: [{ environmentId: a, role: "editor" }, { environmentId: b, role: "none" }] })).status).toBe(200);
    const made = await v2(actor.api, "POST", a, "", plugin(sa));
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const before = await state(a);
    const foreign = await state(b);
    const viewer = await h.as("viewer");
    for (const method of ["POST", "PUT", "DELETE"]) {
      const suffix = method === "POST" ? "" : `/${made.body.id}`;
      const body = method === "DELETE" ? undefined : plugin(sa, { enabled: false });
      expect((await v2(viewer.api, method, a, suffix, body)).status).toBe(403);
      expect((await v2(h.anonymous, method, a, suffix, body)).status).toBe(401);
      expect((await v2(actor.api, method, b, suffix, method === "DELETE" ? undefined : plugin(sb))).status).toBe(404);
    }
    expect(await state(a)).toEqual(before);
    expect(await state(b)).toEqual(foreign);
    const changed = await v2(actor.api, "PUT", a, `/${made.body.id}`, plugin(sa, { enabled: false }));
    expect(changed.status).toBe(200);
    expect(changed.body.enabled).toBe(false);
    expect((await v2(actor.api, "DELETE", a, `/${made.body.id}`)).status).toBe(204);
  });

  it("reserves platform mandatory names and product names in every scope, including legacy rows", async () => {
    for (const name of ["prometheus", "http-log", "gromesh-workspace", "gromesh-route-guard"]) {
      const res = await v2(h.api, "POST", a, "", plugin(sa, { name, config: name === "http-log" ? { http_endpoint: "http://logs:8080" } : {} }));
      expect(res.status, JSON.stringify(res.body)).toBe(422);
    }
    // Old v1 rows cannot be used as a PUT/DELETE path around the v2 reservation.
    for (const name of ["prometheus", "http-log"]) {
      const body = plugin(sa, { name, config: name === "http-log" ? { http_endpoint: "http://logs:8080" } : {} });
      const old = await h.api("POST", `/environments/${a}/plugins`, body);
      expect(old.status).toBe(201);
      const before = await state(a);
      for (const replacement of [plugin(sa), { ...body, enabled: false }]) {
        expect((await v2(h.api, "PUT", a, `/${old.body.id}`, replacement)).status).toBe(422);
      }
      expect((await v2(h.api, "DELETE", a, `/${old.body.id}`)).status).toBe(422);
      expect(await state(a)).toEqual(before);
      expect((await h.api("DELETE", `/environments/${a}/plugins/${old.body.id}`)).status).toBe(204);
    }
    expect((await v2(h.api, "DELETE", a, "/14f9de7e-3701-4c69-b7f7-b8b5622c0101")).status).toBe(404);
  });

  it("validates POST and PUT with pinned fields and real Kong constraints, refusing empty scope without effects", async () => {
    const f = await raceFixture("PUT", false);
    const existing = (await v2(h.api, "GET", f.ws)).body.items[0];
    const consumer = await h.api("POST", `/environments/${f.ws}/consumers`, { username: uniq("kong") });
    expect(consumer.status).toBe(201);
    const before = await state(f.ws);
    for (const [body, path] of [
      [plugin(f.serviceId, { name: "rate-limiting", config: { minute: "wrong" } }), "config.minute"],
      [plugin(f.serviceId, { config: { invented: true } }), "config.invented"],
      [plugin(f.serviceId, { scope: {} }), "scope"],
      [plugin(f.serviceId, { name: "ldap-auth" }), "name"],
      [plugin(f.serviceId, { tags: ["gromesh-platform"] }), "tags.0"],
      [plugin(f.serviceId, { scope: { consumerId: consumer.body.id } }), "scope.consumerId"],
    ] as const) {
      for (const method of ["POST", "PUT"]) {
        const res = await v2(h.api, method, f.ws, method === "POST" ? "" : `/${existing.id}`, body);
        expect(res.status, JSON.stringify(res.body)).toBe(422);
        expect(res.body.errors).toContainEqual(expect.objectContaining({ path }));
        expect(await state(f.ws)).toEqual(before);
      }
    }
  });

  it("allows one effective authenticator and rejects a second mechanism or consumer-scoped authenticator", async () => {
    const route = await h.api("POST", `/environments/${a}/routes`, { name: uniq("auth-route"), serviceId: sa, paths: ["/auth"] });
    expect(route.status).toBe(201);
    const first = await v2(h.api, "POST", a, "", plugin(sa, { name: "key-auth" }));
    expect(first.status).toBe(201);
    const second = await v2(h.api, "POST", a, "", plugin(sa, { name: "basic-auth", scope: { routeId: route.body.id } }));
    expect([second.status, second.body.errors?.[0]?.path]).toEqual([422, "name"]);
    const consumer = await h.api("POST", `/environments/${a}/consumers`, { username: uniq("auth-consumer") });
    const byConsumer = await v2(h.api, "POST", a, "", plugin(sa, { name: "jwt", scope: { consumerId: consumer.body.id } }));
    expect(byConsumer.status).toBe(422);
    const disabled = await v2(h.api, "POST", a, "", plugin(sa, { name: "basic-auth", enabled: false }));
    expect(disabled.status).toBe(201);
    const enabled = await v2(h.api, "PUT", a, `/${disabled.body.id}`, plugin(sa, { name: "basic-auth", enabled: true }));
    expect(enabled.status).toBe(422);
    expect((await v2(h.api, "POST", a, "", plugin(sa, { name: "key-auth" }))).status).toBe(409);
    const other = await v2(h.api, "POST", b, "", plugin(sb, { name: "key-auth" }));
    expect(other.status).toBe(201);
    for (const row of [first, disabled]) await v2(h.api, "DELETE", a, `/${row.body.id}`);
    await v2(h.api, "DELETE", b, `/${other.body.id}`);
  });

  it("replaces the only key-auth with basic-auth via PUT on the same plugin id", async () => {
    const f = await raceFixture("POST", false);
    const route = await h.api("POST", `/environments/${f.ws}/routes`, { name: "auth", serviceId: f.serviceId, paths: ["/auth"] });
    expect(route.status).toBe(201);
    const made = await v2(h.api, "POST", f.ws, "", plugin(f.serviceId, { name: "key-auth" }));
    expect(made.status).toBe(201);
    const changed = await v2(h.api, "PUT", f.ws, `/${made.body.id}`, plugin(f.serviceId, { name: "basic-auth" }));
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body).toMatchObject({ id: made.body.id, createdAt: made.body.createdAt, name: "basic-auth", enabled: true,
      scope: { serviceId: f.serviceId, routeId: null, consumerId: null } });
    expect((await v2(h.api, "GET", f.ws)).body.items).toEqual([changed.body]);
    expect((await h.sql.query("select before, after from audit_events where entity_id = $1 and action = 'plugin.update'", [made.body.id])).rows)
      .toEqual([{ before: made.body, after: changed.body }]);
  });

  it.each(["key-auth", "basic-auth", "jwt"] as const)("allows same-workspace anonymous with %s and rejects an overlapping second mechanism on POST and PUT", async (name) => {
    const f = await raceFixture("POST", false);
    const route = await h.api("POST", `/environments/${f.ws}/routes`, { name: "auth", serviceId: f.serviceId, paths: ["/auth"] });
    const consumer = await h.api("POST", `/environments/${f.ws}/consumers`, { username: uniq("anon") });
    expect([route.status, consumer.status]).toEqual([201, 201]);
    const auth = await v2(h.api, "POST", f.ws, "", plugin(f.serviceId, { name, config: { anonymous: consumer.body.id } }));
    expect(auth.status, JSON.stringify(auth.body)).toBe(201);
    const secondName = name === "key-auth" ? "basic-auth" : "key-auth";
    const disabled = await v2(h.api, "POST", f.ws, "", plugin(f.serviceId, { name: secondName, enabled: false, scope: { routeId: route.body.id } }));
    expect(disabled.status).toBe(201);
    const before = await state(f.ws);
    for (const method of ["POST", "PUT"]) {
      for (const scope of [{ serviceId: f.serviceId }, { routeId: route.body.id }]) {
        const res = await v2(h.api, method, f.ws, method === "POST" ? "" : `/${disabled.body.id}`,
          plugin(f.serviceId, { name: secondName, scope, config: { anonymous: consumer.body.id } }));
        expect(res.status, JSON.stringify(res.body)).toBe(422);
        expect(res.body.errors).toContainEqual(expect.objectContaining({ path: "name" }));
        expect(await state(f.ws)).toEqual(before);
      }
    }
    // Kong precedence for the SAME mechanism is supported; it is not an AND/OR chain.
    const same = await v2(h.api, "POST", f.ws, "", plugin(f.serviceId, { name, scope: { routeId: route.body.id }, config: { anonymous: consumer.body.id } }));
    expect(same.status, JSON.stringify(same.body)).toBe(201);
  });

  it("refuses unsupported authenticators, consumer-scoped auth and vault config on POST and PUT without effects", async () => {
    const f = await raceFixture("PUT", false);
    const current = (await v2(h.api, "GET", f.ws)).body.items[0];
    const consumer = await h.api("POST", `/environments/${f.ws}/consumers`, { username: uniq("auth-scope") });
    expect(consumer.status).toBe(201);
    const before = await state(f.ws);
    for (const method of ["POST", "PUT"]) {
      for (const [body, path] of [
        ...["ldap-auth", "session", "hmac-auth", "oauth2"].map(name => [plugin(f.serviceId, { name }), "name"] as const),
        [plugin(f.serviceId, { name: "key-auth", scope: { consumerId: consumer.body.id } }), "scope.consumerId"],
        [plugin(f.serviceId, { name: "rate-limiting", config: { minute: 10, policy: "local", redis: { password: "{vault://env/secret}" } } }), "config.redis.password"],
      ] as const) {
        const res = await v2(h.api, method, f.ws, method === "POST" ? "" : `/${current.id}`, body);
        expect(res.status, JSON.stringify(res.body)).toBe(422);
        expect(res.body.errors).toContainEqual(expect.objectContaining({ path }));
        expect(await state(f.ws)).toEqual(before);
      }
    }
  });

  it.each(["v1", "v2"] as const)("preserves and rotates %s-created write-only secrets without response, audit or diff leaks", async (api) => {
    const f = await raceFixture("POST", false);
    const secret = "plugins-v2-secret-321";
    const rotated = "plugins-v2-new-secret-654";
    const config = (password: string, minute = 10) => ({ minute, policy: "local", redis: { password } });
    const body = plugin(f.serviceId, { name: "rate-limiting", config: config(secret) });
    const made = api === "v1" ? await h.api("POST", `/environments/${f.ws}/plugins`, body) : await v2(h.api, "POST", f.ws, "", body);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.config.redis.password).toBe("REDACTED");
    const id = made.body.id as string;
    const storedSecret = async () => {
      const stored = (await h.sql.query("select config from plugins where id = $1", [id])).rows[0].config.redis.password as string;
      expect(stored).toMatch(/^enc:/);
      return h.app.get<Encryptor>(ENCRYPTOR).open(stored, pluginSecretContext(id, ["redis", "password"]));
    };
    expect(await storedSecret()).toBe(secret);
    const baseline = await h.api("POST", `/environments/${f.ws}/snapshots`, {});
    expect(baseline.status, JSON.stringify(baseline.body)).toBe(201);
    const responses = [made];
    for (const [password, expected, minute] of [["REDACTED", secret, 20], [rotated, rotated, 30], ["REDACTED", rotated, 40]] as const) {
      const changed = await v2(h.api, "PUT", f.ws, `/${id}`, { ...body, config: config(password, minute) });
      expect(changed.status, JSON.stringify(changed.body)).toBe(200);
      expect(changed.body).toMatchObject({ id, createdAt: made.body.createdAt, config: { minute, redis: { password: "REDACTED" } } });
      expect(await storedSecret()).toBe(expected);
      responses.push(changed);
    }
    const preview = await h.api("GET", `/environments/${f.ws}/publish-preview`);
    expect(preview.status).toBe(200);
    expect(preview.body.changes).toContainEqual(expect.objectContaining({ kind: "plugins", after: expect.objectContaining({ config: expect.objectContaining({ redis: { password: "REDACTED" } }) }) }));
    const snapshot = await h.api("POST", `/environments/${f.ws}/snapshots`, {});
    expect(snapshot.status).toBe(201);
    responses.push(preview, await v2(h.api, "GET", f.ws), await v2(h.api, "GET", f.ws, `/${id}`),
      await h.api("GET", `/environments/${f.ws}/snapshots/${snapshot.body.version}/diff`));
    expect(responses.map(r => r.status)).toEqual([201, 200, 200, 200, 200, 200, 200, 200]);
    expect((await v2(h.api, "DELETE", f.ws, `/${id}`)).status).toBe(204);
    const events = (await h.sql.query("select before, after from audit_events where entity_id = $1", [id])).rows;
    expect(events).toHaveLength(5);
    for (const exposed of [JSON.stringify(responses), JSON.stringify(events)]) {
      expect(exposed).not.toContain(secret);
      expect(exposed).not.toContain(rotated);
      expect(exposed).not.toContain("enc:");
    }
    const before = await state(f.ws);
    const placeholder = await v2(h.api, "POST", f.ws, "", { ...body, config: config("REDACTED") });
    expect(placeholder.status).toBe(422);
    expect(placeholder.body.errors).toContainEqual(expect.objectContaining({ path: "config.redis.password" }));
    expect(await state(f.ws)).toEqual(before);
  });

  it("refuses archived and auto-publishing workspaces on all writes, without changing the draft or auditing", async () => {
    for (const state of ["archived", "auto"] as const) {
      const ws = (await h.api("POST", "/environments", { name: uniq(state) })).body.id as string;
      const svc = (await h.api("POST", `/environments/${ws}/services`, { name: uniq("s"), protocol: "http", host: "echo", port: 80 })).body.id as string;
      const row = (await h.api("POST", `/environments/${ws}/plugins`, plugin(svc))).body;
      if (state === "archived") expect((await h.api("POST", `/../v2/workspaces/${ws}/archive`)).status).toBe(204);
      else await h.sql.query("update environments set publish_mode = 'auto' where id = $1", [ws]);
      const before = (await h.sql.query("select config, enabled, updated_at from plugins where id = $1", [row.id])).rows;
      const audits = (await h.sql.query("select count(*)::int n from audit_events where environment_id = $1", [ws])).rows;
      for (const method of ["POST", "PUT", "DELETE"]) {
        const res = await v2(h.api, method, ws, method === "POST" ? "" : `/${row.id}`, method === "DELETE" ? undefined : plugin(svc, { enabled: false }));
        expect([res.status, res.body.code], JSON.stringify(res.body)).toEqual([409, state === "auto" ? "auto-publish" : "workspace-archived"]);
      }
      expect((await h.sql.query("select config, enabled, updated_at from plugins where id = $1", [row.id])).rows).toEqual(before);
      expect((await h.sql.query("select count(*)::int n from audit_events where environment_id = $1", [ws])).rows).toEqual(audits);
    }
  });

  const state = async (ws: string) => (await h.sql.query<WorkspaceState>(`select to_jsonb(e) as environment,
    (select to_jsonb(w) from workspaces w where w.id = e.id) as workspace,
    coalesce((select jsonb_agg(p order by p.id) from plugins p where p.environment_id = e.id), '[]'::jsonb) as plugins,
    coalesce((select jsonb_agg(a order by a.id) from audit_events a where a.environment_id = e.id), '[]'::jsonb) as audits,
    coalesce((select jsonb_agg(s order by s.version) from snapshots s where s.environment_id = e.id), '[]'::jsonb) as snapshots,
    coalesce((select jsonb_agg(r order by r.version) from releases r where r.workspace_id = e.id), '[]'::jsonb) as releases,
    coalesce((select jsonb_agg(d order by d.epoch, d.revision) from deployments d
      where d.members @> jsonb_build_array(jsonb_build_object('workspaceId', e.id))), '[]'::jsonb) as deployments
    from environments e where e.id = $1`, [ws])).rows[0]!;
  const raceFixture = async (method: "POST" | "PUT" | "DELETE", published = true) => {
    const env = await h.api("POST", "/environments", { name: uniq("plugin-race") });
    expect(env.status).toBe(201);
    const ws = env.body.id as string;
    const service = await h.api("POST", `/environments/${ws}/services`, { name: "svc", protocol: "http", host: "echo", port: 80 });
    expect(service.status).toBe(201);
    const serviceId = service.body.id as string;
    let suffix = "";
    if (method !== "POST") {
      const existing = await v2(h.api, "POST", ws, "", plugin(serviceId));
      expect(existing.status).toBe(201);
      suffix = `/${existing.body.id}`;
    }
    if (published) expect((await h.api("POST", `/environments/${ws}/snapshots`, {})).status).toBe(201);
    return {
      ws, serviceId,
      write: () => v2(h.api, method, ws, suffix, method === "DELETE" ? undefined : plugin(serviceId, { enabled: false, config: { origins: ["https://draft.example.com"] } })),
    };
  };
  // Synchronize on PostgreSQL wait edges, without timing-based sleeps or application mocks.
  const waitFor = async (blocker: number, pattern: string) => {
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      const { rows } = await h.sql.query<{ pid: number }>(`select pid from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
          and $1 = any(pg_blocking_pids(pid)) and query ~ $2`, [blocker, pattern]);
      if (rows.length === 1) return rows[0]!.pid;
    }
    throw new Error(`No lock wait for ${pattern} behind ${blocker}`);
  };
  const workspaceWait = "pg_advisory_xact_lock\\(hashtextextended";
  const barrier = async (query: string, ws: string, run: (pid: number, release: () => Promise<void>, start: <T>(p: Promise<T>) => Promise<T>) => Promise<void>) => {
    const holder = await h.sql.connect();
    const pending: Promise<unknown>[] = [];
    try {
      await holder.query("begin");
      await holder.query(query, [ws]);
      const { rows: [backend] } = await holder.query<{ pid: number }>("select pg_backend_pid() as pid");
      await run(backend!.pid, async () => { await holder.query("commit"); }, (p) => {
        pending.push(p);
        void p.catch(() => undefined);
        return p;
      });
    } finally {
      await holder.query("rollback");
      holder.release();
      await Promise.allSettled(pending);
      expect(aborts).toEqual([]);
    }
  };
  const noEntityLocks = async (pid: number) => {
    expect((await h.sql.query("select relation::regclass::text from pg_locks where pid = $1 and mode = 'RowExclusiveLock'", [pid])).rows).toEqual([]);
  };
  const unchangedPublication = (before: WorkspaceState, after: WorkspaceState) => {
    expect(before.snapshots).toHaveLength(1);
    expect(after.snapshots).toEqual(before.snapshots);
    expect(after.releases).toEqual(before.releases);
    expect(after.deployments).toEqual(before.deployments);
    expect(after.workspace).toEqual(before.workspace);
  };
  const auditActions = (before: WorkspaceState, after: WorkspaceState) => after.audits
    .filter(a => !before.audits.some(b => b.id === a.id)).map(a => a.action).sort();

  it.each(["POST", "PUT", "DELETE"] as const)("%s v2 waits for publishMode to commit auto, then refuses without effects", async (method) => {
    const f = await raceFixture(method);
    const before = await state(f.ws);
    await barrier("select 1 from environments where id = $1 for update", f.ws, async (pid, release, start) => {
      const switching = start(h.api("PATCH", `/environments/${f.ws}`, { name: before.environment.name, publishMode: "auto" }));
      const switcher = await waitFor(pid, 'from "environments".*for update');
      const writing = start(f.write());
      const writer = await waitFor(switcher, workspaceWait);
      await noEntityLocks(writer);
      expect(await state(f.ws)).toEqual(before);
      await release();
      expect((await switching).status).toBe(200);
      const res = await writing;
      expect([res.status, res.body.code], JSON.stringify(res.body)).toEqual([409, "auto-publish"]);
      expect(res.contentType).toContain("application/problem+json");
    });
    const after = await state(f.ws);
    expect(after.plugins).toEqual(before.plugins);
    expect(after.environment).toMatchObject({ publish_mode: "auto", current_version: 1, has_unpublished_changes: false });
    expect(auditActions(before, after)).toEqual(["environment.update"]);
    unchangedPublication(before, after);
  });

  it.each(["POST", "PUT", "DELETE"] as const)("%s v2 holds the workspace through commit before publishMode changes, writing only the draft", async (method) => {
    const f = await raceFixture(method);
    const before = await state(f.ws);
    const action = method === "POST" ? "plugin.create" : method === "PUT" ? "plugin.update" : "plugin.delete";
    // Pause after the plugin write and dirty mark, at audit insertion, to detect early lock release.
    await h.sql.query(`create function ws_p1_pause_plugin() returns trigger language plpgsql as $$
      begin perform pg_advisory_xact_lock(232, hashtext(TG_ARGV[0])); return NEW; end $$`);
    try {
      await h.sql.query(`create trigger ws_p1_pause_plugin before insert on audit_events for each row
        when (NEW.environment_id = '${f.ws}'::uuid and NEW.action = '${action}')
        execute function ws_p1_pause_plugin('${f.ws}')`);
      await barrier("select pg_advisory_xact_lock(232, hashtext($1))", f.ws, async (pid, release, start) => {
        const writing = start(f.write());
        const writer = await waitFor(pid, 'insert into "audit_events"');
        const switching = start(h.api("PATCH", `/environments/${f.ws}`, { name: before.environment.name, publishMode: "auto" }));
        const switcher = await waitFor(writer, workspaceWait);
        await noEntityLocks(switcher);
        expect(await state(f.ws)).toEqual(before);
        await release();
        const written = await writing;
        expect(written.status, JSON.stringify(written.body)).toBe(method === "POST" ? 201 : method === "PUT" ? 200 : 204);
        expect((await switching).status).toBe(200);
        const after = await state(f.ws);
        expect(after.plugins).toEqual(method === "DELETE" ? [] : [expect.objectContaining({
          id: written.body.id, environment_id: f.ws, name: "cors", service_id: f.serviceId,
          enabled: false, config: { origins: ["https://draft.example.com"] },
        })]);
        if (method === "PUT") expect(written.body.id).toBe(before.plugins[0]!.id);
        expect(after.environment).toMatchObject({ publish_mode: "auto", current_version: 1, has_unpublished_changes: true });
        expect(auditActions(before, after)).toEqual(["environment.update", action]);
        unchangedPublication(before, after);
      });
    } finally { await h.sql.query("drop function ws_p1_pause_plugin() cascade"); }
  });

  it.each(["POST", "PUT", "DELETE"] as const)("%s waits behind archive and refuses without partial draft effects", async (method) => {
    const f = await raceFixture(method, false);
    const before = await state(f.ws);
    await barrier("select 1 from environments where id = $1 for no key update", f.ws, async (pid, release, start) => {
      const archiving = start(h.api("POST", `/../v2/workspaces/${f.ws}/archive`));
      const archiver = await waitFor(pid, 'from "environments".*for no key update');
      const writing = start(f.write());
      const writer = await waitFor(archiver, workspaceWait);
      await noEntityLocks(writer);
      expect(await state(f.ws)).toEqual(before);
      await release();
      expect((await archiving).status).toBe(204);
      const res = await writing;
      expect([res.status, res.body.code]).toEqual([409, "workspace-archived"]);
    });
    const after = await state(f.ws);
    expect(after.plugins).toEqual(before.plugins);
    expect(after.environment.has_unpublished_changes).toBe(before.environment.has_unpublished_changes);
    expect(after.workspace).toMatchObject({ status: "archived" });
    expect(auditActions(before, after)).toEqual(["workspace.archive"]);
    for (const key of ["snapshots", "releases", "deployments"] as const) expect(after[key]).toEqual(before[key]);
  });

  it.each(["POST", "PUT", "DELETE"] as const)("%s commits its entire draft before a queued archive", async (method) => {
    const f = await raceFixture(method, false);
    const before = await state(f.ws);
    const action = method === "POST" ? "plugin.create" : method === "PUT" ? "plugin.update" : "plugin.delete";
    await h.sql.query(`create function ws_p1_pause_archive() returns trigger language plpgsql as $$
      begin perform pg_advisory_xact_lock(233, hashtext(TG_ARGV[0])); return NEW; end $$`);
    try {
      await h.sql.query(`create trigger ws_p1_pause_archive before insert on audit_events for each row
        when (NEW.environment_id = '${f.ws}'::uuid and NEW.action = '${action}')
        execute function ws_p1_pause_archive('${f.ws}')`);
      await barrier("select pg_advisory_xact_lock(233, hashtext($1))", f.ws, async (pid, release, start) => {
        const writing = start(f.write());
        const writer = await waitFor(pid, 'insert into "audit_events"');
        const archiving = start(h.api("POST", `/../v2/workspaces/${f.ws}/archive`));
        const archiver = await waitFor(writer, workspaceWait);
        await noEntityLocks(archiver);
        expect(await state(f.ws)).toEqual(before);
        await release();
        const res = await writing;
        expect(res.status, JSON.stringify(res.body)).toBe(method === "POST" ? 201 : method === "PUT" ? 200 : 204);
        expect((await archiving).status).toBe(204);
        const after = await state(f.ws);
        expect(after.plugins).toEqual(method === "DELETE" ? [] : [expect.objectContaining({ id: res.body.id, enabled: false, config: { origins: ["https://draft.example.com"] } })]);
        expect(after.environment.has_unpublished_changes).toBe(true);
        expect(after.workspace).toMatchObject({ status: "archived" });
        expect(auditActions(before, after)).toEqual([action, "workspace.archive"].sort());
        for (const key of ["snapshots", "releases", "deployments"] as const) expect(after[key]).toEqual(before[key]);
      });
    } finally { await h.sql.query("drop function ws_p1_pause_archive() cascade"); }
  });

  it.each(["service", "route", "consumer", "anonymous"] as const)("POST and PUT recheck the %s target deleted while queued on the workspace", async (reference) => {
    const entity = reference === "anonymous" ? "consumer" : reference;
    const path = reference === "anonymous" ? "config.anonymous" : `scope.${entity}Id`;
    for (const method of ["POST", "PUT"] as const) {
      const f = await raceFixture(method);
      const target = entity === "service"
        ? await h.api("POST", `/environments/${f.ws}/services`, { name: "target", protocol: "http", host: "echo", port: 80 })
        : entity === "route"
          ? await h.api("POST", `/environments/${f.ws}/routes`, { name: "target", serviceId: f.serviceId, paths: ["/target"] })
          : await h.api("POST", `/environments/${f.ws}/consumers`, { username: uniq("target") });
      expect(target.status).toBe(201);
      const before = await state(f.ws);
      const suffix = method === "PUT" ? `/${before.plugins[0]!.id}` : "";
      await barrier("select 1 from environments where id = $1 for no key update", f.ws, async (pid, release, start) => {
        const deleting = start(h.api("DELETE", `/../v2/workspaces/${f.ws}/${entity}s/${target.body.id}`));
        const deleter = await waitFor(pid, 'from "environments".*for no key update');
        const body = reference === "anonymous"
          ? plugin(f.serviceId, { name: "key-auth", config: { anonymous: target.body.id } })
          : plugin(f.serviceId, { scope: { [`${entity}Id`]: target.body.id },
            ...(entity === "consumer" ? { name: "rate-limiting", config: { minute: 10, policy: "local" } } : {}) });
        const writing = start(v2(h.api, method, f.ws, suffix, body));
        const writer = await waitFor(deleter, workspaceWait);
        await noEntityLocks(writer);
        expect(await state(f.ws)).toEqual(before);
        await release();
        expect((await deleting).status).toBe(204);
        const res = await writing;
        expect(res.status, JSON.stringify(res.body)).toBe(422);
        expect(res.body.errors).toContainEqual(expect.objectContaining({ path }));
      });
      const after = await state(f.ws);
      expect(after.plugins).toEqual(before.plugins);
      expect(auditActions(before, after)).toEqual([`${entity}.delete`]);
      expect((await h.sql.query(`select id from ${entity}s where id = $1`, [target.body.id])).rows).toEqual([]);
      unchangedPublication(before, after);
    }
  });

  it.each(["service", "route", "consumer", "anonymous"] as const)("%s DELETE waits for POST/PUT plugin commit and obeys reference or cascade rules", async (reference) => {
    const entity = reference === "anonymous" ? "consumer" : reference;
    const cascades = reference === "route" || reference === "consumer";
    for (const method of ["POST", "PUT"] as const) {
      const f = await raceFixture(method);
      const route = entity === "route" ? await h.api("POST", `/environments/${f.ws}/routes`, { name: "target", serviceId: f.serviceId, paths: ["/target"] }) : undefined;
      if (route) expect(route.status).toBe(201);
      const consumer = entity === "consumer" ? await h.api("POST", `/environments/${f.ws}/consumers`, { username: uniq("target") }) : undefined;
      if (consumer) expect(consumer.status).toBe(201);
      const id = (route?.body.id ?? consumer?.body.id ?? f.serviceId) as string;
      const before = await state(f.ws);
      const suffix = method === "PUT" ? `/${before.plugins[0]!.id}` : "";
      await h.sql.query(`create function ws_p1_pause_target() returns trigger language plpgsql as $$
        begin perform pg_advisory_xact_lock(234, hashtext(TG_ARGV[0])); return NEW; end $$`);
      try {
        await h.sql.query(`create trigger ws_p1_pause_target before insert on audit_events for each row
          when (NEW.environment_id = '${f.ws}'::uuid and NEW.action = '${method === "POST" ? "plugin.create" : "plugin.update"}')
          execute function ws_p1_pause_target('${f.ws}')`);
        await barrier("select pg_advisory_xact_lock(234, hashtext($1))", f.ws, async (pid, release, start) => {
          const body = reference === "anonymous"
            ? plugin(f.serviceId, { name: "key-auth", config: { anonymous: id }, enabled: false })
            : plugin(f.serviceId, { scope: { [`${entity}Id`]: id }, enabled: false,
              ...(entity === "consumer" ? { name: "rate-limiting", config: { minute: 10, policy: "local" } } : {}) });
          const writing = start(v2(h.api, method, f.ws, suffix, body));
          const writer = await waitFor(pid, 'insert into "audit_events"');
          const deleting = start(h.api("DELETE", `/../v2/workspaces/${f.ws}/${entity}s/${id}`));
          const deleter = await waitFor(writer, workspaceWait);
          await noEntityLocks(deleter);
          expect(await state(f.ws)).toEqual(before);
          await release();
          const res = await writing;
          expect(res.status, JSON.stringify(res.body)).toBe(method === "POST" ? 201 : 200);
          const deleted = await deleting;
          expect(deleted.status, JSON.stringify(deleted.body)).toBe(cascades ? 204 : 409);
          const after = await state(f.ws);
          expect(after.plugins).toEqual(cascades ? [] : [expect.objectContaining({ id: res.body.id, service_id: f.serviceId, enabled: false,
            ...(reference === "anonymous" ? { config: { anonymous: id } } : {}) })]);
          expect((await h.sql.query(`select id from ${entity}s where id = $1`, [id])).rows).toEqual(cascades ? [] : [{ id }]);
          expect(auditActions(before, after)).toEqual([method === "POST" ? "plugin.create" : "plugin.update", ...(cascades ? [`${entity}.delete`] : [])].sort());
          unchangedPublication(before, after);
        });
      } finally { await h.sql.query("drop function ws_p1_pause_target() cascade"); }
    }
  });

  it.each(["PUT", "DELETE"] as const)("%s rechecks a plugin cascaded by a queued Route DELETE, returning 404 without effects", async (method) => {
    const f = await raceFixture("POST");
    const route = await h.api("POST", `/environments/${f.ws}/routes`, { name: "target", serviceId: f.serviceId, paths: ["/target"] });
    expect(route.status).toBe(201);
    const body = plugin(f.serviceId, { scope: { routeId: route.body.id } });
    const made = await v2(h.api, "POST", f.ws, "", body);
    expect(made.status).toBe(201);
    const before = await state(f.ws);
    await barrier("select 1 from environments where id = $1 for no key update", f.ws, async (pid, release, start) => {
      const deleting = start(h.api("DELETE", `/../v2/workspaces/${f.ws}/routes/${route.body.id}`));
      const deleter = await waitFor(pid, 'from "environments".*for no key update');
      const writing = start(v2(h.api, method, f.ws, `/${made.body.id}`, method === "PUT" ? { ...body, enabled: false } : undefined));
      const writer = await waitFor(deleter, workspaceWait);
      await noEntityLocks(writer);
      expect(await state(f.ws)).toEqual(before);
      await release();
      expect((await deleting).status).toBe(204);
      expect((await writing).status).toBe(404);
    });
    const after = await state(f.ws);
    expect(after.plugins).toEqual([]);
    expect(auditActions(before, after)).toEqual(["route.delete"]);
    unchangedPublication(before, after);
  });

  it("merges REDACTED from the current committed secret after a concurrent v1 writer", async () => {
    const f = await raceFixture("POST", false);
    const body = plugin(f.serviceId, { name: "rate-limiting", config: { minute: 10, policy: "local", redis: { password: "old-secret" } } });
    const made = await h.api("POST", `/environments/${f.ws}/plugins`, body);
    expect(made.status).toBe(201);
    const enc = h.app.get<Encryptor>(ENCRYPTOR);
    const context = pluginSecretContext(made.body.id, ["redis", "password"]);
    const holder = await h.sql.connect();
    let pending: ReturnType<typeof v2> | undefined;
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtextextended($1::uuid::text, $2))", [f.ws, 0x6772_7761]);
      const pid = (await holder.query<{ pid: number }>("select pg_backend_pid() pid")).rows[0]!.pid;
      pending = v2(h.api, "PUT", f.ws, `/${made.body.id}`, { ...body, config: { ...body.config, redis: { password: "REDACTED" } } });
      await waitFor(pid, workspaceWait);
      // Emulate the uncommitted row of a v1 writer holding W; HTTP would queue behind our barrier.
      await holder.query("update plugins set config = jsonb_set(config, '{redis,password}', to_jsonb($1::text)) where id = $2", [enc.seal("concurrent-secret", context), made.body.id]);
      await holder.query("commit");
      expect((await pending).status).toBe(200);
      const stored = (await h.sql.query("select config from plugins where id = $1", [made.body.id])).rows[0].config.redis.password as string;
      expect(enc.open(stored, context)).toBe("concurrent-secret");
    } finally { await holder.query("rollback"); holder.release(); if (pending) await pending; }
    expect(aborts).toEqual([]);
  });

  it("rechecks the current privileged plugin under the workspace lock after a concurrent v1 change", async () => {
    const editor = await h.as("editor");
    const made = await h.api("POST", `/environments/${a}/plugins`, plugin(sa, { name: "request-termination" }));
    expect(made.status).toBe(201);
    const holder = await h.sql.connect();
    let pending: ReturnType<typeof v2> | undefined;
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtextextended($1::uuid::text, $2))", [a, 0x6772_7761]);
      const pid = (await holder.query<{ pid: number }>("select pg_backend_pid() pid")).rows[0]!.pid;
      pending = v2(editor.api, "PUT", a, `/${made.body.id}`, plugin(sa));
      const writer = await waitFor(pid, workspaceWait);
      await noEntityLocks(writer);
      await holder.query("update plugins set name = 'pre-function', config = '{\"access\":[\"return\"]}' where id = $1", [made.body.id]);
      await holder.query("commit");
      expect((await pending).status).toBe(403);
    } finally { await holder.query("rollback"); holder.release(); if (pending) await pending; }
    expect(aborts).toEqual([]);
    await h.api("DELETE", `/environments/${a}/plugins/${made.body.id}`);
  });
});
