import { isIP } from "node:net";
import { Controller, Get, HttpStatus, Inject, Injectable, Logger, Module, Param, Query, type OnApplicationShutdown } from "@nestjs/common";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { Ctx, RequiredRole, type RequestContext, type Role } from "../auth/auth.js";
import { decodeCursor, encodeCursor, parseLimit, type Page } from "../common/pagination.js";
import { ProblemException, unprocessable, type FieldError } from "../common/problem.js";
import { APP_CONFIG, type AppConfig } from "../config.js";
import { inArray } from "drizzle-orm";
import { DB, type Db } from "../db/db.js";
import { routes } from "../db/schema.js";
import { requireEnvironment, uuidParam } from "../environments/environments.js";

/* ---------------- query parsing ---------------- */

const INTERVALS = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "1d": 86_400_000 } as const;
type Interval = keyof typeof INTERVALS;
const MAX_PERIOD_MS = 7 * 86_400_000;
const MAX_BUCKETS = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS_CLASSES = { "2xx": [200, 299], "3xx": [300, 399], "4xx": [400, 499], "5xx": [500, 599] } as const;
/** Ranking criteria of the top routes: the ORDER BY expression over the aggregated columns. */
const TOP_BY = { requests: "requests DESC", errors: "errors DESC", p95: "p95 DESC" } as const;
type TopBy = keyof typeof TOP_BY;
const TOP_LIMIT = { default: 10, max: 50 };

interface Period {
  fromMs: number;
  toMs: number;
}

interface Filters {
  routeId?: string;
  serviceId?: string;
  consumerId?: string;
  status?: number;
  statusClass?: keyof typeof STATUS_CLASSES;
}

/** The checks the contract's JSON Schema cannot express (ordering, span, exclusivity), with the parameter as path. */
function parsePeriod(query: Record<string, unknown>, errors: FieldError[]): Period {
  const at = (name: "from" | "to") => {
    const raw = query[name];
    const ms = typeof raw === "string" ? Date.parse(raw) : NaN;
    if (Number.isNaN(ms)) errors.push({ path: name, message: raw === undefined ? "is required" : "must be an RFC 3339 date-time" });
    return ms;
  };
  const fromMs = at("from");
  const toMs = at("to");
  if (!Number.isNaN(fromMs) && !Number.isNaN(toMs)) {
    if (toMs <= fromMs) errors.push({ path: "to", message: "must be after from" });
    else if (toMs - fromMs > MAX_PERIOD_MS) errors.push({ path: "to", message: "the period may span at most 7 days" });
  }
  return { fromMs, toMs };
}

function parseFilters(query: Record<string, unknown>, errors: FieldError[], allowed: (keyof Filters)[]): Filters {
  const out: Filters = {};
  for (const name of ["routeId", "serviceId", "consumerId"] as const) {
    if (!allowed.includes(name) || query[name] === undefined) continue;
    if (typeof query[name] === "string" && UUID.test(query[name])) out[name] = query[name].toLowerCase();
    else errors.push({ path: name, message: "must be a UUID" });
  }
  if (allowed.includes("status") && query.status !== undefined) {
    const n = Number(query.status);
    if (Number.isInteger(n) && n >= 100 && n <= 599) out.status = n;
    else errors.push({ path: "status", message: "must be an integer between 100 and 599" });
  }
  if (allowed.includes("statusClass") && query.statusClass !== undefined) {
    if (typeof query.statusClass === "string" && query.statusClass in STATUS_CLASSES) out.statusClass = query.statusClass as keyof typeof STATUS_CLASSES;
    else errors.push({ path: "statusClass", message: "must be one of 2xx, 3xx, 4xx, 5xx" });
  }
  if (out.status !== undefined && out.statusClass !== undefined) errors.push({ path: "statusClass", message: "cannot be combined with status" });
  return out;
}

function parseInterval(query: Record<string, unknown>, period: Period, errors: FieldError[]): Interval {
  const raw = query.interval ?? "5m";
  if (typeof raw !== "string" || !(raw in INTERVALS)) {
    errors.push({ path: "interval", message: "must be one of 1m, 5m, 15m, 1h, 1d" });
    return "5m";
  }
  const interval = raw as Interval;
  const span = period.toMs - period.fromMs;
  // Only a valid period is judged on its bucket count: an oversized one is already reported on `to`.
  if (span > 0 && span <= MAX_PERIOD_MS && Math.ceil(span / INTERVALS[interval]) > MAX_BUCKETS) {
    errors.push({ path: "interval", message: `the period may hold at most ${MAX_BUCKETS} buckets of this size` });
  }
  return interval;
}

