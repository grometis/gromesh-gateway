import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { parse } from "yaml";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as argon2 from "@node-rs/argon2";
import { loadConfig } from "../../src/config.js";

// Spied, not replaced: the login must run a real verification even for unknown e-mails (see the decoy hash).
vi.mock("@node-rs/argon2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@node-rs/argon2")>();
  return { ...actual, verify: vi.fn(actual.verify) };
});
import { BOOTSTRAP_ADMIN, startHarness, uniq, type ApiClient, type Harness } from "./harness.js";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h?.close();
});

const PASSWORD = "a-password-with-12+";

async function newUser(role: "viewer" | "editor" | "admin", overrides: Record<string, unknown> = {}) {
  const email = `${uniq(role)}@example.test`;
  const res = await h.api("POST", "/users", { email, name: `${role} ${uniq("u")}`, role, password: PASSWORD, ...overrides });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { ...(res.body as { id: string }), email };
}

describe("login", () => {
  it("sets an httpOnly session cookie, returns the user and never a token", async () => {
    const res = await h.anonymous("POST", "/auth/login", BOOTSTRAP_ADMIN);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(["user"]);
    expect(res.body.user).toMatchObject({ email: BOOTSTRAP_ADMIN.email, role: "admin", active: true });
    expect(res.body.user.passwordHash).toBeUndefined();
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^gromesh_session=[A-Za-z0-9_-]{43}; Max-Age=28800; Path=\/; HttpOnly; SameSite=Strict$/);

    const second = await h.anonymous("POST", "/auth/login", BOOTSTRAP_ADMIN);
    expect(second.headers.get("set-cookie")).not.toBe(cookie); // a new id per login (no fixation)
  });

  it("adds Secure to the cookie unless COOKIE_SECURE=false", async () => {
    expect(loadConfig({ DATABASE_URL: "x" }).cookieSecure).toBe(true);
    expect(loadConfig({ DATABASE_URL: "x", COOKIE_SECURE: "false" }).cookieSecure).toBe(false);
    const secure = await startHarness({ cookieSecure: true });
    try {
      const res = await secure.anonymous("POST", "/auth/login", BOOTSTRAP_ADMIN);
      expect(res.headers.get("set-cookie")).toContain("; Secure");
    } finally {
      await secure.close();
    }
  });

  it("answers the same 401 for a wrong password, an unknown e-mail and an inactive user", async () => {
    const user = await newUser("viewer");
    await h.api("PATCH", `/users/${user.id}`, { active: false });
    const answers = await Promise.all([
      h.anonymous("POST", "/auth/login", { email: BOOTSTRAP_ADMIN.email, password: "wrong-password-123" }),
      h.anonymous("POST", "/auth/login", { email: `${uniq("nobody")}@example.test`, password: "wrong-password-123" }),
      h.anonymous("POST", "/auth/login", { email: user.email, password: PASSWORD }),
    ]);
    for (const res of answers) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual(answers[0]!.body);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });

  it("verifies a decoy hash when the e-mail is unknown, so the miss costs the same time", async () => {
    const verify = vi.mocked(argon2.verify);
    verify.mockClear();
    expect((await h.anonymous("POST", "/auth/login", { email: `${uniq("ghost")}@example.test`, password: "wrong-password-123" })).status).toBe(401);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0]![0]).toMatch(/^\$argon2id\$/);
    expect(verify.mock.calls[0]![1]).toBe("wrong-password-123");
  });

  it("is case-insensitive on the e-mail and validates the body with the contract", async () => {
    const user = await newUser("viewer");
    expect((await h.login(user.email.toUpperCase(), PASSWORD)).status).toBe(200);
    const missing = await h.anonymous("POST", "/auth/login", {});
    expect(missing.status).toBe(422);
    expect(missing.body.errors).toContainEqual(expect.objectContaining({ path: "password" }));
  });

  it("locks the e-mail+address pair after 5 failures: 429 with Retry-After, even with the right password", async () => {
    const user = await newUser("editor");
    for (let i = 0; i < 5; i++) expect((await h.anonymous("POST", "/auth/login", { email: user.email, password: "wrong-password-123" })).status).toBe(401);
    const locked = await h.anonymous("POST", "/auth/login", { email: user.email, password: PASSWORD });
    expect(locked.status).toBe(429);
    expect(locked.contentType).toContain("application/problem+json");
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
    // Other accounts from the same address are unaffected.
    const other = await newUser("editor");
    expect((await h.login(other.email, PASSWORD)).status).toBe(200);
  });

  it("never lets one address lock an account for another: 10 failures from A, the admin still logs in from B", async () => {
    // trust proxy on, so X-Forwarded-For stands for the client address.
    const proxied = await startHarness({ trustProxy: true });
    try {
      const fromA = { "x-forwarded-for": "203.0.113.10" };
      const fromB = { "x-forwarded-for": "203.0.113.20" };
      for (let i = 0; i < 10; i++) {
        const res = await proxied.anonymous("POST", "/auth/login", { email: BOOTSTRAP_ADMIN.email, password: "wrong-password-123" }, fromA);
        expect(res.status, `attempt ${i + 1}`).toBe(i < 5 ? 401 : 429);
      }
      const fromElsewhere = await proxied.anonymous("POST", "/auth/login", BOOTSTRAP_ADMIN, fromB);
      expect(fromElsewhere.status).toBe(200);
      const { rows } = await h.sql.query("select key, locked_until from login_attempts where key like $1", [`%${BOOTSTRAP_ADMIN.email}%`]);
      expect(rows.map((r) => r.key).sort()).toEqual([`email_ip:${BOOTSTRAP_ADMIN.email}|203.0.113.10`]);
    } finally {
      await h.sql.query("delete from login_attempts where key like $1 or key like 'ip:203.%'", [`%${BOOTSTRAP_ADMIN.email}%`]);
      await proxied.close();
    }
  });

  it("never resets the address counter on a successful login", async () => {
    // N-1 failures from X against someone else, one good login with an own account from X, then more failures:
    // the address still locks at N. The window is the only thing that clears it.
    const strict = await startHarness({ trustProxy: true, loginMaxFailuresPerIp: 3, loginLockoutMs: 60_000 });
    try {
      const fromX = { "x-forwarded-for": "198.51.100.77" };
      const own = await newUser("viewer");
      const other = await newUser("viewer");
      for (let i = 0; i < 2; i++) expect((await strict.anonymous("POST", "/auth/login", { email: other.email, password: "wrong-password-123" }, fromX)).status).toBe(401);
      expect((await strict.anonymous("POST", "/auth/login", { email: own.email, password: PASSWORD }, fromX)).status).toBe(200);
      expect((await strict.anonymous("POST", "/auth/login", { email: other.email, password: "wrong-password-123" }, fromX)).status).toBe(401);
      const locked = await strict.anonymous("POST", "/auth/login", { email: own.email, password: PASSWORD }, fromX);
      expect(locked.status).toBe(429);
      const { rows } = await h.sql.query("select failures, locked_until from login_attempts where key = $1", ["ip:198.51.100.77"]);
      expect(rows[0].failures).toBe(3);
      expect(rows[0].locked_until).not.toBeNull();
    } finally {
      await h.sql.query("delete from login_attempts where key like 'ip:198.51.100.%'");
      await strict.close();
    }
  });

  it("slows repeated failures on an e-mail progressively, without ever locking it", async () => {
    const slow = await startHarness({ loginDelayBaseMs: 60, loginDelayMaxMs: 200 });
    try {
      const user = await newUser("viewer");
      const timings: number[] = [];
      for (let i = 0; i < 4; i++) {
        const started = Date.now();
        expect((await slow.anonymous("POST", "/auth/login", { email: user.email, password: "wrong-password-123" }, { "x-forwarded-for": `198.51.100.${i}` })).status).toBe(401);
        timings.push(Date.now() - started);
      }
      // 0, 60, 120, 200 ms of delay before the 1st..4th attempts (the first has nothing to wait for).
      expect(timings[1]).toBeGreaterThanOrEqual(55);
      expect(timings[2]).toBeGreaterThanOrEqual(110);
      expect(timings[3]).toBeGreaterThanOrEqual(190);
      const started = Date.now();
      expect((await slow.login(user.email, PASSWORD)).status).toBe(200);
      expect(Date.now() - started).toBeGreaterThanOrEqual(190); // the delay applies to the right password too
      expect((await slow.login(user.email, PASSWORD)).status).toBe(200); // ...and clears on success
    } finally {
      await slow.close();
    }
  });

  it("locks a client address after too many failures across accounts", async () => {
    // The lockout table is shared by every replica, so this replica sees the failures made through `h` too:
    // use fresh keys (new e-mails) and a threshold the test can reach on its own.
    const strict = await startHarness({ loginMaxFailuresPerIp: 3, loginLockoutMs: 60_000 });
    try {
      await h.sql.query("delete from login_attempts where key like 'ip:%'");
      for (let i = 0; i < 3; i++) {
        expect((await strict.anonymous("POST", "/auth/login", { email: `${uniq("x")}@example.test`, password: "wrong-password-123" })).status).toBe(401);
      }
      const locked = await strict.anonymous("POST", "/auth/login", BOOTSTRAP_ADMIN);
      expect(locked.status).toBe(429);
      expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
    } finally {
      await h.sql.query("delete from login_attempts where key like 'ip:%'");
      await strict.close();
    }
  });

  it("locks password login independently of the bearer's per-address limiter", async () => {
    const strict = await startHarness({ loginMaxFailuresPerIp: 3, loginLockoutMs: 60_000, trustProxy: true });
    const ip = "192.0.2.180";
    const from = { "x-forwarded-for": ip };
    const user = await strict.as("viewer");
    try {
      const created = await user.api("POST", "/users/me/tokens", { name: uniq("login-isolation"), role: "viewer", expiresInDays: 1 });
      expect(created.status).toBe(201);
      const valid = { authorization: `Bearer ${created.body.token}`, ...from };
      const invalid = { authorization: `Bearer ggt_${"x".repeat(43)}`, ...from };
      for (let i = 0; i < 3; i++) {
        expect((await strict.anonymous("POST", "/auth/login", { email: user.email, password: "wrong-password-123" }, from)).status).toBe(401);
      }
      const locked = await strict.anonymous("POST", "/auth/login", strict.admin, from);
      expect(locked.status).toBe(429);
      expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
      const { rows: before } = await strict.sql.query("select key, failures from login_attempts where key = any($1::text[])", [[`ip:${ip}`, `bearer-ip:${ip}`]]);
      expect(before).toEqual([{ key: `ip:${ip}`, failures: 3 }]);
      for (let i = 0; i < 3; i++) {
        expect((await strict.anonymous("GET", "/me", undefined, valid)).status).toBe(200);
        const rejected = await strict.anonymous("GET", "/me", undefined, invalid);
        expect(rejected.status).toBe(401);
        expect(rejected.headers.get("retry-after")).toBeNull();
      }
      const bearerLocked = await strict.anonymous("GET", "/me", undefined, invalid);
      expect(bearerLocked.status).toBe(429);
      expect(Number(bearerLocked.headers.get("retry-after"))).toBeGreaterThan(0);
      const { rows: after } = await strict.sql.query("select key, failures from login_attempts where key = any($1::text[]) order by key", [[`ip:${ip}`, `bearer-ip:${ip}`]]);
      expect(after).toEqual([{ key: `bearer-ip:${ip}`, failures: 3 }, { key: `ip:${ip}`, failures: 3 }]);
    } finally {
      await strict.sql.query("delete from login_attempts where key = any($1::text[])", [[`ip:${ip}`, `bearer-ip:${ip}`, `email:${user.email}`, `email_ip:${user.email}|${ip}`]]);
      await strict.close();
    }
  });

  it("writes auth.login to the audit log without the password", async () => {
    const password = `pw-${uniq("very-secret")}`;
    const user = await newUser("viewer", { password });
    await h.anonymous("POST", "/auth/login", { email: user.email, password: "wrong-password-123" });
    const session = await h.login(user.email, password);
    expect(session.status).toBe(200);
    await session.api("POST", "/auth/logout");
    const { rows } = await h.sql.query("select actor, action, after from audit_events where action like 'auth.%' order by at");
    const text = JSON.stringify(rows);
    expect(text).not.toContain(password);
    expect(text).not.toContain("wrong-password-123");
    expect(rows).toContainEqual(expect.objectContaining({ action: "auth.login", actor: { type: "system", id: "auth" }, after: { ok: false, email: user.email, reason: "invalid_credentials" } }));
    expect(rows).toContainEqual(expect.objectContaining({ action: "auth.login", actor: expect.objectContaining({ type: "user", id: user.id }), after: { ok: true } }));
    expect(rows).toContainEqual(expect.objectContaining({ action: "auth.logout", actor: expect.objectContaining({ id: user.id }) }));
  });
});

