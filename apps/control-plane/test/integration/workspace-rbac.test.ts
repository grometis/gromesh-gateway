import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { RANK, type Role } from "../../src/auth/environment-access.js";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { BUILTIN_ROLES, LEGACY_CLUSTERS, legacyPermissions, PERMISSIONS, permissionsIn, requiredPermission, tokenPermissions } from "../../src/auth/permissions.js";
import * as schema from "../../src/db/schema.js";
import { users } from "../../src/db/schema.js";
import { type ApiResponse, startHarness, uniq, type Harness } from "./harness.js";

// N1-C3: one authorization for both APIs (decision H-9). v1 roles are translated to v2 permissions; v2 role bindings
// add to them; the same guard decides v1 and v2 operations.
const v2 = parse(readFileSync(new URL("../../../../contracts/control-plane-v2.openapi.yaml", import.meta.url), "utf8")) as { info: Record<string, unknown> };
const ROLES: Role[] = ["viewer", "editor", "admin"];

describe("the permission model", () => {
  it("is the contract's catalog and built-in roles", () => {
    // M2M permissions belong to M2M clients only, never to a person's binding.
    const m2m = new Set(v2.info["x-gromesh-m2m-permissions"] as string[]);
    expect([...PERMISSIONS].sort()).toEqual((v2.info["x-gromesh-permissions"] as string[]).filter((p) => !m2m.has(p)).sort());
    const roles = v2.info["x-gromesh-builtin-roles"] as Record<string, string[]>;
    expect(Object.keys(BUILTIN_ROLES).sort()).toEqual(Object.keys(roles).sort());
    for (const [name, permissions] of Object.entries(roles)) expect([...BUILTIN_ROLES[name as keyof typeof BUILTIN_ROLES]].sort(), name).toEqual([...permissions].sort());
  });

  it("translates the v1 ladder exactly: a role reaches a requirement iff it holds its permission, in and out of a workspace", () => {
    for (const inWorkspace of [true, false]) {
      for (const role of ROLES) {
        for (const required of ROLES) {
          const held = new Set(legacyPermissions(role, !inWorkspace && role === "admin"));
          expect(held.has(requiredPermission(required, inWorkspace)), `${role} vs ${required}, workspace ${inWorkspace}`).toBe(RANK[role] >= RANK[required]);
        }
      }
    }
  });

  it("lets every v1 role at or above editor publish and roll back, and nobody below", () => {
    for (const role of ROLES) {
      const held = new Set(legacyPermissions(role, false));
      for (const p of ["release.publish", "release.rollback"] as const) expect(held.has(p), `${role}: ${p}`).toBe(RANK[role] >= RANK.editor);
      expect(held.has(LEGACY_CLUSTERS), `${role}: clusters`).toBe(role === "admin");
    }
  });

  it("makes min(token role, owner role) exactly the intersection of their permissions", () => {
    for (const token of ROLES) {
      for (const owner of ROLES) {
        for (const globalAdmin of [false, true]) {
          const own = new Set(legacyPermissions(owner, globalAdmin && owner === "admin"));
          const min = RANK[token] <= RANK[owner] ? token : owner;
          const expected = new Set(legacyPermissions(min, min === "admin" && globalAdmin && owner === "admin"));
          expect(tokenPermissions(token, own), `${token} token, ${owner} owner`).toEqual(expected);
        }
      }
    }
  });
});

