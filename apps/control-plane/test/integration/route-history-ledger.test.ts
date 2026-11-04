import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inject } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "../../src/db/db.js";
import { appendRouteHistory, readRouteHistory } from "../../src/analytics/route-history-ledger.js";
const ctx = { actor: { type: "system" as const, id: "ledger-test" }, ip: null, role: "admin" as const };
const routeId = "00000000-0000-4000-8000-000000000001";
const workspaceId = "00000000-0000-4000-8000-000000000002";
const serviceId = "00000000-0000-4000-8000-000000000003";
const route = { routeId, workspaceId, serviceId, releaseVersion: 1 };
const ref = (revision: number) => ({ epoch: 1, revision });
const input = (instanceId = randomUUID(), revision = 1) => ({ instanceId, ...ref(revision), recordedAt: `2026-01-01T00:00:${String(revision).padStart(2, "0")}.000Z`, previous: revision === 1 ? null : ref(revision - 1), genesis: revision === 1, reason: "publish" as const, rollbackOf: null, configHash: `sha256:${"a".repeat(64)}`, routes: [route] });
let db: ReturnType<typeof createDb>["db"];
let pool: ReturnType<typeof createDb>["pool"];
beforeAll(() => { ({ db, pool } = createDb(inject("databaseUrl"))); });
afterAll(async () => { await pool?.end(); });
const save = (v = input()) => db.transaction(tx => appendRouteHistory(tx, ctx, v));
describe("transactional route history ledger", () => {
    it("persists a complete first revision and historical identity", async () => {
        const v = input();
        await save(v);
        const history = await readRouteHistory(db, v.instanceId);
        expect(history).toHaveLength(1);
        expect(history[0]?.routes).toEqual([route]);
        expect(history[0]?.genesis).toBe(true);
    });
    it("does not expose an aborted transaction", async () => {
        const v = input();
        await expect(db.transaction(async (tx) => { await appendRouteHistory(tx, ctx, v); throw Error("abort"); })).rejects.toThrow("abort");
        expect(await readRouteHistory(db, v.instanceId)).toEqual([]);
    });
    it("retries identical revisions idempotently and rejects conflicting maps", async () => {
        const v = input();
        await save(v);
        await save(v);
        await expect(save({ ...v, routes: [{ ...route, workspaceId: randomUUID() }] })).rejects.toThrow(/conflict/i);
        expect(await readRouteHistory(db, v.instanceId)).toHaveLength(1);
    });
    it("preserves predecessor, deleted routes and recreation identities", async () => {
        const v = input();
        await save(v);
        await save({ ...input(v.instanceId, 2), routes: [] });
        await save({ ...input(v.instanceId, 3), routes: [{ ...route, routeId: randomUUID() }] });
        const rows = await readRouteHistory(db, v.instanceId);
        expect(rows[1]?.previous).toEqual(ref(1));
        expect(rows[0]?.routes).toEqual([route]);
        expect(rows[1]?.routes).toEqual([]);
        expect(rows[2]?.routes[0]?.routeId).not.toBe(routeId);
    });
    it("allows missing history without manufacturing genesis", async () => {
        const v = { ...input(randomUUID(), 7), previous: ref(6) };
        await save(v);
        expect((await readRouteHistory(db, v.instanceId))[0]?.genesis).toBe(false);
    });
    it("retains reuse across Workspaces and service changes as historical facts", async () => {
        const v = input();
        await save(v);
        const newService = randomUUID();
        await save({ ...input(v.instanceId, 2), routes: [{ ...route, serviceId: newService }] });
        await save({ ...input(v.instanceId, 3), routes: [{ ...route, workspaceId: randomUUID() }] });
        const h = await readRouteHistory(db, v.instanceId);
        expect(h[1]?.routes[0]?.serviceId).toBe(newService);
        expect(new Set(h.flatMap(r => r.routes.map(x => x.workspaceId))).size).toBe(2);
    });
    it("creates a rollback revision and preserves its target", async () => {
        const v = input();
        await save(v);
        await save({ ...input(v.instanceId, 2), routes: [] });
        await db.transaction(tx => appendRouteHistory(tx, ctx, { ...input(v.instanceId, 3), reason: "rollback", rollbackOf: ref(1) }));
        const h = await readRouteHistory(db, v.instanceId);
        expect(h).toHaveLength(3);
        expect(h[2]?.rollbackOf).toEqual(ref(1));
        expect(h[0]?.routes).toEqual([route]);
    });
    it("rejects contradictory, future or missing rollback provenance", async () => {
        const v = input();
        await expect(db.transaction(tx => appendRouteHistory(tx, ctx, { ...v, rollbackOf: ref(1) }))).rejects.toThrow();
        await expect(db.transaction(tx => appendRouteHistory(tx, ctx, { ...v, reason: "rollback", rollbackOf: ref(2) }))).rejects.toThrow();
    });
    it("records a new epoch with an explicit predecessor", async () => {
        const v = input();
        await save(v);
        await save({ ...input(v.instanceId), epoch: 2, previous: ref(1), genesis: false });
        expect((await readRouteHistory(db, v.instanceId))[1]?.epoch).toBe(2);
    });
    it("serializes two replicas retrying the same revision", async () => {
        const v = input();
        await Promise.all([save(v), save(v)]);
        expect(await readRouteHistory(db, v.instanceId)).toHaveLength(1);
    });
    it("rejects concurrent conflicting revisions without choosing the last writer", async () => {
        const v = input();
        const outcomes = await Promise.allSettled([save(v), save({ ...v, routes: [] })]);
        expect(outcomes.filter(x => x.status === "fulfilled")).toHaveLength(1);
        expect(outcomes.filter(x => x.status === "rejected")).toHaveLength(1);
    });
    it("rejects duplicate Route IDs even inside a single map", async () => { await expect(save({ ...input(), routes: [route, route] })).rejects.toThrow(); });
    it("does not mutate or truncate committed rows", async () => {
        const v = input();
        await save(v);
        await expect(db.execute(sql `update analytics_route_history set route_count=0 where instance_id=${v.instanceId}`)).rejects.toThrow();
        await expect(db.execute(sql `delete from analytics_route_history where instance_id=${v.instanceId}`)).rejects.toThrow();
        await expect(db.execute(sql `truncate analytics_route_history_routes cascade`)).rejects.toThrow();
    });
    it("rejects adding entries to a committed map", async () => {
        const v = input();
        await save(v);
        await expect(db.execute(sql `insert into analytics_route_history_routes(instance_id,epoch,revision,route_id,workspace_id,service_id,release_version) values(${v.instanceId},1,1,${randomUUID()},${workspaceId},${serviceId},1)`)).rejects.toThrow();
    });
    it("rolls back header and audit when a route write fails", async () => {
        const v = { ...input(), routes: [{ ...route, serviceId: "not-a-uuid" }] };
        await expect(save(v)).rejects.toThrow();
        expect(await readRouteHistory(db, v.instanceId)).toEqual([]);
    });
    it("rejects a partial map at commit even without repository writes", async () => {
        const v = input();
        await expect(db.transaction(tx => tx.execute(sql `insert into analytics_route_history(instance_id,epoch,revision,recorded_at,genesis,reason,config_hash,route_count) values(${v.instanceId},1,1,${v.recordedAt},true,'publish',${v.configHash},1)`))).rejects.toThrow();
        expect(await readRouteHistory(db, v.instanceId)).toEqual([]);
    });
    it("checks completeness after constraints are made immediate", async () => {
        const v = input();
        await expect(db.transaction(async (tx) => {
            await appendRouteHistory(tx, ctx, { ...v, routes: [] });
            await tx.execute(sql `set constraints all immediate`);
            await tx.execute(sql `insert into analytics_route_history_routes(instance_id,epoch,revision,route_id,workspace_id,service_id,release_version) values(${v.instanceId},1,1,${routeId},${workspaceId},${serviceId},1)`);
        })).rejects.toThrow();
        expect(await readRouteHistory(db, v.instanceId)).toEqual([]);
    });
    it("preserves microsecond boundaries in stored and repeated inputs", async () => {
        const v = { ...input(), recordedAt: "2026-01-01T00:00:01.000001Z" };
        await save(v);
        await save(v);
        expect((await readRouteHistory(db, v.instanceId))[0]?.recordedAt).toBe(v.recordedAt);
        await expect(save({ ...v, recordedAt: "2026-01-01T00:00:01.000002Z" })).rejects.toThrow(/conflict/i);
    });
    it("rejects clock regression without losing submillisecond precision", async () => {
        const v = { ...input(), recordedAt: "2026-01-01T00:00:01.000002Z" };
        await save(v);
        await expect(save({ ...input(v.instanceId, 2), recordedAt: "2026-01-01T00:00:01.000001Z" })).rejects.toThrow(/backwards/i);
    });
    it("refuses missing rollback target and predecessor forks", async () => {
        const v = input();
        await save(v);
        await save(input(v.instanceId, 2));
        await expect(save({ ...input(v.instanceId, 3), previous: ref(1) })).rejects.toThrow(/predecessor/i);
        await expect(db.transaction(tx => appendRouteHistory(tx, ctx, { ...input(randomUUID(), 3), reason: "rollback", rollbackOf: ref(1) }))).rejects.toThrow(/missing/i);
    });
    it("is invariant under map input order", async () => {
        const v = { ...input(), routes: [route, { ...route, routeId: randomUUID() }] };
        await save(v);
        await save({ ...v, routes: [...v.routes].reverse() });
        expect((await readRouteHistory(db, v.instanceId))[0]?.routes).toHaveLength(2);
    });
    it("enforces explicit finite read budgets", async () => {
        const v = input();
        await save(v);
        await save(input(v.instanceId, 2));
        await expect(readRouteHistory(db, v.instanceId, { limit: 1 })).rejects.toThrow(/budget/i);
    });
    it("rejects a timestamp older than retained history when the named predecessor is missing", async () => {
        const v = { ...input(), recordedAt: "2026-01-01T00:00:10.000002Z" };
        await save(v);
        await expect(save({ ...input(v.instanceId, 3), recordedAt: "2026-01-01T00:00:10.000001Z" })).rejects.toThrow(/backwards/i);
        expect(await readRouteHistory(db, v.instanceId)).toHaveLength(1);
    });

    it("records rollback with a new Release version without restoring unrelated Workspace members", async () => {
        const v = input(); await save(v);
        const other = { ...route, routeId: randomUUID(), workspaceId: randomUUID(), serviceId: randomUUID(), releaseVersion: 2 };
        await save({ ...input(v.instanceId, 2), routes: [other] });
        await db.transaction(tx => appendRouteHistory(tx, ctx, { ...input(v.instanceId, 3), reason: "rollback", rollbackOf: ref(1), routes: [{ ...route, releaseVersion: 3 }, other] }));
        const history = await readRouteHistory(db, v.instanceId);
        expect(history[2]?.routes).toEqual(expect.arrayContaining([{ ...route, releaseVersion: 3 }, other]));
        expect(history[0]?.routes).toEqual([route]);
    });

});