describe("sessions", () => {
  it("logout clears the cookie and invalidates the session", async () => {
    const user = await newUser("viewer");
    const session = await h.login(user.email, PASSWORD);
    expect((await session.api("GET", "/me")).body).toMatchObject({ id: user.id, role: "viewer" });
    const out = await session.api("POST", "/auth/logout");
    expect(out.status).toBe(204);
    expect(out.headers.get("set-cookie")).toMatch(/^gromesh_session=; Max-Age=0;/);
    expect((await session.api("GET", "/me")).status).toBe(401);
  });

  it("renews the cookie when the sliding expiry moves", async () => {
    const user = await newUser("viewer");
    const session = await h.login(user.email, PASSWORD);
    expect((await session.api("GET", "/me")).headers.get("set-cookie")).toBeNull(); // nothing slid yet
    await h.sql.query("update sessions set last_seen_at = now() - interval '2 minutes' where user_id = $1", [user.id]);
    const slid = await session.api("GET", "/me");
    expect(slid.status).toBe(200);
    expect(slid.headers.get("set-cookie")).toBe(`${session.cookie}; Max-Age=28800; Path=/; HttpOnly; SameSite=Strict`);
    const { rows } = await h.sql.query("select expires_at > now() + interval '7 hours 59 minutes' as slid from sessions where user_id = $1", [user.id]);
    expect(rows[0].slid).toBe(true);
  });

  it("revokes the session a browser still presents when it logs in again", async () => {
    const user = await newUser("viewer");
    const first = await h.login(user.email, PASSWORD);
    expect((await first.api("GET", "/me")).status).toBe(200);
    const again = await h.anonymous("POST", "/auth/login", { email: user.email, password: PASSWORD }, { cookie: first.cookie! });
    expect(again.status).toBe(200);
    expect(again.headers.get("set-cookie")).not.toContain(first.cookie);
    expect((await first.api("GET", "/me")).status).toBe(401);
  });

  it("ends every session of a user who is deactivated, demoted or given a new password", async () => {
    for (const change of [{ active: false }, { role: "viewer" }, { password: "another-password-12" }]) {
      const user = await newUser("editor");
      const session = await h.login(user.email, PASSWORD);
      expect((await session.api("GET", "/me")).status).toBe(200);
      expect((await h.api("PATCH", `/users/${user.id}`, change)).status).toBe(200);
      expect((await session.api("GET", "/me")).status, JSON.stringify(change)).toBe(401);
    }
  });

  it("refuses a mutation without the CSRF header, and with a wrong one", async () => {
    const env = await h.api("POST", "/environments", { name: uniq("env") });
    const user = await newUser("editor");
    const session = await h.login(user.email, PASSWORD);
    const service = () => ({ name: uniq("svc"), protocol: "http", host: "echo", port: 80 });
    const withCsrf = await session.api("POST", `/environments/${env.body.id}/services`, service());
    expect(withCsrf.status).toBe(201);
    const bare = await session.api("POST", `/environments/${env.body.id}/services`, service(), { "x-csrf-token": "" });
    expect(bare.status).toBe(403);
    expect(bare.body.detail).toContain("CSRF");
    const wrong = await session.api("POST", `/environments/${env.body.id}/services`, service(), { "x-csrf-token": "not-the-token" });
    expect(wrong.status).toBe(403);
    // A token of another length (would make a naive timing-safe compare throw) is just invalid.
    expect((await session.api("POST", `/environments/${env.body.id}/services`, service(), { "x-csrf-token": "x" })).status).toBe(403);
    // Reads need the cookie only.
    expect((await session.api("GET", "/environments", undefined, { "x-csrf-token": "" })).status).toBe(200);
  });
});

