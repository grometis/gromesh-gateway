import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, uniq, type Harness } from "./harness.js";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h?.close();
});

const newEnvironment = async (): Promise<string> => {
  const res = await h.api("POST", "/environments", { name: uniq("env-roles") });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id;
};
const rolesOf = async (userId: string) => (await h.api("GET", `/users/${userId}/environment-roles`)).body.items;
const rowsOf = async (userId: string) => (await h.sql.query("select environment_id from environment_roles where user_id = $1", [userId])).rows.length;

describe("environment roles", () => {
  it("replaces the whole set, audits it before and after, and shows it in /me", async () => {
    const [a, b] = [await newEnvironment(), await newEnvironment()];
    const user = await h.as("viewer");
    expect(await rolesOf(user.id)).toEqual([]);
    const first = await h.api("PUT", `/users/${user.id}/environment-roles`, { items: [{ environmentId: a, role: "editor" }, { environmentId: b, role: "none" }] });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.items).toEqual(expect.arrayContaining([{ environmentId: a, role: "editor" }, { environmentId: b, role: "none" }]));
    expect((await user.api("GET", "/me")).body.environmentRoles).toEqual(first.body.items);

    const second = await h.api("PUT", `/users/${user.id}/environment-roles`, { items: [{ environmentId: b, role: "admin" }] });
    expect(second.body.items).toEqual([{ environmentId: b, role: "admin" }]);
    const events = (await h.api("GET", `/audit-events?entityType=user&limit=200`)).body.items.filter(
      (e: { action: string; entityId: string }) => e.action === "user.environment_roles.replace" && e.entityId === user.id,
    );
    expect(events).toHaveLength(2);
    expect(events[0].before).toEqual({ items: first.body.items });
    expect(events[0].after).toEqual({ items: [{ environmentId: b, role: "admin" }] });

    expect((await h.api("PUT", `/users/${user.id}/environment-roles`, { items: [] })).body.items).toEqual([]);
    expect((await user.api("GET", "/me")).body.environmentRoles).toEqual([]);
  });

  it("answers 422 with the path for an unknown or repeated environment, and for a global admin", async () => {
    const env = await newEnvironment();
    const user = await h.as("editor");
    const unknown = await h.api("PUT", `/users/${user.id}/environment-roles`, { items: [{ environmentId: env, role: "viewer" }, { environmentId: randomUUID(), role: "viewer" }] });
    expect(unknown.status).toBe(422);
    expect(unknown.body.errors).toEqual([{ path: "items.1.environmentId", message: "is not an environment" }]);
    const repeated = await h.api("PUT", `/users/${user.id}/environment-roles`, { items: [{ environmentId: env, role: "viewer" }, { environmentId: env, role: "editor" }] });
    expect(repeated.status).toBe(422);
    expect(repeated.body.errors).toEqual([{ path: "items.1.environmentId", message: "is repeated" }]);
    const invalid = await h.api("PUT", `/users/${user.id}/environment-roles`, { items: [{ environmentId: env, role: "owner" }] });
    expect(invalid.status).toBe(422);
    expect(await rowsOf(user.id)).toBe(0);

    const admin = await h.as("admin");
    const forAdmin = await h.api("PUT", `/users/${admin.id}/environment-roles`, { items: [{ environmentId: env, role: "viewer" }] });
    expect(forAdmin.status).toBe(422);
    expect(forAdmin.body.errors).toEqual([{ path: "(body)", message: "a global admin is admin in every environment" }]);
    expect((await h.api("GET", `/users/${randomUUID()}/environment-roles`)).status).toBe(404);
    expect((await h.api("PUT", `/users/${randomUUID()}/environment-roles`, { items: [] })).status).toBe(404);
  });

  it("is managed by a global admin only, never by an environment admin, and never with a token", async () => {
    const env = await newEnvironment();
    const envAdmin = await h.as("viewer");
    await h.api("PUT", `/users/${envAdmin.id}/environment-roles`, { items: [{ environmentId: env, role: "admin" }] });
    const target = await h.as("viewer");
    expect((await envAdmin.api("GET", `/users/${target.id}/environment-roles`)).status).toBe(403);
    expect((await envAdmin.api("PUT", `/users/${target.id}/environment-roles`, { items: [{ environmentId: env, role: "editor" }] })).status).toBe(403);
    expect((await envAdmin.api("GET", "/users")).status).toBe(403);
    expect((await envAdmin.api("GET", "/tokens")).status).toBe(403);
    // ... while it does administer the environment itself.
    expect((await envAdmin.api("PATCH", `/environments/${env}`, { name: uniq("renamed") })).status).toBe(200);
  });

  it("goes away with the environment, the user, or a promotion to global admin; a deactivated user loses everything", async () => {
    const [a, b] = [await newEnvironment(), await newEnvironment()];
    const user = await h.as("viewer");
    await h.api("PUT", `/users/${user.id}/environment-roles`, { items: [{ environmentId: a, role: "editor" }, { environmentId: b, role: "editor" }] });
    expect((await h.api("DELETE", `/environments/${a}`)).status).toBe(204);
    expect(await rolesOf(user.id)).toEqual([{ environmentId: b, role: "editor" }]);

    expect((await h.api("PATCH", `/users/${user.id}`, { role: "admin" })).status).toBe(200);
    expect(await rolesOf(user.id)).toEqual([]);
    expect((await h.api("PATCH", `/users/${user.id}`, { role: "viewer" })).status).toBe(200);

    const other = await h.as("viewer");
    await h.api("PUT", `/users/${other.id}/environment-roles`, { items: [{ environmentId: b, role: "admin" }] });
    expect((await h.api("PATCH", `/users/${other.id}`, { active: false })).status).toBe(200);
    expect((await other.api("GET", `/environments/${b}`)).status).toBe(401);
    expect((await h.api("DELETE", `/users/${other.id}`)).status).toBe(204);
    expect(await rowsOf(other.id)).toBe(0);
  });

  it("a missing environment and an invisible one look the same", async () => {
    const env = await newEnvironment();
    const user = await h.as("editor");
    await h.api("PUT", `/users/${user.id}/environment-roles`, { items: [{ environmentId: env, role: "none" }] });
    const hidden = await user.api("POST", `/environments/${env}/services`, {});
    const missing = await user.api("POST", `/environments/${randomUUID()}/services`, {});
    expect(hidden.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(hidden.body.detail).toBe(missing.body.detail);
    expect((await user.api("GET", `/environments/not-a-uuid/services`)).status).toBe(404);
  });

  it("an environment role really grants its operations: create, rotate and delete in A, refused in B", async () => {
    const [a, b] = [await newEnvironment(), await newEnvironment()];
    const user = await h.as("viewer");
    await h.api("PUT", `/users/${user.id}/environment-roles`, { items: [{ environmentId: a, role: "admin" }] });
    const service = { name: uniq("svc"), protocol: "http", host: "echo", port: 80 };
    expect((await user.api("POST", `/environments/${a}/services`, service)).status).toBe(201);
    expect((await user.api("POST", `/environments/${b}/services`, service)).status).toBe(403);
    const cluster = await user.api("POST", `/environments/${a}/clusters`, { name: uniq("c") });
    expect(cluster.status).toBe(201);
    expect((await user.api("POST", `/clusters/${cluster.body.id}/rotate-token`)).status).toBe(200);
    expect((await user.api("DELETE", `/clusters/${cluster.body.id}`)).status).toBe(204);
    const other = (await h.api("POST", `/environments/${b}/clusters`, { name: uniq("c") })).body.id;
    expect((await user.api("POST", `/clusters/${other}/rotate-token`)).status).toBe(403);
    expect((await user.api("GET", `/clusters/${other}`)).status).toBe(200);
  });

  it("accepts an environment id in upper case as the same environment", async () => {
    const env = await newEnvironment();
    const user = await h.as("viewer");
    const res = await h.api("PUT", `/users/${user.id}/environment-roles`, { items: [{ environmentId: env.toUpperCase(), role: "editor" }] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.items).toEqual([{ environmentId: env, role: "editor" }]);
  });

  it("the database refuses a role outside the ladder", async () => {
    const env = await newEnvironment();
    const user = await h.as("viewer");
    await expect(h.sql.query("insert into environment_roles (user_id, environment_id, role) values ($1, $2, 'viewr')", [user.id, env])).rejects.toThrow(/environment_roles_role_ck/);
  });
});