function parseTopBy(query: Record<string, unknown>, errors: FieldError[]): TopBy {
  const raw = query.by ?? "requests";
  if (typeof raw === "string" && raw in TOP_BY) return raw as TopBy;
  errors.push({ path: "by", message: "must be one of requests, errors, p95" });
  return "requests";
}

function parseTopLimit(query: Record<string, unknown>, errors: FieldError[]): number {
  if (query.limit === undefined) return TOP_LIMIT.default;
  const n = Number(query.limit);
  if (Number.isInteger(n) && n >= 1 && n <= TOP_LIMIT.max) return n;
  errors.push({ path: "limit", message: `must be an integer between 1 and ${TOP_LIMIT.max}` });
  return TOP_LIMIT.default;
}

/* ---------------- client address masking ---------------- */

/** Admins see the address; everyone else gets the IPv4 /24 or the IPv6 /48. */
export function maskClientIp(ip: string, role: Role): string {
  const v4 = ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
  if (role === "admin") return v4;
  if (isIP(v4) === 4) return v4.replace(/\.\d+$/, ".0");
  if (isIP(v4) === 6) {
    const [head = "", tail = ""] = v4.split("::");
    const left = head ? head.split(":") : [];
    const right = tail ? tail.split(":") : [];
    const groups = [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
    return `${groups.slice(0, 3).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::`;
  }
  return "";
}

/* ---------------- service ---------------- */

interface BucketRow {
  b: number;
  requests: number;
  errors4xx: number;
  errors5xx: number;
  q: [number, number, number];
}

interface TopRouteRow {
  route_id: string | null;
  service_id: string | null;
  requests: number;
  errors4xx: number;
  errors5xx: number;
  q: [number, number, number];
}

interface RequestRow {
  id: string;
  ts: string;
  environment_id: string;
  cluster_id: string;
  service_id: string | null;
  route_id: string | null;
  consumer_id: string | null;
  method: string;
  path: string;
  status: number;
  latency_kong_ms: number;
  latency_upstream_ms: number | null;
  latency_total_ms: number;
  client_ip: string;
  request_size: number;
  response_size: number;
}

/** Every stored column of a row: two copies of one id that differ in any of them are a conflict. */
const CONTENT = "tuple(ts, environment_id, cluster_id, service_id, route_id, consumer_id, method, path, status, latency_kong_ms, latency_upstream_ms, latency_total_ms, client_ip, request_size, response_size, retention_days)";

/**
 * The rows of `where`, one per request id (agent protocol v2 "Analytics guarantees"). Kong's queue and the collector
 * retry, so the table may hold copies of a request: identical copies count once, without relying on a merge having
 * run. An id whose copies differ anywhere in the table (another route, environment, cluster or any other column) is a
 * conflict and is left out before anything is counted or filtered, so no copy is ever chosen for this environment and
 * no filter can reveal it; it belongs only to the instance's unattributed totals.
 */
const deduped = (where: string) =>
  `(SELECT * FROM requests WHERE ${where} AND id NOT IN (` +
  `SELECT id FROM requests WHERE id IN (SELECT id FROM requests WHERE ${where}) GROUP BY id HAVING uniqExact(${CONTENT}) > 1` +
  `) LIMIT 1 BY id)`;

/** ClickHouse renders DateTime64 as "YYYY-MM-DD hh:mm:ss.SSS" in UTC. */
const isoFromClickHouse = (ts: string) => new Date(`${ts.replace(" ", "T")}Z`).toISOString();

function stats(row: { requests: number; errors4xx: number; errors5xx: number; q: [number, number, number] } | undefined) {
  const requests = row?.requests ?? 0;
  const errors4xx = row?.errors4xx ?? 0;
  const errors5xx = row?.errors5xx ?? 0;
  const q = requests > 0 && row ? row.q : [null, null, null];
  return { requests, errors4xx, errors5xx, errorRate: requests > 0 ? (errors4xx + errors5xx) / requests : 0, p50Ms: q[0], p95Ms: q[1], p99Ms: q[2] };
}

@Injectable()
export class AnalyticsService implements OnApplicationShutdown {
  private readonly logger = new Logger("Analytics");
  private client: ClickHouseClient | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async summary(envId: string, query: Record<string, unknown>) {
    await requireEnvironment(this.db, envId);
    const errors: FieldError[] = [];
    const period = parsePeriod(query, errors);
    const interval = parseInterval(query, period, errors);
    const filters = parseFilters(query, errors, ["routeId", "serviceId"]);
    if (errors.length > 0) throw unprocessable("Invalid analytics query", errors);
    const bucketMs = INTERVALS[interval];
    const { where, params } = this.scope(envId, period, filters);
    const [buckets, totals] = await Promise.all([
      this.rows<BucketRow>(
        `SELECT intDiv(toUnixTimestamp64Milli(ts) - {fromMs:Int64}, {bucketMs:Int64}) AS b, count() AS requests,
                countIf(status >= 400 AND status < 500) AS errors4xx, countIf(status >= 500) AS errors5xx,
                quantilesExact(0.5, 0.95, 0.99)(latency_total_ms) AS q
         FROM ${deduped(where)} GROUP BY b ORDER BY b`,
        { ...params, bucketMs },
      ),
      this.rows<Omit<BucketRow, "b">>(
        `SELECT count() AS requests, countIf(status >= 400 AND status < 500) AS errors4xx, countIf(status >= 500) AS errors5xx,
                quantilesExact(0.5, 0.95, 0.99)(latency_total_ms) AS q
         FROM ${deduped(where)}`,
        params,
      ),
    ]);
    const byBucket = new Map(buckets.map((row) => [row.b, row]));
    const count = Math.ceil((period.toMs - period.fromMs) / bucketMs);
    return {
      from: new Date(period.fromMs).toISOString(),
      to: new Date(period.toMs).toISOString(),
      interval,
      totals: stats(totals[0]),
      series: Array.from({ length: count }, (_, b) => ({ ts: new Date(period.fromMs + b * bucketMs).toISOString(), ...stats(byBucket.get(b)) })),
    };
  }

  /** Routes ranked over the period; names come from the control plane, so a deleted route keeps its id with a null name. */
  async topRoutes(envId: string, query: Record<string, unknown>) {
    await requireEnvironment(this.db, envId);
    const errors: FieldError[] = [];
    const period = parsePeriod(query, errors);
    const by = parseTopBy(query, errors);
    const limit = parseTopLimit(query, errors);
    if (errors.length > 0) throw unprocessable("Invalid analytics query", errors);
    const { where, params } = this.scope(envId, period, {});
    // A route belongs to one service; `any` picks it. Ties: more requests first, then the route id (nulls last).
    const rows = await this.rows<TopRouteRow>(
      `SELECT route_id, any(service_id) AS service_id, count() AS requests,
              countIf(status >= 400 AND status < 500) AS errors4xx, countIf(status >= 500) AS errors5xx,
              countIf(status >= 400) AS errors, quantileExact(0.95)(latency_total_ms) AS p95,
              quantilesExact(0.5, 0.95, 0.99)(latency_total_ms) AS q
       FROM ${deduped(where)} GROUP BY route_id
       ORDER BY ${TOP_BY[by]}, requests DESC, route_id ASC NULLS LAST LIMIT {limit:UInt32}`,
      { ...params, limit },
    );
    const ids = rows.map((row) => row.route_id).filter((id): id is string => id !== null);
    const named = ids.length > 0 ? await this.db.select({ id: routes.id, name: routes.name }).from(routes).where(inArray(routes.id, ids)) : [];
    const names = new Map(named.map((r) => [r.id, r.name]));
    return {
      from: new Date(period.fromMs).toISOString(),
      to: new Date(period.toMs).toISOString(),
      by,
      items: rows.map((row) => ({
        routeId: row.route_id,
        routeName: row.route_id === null ? null : (names.get(row.route_id) ?? null),
        serviceId: row.service_id,
        ...stats(row),
      })),
    };
  }

  async requests(envId: string, query: Record<string, unknown>, role: Role): Promise<Page<ReturnType<typeof toRecord>>> {
    await requireEnvironment(this.db, envId);
    const errors: FieldError[] = [];
    const period = parsePeriod(query, errors);
    const filters = parseFilters(query, errors, ["routeId", "serviceId", "consumerId", "status", "statusClass"]);
    if (errors.length > 0) throw unprocessable("Invalid analytics query", errors);
    const limit = parseLimit(query.limit);
    const cursor = decodeCursor(query.cursor);
    const cursorMs = cursor ? Date.parse(cursor.k) : NaN;
    if (cursor && (Number.isNaN(cursorMs) || !UUID.test(cursor.id))) throw unprocessable("Invalid cursor", [{ path: "cursor", message: "is not a valid cursor" }]);
    const { where, params } = this.scope(envId, period, filters);
    const rows = await this.rows<RequestRow>(
      `SELECT id, ts, environment_id, cluster_id, service_id, route_id, consumer_id, method, path, status,
              latency_kong_ms, latency_upstream_ms, latency_total_ms, client_ip, request_size, response_size
       FROM ${deduped(where)}${cursor ? " WHERE (ts, id) < (fromUnixTimestamp64Milli({cursorMs:Int64}), {cursorId:UUID})" : ""}
       ORDER BY ts DESC, id DESC LIMIT {limit:UInt32}`,
      { ...params, limit: limit + 1, ...(cursor ? { cursorMs, cursorId: cursor.id } : {}) },
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    return {
      items: page.map((row) => toRecord(row, role)),
      nextCursor: hasMore && last ? encodeCursor({ k: isoFromClickHouse(last.ts), id: last.id }) : null,
    };
  }

  private scope(envId: string, period: Period, filters: Filters) {
    const where = ["environment_id = {env:UUID}", "ts >= fromUnixTimestamp64Milli({fromMs:Int64})", "ts < fromUnixTimestamp64Milli({toMs:Int64})"];
    const params: Record<string, unknown> = { env: envId, fromMs: period.fromMs, toMs: period.toMs };
    if (filters.routeId) (where.push("route_id = {routeId:UUID}"), (params.routeId = filters.routeId));
    if (filters.serviceId) (where.push("service_id = {serviceId:UUID}"), (params.serviceId = filters.serviceId));
    if (filters.consumerId) (where.push("consumer_id = {consumerId:UUID}"), (params.consumerId = filters.consumerId));
    if (filters.status !== undefined) (where.push("status = {status:UInt16}"), (params.status = filters.status));
    if (filters.statusClass) {
      const [lo, hi] = STATUS_CLASSES[filters.statusClass];
      where.push("status BETWEEN {statusLo:UInt16} AND {statusHi:UInt16}");
      params.statusLo = lo;
      params.statusHi = hi;
    }
    return { where: where.join(" AND "), params };
  }

  /** Every query goes through here: the store being off or down is a 502, never a 500 with its stack. */
  private async rows<T>(query: string, params: Record<string, unknown>): Promise<T[]> {
    if (!this.config.clickhouse) throw new ProblemException(HttpStatus.BAD_GATEWAY, "Analytics store is not configured");
    this.client ??= createClient({
      url: this.config.clickhouse.url,
      username: this.config.clickhouse.user,
      password: this.config.clickhouse.password,
      database: this.config.clickhouse.database,
      request_timeout: 10_000,
      clickhouse_settings: { output_format_json_quote_64bit_integers: 0 },
    });
    try {
      const result = await this.client.query({ query, query_params: params, format: "JSONEachRow" });
      return await result.json<T>();
    } catch (err) {
      this.logger.error(`ClickHouse query failed: ${err instanceof Error ? err.message : String(err)}`);
      throw new ProblemException(HttpStatus.BAD_GATEWAY, "Analytics store is unavailable");
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.client?.close();
  }
}

function toRecord(row: RequestRow, role: Role) {
  return {
    id: row.id,
    ts: isoFromClickHouse(row.ts),
    environmentId: row.environment_id,
    clusterId: row.cluster_id,
    serviceId: row.service_id,
    routeId: row.route_id,
    consumerId: row.consumer_id,
    method: row.method,
    path: row.path,
    status: row.status,
    latencyKongMs: Math.round(row.latency_kong_ms),
    latencyUpstreamMs: row.latency_upstream_ms === null ? null : Math.round(row.latency_upstream_ms),
    latencyTotalMs: Math.round(row.latency_total_ms),
    clientIp: maskClientIp(row.client_ip, role),
    requestSize: row.request_size,
    responseSize: row.response_size,
  };
}

/* ---------------- controller ---------------- */

@Controller("environments/:envId")
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get("analytics/summary")
  @RequiredRole("viewer")
  summary(@Param("envId", uuidParam()) envId: string, @Query() query: Record<string, unknown>) {
    return this.analytics.summary(envId, query);
  }

  @Get("analytics/top-routes")
  @RequiredRole("viewer")
  topRoutes(@Param("envId", uuidParam()) envId: string, @Query() query: Record<string, unknown>) {
    return this.analytics.topRoutes(envId, query);
  }

  @Get("requests")
  @RequiredRole("viewer")
  requests(@Ctx() ctx: RequestContext, @Param("envId", uuidParam()) envId: string, @Query() query: Record<string, unknown>) {
    return this.analytics.requests(envId, query, ctx.role);
  }
}

@Module({ controllers: [AnalyticsController], providers: [AnalyticsService] })
export class AnalyticsModule {}
