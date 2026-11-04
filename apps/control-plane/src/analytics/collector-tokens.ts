import { eq, getTableColumns, sql } from "drizzle-orm";
import { audit } from "../audit/audit.js";
import type { Encryptor } from "../crypto/crypto.js";
import type { Executor, Tx } from "../db/db.js";
import { clusterNodes, clusters } from "../db/schema.js";

export interface CollectorTokenFingerprints {
  current: string;
  previous: string | null;
}

/** The wire digest is specified by the agent contract; only its server-keyed HMAC is persisted. */
export function collectorTokenEvidence(enc: Encryptor, value: CollectorTokenFingerprints | undefined) {
  if (!value) return null;
  const hash = (v: string) => enc.fingerprint(`gromesh-collector-fingerprint/v1\n${v}`);
  return {
    current: hash(value.current),
    previous: value.previous === null ? null : hash(value.previous),
    currentHint: value.current.slice(7, 15),
    previousHint: value.previous?.slice(7, 15) ?? null,
  };
}

export interface CollectorTokenState {
  shared: boolean;
  unverified: boolean;
  rotating: boolean;
  keyHints: string[];
}

export async function collectorTokenStates(tx: Executor): Promise<Map<string, CollectorTokenState>> {
  // Use the server's wall clock, including time spent waiting for the delivery lease.
  const nodes = await tx.select({
    ...getTableColumns(clusterNodes),
    evidenceFresh: sql<boolean>`${clusterNodes.collectorTokenReportedAt} >= statement_timestamp() - interval '45 seconds'`,
  }).from(clusterNodes).where(sql`${clusterNodes.lastSeenAt} >= statement_timestamp() - interval '45 seconds'`);
  const states = new Map<string, CollectorTokenState>();
  for (const n of nodes) {
    const own = states.get(n.clusterId) ?? { shared: false, unverified: false, rotating: false, keyHints: [] };
    states.set(n.clusterId, own);
    const a = n.collectorTokenEvidence;
    if (!a || !n.evidenceFresh) {
      own.unverified = true;
      continue;
    }
    for (const other of nodes) {
      if (other.clusterId === n.clusterId) continue;
      const b = other.collectorTokenEvidence;
      if (!b || !other.evidenceFresh) continue;
      if (a.current === b.current) {
        own.shared = true;
        own.keyHints.push(a.currentHint);
      }
      if (a.previous === b.current || a.current === b.previous || (a.previous !== null && a.previous === b.previous)) own.rotating = true;
    }
  }
  for (const state of states.values()) {
    state.rotating &&= !state.shared;
    state.keyHints = [...new Set(state.keyHints)].sort();
  }
  return states;
}

/** Caller holds deployment_lease first, as for every v2 status/activation, across all replicas. */
export async function reconcileCollectorTokens(tx: Tx) {
  const states = await collectorTokenStates(tx);
  const rows = await tx.select().from(clusters).orderBy(clusters.id);
  for (const cluster of rows) {
    const state = states.get(cluster.id);
    const shared = state?.shared ?? false;
    if (shared === cluster.collectorTokenShared) continue;
    await tx.update(clusters).set({ collectorTokenShared: shared }).where(eq(clusters.id, cluster.id));
    await audit(tx, { actor: { type: "system", id: "collector-tokens" }, ip: null, role: "viewer" }, {
      action: "cluster.collector-token-shared", entityType: "cluster", entityId: cluster.id,
      environmentId: cluster.environmentId,
      before: { shared: cluster.collectorTokenShared }, after: { shared, keyHints: state?.keyHints ?? [] },
    });
  }
  return states;
}
