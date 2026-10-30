import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ApiClient, type ApiResponse, startHarness, uniq, type Harness } from "./harness.js";

// WS-R1: writing services through /api/v2. The same service layer as v1 (decision H-9), scoped to the workspace: a
// service is of one workspace, refers to an upstream only by upstreamId and only of its own workspace, accepts a
// VarRef only where the contract allows it (and, while no variable can be declared, refuses it), and edits the draft
// without publishing or deploying anything.
const v2 = (client: ApiClient, method: string, path: string, body?: unknown): Promise<ApiResponse> => client(method, `/../v2${path}`, body);
const service = (over: Record<string, unknown> = {}) => ({ name: uniq("svc"), protocol: "http", host: "orders.example.com", port: 8080, ...over });

describe("services through /api/v2 (WS-R1)", () => {
  let h: Harness;
  let a: string;
  let b: string;
  beforeAll(async () => {
    h = await startHarness();
    a = (await h.api("POST", "/environments", { name: uniq("ws-a") })).body.id;
    b = (await h.api("POST", "/environments", { name: uniq("ws-b") })).body.id;
  });
  afterAll(async () => h?.close());

  it("creates a service of one workspace only, audited, without publishing or deploying", async () => {
    const snapshots = (await h.sql.query("select count(*)::int as n from snapshots where environment_id = $1", [a])).rows[0].n;
    const res = await v2(h.api, "POST", `/workspaces/${a}/services`, service({ path: "/v1" }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ workspaceId: a, upstreamId: null, host: "orders.example.com", port: 8080, path: "/v1" });
    expect((await v2(h.api, "GET", `/workspaces/${a}/services/${res.body.id}`)).body).toEqual(res.body);
    expect((await v2(h.api, "GET", `/workspaces/${b}/services/${res.body.id}`)).status).toBe(404);
    expect((await v2(h.api, "GET", `/workspaces/${b}/services`)).body.items.map((s: { id: string }) => s.id)).not.toContain(res.body.id);
    // The v1 view of the same row.
    expect((await h.api("GET", `/environments/${a}/services/${res.body.id}`)).body.name).toBe(res.body.name);
    const [env] = (await h.sql.query("select has_unpublished_changes, current_version from environments where id = $1", [a])).rows;
    expect(env.has_unpublished_changes).toBe(true);
    expect((await h.sql.query("select count(*)::int as n from snapshots where environment_id = $1", [a])).rows[0].n).toBe(snapshots);
    expect((await h.sql.query("select count(*)::int as n from deployments")).rows[0].n).toBe(0);
    const [event] = (await h.sql.query("select after from audit_events where action = 'service.create' and entity_id = $1", [res.body.id])).rows;
    expect(event.after.name).toBe(res.body.name);
  });

  it("replaces a service, keeping its id, and refuses a duplicate name in the workspace only", async () => {
    const first = (await v2(h.api, "POST", `/workspaces/${a}/services`, service())).body;
    const replaced = await v2(h.api, "PUT", `/workspaces/${a}/services/${first.id}`, service({ name: first.name, port: 9090 }));
    expect([replaced.status, replaced.body.id, replaced.body.port]).toEqual([200, first.id, 9090]);
    expect((await v2(h.api, "POST", `/workspaces/${a}/services`, service({ name: first.name }))).status).toBe(409);
    // The same name in another workspace is another service.
    expect((await v2(h.api, "POST", `/workspaces/${b}/services`, service({ name: first.name }))).status).toBe(201);
    expect((await v2(h.api, "PUT", `/workspaces/${b}/services/${first.id}`, service())).status).toBe(404);
  });

  it("refers to an upstream only by upstreamId, and only to one of its own workspace", async () => {
    const own = (await v2(h.api, "POST", `/workspaces/${a}/upstreams`, { name: uniq("pool") })).body;
    const foreign = (await v2(h.api, "POST", `/workspaces/${b}/upstreams`, { name: uniq("pool") })).body;
    const linked = await v2(h.api, "POST", `/workspaces/${a}/services`, service({ host: own.name, upstreamId: own.id }));
    expect([linked.status, linked.body.upstreamId]).toEqual([201, own.id]);
    expect((await v2(h.api, "GET", `/workspaces/${a}/services`)).body.items.find((s: { id: string }) => s.id === linked.body.id).upstreamId).toBe(own.id);
    const cross = await v2(h.api, "POST", `/workspaces/${a}/services`, service({ host: foreign.name, upstreamId: foreign.id }));
    expect([cross.status, cross.body.errors[0].path]).toEqual([422, "upstreamId"]);
    const mismatch = await v2(h.api, "POST", `/workspaces/${a}/services`, service({ host: "other.example.com", upstreamId: own.id }));
    expect([mismatch.status, mismatch.body.errors[0].path]).toEqual([422, "host"]);
    const byHost = await v2(h.api, "POST", `/workspaces/${a}/services`, service({ host: own.name }));
    expect([byHost.status, byHost.body.errors[0].path]).toEqual([422, "upstreamId"]);
    // A foreign upstream's name as a plain host is just a DNS name in this workspace (nothing of B is referenced).
    expect((await v2(h.api, "POST", `/workspaces/${a}/services`, service({ host: foreign.name }))).body.upstreamId).toBeNull();
  });

  it("refuses a VarRef (no variable can be declared yet), a reserved host and a forbidden destination", async () => {
    for (const [field, value] of [["host", { $var: "ORDERS_HOST" }], ["port", { $var: "ORDERS_PORT" }], ["path", { $var: "BASE_PATH" }], ["protocol", { $var: "SCHEME" }]] as const) {
      const res = await v2(h.api, "POST", `/workspaces/${a}/services`, service({ [field]: value }));
      expect([res.status, res.body.errors?.[0]?.path], field).toEqual([422, field]);
      expect(res.body.errors[0].message).toContain("not declared");
    }
    // Where the contract allows no VarRef at all, the schema refuses it.
    expect((await v2(h.api, "POST", `/workspaces/${a}/services`, service({ name: { $var: "NAME" } }))).status).toBe(422);
    expect((await v2(h.api, "POST", `/workspaces/${a}/services`, service({ host: "x.gromesh.internal" }))).body.errors[0].path).toBe("host");
    expect((await v2(h.api, "POST", `/workspaces/${a}/services`, service({ host: "169.254.169.254" }))).body.errors[0].path).toBe("host");
  });

  it("never writes through v2 where v1 auto-publishes the draft", async () => {
    const auto = (await h.api("POST", "/environments", { name: uniq("auto"), publishMode: "auto" })).body.id as string;
    const res = await v2(h.api, "POST", `/workspaces/${auto}/services`, service());
    expect([res.status, res.body.code]).toEqual([409, "auto-publish"]);
    expect((await h.sql.query("select count(*)::int as n from services where environment_id = $1", [auto])).rows[0].n).toBe(0);
  });

  it("holds the named upstream until the write commits: a delete in between waits, then is refused", async () => {
    const pool = (await v2(h.api, "POST", `/workspaces/${a}/upstreams`, { name: uniq("held") })).body;
    const linked = await v2(h.api, "POST", `/workspaces/${a}/services`, service({ host: pool.name, upstreamId: pool.id }));
    expect(linked.status).toBe(201);
    // Deleting it now: refused while a service uses it.
    expect((await v2(h.api, "DELETE", `/workspaces/${a}/upstreams/${pool.id}`)).status).toBe(409);
  });

  it("needs gateway.write in the workspace: a viewer is refused, a workspace it cannot see is not found", async () => {
    const viewer = await h.as("viewer");
    expect((await v2(viewer.api, "POST", `/workspaces/${a}/services`, service())).status).toBe(403);
    const editor = await h.as("editor");
    expect((await h.api("PUT", `/users/${editor.id}/environment-roles`, { items: [{ environmentId: b, role: "none" }] })).status).toBe(200);
    expect((await v2(editor.api, "POST", `/workspaces/${a}/services`, service())).status).toBe(201);
    expect((await v2(editor.api, "POST", `/workspaces/${b}/services`, service())).status).toBe(404);
  });
});