describe("users", () => {
  it("creates, lists (cursor), updates and deletes users; e-mail is unique", async () => {
    const user = await newUser("viewer");
    expect((await h.api("POST", "/users", { email: user.email.toUpperCase(), name: "dup", role: "viewer", password: PASSWORD })).status).toBe(409);
    const short = await h.api("POST", "/users", { email: `${uniq("s")}@example.test`, name: "s", role: "viewer", password: "short" });
    expect(short.status).toBe(422);
    expect(short.body.errors).toContainEqual(expect.objectContaining({ path: "password" }));

    const page = await h.api("GET", "/users?limit=1");
    expect(page.body.items).toHaveLength(1);
    expect(page.body.nextCursor).toBeTruthy();
    const next = await h.api("GET", `/users?limit=1&cursor=${page.body.nextCursor}`);
    expect(next.body.items[0].id).not.toBe(page.body.items[0].id);
    for (const item of [...page.body.items, ...next.body.items]) expect(Object.keys(item).sort()).toEqual(["active", "createdAt", "email", "id", "name", "role", "updatedAt"]);

    const patched = await h.api("PATCH", `/users/${user.id}`, { name: "Renamed", role: "editor" });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ id: user.id, name: "Renamed", role: "editor" });
    expect((await h.api("DELETE", `/users/${user.id}`)).status).toBe(204);
    expect((await h.api("DELETE", `/users/${user.id}`)).status).toBe(404);

    const { rows } = await h.sql.query("select action, before, after from audit_events where entity_type = 'user' and entity_id = $1 order by at", [user.id]);
    expect(rows.map((r) => r.action)).toEqual(["user.create", "user.update", "user.delete"]);
    expect(JSON.stringify(rows)).not.toContain(PASSWORD);
    expect(JSON.stringify(rows)).not.toContain("passwordHash");
  });

  it("protects the last active admin from deletion, demotion and deactivation", async () => {
    // The bootstrap admin is shared by every test file (they run in parallel on one database): the checks on it are
    // the refusals, which change nothing. Only extra admins are changed here, and only while the bootstrap one stays.
    const me = (await h.api("GET", "/me")).body;
    const onlyAdmin = async () => (await h.api("GET", "/users?limit=200")).body.items.filter((u: { role: string; active: boolean }) => u.role === "admin" && u.active).length === 1;
    if (await onlyAdmin()) {
      expect((await h.api("DELETE", `/users/${me.id}`)).status).toBe(409);
      expect((await h.api("PATCH", `/users/${me.id}`, { role: "editor" })).status).toBe(409);
      expect((await h.api("PATCH", `/users/${me.id}`, { active: false })).status).toBe(409);
    }
    expect((await h.api("PATCH", `/users/${me.id}`, { name: "Admin" })).status).toBe(200);
    // With another active admin around, an admin may be demoted, deactivated or deleted.
    const second = await newUser("admin");
    expect((await h.api("PATCH", `/users/${second.id}`, { role: "editor" })).status).toBe(200);
    expect((await h.api("PATCH", `/users/${second.id}`, { role: "admin", active: false })).status).toBe(200);
    expect((await h.api("DELETE", `/users/${second.id}`)).status).toBe(204);
  });

  it("refuses to demote or deactivate the last admin even through a second replica", async () => {
    const replica = await startHarness();
    try {
      const me = (await replica.api("GET", "/me")).body;
      const extra = await newUser("admin");
      // Deactivate the extra admin first so the bootstrap one is the last; both calls are refusals, nothing changes.
      expect((await replica.api("PATCH", `/users/${extra.id}`, { active: false })).status).toBe(200);
      const others = (await replica.api("GET", "/users?limit=200")).body.items.filter((u: { id: string; role: string; active: boolean }) => u.id !== me.id && u.role === "admin" && u.active);
      if (others.length === 0) expect((await replica.api("PATCH", `/users/${me.id}`, { role: "viewer" })).status).toBe(409);
      expect((await replica.api("DELETE", `/users/${extra.id}`)).status).toBe(204);
    } finally {
      await replica.close();
    }
  });

  it("creates the bootstrap admin only once, on an empty table", async () => {
    const again = await startHarness({ bootstrapAdmin: { email: "other@harness.test", password: "other-admin-password" } });
    try {
      expect((await again.anonymous("POST", "/auth/login", { email: "other@harness.test", password: "other-admin-password" })).status).toBe(401);
    } finally {
      await again.close();
    }
  });
});

