import {BatchIdentityPolicy,digestAdmissionDescriptor} from "./batch-identity.js";
import { claimIngestionWork,assertIngestionWork,finishIngestionWork } from "./ingestion-workers.js";
import { createHash } from "node:crypto";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/db.js";
import { analyticsClusterEvents, analyticsClusterVisibility, analyticsIngestionBatches as batches, analyticsIngestionReceipts as receipts, analyticsIngestionCounter as counter, analyticsIngestionStreams as streams, analyticsIngestionPruneCoverage as coverage, clusters, instance } from "../db/schema.js";
import { AgentGatewayService } from "../agent-gateway/agent-gateway.js";
import { audit } from "../audit/audit.js";
import type { RequestContext } from "../auth/auth.js";
import { ProblemException } from "../common/problem.js";
import { copyStateOf } from "./copy-state.js";
import { extendAdmittedCopyEvidence, reconcileAdmittedComparisons, recordCopyEvidence } from "./copy-evidence.js";
import { CopyEvidenceError, IngestionCopyPersistence } from "./ingestion-copy-persistence.js";
import { encodeRawRequestCopy } from "./request-copy-store.js";

export interface IngestionCopy {
  readonly schemaVersion: 1;
  readonly copyId: string;
  readonly podUid: string;
  readonly requestId: string;
  readonly event: Readonly<Record<string, unknown>>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const invalid = (): never => { throw new ProblemException(422, "Invalid ingestion admission"); };
const denied = (): never => { throw new ProblemException(401, "Missing, invalid or revoked ingestion identity"); };
const hash = (value:string) => createHash("sha256").update(value).digest("hex");
function micros(value:string):bigint {
  const ms=Date.parse(value);const fraction=/\.(\d{1,6})/.exec(value)?.[1]??"";
  if(!Number.isFinite(ms))return denied();
  return BigInt(ms)*1000n+BigInt(fraction.padEnd(6,"0").slice(3));
}
async function lock(tx:Tx) {
  await tx.execute(sql`set local search_path=pg_catalog,public,pg_temp`);
  await tx.execute(sql`set local lock_timeout='1s'`);
  await tx.execute(sql`set local statement_timeout='5s'`);
  await tx.execute(sql`select pg_advisory_xact_lock(1818,1801)`);
}
function describe(stream:typeof streams.$inferSelect,copies:readonly IngestionCopy[],nowText:string,visibleAt:string){
      const ids=new Set<string>();
      return copies.map(copy=>{
        if(!copy||Object.keys(copy).sort().join(",")!=="copyId,event,podUid,requestId,schemaVersion"||copy.schemaVersion!==1||!uuid.test(copy.copyId)||ids.has(copy.copyId)||copy.podUid!==stream.podUid||!/^[0-9a-f]{32}$/.test(copy.requestId))return invalid();
        ids.add(copy.copyId);
        const hex=hash(stream.clusterId+"|"+stream.podUid+"|"+copy.requestId).slice(0,32);
        const id=`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
        if(!copy.event||typeof copy.event!=="object"||Array.isArray(copy.event))return invalid();
        const {id:declared,...content}=copy.event;
        if(declared!==id||content.environmentId!==stream.instanceId||content.clusterId!==stream.clusterId)return invalid();
        try{encodeRawRequestCopy({id,content});}catch{return invalid();}
        const eventTime=Date.parse(content.ts as string),now=Date.parse(nowText);
        // Earlier authorizations are not inferred from the stream's current binding.
        if(eventTime>now||eventTime<now-7*86400000||BigInt(eventTime)*1000n<micros(visibleAt))return invalid();
        return {copyId:copy.copyId,id,commitment:hash(copyStateOf(id,copy.event).minContent),expiresAt:new Date(eventTime+(content.retentionDays as number)*86400000).toISOString()};
      });
}

/** Internal admission only: there is deliberately no HTTP handler or persistence-confirmation shortcut. */
export class IngestionAdmissions {
  constructor(private readonly db:Db,private readonly gateway:AgentGatewayService,private readonly persistence?:IngestionCopyPersistence,private readonly identityPolicy?:BatchIdentityPolicy) {}
  private async authorized(tx:Tx,token:string) {
    // Identify first, then lock the cluster before revalidating the bearer, matching its lifecycle lock order.
    const found=await this.gateway.node(tx,token);
    await tx.select().from(clusters).where(eq(clusters.id,found.cluster.id)).for("update");
    const current=await this.gateway.node(tx,token);
    const [self]=await tx.select().from(instance);
    const [last]=await tx.select().from(analyticsClusterEvents).where(eq(analyticsClusterEvents.clusterId,current.cluster.id)).orderBy(desc(analyticsClusterEvents.sequence)).limit(1);
    const [visible]=last?await tx.select({observedAt:analyticsClusterVisibility.observedAt}).from(analyticsClusterVisibility).where(eq(analyticsClusterVisibility.authorizationId,last.id)):[];
    if(!self||current.cluster.deliveryProtocol!=="v2"||!last||last.operation!=="authorize"||!last.complete||last.instanceId!==self.id||!visible) return denied();
    const now=(await tx.execute<{now:string}>(sql`select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as now`)).rows[0]!.now;
    if(micros(visible.observedAt)>micros(now))return denied();
    return {current,self,last,visible,now,ctx:{actor:{type:"agent",id:current.node.nodeId},role:"viewer",ip:null} satisfies RequestContext};
  }
  async open(token:string,podUid:string) {
    if(!uuid.test(podUid))return invalid();
    return this.db.transaction(async tx=>{
      await lock(tx);const a=await this.authorized(tx,token);
      const [foreignOwner]=await tx.select({id:streams.id}).from(streams).where(and(eq(streams.instanceId,a.self.id),eq(streams.clusterId,a.current.cluster.id),eq(streams.podUid,podUid),ne(streams.nodeId,a.current.node.nodeId))).limit(1);
      if(foreignOwner)return denied();
      const [stream]=await tx.insert(streams).values({instanceId:a.self.id,clusterId:a.current.cluster.id,nodeId:a.current.node.nodeId,podUid,authorizationId:a.last.id}).returning();
      await audit(tx,a.ctx,{action:"analytics.ingestion.open",entityType:"ingestion-stream",entityId:stream!.id,after:{instanceId:stream!.instanceId,clusterId:stream!.clusterId,podUid,authorizationId:a.last.id}});
      return stream!;
    });
  }
  async prepare(token:string,streamId:string,batchId:string,copies:readonly IngestionCopy[],expectedGeneration?:string){return this.prepareInternal(token,streamId,batchId,copies,expectedGeneration);}
  /** Isolated proposal consumer. No runtime factory supplies identityPolicy. */
  async prepareWithIdentity(token:string,streamId:string,identity:{batchId:string;token:string},copies:readonly IngestionCopy[]){if(!this.identityPolicy||!identity||typeof identity.token!=="string"||!identity.token||identity.token.length>2048)throw new ProblemException(409,"Authenticated batch identity required");return this.prepareInternal(token,streamId,identity.batchId,copies,undefined,identity.token);}
  async issueIdentity(token:string,streamId:string,copies:readonly IngestionCopy[]){
    if(!this.identityPolicy||!uuid.test(streamId)||!Array.isArray(copies)||copies.length<1||copies.length>100||Buffer.byteLength(JSON.stringify(copies))>2*1024*1024)return invalid();
    copies=structuredClone(copies);
    return this.db.transaction(async tx=>{
      await lock(tx);const a=await this.authorized(tx,token);
      const [stream]=await tx.select().from(streams).where(eq(streams.id,streamId));
      if(!stream||stream.instanceId!==a.self.id||stream.clusterId!==a.current.cluster.id||stream.nodeId!==a.current.node.nodeId||stream.authorizationId!==a.last.id)return denied();
      const descriptor=describe(stream,copies,a.now,a.visible.observedAt),[current]=await tx.select().from(counter).where(eq(counter.singleton,true));
      const position=((current?.position??0n)+1n).toString();
      const issued=this.identityPolicy!.issue({instanceId:a.self.id,streamId,authorizationId:a.last.id,position,descriptorDigest:digestAdmissionDescriptor(descriptor)},Date.parse(a.now));
      await audit(tx,a.ctx,{action:"analytics.ingestion.identity",entityType:"ingestion-batch",entityId:issued.batchId,after:{streamId,position,copyCount:descriptor.length}});
      return issued;
    });
  }
  private async prepareInternal(token:string,streamId:string,batchId:string,copies:readonly IngestionCopy[],expectedGeneration?:string,identityTicket?:string) {
    if(expectedGeneration!==undefined&&(!/^[1-9][0-9]{0,18}$/.test(expectedGeneration)||BigInt(expectedGeneration)>9223372036854775807n))return invalid();
    if(!uuid.test(streamId)||!uuid.test(batchId)||!Array.isArray(copies)||copies.length<1||copies.length>100||Buffer.byteLength(JSON.stringify(copies))>2*1024*1024)return invalid();
    copies=structuredClone(copies);
    return this.db.transaction(async tx=>{
      await lock(tx);const a=await this.authorized(tx,token);
      const [stream]=await tx.select().from(streams).where(eq(streams.id,streamId));
      if(!stream||stream.instanceId!==a.self.id||stream.clusterId!==a.current.cluster.id||stream.nodeId!==a.current.node.nodeId||stream.authorizationId!==a.last.id)return denied();
      const descriptor=describe(stream,copies,a.now,a.visible.observedAt);
      if(batchId[14]==='8'&&identityTicket===undefined)throw new ProblemException(409,"Authenticated batch identity required");
      const identity=identityTicket!==undefined?this.identityPolicy?.verify(identityTicket,{instanceId:a.self.id,streamId,authorizationId:a.last.id,batchId,descriptorDigest:digestAdmissionDescriptor(descriptor)},Date.parse(a.now)):undefined;
      if(identityTicket!==undefined&&!identity)throw new ProblemException(409,"Batch identity policy is not enabled");
      const [prior]=await tx.select().from(batches).where(eq(batches.id,batchId));
      // A reconciliation may only revisit the exact existing position; GC/missing history must never readmit it.
      if(expectedGeneration!==undefined&&(!prior||prior.generation.toString()!==expectedGeneration))throw new ProblemException(409,"Ingestion admission is no longer available at the expected position");
      if(prior){if(identity&&prior.generation.toString()!==identity.position)throw new ProblemException(409,"Batch identity position conflicts");if(prior.streamId!==streamId||JSON.stringify(prior.descriptor.map(d=>[d.copyId,d.id,d.commitment,d.expiresAt]))!==JSON.stringify(descriptor.map(d=>[d.copyId,d.id,d.commitment,d.expiresAt])))throw new ProblemException(409,"Ingestion batch conflicts with its admission");return {id:prior.id,generation:prior.generation.toString(),state:"prepared" as const};}
      // Pruning erased the only global UUID binding. Without a new identity-lifetime contract,
      // unknown IDs cannot be distinguished from consumed IDs; stop rather than resurrect either.
      const [lostHistory]=await tx.select({through:coverage.prunedThrough}).from(coverage).where(eq(coverage.singleton,true));
      if(lostHistory&&!identity)throw new ProblemException(409,"Ingestion identity cannot be verified after history pruning");
      if(identity){const[current]=await tx.select().from(counter).where(eq(counter.singleton,true));if(BigInt(identity.position)!==(current?.position??0n)+1n)throw new ProblemException(409,"Batch identity position is already consumed or stale");}
      await tx.insert(counter).values({singleton:true,position:0n}).onConflictDoNothing();
      const [position]=await tx.update(counter).set({position:sql`${counter.position}+1`}).where(eq(counter.singleton,true)).returning();
      await tx.insert(batches).values({id:batchId,streamId,generation:position!.position,descriptor});
      await extendAdmittedCopyEvidence(tx,a.ctx,batchId);
      await audit(tx,a.ctx,{action:"analytics.ingestion.prepare",entityType:"ingestion-batch",entityId:batchId,after:{streamId,generation:position!.position.toString(),copyCount:descriptor.length}});
      return {id:batchId,generation:position!.position.toString(),state:"prepared" as const};
    });
  }
  async persist(token:string,streamId:string,batchId:string,copies:readonly IngestionCopy[],options:{expectedGeneration?:string;signal?:AbortSignal;identityTicket?:string}={}) {
    const signal=options.signal;signal?.throwIfAborted();copies=structuredClone(copies);
    if(!this.persistence)throw new Error("Ingestion persistence is not configured");
    const prepared=await this.prepareInternal(token,streamId,batchId,copies,options.expectedGeneration,options.identityTicket);
    signal?.throwIfAborted();
    const prior=await this.db.select().from(receipts).where(eq(receipts.batchId,batchId));
    const receipt=(counts:{storedCopies:number;expiredCopies:number})=>({schemaVersion:1 as const,streamId,batchId,generation:prepared.generation,status:"persisted" as const,storedCopies:counts.storedCopies,expiredCopies:counts.expiredCopies});
    signal?.throwIfAborted();if(prior[0])return receipt(prior[0]);
    const work=await this.db.transaction(async tx=>{
      await lock(tx);const a=await this.authorized(tx,token);
      const [stream]=await tx.select().from(streams).where(eq(streams.id,streamId));
      if(!stream||stream.nodeId!==a.current.node.nodeId||stream.authorizationId!==a.last.id)return denied();
      signal?.throwIfAborted();return claimIngestionWork(tx,a.ctx,batchId);
    });
    // No network call is performed while holding a PostgreSQL transaction or cluster/admission lock.
    let observed:Awaited<ReturnType<IngestionCopyPersistence["persist"]>>;
    try {
      const asOf=(await this.db.execute<{now:string}>(sql`select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as now`)).rows[0]!.now;
      signal?.throwIfAborted();observed=await this.persistence.persist({streamId,batchId,generation:prepared.generation,copies,asOf},signal);signal?.throwIfAborted(); }
    catch(error) {
      try{if(error instanceof CopyEvidenceError) await recordCopyEvidence(this.db,{actor:{type:"system",id:"analytics-copy-observer"},role:"viewer",ip:null},batchId,error.observations);}
      finally{await this.db.transaction(async tx=>{await lock(tx);await finishIngestionWork(tx,{actor:{type:"system",id:"analytics-persistence-worker"},role:"viewer",ip:null},work,"failed");});}
      throw error;
    }
    try{const confirmed=await this.db.transaction(async tx=>{
      await lock(tx);const a=await this.authorized(tx,token);
      signal?.throwIfAborted();await assertIngestionWork(tx,work);
      const [stream]=await tx.select().from(streams).where(eq(streams.id,streamId));
      if(!stream||stream.instanceId!==a.self.id||stream.clusterId!==a.current.cluster.id||stream.nodeId!==a.current.node.nodeId||stream.authorizationId!==a.last.id)return denied();
      const [existing]=await tx.select().from(receipts).where(eq(receipts.batchId,batchId));
      if(existing)return receipt(existing);
      const comparison=await reconcileAdmittedComparisons(tx,a.ctx,batchId,observed.observedCopies);
      if(comparison.blocked){await finishIngestionWork(tx,a.ctx,work,"failed");return null;}
      const counts={storedCopies:observed.storedCopies,expiredCopies:observed.expiredCopies};
      signal?.throwIfAborted();await tx.insert(receipts).values({batchId,...counts});
      await audit(tx,a.ctx,{action:"analytics.ingestion.persist",entityType:"ingestion-batch",entityId:batchId,after:{streamId,generation:prepared.generation,...counts,evidence:"exact-clickhouse-read-back",...(observed.storageWitness?{storageWitness:observed.storageWitness}:{})}});
      await finishIngestionWork(tx,a.ctx,work,"verified");
      signal?.throwIfAborted();return receipt(observed);
    });if(!confirmed)throw new Error("Ingestion persistence is not confirmed");return confirmed;}catch(error){
      await this.db.transaction(async tx=>{await lock(tx);await finishIngestionWork(tx,{actor:{type:"system",id:"analytics-persistence-worker"},role:"viewer",ip:null},work,"failed");});
      throw error;
    }
  }
  async prefix() {
    return this.db.transaction(async tx=>{
      await tx.execute(sql`set local statement_timeout='5s'`);
      const [position]=await tx.select().from(counter).where(eq(counter.singleton,true));
      const rows=await tx.select({generation:batches.generation,receiptId:receipts.batchId}).from(batches).leftJoin(receipts,eq(receipts.batchId,batches.id)).orderBy(asc(batches.generation)).limit(10001);
      if(rows.length>10000)throw new Error("Ingestion admission budget exceeded");
      let persistedThrough=0n;
      for(const row of rows){if(!row.receiptId||row.generation!==persistedThrough+1n)break;persistedThrough=row.generation;}
      const pending=rows.filter(row=>!row.receiptId);
      // Receipts certify individual batches, not global conflict retention or a coherent PG/CH serving snapshot.
      return {acceptedThrough:(position?.position??0n).toString(),persistedThrough:persistedThrough.toString(),pendingBatches:pending.length,copiesComplete:false as const,conflictHistoryComplete:false as const,coherentSnapshot:false as const,reason:pending.length?"persistence-not-confirmed" as const:"serving-evidence-incomplete" as const};
    },{isolationLevel:"repeatable read",accessMode:"read only"});
  }
}
