import { randomUUID } from "node:crypto";
import type pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema.js";
import { and, eq, inArray } from "drizzle-orm";
import { withIngestionReadFence } from "./ingestion-read-snapshot.js";
import { planPersistedPrefix, validatePersistedPrefix } from "./persisted-prefix-observer.js";
import { BoundedCopyQueries, copyReadNotReady, type CopyReadBudget } from "./bounded-copy-queries.js";
import type { CopyReadWindow } from "./bounded-copy-reader.js";
import { PhysicalCopyFence, observePhysicalCopyCut } from "./physical-copy-fence.js";
import { assertCopyStorageSchema } from "./copy-storage-schema.js";
import { readRuntimeCopyStorage, readRuntimeCopyStorageSnapshot } from "./ingestion-storage-registration.js";
import { observeCopyStorageAuthority, observeCopyStorageResource } from "./copy-storage-authority-observer.js";
import { privateCopyStorageClient, type TrustedCopyStorageSettings } from "./trusted-copy-storage.js";
import { routeHistoryEvidenceSnapshot } from "./route-history-evidence.js";
import { foldStorageCopies, evaluateStorageEvidence } from "./storage-consistency.js";
import { attributeRouteHistoryV2 } from "./route-history-v2.js";
import type { AnalyticsRow } from "./attribution.js";

/** A fresh proof is produced for each bounded read; it is never a reusable caller-supplied serving token.
 * Scope is the current admitted prefix, not delivery from Kong, future survival or a global PG/CH ACID snapshot. */
