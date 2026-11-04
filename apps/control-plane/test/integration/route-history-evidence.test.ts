import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, inject, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "../../src/db/db.js";
import { appendRouteHistory } from "../../src/analytics/route-history-ledger.js";
import { confirmRouteHistory, routeHistoryEvidence } from "../../src/analytics/route-history-evidence.js";
import { attributeRouteHistoryV2 } from "../../src/analytics/route-history-v2.js";
import { request } from "../../src/analytics/route-history-v2.fixtures.js";
const ctx = { actor: { type: "system" as const, id: "ledger-evidence-test" }, role: "admin" as const, ip: null };
let db: ReturnType<typeof createDb>["db"], pool: ReturnType<typeof createDb>["pool"];
beforeAll(() => {
    ({ db, pool } = createDb(inject("databaseUrl")));
});
afterAll(async () => pool?.end());
const route = { routeId: randomUUID(), workspaceId: randomUUID(), serviceId: randomUUID(), releaseVersion: 1 };
const record = (instanceId = randomUUID(), revision = 1) => ({ instanceId, epoch: 1, revision, recordedAt: `2026-01-01T00:00:0${revision}Z`, previous: revision === 1 ? null : { epoch: 1, revision: revision - 1 }, genesis: revision === 1, reason: "publish" as const, rollbackOf: null, configHash: `sha256:${"a".repeat(64)}`, routes: [route] });
const bounds = { from: "2026-01-01T00:00:00Z", to: "2026-01-02T00:00:00Z", routeIds: [route.routeId] };
const write = (v = record()) => db.transaction(tx => appendRouteHistory(tx, ctx, v));
it("does not certify a committed but unobserved revision", async () => {
    const v = record();
    await write(v);
    const e = await routeHistoryEvidence(db, v.instanceId, bounds);
    expect(e.revisionsComplete).toBe(false);
    expect(e.revisions).toEqual([]);
});
it("records a separate post-commit observation idempotently", async () => {
    const v = record();
    await write(v);
    await confirmRouteHistory(db, ctx, v);
    await confirmRouteHistory(db, ctx, v);
    const e = await routeHistoryEvidence(db, v.instanceId, bounds);
    expect(e.revisionsComplete).toBe(true);
    expect(e.revisions).toHaveLength(1);
    expect(e.revisions[0]?.visibleAt).not.toBe(e.revisions[0]?.recordedAt);
    expect(e.clusterHistory).toEqual([]);
});
it("refuses visibility produced in the creating transaction", async () => {
    const v = record();
    await expect(db.transaction(async (tx) => {
        await appendRouteHistory(tx, ctx, v);
        await tx.execute(sql `insert into analytics_route_history_visibility(instance_id,epoch,revision) values(${v.instanceId},1,1)`);
    })).rejects.toThrow();
});
it("leaves a missing predecessor or unknown genesis incomplete", async () => {
    const v = record(randomUUID(), 3);
    await write(v);
    await confirmRouteHistory(db, ctx, v);
    const e = await routeHistoryEvidence(db, v.instanceId, bounds);
    expect(e.revisionsComplete).toBe(false);
    const r = request({ environmentId: v.instanceId, routeId: route.routeId, ts: e.revisions[0]!.visibleAt });
    expect(attributeRouteHistoryV2({ ...e, clusterHistory: [{ clusterId: r.copies[0]!.content.clusterId, instanceId: v.instanceId, validFrom: v.recordedAt, validUntil: null, trusted: true }] }, r).reason).toBe("attribution-evidence-missing");
});
it("preserves ambiguity outside the selected revision window", async () => {
    const v = record();
    await write(v);
    await confirmRouteHistory(db, ctx, v);
    await write({ ...record(v.instanceId, 2), routes: [{ ...route, workspaceId: randomUUID() }] });
    await confirmRouteHistory(db, ctx, { ...v, revision: 2 });
    const e = await routeHistoryEvidence(db, v.instanceId, { ...bounds, from: "2026-01-01T00:00:02Z" });
    expect(e.identities[0]?.workspaceIds).toHaveLength(2);
    const r = request({ environmentId: v.instanceId, routeId: route.routeId, ts: e.revisions.at(-1)!.visibleAt });
    expect(attributeRouteHistoryV2({ ...e, clusterHistory: [{ clusterId: r.copies[0]!.content.clusterId, instanceId: v.instanceId, validFrom: v.recordedAt, validUntil: null, trusted: true }] }, r).reason).toBe("ambiguous-route");
});
it("uses persisted evidence with the pure policy, with explicit fixture-only cluster proof", async () => {
    const v = record();
    await write(v);
    await confirmRouteHistory(db, ctx, v);
    const e = await routeHistoryEvidence(db, v.instanceId, bounds);
    const observed = e.revisions[0]!.visibleAt;
    const r = request({ environmentId: v.instanceId, routeId: route.routeId, serviceId: route.serviceId, ts: observed });
    expect(attributeRouteHistoryV2(e, r).reason).toBe("unknown-cluster");
    const trusted = { ...e, clusterHistory: [{ clusterId: r.copies[0]!.content.clusterId, instanceId: v.instanceId, validFrom: v.recordedAt, validUntil: null, trusted: true }] };
    const result = attributeRouteHistoryV2(trusted, r);
    expect(result.workspaceId).toBe(route.workspaceId);
    expect(result.effectiveRevision).toBeNull();
    expect(attributeRouteHistoryV2(trusted, r)).toEqual(result);
});
it("does not retroactively attribute events before observation", async () => {
    const v = record();
    await write(v);
    await confirmRouteHistory(db, ctx, v);
    const e = await routeHistoryEvidence(db, v.instanceId, bounds);
    const r = request({ environmentId: v.instanceId, routeId: route.routeId, ts: v.recordedAt });
    expect(attributeRouteHistoryV2({ ...e, clusterHistory: [{ clusterId: r.copies[0]!.content.clusterId, instanceId: v.instanceId, validFrom: v.recordedAt, validUntil: null, trusted: true }] }, r).reason).toBe("attribution-evidence-missing");
});
it("rejects unbounded windows and route identity budgets", async () => {
    await expect(routeHistoryEvidence(db, randomUUID(), { ...bounds, to: "2026-02-01T00:00:00Z" })).rejects.toThrow();
    await expect(routeHistoryEvidence(db, randomUUID(), { ...bounds, routeIds: Array(201).fill(route.routeId) })).rejects.toThrow();
});
it("keeps a gap incomplete for every later revision and preserves its missing predecessor", async () => {
    const v = record(randomUUID(), 3);
    await write(v);
    await confirmRouteHistory(db, ctx, v);
    const next = { ...record(v.instanceId, 4), recordedAt: "2026-01-01T00:00:04Z" };
    await write(next);
    await confirmRouteHistory(db, ctx, next);
    const e = await routeHistoryEvidence(db, v.instanceId, bounds);
    expect(e.revisionsComplete).toBe(false);
    expect(e.revisions.at(-1)?.previous).toEqual({ epoch: 1, revision: 3 });
    expect(e.identities[0]?.complete).toBe(false);
});
it("retains an anchor and its cross-epoch bridge without loading older maps", async () => {
    const v = record();
    await write(v);
    await confirmRouteHistory(db, ctx, v);
    const second = { ...record(v.instanceId), epoch: 2, previous: { epoch: 1, revision: 1 }, genesis: false, recordedAt: "2026-01-01T00:00:02Z" };
    await write(second);
    await confirmRouteHistory(db, ctx, second);
    const third = { ...second, revision: 2, previous: { epoch: 2, revision: 1 }, recordedAt: "2026-01-01T00:00:03Z" };
    await write(third);
    await confirmRouteHistory(db, ctx, third);
    const e = await routeHistoryEvidence(db, v.instanceId, { ...bounds, from: "2026-01-01T00:00:04Z" });
    expect(e.revisions.map(x => [x.epoch, x.revision])).toEqual([[1, 1], [2, 1], [2, 2]]);
    expect(e.revisionsComplete).toBe(true);
});
it("retains exactly the predecessor anchor for an exact boundary", async () => {
    const v = record();
    for (let n = 1; n <= 4; n++) {
        const row = record(v.instanceId, n);
        await write(row);
        await confirmRouteHistory(db, ctx, row);
    }
    const e = await routeHistoryEvidence(db, v.instanceId, { ...bounds, from: "2026-01-01T00:00:04Z" });
    expect(e.revisions.map(x => x.revision)).toEqual([2, 3, 4]);
    expect(e.firstRevision?.revision).toBe(1);
});
it("keeps rollback history and effectiveRevision unknown through the database adapter", async () => {
    const v = record();
    await write(v);
    await confirmRouteHistory(db, ctx, v);
    await write({ ...record(v.instanceId, 2), routes: [] });
    await confirmRouteHistory(db, ctx, { ...v, revision: 2 });
    const rollback = { ...record(v.instanceId, 3), reason: "rollback" as const, rollbackOf: { epoch: 1, revision: 1 } };
    await db.transaction(tx => appendRouteHistory(tx, ctx, rollback));
    await confirmRouteHistory(db, ctx, rollback);
    const e = await routeHistoryEvidence(db, v.instanceId, bounds);
    expect(e.revisions.at(-1)?.rollbackOf).toEqual({ epoch: 1, revision: 1 });
    const r = request({ environmentId: v.instanceId, routeId: route.routeId, ts: e.revisions.at(-1)!.visibleAt });
    const result = attributeRouteHistoryV2({ ...e, clusterHistory: [{ clusterId: r.copies[0]!.content.clusterId, instanceId: v.instanceId, validFrom: v.recordedAt, validUntil: null, trusted: true }] }, r);
    expect(result.workspaceId).toBe(route.workspaceId);
    expect(result.effectiveRevision).toBeNull();
});
it("serializes duplicate confirmations without moving the first observation", async () => {
    const v = record();
    await write(v);
    await Promise.all([confirmRouteHistory(db, ctx, v), confirmRouteHistory(db, ctx, v)]);
    const a = await routeHistoryEvidence(db, v.instanceId, bounds);
    await confirmRouteHistory(db, ctx, v);
    const b = await routeHistoryEvidence(db, v.instanceId, bounds);
    expect(b.revisions[0]?.visibleAt).toBe(a.revisions[0]?.visibleAt);
});
it("cannot forge an earlier visibility timestamp", async () => {
    const v = record();
    await write(v);
    await db.execute(sql `insert into analytics_route_history_visibility(instance_id,epoch,revision,observed_at) values(${v.instanceId},1,1,'2000-01-01T00:00:00Z')`);
    const e = await routeHistoryEvidence(db, v.instanceId, bounds);
    expect(e.revisions[0]?.visibleAt).not.toBe("2000-01-01T00:00:00.000000Z");
    await expect(db.execute(sql `update analytics_route_history_visibility set observed_at='2000-01-01' where instance_id=${v.instanceId}`)).rejects.toThrow();
});
it("does not combine another instance's maps or identities", async () => {
    const a = record(), b = record();
    await write(a);
    await write({ ...b, routes: [{ ...route, workspaceId: randomUUID() }] });
    await confirmRouteHistory(db, ctx, a);
    const e = await routeHistoryEvidence(db, a.instanceId, bounds);
    expect(e.identities[0]?.workspaceIds).toEqual([route.workspaceId]);
    expect(e.revisions.every(x => x.routes.every(r => r.workspaceId === route.workspaceId))).toBe(true);
});
