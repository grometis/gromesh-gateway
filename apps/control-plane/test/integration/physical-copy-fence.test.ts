import { randomUUID } from "node:crypto";
import type { ClickHouseClient } from "@clickhouse/client";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { PhysicalCopyFence } from "../../src/analytics/physical-copy-fence.js";
import { RawRequestCopyStore } from "../../src/analytics/request-copy-store.js";
import { physicalFenceFixture } from "./physical-fence-fixture.js";
let fixture:Awaited<ReturnType<typeof physicalFenceFixture>>,client:ClickHouseClient,writer:ClickHouseClient,operator:ClickHouseClient;
beforeAll(async()=>{fixture=await physicalFenceFixture();client=fixture.reader;writer=fixture.writer;operator=fixture.operator;});
afterAll(()=>fixture?.close());
const copy=()=>({id:randomUUID(),content:{ts:"2099-11-01T12:00:00.000Z",environmentId:randomUUID(),clusterId:randomUUID(),serviceId:null,routeId:randomUUID(),consumerId:null,method:"GET",path:"/synthetic",status:200,latencyKongMs:1,latencyUpstreamMs:null,latencyTotalMs:2,clientIp:"2001:db8::1",requestSize:"9007199254740993",responseSize:"18446744073709551615",retentionDays:7}});
it("pins actual immutable parts and reads every global copy without losing UInt64",async()=>{
 const a=copy(),b={...a,content:{...a.content,environmentId:randomUUID(),status:500}};await new RawRequestCopyStore(writer).append([a,a,b]);
 const result=await new PhysicalCopyFence(client).observe([a.id]);
 expect(result.rows).toHaveLength(3);expect(result.rows.map(r=>r.request_size)).toEqual(Array(3).fill("9007199254740993"));
 expect(result.tableId).toMatch(/^[0-9a-f-]{36}$/);expect(result.parts.length).toBeGreaterThan(0);expect(result.usage.readRows).toBeGreaterThan(0);
 expect(result.proof).toEqual({copiesComplete:false,conflictHistoryComplete:false,coherentSnapshot:false,deliveryFromKongComplete:false});
});
it("rejects concurrent insertion even when it does not match the request filter",async()=>{
 const a=copy();await new RawRequestCopyStore(writer).append([a]);
 const original=client.query.bind(client);const spy=vi.spyOn(client,"query").mockImplementation(async params=>{const result=await original(params);if(params.query.includes("WHERE id IN"))await new RawRequestCopyStore(writer).append([copy()]);return result;});
 try{await expect(new PhysicalCopyFence(client).observe([a.id])).rejects.toMatchObject({code:"analytics-not-ready"});}finally{spy.mockRestore();}
});
it("refuses a merge replacing its observed parts",async()=>{
 const a=copy();await new RawRequestCopyStore(writer).append([a,a]);
 const original=client.query.bind(client);const spy=vi.spyOn(client,"query").mockImplementation(async params=>{const result=await original(params);if(params.query.includes("WHERE id IN"))await operator.command({query:"OPTIMIZE TABLE requests_v2_copies FINAL"});return result;});
 try{await expect(new PhysicalCopyFence(client).observe([a.id])).rejects.toMatchObject({code:"analytics-not-ready"});}finally{spy.mockRestore();}
});
it("refuses cancellation and engine budget exhaustion instead of returning partial evidence",async()=>{
 const a=copy();await new RawRequestCopyStore(writer).append([a,a]);
 await expect(new PhysicalCopyFence(client).observe([a.id],{},AbortSignal.abort())).rejects.toMatchObject({code:"analytics-not-ready"});
 await expect(new PhysicalCopyFence(client).observe([a.id],{maxReadRows:1})).rejects.toMatchObject({code:"analytics-budget-exceeded"});
});
it("rejects identifiers and oversized sets before contacting ClickHouse",async()=>{
 for(const ids of [["bad'"],Array(10001).fill(randomUUID())])await expect(new PhysicalCopyFence(client).observe(ids)).rejects.toThrow("Invalid physical copy read");
});