export async function openVerifiedHistoricalReader(input: { pool: pg.Pool; settings: Pick<TrustedCopyStorageSettings,"url"|"databaseName"|"reader"|"auditor"> }) {
  const db = drizzle(input.pool, { schema });
  const registered = await readRuntimeCopyStorage(db);
  if (registered.databaseName !== input.settings.databaseName) throw copyReadNotReady();
  const reader = privateCopyStorageClient(input.settings, input.settings.reader);
  const auditor = privateCopyStorageClient(input.settings, input.settings.auditor);
  let closed = false, busy = false;
  const close = async () => { closed = true; await Promise.all([reader.close(), auditor.close()]); };
  try {
    const initial = await observeCopyStorageAuthority(new BoundedCopyQueries(auditor), registered);
    if (initial.authority.reader !== input.settings.reader.user || initial.authority.auditor !== input.settings.auditor.user) throw copyReadNotReady();
    const read = async (window: CopyReadWindow, budget: CopyReadBudget = {}, caller?: AbortSignal) => {
      window = structuredClone(window); budget = { ...budget };
      const from = Date.parse(window.from), to = Date.parse(window.to);
      if (closed || busy || window.instanceId !== registered.instanceId || !Number.isFinite(from) || !Number.isFinite(to) || from >= to || to-from > 7*86400000 || !Number.isInteger(window.pageSize) || window.pageSize < 1 || window.pageSize > 200) throw copyReadNotReady();
      if (window.after && (!/^[0-9a-f-]{36}$/.test(window.after.id) || !Number.isFinite(Date.parse(window.after.ts)) || Date.parse(window.after.ts) < from || Date.parse(window.after.ts) >= to)) throw copyReadNotReady();
      busy = true;
      try {
        return await withIngestionReadFence(input.pool, async snapshot => {
          const binding = await readRuntimeCopyStorageSnapshot(snapshot);
          if (JSON.stringify(binding) !== JSON.stringify(registered)) throw copyReadNotReady();
          return planPersistedPrefix(snapshot);
        }, async (plan, signal) => {
          const queries = new BoundedCopyQueries(auditor, budget, signal, `gromesh-proof-authority-${randomUUID()}`);
          const data = queries.withSession(reader, `gromesh-proof-data-${randomUUID()}`);
          const before = await observeCopyStorageAuthority(queries, registered);
          const resource = await observeCopyStorageResource(data, registered);
          if (resource.principal !== before.authority.reader) throw copyReadNotReady();
          const physical = await new PhysicalCopyFence(reader).observe(plan.ids, budget, signal, data, true);
          budget.operation?.materialize(physical.rows);
          const after = await observeCopyStorageAuthority(queries, registered, true);
          if (JSON.stringify(before) !== JSON.stringify(after) || physical.tableId !== registered.tableId) throw copyReadNotReady();
          return { physical, queries, data, authority: before };
        }, async (snapshot, prepared, observed) => {
          const checked = await validatePersistedPrefix(snapshot, prepared, observed.physical);
          budget.operation?.materialize(checked.copies);
          const receipts = prepared.rows.length ? await snapshot.select({ batchId: schema.auditEvents.entityId, after: schema.auditEvents.after })
            .from(schema.auditEvents).where(and(eq(schema.auditEvents.action, "analytics.ingestion.persist"), inArray(schema.auditEvents.entityId, prepared.rows.map(row => row.batchId)))).limit(101) : [];
          if (receipts.length !== prepared.rows.length) throw copyReadNotReady();
          for (const row of prepared.rows) {
            const receipt = receipts.filter(receipt => receipt.batchId === row.batchId);
            const facts = receipt[0]?.after;
            if (receipt.length !== 1 || !facts || typeof facts !== "object" || Array.isArray(facts)) throw copyReadNotReady();
            const fields = facts as Record<string, unknown>, witness = fields.storageWitness;
            if (fields.streamId !== row.streamId || fields.generation !== row.generation || fields.storedCopies !== row.storedCopies || fields.expiredCopies !== 0 || !witness || typeof witness !== "object" || Array.isArray(witness)) throw copyReadNotReady();
            const value = witness as Record<string, unknown>;
            if (value.kind !== "observed-sync-policy-readback-v1" || value.serverId !== registered.serverId || value.tableId !== registered.tableId || value.serverVersion !== "25.8.33.6" || typeof value.insertQueryId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.insertQueryId)) throw copyReadNotReady();
          }
          const logical = checked.copies.map(row => ({ id: String(row.copy.event.id), content: row.copy.event, provenance: "workspace-v2" as const }));
          const strings = (field: string) => [...new Set(logical.flatMap(row => typeof row.content[field] === "string" ? [String(row.content[field])] : []))];
          const history = await routeHistoryEvidenceSnapshot(snapshot, registered.instanceId, { from: window.from, to: window.to, routeIds: strings("routeId"), clusterIds: strings("clusterId") });
          budget.operation?.materialize(history);
          // All positions, exact copies, negative history, resource identity and stable parts have just passed.
          // No flag is sourced from configuration, the producer or a fixture.
          const proof = { copiesComplete: true, conflictHistoryComplete: true, coherentSnapshot: true, deliveryFromKongComplete: false } as const;
          const items = prepared.ids.map(id => {
            const copies = logical.filter(row => row.id === id);
            const evidence = foldStorageCopies({ id, previous: null, copies, budget: { maxRows: 10000, maxDecodedBytes: 2*1024*1024 } }).evidence;
            const storage = evaluateStorageEvidence(evidence, { asOf: history.asOf, ...proof });
            if (storage.kind !== "ready") throw copyReadNotReady();
            const attribution = attributeRouteHistoryV2(history, { copiesComplete: proof.copiesComplete,
              copies: copies.map(row => ({ ...row, content: row.content as AnalyticsRow })), retainedCopyState: null });
            const candidateRevisions = attribution.candidateRevisions.map(ref => {
              const revision = history.revisions.find(row => row.epoch === ref.epoch && row.revision === ref.revision);
              if (!revision) throw copyReadNotReady();
              return { ...ref, recordedAt: revision.recordedAt };
            });
            return { id, ts: String(storage.content.ts), storage, attribution, candidateRevisions };
          }).filter(row => Date.parse(row.ts) >= from && Date.parse(row.ts) < to)
            .sort((a,b) => a.ts === b.ts ? a.id === b.id ? 0 : a.id < b.id ? 1 : -1 : a.ts < b.ts ? 1 : -1);
          const after = window.after;
          const selected = items.filter(row => !after || row.ts < after.ts || (row.ts === after.ts && row.id < after.id));
          const page = selected.slice(0, window.pageSize), last = page.at(-1);
          budget.operation?.materialize(items);
          return { scope: "admitted-prefix" as const, observedThrough: checked.current.through, asOf: history.asOf, items: page,
            next: selected.length > page.length && last ? { ts: last.ts, id: last.id } : null, usage: observed.physical.usage, proof };
        }, caller, async (_plan, observed) => {
          // No PG transaction is open here; all ledgers/history were already read under one coherent snapshot.
          const authority = await observeCopyStorageAuthority(observed.queries, registered, true);
          const resource = await observeCopyStorageResource(observed.data, registered, true);
          if (resource.principal !== authority.authority.reader || JSON.stringify(authority) !== JSON.stringify(observed.authority)) throw copyReadNotReady();
          await assertCopyStorageSchema(observed.data);
          const final = await observePhysicalCopyCut(observed.data, true);
          if (final.tableId !== observed.physical.tableId || final.definition !== registered.definition || JSON.stringify(final.parts) !== JSON.stringify(observed.physical.parts)) throw copyReadNotReady();
        },budget.operation);
      } finally { busy = false; }
    };
    return Object.freeze({ read, close });
  } catch { await close(); throw copyReadNotReady(); }
}
