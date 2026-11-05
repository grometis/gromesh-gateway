import { integrationInputs } from "../../../../scripts/integration-databases.mjs";
import { createHash, randomUUID } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { expect,it } from "vitest";
import { AgentGatewayService } from "../../src/agent-gateway/agent-gateway.js";
import { IngestionAdmissions } from "../../src/analytics/ingestion-admissions.js";
import { IngestionCopyPersistence } from "../../src/analytics/ingestion-copy-persistence.js";
import { HistoricalCopyReader } from "../../src/analytics/historical-copy-reader.js";
import { BoundedCopyReader } from "../../src/analytics/bounded-copy-reader.js";
import { authorizeClusterDelivery,confirmClusterAssociation } from "../../src/analytics/cluster-history.js";
import { routeHistoryEvidence } from "../../src/analytics/route-history-evidence.js";
import { attributeRouteHistoryV2 } from "../../src/analytics/route-history-v2.js";
import { evaluateStorageEvidence } from "../../src/analytics/storage-consistency.js";
import { clusterHistoryFixture } from "./cluster-history-fixtures.js";
import { CLICKHOUSE,CLICKHOUSE_ADMIN } from "./harness.js";
it("real bearer→admission→CH→receipt→reader→history→policy remains unassigned without a coherent serving fence",async()=>{
 const f=await clusterHistoryFixture();const writer=createClient({url:CLICKHOUSE_ADMIN.url,database:CLICKHOUSE_ADMIN.database,username:CLICKHOUSE_ADMIN.user,password:CLICKHOUSE_ADMIN.password}),reader=createClient({url:CLICKHOUSE.url,database:CLICKHOUSE.database,username:CLICKHOUSE.user,password:CLICKHOUSE.password});
 try{
  const source=await f.registered(),authorization=await f.db.transaction(tx=>authorizeClusterDelivery(tx,source.ctx,source.source));await confirmClusterAssociation(f.db,authorization);
  const service=new IngestionAdmissions(f.db,f.h.app.get(AgentGatewayService),new IngestionCopyPersistence(writer,reader));const podUid=randomUUID(),stream=await service.open(source.token,podUid);
  const ts=(await f.h.sql.query<{ts:string}>(`select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as ts`)).rows[0]!.ts;
  let sequence=0;const make=(routeId:string,serviceId:string)=>{const requestId=(++sequence).toString(16).padStart(32,"0"),h=createHash("sha256").update(source.source.clusterId+"|"+podUid+"|"+requestId).digest("hex").slice(0,32),id=`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
   return {schemaVersion:1 as const,copyId:randomUUID(),podUid,requestId,event:{id,ts,environmentId:f.instanceId,clusterId:source.source.clusterId,routeId,serviceId,consumerId:null,method:"GET",path:"/same",status:200,latencyKongMs:1,latencyUpstreamMs:null,latencyTotalMs:2,clientIp:"2001:db8::1",requestSize:"9007199254740993",responseSize:"18446744073709551615",retentionDays:7}};};
  const copies=[make(f.routeId,f.serviceId),make(f.otherRouteId,f.otherServiceId)];expect(await service.persist(source.token,stream.id,randomUUID(),copies)).toMatchObject({status:"persisted",storedCopies:2});
  const from=new Date(Date.parse(ts)-1000).toISOString(),to=new Date(Date.parse(ts)+1000).toISOString();
  const page=await new BoundedCopyReader(reader).read({instanceId:f.instanceId,from,to,pageSize:200});expect(page.items).toHaveLength(2);
  const history=await routeHistoryEvidence(f.db,f.instanceId,{from,to,routeIds:[f.routeId,f.otherRouteId],clusterIds:[source.source.clusterId]});expect(history.clusterHistory).toHaveLength(1);expect(history.clusterHistory[0]!.trusted).toBe(true);
  for(const copy of copies){
   const row=page.items.find(x=>x.id===copy.event.id)!;expect(row.evidence?.kind).toBe("identical");
   expect(evaluateStorageEvidence(row.evidence,{asOf:history.asOf,...page.proof})).toMatchObject({kind:"not-ready"});
   if(row.evidence?.kind!=="identical")throw Error("Missing stored copy evidence");
   const stored=row.evidence.content;expect(row.evidence.provenanceComplete).toBe(false);
   if(typeof stored.environmentId!=="string"||typeof stored.clusterId!=="string"||typeof stored.ts!=="string"||(stored.routeId!==null&&typeof stored.routeId!=="string"))throw Error("Invalid stored attribution columns");
   const decision=attributeRouteHistoryV2(history,{copiesComplete:page.proof.copiesComplete,copies:[{id:row.id,provenance:row.evidence.provenanceComplete?"workspace-v2":"unknown",content:{...stored,environmentId:stored.environmentId,clusterId:stored.clusterId,routeId:stored.routeId,ts:stored.ts}}],retainedCopyState:null});
   expect(decision).toMatchObject({workspaceId:null,effectiveRevision:null,reason:"attribution-evidence-missing"});
  }
  expect((await service.prefix()).copiesComplete).toBe(false);
  const integrated=await new HistoricalCopyReader(f.h.sql,new BoundedCopyReader(reader)).read({instanceId:f.instanceId,from,to,pageSize:200});
  expect(integrated.prefix.receiptPrefixComplete).toBe(true);expect(integrated.proof).toEqual({copiesComplete:false,conflictHistoryComplete:false,coherentSnapshot:false});
  expect(integrated.items).toHaveLength(2);for(const item of integrated.items){expect(item.attribution).toMatchObject({workspaceId:null,effectiveRevision:null});expect(item.storage.kind).toBe("not-ready");}
  const conflicting={...copies[0]!,copyId:randomUUID(),event:{...copies[0]!.event,status:500}};
  await expect(service.persist(source.token,stream.id,randomUUID(),[conflicting])).rejects.toThrow();
  const blocked=await new HistoricalCopyReader(f.h.sql,new BoundedCopyReader(reader)).read({instanceId:f.instanceId,from,to,pageSize:200});
  expect(blocked.prefix.receiptPrefixComplete).toBe(false);expect(blocked.items.find(i=>i.id===conflicting.event.id)!.evidenceKind).toBe("conflicting-copies");
  expect(blocked.items.every(i=>i.attribution.workspaceId===null&&i.attribution.effectiveRevision===null)).toBe(true);
  const admin=integrationInputs(process.env).clickhouse;
  if(!/^gromesh_test_[0-9a-f]{32}$/.test(CLICKHOUSE.database)||admin.url!==CLICKHOUSE.url)throw Error("Unowned maintenance target");
  const maintenance=createClient({url:admin.url,database:CLICKHOUSE.database,username:admin.user,password:admin.password});
  try{await maintenance.command({query:"ALTER TABLE requests_v2_copies DELETE WHERE id={id:UUID}",query_params:{id:conflicting.event.id},clickhouse_settings:{mutations_sync:"2"}});}finally{await maintenance.close();}
  await expect(service.persist(source.token,stream.id,randomUUID(),[{...copies[0]!,copyId:randomUUID()}])).rejects.toThrow();
  const retained=await new HistoricalCopyReader(f.h.sql,new BoundedCopyReader(reader)).read({instanceId:f.instanceId,from,to,pageSize:200});
  expect(retained.items.find(i=>i.id===conflicting.event.id)!.evidenceKind).toBe("conflicting-copies");
  expect(retained.items.every(i=>i.attribution.workspaceId===null)).toBe(true);
 }finally{await reader.close();await writer.close();await f.close();}
});
