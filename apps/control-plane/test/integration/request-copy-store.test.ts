import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { afterAll, expect, it } from "vitest";
import { RawRequestCopyStore } from "../../src/analytics/request-copy-store.js";
import { CLICKHOUSE, CLICKHOUSE_ADMIN } from "./harness.js";

const writer = createClient({url: CLICKHOUSE_ADMIN.url, database: CLICKHOUSE_ADMIN.database, username: CLICKHOUSE_ADMIN.user, password: CLICKHOUSE_ADMIN.password});
const reader = createClient({url: CLICKHOUSE.url, database: CLICKHOUSE.database, username: CLICKHOUSE.user, password: CLICKHOUSE.password});
afterAll(async () => { await writer.close(); await reader.close(); });
const event = (id = randomUUID()) => ({ id, content: {
  ts: "2099-11-01T12:00:00.000Z", environmentId: randomUUID(), clusterId: randomUUID(),
  serviceId: null, routeId: randomUUID(), consumerId: null, method: "GET", path: "/same",
  status: 200, latencyKongMs: 1.25, latencyUpstreamMs: null, latencyTotalMs: 2.75,
  clientIp: "2001:db8::1", requestSize: "9007199254740993", responseSize: "18446744073709551615", retentionDays: 7,
} });
const count = async (id:string) => (await (await reader.query({ query: "SELECT toString(count()) AS n FROM requests_v2_copies WHERE id={id:UUID}", query_params:{id},format:"JSONEachRow" })).json<{n:string}>())[0]!.n;

it("migration is additive, has original event TTL and no collapsing/deduplicating engine", () => {
 const sql = readFileSync(new URL("../../../../deploy/observability/clickhouse/003-request-copies.sql", import.meta.url), "utf8");
 expect(sql).toContain("ENGINE = MergeTree"); expect(sql).toContain("TTL ts + toIntervalDay(retention_days)");
 expect(sql).not.toMatch(/DROP|ALTER|ReplacingMergeTree|SummingMergeTree/i);
});
it("persists all identical and conflicting copies, including retries and a new writer instance", async () => {
 const a=event(); const b={...a,content:{...a.content,status:500,environmentId:randomUUID(),routeId:randomUUID(),ts:"2099-10-31T12:00:00.000Z"}};
 const store=new RawRequestCopyStore(writer); await store.append([a,a,b]);
 await new RawRequestCopyStore(writer).append([a]);
 expect(await count(a.id)).toBe("4");
 const rows=await (await reader.query({query:"SELECT status, toString(request_size) AS requestSize, toString(response_size) AS responseSize FROM requests_v2_copies WHERE id={id:UUID} ORDER BY status",query_params:{id:a.id},format:"JSONEachRow"})).json<{status:number,requestSize:string,responseSize:string}>();
 expect(rows.map(x=>x.status)).toEqual([200,200,200,500]);
 expect(rows.every(x=>x.requestSize==="9007199254740993"&&x.responseSize==="18446744073709551615")).toBe(true);
 expect(await (await reader.query({query:"SELECT toString(count()) AS n FROM requests WHERE id={id:UUID}",query_params:{id:a.id},format:"JSONEachRow"})).json()).toEqual([{n:"0"}]);
});
it("rejects a whole invalid batch before a write and never leaks the event in its error", async () => {
 const a=event();const b={...a,content:{...a.content,path:"/secret?token=DO_NOT_EXPOSE"}};
 await expect(new RawRequestCopyStore(writer).append([a,b])).rejects.toThrow(/^Invalid raw request copies$/);
 expect(await count(a.id)).toBe("0");
});
it("rejects unsafe sizes, non-finite latency, unknown columns, false identities and oversized batches", async () => {
 const a=event();
 for(const content of [{...a.content,requestSize:9007199254740992},{...a.content,responseSize:"18446744073709551616"},{...a.content,latencyTotalMs:Infinity},{...a.content,latencyTotalMs:-0},{...a.content,workspaceId:randomUUID()},{...a.content,clusterId:"unknown"},{...a.content,retentionDays:8}])
   await expect(new RawRequestCopyStore(writer).append([{id:a.id,content}])).rejects.toThrow("Invalid raw request copies");
 await expect(new RawRequestCopyStore(writer).append(Array.from({length:101},()=>a))).rejects.toThrow("Invalid raw request copies");
 expect(await count(a.id)).toBe("0");
});

it("accepts Unicode paths by JSON Schema code points, bounded separately by the batch byte budget", async () => {
 const a=event();a.content.path="/"+"é".repeat(1024);await new RawRequestCopyStore(writer).append([a]);expect(await count(a.id)).toBe("1");
 const b=event();b.content.path="/"+"😀".repeat(2047);await new RawRequestCopyStore(writer).append([b]);expect(await count(b.id)).toBe("1");
 const c=event();c.content.path="/"+"😀".repeat(2048);await expect(new RawRequestCopyStore(writer).append([c])).rejects.toThrow("Invalid raw request copies");expect(await count(c.id)).toBe("0");
});