describe("RBAC matrix from the contract", () => {
  interface Operation { method: string; path: string; role: "viewer" | "editor" | "admin"; id: string }
  const RANK = { viewer: 1, editor: 2, admin: 3 };
  const contract = parse(readFileSync(new URL("../../../../contracts/control-plane.openapi.yaml", import.meta.url), "utf8")) as {
    paths: Record<string, Record<string, { operationId: string; "x-required-role"?: Operation["role"]; "x-gromesh-planned"?: boolean; security?: Record<string, unknown>[] }>>;
  };
  /** Operations whose own `security` leaves the bearer scheme out: a session only (token and user management). */
  const sessionOnly = new Set<string>();
  // logout ends the session it is called with, so the sessions tests cover it instead of the matrix.
  const SKIP = new Set(["logout"]);
  const operations: Operation[] = [];
  // Contract-only PRs mark new operations with x-gromesh-planned until the implementation PR removes the mark.
  const planned: Operation[] = [];
  for (const [path, methods] of Object.entries(contract.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (method === "parameters" || !op["x-required-role"] || SKIP.has(op.operationId)) continue;
      const operation = { method: method.toUpperCase(), path, role: op["x-required-role"], id: op.operationId };
      (op["x-gromesh-planned"] ? planned : operations).push(operation);
      if (op.security && !op.security.some((s) => "bearerApiToken" in s)) sessionOnly.add(op.operationId);
    }
  }
  /** Routes registered in Nest, as "METHOD /api/v1/path/:param", from the Express router. */
  const registeredRoutes = (): Set<string> => {
    const express = h.app.getHttpAdapter().getInstance() as { _router?: { stack: { route?: { path: string; methods: Record<string, boolean> } }[] } };
    const routes = new Set<string>();
    for (const layer of express._router?.stack ?? []) {
      if (!layer.route) continue;
      for (const [method, on] of Object.entries(layer.route.methods)) if (on) routes.add(`${method.toUpperCase()} ${layer.route.path}`);
    }
    return routes;
  };
  const nestPath = (path: string) => `/api/v1${path.replace(/\{([a-zA-Z]+)\}/g, ":$1")}`;
  const concrete = (path: string) => path.replace(/\{version\}/g, "1").replace(/\{pluginName\}/g, "cors").replace(/\{[a-zA-Z]+\}/g, () => randomUUID());
  const mutation = (method: string) => !["GET", "HEAD"].includes(method);

  it("covers every operation of the contract", () => {
    expect(operations.length).toBeGreaterThan(40);
    expect(operations.map((o) => o.id)).toContain("rotateClusterToken");
  });

  it("has a handler for every operation that is not planned, and none for a planned one", () => {
    const routes = registeredRoutes();
    expect(routes.size).toBeGreaterThan(40);
    for (const op of operations) expect(routes.has(`${op.method} ${nestPath(op.path)}`), `${op.id} has no handler`).toBe(true);
    // The implementation PR must remove x-gromesh-planned: a planned operation with a handler fails here.
    for (const op of planned) expect(routes.has(`${op.method} ${nestPath(op.path)}`), `${op.id} is marked x-gromesh-planned but has a handler`).toBe(false);
  });

  it("answers 401 to every operation without a session", async () => {
    for (const op of operations) {
      const res = await h.anonymous(op.method, concrete(op.path), mutation(op.method) ? {} : undefined);
      expect(res.status, `${op.id}`).toBe(401);
    }
  });

  it("answers 403 to every mutation without the CSRF token, before validating anything", async () => {
    const editor = await h.as("admin");
    for (const op of operations.filter((o) => mutation(o.method))) {
      const res = await editor.api(op.method, concrete(op.path), {}, { "x-csrf-token": "" });
      expect(res.status, `${op.id}`).toBe(403);
      expect(res.body.detail).toContain("CSRF");
    }
  });

  it("applies x-required-role: 403 below the role, never 401/403 at or above it", async () => {
    const clients: Record<Operation["role"], ApiClient> = { viewer: (await h.as("viewer")).api, editor: (await h.as("editor")).api, admin: (await h.as("admin")).api };
    for (const op of operations) {
      for (const role of ["viewer", "editor", "admin"] as const) {
        const res = await clients[role](op.method, concrete(op.path), mutation(op.method) ? {} : undefined);
        if (RANK[role] < RANK[op.role]) expect(res.status, `${role} on ${op.id}`).toBe(403);
        else expect([401, 403], `${role} on ${op.id} → ${res.status}`).not.toContain(res.status);
      }
    }
  });

  it("accepts an API token wherever the contract allows the bearer scheme, with the token's role, and never where it does not", async () => {
    expect(sessionOnly.size).toBeGreaterThan(5);
    expect([...sessionOnly]).toEqual(expect.arrayContaining(["createMyToken", "revokeMyToken", "listTokens", "revokeToken", "listUsers", "createUser", "getCsrfToken"]));
    const clients: Record<Operation["role"], ApiClient> = { viewer: null!, editor: null!, admin: null! };
    for (const role of ["viewer", "editor", "admin"] as const) {
      const user = await h.as(role);
      const token = await user.api("POST", "/users/me/tokens", { name: `matrix-${role}`, role, expiresInDays: 1 });
      expect(token.status, JSON.stringify(token.body)).toBe(201);
      clients[role] = (method, path, body, headers = {}) => h.anonymous(method, path, body, { authorization: `Bearer ${token.body.token}`, ...headers });
    }
    for (const op of operations) {
      for (const role of ["viewer", "editor", "admin"] as const) {
        // No CSRF header on mutations: a bearer never needs one.
        const res = await clients[role](op.method, concrete(op.path), mutation(op.method) ? {} : undefined);
        if (sessionOnly.has(op.id)) expect(res.status, `${role} by token on ${op.id}`).toBe(401);
        else if (RANK[role] < RANK[op.role]) expect(res.status, `${role} by token on ${op.id}`).toBe(403);
        else expect([401, 403], `${role} by token on ${op.id} → ${res.status}`).not.toContain(res.status);
      }
    }
  });
});
