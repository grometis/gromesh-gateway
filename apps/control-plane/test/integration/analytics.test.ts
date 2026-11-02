import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { maskClientIp } from "../../src/analytics/analytics.js";
import { CLICKHOUSE, CLICKHOUSE_ADMIN, startHarness, uniq, type ApiClient, type ApiResponse, type Harness } from "./harness.js";

let h: Harness;
const admin = createClient({ url: CLICKHOUSE.url, username: CLICKHOUSE_ADMIN.user, password: CLICKHOUSE_ADMIN.password, database: CLICKHOUSE.database });

beforeAll(async () => {
  const ping = await admin.ping();
  if (!ping.success) throw new Error(`These tests read a real ClickHouse at ${CLICKHOUSE.url}: run the compose \`observability\` profile or set TEST_CLICKHOUSE_URL`);
  // The compose ClickHouse applies these on first start; a bare CI service does not. Both are idempotent, and the
  // reads compare every column of a row, retention_days (002) included.
  for (const file of ["001-requests.sql", "002-retention.sql"]) {
    const ddl = readFileSync(new URL(`../../../../deploy/observability/clickhouse/${file}`, import.meta.url), "utf8");
    for (const statement of ddl.split(";").map((s) => s.trim()).filter(Boolean)) await admin.command({ query: statement });
  }
  h = await startHarness();
});
afterAll(async () => {
  await h?.close();
  await admin.close();
});

/** Fixture: a known traffic shape in two 5-minute buckets, 20 minutes ago. */
const base = Math.floor((Date.now() - 20 * 60_000) / 60_000) * 60_000;
const at = (offsetMs: number) => new Date(base + offsetMs).toISOString().replace("T", " ").replace("Z", "");
const row = (envId: string, offsetMs: number, status: number, latency: number, extra: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  ts: at(offsetMs),
  environment_id: envId,
  cluster_id: "00000000-0000-4000-8000-0000000000c1",
  service_id: "00000000-0000-4000-8000-0000000000a1",
  route_id: "00000000-0000-4000-8000-0000000000b1",
  consumer_id: null,
  method: "GET",
  path: "/orders/42",
  status,
  latency_kong_ms: 1.2,
  latency_upstream_ms: latency - 1,
  latency_total_ms: latency,
  client_ip: "203.0.113.10",
  request_size: 300,
  response_size: 1800,
  ...extra,
});

async function seed() {
  const env = await h.api("POST", "/environments", { name: uniq("analytics") });
  const envId = env.body.id as string;
  const other = randomUUID();
  const rows = [
    // Bucket A: four 200s at 10 ms, one of them for a consumer on another route.
    row(envId, 10_000, 200, 10),
    row(envId, 20_000, 200, 10),
    row(envId, 30_000, 200, 10, { consumer_id: "00000000-0000-4000-8000-0000000000d1" }),
    row(envId, 40_000, 200, 10, { route_id: "00000000-0000-4000-8000-0000000000b2", path: "/other" }),
    // Bucket B: a 500 and a 404 at 100 ms, the 500 from IPv6 and without upstream.
    row(envId, 5 * 60_000 + 10_000, 500, 100, { client_ip: "2001:db8:1234:5678::1", latency_upstream_ms: null }),
    row(envId, 5 * 60_000 + 20_000, 404, 100),
    // Another environment, never visible here.
    row(other, 15_000, 200, 999),
  ];
  await admin.insert({ table: "requests", values: rows, format: "JSONEachRow" });
  return { envId, other, rows };
}

const period = (fromOffsetMs = 0, toOffsetMs = 10 * 60_000) => `from=${new Date(base + fromOffsetMs).toISOString()}&to=${new Date(base + toOffsetMs).toISOString()}`;

