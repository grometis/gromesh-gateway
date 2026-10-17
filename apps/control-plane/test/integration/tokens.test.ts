import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, uniq, type ApiClient, type Harness } from "./harness.js";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h?.close();
});

const PATTERN = /^ggt_[A-Za-z0-9_-]{43}$/;

/** A client that authenticates with a bearer token only (no cookie, no CSRF header). */
const bearer = (token: string): ApiClient => (method, path, body, headers = {}) => h.anonymous(method, path, body, { authorization: `Bearer ${token}`, ...headers });

async function tokenFor(api: ApiClient, role: "viewer" | "editor" | "admin", name = uniq("token"), expiresInDays = 30) {
  const res = await api("POST", "/users/me/tokens", { name, role, expiresInDays });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(res.body.token).toMatch(PATTERN);
  return res.body as { id: string; token: string; tokenHint: string; name: string; role: string; expiresAt: string };
}

/** Every text and json column of every table as one string: nothing in the database may contain a token. */
async function dump(): Promise<string> {
  const { rows } = await h.sql.query<{ table_name: string; column_name: string }>(
    "select table_name, column_name from information_schema.columns where table_schema = 'public' and data_type in ('text', 'jsonb', 'character varying')",
  );
  const parts: string[] = [];
  for (const { table_name, column_name } of rows) {
    const { rows: values } = await h.sql.query(`select "${column_name}"::text as v from "${table_name}"`);
    parts.push(...values.map((r: { v: string | null }) => r.v ?? ""));
  }
  return parts.join("\n");
}

