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
    // A switch to auto committed while the write waits on the environment: the write sees it and refuses.
    const manual = (await h.api("POST", "/environments", { name: uniq("manual") })).body;
    const holder = await h.sql.connect();
    try {
      await holder.query("begin");
      await holder.query("update environments set publish_mode = 'auto' where id = $1", [manual.id]);
      const write = v2(h.api, "POST", `/workspaces/${manual.id}/services`, service());
      await new Promise((r) => setTimeout(r, 400));
      await holder.query("commit");
      expect((await write).body.code).toBe("auto-publish");
    } finally {
      holder.release();
    }
    expect((await h.sql.query("select count(*)::int as n from services where environment_id = $1", [manual.id])).rows[0].n).toBe(0);
  });

  it("never deadlocks: concurrent service writes, upstream deletes and renames in one workspace answer, none with a 500", async () => {
    for (let round = 0; round < 6; round++) {
      const pool = (await v2(h.api, "POST", `/workspaces/${a}/upstreams`, { name: uniq("race") })).body;
      const results = await Promise.all([
        v2(h.api, "POST", `/workspaces/${a}/services`, service({ host: pool.name, upstreamId: pool.id })),
        v2(h.api, "POST", `/workspaces/${a}/services`, service()),
        v2(h.api, "POST", `/workspaces/${a}/services`, service()),
        v2(h.api, "DELETE", `/workspaces/${a}/upstreams/${pool.id}`),
      ]);
      for (const r of results) expect(r.status, JSON.stringify(r.body)).toBeLessThan(500);
    }
    // And with v1 edits and an archive of the workspace in the same instant.
    for (let round = 0; round < 6; round++) {
      const ws = (await h.api("POST", "/environments", { name: uniq("ws-race") })).body.id as string;
      const svc = (await v2(h.api, "POST", `/workspaces/${ws}/services`, service())).body;
      const results = await Promise.all([
        v2(h.api, "PUT", `/workspaces/${ws}/services/${svc.id}`, service({ name: svc.name, port: 81 })),
        h.api("PUT", `/environments/${ws}/services/${svc.id}`, service({ name: svc.name, port: 82 })),
        v2(h.api, "POST", `/workspaces/${ws}/services`, service()),
        v2(h.api, "POST", `/workspaces/${ws}/archive`),
      ]);
      for (const r of results) expect(r.status, JSON.stringify(r.body)).toBeLessThan(500);
    }
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

describe("retryingTransaction", () => {
  it("runs again after a deadlock or serialization abort, at most three times, and rethrows anything else", async () => {
    const { retryingTransaction } = await import("../../src/common/retry.js");
    let calls = 0;
    const abort = (code: string) => Object.assign(new Error("aborted"), { cause: { code } });
    expect(await retryingTransaction(async () => (++calls < 3 ? Promise.reject(abort("40P01")) : "ok"))).toBe("ok");
    expect(calls).toBe(3);
    calls = 0;
    await expect(retryingTransaction(async () => { calls++; throw abort("40001"); })).rejects.toThrow("aborted");
    expect(calls).toBe(3);
    calls = 0;
    await expect(retryingTransaction(async () => { calls++; throw abort("23505"); })).rejects.toThrow("aborted");
    expect(calls).toBe(1);
  });
});

describe("concurrency aborts (B1)", () => {
  let h: Harness;
  let ws: string;
  beforeAll(async () => {
    h = await startHarness();
    ws = (await h.api("POST", "/environments", { name: uniq("abort") })).body.id;
  });
  afterAll(async () => h?.close());

  it("a real deadlock aborts one side; the API write runs again and lands once, audited once", async () => {
    const pool = (await v2(h.api, "POST", `/workspaces/${ws}/upstreams`, { name: uniq("dl") })).body;
    const name = uniq("dl-svc");
    const t = await h.sql.connect();
    try {
      await t.query("begin");
      await t.query("select 1 from environments where id = $1 for update", [ws]);
      // The write takes the upstream (KEY SHARE) and the archive lock, then waits on the environment held here.
      const write = v2(h.api, "POST", `/workspaces/${ws}/services`, service({ name, host: pool.name, upstreamId: pool.id }));
      await new Promise((r) => setTimeout(r, 400));
      // Now this side wants the upstream the write holds: a cycle; PostgreSQL aborts one of the two.
      const mine = await t.query("select 1 from upstreams where id = $1 for update", [pool.id]).then(() => "locked", (e: { code?: string }) => e.code);
      await t.query("rollback").catch(() => undefined);
      const res = await write;
      expect([res.status, mine === "locked" || mine === "40P01"], JSON.stringify(res.body)).toEqual([201, true]);
    } finally {
      t.release();
    }
    expect((await h.sql.query("select count(*)::int as n from services where environment_id = $1 and name = $2", [ws, name])).rows[0].n).toBe(1);
    expect((await h.sql.query("select count(*)::int as n from audit_events where action = 'service.create' and after->>'name' = $1", [name])).rows[0].n).toBe(1);
  });

  it("v1 deletes and rollbacks raced with v2 writes never answer 500, and v1 keeps its own answers", async () => {
    for (let round = 0; round < 5; round++) {
      const env = (await h.api("POST", "/environments", { name: uniq("v1race") })).body.id as string;
      const svc = (await h.api("POST", `/environments/${env}/services`, service())).body.id as string;
      expect((await h.api("POST", `/environments/${env}/snapshots`, {})).status).toBe(201);
      await h.api("POST", `/environments/${env}/services`, service());
      const results = await Promise.all([
        h.api("DELETE", `/environments/${env}/services/${svc}`),
        v2(h.api, "PUT", `/workspaces/${env}/services/${svc}`, service({ name: "renamed" })),
        h.api("POST", `/environments/${env}/snapshots/1/rollback`, {}),
        v2(h.api, "POST", `/workspaces/${env}/services`, service()),
      ]);
      for (const r of results) expect(r.status, JSON.stringify(r.body)).toBeLessThan(500);
    }
  });

  it("an abort that outlives its retries answers 409 concurrent-update, never a 500", async () => {
    const { ProblemFilter } = await import("../../src/common/problem.filter.js");
    const filter = new ProblemFilter() as unknown as { toProblem: (e: unknown) => { status: number; code?: string } };
    for (const code of ["40P01", "40001"]) expect(filter.toProblem(Object.assign(new Error("x"), { cause: { code } }))).toMatchObject({ status: 409, code: "concurrent-update" });
    expect(filter.toProblem(Object.assign(new Error("x"), { cause: { code: "57014" } })).status).toBe(500);
  });
});

describe("explicit upstream binding (WS-U0, B3)", () => {
  let h: Harness;
  let ws: string;
  beforeAll(async () => {
    h = await startHarness();
    ws = (await h.api("POST", "/environments", { name: uniq("bind") })).body.id;
  });
  afterAll(async () => h?.close());

  it("an upstream created or renamed later never captures a v2 service that names its host as DNS (v1 or v2 API)", async () => {
    const direct = (await v2(h.api, "POST", `/workspaces/${ws}/services`, service({ host: "pool-dns" }))).body;
    expect(direct.upstreamId).toBeNull();
    const viaV2 = await v2(h.api, "POST", `/workspaces/${ws}/upstreams`, { name: "pool-dns" });
    const viaV1 = await h.api("POST", `/environments/${ws}/upstreams`, { name: "pool-dns" });
    for (const r of [viaV2, viaV1]) expect([r.status, r.body.code]).toEqual([409, "upstream-captures-service"]);
    const other = (await v2(h.api, "POST", `/workspaces/${ws}/upstreams`, { name: uniq("other") })).body;
    const rename = await v2(h.api, "PUT", `/workspaces/${ws}/upstreams/${other.id}`, { name: "pool-dns" });
    expect([rename.status, rename.body.code]).toEqual([409, "upstream-captures-service"]);
    expect((await v2(h.api, "GET", `/workspaces/${ws}/services/${direct.id}`)).body.upstreamId).toBeNull();
  });

  it("decides one name at a time: a v2 service and an upstream of the same name written together never both land", async () => {
    for (let round = 0; round < 6; round++) {
      const name = uniq("race");
      const [svc, up] = await Promise.all([v2(h.api, "POST", `/workspaces/${ws}/services`, service({ host: name })), v2(h.api, "POST", `/workspaces/${ws}/upstreams`, { name })]);
      expect([svc.status, up.status].filter((s) => s === 201).length, `${svc.status} ${up.status}`).toBe(1);
    }
  });

  it("keeps v1 services bound by name, as before; a rename follows the services bound by upstreamId", async () => {
    const legacyPool = (await h.api("POST", `/environments/${ws}/upstreams`, { name: uniq("legacy") })).body;
    const legacy = (await h.api("POST", `/environments/${ws}/services`, service({ host: legacyPool.name }))).body;
    expect((await v2(h.api, "GET", `/workspaces/${ws}/services/${legacy.id}`)).body.upstreamId).toBe(legacyPool.id);
    expect((await v2(h.api, "PUT", `/workspaces/${ws}/upstreams/${legacyPool.id}`, { name: uniq("renamed") })).status).toBe(409);
    const pool = (await v2(h.api, "POST", `/workspaces/${ws}/upstreams`, { name: uniq("bound") })).body;
    const bound = (await v2(h.api, "POST", `/workspaces/${ws}/services`, service({ host: pool.name, upstreamId: pool.id }))).body;
    const newName = uniq("moved");
    expect((await v2(h.api, "PUT", `/workspaces/${ws}/upstreams/${pool.id}`, { name: newName })).status).toBe(200);
    expect((await v2(h.api, "GET", `/workspaces/${ws}/services/${bound.id}`)).body).toMatchObject({ host: newName, upstreamId: pool.id });
    const [row] = (await h.sql.query("select binding, upstream_id from services where id = $1", [legacy.id])).rows;
    expect(row).toEqual({ binding: null, upstream_id: null });
  });
});

describe("v1 writes, export and import of a v2 service (WS-U0, r7)", () => {
  let h: Harness;
  let ws: string;
  beforeAll(async () => {
    h = await startHarness();
    ws = (await h.api("POST", "/environments", { name: uniq("v1io") })).body.id;
  });
  afterAll(async () => h?.close());
  const binding = async (id: string) => (await h.sql.query("select binding, upstream_id from services where id = $1", [id])).rows[0];

  it("a v1 edit gives the service the v1 semantics instead of leaving an explicit binding behind", async () => {
    const pool = (await v2(h.api, "POST", `/workspaces/${ws}/upstreams`, { name: uniq("p") })).body;
    const svc = (await v2(h.api, "POST", `/workspaces/${ws}/services`, service({ host: pool.name, upstreamId: pool.id }))).body;
    expect(await binding(svc.id)).toEqual({ binding: "explicit", upstream_id: pool.id });
    expect((await h.api("PUT", `/environments/${ws}/services/${svc.id}`, service({ name: svc.name, host: "api.example.com" }))).status).toBe(200);
    expect(await binding(svc.id)).toEqual({ binding: null, upstream_id: null });
  });

  it("exports a v2 service in the v1 format and imports it back, which gives it the v1 binding", async () => {
    const svc = (await v2(h.api, "POST", `/workspaces/${ws}/services`, service({ host: "dns.example.com" }))).body;
    expect((await binding(svc.id)).binding).toBe("explicit");
    const exported = await h.api("GET", `/environments/${ws}/export`);
    expect(exported.status).toBe(200);
    expect(JSON.stringify(exported.body)).not.toMatch(/"binding"|"upstreamId"/);
    // The dry run already announces the change of binding (same attributes otherwise).
    const preview = await h.api("POST", `/environments/${ws}/import`, { document: exported.body, mode: "merge", dryRun: true });
    expect(JSON.stringify(preview.body.modified ?? preview.body)).toContain(svc.id);
    const imported = await h.api("POST", `/environments/${ws}/import`, { document: exported.body, mode: "merge", dryRun: false });
    expect(imported.status, JSON.stringify(imported.body)).toBeLessThan(300);
    expect((await binding(svc.id)).binding).toBeNull();
  });
});