describe("role bindings through /api/v2, honored by v1 and v2 alike", () => {
  let h: Harness;
  let v2api: (client: Harness["api"], method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<ApiResponse>;

  beforeAll(async () => {
    h = await startHarness();
    // The harness's clients speak /api/v1; v2 paths are reached through it.
    v2api = (client, method, path, body, headers) => client(method, `/../v2${path}`, body, headers);
  });
  afterAll(async () => {
    await h?.close();
  });

  const env = async () => (await h.api("POST", "/environments", { name: uniq("rbac") })).body.id as string;
  const user = async (role: Role, overrides: { env: string; role: Role | "none" }[] = []) => {
    const u = await h.as(role);
    if (overrides.length) expect((await h.api("PUT", `/users/${u.id}/environment-roles`, { items: overrides.map((o) => ({ environmentId: o.env, role: o.role })) })).status).toBe(200);
    return u;
  };

  it("lists the built-in roles to whoever reads members", async () => {
    const viewer = await user("viewer");
    const roles = await v2api(viewer.api, "GET", "/roles");
    expect(roles.status).toBe(200);
    expect(roles.body.map((r: { name: string }) => r.name).sort()).toEqual(Object.keys(BUILTIN_ROLES).sort());
    expect(roles.body.every((r: { builtin: boolean; id: string }) => r.builtin && /^[0-9a-f-]{36}$/.test(r.id))).toBe(true);
    expect((await v2api(h.anonymous, "GET", "/roles")).status).toBe(401);
  });

  it("lets a workspace admin grant within the workspace; the grant opens v1 and v2 there at once, and its revocation closes them", async () => {
    const a = await env();
    const admin = await user("viewer", [{ env: a, role: "admin" }]);
    const plain = await user("viewer");
    const service = () => plain.api("POST", `/environments/${a}/services`, { name: uniq("svc"), protocol: "http", host: "a.example.com", port: 80 });
    expect((await service()).status).toBe(403);
    const created = await v2api(admin.api, "POST", `/workspaces/${a}/role-bindings`, { subjectType: "user", subjectId: plain.id, role: "editor" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ scope: { type: "workspace", workspaceId: a }, subjectType: "user", subjectId: plain.id, effect: "allow", origin: "v2", role: "editor", grantedBy: admin.id, revokedAt: null });
    // The same guard decides v1: the binding makes it an editor of the environment, there only.
    expect((await service()).status).toBe(201);
    const b = await env();
    expect((await plain.api("POST", `/environments/${b}/services`, { name: uniq("svc"), protocol: "http", host: "a.example.com", port: 80 })).status).toBe(403);
    // Editor is not publisher: no publishing through v1 either (v2 needs release.publish).
    expect((await plain.api("POST", `/environments/${a}/snapshots`, {})).status).toBe(403);
    // Revoked: the very next request is decided without it.
    expect((await v2api(admin.api, "POST", `/role-bindings/${created.body.id}/revoke`)).status).toBe(204);
    expect((await service()).status).toBe(403);
    const audit = (await h.sql.query(`select action from audit_events where entity_id = $1 order by at`, [created.body.id])).rows.map((r) => r.action);
    expect(audit).toEqual(["role_binding.create", "role_binding.revoke"]);
  });

  it("keeps an environment role none a deny no workspace grant overrides, and shows the v1 roles as read-only bindings", async () => {
    const a = await env();
    const admin = await user("viewer", [{ env: a, role: "admin" }]);
    const hidden = await user("viewer", [{ env: a, role: "none" }]);
    const granted = await v2api(admin.api, "POST", `/workspaces/${a}/role-bindings`, { subjectType: "user", subjectId: hidden.id, role: "editor" });
    expect(granted.status).toBe(201);
    expect((await hidden.api("GET", `/environments/${a}/services`)).status).toBe(404);
    expect((await v2api(hidden.api, "GET", `/workspaces/${a}/role-bindings`)).status).toBe(404);
    const listed = (await v2api(admin.api, "GET", `/workspaces/${a}/role-bindings`)).body as { id: string; subjectId: string; origin: string; effect: string; role?: string }[];
    const v1 = listed.filter((x) => x.origin === "v1-environment-role");
    expect(v1.map((x) => ({ subjectId: x.subjectId, effect: x.effect, role: x.role })).sort((x, y) => x.effect.localeCompare(y.effect))).toEqual([
      { subjectId: admin.id, effect: "allow", role: "workspace-admin" },
      { subjectId: hidden.id, effect: "deny", role: undefined },
    ]);
    const deny = v1.find((x) => x.effect === "deny")!;
    expect((await v2api(h.api, "POST", `/role-bindings/${deny.id}/revoke`)).status).toBe(403);
    // Through v1, as before: the role changes and its binding with it.
    expect((await h.api("PUT", `/users/${hidden.id}/environment-roles`, { items: [] })).status).toBe(200);
    expect((await hidden.api("POST", `/environments/${a}/services`, { name: uniq("svc"), protocol: "http", host: "a.example.com", port: 80 })).status).toBe(201);
  });

  it("decides from one snapshot: the global role, the environment role and the grants are read in one statement", async () => {
    const a = await env();
    const target = await user("viewer", [{ env: a, role: "none" }]);
    const grant = await v2api(h.api, "POST", `/workspaces/${a}/role-bindings`, { subjectType: "user", subjectId: target.id, role: "workspace-admin" });
    expect(grant.status).toBe(201);
    let statements = 0;
    const db = drizzle(h.sql, { schema, logger: { logQuery: () => void statements++ } });
    const decide = async () => {
      const [row] = await db.select().from(users).where(eq(users.id, target.id));
      statements = 0;
      const held = await permissionsIn(db, row!, { type: "workspace", workspaceId: a });
      expect(statements).toBe(1);
      return held;
    };
    // The deny prevails over the grant; once both change, only the new state counts: never the old grant without the deny.
    expect([...(await decide())]).toEqual([]);
    expect((await v2api(h.api, "POST", `/role-bindings/${grant.body.id}/revoke`)).status).toBe(204);
    await h.sql.query(`delete from environment_roles where user_id = $1 and environment_id = $2`, [target.id, a]);
    expect([...(await decide())].sort()).toEqual([...BUILTIN_ROLES.viewer].sort());
  });

  it("follows an environment role an older replica writes (only environment_roles) at once, in v1 and v2", async () => {
    const a = await env();
    const target = await user("viewer", [{ env: a, role: "admin" }]);
    expect((await target.api("GET", `/environments/${a}/services`)).status).toBe(200);
    // What the previous version does: it knows nothing about role bindings.
    await h.sql.query(`update environment_roles set role = 'none' where user_id = $1 and environment_id = $2`, [target.id, a]);
    expect((await target.api("GET", `/environments/${a}/services`)).status).toBe(404);
    expect((await v2api(target.api, "GET", `/workspaces/${a}/role-bindings`)).status).toBe(404);
    await h.sql.query(`delete from environment_roles where user_id = $1 and environment_id = $2`, [target.id, a]);
    expect((await target.api("GET", `/environments/${a}/services`)).status).toBe(200);
    const listed = (await v2api(h.api, "GET", `/workspaces/${a}/role-bindings`)).body as { subjectId: string }[];
    expect(listed.filter((b) => b.subjectId === target.id)).toEqual([]);
  });

  it("validates a grant against the core profile of the contract (what later phases bring is refused by the contract)", async () => {
    const a = await env();
    const target = await user("viewer");
    const res = await v2api(h.api, "POST", `/workspaces/${a}/role-bindings`, { subjectType: "user", subjectId: target.id, role: "viewer", expiresAt: null });
    expect(res.status).toBe(422);
    expect(res.body.detail).toBe("Request body does not match the contract");
  });

  it("gives clusters to platform administration and to a v1 environment admin, never through a workspace grant", async () => {
    const a = await env();
    const target = await user("viewer");
    expect((await v2api(h.api, "POST", `/workspaces/${a}/role-bindings`, { subjectType: "user", subjectId: target.id, role: "workspace-admin" })).status).toBe(201);
    expect((await target.api("POST", `/environments/${a}/clusters`, { name: uniq("edge") })).status).toBe(403);
    const v1admin = await user("viewer", [{ env: a, role: "admin" }]);
    expect((await v1admin.api("POST", `/environments/${a}/clusters`, { name: uniq("edge") })).status).toBe(201);
  });

  it("never grants more than the granter holds, nor platform administration inside a workspace, nor what later phases bring", async () => {
    const a = await env();
    const admin = await user("viewer", [{ env: a, role: "admin" }]);
    const target = await user("viewer");
    const post = (body: Record<string, unknown>) => v2api(admin.api, "POST", `/workspaces/${a}/role-bindings`, { subjectType: "user", subjectId: target.id, ...body });
    expect((await post({ permissions: ["promotion.approve"] })).status).toBe(403);
    expect((await post({ role: "approver" })).status).toBe(403);
    for (const [body, path] of [
      [{ role: "platform-admin" }, "role"],
      [{ permissions: ["platform.admin"] }, "permissions"],
      [{ role: "custom-role" }, "role"],
      [{ role: "viewer", effect: "deny" }, "effect"],
      // The core profile: an expiring grant is a rollback.emergency one (refused by the contract itself).
      [{ role: "viewer", expiresAt: new Date(Date.now() + 3600_000).toISOString(), justification: "for a while" }, "permissions"],
    ] as const) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(res.body.errors.map((e: { path: string }) => e.path), JSON.stringify(body)).toContain(path);
    }
    const group = await v2api(admin.api, "POST", `/workspaces/${a}/role-bindings`, { subjectType: "group", subjectId: target.id, role: "viewer" });
    expect(group.status).toBe(422);
    expect((await post({ subjectId: "00000000-0000-4000-8000-000000000000", role: "viewer" })).status).toBe(422);
  });

  it("protects a platform grant whatever its grantor becomes, and lets platform administration revoke any grant", async () => {
    const a = await env();
    const platform = await user("viewer");
    expect((await v2api(h.api, "POST", "/role-bindings", { subjectType: "user", subjectId: platform.id, role: "platform-admin" })).status).toBe(201);
    const target = await user("viewer");
    const grant = await v2api(platform.api, "POST", `/workspaces/${a}/role-bindings`, { subjectType: "user", subjectId: target.id, role: "editor" });
    expect(grant.status, JSON.stringify(grant.body)).toBe(201);
    const local = await user("viewer", [{ env: a, role: "admin" }]);
    expect((await v2api(local.api, "POST", `/role-bindings/${grant.body.id}/revoke`)).status).toBe(403);
    // An emergency grant: platform administration revokes it without holding rollback.emergency itself.
    const soon = new Date(Date.now() + 24 * 3600_000).toISOString();
    const emergency = await v2api(h.api, "POST", `/workspaces/${a}/role-bindings`, { subjectType: "user", subjectId: target.id, permissions: ["rollback.emergency"], expiresAt: soon, justification: "incident 7, on call" });
    expect(emergency.status).toBe(201);
    expect((await v2api(h.api, "POST", `/role-bindings/${emergency.body.id}/revoke`)).status).toBe(204);
    // Any expiresAt, null included, belongs to an emergency grant only (the core profile).
    const nulled = await v2api(h.api, "POST", `/workspaces/${a}/role-bindings`, { subjectType: "user", subjectId: target.id, role: "viewer", expiresAt: null });
    expect(nulled.status).toBe(422);
  });

  it("grants rollback.emergency only from platform administration, to a user, for at most 7 days", async () => {
    const a = await env();
    const target = await user("viewer");
    const soon = new Date(Date.now() + 24 * 3600_000).toISOString();
    const admin = await user("viewer", [{ env: a, role: "admin" }]);
    expect((await v2api(admin.api, "POST", `/workspaces/${a}/role-bindings`, { subjectType: "user", subjectId: target.id, permissions: ["rollback.emergency"], expiresAt: soon, justification: "incident 42, on call" })).status).toBe(403);
    expect((await v2api(h.api, "POST", `/workspaces/${a}/role-bindings`, { subjectType: "user", subjectId: target.id, permissions: ["rollback.emergency"], expiresAt: new Date(Date.now() + 8 * 24 * 3600_000).toISOString(), justification: "incident 42, on call" })).status).toBe(422);
    const ok = await v2api(h.api, "POST", `/workspaces/${a}/role-bindings`, { subjectType: "user", subjectId: target.id, permissions: ["rollback.emergency"], expiresAt: soon, justification: "incident 42, on call" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });

  it("creates instance bindings by session only and from platform administration; they reach environments created later", async () => {
    const a = await env();
    const admin = await user("viewer", [{ env: a, role: "admin" }]);
    const target = await user("viewer");
    expect((await v2api(admin.api, "POST", "/role-bindings", { subjectType: "user", subjectId: target.id, role: "editor" })).status).toBe(403);
    const token = (await h.api("POST", "/users/me/tokens", { name: uniq("t"), role: "admin", expiresInDays: 1 })).body.token as string;
    expect((await v2api(h.anonymous, "POST", "/role-bindings", { subjectType: "user", subjectId: target.id, role: "editor" }, { authorization: `Bearer ${token}` })).status).toBe(401);
    const created = await v2api(h.api, "POST", "/role-bindings", { subjectType: "user", subjectId: target.id, role: "editor" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.scope).toEqual({ type: "instance", workspaceId: null });
    const later = await env();
    expect((await target.api("POST", `/environments/${later}/services`, { name: uniq("svc"), protocol: "http", host: "a.example.com", port: 80 })).status).toBe(201);
    expect((await v2api(target.api, "GET", "/role-bindings")).status).toBe(200);
    expect((await v2api(h.api, "POST", `/role-bindings/${created.body.id}/revoke`)).status).toBe(204);
    expect((await target.api("POST", `/environments/${later}/services`, { name: uniq("svc"), protocol: "http", host: "a.example.com", port: 80 })).status).toBe(403);
  });

  it("caps a token by its own role, and hides a binding of a workspace the caller cannot see", async () => {
    const a = await env();
    const manager = await user("viewer", [{ env: a, role: "admin" }]);
    const viewerToken = (await manager.api("POST", "/users/me/tokens", { name: uniq("t"), role: "viewer", expiresInDays: 1 })).body.token as string;
    const target = await user("viewer");
    const asToken = (method: string, path: string, body?: unknown) => v2api(h.anonymous, method, path, body, { authorization: `Bearer ${viewerToken}` });
    expect((await asToken("GET", `/workspaces/${a}/role-bindings`)).status).toBe(200);
    expect((await asToken("POST", `/workspaces/${a}/role-bindings`, { subjectType: "user", subjectId: target.id, role: "viewer" })).status).toBe(403);
    const created = await v2api(manager.api, "POST", `/workspaces/${a}/role-bindings`, { subjectType: "user", subjectId: target.id, role: "viewer" });
    const outsider = await user("viewer", [{ env: a, role: "none" }]);
    expect((await v2api(outsider.api, "POST", `/role-bindings/${created.body.id}/revoke`)).status).toBe(404);
    expect((await v2api(outsider.api, "GET", `/workspaces/${a}/role-bindings`)).status).toBe(404);
    expect((await v2api(h.api, "GET", "/workspaces/00000000-0000-4000-8000-000000000000/role-bindings")).status).toBe(404);
  });
});