/** Fixture for the ranking: four routes with distinct winners per criterion, one of them a real route of the environment. */
async function seedTop() {
  const env = await h.api("POST", "/environments", { name: uniq("top") });
  const envId = env.body.id as string;
  const svc = await h.api("POST", `/environments/${envId}/services`, { name: uniq("svc"), protocol: "http", host: "echo", port: 80 });
  const named = await h.api("POST", `/environments/${envId}/routes`, { name: "orders-route", serviceId: svc.body.id, paths: ["/orders"] });
  expect(named.status, JSON.stringify(named.body)).toBe(201);
  const R = named.body.id as string;
  const gone = "00000000-0000-4000-8000-0000000000b2"; // never existed in the control plane: id kept, name null
  const slow = "00000000-0000-4000-8000-0000000000b3";
  const rows = [
    // R: 5 requests, 2 errors, p95 100
    row(envId, 1_000, 200, 10, { route_id: R, service_id: svc.body.id }),
    row(envId, 2_000, 200, 10, { route_id: R, service_id: svc.body.id }),
    row(envId, 3_000, 200, 10, { route_id: R, service_id: svc.body.id }),
    row(envId, 4_000, 500, 100, { route_id: R, service_id: svc.body.id }),
    row(envId, 5_000, 404, 100, { route_id: R, service_id: svc.body.id }),
    // gone: 1 request, p95 10
    row(envId, 6_000, 200, 10, { route_id: gone }),
    // slow: 3 requests, no errors, p95 500
    row(envId, 7_000, 200, 500, { route_id: slow }),
    row(envId, 8_000, 200, 500, { route_id: slow }),
    row(envId, 9_000, 200, 500, { route_id: slow }),
    // no route matched: 2 requests, 2 errors, p95 5
    row(envId, 10_000, 404, 5, { route_id: null, service_id: null, path: "/nowhere" }),
    row(envId, 11_000, 404, 5, { route_id: null, service_id: null, path: "/nowhere" }),
    // another environment
    row(randomUUID(), 1_000, 200, 999),
  ];
  await admin.insert({ table: "requests", values: rows, format: "JSONEachRow" });
  return { envId, R, gone, slow, serviceId: svc.body.id as string };
}

describe("analytics top routes", () => {
  it("ranks by requests, errors (4xx + 5xx) and p95, with names from the control plane and null for deleted or unmatched", async () => {
    const { envId, R, gone, slow, serviceId } = await seedTop();
    const ids = (res: ApiResponse) => (res.body.items as { routeId: string | null }[]).map((i) => i.routeId);

    const byRequests = await h.api("GET", `/environments/${envId}/analytics/top-routes?${period()}`);
    expect(byRequests.status, JSON.stringify(byRequests.body)).toBe(200);
    expect(byRequests.body).toMatchObject({ from: new Date(base).toISOString(), to: new Date(base + 10 * 60_000).toISOString(), by: "requests" });
    expect(ids(byRequests)).toEqual([R, slow, null, gone]);
    expect(byRequests.body.items[0]).toEqual({
      routeId: R, routeName: "orders-route", serviceId, requests: 5, errors4xx: 1, errors5xx: 1, errorRate: 0.4, p50Ms: 10, p95Ms: 100, p99Ms: 100,
    });
    expect(byRequests.body.items[2]).toMatchObject({ routeId: null, routeName: null, serviceId: null, requests: 2, errors4xx: 2, errorRate: 1, p95Ms: 5 });
    expect(byRequests.body.items[3]).toMatchObject({ routeId: gone, routeName: null, requests: 1 });

    // errors: R and the unmatched traffic tie at 2, more requests first; then the error-free routes by requests.
    const byErrors = await h.api("GET", `/environments/${envId}/analytics/top-routes?${period()}&by=errors`);
    expect(byErrors.body.by).toBe("errors");
    expect(ids(byErrors)).toEqual([R, null, slow, gone]);

    const byP95 = await h.api("GET", `/environments/${envId}/analytics/top-routes?${period()}&by=p95&limit=2`);
    expect(byP95.body.by).toBe("p95");
    expect(ids(byP95)).toEqual([slow, R]);
    expect(byP95.body.items[0].p95Ms).toBe(500);
  });

  it("refuses an unknown criterion, a limit above 50 and the usual period errors", async () => {
    const { envId } = await seedTop();
    const bad = await h.api("GET", `/environments/${envId}/analytics/top-routes?${period()}&by=latency&limit=51`);
    expect(bad.status).toBe(422);
    expect(bad.body.errors.map((e: { path: string }) => e.path).sort()).toEqual(["by", "limit"]);
    const span = await h.api("GET", `/environments/${envId}/analytics/top-routes?from=${new Date(base - 8 * 86_400_000).toISOString()}&to=${new Date(base).toISOString()}`);
    expect(span.status).toBe(422);
    expect(span.body.errors[0].path).toBe("to");
    expect((await h.api("GET", `/environments/${randomUUID()}/analytics/top-routes?${period()}`)).status).toBe(404);
  });
});

