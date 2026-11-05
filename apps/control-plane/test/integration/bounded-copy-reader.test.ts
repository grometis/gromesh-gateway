import { randomUUID } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { afterAll, expect, it } from "vitest";
import { BoundedCopyReader } from "../../src/analytics/bounded-copy-reader.js";
import { RawRequestCopyStore } from "../../src/analytics/request-copy-store.js";
import { CLICKHOUSE, CLICKHOUSE_ADMIN } from "./harness.js";
const writer=createClient({url:CLICKHOUSE_ADMIN.url,database:CLICKHOUSE_ADMIN.database,username:CLICKHOUSE_ADMIN.user,password:CLICKHOUSE_ADMIN.password});
const reader=createClient({url:CLICKHOUSE.url,database:CLICKHOUSE.database,username:CLICKHOUSE.user,password:CLICKHOUSE.password});
afterAll(async()=>{await writer.close();await reader.close();});
const instanceId=randomUUID();
const copy=(ts="2099-11-01T12:00:00.000Z")=>({id:randomUUID(),content:{ts,environmentId:instanceId,clusterId:randomUUID(),serviceId:null,routeId:randomUUID(),consumerId:null,method:"GET",path:"/same",status:200,latencyKongMs:1.25,latencyUpstreamMs:null,latencyTotalMs:2.75,clientIp:"2001:db8::1",requestSize:"9007199254740993",responseSize:"18446744073709551615",retentionDays:7}});
const window={instanceId,from:"2099-11-01T00:00:00.000Z",to:"2099-11-02T00:00:00.000Z",pageSize:200};
it("loads global copies before instance/window/status selection and reports conflict without a representative",async()=>{
 const a=copy();await new RawRequestCopyStore(writer).append([a,a,{...a,content:{...a.content,status:500,environmentId:randomUUID(),routeId:randomUUID(),ts:"2099-10-31T00:00:00.000Z"}}]);
 const page=await new BoundedCopyReader(reader).read({...window,instanceId:a.content.environmentId});const e=page.items.find(i=>i.id===a.id)!;
 expect(e.evidence?.kind).toBe("conflicting-copies");expect(e.evidence).not.toHaveProperty("content");expect(page.proof).toEqual({copiesComplete:false,conflictHistoryComplete:false,coherentSnapshot:false});
 expect(page.usage.readRows).toBeGreaterThan(0);expect(page.usage.readBytes).toBeGreaterThan(0);
});
it("keeps UInt64 exact and never upgrades raw data to trusted provenance",async()=>{
 const a=copy();a.content.environmentId=randomUUID();await new RawRequestCopyStore(writer).append([a,a]);
 const page=await new BoundedCopyReader(reader).read({...window,instanceId:a.content.environmentId});expect(page.items).toHaveLength(1);
 expect(page.items[0]!.evidence).toMatchObject({kind:"identical",provenanceComplete:false,content:{requestSize:"9007199254740993",responseSize:"18446744073709551615"}});
});
it("paginates candidate ids deterministically at equal timestamps and includes all copies of a boundary id",async()=>{
 const own=randomUUID(),a=copy(),b=copy(),c=copy();for(const v of [a,b,c])v.content.environmentId=own;
 await new RawRequestCopyStore(writer).append([a,b,c,a]);const adapter=new BoundedCopyReader(reader);
 const first=await adapter.read({...window,instanceId:own,pageSize:2});expect(first.items.map(i=>i.id)).toEqual([a.id,b.id,c.id].sort().reverse().slice(0,2));expect(first.next).not.toBeNull();
 const second=await adapter.read({...window,instanceId:own,pageSize:2,after:first.next!});expect(second.items.map(i=>i.id)).toEqual([a.id,b.id,c.id].sort().reverse().slice(2));expect(second.next).toBeNull();
});
it("returns empty data without claiming completeness",async()=>{const page=await new BoundedCopyReader(reader).read({...window,instanceId:randomUUID()});expect(page.items).toEqual([]);expect(page.proof.copiesComplete).toBe(false);});
it("refuses invalid bounds and injection before contacting ClickHouse",async()=>{
 const adapter=new BoundedCopyReader(reader);for(const bad of [{instanceId:"x' OR 1=1"},{pageSize:201},{from:"2099-10-01T00:00:00.000Z"},{after:{id:"bad",ts:"not-time"}},{to:"invalid"}])await expect(adapter.read({...window,...bad})).rejects.toThrow("Invalid copy read");
});
it("enforces engine read budget even if the final page contains only one id",async()=>{
 const a=copy();a.content.environmentId=randomUUID();await new RawRequestCopyStore(writer).append([a,a,a]);
 await expect(new BoundedCopyReader(reader).read({...window,instanceId:a.content.environmentId,pageSize:1},{maxReadRows:1})).rejects.toMatchObject({code:"analytics-budget-exceeded"});
});
it("supports cancellation without returning a partial page",async()=>{const signal=AbortSignal.abort();await expect(new BoundedCopyReader(reader).read(window,{},signal)).rejects.toMatchObject({code:"analytics-not-ready"});});
