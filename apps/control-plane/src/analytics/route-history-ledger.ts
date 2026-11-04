import { and, asc, eq, sql, or, getTableColumns } from "drizzle-orm";
import type { Db, Tx } from "../db/db.js";
import { analyticsRouteHistory as headers, analyticsRouteHistoryRoutes as entries } from "../db/schema.js";
import { audit } from "../audit/audit.js";
import type { RequestContext } from "../auth/auth.js";
import type { RevisionRef, RouteHistoryRevision } from "./route-history-v2.js";
export interface RouteHistoryRecord extends RevisionRef {
    instanceId: string;
    recordedAt: string;
    previous: RevisionRef | null;
    genesis: boolean;
    reason: RouteHistoryRevision["reason"];
    rollbackOf: RevisionRef | null;
    configHash: string;
    routes: RouteHistoryRevision["routes"];
}
const sameRef = (a: RevisionRef | null, b: RevisionRef | null) => a?.epoch === b?.epoch && a?.revision === b?.revision;
const before = (a: RevisionRef, b: RevisionRef) => a.epoch < b.epoch || (a.epoch === b.epoch && a.revision < b.revision);
const keyWhere = (v: RevisionRef & {
    instanceId: string;
}) => and(eq(headers.instanceId, v.instanceId), eq(headers.epoch, v.epoch), eq(headers.revision, v.revision));
const routesOf = (v: RouteHistoryRecord) => [...v.routes].map(r => ({ routeId: r.routeId, workspaceId: r.workspaceId, serviceId: r.serviceId, releaseVersion: r.releaseVersion })).sort((a, b) => a.routeId.localeCompare(b.routeId));
const instantKey = (v: string) => { const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(v); if (!m || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0, 19) !== m[1])
    throw Error("Invalid route history timestamp"); return m[1] + "." + (m[2] ?? "").padEnd(6, "0") + "Z"; };
