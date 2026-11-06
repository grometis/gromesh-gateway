import pg from "pg";
import {ADMIN_URL} from "./databases.js";
import { readFileSync } from "node:fs";
import { createClient } from "@clickhouse/client";
import { integrationInputs,provisionClickhouse } from "../../../../scripts/integration-databases.mjs";
// Shared across nested fixtures in this worker; do not queue a new lock behind an exclusive waiter while retaining our first one.
let catalog:Promise<pg.Client>|undefined,catalogUrl:string|undefined,references=0;
export async function physicalCatalogLease(url=ADMIN_URL){
 if(catalog&&catalogUrl!==url)throw Error("Mixed disposable catalog coordination namespace");
 references++;if(!catalog)catalogUrl=url;
 if(!catalog)catalog=(async()=>{const client=new pg.Client({connectionString:url});try{await client.connect();await client.query('select pg_advisory_lock_shared(21121,1)');return client;}catch{await client.end();throw Error('Disposable catalog coordination unavailable');}})();
 const current=catalog;
 try{await current;}catch(error){references--;if(catalog===current&&references===0){catalog=undefined;catalogUrl=undefined;}throw error;}
 let released=false;return async()=>{if(released)return;released=true;if(--references===0){if(catalog===current){catalog=undefined;catalogUrl=undefined;}await(await current).end();}};
}
/** Each physical observation suite owns its table: unrelated integration writers must not mutate its cut. */
export async function physicalFenceFixture(options:{sync?:boolean}={}){
 const release=await physicalCatalogLease();try{
 const admin=integrationInputs(process.env).clickhouse;
 const ddl=["001-requests.sql","002-retention.sql","003-request-copies.sql","004-ingestion-envelopes.sql"].map(name=>readFileSync(new URL(`../../../../deploy/observability/clickhouse/${name}`,import.meta.url),"utf8")).join("\n");
 const store=await provisionClickhouse(admin,ddl,{copyFenceMetadata:true,syncCopyWitnessMetadata:options.sync??false});
 const client=(c:typeof store.reader)=>createClient({url:c.url,database:c.database,username:c.user,password:c.password});
 const reader=client(store.reader),writer=client(store.writer),operator=createClient({url:admin.url,database:store.reader.database,username:admin.user,password:admin.password});
 return {reader,writer,operator,close:async()=>{try{await reader.close();await writer.close();await operator.close();await store.close();}finally{await release();}}};
 }catch(error){await release();throw error;}
}
