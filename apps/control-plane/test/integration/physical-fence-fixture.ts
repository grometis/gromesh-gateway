import { readFileSync } from "node:fs";
import { createClient } from "@clickhouse/client";
import { integrationInputs,provisionClickhouse } from "../../../../scripts/integration-databases.mjs";
/** Each physical observation suite owns its table: unrelated integration writers must not mutate its cut. */
export async function physicalFenceFixture(){
 const admin=integrationInputs(process.env).clickhouse;
 const ddl=["001-requests.sql","002-retention.sql","003-request-copies.sql","004-ingestion-envelopes.sql"].map(name=>readFileSync(new URL(`../../../../deploy/observability/clickhouse/${name}`,import.meta.url),"utf8")).join("\n");
 const store=await provisionClickhouse(admin,ddl,{copyFenceMetadata:true});
 const client=(c:typeof store.reader)=>createClient({url:c.url,database:c.database,username:c.user,password:c.password});
 const reader=client(store.reader),writer=client(store.writer),operator=createClient({url:admin.url,database:store.reader.database,username:admin.user,password:admin.password});
 return {reader,writer,operator,close:async()=>{await reader.close();await writer.close();await operator.close();await store.close();}};
}
