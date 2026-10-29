import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../../src/db/migrate.js";
import { SnapshotsService } from "../../src/snapshots/snapshots.js";
import { type ApiClient, type ApiResponse, startHarness, uniq, type Harness } from "./harness.js";

// WS-M0/WS-M1: workspace administration through v2. A second workspace in the instance is created only while a
// disposable lab turns Workspaces mode on (the N2 block), only on dev, and only as the creation policy allows; creating
// one grants nothing, deploys nothing and never adjusts the slug. Archiving deletes nothing and makes it read-only.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://gromesh:gromesh@127.0.0.1:5432/gromesh";
const LAB = { stage: "dev" as const, convergenceDeadlineMs: 600_000 };
const created: string[] = [];

/** The instance row and the policy are instance-wide: each group gets its own migrated database. */
async function freshDatabase(label: string): Promise<string> {
  const name = `gromesh_wsm1_${label}_${Date.now()}_${process.pid}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  created.push(name);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  await runMigrations(url.toString());
  return url.toString();
}

afterAll(async () => {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  for (const name of created) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.end();
});

const v2 = (client: ApiClient, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<ApiResponse> => client(method, `/../v2${path}`, body, headers);
const count = async (h: Harness, table: string) => Number((await h.sql.query(`select count(*)::int as n from ${table}`)).rows[0].n);

describe("while Workspaces mode is disabled (the N2 block)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ databaseUrl: await freshDatabase("off"), instanceStage: "dev" });
  });
  afterAll(async () => h?.close());

  it("refuses every creation with 409 workspaces-mode-disabled before anything else, creating nothing", async () => {
    const before = await count(h, "workspaces");
    // The mode before the body (the contract's order): even an invalid body answers the mode.
    for (const body of [{ name: uniq("Off") }, { name: "x", slug: "api" }, { name: "x", slug: "INVALID" }, { nope: true }]) {
      const res = await v2(h.api, "POST", "/workspaces", body);
      expect([res.status, res.body.code], JSON.stringify(body)).toEqual([409, "workspaces-mode-disabled"]);
    }
    expect(await count(h, "workspaces")).toBe(before);
    expect((await h.sql.query("select count(*)::int as n from audit_events where action = 'workspace.create'")).rows[0].n).toBe(0);
  });

  it("tells the caller it cannot create, and still lets v1 create environments", async () => {
    const policy = await v2(h.api, "GET", "/workspace-creation-policy");
    expect(policy.body).toMatchObject({ mode: "restricted-request", creatorBecomesAdmin: false, updatedAt: null, workspacesMode: "disabled", stage: "dev", caller: { canCreate: false, canRequest: false, canDecide: false } });
    expect((await h.api("POST", "/environments", { name: uniq("v1") })).status).toBe(201);
  });
});

describe("outside dev", () => {
  it("refuses a creation on hml with 403, even in a lab", async () => {
    const h = await startHarness({ databaseUrl: await freshDatabase("hml"), workspacesDeployments: { ...LAB, stage: "hml" } });
    try {
      const res = await v2(h.api, "POST", "/workspaces", { name: uniq("Hml") });
      expect(res.status).toBe(403);
      expect(await count(h, "workspaces")).toBe(0);
    } finally {
      await h.close();
    }
  });
});

describe("in a dev lab", () => {
  let h: Harness;
  const grant = async (userId: string, permissions: string[]) =>
    expect((await v2(h.api, "POST", "/role-bindings", { subjectType: "user", subjectId: userId, permissions })).status).toBe(201);
  const setPolicy = async (mode: string, creatorBecomesAdmin = false) =>
    expect((await v2(h.api, "PUT", "/workspace-creation-policy", { mode, creatorBecomesAdmin })).status).toBe(200);

  beforeAll(async () => {
    h = await startHarness({ databaseUrl: await freshDatabase("lab"), workspacesDeployments: LAB });
  });
  afterAll(async () => h?.close());

  it("creates an empty workspace: derived slug as is, new identity, nothing granted, nothing deployed", async () => {
    const bindings = await count(h, "role_bindings");
    const res = await v2(h.api, "POST", "/workspaces", { name: "Recarga Pré-Paga", description: "Recargas" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: "Recarga Pré-Paga", description: "Recargas", slug: "recarga-pre-paga", status: "active", activeRelease: null, provisionedByPromotion: null });
    expect(res.body.key).not.toBe(res.body.id);
    expect((await v2(h.api, "GET", `/workspaces/${res.body.id}`)).body).toEqual(res.body);
    expect(await count(h, "role_bindings")).toBe(bindings);
    expect(await count(h, "deployments")).toBe(0);
    expect(await count(h, "releases")).toBe(0);
    expect((await h.sql.query("select count(*)::int as n from clusters where environment_id = $1", [res.body.id])).rows[0].n).toBe(0);
    const [event] = (await h.sql.query("select actor, after from audit_events where action = 'workspace.create' and entity_id = $1", [res.body.id])).rows;
    expect(event.after).toEqual(res.body);
  });

  it("never adjusts a slug: reserved or invalid is 422, taken is 409 with a suggestion only", async () => {
    const name = uniq("Pagamentos");
    const first = await v2(h.api, "POST", "/workspaces", { name, slug: "pagamentos" });
    expect(first.status).toBe(201);
    const taken = await v2(h.api, "POST", "/workspaces", { name: uniq("Outro"), slug: "pagamentos" });
    expect([taken.status, taken.body.code, taken.body.suggestedSlug, taken.body.errors[0].path]).toEqual([409, "slug-taken", "pagamentos-2", "slug"]);
    const derived = await v2(h.api, "POST", "/workspaces", { name: "Pagamentos" });
    expect([derived.status, derived.body.code]).toEqual([409, "slug-taken"]);
    const sameName = await v2(h.api, "POST", "/workspaces", { name, slug: "pagamentos-novos" });
    expect([sameName.status, sameName.body.code, sameName.body.errors[0].path]).toEqual([409, "name-taken", "name"]);
    for (const slug of ["api", "gromesh-x", "kong"]) {
      const res = await v2(h.api, "POST", "/workspaces", { name: uniq("R"), slug });
      expect([res.status, res.body.errors?.[0]?.path], slug).toEqual([422, "slug"]);
    }
    expect((await v2(h.api, "POST", "/workspaces", { name: "Ação!" })).body.slug).toBe("acao");
    expect((await h.sql.query("select count(*)::int as n from workspaces where slug like 'pagamentos%'")).rows[0].n).toBe(1);
  });

  it("decides the same slug for concurrent creations once", async () => {
    const results = await Promise.all([1, 2, 3].map((n) => v2(h.api, "POST", "/workspaces", { name: uniq(`Corrida ${n}`), slug: "corrida" })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
  });

  it("follows the policy: workspace.create is an explicit instance grant; admin-only is platform administration", async () => {
    const dev = await h.as("admin");
    // A v1 admin is a global admin; an environment admin is not: a viewer promoted in one environment.
    const lead = await h.as("viewer");
    const plain = await h.as("editor");
    expect((await v2(plain.api, "POST", "/workspaces", { name: uniq("Sem") })).status).toBe(403);
    expect((await v2(lead.api, "POST", "/workspaces", { name: uniq("Sem") })).status).toBe(403);
    // workspace.create is never granted inside a workspace.
    const ws = (await v2(h.api, "POST", "/workspaces", { name: uniq("Escopo") })).body.id as string;
    expect((await v2(h.api, "POST", `/workspaces/${ws}/role-bindings`, { subjectType: "user", subjectId: lead.id, permissions: ["workspace.create"] })).status).toBe(422);
    await grant(lead.id, ["workspace.create"]);
    for (const mode of ["restricted-request", "autonomous"]) {
      await setPolicy(mode);
      expect((await v2(lead.api, "POST", "/workspaces", { name: uniq(mode) })).status, mode).toBe(201);
      expect((await v2(lead.api, "GET", "/workspace-creation-policy")).body.caller, mode).toEqual({ canCreate: true, canRequest: false, canDecide: false });
    }
    await setPolicy("admin-only");
    expect((await v2(lead.api, "POST", "/workspaces", { name: uniq("AdminOnly") })).status).toBe(403);
    // The policy before the body: an invalid body from a caller the policy refuses is a 403, not a 422.
    expect((await v2(lead.api, "POST", "/workspaces", { name: "x", slug: "api" })).status).toBe(403);
    expect((await v2(lead.api, "GET", "/workspace-creation-policy")).body.caller).toEqual({ canCreate: false, canRequest: false, canDecide: false });
    expect((await v2(dev.api, "POST", "/workspaces", { name: uniq("AdminOnly") })).status).toBe(201);
    await setPolicy("restricted-request");
  });

  it("grants the creator workspace-admin only when the policy says so, and never to platform administration", async () => {
    const lead = await h.as("viewer");
    await grant(lead.id, ["workspace.create"]);
    const plain = (await v2(lead.api, "POST", "/workspaces", { name: uniq("Plain") })).body.id as string;
    expect((await v2(lead.api, "PATCH", `/workspaces/${plain}`, { description: "x" })).status).toBe(403);
    await setPolicy("autonomous", true);
    const own = (await v2(lead.api, "POST", "/workspaces", { name: uniq("Own") })).body.id as string;
    expect((await v2(lead.api, "PATCH", `/workspaces/${own}`, { description: "minha" })).status).toBe(200);
    const bindings = (await v2(h.api, "GET", `/workspaces/${own}/role-bindings`)).body as { role?: string; subjectId: string }[];
    expect(bindings.filter((b) => b.subjectId === lead.id).map((b) => b.role)).toEqual(["workspace-admin"]);
    const before = await count(h, "role_bindings");
    expect((await v2(h.api, "POST", "/workspaces", { name: uniq("ByAdmin") })).status).toBe(201);
    expect(await count(h, "role_bindings")).toBe(before);
    await setPolicy("restricted-request");
  });

  it("lets only platform administration, in a session, replace the policy, audited", async () => {
    const lead = await h.as("viewer");
    await grant(lead.id, ["workspace.create"]);
    expect((await v2(lead.api, "PUT", "/workspace-creation-policy", { mode: "autonomous", creatorBecomesAdmin: true })).status).toBe(403);
    const token = await h.api("POST", "/users/me/tokens", { name: uniq("t"), role: "admin", expiresInDays: 1 });
    expect(token.status).toBe(201);
    const bearer = { authorization: `Bearer ${token.body.token}` };
    // The same token reads the policy: only the session-only replacement refuses it.
    expect((await v2(h.anonymous, "GET", "/workspace-creation-policy", undefined, bearer)).status).toBe(200);
    expect((await v2(h.anonymous, "PUT", "/workspace-creation-policy", { mode: "autonomous", creatorBecomesAdmin: false }, bearer)).status).toBe(401);
    expect((await v2(h.api, "PUT", "/workspace-creation-policy", { mode: "open", creatorBecomesAdmin: false })).status).toBe(422);
    await Promise.all(["autonomous", "admin-only", "restricted-request", "autonomous"].map((mode) => v2(h.api, "PUT", "/workspace-creation-policy", { mode, creatorBecomesAdmin: false })));
    await setPolicy("restricted-request");
    const events = (await h.sql.query("select before, after from audit_events where action = 'workspace_creation_policy.update'")).rows;
    // Serialized: the replacements form one chain, each before being exactly one other's after (`at` is when each
    // transaction started, not the order they committed in).
    const key = (p: { mode: string; updatedAt: string | null }) => `${p.mode}@${p.updatedAt}`;
    const byBefore = new Map(events.map((e) => [key(e.before), e]));
    expect(byBefore.size).toBe(events.length);
    let step = events.find((e) => e.before.updatedAt === null);
    let walked = 0;
    while (step) {
      walked++;
      step = byBefore.get(key(step.after));
    }
    expect(walked).toBe(events.length);
    expect(events.length).toBeGreaterThan(0);
    expect(events.at(-1).after).toMatchObject({ mode: "restricted-request", creatorBecomesAdmin: false });
  });

  it("never reveals a workspace outside the caller's scope, in the list or by id", async () => {
    const hidden = (await v2(h.api, "POST", "/workspaces", { name: uniq("Oculto") })).body.id as string;
    const shown = (await v2(h.api, "POST", "/workspaces", { name: uniq("Visivel") })).body.id as string;
    const viewer = await h.as("viewer");
    expect((await h.api("PUT", `/users/${viewer.id}/environment-roles`, { items: [{ environmentId: hidden, role: "none" }] })).status).toBe(200);
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page: ApiResponse = await v2(viewer.api, "GET", `/workspaces?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      expect(page.status).toBe(200);
      ids.push(...page.body.items.map((w: { id: string }) => w.id));
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(ids).toContain(shown);
    expect(ids).not.toContain(hidden);
    // limit counts only what is returned, and no cursor ever names a workspace the caller may not read.
    let next: string | null = null;
    const seen: string[] = [];
    do {
      const page: ApiResponse = await v2(viewer.api, "GET", `/workspaces?limit=1${next ? `&cursor=${encodeURIComponent(next)}` : ""}`);
      expect(page.body.items.length).toBe(1);
      seen.push(page.body.items[0].id);
      next = page.body.nextCursor;
      if (next) expect(JSON.parse(Buffer.from(next, "base64url").toString("utf8")).id).toBe(page.body.items[0].id);
    } while (next);
    expect(seen).toEqual(ids);
    expect((await v2(viewer.api, "GET", `/workspaces/${hidden}`)).status).toBe(404);
    expect((await v2(viewer.api, "PATCH", `/workspaces/${hidden}`, { name: "x" })).status).toBe(404);
    // The same 404 as a workspace that does not exist.
    expect((await v2(viewer.api, "GET", "/workspaces/00000000-0000-4000-8000-000000000000")).body).toEqual((await v2(viewer.api, "GET", `/workspaces/${hidden}`)).body);
  });

  it("updates name and description only, keeping id, key and slug, audited", async () => {
    const w = (await v2(h.api, "POST", "/workspaces", { name: uniq("Antes") })).body;
    const other = (await v2(h.api, "POST", "/workspaces", { name: uniq("Outro") })).body;
    const res = await v2(h.api, "PATCH", `/workspaces/${w.id}`, { name: uniq("Depois"), description: "nova" });
    expect(res.status).toBe(200);
    expect([res.body.id, res.body.key, res.body.slug, res.body.description]).toEqual([w.id, w.key, w.slug, "nova"]);
    expect((await v2(h.api, "PATCH", `/workspaces/${w.id}`, { slug: "outro" })).status).toBe(422);
    const clash = await v2(h.api, "PATCH", `/workspaces/${w.id}`, { name: other.name });
    expect([clash.status, clash.body.code]).toEqual([409, "name-taken"]);
    const editor = await h.as("editor");
    expect((await v2(editor.api, "PATCH", `/workspaces/${w.id}`, { description: "x" })).status).toBe(403);
    // Concurrent renames of different workspaces to one free name: one wins, every other gets name-taken.
    const racers = await Promise.all([1, 2, 3].map(async (n) => (await v2(h.api, "POST", "/workspaces", { name: uniq(`Racer ${n}`) })).body.id as string));
    const target = uniq("Disputado");
    const renames = await Promise.all(racers.map((id) => v2(h.api, "PATCH", `/workspaces/${id}`, { name: target })));
    expect(renames.map((r) => [r.status, r.body.code ?? null]).sort()).toEqual([[200, null], [409, "name-taken"], [409, "name-taken"]]);
    const [event] = (await h.sql.query("select before, after from audit_events where action = 'workspace.update' and entity_id = $1", [w.id])).rows;
    expect([event.before.name, event.after.name]).toEqual([w.name, res.body.name]);
  });

  it("archives deleting nothing, refuses while something may be served, and leaves the workspace read-only", async () => {
    const w = (await v2(h.api, "POST", "/workspaces", { name: uniq("Arquivo") })).body;
    const service = await h.api("POST", `/environments/${w.id}/services`, { name: "svc", protocol: "http", host: "example.com", port: 80 });
    expect(service.status).toBe(201);
    // Only platform administration archives (a workspace admin does not).
    const lead = await h.as("viewer");
    expect((await h.api("PUT", `/users/${lead.id}/environment-roles`, { items: [{ environmentId: w.id, role: "admin" }] })).status).toBe(200);
    expect((await v2(lead.api, "POST", `/workspaces/${w.id}/archive`)).status).toBe(403);

    const withCluster = (await v2(h.api, "POST", "/workspaces", { name: uniq("ComCluster") })).body;
    expect((await h.api("POST", `/environments/${withCluster.id}/clusters`, { name: "c1" })).status).toBe(201);
    expect((await v2(h.api, "POST", `/workspaces/${withCluster.id}/archive`)).body.code).toBe("clusters");
    const published = (await v2(h.api, "POST", "/workspaces", { name: uniq("Publicado") })).body;
    expect((await h.api("POST", `/environments/${published.id}/snapshots`, {})).status).toBe(201);
    expect((await v2(h.api, "POST", `/workspaces/${published.id}/archive`)).body.code).toBe("published-configuration");
    for (const id of [withCluster.id, published.id]) expect((await v2(h.api, "GET", `/workspaces/${id}`)).body.status).toBe("active");

    // A release published and deployed is still served: refused while active, and while the latest revision has it.
    const deployed = (await v2(h.api, "POST", "/workspaces", { name: uniq("Implantado") })).body;
    expect((await v2(h.api, "POST", `/workspaces/${deployed.id}/releases`, { message: "r1" })).status).toBe(201);
    expect((await v2(h.api, "POST", `/workspaces/${deployed.id}/archive`)).body.code).toBe("active-release");
    expect((await v2(h.api, "POST", "/deployments", { expectedRevision: null, reason: "ws-m1" })).status).toBe(201);
    await h.sql.query("delete from workspace_active_release where workspace_id = $1", [deployed.id]);
    expect((await v2(h.api, "POST", `/workspaces/${deployed.id}/archive`)).body.code).toBe("deployed");
    // Simulated node evidence: only a converged revision without it withdraws it (a failed apply keeps the one before).
    const converge = async (revision: number) =>
      h.sql.query("insert into deployment_states (epoch, revision, seq, state, reason) select epoch, revision, coalesce(max(seq), 0) + 1, 'converged', 'test' from deployment_states where revision = $1 group by epoch, revision", [revision]);
    const r1 = Number((await h.sql.query("select max(revision)::int as r from deployments")).rows[0].r);
    await converge(r1);
    expect((await v2(h.api, "POST", `/workspaces/${deployed.id}/archive`)).body.code).toBe("deployed");
    await h.sql.query("update deployment_lease set revision = null, operation = null, owner = null, started_at = null, deadline_at = null");
    // The next revision composes another workspace's release, not this one.
    const keeper = (await v2(h.api, "POST", "/workspaces", { name: uniq("Mantido") })).body.id as string;
    expect((await v2(h.api, "POST", `/workspaces/${keeper}/releases`, { message: "k1" })).status).toBe(201);
    const second = await v2(h.api, "POST", "/deployments", { expectedRevision: r1, reason: "without it" });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect((await v2(h.api, "POST", `/workspaces/${deployed.id}/archive`)).body.code).toBe("deployed");
    await converge(r1 + 1);
    expect((await v2(h.api, "POST", `/workspaces/${deployed.id}/archive`)).status).toBe(204);

    expect((await v2(h.api, "POST", `/workspaces/${w.id}/archive`)).status).toBe(204);
    expect((await v2(h.api, "POST", `/workspaces/${w.id}/archive`)).status).toBe(204);
    expect((await h.sql.query("select count(*)::int as n from audit_events where action = 'workspace.archive' and entity_id = $1", [w.id])).rows[0].n).toBe(1);
    expect((await v2(h.api, "GET", `/workspaces/${w.id}`)).body.status).toBe("archived");
    // Nothing deleted, everything readable; every mutation in its scope refused, v1 or v2.
    expect((await h.api("GET", `/environments/${w.id}/services`)).body.items.map((s: { name: string }) => s.name)).toEqual(["svc"]);
    for (const [res, what] of [
      [await v2(h.api, "PATCH", `/workspaces/${w.id}`, { description: "x" }), "v2 update"],
      [await h.api("POST", `/environments/${w.id}/services`, { name: "svc2", protocol: "http", host: "example.com", port: 80 }), "v1 create"],
      [await h.api("DELETE", `/environments/${w.id}/services/${service.body.id}`), "v1 delete"],
      [await h.api("DELETE", `/environments/${w.id}`), "v1 environment delete"],
    ] as const) expect([res.status, res.body?.code], what).toEqual([409, "workspace-archived"]);
    // v1 roles in an archived workspace: no new access, only none (the deny).
    expect((await h.api("PUT", `/users/${lead.id}/environment-roles`, { items: [{ environmentId: w.id, role: "editor" }] })).body.code).toBe("workspace-archived");
    expect((await h.api("PUT", `/users/${lead.id}/environment-roles`, { items: [{ environmentId: w.id, role: "none" }] })).status).toBe(200);
    expect((await v2(h.api, "POST", `/workspaces/${w.id}/role-bindings`, { subjectType: "user", subjectId: lead.id, role: "viewer" })).body.code).toBe("workspace-archived");

    // A write the guard let through before an archive committed is refused in its own transaction.
    const racing = (await v2(h.api, "POST", "/workspaces", { name: uniq("Corrida") })).body.id as string;
    const archiver = await h.sql.connect();
    try {
      await archiver.query("begin");
      // What archiveWorkspace does: the exclusive archive lock, then its rows.
      await archiver.query("select pg_advisory_xact_lock($1, hashtext($2::uuid::text))", [0x67727761, racing]);
      await archiver.query("select 1 from environments e join workspaces w on w.id = e.id where e.id = $1 for no key update", [racing]);
      await archiver.query("update workspaces set status = 'archived' where id = $1", [racing]);
      // The same workspace written in capitals: the same lock.
      const write = h.api("POST", `/environments/${racing.toUpperCase()}/services`, { name: "late", protocol: "http", host: "example.com", port: 80 });
      await new Promise((r) => setTimeout(r, 500));
      await archiver.query("commit");
      const late = await write;
      expect([late.status, late.body.code]).toEqual([409, "workspace-archived"]);
    } finally {
      archiver.release();
    }
    expect((await h.sql.query("select count(*)::int as n from services where environment_id = $1", [racing])).rows[0].n).toBe(0);

    // The v1 auto-publisher never publishes the pending draft of an archived workspace.
    const auto = (await v2(h.api, "POST", "/workspaces", { name: uniq("Auto") })).body.id as string;
    expect((await v2(h.api, "POST", `/workspaces/${auto}/archive`)).status).toBe(204);
    await h.sql.query("update environments set publish_mode = 'auto', has_unpublished_changes = true, draft_changed_at = now() - interval '1 hour' where id = $1", [auto]);
    await h.app.get(SnapshotsService).autoPublish(auto, 0);
    expect((await h.sql.query("select count(*)::int as n from snapshots where environment_id = $1", [auto])).rows[0].n).toBe(0);

    // Archiving while v1 roles, v2 grants and draft edits race in the same workspace: never a 500 (no lock cycle).
    for (let round = 0; round < 8; round++) {
      const target = (await v2(h.api, "POST", "/workspaces", { name: uniq("Ciclo") })).body.id as string;
      const someone = await h.as("viewer");
      const results = await Promise.all([
        h.api("PUT", `/users/${someone.id}/environment-roles`, { items: [{ environmentId: target, role: "editor" }] }),
        v2(h.api, "POST", `/workspaces/${target}/role-bindings`, { subjectType: "user", subjectId: someone.id, role: "viewer" }),
        h.api("POST", `/environments/${target}/consumers`, { username: uniq("c") }),
        // A publish (it locks the environment, then updates the workspace row) beside a cluster creation (review r5).
        v2(h.api, "POST", `/workspaces/${target}/releases`, { message: "ciclo" }),
        h.api("POST", `/environments/${target}/clusters`, { name: uniq("c") }),
        v2(h.api, "POST", `/workspaces/${target}/archive`),
      ]);
      for (const r of results) expect(r.status, JSON.stringify(r.body)).toBeLessThan(500);
    }

    // Revoking access stays possible there.
    const binding = await v2(h.api, "POST", `/workspaces/${withCluster.id}/role-bindings`, { subjectType: "user", subjectId: lead.id, role: "viewer" });
    expect(binding.status).toBe(201);
    await h.sql.query("update workspaces set status = 'archived' where id = $1", [withCluster.id]);
    expect((await v2(h.api, "POST", `/role-bindings/${binding.body.id}/revoke`)).status).toBe(204);
  });
});
