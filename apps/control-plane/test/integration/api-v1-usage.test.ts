import { ADMIN_URL, integrationDatabaseName, createIntegrationDatabase, dropIntegrationDatabase } from "./databases.js";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Role } from "../../src/auth/environment-access.js";
import { contractsV2 } from "../../src/common/contract.js";
import { runMigrations } from "../../src/db/migrate.js";
import { ApiV1UsageService, CONFIRM_MS } from "../../src/instance/instance.js";
import { type ApiClient, type ApiResponse, startHarness, uniq, type Harness } from "./harness.js";

// N1-X5: what still calls the v1 the controlled migration will cut (decision H-9), the migration report, and one
// authorization for both APIs. A database of its own: other files call v1 too, and their calls would count here.
const name = integrationDatabaseName("usage");

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
    return res.body as { windowDays: number; since: string; completeThrough: string; silentReplicas: { replicaId: string }[]; sessionCalls: number; tokens: { tokenId: string; tokenName: string; ownerId: string; calls: number; lastCalledOn: string }[] };
  };
  const bearer = (token: string): ApiClient => (method, path, body) => h.anonymous(method, path, body, { authorization: `Bearer ${token}` });
  /**
   * Stops the database's clock at `moment` (SQL) until the test ends: the rows a test sets relative to today and the
   * days it then expects fall on one UTC day, even when a midnight passes while it runs.
   */
  const stopClock = async (moment = "pg_catalog.now()") => {
    await h.sql.query(`delete from test_clock`);
    const [row] = (await h.sql.query(`insert into test_clock select ${moment} returning to_char(at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at`)).rows;
    return row.at as string;
  };

  beforeAll(async () => {
    await createIntegrationDatabase(name);
    const url = new URL(ADMIN_URL);
    url.pathname = `/${name}`;
    dbUrl = url.toString();
    await runMigrations(dbUrl);
    // A clock the tests can stop: in this database now() is public.now() (found before pg_catalog's), the pinned
    // moment if there is one, otherwise the real one. The UTC days are the database's, out of a fake timer's reach.
    const db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
    await db.query(`create table test_clock (at timestamptz not null)`);
    await db.query(`create function public.now() returns timestamptz language sql stable as 'select coalesce((select at from public.test_clock), pg_catalog.now())'`);
    await db.query(`alter database "${name}" set search_path = "$user", public, pg_catalog`);
    await db.end();
    // No timer: the test flushes the session calls itself.
    h = await startHarness({ databaseUrl: url.toString(), apiV1UsageFlushMs: 0 });
    usage = h.app.get(ApiV1UsageService);
    env = (await h.api("POST", "/environments", { name: uniq("usage") })).body.id as string;
  });
  afterAll(async () => {
    await h?.close();
    await dropIntegrationDatabase(name);
  });
  afterEach(async () => {
    await h?.sql.query(`delete from test_clock`);
  });

  it("counts each token's calls to the operations the cut reaches, written with the confirmation, and nothing else", async () => {
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
    // Not by the request: with the next confirmation.
    expect((await h.sql.query(`select calls from api_v1_usage where token_id = $1`, [tokenId])).rows).toEqual([]);
    await usage.flush();
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
      usage.record(null);
    } finally {
      vi.useRealTimers();
    }
    await usage.flush();
    const day = yesterday.toISOString().slice(0, 10);
    const [row] = (await h.sql.query(`select calls from api_v1_usage where token_id is null and day = $1`, [day])).rows;
    expect(row?.calls).toBeGreaterThanOrEqual(1);
  });

  it("keeps 30 days: older days leave the window and the table", async () => {
    await stopClock();
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
    // Stopping that replica closes its row only, never this one's.
    expect((await h.sql.query(`select closed from api_v1_usage_replicas where replica_id = $1`, [usage["replicaId" as keyof ApiV1UsageService] as unknown as string])).rows[0].closed).toBe(false);
    expect((await read()).tokens.find((t) => t.tokenId === created.body.id)).toMatchObject({ calls: 40 });
  });

  const day = (n: number) => h.sql.query(`select to_char((now() at time zone 'utc')::date - $1::int, 'YYYY-MM-DD') as d`, [n]).then((r) => r.rows[0].d as string);
  /** Midnight UTC n days ago, plus some hours. */
  const at = (n: number, hours = 0) => `((now() at time zone 'utc')::date - ${n})::timestamp at time zone 'utc' + interval '${hours} hours'`;
  const mine = () => usage["replicaId" as keyof ApiV1UsageService] as unknown as string;
  /** Only this replica on record, counting from `startedAt` (SQL): what a test of the window starts from. */
  const alone = async (startedAt: string) => {
    await h.sql.query(`delete from api_v1_usage_replicas where replica_id <> $1`, [mine()]);
    await h.sql.query(`update api_v1_usage_replicas set started_at = ${startedAt} where replica_id = $1`, [mine()]);
  };
  const dayAfter = (moment: string) => new Date(Date.parse(moment.slice(0, 10)) + 86_400_000).toISOString().slice(0, 10);

  it("starts the 30 days only once a replica counted a whole UTC day, and restarts them after a time nobody counted", async () => {
    await stopClock();
    // Counting began just now: no day is complete through the last confirmed moment, so since is the day after it
    // (tomorrow; today in the two minutes after midnight UTC, when nothing of today is confirmed yet).
    await alone("now()");
    const fresh = await read();
    expect(fresh.since).toBe(dayAfter(fresh.completeThrough));
    await alone(at(29));
    const r = await read();
    expect(r.since).toBe(await day(29));
    expect(Date.parse(r.completeThrough)).toBeLessThan(Date.now() - 60_000);
    // A rollback to a release that does not count, from 08:00 of five days ago to noon of four days ago.
    await h.sql.query(`insert into api_v1_usage_replicas (replica_id, started_at, seen_at, closed) values (gen_random_uuid(), ${at(29)}, ${at(5, 8)}, true)`);
    await h.sql.query(`update api_v1_usage_replicas set started_at = ${at(4, 12)} where replica_id = $1`, [mine()]);
    expect((await read()).since).toBe(await day(3));
    // A restart: two minutes without a replica is no gap, three are.
    await h.sql.query(`delete from api_v1_usage_replicas where replica_id <> $1`, [mine()]);
    await h.sql.query(`insert into api_v1_usage_replicas (replica_id, started_at, seen_at, closed) values (gen_random_uuid(), ${at(29)}, ${at(5, 8)}, true)`);
    await h.sql.query(`update api_v1_usage_replicas set started_at = ${at(5, 8)} + interval '2 minutes' where replica_id = $1`, [mine()]);
    expect((await read()).since).toBe(await day(29));
    await h.sql.query(`update api_v1_usage_replicas set started_at = ${at(5, 8)} + interval '3 minutes' where replica_id = $1`, [mine()]);
    expect((await read()).since).toBe(await day(4));
  });

  it("starts the 30 days the same at any time of the UTC day, the two minutes after midnight included", async () => {
    // Yesterday, so that this replica's confirmations (the real clock) are never behind the pinned one.
    const midnight = `date_trunc('day', pg_catalog.now() at time zone 'utc') at time zone 'utc' - interval '1 day'`;
    for (const [moment, nothingYet] of [[`${midnight} + interval '1 minute'`, 0], [`${midnight} + interval '12 hours'`, -1]] as const) {
      const now = await stopClock(moment);
      // Counting began just now. At 00:01 nothing of today is confirmed yet and yesterday is incomplete: since is
      // today. At noon today is incomplete: since is tomorrow.
      await alone("now()");
      const fresh = await read();
      expect(Date.parse(fresh.completeThrough)).toBe(Date.parse(now) - CONFIRM_MS);
      expect(fresh.since).toBe(await day(nothingYet));
      // Counted for 29 days: the whole window is complete, also while nothing of today is confirmed yet.
      await alone(at(29));
      expect((await read()).since).toBe(await day(29));
    }
  });

  it("keeps the 30 days from completing while a replica that went silent without stopping cleanly is on record", async () => {
    await stopClock();
    await alone(at(29));
    // Silent: it may be up, taking calls it cannot count, so no day from its last confirmation on is complete.
    await h.sql.query(`insert into api_v1_usage_replicas (replica_id, started_at, seen_at) values (gen_random_uuid(), ${at(29)}, ${at(10)} - interval '1 second')`);
    expect((await read()).since).toBe(await day(-1));
    await h.sql.query(`delete from api_v1_usage_replicas where seen_at = ${at(10)} - interval '1 second'`);
    expect((await read()).since).toBe(await day(29));
    // Never pruned, however old, and listed: nothing proves it stopped taking calls. A closed one leaves with the window.
    await h.sql.query(`insert into api_v1_usage_replicas (replica_id, started_at, seen_at) values ('00000000-0000-4000-8000-0000000000c1', ${at(60)}, ${at(45)})`);
    await h.sql.query(`insert into api_v1_usage_replicas (replica_id, started_at, seen_at, closed) values (gen_random_uuid(), ${at(60)}, ${at(44)}, true)`);
    const r = await read();
    expect(r.since).toBe(await day(-1));
    expect(r.silentReplicas).toEqual([expect.objectContaining({ replicaId: "00000000-0000-4000-8000-0000000000c1" })]);
    expect((await h.sql.query(`select closed from api_v1_usage_replicas where started_at = ${at(60)}`)).rows).toEqual([{ closed: false }]);
    await h.sql.query(`delete from api_v1_usage_replicas where started_at = ${at(60)}`);
    expect((await read()).since).toBe(await day(29));
  });

  it("confirms one at a time: a later confirmation waits for the counts an earlier one is still writing", async () => {
    const order: string[] = [];
    let release!: () => void;
    type Adder = { add: (...a: unknown[]) => Promise<void> };
    const add = (usage as unknown as Adder).add.bind(usage);
    const spy = vi.spyOn(usage as unknown as Adder, "add")
      .mockImplementationOnce(async (...a) => { order.push("first:start"); await new Promise<void>((r) => (release = r)); await add(...a); order.push("first:end"); })
      .mockImplementationOnce(async (...a) => { order.push("second:start"); await add(...a); order.push("second:end"); });
    try {
      usage.record(null);
      const first = usage.flush();
      for (let i = 0; i < 100 && !release; i++) await new Promise((r) => setTimeout(r, 10));
      usage.record(null);
      const second = usage.flush();
      await new Promise((r) => setTimeout(r, 100));
      expect(order).toEqual(["first:start"]);
      release();
      await Promise.all([first, second]);
      expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("closes the row only once the HTTP server takes no more calls, writing every call it took", async () => {
    const created = await h.api("POST", "/users/me/tokens", { name: uniq("late"), role: "viewer", expiresInDays: 1 });
    const other = await startHarness({ databaseUrl: dbUrl, apiV1UsageFlushMs: 0 });
    const theirs = other.app.get(ApiV1UsageService);
    const id = theirs["replicaId" as keyof ApiV1UsageService] as unknown as string;
    const call = () => other.anonymous("GET", `/environments/${env}/services`, undefined, { authorization: `Bearer ${created.body.token as string}` });
    try {
      expect((await call()).status).toBe(200);
      // Module teardown: the server still takes calls, so the row stays open.
      theirs.onModuleDestroy();
      expect((await call()).status).toBe(200);
      expect((await h.sql.query(`select closed from api_v1_usage_replicas where replica_id = $1`, [id])).rows[0].closed).toBe(false);
    } finally {
      await other.close();
    }
    expect((await h.sql.query(`select closed from api_v1_usage_replicas where replica_id = $1`, [id])).rows[0].closed).toBe(true);
    expect((await read()).tokens.find((t) => t.tokenId === created.body.id)).toMatchObject({ calls: 2 });
  });

  it("never confirms past a token call still being authenticated, and a stop waits for it before closing", async () => {
    const other = await startHarness({ databaseUrl: dbUrl, apiV1UsageFlushMs: 0 });
    const theirs = other.app.get(ApiV1UsageService);
    const id = theirs["replicaId" as keyof ApiV1UsageService] as unknown as string;
    const admitted = Date.now();
    const call = theirs.begin();
    await new Promise((r) => setTimeout(r, 50));
    await theirs.flush();
    const seen = (await h.sql.query(`select seen_at from api_v1_usage_replicas where replica_id = $1`, [id])).rows[0].seen_at as Date;
    expect(seen.getTime()).toBeLessThanOrEqual(admitted + 5);
    const stopping = other.close();
    await new Promise((r) => setTimeout(r, 200));
    theirs.record(null);
    theirs.end(call);
    await stopping;
    expect((await h.sql.query(`select closed from api_v1_usage_replicas where replica_id = $1`, [id])).rows[0].closed).toBe(true);
  });

  it("serves the calls while their counts cannot be written; the 30 days cannot complete while that replica is silent", async () => {
    await stopClock();
    const created = await h.api("POST", "/users/me/tokens", { name: uniq("lost"), role: "viewer", expiresInDays: 1 });
    await alone(at(29));
    const other = await startHarness({ databaseUrl: dbUrl, apiV1UsageFlushMs: 0 });
    const theirs = other.app.get(ApiV1UsageService);
    const id = theirs["replicaId" as keyof ApiV1UsageService] as unknown as string;
    try {
      await h.sql.query(`update api_v1_usage_replicas set started_at = ${at(29)}`);
      // That replica cannot write anything: the request never waits for it.
      await other.sql.query(`alter table api_v1_usage rename to api_v1_usage_off`);
      try {
        const started = Date.now();
        expect((await other.anonymous("GET", `/environments/${env}/services`, undefined, { authorization: `Bearer ${created.body.token as string}` })).status).toBe(200);
        expect(Date.now() - started).toBeLessThan(2_000);
        await expect(theirs.flush()).rejects.toThrow();
      } finally {
        await other.sql.query(`alter table api_v1_usage_off rename to api_v1_usage`);
      }
      // Its confirmation did not move: within two minutes it is not claimed, past them it is silent.
      expect(Date.parse((await read()).completeThrough)).toBeLessThan(Date.now());
      await h.sql.query(`update api_v1_usage_replicas set seen_at = seen_at - interval '3 minutes' where replica_id = $1`, [id]);
      const blocked = await read();
      expect(blocked.since).toBe(await day(-1));
      expect(blocked.silentReplicas.map((r) => r.replicaId)).toEqual([id]);
      // Once it writes again, the call is counted and nothing is missing.
      await theirs.flush();
      const back = await read();
      expect(back.since).toBe(await day(29));
      expect(back.tokens.find((t) => t.tokenId === created.body.id)).toMatchObject({ calls: 1 });
    } finally {
      await other.close();
    }
  });

  it("does not hold a request behind a blocked usage row", async () => {
    const created = await h.api("POST", "/users/me/tokens", { name: uniq("blocked"), role: "viewer", expiresInDays: 1 });
    expect((await bearer(created.body.token as string)("GET", `/environments/${env}/services`)).status).toBe(200);
    await usage.flush();
    const holder = await h.sql.connect();
    try {
      await holder.query("begin");
      await holder.query("select calls from api_v1_usage where token_id = $1 for update", [created.body.id]);
      const started = Date.now();
      for (let i = 0; i < 5; i++) expect((await bearer(created.body.token as string)("GET", `/environments/${env}/services`)).status).toBe(200);
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await holder.query("rollback");
      holder.release();
    }
    expect((await read()).tokens.find((t) => t.tokenId === created.body.id)).toMatchObject({ calls: 6 });
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
    const cons = (await h.api("POST", `/environments/${env}/consumers`, { username: uniq("matrix") })).body.id as string;
    const operations: { name: string; v1: (c: ApiClient) => Promise<ApiResponse>; v2: (c: ApiClient) => Promise<ApiResponse> }[] = [
      { name: "list services", v1: (c) => c("GET", `/environments/${env}/services`), v2: (c) => v2(c, "GET", `/workspaces/${env}/services`) },
      { name: "list routes", v1: (c) => c("GET", `/environments/${env}/routes`), v2: (c) => v2(c, "GET", `/workspaces/${env}/routes`) },
      { name: "list plugins", v1: (c) => c("GET", `/environments/${env}/plugins`), v2: (c) => v2(c, "GET", `/workspaces/${env}/plugins`) },
      { name: "export", v1: (c) => c("GET", `/environments/${env}/export`), v2: (c) => v2(c, "GET", `/workspaces/${env}/export`) },
      { name: "create key-auth", v1: (c) => c("POST", `/environments/${env}/consumers/${cons}/key-auth`, {}), v2: (c) => v2(c, "POST", `/workspaces/${env}/consumers/${cons}/key-auth`, {}) },
      { name: "create basic-auth", v1: (c) => c("POST", `/environments/${env}/consumers/${cons}/basic-auth`, { username: uniq("b"), password: "password-123" }), v2: (c) => v2(c, "POST", `/workspaces/${env}/consumers/${cons}/basic-auth`, { username: uniq("b"), password: "password-123" }) },
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
  }, 120_000);
});
