import { isIP } from "node:net";
import type { ClickHouseClient } from "@clickhouse/client";

/** Sanitized logical event columns, without a producer's self-asserted trust or Workspace. */
export interface RawRequestCopy {
  readonly id: string;
  readonly content: Readonly<Record<string, unknown>>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fields = ["ts", "environmentId", "clusterId", "serviceId", "routeId", "consumerId", "method", "path", "status", "latencyKongMs", "latencyUpstreamMs", "latencyTotalMs", "clientIp", "requestSize", "responseSize", "retentionDays"] as const;
const invalid = (): never => { throw new Error("Invalid raw request copies"); };
function uint64(value: unknown): string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > 18_446_744_073_709_551_615n) return invalid();
  return value;
}
export function encodeRawRequestCopy(copy: RawRequestCopy): Record<string, unknown> {
  const c = copy.content;
  if (!uuid.test(copy.id) || !c || Object.keys(c).length !== fields.length || fields.some(key => !Object.hasOwn(c, key))) return invalid();
  for (const key of ["environmentId", "clusterId"] as const) if (typeof c[key] !== "string" || !uuid.test(c[key])) return invalid();
  for (const key of ["serviceId", "routeId", "consumerId"] as const) if (c[key] !== null && (typeof c[key] !== "string" || !uuid.test(c[key]))) return invalid();
  if (typeof c.ts !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(c.ts) || !Number.isFinite(Date.parse(c.ts)) || new Date(c.ts).toISOString() !== c.ts) return invalid();
  if (typeof c.method !== "string" || !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "CONNECT"].includes(c.method)) return invalid();
  if (typeof c.path !== "string" || !c.path.startsWith("/") || /[?#\u0000-\u001f\u007f]/.test(c.path) || [...c.path].length > 2048) return invalid();
  if (typeof c.status !== "number" || !Number.isInteger(c.status) || c.status < 100 || c.status > 599) return invalid();
  for (const key of ["latencyKongMs", "latencyUpstreamMs", "latencyTotalMs"] as const) {
    if (key === "latencyUpstreamMs" && c[key] === null) continue;
    if (typeof c[key] !== "number" || !Number.isFinite(c[key]) || Object.is(c[key], -0) || c[key] < 0) return invalid();
  }
  if (typeof c.clientIp !== "string" || isIP(c.clientIp) !== 6 || typeof c.retentionDays !== "number" || !Number.isInteger(c.retentionDays) || c.retentionDays < 1 || c.retentionDays > 7) return invalid();
  return { id: copy.id, ts: c.ts.replace("T", " ").replace("Z", ""), environment_id: c.environmentId, cluster_id: c.clusterId,
    service_id: c.serviceId, route_id: c.routeId, consumer_id: c.consumerId, method: c.method, path: c.path, status: c.status,
    latency_kong_ms: c.latencyKongMs, latency_upstream_ms: c.latencyUpstreamMs, latency_total_ms: c.latencyTotalMs,
    client_ip: c.clientIp, request_size: uint64(c.requestSize), response_size: uint64(c.responseSize), retention_days: c.retentionDays };
}

/** Isolated raw-copy sink. Success is a write acknowledgement, never provenance or an ingestion fence. */
export class RawRequestCopyStore {
  constructor(private readonly writer: ClickHouseClient) {}
  async append(copies: readonly RawRequestCopy[], signal?: AbortSignal): Promise<void> {
    if (!Array.isArray(copies) || copies.length < 1 || copies.length > 100) return invalid();
    const rows = copies.map(encodeRawRequestCopy);
    if (Buffer.byteLength(JSON.stringify(rows)) > 2 * 1024 * 1024) return invalid();
    try {
      // Never collapse by id: a retry can repeat rows, and divergent copies must survive for exact comparison.
      await this.writer.insert({ table: "requests_v2_copies", values: rows, format: "JSONEachRow", abort_signal: signal,
        clickhouse_settings: { async_insert: 0, insert_deduplicate: 0 } });
    } catch { throw new Error("Raw request copy persistence failed"); }
  }
}
