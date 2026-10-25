import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { contractsV2 } from "../../src/common/contract.js";
import { selfSigned } from "./certs.js";
import { type ApiClient, type ApiResponse, startHarness, uniq, type Harness } from "./harness.js";

// N1-X4: the gateway entities of a workspace through /api/v2, on the same services and guard as v1 (decision H-9).
// Every call goes through the contract: the operation names the path, and every 2xx body is validated against that
// operation's response schema. The last test checks that every implemented entity operation was exercised.
type Doc = Record<string, any>;
const v2 = parse(readFileSync(new URL("../../../../contracts/control-plane-v2.openapi.yaml", import.meta.url), "utf8")) as Doc;
const OPS = new Map<string, { path: string; method: string; op: Doc }>();
for (const [path, item] of Object.entries(v2.paths as Doc)) {
  for (const [method, op] of Object.entries(item as Doc)) if (op && typeof op === "object" && op.operationId) OPS.set(op.operationId, { path, method, op });
}
const pointer = (path: string, method: string, code: string) =>
  `#/paths/${path.replace(/~/g, "~0").replace(/\//g, "~1")}/${method}/responses/${code}/content/application~1json/schema`;

describe("workspace entities through /api/v2", () => {
  let h: Harness;
  let a: string;
  let b: string;
  const called = new Set<string>();

  /** Calls an operation of the contract; a 2xx body must match its response schema. */
  async function call(client: ApiClient, operationId: string, params: Record<string, string>, body?: unknown, query = ""): Promise<ApiResponse> {
    const entry = OPS.get(operationId);
    if (!entry) throw new Error(`unknown operation ${operationId}`);
    const path = entry.path.replace(/\{(\w+)\}/g, (_, name: string) => params[name] ?? `{${name}}`);
    const res = await client(entry.method.toUpperCase(), `/../v2${path}${query}`, body);
    called.add(operationId);
    const code = String(res.status);
    if (res.status < 300 && entry.op.responses[code]?.content) {
      const validate = contractsV2.validator(pointer(entry.path, entry.method, code));
      expect(validate(res.body), `${operationId}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
    return res;
  }
  const env = async () => (await h.api("POST", "/environments", { name: uniq("ws") })).body.id as string;
  const conflictOf = (res: ApiResponse) => JSON.stringify(res.body);

  beforeAll(async () => {
    h = await startHarness();
    a = await env();
    b = await env();
  });
  afterAll(async () => {
    await h?.close();
  });

  it("lists and reads workspaces the caller may read, with the slug and no release yet", async () => {
    const page = await call(h.api, "listWorkspaces", {}, undefined, "?limit=200");
    expect(page.status).toBe(200);
    expect(page.body.items.map((w: { id: string }) => w.id)).toEqual(expect.arrayContaining([a, b]));
    const one = await call(h.api, "getWorkspace", { workspaceId: a });
    expect(one.status).toBe(200);
    const slug = (await h.sql.query(`select slug, key from workspaces where id = $1`, [a])).rows[0];
    expect(one.body).toMatchObject({ id: a, key: slug.key, slug: slug.slug, status: "active", activeRelease: null });
    // A user denied in one workspace does not see it, in the list or alone.
    const hidden = await h.as("viewer");
    await h.api("PUT", `/users/${hidden.id}/environment-roles`, { items: [{ environmentId: a, role: "none" }] });
    const seen = (await call(hidden.api, "listWorkspaces", {}, undefined, "?limit=200")).body.items.map((w: { id: string }) => w.id);
    expect(seen).toContain(b);
    expect(seen).not.toContain(a);
    expect((await call(hidden.api, "getWorkspace", { workspaceId: a })).status).toBe(404);
  });

  it("pages the workspaces by cursor without skipping or repeating one", async () => {
    const all: string[] = [];
    let cursor: string | null = null;
    do {
      const page: ApiResponse = await call(h.api, "listWorkspaces", {}, undefined, `?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      expect(page.body.items.length).toBeLessThanOrEqual(1);
      all.push(...page.body.items.map((w: { id: string }) => w.id));
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toEqual(expect.arrayContaining([a, b]));
  });

  it("keeps consumers unique in the workspace only, with closed bodies", async () => {
    const created = await call(h.api, "createConsumer", { workspaceId: a }, { username: "app-sky", customId: "sky-1" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await call(h.api, "createConsumer", { workspaceId: a }, { username: "app-sky" })).status).toBe(409);
    // Another workspace may use the same username and customId (decision H-5).
    expect((await call(h.api, "createConsumer", { workspaceId: b }, { username: "app-sky", customId: "sky-1" })).status).toBe(201);
    expect((await call(h.api, "createConsumer", { workspaceId: a }, { username: "x", extra: true })).status).toBe(422);
    expect((await call(h.api, "createConsumer", { workspaceId: a }, { tags: ["t"] })).status).toBe(422);
    const id = created.body.id as string;
    expect((await call(h.api, "getConsumer", { workspaceId: a, consumerId: id })).body.username).toBe("app-sky");
    expect((await call(h.api, "replaceConsumer", { workspaceId: a, consumerId: id }, { username: "app-sky", customId: "sky-2" })).body.customId).toBe("sky-2");
    expect((await call(h.api, "listConsumers", { workspaceId: a }, undefined, "?q=app-sky")).body.items).toHaveLength(1);
    // Another workspace's consumer is not reachable from here.
    expect((await call(h.api, "getConsumer", { workspaceId: b, consumerId: id })).status).toBe(404);
    const audit = (await h.sql.query(`select action from audit_events where entity_id = $1 order by at`, [id])).rows.map((r) => r.action);
    expect(audit).toEqual(["consumer.create", "consumer.update"]);
  });

  it("keeps credentials unique in the instance, with a conflict that never names the other workspace", async () => {
    const ca = (await call(h.api, "createConsumer", { workspaceId: a }, { username: uniq("cred") })).body.id as string;
    const cb = (await call(h.api, "createConsumer", { workspaceId: b }, { username: uniq("cred") })).body.id as string;
    const key = `key-${uniq("k")}-0123456789`;
    const keyAuth = await call(h.api, "createKeyAuthCredential", { workspaceId: a, consumerId: ca }, { key });
    expect(keyAuth.status, JSON.stringify(keyAuth.body)).toBe(201);
    expect(keyAuth.body.key).toBe(key);
    const taken = await call(h.api, "createKeyAuthCredential", { workspaceId: b, consumerId: cb }, { key });
    expect(taken.status).toBe(409);
    expect(conflictOf(taken)).not.toContain(a);
    expect((await call(h.api, "createKeyAuthCredential", { workspaceId: a, consumerId: ca }, { key: `${key}-2`, extra: 1 })).status).toBe(422);
    const listed = await call(h.api, "listKeyAuthCredentials", { workspaceId: a, consumerId: ca });
    expect(JSON.stringify(listed.body)).not.toContain(key);
    expect((await call(h.api, "deleteKeyAuthCredential", { workspaceId: a, consumerId: ca, credentialId: keyAuth.body.id })).status).toBe(204);

    const iss = uniq("iss");
    const jwt = await call(h.api, "createJwtCredential", { workspaceId: a, consumerId: ca }, { key: iss });
    expect(jwt.status, JSON.stringify(jwt.body)).toBe(201);
    const jwtTaken = await call(h.api, "createJwtCredential", { workspaceId: b, consumerId: cb }, { key: iss });
    expect(jwtTaken.status).toBe(409);
    expect(conflictOf(jwtTaken)).not.toContain(a);
    expect((await call(h.api, "listJwtCredentials", { workspaceId: a, consumerId: ca })).body.items).toHaveLength(1);
    expect((await call(h.api, "deleteJwtCredential", { workspaceId: a, consumerId: ca, credentialId: jwt.body.id })).status).toBe(204);

    const username = uniq("basic");
    const basic = await call(h.api, "createBasicAuthCredential", { workspaceId: a, consumerId: ca }, { username, password: "a-long-password-1" });
    expect(basic.status, JSON.stringify(basic.body)).toBe(201);
    const basicTaken = await call(h.api, "createBasicAuthCredential", { workspaceId: b, consumerId: cb }, { username, password: "a-long-password-2" });
    expect(basicTaken.status).toBe(409);
    expect(conflictOf(basicTaken)).not.toContain(a);
    expect((await call(h.api, "listBasicAuthCredentials", { workspaceId: a, consumerId: ca })).body.items).toHaveLength(1);
    expect((await call(h.api, "deleteBasicAuthCredential", { workspaceId: a, consumerId: ca, credentialId: basic.body.id })).status).toBe(204);

    expect((await call(h.api, "replaceConsumerAclGroups", { workspaceId: a, consumerId: ca }, { groups: ["gold"] })).status).toBe(200);
    expect((await call(h.api, "replaceConsumerAclGroups", { workspaceId: a, consumerId: ca }, { groups: ["gold"], extra: 1 })).status).toBe(422);
    expect((await call(h.api, "getConsumerAclGroups", { workspaceId: a, consumerId: ca })).body.groups).toEqual(["gold"]);
    expect((await call(h.api, "deleteConsumer", { workspaceId: a, consumerId: ca })).status).toBe(204);
  });

  it("manages upstreams and targets; a VarRef names a variable nobody could declare yet: 422 at the field", async () => {
    const created = await call(h.api, "createUpstream", { workspaceId: a }, { name: "pool" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await call(h.api, "createUpstream", { workspaceId: a }, { name: "pool" })).status).toBe(409);
    expect((await call(h.api, "createUpstream", { workspaceId: b }, { name: "pool" })).status).toBe(201);
    // Healthchecks are closed at every level.
    expect((await call(h.api, "createUpstream", { workspaceId: a }, { name: "closed", healthchecks: { active: { type: "http", extra: 1 } } })).status).toBe(422);
    const id = created.body.id as string;
    expect((await call(h.api, "getUpstream", { workspaceId: a, upstreamId: id })).body.name).toBe("pool");
    expect((await call(h.api, "replaceUpstream", { workspaceId: a, upstreamId: id }, { name: "pool", algorithm: "least-connections" })).body.algorithm).toBe("least-connections");
    expect((await call(h.api, "listUpstreams", { workspaceId: a })).body.items.map((u: { id: string }) => u.id)).toEqual([id]);

    const varRef = await call(h.api, "createTarget", { workspaceId: a, upstreamId: id }, { target: { $var: "BACKEND" } });
    expect(varRef.status).toBe(422);
    expect(varRef.body.errors).toEqual([{ path: "target", message: "variable BACKEND is not declared in this workspace" }]);
    const target = await call(h.api, "createTarget", { workspaceId: a, upstreamId: id }, { target: "backend.example.com:8080" });
    expect(target.status, JSON.stringify(target.body)).toBe(201);
    expect((await call(h.api, "createTarget", { workspaceId: a, upstreamId: id }, { target: "backend.example.com:8080" })).status).toBe(409);
    expect((await call(h.api, "replaceTarget", { workspaceId: a, upstreamId: id, targetId: target.body.id }, { target: "backend.example.com:8081", weight: 5 })).body.weight).toBe(5);
    expect((await call(h.api, "replaceTarget", { workspaceId: a, upstreamId: id, targetId: target.body.id }, { target: { $var: "BACKEND" } })).status).toBe(422);
    expect((await call(h.api, "listTargets", { workspaceId: a, upstreamId: id })).body.items).toHaveLength(1);
    expect((await call(h.api, "deleteTarget", { workspaceId: a, upstreamId: id, targetId: target.body.id })).status).toBe(204);
    expect((await call(h.api, "deleteUpstream", { workspaceId: a, upstreamId: id })).status).toBe(204);
  });

  it("manages certificates: the key is write-only, an SNI is unique in the instance, a VarRef is refused", async () => {
    const name = `${uniq("tls")}.example.com`;
    const pem = selfSigned(name);
    const varRef = await call(h.api, "createCertificate", { workspaceId: a }, { cert: pem.cert, key: { $var: "TLS_KEY" }, snis: [name] });
    expect(varRef.status).toBe(422);
    expect(varRef.body.errors.map((e: { path: string }) => e.path)).toEqual(["key"]);
    const created = await call(h.api, "createCertificate", { workspaceId: a }, { cert: pem.cert, key: pem.key, snis: [name] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.key).toBe("REDACTED");
    const other = selfSigned(name);
    const taken = await call(h.api, "createCertificate", { workspaceId: b }, { cert: other.cert, key: other.key, snis: [name] });
    expect(taken.status).toBe(409);
    expect(conflictOf(taken)).not.toContain(a);
    const id = created.body.id as string;
    expect((await call(h.api, "getCertificate", { workspaceId: a, certificateId: id })).body.snis).toEqual([name]);
    expect((await call(h.api, "replaceCertificate", { workspaceId: a, certificateId: id }, { cert: pem.cert, key: "REDACTED", snis: [name], tags: ["kept"] })).body.tags).toEqual(["kept"]);
    expect((await call(h.api, "listCertificates", { workspaceId: a })).body.items.map((c: { id: string }) => c.id)).toEqual([id]);
    expect((await call(h.api, "deleteCertificate", { workspaceId: a, certificateId: id })).status).toBe(204);
  });

  it("reads services, routes and plugins as v2 shows them, and deletes them with the v2 rules", async () => {
    const svc = (await h.api("POST", `/environments/${a}/services`, { name: "orders", protocol: "http", host: "orders.example.com", port: 80 })).body.id as string;
    const route = (await h.api("POST", `/environments/${a}/routes`, { name: "orders", serviceId: svc, paths: ["/orders"] })).body.id as string;
    const plugin = (await h.api("POST", `/environments/${a}/plugins`, { name: "cors", scope: { serviceId: svc }, config: { origins: ["https://example.com"] } })).body.id as string;

    expect((await call(h.api, "getService", { workspaceId: a, serviceId: svc })).body).toMatchObject({ id: svc, workspaceId: a, upstreamId: null });
    expect((await call(h.api, "listServices", { workspaceId: a }, undefined, "?q=orders")).body.items.map((s: { id: string }) => s.id)).toEqual([svc]);
    expect((await call(h.api, "getRoute", { workspaceId: a, routeId: route })).body).toMatchObject({ id: route, pathCompatibility: "legacy-preserved" });
    expect((await call(h.api, "listRoutes", { workspaceId: a }, undefined, `?serviceId=${svc}`)).body.items.map((r: { id: string }) => r.id)).toEqual([route]);
    expect((await call(h.api, "getPlugin", { workspaceId: a, pluginId: plugin })).body).toMatchObject({ id: plugin, name: "cors" });
    expect((await call(h.api, "listPlugins", { workspaceId: a }, undefined, `?serviceId=${svc}`)).body.items.map((p: { id: string }) => p.id)).toEqual([plugin]);

    // v2 refuses deleting a service while routes or plugins use it (v1 deletes its plugins with it).
    expect((await call(h.api, "deleteService", { workspaceId: a, serviceId: svc })).status).toBe(409);
    expect((await call(h.api, "deleteRoute", { workspaceId: a, routeId: route })).status).toBe(204);
    const byPlugin = await call(h.api, "deleteService", { workspaceId: a, serviceId: svc });
    expect(byPlugin.status).toBe(409);
    expect(byPlugin.body.detail).toMatch(/plugin/);
    expect((await call(h.api, "deletePlugin", { workspaceId: a, pluginId: plugin })).status).toBe(204);
    expect((await call(h.api, "deleteService", { workspaceId: a, serviceId: svc })).status).toBe(204);
    const actions = (await h.sql.query(`select action from audit_events where entity_id = any($1) order by at`, [[svc, route, plugin]])).rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["route.delete", "plugin.delete", "service.delete"]));
  });

  it("decides every operation with the v2 guard: read needs workspace.read, a change gateway.write, out of scope 404", async () => {
    const viewer = await h.as("viewer");
    expect((await call(viewer.api, "listConsumers", { workspaceId: a })).status).toBe(200);
    expect((await call(viewer.api, "createConsumer", { workspaceId: a }, { username: uniq("v") })).status).toBe(403);
    const hidden = await h.as("editor");
    await h.api("PUT", `/users/${hidden.id}/environment-roles`, { items: [{ environmentId: a, role: "none" }] });
    expect((await call(hidden.api, "listUpstreams", { workspaceId: a })).status).toBe(404);
    expect((await call(hidden.api, "createUpstream", { workspaceId: b }, { name: uniq("p") })).status).toBe(201);
    // A grant in a workspace opens v2 there only.
    const granted = await h.as("viewer");
    expect((await h.api("POST", `/../v2/workspaces/${a}/role-bindings`, { subjectType: "user", subjectId: granted.id, role: "editor" })).status).toBe(201);
    expect((await call(granted.api, "createUpstream", { workspaceId: a }, { name: uniq("p") })).status).toBe(201);
    expect((await call(granted.api, "createUpstream", { workspaceId: b }, { name: uniq("p") })).status).toBe(403);
    // A token acts within its own role.
    const token = (await granted.api("POST", "/users/me/tokens", { name: uniq("t"), role: "viewer", expiresInDays: 1 })).body.token as string;
    const bearer: ApiClient = (method, path, body) => h.anonymous(method, path, body, { authorization: `Bearer ${token}` });
    expect((await call(bearer, "listUpstreams", { workspaceId: a })).status).toBe(200);
    expect((await call(bearer, "createUpstream", { workspaceId: a }, { name: uniq("p") })).status).toBe(403);
    const unknown = "00000000-0000-4000-8000-0000000000ff";
    expect((await call(h.api, "listServices", { workspaceId: unknown })).status).toBe(404);
  });

  it("exercised every implemented gateway-entity and workspace-reading operation", () => {
    const implemented = [...OPS.values()]
      .filter(({ path, op }) => !op["x-gromesh-planned"] && /^\/workspaces(\/\{workspaceId\})?(\/(services|routes|consumers|upstreams|certificates|plugins)(?!.*path-compatibility)|$)/.test(path))
      .map(({ op }) => op.operationId as string);
    expect(implemented.length).toBe(41);
    expect(implemented.filter((id) => !called.has(id))).toEqual([]);
  });
});