describe("analytics summary", () => {
  it("aggregates totals and one point per bucket, filling the empty ones", async () => {
    const { envId } = await seed();
    const res = await h.api("GET", `/environments/${envId}/analytics/summary?${period(0, 15 * 60_000)}&interval=5m`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      from: new Date(base).toISOString(),
      to: new Date(base + 15 * 60_000).toISOString(),
      interval: "5m",
      totals: { requests: 6, errors4xx: 1, errors5xx: 1, errorRate: 2 / 6, p50Ms: 10, p95Ms: 100, p99Ms: 100 },
    });
    expect(res.body.series).toEqual([
      { ts: new Date(base).toISOString(), requests: 4, errors4xx: 0, errors5xx: 0, errorRate: 0, p50Ms: 10, p95Ms: 10, p99Ms: 10 },
      { ts: new Date(base + 5 * 60_000).toISOString(), requests: 2, errors4xx: 1, errors5xx: 1, errorRate: 1, p50Ms: 100, p95Ms: 100, p99Ms: 100 },
      { ts: new Date(base + 10 * 60_000).toISOString(), requests: 0, errors4xx: 0, errors5xx: 0, errorRate: 0, p50Ms: null, p95Ms: null, p99Ms: null },
    ]);
  });

  it("filters by route and service", async () => {
    const { envId } = await seed();
    const byRoute = await h.api("GET", `/environments/${envId}/analytics/summary?${period()}&routeId=00000000-0000-4000-8000-0000000000b2`);
    expect(byRoute.body.totals.requests).toBe(1);
    const byService = await h.api("GET", `/environments/${envId}/analytics/summary?${period()}&serviceId=00000000-0000-4000-8000-0000000000a1`);
    expect(byService.body.totals.requests).toBe(6);
    const none = await h.api("GET", `/environments/${envId}/analytics/summary?${period()}&serviceId=${randomUUID()}`);
    expect(none.body.totals).toEqual({ requests: 0, errors4xx: 0, errors5xx: 0, errorRate: 0, p50Ms: null, p95Ms: null, p99Ms: null });
  });

  it("refuses invalid periods and intervals with the parameter as path, 404 for an unknown environment", async () => {
    const { envId } = await seed();
    const cases: [string, string][] = [
      [`to=${new Date(base).toISOString()}`, "from"],
      [`from=${new Date(base).toISOString()}&to=${new Date(base - 1000).toISOString()}`, "to"],
      [`from=${new Date(base - 8 * 86_400_000).toISOString()}&to=${new Date(base).toISOString()}`, "to"],
      [`${period()}&interval=2h`, "interval"],
      [`from=${new Date(base - 7 * 86_400_000).toISOString()}&to=${new Date(base).toISOString()}&interval=1m`, "interval"],
      [`${period()}&routeId=not-a-uuid`, "routeId"],
    ];
    for (const [query, path] of cases) {
      const res = await h.api("GET", `/environments/${envId}/analytics/summary?${query}`);
      expect(res.status, query).toBe(422);
      expect(res.body.errors, query).toEqual([expect.objectContaining({ path })]);
    }
    expect((await h.api("GET", `/environments/${randomUUID()}/analytics/summary?${period()}`)).status).toBe(404);
  });
});

