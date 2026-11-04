import { afterAll, beforeAll, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { clusterHistoryFixture } from "./cluster-history-fixtures.js";
import { authorizeClusterDelivery, revokeClusterAssociation, confirmClusterAssociation, readClusterHistory } from "../../src/analytics/cluster-history.js";
const admin = { actor: { type: "system" as const, id: "synthetic-fixture-administrator" }, role: "admin" as const, ip: null };
let f: Awaited<ReturnType<typeof clusterHistoryFixture>>;
beforeAll(async () => {
    f = await clusterHistoryFixture();
    const clock = (await f.h.sql.query<{
        now: Date;
    }>("select clock_timestamp() as now")).rows[0]!.now;
    window = { from: new Date(clock.getTime() - 86400000).toISOString(), to: new Date(clock.getTime() + 86400000).toISOString(), asOf: new Date(clock.getTime() + 86400000).toISOString() };
}, 180000);
afterAll(async () => f?.close());
let window = { from: "2026-01-01T00:00:00Z", to: "2027-01-01T00:00:00Z", asOf: "2027-01-01T00:00:00Z" };
const history = (ids: readonly string[]) => f.db.transaction(tx => readClusterHistory(tx, ids, window), { isolationLevel: "repeatable read", accessMode: "read only" });
const fixture = async () => {
    const c = await f.registered();
    const id = await f.db.transaction(tx => authorizeClusterDelivery(tx, c.ctx, c.source));
    return { ...c, id };
};
it("records only a concrete authorized-delivery source and post-commit confirmation", async () => {
    const c = await fixture();
    expect(await history([c.source.clusterId])).toEqual([]);
    await confirmClusterAssociation(f.db, c.id);
    expect(await history([c.source.clusterId])).toEqual([{ clusterId: c.source.clusterId, instanceId: f.instanceId, validFrom: expect.any(String), validUntil: null, trusted: true }]);
});
it("keeps an unknown cluster unknown", async () => {
    expect(await history(["00000000-0000-4000-8000-000000000001"])).toEqual([]);
});
it("refuses a mismatching authenticated node identity", async () => {
    const c = await f.registered();
    await expect(f.db.transaction(tx => authorizeClusterDelivery(tx, { ...c.ctx, actor: { type: "agent", id: "another-node" } }, c.source))).rejects.toThrow();
});
it("does not infer authorization from current v2 state or heartbeat", async () => {
    const c = await f.registered();
    expect(await history([c.source.clusterId])).toEqual([]);
    await expect(f.db.transaction(tx => authorizeClusterDelivery(tx, admin, c.source))).rejects.toThrow();
});
it("refuses a foreign instance or unknown deployment source", async () => {
    const c = await f.registered();
    await expect(f.db.transaction(tx => authorizeClusterDelivery(tx, c.ctx, { ...c.source, instanceId: "00000000-0000-4000-8000-000000000001" }))).rejects.toThrow();
    await expect(f.db.transaction(tx => authorizeClusterDelivery(tx, c.ctx, { ...c.source, revision: 999 }))).rejects.toThrow();
});
it("refuses a v1 cluster and a mismatching configuration hash", async () => {
    const c = await f.registered("v1");
    await expect(f.db.transaction(tx => authorizeClusterDelivery(tx, c.ctx, c.source))).rejects.toThrow();
    const d = await f.registered();
    await expect(f.db.transaction(tx => authorizeClusterDelivery(tx, d.ctx, { ...d.source, configHash: `sha256:${"0".repeat(64)}` }))).rejects.toThrow();
});
it("repeats identical authorization idempotently without moving its origin", async () => {
    const c = await fixture();
    const second = await f.db.transaction(tx => authorizeClusterDelivery(tx, c.ctx, c.source));
    expect(second).toBe(c.id);
    await confirmClusterAssociation(f.db, c.id);
    const a = await history([c.source.clusterId]);
    await confirmClusterAssociation(f.db, c.id);
    expect(await history([c.source.clusterId])).toEqual(a);
});
it("rolls back an authorization before commit", async () => {
    const c = await f.registered();
    await expect(f.db.transaction(async (tx) => {
        await authorizeClusterDelivery(tx, c.ctx, c.source);
        throw Error("injected abort");
    })).rejects.toThrow("injected abort");
    expect(await history([c.source.clusterId])).toEqual([]);
    expect((await f.h.sql.query<{
        n: number;
    }>("select count(*)::int as n from analytics_cluster_events where cluster_id=$1", [c.source.clusterId])).rows[0]?.n).toBe(0);
});
it("does not confirm inside the creating transaction", async () => {
    const c = await f.registered();
    await expect(f.db.transaction(async (tx) => {
        const id = await authorizeClusterDelivery(tx, c.ctx, c.source);
        await tx.execute(sql `insert into analytics_cluster_visibility(authorization_id) values(${id})`);
    })).rejects.toThrow();
});
it("serializes concurrent replicas authorizing one cluster", async () => {
    const c = await f.registered();
    const ids = await Promise.all([f.db.transaction(tx => authorizeClusterDelivery(tx, c.ctx, c.source)), f.db.transaction(tx => authorizeClusterDelivery(tx, c.ctx, c.source))]);
    expect(new Set(ids).size).toBe(1);
});
it("preserves a revoked interval for delayed historical events", async () => {
    const c = await fixture();
    await confirmClusterAssociation(f.db, c.id);
    await f.db.transaction(tx => revokeClusterAssociation(tx, admin, c.source.clusterId, "revoke"));
    const rows = await history([c.source.clusterId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.validUntil).not.toBeNull();
    expect(rows[0]?.trusted).toBe(true);
});
it("repeats revocation idempotently and records a fresh interval on reauthorization", async () => {
    const c = await fixture();
    await confirmClusterAssociation(f.db, c.id);
    await f.db.transaction(tx => revokeClusterAssociation(tx, admin, c.source.clusterId, "revoke"));
    await f.db.transaction(tx => revokeClusterAssociation(tx, admin, c.source.clusterId, "revoke"));
    const id = await f.db.transaction(tx => authorizeClusterDelivery(tx, c.ctx, c.source));
    expect(id).not.toBe(c.id);
    await confirmClusterAssociation(f.db, id);
    const rows = await history([c.source.clusterId]);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.validUntil).not.toBeNull();
    expect(rows[1]?.validUntil).toBeNull();
});
it("keeps an unconfirmed registration incomplete", async () => {
    const c = await fixture();
    expect(await history([c.source.clusterId])).toEqual([]);
});
it("does not overwrite or truncate association facts", async () => {
    const c = await fixture();
    await expect(f.db.execute(sql `update analytics_cluster_events set complete=false where id=${c.id}`)).rejects.toThrow();
    await expect(f.db.execute(sql `delete from analytics_cluster_events where id=${c.id}`)).rejects.toThrow();
    await expect(f.db.execute(sql `truncate analytics_cluster_events cascade`)).rejects.toThrow();
});
it("retains a terminal deletion tombstone and refuses identity reuse", async () => {
    const c = await fixture();
    await confirmClusterAssociation(f.db, c.id);
    await f.db.transaction(tx => revokeClusterAssociation(tx, admin, c.source.clusterId, "delete"));
    await expect(f.db.transaction(tx => authorizeClusterDelivery(tx, c.ctx, c.source))).rejects.toThrow();
    expect((await history([c.source.clusterId]))[0]?.validUntil).not.toBeNull();
});
it("does not turn a failed revocation into a closed interval", async () => {
    const c = await fixture();
    await confirmClusterAssociation(f.db, c.id);
    await expect(f.db.transaction(async (tx) => {
        await revokeClusterAssociation(tx, admin, c.source.clusterId, "revoke");
        throw Error("abort");
    })).rejects.toThrow();
    expect((await history([c.source.clusterId]))[0]?.validUntil).toBeNull();
});
it("rejects a different cluster's registered node as identity", async () => {
    const a = await f.registered(), b = await f.registered();
    await expect(f.db.transaction(tx => authorizeClusterDelivery(tx, b.ctx, { ...a.source, nodeId: b.source.nodeId }))).rejects.toThrow();
});
it("does not accept overlapping authorizations with a conflicting source identity", async () => {
    const c = await fixture();
    await expect(f.db.transaction(tx => authorizeClusterDelivery(tx, c.ctx, { ...c.source, instanceId: "00000000-0000-4000-8000-000000000002" }))).rejects.toThrow();
    await confirmClusterAssociation(f.db, c.id);
    expect(await history([c.source.clusterId])).toHaveLength(1);
});
it("preserves a prospective gap instead of inventing association before confirmation", async () => {
    const c = await fixture();
    await confirmClusterAssociation(f.db, c.id);
    const row = (await history([c.source.clusterId]))[0]!;
    expect(await f.db.transaction(tx => readClusterHistory(tx, [c.source.clusterId], { ...window, to: row.validFrom }), { isolationLevel: "repeatable read", accessMode: "read only" })).toEqual([]);
});
it("limits history requests explicitly", async () => {
    await expect(history(Array(201).fill("00000000-0000-4000-8000-000000000001"))).rejects.toThrow();
});
it("captures an actual authenticated delivery decision, never an invalid bearer", async () => {
    const c = await f.registered();
    const denied = await fetch(`${f.base}/agent/v2/deployments/current`, { headers: { authorization: "Bearer invalid-fixture-token" } });
    expect(denied.status).toBe(401);
    expect(await history([c.source.clusterId])).toEqual([]);
    const accepted = await fetch(`${f.base}/agent/v2/deployments/current`, { headers: { authorization: `Bearer ${c.token}` } });
    expect(accepted.status).toBe(200);
    const rows = await history([c.source.clusterId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.instanceId).toBe(f.instanceId);
    expect(rows[0]?.trusted).toBe(true);
});
it("records terminal revocation in the actual cluster deletion transaction", async () => {
    const c = await f.registered();
    const delivered = await fetch(`${f.base}/agent/v2/deployments/current`, { headers: { authorization: `Bearer ${c.token}` } });
    expect(delivered.status).toBe(200);
    expect((await f.h.api("DELETE", `/clusters/${c.source.clusterId}`)).status).toBe(204);
    const rows = await history([c.source.clusterId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.validUntil).not.toBeNull();
    expect((await f.h.sql.query<{
        operation: string;
    }>("select operation from analytics_cluster_events where cluster_id=$1 order by sequence desc limit 1", [c.source.clusterId])).rows[0]?.operation).toBe("delete");
});
it("binds the source to actual bearer possession rather than a declared actor/node id", async () => {
    const c = await f.registered();
    await expect(f.db.transaction(tx => authorizeClusterDelivery(tx, c.ctx, { ...c.source, nodeToken: "invalid-synthetic-bearer" }))).rejects.toThrow();
});
it("omits a period revoked before its first post-commit observation", async () => {
    const c = await fixture();
    await f.db.transaction(tx => revokeClusterAssociation(tx, admin, c.source.clusterId, "revoke"));
    await confirmClusterAssociation(f.db, c.id);
    expect(await history([c.source.clusterId])).toEqual([]);
    const id = await f.db.transaction(tx => authorizeClusterDelivery(tx, c.ctx, c.source));
    await confirmClusterAssociation(f.db, id);
    expect(await history([c.source.clusterId])).toHaveLength(1);
});
it("rejects a raw overlapping authorization through the database guard", async () => {
    const c = await fixture();
    await expect(f.db.execute(sql `insert into analytics_cluster_events(instance_id,cluster_id,sequence,previous_event_id,operation,source_node_id,source_epoch,source_revision,config_hash,provenance,actor,complete) select instance_id,cluster_id,sequence+1,id,operation,source_node_id,source_epoch,source_revision,config_hash,provenance,actor,complete from analytics_cluster_events where id=${c.id}`)).rejects.toThrow();
});
it("does not store authentication material in history or its audit", async () => {
    const c = await fixture();
    await confirmClusterAssociation(f.db, c.id);
    const rows = (await f.h.sql.query("select to_jsonb(e) as event from analytics_cluster_events e where cluster_id=$1", [c.source.clusterId])).rows;
    const audits = (await f.h.sql.query("select after from audit_events where entity_type='cluster-association' and entity_id=$1", [c.id])).rows;
    expect(JSON.stringify([rows, audits])).not.toContain(c.token);
});
it("requires a read-only coherent snapshot rather than a sequence of READ COMMITTED lookups", async () => {
    await expect(f.db.transaction(tx => readClusterHistory(tx, ["00000000-0000-4000-8000-000000000001"], window))).rejects.toThrow(/snapshot/i);
});
it("rejects another cluster's bearer even when node identifiers have the same text", async () => {
    const a = await f.registered(), b = await f.registered();
    await f.h.sql.query("update cluster_nodes set node_id=$2 where cluster_id=$1", [b.source.clusterId, a.source.nodeId]);
    await expect(f.db.transaction(tx => authorizeClusterDelivery(tx, a.ctx, { ...a.source, nodeToken: b.token }))).rejects.toThrow();
});
