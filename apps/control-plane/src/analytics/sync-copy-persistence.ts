import {randomUUID} from "node:crypto";
import type {ClickHouseClient} from "@clickhouse/client";
import {BoundedCopyQueries} from "./bounded-copy-queries.js";
import {assertCopyStorageSchema} from "./copy-storage-schema.js";
import {IngestionCopyPersistence,type CopyPersistenceObservation} from "./ingestion-copy-persistence.js";
const failed=()=>Error("Synchronous copy storage is not confirmed");
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const engine="MergeTree PARTITION BY toDate(ts) ORDER BY (id, ts, environment_id) TTL ts + toIntervalDay(retention_days) SETTINGS ";
/** Strict allowlist for the exact plain-MergeTree layout/version exercised by the disposable harness. */
export function synchronousCopyResource(value:unknown){
 if(!value||typeof value!=="object"||Array.isArray(value))throw failed();const row=value as Record<string,unknown>;
 if(row.serverVersion!=="25.8.33.6"||typeof row.serverId!=="string"||!uuid.test(row.serverId)||row.serverId==="00000000-0000-0000-0000-000000000000"||typeof row.tableId!=="string"||!uuid.test(row.tableId)||row.tableId==="00000000-0000-0000-0000-000000000000"||typeof row.engineFull!=="string"||!row.engineFull.startsWith(engine))throw failed();
 const wanted=new Map([['index_granularity','8192'],['fsync_after_insert','1'],['fsync_part_directory','1'],['min_rows_to_fsync_after_merge','1']]);
 const settings=row.engineFull.slice(engine.length).split(', ');if(settings.length!==wanted.size)throw failed();
 for(const setting of settings){const match=/^([a-z_]+) = ([0-9]+)$/.exec(setting);if(!match||wanted.get(match[1]!)!==match[2])throw failed();wanted.delete(match[1]!);}
 if(wanted.size)throw failed();return {serverVersion:row.serverVersion,serverId:row.serverId,tableId:row.tableId,engineFull:row.engineFull};
}
const metadata="SELECT version() AS serverVersion,toString(serverUUID()) AS serverId,toString(uuid) AS tableId,engine_full AS engineFull FROM system.tables WHERE database=currentDatabase() AND name='requests_v2_copies'";
/** Opt-in only. Observes synchronous policy before/after ACK and exact readback; no policy-continuity, serving-fence or Kong-delivery claim. */
export class SyncIngestionCopyPersistence extends IngestionCopyPersistence{
 constructor(private readonly writeClient:ClickHouseClient,private readonly readClient:ClickHouseClient){super(writeClient,readClient);}
 override async persist(input:Parameters<IngestionCopyPersistence['persist']>[0],caller?:AbortSignal):Promise<CopyPersistenceObservation>{
  const readSession=`gromesh-sync-read-${randomUUID()}`,writeSession=`gromesh-sync-write-${randomUUID()}`;
  const reads=new BoundedCopyQueries(this.readClient,{},caller,readSession),writes=reads.withSession(this.writeClient,writeSession);
  const resource=async(queries:BoundedCopyQueries,exists:boolean)=>{const rows=await queries.query(metadata,{},1,exists);if(rows.length!==1)throw failed();return synchronousCopyResource(rows[0]);};
  const beforeRead=await resource(reads,false),beforeWrite=await resource(writes,false);
  if(JSON.stringify(beforeRead)!==JSON.stringify(beforeWrite))throw failed();
  await assertCopyStorageSchema(reads);
  const observed=await new IngestionCopyPersistence(this.writeClient,this.readClient,{queries:reads,writes}).persist(input,reads.signal);
  const afterWrite=await resource(writes,true),afterRead=await resource(reads,true);
  await assertCopyStorageSchema(reads);
  if(JSON.stringify(beforeRead)!==JSON.stringify(afterRead)||JSON.stringify(beforeWrite)!==JSON.stringify(afterWrite))throw failed();
  if(observed.storedCopies===0)return observed;
  if(!observed.insertQueryId||!uuid.test(observed.insertQueryId))throw failed();
  return {...observed,storageWitness:{kind:'observed-sync-policy-readback-v1',serverId:beforeRead.serverId,tableId:beforeRead.tableId,serverVersion:beforeRead.serverVersion,insertQueryId:observed.insertQueryId}};
 }
}
