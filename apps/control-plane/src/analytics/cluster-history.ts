import { createHash } from "node:crypto";
import { ProblemException } from "../common/problem.js";
import { and, asc, desc, eq, getTableColumns, inArray, isNotNull, lt, lte, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db, Tx, Executor } from "../db/db.js";
import type { RequestContext } from "../auth/auth.js";
import { audit } from "../audit/audit.js";
import { analyticsClusterEvents as events, analyticsClusterVisibility as visibility, clusters, clusterNodes, deployments, instance } from "../db/schema.js";
import type { RouteHistoryEvidence } from "./route-history-v2.js";
const stamp = (column: unknown) => sql<string> `to_char(${column} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const clock = async (tx: Tx) => (await tx.execute<{
    now: string;
}>(sql `select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as now`)).rows[0]!.now;
const latest = async (tx: Tx, clusterId: string) => (await tx.select().from(events).where(eq(events.clusterId, clusterId)).orderBy(desc(events.sequence)).limit(1))[0];
const system: RequestContext = { actor: { type: "system", id: "analytics-cluster-observer" }, role: "viewer", ip: null };
export interface ClusterDeliverySource {
    readonly instanceId: string;
    readonly clusterId: string;
    readonly nodeId: string;
    readonly nodeToken: string;
    readonly epoch: number;
    readonly revision: number;
    readonly configHash: string;
}
async function temporalComplete(tx: Tx, previous: typeof events.$inferSelect | undefined, now: string): Promise<boolean> {
    if (!previous)
        return true;
    if (!previous.complete)
        return false;
    const auth = previous.operation === "authorize" ? previous.id : previous.authorizationId;
    const [marker] = auth ? await tx.select().from(visibility).where(eq(visibility.authorizationId, auth)) : [];
    const row = (await tx.execute<{
        ok: boolean;
    }>(sql `select ${now}::timestamptz >= ${previous.recordedAt}::timestamptz and (${marker?.observedAt ?? null}::timestamptz is null or ${now}::timestamptz >= ${marker?.observedAt ?? null}::timestamptz) as ok`)).rows[0];
    return row?.ok === true;
}
/** Only called after the existing bearer/protocol gates authorize current v2 delivery; not a registration/heartbeat hook. */
export async function authorizeClusterDelivery(tx: Tx, ctx: RequestContext, source: ClusterDeliverySource): Promise<string> {
    if (ctx.actor.type !== "agent" || ctx.actor.id !== source.nodeId)
        throw Error("Cluster authorization requires an authenticated delivery identity");
    const [cluster] = await tx.select().from(clusters).where(eq(clusters.id, source.clusterId)).for("update");
    if (typeof source.nodeToken !== "string" || !source.nodeToken)
        throw new ProblemException(401, "Missing, invalid or revoked agent token");
    // Same bearer hash as AgentGateway; transient validation only, never persisted in the ledger or audit.
    const credentialHash = createHash("sha256").update(source.nodeToken).digest("hex");
    const [node] = await tx.select().from(clusterNodes).where(and(eq(clusterNodes.clusterId, source.clusterId), eq(clusterNodes.nodeId, source.nodeId), eq(clusterNodes.tokenHash, credentialHash)));
    if (!node)
        throw new ProblemException(401, "Missing, invalid or revoked agent token");
    const [self] = await tx.select().from(instance);
    const [deployment] = await tx.select().from(deployments).orderBy(desc(deployments.epoch), desc(deployments.revision)).limit(1);
    if (!cluster || cluster.deliveryProtocol !== "v2" || !node || self?.id !== source.instanceId || !deployment || deployment.epoch !== source.epoch || deployment.revision !== source.revision || deployment.configHash !== source.configHash)
        throw Error("Cluster authorization source is missing or inconsistent");
    const previous = await latest(tx, source.clusterId);
    if (previous?.operation === "delete" || previous && previous.instanceId !== source.instanceId)
        throw Error("Cluster identity history conflicts with delivery");
    if (previous?.operation === "authorize")
        return previous.id;
    const now = await clock(tx);
    const [fact] = await tx.insert(events).values({ instanceId: source.instanceId, clusterId: source.clusterId, sequence: (previous?.sequence ?? 0) + 1, previousEventId: previous?.id ?? null, authorizationId: null, operation: "authorize", sourceNodeId: source.nodeId, sourceEpoch: source.epoch, sourceRevision: source.revision, configHash: source.configHash, provenance: "cp-authorized-v2-delivery", actor: ctx.actor, recordedAt: now, complete: await temporalComplete(tx, previous, now) }).returning();
    await audit(tx, ctx, { action: "analytics.cluster-history.authorize", entityType: "cluster-association", entityId: fact!.id, after: { clusterId: source.clusterId, instanceId: source.instanceId, sourceEpoch: source.epoch, sourceRevision: source.revision, provenance: "cp-authorized-v2-delivery" } });
    return fact!.id;
}
/** Same lifecycle transaction, before physical deletion. A terminal tombstone never permits UUID reuse. */
export async function revokeClusterAssociation(tx: Tx, ctx: RequestContext, clusterId: string, operation: "revoke" | "delete"): Promise<void> {
    if (ctx.actor.type === "agent")
        throw Error("Cluster lifecycle authorization is required");
    const [cluster] = await tx.select().from(clusters).where(eq(clusters.id, clusterId)).for("update");
    if (!cluster)
        throw Error("Cluster lifecycle source is missing");
    const [self] = await tx.select().from(instance);
    if (!self)
        return; // A v1-only CP has no instance identity: never invent one to populate Analytics.
    const previous = await latest(tx, clusterId);
    if (previous?.operation === "delete" || operation === "revoke" && (!previous || previous.operation === "revoke"))
        return;
    const now = await clock(tx);
    const [fact] = await tx.insert(events).values({ instanceId: self.id, clusterId, sequence: (previous?.sequence ?? 0) + 1, previousEventId: previous?.id ?? null, authorizationId: previous ? (previous.operation === "authorize" ? previous.id : previous.authorizationId) : null, operation, provenance: "cp-cluster-lifecycle", actor: ctx.actor, recordedAt: now, complete: !!previous && await temporalComplete(tx, previous, now) }).returning();
    await audit(tx, ctx, { action: "analytics.cluster-history." + operation, entityType: "cluster-association", entityId: fact!.id, after: { clusterId, instanceId: self.id, authorizationId: fact!.authorizationId } });
}
export async function confirmClusterAssociation(db: Db, authorizationId: string): Promise<void> {
    await db.transaction(async (tx) => {
        const [fact] = await tx.select().from(events).where(eq(events.id, authorizationId));
        if (!fact || fact.operation !== "authorize")
            throw Error("Committed cluster authorization is missing");
        const inserted = await tx.insert(visibility).values({ authorizationId }).onConflictDoNothing().returning();
        if (inserted.length)
            await audit(tx, system, { action: "analytics.cluster-history.observe", entityType: "cluster-association", entityId: authorizationId, after: { clusterId: fact.clusterId, instanceId: fact.instanceId, evidence: "post-commit-control-plane-observation" } });
    });
}
/** Caller supplies one coherent read transaction. Scope is requested Cluster IDs, not a current registry lookup. */
export async function readClusterHistory(tx: Executor, clusterIds: readonly string[], window: {
    from: string;
    to: string;
}): Promise<RouteHistoryEvidence["clusterHistory"]> {
    if (clusterIds.length > 200 || !Number.isFinite(Date.parse(window.from)) || !Number.isFinite(Date.parse(window.to)) || Date.parse(window.from) >= Date.parse(window.to) || Date.parse(window.to) - Date.parse(window.from) > 7 * 86400000)
        throw Error("Invalid cluster history window");
    const ids = [...new Set(clusterIds)];
    if (!ids.length)
        return [];
    const snapshot = (await tx.execute<{
        isolation: string;
        readOnly: string;
        asOf: string;
    }>(sql `select current_setting('transaction_isolation') as isolation,current_setting('transaction_read_only') as "readOnly",to_char(transaction_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "asOf"`)).rows[0]!;
    if (!["repeatable read", "serializable"].includes(snapshot.isolation) || snapshot.readOnly !== "on")
        throw Error("Cluster history requires a coherent read-only snapshot");
    const close = alias(events, "cluster_closures");
    const rows = await tx.select({ event: events, validFrom: stamp(visibility.observedAt) }).from(events).innerJoin(visibility, eq(visibility.authorizationId, events.id)).where(and(inArray(events.clusterId, ids), eq(events.operation, "authorize"), lt(visibility.observedAt, window.to), lte(visibility.observedAt, snapshot.asOf), notExists(tx.select({ id: close.id }).from(close).where(and(eq(close.authorizationId, events.id), lte(close.recordedAt, window.from)))))).orderBy(asc(events.clusterId), asc(events.sequence)).limit(1001);
    if (rows.length > 1000)
        throw Error("Cluster history budget exceeded");
    if (!rows.length)
        return [];
    const closures = await tx.select({ ...getTableColumns(events), recordedAt: stamp(events.recordedAt) }).from(events).where(and(inArray(events.authorizationId, rows.map(r => r.event.id)), isNotNull(events.authorizationId))).orderBy(asc(events.sequence)).limit(2001);
    if (closures.length > 2000)
        throw Error("Cluster closure budget exceeded");
    const heads = await tx.selectDistinctOn([events.clusterId], { clusterId: events.clusterId, complete: events.complete }).from(events).where(inArray(events.clusterId, ids)).orderBy(events.clusterId, desc(events.sequence));
    const complete = new Map(heads.map(h => [h.clusterId, h.complete]));
    return rows.flatMap(({ event, validFrom }) => {
        const ending = closures.find(c => c.authorizationId === event.id);
        // Both stamps are canonical UTC with six fractional digits. No eligible interval existed if observation was late.
        if (ending && ending.recordedAt <= validFrom)
            return [];
        return [{ clusterId: event.clusterId, instanceId: event.instanceId, validFrom, validUntil: ending?.recordedAt ?? null, trusted: event.complete && complete.get(event.clusterId) === true && (!ending || ending.complete) }];
    });
}
