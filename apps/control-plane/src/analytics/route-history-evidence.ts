import { assertAnalyticsReadSnapshot } from "./ingestion-read-snapshot.js";
import { and, asc, desc, eq, gte, inArray, lt, lte, sql, or } from "drizzle-orm";
import type { Db, Executor } from "../db/db.js";
import type { RequestContext } from "../auth/auth.js";
import { audit } from "../audit/audit.js";
import { analyticsRouteHistory as history, analyticsRouteHistoryRoutes as routes, analyticsRouteHistoryVisibility as visibility } from "../db/schema.js";
import { readClusterHistory } from "./cluster-history.js";
import { readRouteHistory } from "./route-history-ledger.js";
import type { RevisionRef, RouteHistoryEvidence } from "./route-history-v2.js";
const refKey = (r: RevisionRef) => `${r.epoch}:${r.revision}`;
const stamp = (column: unknown) => sql<string> `to_char(${column} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
/** Separate transaction: observing a committed map is evidence only of CP visibility, never Kong delivery. */
export async function confirmRouteHistory(db: Db, ctx: RequestContext, key: RevisionRef & {
    instanceId: string;
}): Promise<void> {
    await db.transaction(async (tx) => {
        const [h] = await tx.select().from(history).where(and(eq(history.instanceId, key.instanceId), eq(history.epoch, key.epoch), eq(history.revision, key.revision)));
        if (!h)
            throw Error("Route history is not committed");
        // Read/check the immutable map before recording its observation; a failed observation leaves no marker/audit.
        await readRouteHistory(tx, key.instanceId, { ref: key });
        const inserted = await tx.insert(visibility).values({ instanceId: key.instanceId, epoch: key.epoch, revision: key.revision }).onConflictDoNothing().returning();
        if (inserted.length)
            await audit(tx, ctx, { action: "analytics.route-history.observe", entityType: "deployment", entityId: refKey(key), after: { instanceId: key.instanceId, evidence: "control-plane-post-commit" } });
    });
}
export interface HistoryWindow {
    from: string;
    to: string;
    routeIds: readonly string[];
    clusterIds?: readonly string[];
}
/** Both immutable ledgers are read in the same read-only snapshot; absent authorization stays absent. */
export async function routeHistoryEvidence(db: Db, instanceId: string, window: HistoryWindow): Promise<RouteHistoryEvidence> {
    const from = Date.parse(window.from), to = Date.parse(window.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || to - from > 7 * 86400000 || window.routeIds.length > 200 || (window.clusterIds?.length ?? 0) > 200)
        throw Error("Invalid route history window");
    return db.transaction(tx=>routeHistoryEvidenceSnapshot(tx,instanceId,window),{isolationLevel:"repeatable read",accessMode:"read only"});
}
/** Both ledgers participate in the caller's existing read-only snapshot. */
export async function routeHistoryEvidenceSnapshot(tx:Executor,instanceId:string,window:HistoryWindow):Promise<RouteHistoryEvidence>{
    await assertAnalyticsReadSnapshot(tx);
    const from=Date.parse(window.from),to=Date.parse(window.to);
    if(!Number.isFinite(from)||!Number.isFinite(to)||from>=to||to-from>7*86400000||window.routeIds.length>200||(window.clusterIds?.length??0)>200)throw Error("Invalid route history window");
        await tx.execute(sql `set local statement_timeout='5s'`);
        const clock = (await tx.execute<{
            asOf: string;
        }>(sql `select to_char(transaction_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "asOf"`)).rows[0]!;
        const base = eq(history.instanceId, instanceId);
        const [latest] = await tx.select().from(history).where(base).orderBy(desc(history.epoch), desc(history.revision)).limit(1);
        const [genesis] = await tx.select({ epoch: history.epoch, revision: history.revision, recordedAt: stamp(history.recordedAt) }).from(history).where(and(base, eq(history.genesis, true))).limit(1);
        const selected = await tx.select().from(history).where(and(base, gte(history.recordedAt, window.from), lt(history.recordedAt, window.to))).orderBy(asc(history.epoch), asc(history.revision)).limit(1001);
        if (selected.length > 1000)
            throw Error("Route history revision budget exceeded");
        const [anchor] = await tx.select().from(history).where(and(base, lt(history.recordedAt, window.from))).orderBy(desc(history.epoch), desc(history.revision)).limit(1);
        const rows = new Map(selected.map(h => [refKey(h), h]));
        if (anchor)
            rows.set(refKey(anchor), anchor);
        // At most two extra references: previous candidate and its cross-epoch bridge. Never load all maps.
        let first = [...rows.values()].sort((a, b) => a.epoch - b.epoch || a.revision - b.revision)[0];
        for (let n = 0; n < 2 && first?.previous; n++) {
            const p = first.previous;
            if (rows.has(refKey(p)))
                break;
            const [prior] = await tx.select().from(history).where(and(base, eq(history.epoch, p.epoch), eq(history.revision, p.revision)));
            if (!prior)
                break;
            rows.set(refKey(prior), prior);
            if (!prior.previous || prior.previous.epoch === prior.epoch)
                break;
            first = prior;
        }
        const refs = [...rows.values()];
        const maps = await readRouteHistory(tx, instanceId, { refs, limit: 1004 });
        const markers = await tx.select({ epoch: visibility.epoch, revision: visibility.revision, visibleAt: stamp(visibility.observedAt) }).from(visibility).where(and(eq(visibility.instanceId, instanceId), lte(visibility.observedAt, clock!.asOf), refs.length ? or(...refs.map(r => and(eq(visibility.epoch, r.epoch), eq(visibility.revision, r.revision)))) : sql `false`)).limit(1005);
        const seen = new Map(markers.map(m => [refKey(m), m.visibleAt]));
        const requested = [...new Set(window.routeIds)];
        const owners = requested.length ? await tx.selectDistinct({ routeId: routes.routeId, workspaceId: routes.workspaceId }).from(routes).where(and(eq(routes.instanceId, instanceId), inArray(routes.routeId, requested))).limit(10001) : [];
        if (owners.length > 10000)
            throw Error("Route identity budget exceeded");
        const clusterHistory = await readClusterHistory(tx, window.clusterIds ?? [], window);
        const complete = latest?.chainComplete === true && maps.length === refs.length && refs.every(h => seen.has(refKey(h)) && h.chainComplete);
        return { instanceId, asOf: clock!.asOf, revisionsComplete: complete, firstRevision: genesis ?? null,
            revisions: maps.filter(m => seen.has(refKey(m))).map(m => ({ ...m, complete: true, visibleAt: seen.get(refKey(m))! })),
            identities: requested.map(routeId => ({ routeId, workspaceIds: owners.filter(x => x.routeId === routeId).map(x => x.workspaceId).sort(), complete: latest?.chainComplete === true })), clusterHistory };
}
