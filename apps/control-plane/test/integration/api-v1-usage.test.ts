import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Role } from "../../src/auth/environment-access.js";
import { contractsV2 } from "../../src/common/contract.js";
import { runMigrations } from "../../src/db/migrate.js";
import { ApiV1UsageService } from "../../src/instance/instance.js";
import { type ApiClient, type ApiResponse, startHarness, uniq, type Harness } from "./harness.js";

// N1-X5: what still calls the v1 the controlled migration will cut (decision H-9), the migration report, and one
// authorization for both APIs. A database of its own: other files call v1 too, and their calls would count here.
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://gromesh:gromesh@127.0.0.1:5432/gromesh";
const name = `gromesh_usage_${Date.now()}_${process.pid}`;

describe("the v1 calls the cut will remove, the migration report and one authorization for v1 and v2", () => {
  let h: Harness;
  let usage: ApiV1UsageService;
  let env: string;
  let dbUrl: string;
  const v2 = (client: ApiClient, method: string, path: string, body?: unknown) => client(method, `/../v2${path}`, body);
  const read = async () => {
    const res = await v2(h.api, "GET", "/instance/api-v1-usage");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const validate = contractsV2.validator("ApiV1Usage");
    expect(validate(structuredClone(res.body)), JSON.stringify(validate.errors)).toBe(true);
    return res.body as { windowDays: number; since: string; sessionCalls: number; tokens: { tokenId: string; tokenName: string; ownerId: string; calls: number; lastCalledOn: string }[] };
  };
  const bearer = (token: string): ApiClient => (method, path, body) => h.anonymous(method, path, body, { authorization: `Bearer ${token}` });

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}"`);
    await admin.end();
    const url = new URL(ADMIN_URL);
    url.pathname = `/${name}`;
    dbUrl = url.toString();
    await runMigrations(dbUrl);
    // No timer: the test flushes the session calls itself.
    h = await startHarness({ databaseUrl: url.toString(), apiV1UsageFlushMs: 0 });
    usage = h.app.get(ApiV1UsageService);
    env = (await h.api("POST", "/environments", { name: uniq("usage") })).body.id as string;
  });
  afterAll(async () => {
    await h?.close();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  });

  it("counts each token's calls to the operations the cut reaches at once, sessions once flushed, and nothing else", async () => {
    const before = await read();
    const created = await h.api("POST", "/users/me/tokens", { name: uniq("ci"), role: "viewer", expiresInDays: 1 });
    const token = created.body.token as string;
    const tokenId = created.body.id as string;
    // Reached by the cut: under /environments/{envId}, /clusters/{clusterId}, and GET /environments; a refused call too.
    expect((await bearer(token)("GET", `/environments/${env}/services`)).status).toBe(200);
    expect((await bearer(token)("GET", "/environments")).status).toBe(200);
    expect((await bearer(token)("POST", `/environments/${env}/services`, { name: uniq("s"), protocol: "http", host: "a.example.com", port: 80 })).status).toBe(403);
    // Not reached: the user's own data, and v2.
    expect((await bearer(token)("GET", "/me")).status).toBe(200);
    expect((await v2(bearer(token), "GET", `/workspaces/${env}/services`)).status).toBe(200);
    // Written at once, before any flush.
    const [row] = (await h.sql.query(`select calls from api_v1_usage where token_id = $1`, [tokenId])).rows;
    expect(row).toEqual({ calls: 3 });
    // The admin's session calls: counted, written when flushed (read() flushes).
    expect((await h.api("GET", `/environments/${env}`)).status).toBe(200);
    const after = await read();
    const mine = after.tokens.find((t) => t.tokenId === tokenId)!;
    expect(mine).toMatchObject({ tokenName: created.body.name, calls: 3 });
    expect(mine.ownerId).toBe((await h.api("GET", "/me")).body.id);
    expect(after.sessionCalls).toBeGreaterThan(before.sessionCalls);
    expect(after.windowDays).toBe(30);
    // Never a token value, a path parameter or a body.
    expect(JSON.stringify(after)).not.toContain(token);
    expect(JSON.stringify(after)).not.toContain(env);
  });

  it("keeps a token's calls in the window after the token and its owner are deleted", async () => {
    const owner = await h.as("editor");
    const created = await owner.api("POST", "/users/me/tokens", { name: uniq("gone"), role: "viewer", expiresInDays: 1 });
    expect((await bearer(created.body.token as string)("GET", `/environments/${env}/services`)).status).toBe(200);
    expect((await h.api("DELETE", `/users/${owner.id}`)).status).toBe(204);
    expect((await read()).tokens.find((t) => t.tokenId === created.body.id)).toMatchObject({ tokenName: created.body.name, ownerId: owner.id, calls: 1 });
  });

  it("counts a token calling a session-only operation the cut reaches, and still refuses it", async () => {
    const created = await h.api("POST", "/users/me/tokens", { name: uniq("rb"), role: "admin", expiresInDays: 1 });
    const res = await bearer(created.body.token as string)("POST", `/environments/${env}/snapshots/1/rollback`);
    expect(res.status).toBe(401);
    expect((await read()).tokens.find((t) => t.tokenId === created.body.id)).toMatchObject({ calls: 1 });
  });

  it("writes a session call on the UTC day it was made, even when written after midnight", async () => {
    await usage.flush();
    const yesterday = new Date(Date.now() - 24 * 3600_000);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(`${yesterday.toISOString().slice(0, 10)}T23:59:59.900Z`));
      await usage.record(null);
    } finally {
      vi.useRealTimers();
    }
    await usage.flush();
    const day = yesterday.toISOString().slice(0, 10);
    const [row] = (await h.sql.query(`select calls from api_v1_usage where token_id is null and day = $1`, [day])).rows;
    expect(row?.calls).toBeGreaterThanOrEqual(1);
  });

  it("keeps 30 days: older days leave the window and the table", async () => {
    const created = await h.api("POST", "/users/me/tokens", { name: uniq("old"), role: "viewer", expiresInDays: 1 });
    await h.sql.query(`insert into api_v1_usage (day, token_id, token_name, owner_id, calls) values ((now() at time zone 'utc')::date - 30, $1, $2, $3, 7), ((now() at time zone 'utc')::date - 29, $1, $2, $3, 2)`, [created.body.id, created.body.name, (await h.api("GET", "/me")).body.id]);
    const r = await read();
    expect(r.tokens.find((t) => t.tokenId === created.body.id)).toMatchObject({ calls: 2 });
    expect((await h.sql.query(`select count(*)::int as n from api_v1_usage where token_id = $1`, [created.body.id])).rows[0].n).toBe(1);
  });

  it("counts every one of concurrent token calls, through two replicas of the control plane", async () => {
    const created = await h.api("POST", "/users/me/tokens", { name: uniq("burst"), role: "viewer", expiresInDays: 1 });
    const token = created.body.token as string;
    const other = await startHarness({ databaseUrl: dbUrl, apiV1UsageFlushMs: 0 });
    try {
      const via = (base: Harness) => (method: string, path: string) => base.anonymous(method, path, undefined, { authorization: `Bearer ${token}` });
      const calls = await Promise.all(Array.from({ length: 40 }, (_, i) => via(i % 2 ? other : h)("GET", `/environments/${env}/services`)));
      expect(calls.map((c) => c.status)).toEqual(Array(40).fill(200));
    } finally {
      await other.close();
    }
    expect((await read()).tokens.find((t) => t.tokenId === created.body.id)).toMatchObject({ calls: 40 });
  });

  it("starts the 30 days only once counting began, and restarts them after a day nobody counted or a write failed", async () => {
    const day = (n: number) => h.sql.query(`select to_char((now() at time zone 'utc')::date - $1::int, 'YYYY-MM-DD') as d`, [n]).then((r) => r.rows[0].d as string);
    // Counting began today (this database): nothing before it is known.
    expect((await read()).since).toBe(await day(0));
    await h.sql.query(`insert into api_v1_usage_coverage (day, failures) select (now() at time zone 'utc')::date - n, 0 from generate_series(1, 29) n`);
    expect((await read()).since).toBe(await day(29));
    await h.sql.query(`update api_v1_usage_coverage set failures = 1 where day = (now() at time zone 'utc')::date - 10`);
    expect((await read()).since).toBe(await day(9));
    await h.sql.query(`delete from api_v1_usage_coverage where day = (now() at time zone 'utc')::date - 5`);
    expect((await read()).since).toBe(await day(4));
    await h.sql.query(`delete from api_v1_usage_coverage where day < (now() at time zone 'utc')::date`);
  });

  it("refuses a token call it cannot count, and keeps today out of the 30 days, even when the next write fails too", async () => {
    const created = await h.api("POST", "/users/me/tokens", { name: uniq("lost"), role: "viewer", expiresInDays: 1 });
    await h.sql.query(`alter table api_v1_usage rename to api_v1_usage_off`);
    try {
      expect((await bearer(created.body.token as string)("GET", `/environments/${env}/services`)).status).toBe(500);
      await h.sql.query(`alter table api_v1_usage_coverage rename to api_v1_usage_coverage_off`);
      await expect(usage.flush()).rejects.toThrow();
      await h.sql.query(`alter table api_v1_usage_coverage_off rename to api_v1_usage_coverage`);
    } finally {
      await h.sql.query(`alter table if exists api_v1_usage_off rename to api_v1_usage`);
    }
    const tomorrow = (await h.sql.query(`select to_char((now() at time zone 'utc')::date + 1, 'YYYY-MM-DD') as d`)).rows[0].d;
    expect((await read()).since).toBe(tomorrow);
    expect((await h.sql.query(`select failures from api_v1_usage_coverage where day = (now() at time zone 'utc')::date`)).rows[0].failures).toBe(1);
    await h.sql.query(`update api_v1_usage_coverage set failures = 0`);
  });

  it("serves the usage and the migration report to platform administration only", async () => {
    const editor = await h.as("editor");
    expect((await v2(editor.api, "GET", "/instance/api-v1-usage")).status).toBe(403);
    expect((await v2(editor.api, "GET", "/instance/workspace-migration")).status).toBe(403);
  });

  it("reports, without writing anything, who loses the implicit access of a global role from N2 on", async () => {
    const editor = await h.as("editor");
    const viewer = await h.as("viewer");
    const off = await h.as("viewer");
    await h.sql.query(`update users set active = false where id = $1`, [off.id]);
    // An environment an older replica created: no slug yet.
    await h.sql.query(`insert into environments (id, name) values ('00000000-0000-4000-8000-0000000000aa', 'Tardio')`);
    const state = () => h.sql.query(`select (select count(*)::int from workspaces where slug is null) as pending, (select count(*)::int from pg_indexes where indexname like '%instance_uq') as indexes`).then((r) => r.rows[0]);
    const before = await state();
    const res: ApiResponse = await v2(h.api, "GET", "/instance/workspace-migration");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const validate = contractsV2.validator("WorkspaceMigrationReport");
    expect(validate(structuredClone(res.body)), JSON.stringify(validate.errors)).toBe(true);
    expect(await state()).toEqual(before);
    expect(res.body.workspaces.find((w: { workspaceId: string }) => w.workspaceId === "00000000-0000-4000-8000-0000000000aa")).toMatchObject({ slug: "tardio" });
    const changes = res.body.accessChanges as { userId: string; globalRole: string }[];
    expect(changes).toEqual(expect.arrayContaining([
      { userId: editor.id, globalRole: "editor", change: "implicit-access-dropped" },
      { userId: viewer.id, globalRole: "viewer", change: "implicit-access-dropped" },
    ]));
    expect(changes.map((c) => c.userId)).not.toContain(off.id);
    const admin = (await h.api("GET", "/me")).body.id;
    expect(changes.map((c) => c.userId)).not.toContain(admin);
  });

  it("decides each operation the same through v1 and v2, for every global role, environment role and token", async () => {
    const operations: { name: string; v1: (c: ApiClient) => Promise<ApiResponse>; v2: (c: ApiClient) => Promise<ApiResponse> }[] = [
      { name: "list consumers", v1: (c) => c("GET", `/environments/${env}/consumers`), v2: (c) => v2(c, "GET", `/workspaces/${env}/consumers`) },
      { name: "create consumer", v1: (c) => c("POST", `/environments/${env}/consumers`, { username: uniq("u") }), v2: (c) => v2(c, "POST", `/workspaces/${env}/consumers`, { username: uniq("u") }) },
      { name: "list upstreams", v1: (c) => c("GET", `/environments/${env}/upstreams`), v2: (c) => v2(c, "GET", `/workspaces/${env}/upstreams`) },
      { name: "create upstream", v1: (c) => c("POST", `/environments/${env}/upstreams`, { name: uniq("p") }), v2: (c) => v2(c, "POST", `/workspaces/${env}/upstreams`, { name: uniq("p") }) },
    ];
    let compared = 0;
    for (const global of ["viewer", "editor", "admin"] as Role[]) {
      for (const override of [undefined, "none", "viewer", "editor", "admin"] as const) {
        const person = await h.as(global);
        if (override) await h.api("PUT", `/users/${person.id}/environment-roles`, { items: [{ environmentId: env, role: override }] });
        const clients: [string, ApiClient][] = [["session", person.api]];
        for (const role of ["viewer", "editor", "admin"] as Role[]) {
          const t = await person.api("POST", "/users/me/tokens", { name: uniq("t"), role, expiresInDays: 1 });
          if (t.status === 201) clients.push([`token ${role}`, bearer(t.body.token as string)]);
        }
        for (const [via, client] of clients) {
          for (const op of operations) {
            const [a, b] = [await op.v1(client), await op.v2(client)];
            expect(b.status, `${global}/${override ?? "-"} ${via}: ${op.name} (v1 ${a.status})`).toBe(a.status);
            compared++;
          }
        }
      }
    }
    expect(compared).toBeGreaterThanOrEqual(15 * operations.length);
  });
});