describe("request explorer", () => {
  it("lists newest first with a stable cursor, never crossing environments", async () => {
    const { envId, rows } = await seed();
    const ids = new Set(rows.filter((r) => r.environment_id === envId).map((r) => r.id));
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: ApiResponse = await h.api("GET", `/environments/${envId}/requests?${period()}&limit=4${cursor ? `&cursor=${cursor}` : ""}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      seen.push(...res.body.items.map((i: { id: string }) => i.id));
      cursor = res.body.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(2);
    expect(new Set(seen)).toEqual(ids);
    expect(seen).toHaveLength(ids.size);

    const first = (await h.api("GET", `/environments/${envId}/requests?${period()}&limit=1`)).body.items[0];
    expect(first).toEqual({
      id: expect.any(String),
      ts: new Date(base + 5 * 60_000 + 20_000).toISOString(),
      environmentId: envId,
      clusterId: "00000000-0000-4000-8000-0000000000c1",
      serviceId: "00000000-0000-4000-8000-0000000000a1",
      routeId: "00000000-0000-4000-8000-0000000000b1",
      consumerId: null,
      method: "GET",
      path: "/orders/42",
      status: 404,
      latencyKongMs: 1,
      latencyUpstreamMs: 99,
      latencyTotalMs: 100,
      clientIp: "203.0.113.10",
      requestSize: 300,
      responseSize: 1800,
    });
  });

  it("filters by status, status class, consumer and route; status and statusClass are exclusive", async () => {
    const { envId } = await seed();
    const count = async (query: string) => (await h.api("GET", `/environments/${envId}/requests?${period()}&${query}`)).body.items.length;
    expect(await count("status=200")).toBe(4);
    expect(await count("statusClass=5xx")).toBe(1);
    expect(await count("statusClass=4xx")).toBe(1);
    expect(await count("consumerId=00000000-0000-4000-8000-0000000000d1")).toBe(1);
    expect(await count("routeId=00000000-0000-4000-8000-0000000000b2")).toBe(1);
    const both = await h.api("GET", `/environments/${envId}/requests?${period()}&status=200&statusClass=2xx`);
    expect(both.status).toBe(422);
    expect(both.body.errors).toEqual([expect.objectContaining({ path: "statusClass" })]);
    const upstream = (await h.api("GET", `/environments/${envId}/requests?${period()}&status=500`)).body.items[0];
    expect(upstream.latencyUpstreamMs).toBeNull();
  });

  it("masks the client address for everyone but admins", async () => {
    const { envId } = await seed();
    const path = `/environments/${envId}/requests?${period()}&limit=10`;
    const asAdmin = (await h.api("GET", path)).body.items.map((i: { clientIp: string }) => i.clientIp);
    expect(asAdmin).toContain("203.0.113.10");
    expect(asAdmin).toContain("2001:db8:1234:5678::1");
    for (const role of ["viewer", "editor"] as const) {
      const client: ApiClient = (await h.as(role)).api;
      const ips = (await client("GET", path)).body.items.map((i: { clientIp: string }) => i.clientIp);
      expect(ips, role).toContain("203.0.113.0");
      expect(ips, role).toContain("2001:db8:1234::");
      expect(ips, role).not.toContain("203.0.113.10");
      expect(JSON.stringify(ips)).not.toContain("5678");
    }
  });

  it("answers 502 when the store is not configured or unreachable", async () => {
    const { envId } = await seed();
    for (const clickhouse of [null, { ...CLICKHOUSE, url: "http://127.0.0.1:9" }]) {
      const isolated = await startHarness({ clickhouse });
      try {
        const res = await isolated.api("GET", `/environments/${envId}/requests?${period()}`);
        expect(res.status).toBe(502);
        expect(res.contentType).toContain("application/problem+json");
      } finally {
        await isolated.close();
      }
    }
  });
});

describe("a request stored more than once (at-least-once delivery)", () => {
  it("counts each request id once in the summary, the ranking and the explorer, while the table keeps every copy", async () => {
    const env = await h.api("POST", "/environments", { name: uniq("dedup") });
    const envId = env.body.id as string;
    const once = row(envId, 10_000, 200, 10);
    const twice = row(envId, 20_000, 500, 100);
    // A Kong queue retry or a collector restart delivers the same request again: same id, same content, other insert.
    await admin.insert({ table: "requests", values: [once, twice], format: "JSONEachRow" });
    await admin.insert({ table: "requests", values: [twice], format: "JSONEachRow" });
    await admin.insert({ table: "requests", values: [twice], format: "JSONEachRow" });
    // The control: the copies are really stored (no merge, no engine dedup is relied on).
    const stored = await (await admin.query({ query: "SELECT count() AS n FROM requests WHERE environment_id = {env:UUID}", query_params: { env: envId }, format: "JSONEachRow" })).json<{ n: string }>();
    expect(Number(stored[0]!.n)).toBe(4);

    const summary = await h.api("GET", `/environments/${envId}/analytics/summary?${period()}&interval=5m`);
    expect(summary.status, JSON.stringify(summary.body)).toBe(200);
    expect(summary.body.totals).toMatchObject({ requests: 2, errors4xx: 0, errors5xx: 1, errorRate: 0.5 });
    expect(summary.body.series.reduce((n: number, p: { requests: number }) => n + p.requests, 0)).toBe(2);
    const top = await h.api("GET", `/environments/${envId}/analytics/top-routes?${period()}`);
    expect(top.body.items).toEqual([expect.objectContaining({ routeId: once.route_id, requests: 2, errors5xx: 1 })]);
    const explorer = await h.api("GET", `/environments/${envId}/requests?${period()}&limit=10`);
    expect(explorer.body.items.map((r: { id: string }) => r.id).sort()).toEqual([once.id, twice.id].sort());
    expect(explorer.body.nextCursor).toBeNull();
  });

  it("keeps percentiles and pages of one request per id, also for distinct requests at the same instant", async () => {
    const env = await h.api("POST", "/environments", { name: uniq("dedup-q") });
    const envId = env.body.id as string;
    // Nine fast requests and one slow one at the same instant: p50 10 ms. Copies of the slow one would move p50 to 100.
    const fast = Array.from({ length: 9 }, () => row(envId, 30_000, 200, 10));
    const slow = row(envId, 30_000, 200, 100);
    await admin.insert({ table: "requests", values: [...fast, slow], format: "JSONEachRow" });
    for (let i = 0; i < 9; i++) await admin.insert({ table: "requests", values: [slow], format: "JSONEachRow" });
    const totals = (await h.api("GET", `/environments/${envId}/analytics/summary?${period()}&interval=5m`)).body.totals;
    expect(totals).toMatchObject({ requests: 10, p50Ms: 10 });
    // Pages of 3 over the ten distinct ids (same ts, ordered by id): every id once, no copy, no gap.
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: ApiResponse = await h.api("GET", `/environments/${envId}/requests?${period()}&limit=3${cursor ? `&cursor=${cursor}` : ""}`);
      expect(page.status, JSON.stringify(page.body)).toBe(200);
      seen.push(...page.body.items.map((r: { id: string }) => r.id));
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(seen.length).toBe(10);
    expect(new Set(seen)).toEqual(new Set([...fast, slow].map((r) => r.id)));
  });
});

describe("copies of one request id that disagree (agent protocol v2, Analytics guarantees: conflicting copies)", () => {
  const R1 = "00000000-0000-4000-8000-0000000000b1", R2 = "00000000-0000-4000-8000-0000000000b2";
  const total = async (envId: string, extra = "") => (await h.api("GET", `/environments/${envId}/analytics/summary?${period()}&interval=5m${extra}`)).body.totals.requests as number;
  const ids = async (envId: string, extra = "") => (await h.api("GET", `/environments/${envId}/requests?${period()}&limit=50${extra}`)).body.items.map((r: { id: string }) => r.id) as string[];
  const routes = async (envId: string) => (await h.api("GET", `/environments/${envId}/analytics/top-routes?${period()}`)).body.items.map((r: { routeId: string | null; requests: number }) => [r.routeId, r.requests]);

  it("never attributes an id whose copies name different routes, in any insertion order, nor leaks it through a filter", async () => {
    for (const order of ["R1 first", "R2 first"]) {
      const envId = (await h.api("POST", "/environments", { name: uniq("conflict") })).body.id as string;
      const clean = row(envId, 10_000, 200, 10, { route_id: R1 });
      const a = row(envId, 20_000, 200, 10, { route_id: R1 });
      const b = { ...a, route_id: R2 };
      await admin.insert({ table: "requests", values: [clean], format: "JSONEachRow" });
      for (const copy of order === "R1 first" ? [a, b] : [b, a]) await admin.insert({ table: "requests", values: [copy], format: "JSONEachRow" });
      // Negative control: the former read (LIMIT 1 BY id) keeps one of the two copies and attributes it to a route.
      const former = await (await admin.query({ query: "SELECT count() AS n FROM (SELECT * FROM requests WHERE environment_id = {env:UUID} LIMIT 1 BY id)", query_params: { env: envId }, format: "JSONEachRow" })).json<{ n: string }>();
      expect(Number(former[0]!.n), order).toBe(2);
      // Now: the conflicted id counts for this environment nowhere; the clean one stays.
      expect(await total(envId), order).toBe(1);
      expect(await ids(envId), order).toEqual([clean.id]);
      expect(await routes(envId), order).toEqual([[R1, 1]]);
      // A filter on either route never reveals the conflicted id.
      expect(await total(envId, `&routeId=${R1}`), order).toBe(1);
      expect(await total(envId, `&routeId=${R2}`), order).toBe(0);
      expect(await ids(envId, `&routeId=${R2}`), order).toEqual([]);
    }
  });

  it("never mixes environments: one id stored for two environments is attributed to neither", async () => {
    const e1 = (await h.api("POST", "/environments", { name: uniq("cross-a") })).body.id as string;
    const e2 = (await h.api("POST", "/environments", { name: uniq("cross-b") })).body.id as string;
    const shared = row(e1, 20_000, 200, 10);
    await admin.insert({ table: "requests", values: [shared, { ...shared, environment_id: e2 }, row(e2, 30_000, 200, 10)], format: "JSONEachRow" });
    expect(await total(e1)).toBe(0);
    expect(await total(e2)).toBe(1);
    expect(await ids(e2)).not.toContain(shared.id);
  });

  it("leaves out a conflict on any column, outside the period too, behind every filter, in series and cursor pages", async () => {
    const envId = (await h.api("POST", "/environments", { name: uniq("conflict-cols") })).body.id as string;
    const clean = row(envId, 10_000, 200, 10);
    const cluster = row(envId, 20_000, 200, 10), byCluster = { ...cluster, cluster_id: "00000000-0000-4000-8000-0000000000c2" };
    const nullable = row(envId, 30_000, 200, 10, { consumer_id: null }), toValue = { ...nullable, consumer_id: "00000000-0000-4000-8000-0000000000d1" };
    const status = row(envId, 40_000, 200, 10), byStatus = { ...status, status: 500 };
    // The other copy lies outside the queried period (another ts): still the same id, still a conflict.
    const early = row(envId, 50_000, 200, 10), earlyCopy = { ...early, ts: at(-3 * 60 * 60_000) };
    await admin.insert({ table: "requests", values: [clean, cluster, byCluster, nullable, toValue, status, byStatus, early, earlyCopy], format: "JSONEachRow" });
    expect(await total(envId)).toBe(1);
    const series = (await h.api("GET", `/environments/${envId}/analytics/summary?${period()}&interval=1m`)).body.series as { requests: number }[];
    expect(series.reduce((n, p) => n + p.requests, 0)).toBe(1);
    for (const filter of ["&status=200", "&status=500", "&consumerId=00000000-0000-4000-8000-0000000000d1", "&serviceId=00000000-0000-4000-8000-0000000000a1"]) {
      const listed = await ids(envId, filter);
      for (const conflicted of [cluster.id, nullable.id, status.id, early.id]) expect(listed, filter).not.toContain(conflicted);
    }
    // Pages of one through the explorer's cursor never surface a conflicted id.
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: ApiResponse = await h.api("GET", `/environments/${envId}/requests?${period()}&limit=1${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...page.body.items.map((r: { id: string }) => r.id));
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(seen).toEqual([clean.id]);
  });

  it("keeps conflicts out across cursor pages and across services, querying either side", async () => {
    const envId = (await h.api("POST", "/environments", { name: uniq("conflict-pages") })).body.id as string;
    const S1 = "00000000-0000-4000-8000-0000000000a1", S2 = "00000000-0000-4000-8000-0000000000a2";
    // Clean events at 10, 30 and 50 s; conflicts at 20 and 40 s, on both sides of every page boundary (pages of 1).
    const clean = [10_000, 30_000, 50_000].map((t) => row(envId, t, 200, 10, { service_id: S1 }));
    const c1 = row(envId, 20_000, 200, 10, { service_id: S1 }), c2 = row(envId, 40_000, 200, 10, { service_id: S1 });
    await admin.insert({ table: "requests", values: [...clean, c1, { ...c1, service_id: S2 }, c2, { ...c2, status: 503 }], format: "JSONEachRow" });
    const seen: string[] = [];
    let cursor: string | null = null, calls = 0;
    do {
      const page: ApiResponse = await h.api("GET", `/environments/${envId}/requests?${period()}&limit=1${cursor ? `&cursor=${cursor}` : ""}`);
      expect(page.status, JSON.stringify(page.body)).toBe(200);
      seen.push(...page.body.items.map((r: { id: string }) => r.id));
      cursor = page.body.nextCursor;
      calls++;
    } while (cursor);
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(seen.sort()).toEqual(clean.map((r) => r.id).sort());
    // The copies of c1 sit in two services: filtering on either one never reveals it, in the explorer or the summary.
    for (const service of [S1, S2]) {
      expect(await ids(envId, `&serviceId=${service}`), service).not.toContain(c1.id);
      expect(await total(envId, `&serviceId=${service}`), service).toBe(service === S1 ? 3 : 0);
    }
  });

  it("still counts identical copies once and distinct ids separately", async () => {
    const envId = (await h.api("POST", "/environments", { name: uniq("legit") })).body.id as string;
    const one = row(envId, 10_000, 200, 10), two = row(envId, 10_000, 200, 10);
    await admin.insert({ table: "requests", values: [one, one, one, two], format: "JSONEachRow" });
    expect(await total(envId)).toBe(2);
    expect((await ids(envId)).sort()).toEqual([one.id, two.id].sort());
  });
});

describe("maskClientIp", () => {
  it("zeroes the IPv4 host octet, truncates IPv6 to /48 and unwraps mapped IPv4", () => {
    expect(maskClientIp("203.0.113.10", "viewer")).toBe("203.0.113.0");
    expect(maskClientIp("::ffff:203.0.113.10", "editor")).toBe("203.0.113.0");
    expect(maskClientIp("::ffff:203.0.113.10", "admin")).toBe("203.0.113.10");
    expect(maskClientIp("2001:db8:1234:5678::1", "viewer")).toBe("2001:db8:1234::");
    expect(maskClientIp("2001:0db8:0000:0000:0000:0000:0000:0001", "viewer")).toBe("2001:db8:0::");
    expect(maskClientIp("::1", "viewer")).toBe("0:0:0::");
    expect(maskClientIp("garbage", "viewer")).toBe("");
  });
});