const canonical = (v: RouteHistoryRecord) => JSON.stringify([v.instanceId, v.epoch, v.revision, instantKey(v.recordedAt), v.previous && [v.previous.epoch, v.previous.revision], v.genesis, v.reason, v.rollbackOf && [v.rollbackOf.epoch, v.rollbackOf.revision], v.configHash, routesOf(v)]);
/** Caller owns the transaction, including deployment and audit. No external calls or independent commit. */
export async function appendRouteHistory(tx: Tx, ctx: RequestContext, v: RouteHistoryRecord): Promise<void> {
    instantKey(v.recordedAt);
    const validRef = (r: RevisionRef) => [r.epoch, r.revision].every(x => Number.isSafeInteger(x) && x > 0);
    if (![v.epoch, v.revision].every(x => Number.isSafeInteger(x) && x > 0) || !Number.isFinite(Date.parse(v.recordedAt)) ||
        (v.previous !== null && (!validRef(v.previous) || !before(v.previous, v))) ||
        (v.genesis && (v.previous !== null || v.epoch !== 1 || v.revision !== 1)) ||
        ((v.reason === "rollback") !== (v.rollbackOf !== null)) ||
        (v.rollbackOf !== null && (!validRef(v.rollbackOf) || !before(v.rollbackOf, v))) || new Set(v.routes.map(r => r.routeId)).size !== v.routes.length)
        throw Error("Invalid route history provenance");
    // Deployment writers already hold the lease; every ledger writer takes this lock in the same order.
    await tx.execute(sql `select pg_advisory_xact_lock(hashtextextended(${v.instanceId}, 1602))`);
    const existing = await readRouteHistory(tx, v.instanceId, { ref: v });
    if (existing.length) {
        if (canonical(existing[0]!) !== canonical(v))
            throw Error("Route history revision conflict");
        return;
    }
    if (v.rollbackOf) {
        const [target] = await readRouteHistory(tx, v.instanceId, { ref: v.rollbackOf });
        if (!target || JSON.stringify(routesOf(target)) !== JSON.stringify(routesOf(v)))
            throw Error("Rollback target history is missing or inconsistent");
    }
    const [previous] = v.previous ? await tx.select().from(headers).where(keyWhere({ ...v.previous, instanceId: v.instanceId })) : [];
    if (previous && (await tx.execute(sql `select ${previous.recordedAt}::timestamptz > ${v.recordedAt}::timestamptz as backwards`)).rows[0]?.backwards)
        throw Error("Route history clock moved backwards");
    const [latest] = await tx.select().from(headers).where(eq(headers.instanceId, v.instanceId)).orderBy(sql `${headers.epoch} desc`, sql `${headers.revision} desc`).limit(1);
    if (latest && (await tx.execute(sql`select ${latest.recordedAt}::timestamptz > ${v.recordedAt}::timestamptz as backwards`)).rows[0]?.backwards)
        throw Error("Route history clock moved backwards");
    if (latest && (!before(latest, v) || (v.previous && before(v.previous, latest)) || !v.previous))
        throw Error("Route history predecessor conflict");
    await tx.insert(headers).values({ instanceId: v.instanceId, epoch: v.epoch, revision: v.revision, recordedAt: v.recordedAt, previous: v.previous, genesis: v.genesis, reason: v.reason, rollbackOf: v.rollbackOf, configHash: v.configHash, routeCount: v.routes.length });
    if (v.routes.length)
        await tx.execute(sql `insert into analytics_route_history_routes(instance_id,epoch,revision,route_id,workspace_id,service_id,release_version)
    select ${v.instanceId}::uuid,${v.epoch},${v.revision},r."routeId",r."workspaceId",r."serviceId",r."releaseVersion"
    from jsonb_to_recordset(${JSON.stringify(routesOf(v))}::jsonb) as r("routeId" uuid,"workspaceId" uuid,"serviceId" uuid,"releaseVersion" integer)`);
    await audit(tx, ctx, { action: "analytics.route-history.record", entityType: "deployment", entityId: `${v.epoch}:${v.revision}`, after: { instanceId: v.instanceId, routeCount: v.routes.length, configHash: v.configHash } });
}
/** Explicit finite bound; callers requiring a longer history must fail closed, never silently certify this prefix. */
export async function readRouteHistory(db: Db | Tx, instanceId: string, options: {
    ref?: RevisionRef;
    limit?: number;
} = {}): Promise<RouteHistoryRecord[]> {
    const limit = options.limit ?? 1000;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000)
        throw Error("Invalid route history limit");
    const rows = await db.select({ ...getTableColumns(headers), recordedAt: sql<string> `to_char(${headers.recordedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` }).from(headers).where(options.ref ? keyWhere({ ...options.ref, instanceId }) : eq(headers.instanceId, instanceId)).orderBy(asc(headers.epoch), asc(headers.revision)).limit(limit + 1);
    if (rows.length > limit)
        throw Error("Route history budget exceeded");
    if (!rows.length)
        return [];
    const all = await db.select().from(entries).where(and(eq(entries.instanceId, instanceId), or(...rows.map(h => and(eq(entries.epoch, h.epoch), eq(entries.revision, h.revision)))))).orderBy(asc(entries.routeId)).limit(100001);
    if (all.length > 100000)
        throw Error("Route history map budget exceeded");
    return rows.map(h => {
        const routes = all.filter(r => r.epoch === h.epoch && r.revision === h.revision).map(({ routeId, workspaceId, serviceId, releaseVersion }) => ({ routeId, workspaceId, serviceId, releaseVersion }));
        if (routes.length !== h.routeCount)
            throw Error("Incomplete route history map");
        return { instanceId, epoch: h.epoch, revision: h.revision, recordedAt: h.recordedAt, previous: h.previous, genesis: h.genesis, reason: h.reason as RouteHistoryRevision["reason"], rollbackOf: h.rollbackOf, configHash: h.configHash, routes };
    });
}
