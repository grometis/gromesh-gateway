import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/db.js";
import type { AgentGatewayService } from "../agent-gateway/agent-gateway.js";
import { analyticsIngestionBatches as batches, analyticsIngestionStreams as streams, analyticsIngestionReceipts as receipts } from "../db/schema.js";
import { IngestionAdmissions, authorizeIngestionProducer } from "./ingestion-admissions.js";
import { assertIngestionWork } from "./ingestion-workers.js";
import { BoundedCopyQueries, copyReadNotReady } from "./bounded-copy-queries.js";
import { IngestionCopyPersistence, type IngestionPersistenceInput, type CopyPersistenceObservation } from "./ingestion-copy-persistence.js";
import { readRuntimeCopyStorage } from "./ingestion-storage-registration.js";
import { observeCopyStorageAuthority, observeCopyStorageResource, type RegisteredCopyStorage } from "./copy-storage-authority-observer.js";
import { assertCopyStorageSchema } from "./copy-storage-schema.js";
import { synchronousCopyResource } from "./sync-copy-persistence.js";
import { copyStateOf } from "./copy-state.js";
import { privateCopyStorageClient, validateTrustedCopyStorageSettings, type TrustedCopyStorageSettings } from "./trusted-copy-storage.js";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/** These checks run both before INSERT and inside the receipt transaction. No network I/O here. */
async function assertAdmittedWrite(tx: Tx, gateway: AgentGatewayService, registration: RegisteredCopyStorage, input: IngestionPersistenceInput) {
  await tx.execute(sql`set local lock_timeout='1s'`);
  await tx.execute(sql`set local statement_timeout='5s'`);
  await tx.execute(sql`select pg_advisory_xact_lock(1818,1801)`);
  const proof = input.admissionProof;
  if (!proof || proof.work.batchId !== input.batchId) throw copyReadNotReady();
  const a = await authorizeIngestionProducer(tx, gateway, proof.bearer);
  await assertIngestionWork(tx, proof.work);
  const binding = await readRuntimeCopyStorage(tx);
  if (JSON.stringify(binding) !== JSON.stringify(registration) || a.self.id !== binding.instanceId) throw copyReadNotReady();
  const [stream] = await tx.select().from(streams).where(eq(streams.id, input.streamId));
  const [batch] = await tx.select().from(batches).where(and(eq(batches.id, input.batchId), eq(batches.streamId, input.streamId)));
  const [receipt] = await tx.select().from(receipts).where(eq(receipts.batchId, input.batchId));
  if (!stream || !batch || receipt || stream.nodeId !== a.current.node.nodeId || stream.clusterId !== a.current.cluster.id || stream.authorizationId !== a.last.id || stream.instanceId !== binding.instanceId || batch.generation.toString() !== input.generation) throw copyReadNotReady();
  const descriptor = input.copies.map(copy => ({ copyId: copy.copyId, id: String(copy.event.id),
    commitment: digest(copyStateOf(String(copy.event.id), copy.event).minContent),
    expiresAt: new Date(Date.parse(String(copy.event.ts)) + Number(copy.event.retentionDays) * 86400000).toISOString() }));
  const identity = (d: typeof descriptor[number]) => [d.copyId, d.id, d.commitment, d.expiresAt];
  if (input.copies.some(copy => copy.podUid !== stream.podUid) || JSON.stringify(descriptor.map(identity)) !== JSON.stringify(batch.descriptor.map(identity))) throw copyReadNotReady();
}

/** Explicit composition only, never bootstrap. Clients and bearer/work proofs do not escape this closure.
 * A trusted administrator or stolen writer secret can bypass application admission; both remain outside
 * this boundary. An in-flight insert after revocation can be orphaned, but cannot obtain a receipt. */
export async function openTrustedIngestion(input: { db: Db; gateway: AgentGatewayService; settings: TrustedCopyStorageSettings; signal?: AbortSignal }) {
  validateTrustedCopyStorageSettings(input.settings);
  const registration = await readRuntimeCopyStorage(input.db);
  if (registration.databaseName !== input.settings.databaseName) throw copyReadNotReady();
  const writer = privateCopyStorageClient(input.settings, input.settings.writer);
  const reader = privateCopyStorageClient(input.settings, input.settings.reader);
  const auditor = privateCopyStorageClient(input.settings, input.settings.auditor);
  let closed = false;
  const close = async () => { closed = true; await Promise.all([writer.close(), reader.close(), auditor.close()]); };
  try {
    const opening = await observeCopyStorageAuthority(new BoundedCopyQueries(auditor, {}, input.signal), registration);
    if (input.settings.writer.user !== opening.authority.writer || input.settings.reader.user !== opening.authority.reader || input.settings.auditor.user !== opening.authority.auditor) throw copyReadNotReady();
    const persistence = {
      confirm: (tx: Tx, value: IngestionPersistenceInput) => assertAdmittedWrite(tx, input.gateway, registration, value),
      persist: async (value: IngestionPersistenceInput, caller?: AbortSignal): Promise<CopyPersistenceObservation> => {
        if (closed) throw copyReadNotReady();
        await input.db.transaction(tx => assertAdmittedWrite(tx, input.gateway, registration, value));
        const queries = new BoundedCopyQueries(auditor, {}, caller, `gromesh-authority-${randomUUID()}`);
        const reads = queries.withSession(reader, `gromesh-admitted-read-${randomUUID()}`);
        const writes = queries.withSession(writer, `gromesh-admitted-write-${randomUUID()}`);
        const before = await observeCopyStorageAuthority(queries, registration);
        let serverVersion = "";
        for (const [q, principal] of [[reads, before.authority.reader], [writes, before.authority.writer]] as const) {
          const resource = await observeCopyStorageResource(q, registration);
          if (resource.principal !== principal) throw copyReadNotReady();
          synchronousCopyResource({ ...resource, serverVersion: resource.version });
          serverVersion = resource.version;
        }
        await assertCopyStorageSchema(reads);
        // The private INSERT path is reached only with a current server-issued worker claim.
        const observed = await new IngestionCopyPersistence(writer, reader, { queries: reads, writes }).persist(value, queries.signal);
        const after = await observeCopyStorageAuthority(queries, registration, true);
        if (JSON.stringify(before) !== JSON.stringify(after)) throw copyReadNotReady();
        if (!observed.storedCopies) return observed;
        if (!observed.insertQueryId) throw copyReadNotReady();
        return { ...observed, storageWitness: { kind: "observed-sync-policy-readback-v1", serverId: registration.serverId,
          tableId: registration.tableId, serverVersion, insertQueryId: observed.insertQueryId } };
      },
    };
    const admissions = new IngestionAdmissions(input.db, input.gateway, persistence);
    const current = () => { if (closed) throw copyReadNotReady(); };
    return Object.freeze({
      open: (...args: Parameters<IngestionAdmissions["open"]>) => { current(); return admissions.open(...args); },
      // Snapshot before the first await: caller-owned objects cannot change the admitted payload in flight.
      prepare: (...args: Parameters<IngestionAdmissions["prepare"]>) => { current(); return admissions.prepare(args[0], args[1], args[2], structuredClone(args[3]), args[4]); },
      persist: (...args: Parameters<IngestionAdmissions["persist"]>) => { current(); return admissions.persist(args[0], args[1], args[2], structuredClone(args[3]), args[4]); },
      prefix: () => { current(); return admissions.prefix(); }, close,
    });
  } catch { await close(); throw copyReadNotReady(); }
}