describe("API tokens", () => {
  it("shows the token once, stores only a keyed hash and a hint, and audits the creation without it", async () => {
    const editor = await h.as("editor");
    const created = await tokenFor(editor.api, "viewer", "ci-deploy");
    expect(created.tokenHint).toBe(`…${created.token.slice(-4)}`);
    expect(created).toMatchObject({ name: "ci-deploy", role: "viewer", lastUsedAt: null, revokedAt: null, owner: { id: editor.id, name: "editor user" } });
    const listed = await editor.api("GET", "/users/me/tokens");
    expect(listed.status).toBe(200);
    expect(listed.body.items.map((t: { id: string }) => t.id)).toContain(created.id);
    expect(JSON.stringify(listed.body)).not.toContain(created.token);
    const { rows } = await h.sql.query("select token_hash from api_tokens where id = $1", [created.id]);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await dump()).not.toContain(created.token);
    const audit = await h.api("GET", `/audit-events?entityType=api_token&actorId=${editor.id}`);
    expect(audit.body.items[0]).toMatchObject({ action: "token.create", entityId: created.id, after: { name: "ci-deploy", role: "viewer" } });
    expect(JSON.stringify(audit.body)).not.toContain(created.token);
  });

  it("acts with the lower of the token's role and the owner's current role, and stops with the owner", async () => {
    const editor = await h.as("editor");
    expect((await editor.api("POST", "/users/me/tokens", { name: "too-much", role: "admin", expiresInDays: 30 })).status).toBe(422);
    expect((await editor.api("POST", "/users/me/tokens", { name: "too-much", role: "admin", expiresInDays: 30 })).body.errors[0].path).toBe("role");
    const token = await tokenFor(editor.api, "editor");
    const api = bearer(token.token);
    const env = (await h.api("POST", "/environments", { name: uniq("tokens") })).body;
    const created = await api("POST", `/environments/${env.id}/services`, { name: uniq("svc"), protocol: "http", host: "echo", port: 80 });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    // The audit log names the token the mutation came through.
    const audit = await h.api("GET", `/audit-events?entityType=service&actorId=${editor.id}`);
    expect(audit.body.items[0].actor).toMatchObject({ type: "user", id: editor.id, name: "editor user", via: "token", tokenId: token.id, tokenName: token.name });
    // Demoted owner: the token is an editor token, but acts as a viewer now.
    expect((await h.api("PATCH", `/users/${editor.id}`, { role: "viewer" })).status).toBe(200);
    expect((await api("POST", `/environments/${env.id}/services`, { name: uniq("denied"), protocol: "http", host: "echo", port: 80 })).status).toBe(403);
    expect((await api("GET", "/environments")).status).toBe(200);
    expect((await api("GET", "/me")).body.id).toBe(editor.id);
    // Deactivated owner: 401 at once.
    expect((await h.api("PATCH", `/users/${editor.id}`, { active: false })).status).toBe(200);
    expect((await api("GET", "/environments")).status).toBe(401);
  });

  it("expires, and records the last use at most once a minute", async () => {
    const viewer = await h.as("viewer");
    const token = await tokenFor(viewer.api, "viewer", "short", 1);
    const api = bearer(token.token);
    expect((await api("GET", "/environments")).status).toBe(200);
    const first = (await viewer.api("GET", "/users/me/tokens")).body.items.find((t: { id: string }) => t.id === token.id);
    expect(first.lastUsedAt).not.toBeNull();
    expect((await api("GET", "/environments")).status).toBe(200);
    const second = (await viewer.api("GET", "/users/me/tokens")).body.items.find((t: { id: string }) => t.id === token.id);
    expect(second.lastUsedAt).toBe(first.lastUsedAt);
    await h.sql.query("update api_tokens set expires_at = now() - interval '1 second' where id = $1", [token.id]);
    expect((await api("GET", "/environments")).status).toBe(401);
  });

  it("uses the bearer alone: no cookie, no CSRF; the session-only operations refuse it", async () => {
    const viewer = await h.as("viewer");
    const editor = await h.as("editor");
    const token = await tokenFor(editor.api, "editor");
    // A viewer's session cookie plus an editor's token: the token wins, and no CSRF header is needed.
    const env = (await h.api("POST", "/environments", { name: uniq("mixed") })).body;
    const mixed = await viewer.api("POST", `/environments/${env.id}/services`, { name: uniq("svc"), protocol: "http", host: "echo", port: 80 }, { authorization: `Bearer ${token.token}`, "x-csrf-token": "" });
    expect(mixed.status, JSON.stringify(mixed.body)).toBe(201);
    const api = bearer(token.token);
    for (const [method, path, body] of [
      ["POST", "/users/me/tokens", { name: "nested", role: "viewer", expiresInDays: 1 }],
      ["GET", "/users/me/tokens", undefined],
      ["DELETE", `/users/me/tokens/${token.id}`, undefined],
      ["GET", "/tokens", undefined],
      ["GET", "/users", undefined],
      ["POST", "/users", { email: "x@y.test", name: "x", role: "viewer", password: "long-enough-password" }],
      ["POST", "/auth/logout", undefined],
      ["GET", "/auth/csrf", undefined],
    ] as const) {
      const res = await api(method, path, body);
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(res.body.detail).toContain("session");
    }
    // The token itself keeps working: those refusals are not failures of the token.
    expect((await api("GET", "/environments")).status).toBe(200);
  });

  it("revokes: 404 for another user's token on the own route, admins revoke any, idempotent, audited", async () => {
    const a = await h.as("editor");
    const b = await h.as("viewer");
    const ta = await tokenFor(a.api, "viewer");
    const tb = await tokenFor(b.api, "viewer");
    expect((await b.api("DELETE", `/users/me/tokens/${ta.id}`)).status).toBe(404);
    expect((await bearer(ta.token)("GET", "/environments")).status).toBe(200);
    expect((await a.api("DELETE", `/users/me/tokens/${ta.id}`)).status).toBe(204);
    expect((await a.api("DELETE", `/users/me/tokens/${ta.id}`)).status).toBe(204);
    expect((await bearer(ta.token)("GET", "/environments")).status).toBe(401);
    const revoked = (await a.api("GET", "/users/me/tokens")).body.items.find((t: { id: string }) => t.id === ta.id);
    expect(revoked.revokedAt).not.toBeNull();
    const all = await h.api("GET", "/tokens?limit=200");
    expect(all.status).toBe(200);
    expect(all.body.items.find((t: { id: string }) => t.id === tb.id)).toMatchObject({ owner: { id: b.id } });
    expect(JSON.stringify(all.body)).not.toContain(tb.token);
    expect((await h.api("DELETE", `/tokens/${tb.id}`)).status).toBe(204);
    expect((await bearer(tb.token)("GET", "/environments")).status).toBe(401);
    const audit = await h.api("GET", "/audit-events?entityType=api_token&limit=50");
    expect(audit.body.items.filter((e: { action: string; entityId: string }) => e.action === "token.revoke").map((e: { entityId: string }) => e.entityId)).toEqual(expect.arrayContaining([ta.id, tb.id]));
  });

  it("holds at most 50 active tokens per user", async () => {
    const viewer = await h.as("viewer");
    for (let i = 0; i < 50; i++) await tokenFor(viewer.api, "viewer", `t${i}`);
    const over = await viewer.api("POST", "/users/me/tokens", { name: "t50", role: "viewer", expiresInDays: 30 });
    expect(over.status).toBe(422);
    expect(over.body.errors[0]).toMatchObject({ path: "(body)" });
    expect(over.body.errors[0].message).toContain("50");
    // A revoked one frees a slot.
    const first = (await viewer.api("GET", "/users/me/tokens?limit=1")).body.items[0];
    expect((await viewer.api("DELETE", `/users/me/tokens/${first.id}`)).status).toBe(204);
    expect((await viewer.api("POST", "/users/me/tokens", { name: "t50", role: "viewer", expiresInDays: 30 })).status).toBe(201);
  });

  it("counts invalid bearers in the login's per-address limiter", async () => {
    // Own replica trusting X-Forwarded-For, so this address is nobody else's (other test files share the database).
    const strict = await startHarness({ loginMaxFailuresPerIp: 3, trustProxy: true });
    const from = { "x-forwarded-for": "203.0.113.77" };
    try {
      for (let i = 0; i < 3; i++) {
        const res = await strict.anonymous("GET", "/environments", undefined, { authorization: `Bearer ggt_${"x".repeat(43)}`, ...from });
        expect(res.status).toBe(401);
      }
      const locked = await strict.anonymous("GET", "/environments", undefined, { authorization: "Bearer nonsense", ...from });
      expect(locked.status).toBe(429);
      expect(locked.headers.get("retry-after")).toMatch(/^\d+$/);
      // The same lock applies to the login from that address.
      expect((await strict.anonymous("POST", "/auth/login", { email: strict.admin.email, password: strict.admin.password }, from)).status).toBe(429);
    } finally {
      await strict.sql.query("delete from login_attempts where key = 'ip:203.0.113.77'");
      await strict.close();
    }
  });
});
