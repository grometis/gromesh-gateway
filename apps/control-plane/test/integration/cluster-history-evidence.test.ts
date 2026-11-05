import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { clusterHistoryFixture } from "./cluster-history-fixtures.js";
import { routeHistoryEvidence, confirmRouteHistory } from "../../src/analytics/route-history-evidence.js";
import { appendRouteHistory } from "../../src/analytics/route-history-ledger.js";
import { authorizeClusterDelivery, confirmClusterAssociation, revokeClusterAssociation } from "../../src/analytics/cluster-history.js";
import { attributeRouteHistoryV2 } from "../../src/analytics/route-history-v2.js";
import { request } from "../../src/analytics/route-history-v2.fixtures.js";

type Fixture = Awaited<ReturnType<typeof clusterHistoryFixture>>;
type Cluster = Awaited<ReturnType<Fixture["registered"]>>;
const ctx = { actor: { type: "system" as const, id: "synthetic-cluster-adapter-test" }, role: "admin" as const, ip: null };
async function withFixture(run: (f: Fixture) => Promise<void>) {
  const f = await clusterHistoryFixture();
  try { await run(f); } finally { await f.close(); }
}
async function evidence(f: Fixture, clusterIds: readonly string[], routeIds = [f.routeId, f.otherRouteId]) {
  const clock = (await f.h.sql.query<{ now: Date }>("select clock_timestamp() as now")).rows[0]!.now;
  return routeHistoryEvidence(f.db, f.instanceId, {
    from: new Date(clock.getTime() - 86400000).toISOString(), to: new Date(clock.getTime() + 86400000).toISOString(), routeIds, clusterIds,
  });
}
async function deliver(f: Fixture, c: Cluster) {
  expect((await fetch(`${f.base}/agent/v2/deployments/current`, { headers: { authorization: `Bearer ${c.token}` } })).status).toBe(200);
  const e = await evidence(f, [c.source.clusterId]);
  expect(e.clusterHistory).toHaveLength(1);
  return e;
}
// Explicit synthetic traffic: copiesComplete/provenance are fixture premises, never claims about today's Vector.
const event = (f: Fixture, c: Cluster, ts: string, routeId = f.routeId) => request({ environmentId: f.instanceId, clusterId: c.source.clusterId, routeId, ts, path: "/same" });
it("attributes persisted authorized history to two workspaces with identical paths", async () => withFixture(async f => {
  const c = await f.registered(), e = await deliver(f, c), ts = e.clusterHistory[0]!.validFrom;
  expect(attributeRouteHistoryV2(e, event(f, c, ts))).toMatchObject({ workspaceId: f.workspaceId, reason: null, effectiveRevision: null });
  expect(attributeRouteHistoryV2(e, event(f, c, ts, f.otherRouteId))).toMatchObject({ workspaceId: f.otherWorkspaceId, reason: null, effectiveRevision: null });
  expect(attributeRouteHistoryV2(e, event(f, c, ts))).toEqual(attributeRouteHistoryV2(e, event(f, c, ts)));
}));
it("does not upgrade current registration into historical authority", async () => withFixture(async f => {
  const c = await f.registered(), e = await evidence(f, [c.source.clusterId]);
  expect(e.clusterHistory).toEqual([]);
  expect(attributeRouteHistoryV2(e, event(f, c, e.revisions[0]!.visibleAt))).toMatchObject({ workspaceId: null, reason: "unknown-cluster" });
}));
it("does not attribute an event before the first authorized observation", async () => withFixture(async f => {
  const c = await f.registered(), e = await deliver(f, c);
  expect(attributeRouteHistoryV2(e, event(f, c, e.firstRevision!.recordedAt))).toMatchObject({ workspaceId: null, reason: "unknown-cluster" });
}));
it("retains late-event ownership after actual cluster deletion and excludes its exact end boundary", async () => withFixture(async f => {
  const c = await f.registered(), before = await deliver(f, c), ts = before.clusterHistory[0]!.validFrom;
  expect((await f.h.api("DELETE", `/clusters/${c.source.clusterId}`)).status).toBe(204);
  const e = await evidence(f, [c.source.clusterId]), end = e.clusterHistory[0]!.validUntil!;
  expect(end).not.toBeNull();
  expect(attributeRouteHistoryV2(e, event(f, c, ts))).toMatchObject({ workspaceId: f.workspaceId, effectiveRevision: null });
  expect(attributeRouteHistoryV2(e, event(f, c, end))).toMatchObject({ workspaceId: null, reason: "unknown-cluster" });
}));
it("keeps a revocation gap unknown and reauthorization prospective", async () => withFixture(async f => {
  const c = await f.registered(); await deliver(f, c);
  await f.db.transaction(tx => revokeClusterAssociation(tx, ctx, c.source.clusterId, "revoke"));
  const revoked = await evidence(f, [c.source.clusterId]), end = revoked.clusterHistory[0]!.validUntil!;
  const id = await f.db.transaction(tx => authorizeClusterDelivery(tx, c.ctx, c.source));
  await confirmClusterAssociation(f.db, id);
  const e = await evidence(f, [c.source.clusterId]);
  expect(e.clusterHistory).toHaveLength(2);
  expect(attributeRouteHistoryV2(e, event(f, c, end))).toMatchObject({ workspaceId: null, reason: "unknown-cluster" });
  expect(attributeRouteHistoryV2(e, event(f, c, e.clusterHistory[1]!.validFrom))).toMatchObject({ workspaceId: f.workspaceId, effectiveRevision: null });
}));
it("never substitutes another instance or an unrequested cluster", async () => withFixture(async f => {
  const c = await f.registered(), e = await deliver(f, c), r = event(f, c, e.clusterHistory[0]!.validFrom);
  expect(attributeRouteHistoryV2(e, { ...r, copies: r.copies.map(x => ({ ...x, content: { ...x.content, environmentId: randomUUID() } })) })).toMatchObject({ workspaceId: null, reason: "foreign-instance" });
  const empty = await evidence(f, []);
  expect(attributeRouteHistoryV2(empty, r)).toMatchObject({ workspaceId: null, reason: "unknown-cluster" });
}));
it("rejects conflicting identity authorization without replacing the confirmed interval", async () => withFixture(async f => {
  const c = await f.registered(); await deliver(f, c);
  await expect(f.db.transaction(tx => authorizeClusterDelivery(tx, c.ctx, { ...c.source, instanceId: randomUUID() }))).rejects.toThrow();
  const e = await evidence(f, [c.source.clusterId]);
  expect(e.clusterHistory).toHaveLength(1);
  expect(e.clusterHistory[0]!.instanceId).toBe(f.instanceId);
}));
it("does not turn invalid bearer or unobserved authorization into evidence", async () => withFixture(async f => {
  const c = await f.registered();
  expect((await fetch(`${f.base}/agent/v2/deployments/current`, { headers: { authorization: "Bearer invalid-synthetic-token" } })).status).toBe(401);
  await f.db.transaction(tx => authorizeClusterDelivery(tx, c.ctx, c.source));
  const e = await evidence(f, [c.source.clusterId]);
  expect(attributeRouteHistoryV2(e, event(f, c, e.revisions[0]!.visibleAt))).toMatchObject({ workspaceId: null, reason: "unknown-cluster" });
}));
it("preserves pure-policy rejection of conflicting copies and missing provenance", async () => withFixture(async f => {
  const c = await f.registered(), e = await deliver(f, c), r = event(f, c, e.clusterHistory[0]!.validFrom);
  const conflicting = { ...r, copies: [...r.copies, ...r.copies.map(x => ({ ...x, content: { ...x.content, status: 500 } }))] };
  expect(attributeRouteHistoryV2(e, conflicting)).toMatchObject({ workspaceId: null, reason: "conflicting-copies" });
  expect(attributeRouteHistoryV2(e, { ...r, copies: r.copies.map(x => ({ ...x, provenance: "unknown" as const })) })).toMatchObject({ workspaceId: null, reason: "attribution-evidence-missing" });
}));
it("reads actual route removal/recreation without using the shared path as identity", async () => withFixture(async f => {
  const c = await f.registered(), before = await deliver(f, c), ts = before.clusterHistory[0]!.validFrom;
  expect((await f.h.api("DELETE", `/environments/${f.workspaceId}/routes/${f.routeId}`)).status).toBe(204);
  const recreated = await f.h.api("POST", `/environments/${f.workspaceId}/routes`, { name: "recreated-route", serviceId: f.serviceId, paths: ["/same"] });
  expect(recreated.status).toBe(201);
  const newId = recreated.body.id as string;
  expect(newId).not.toBe(f.routeId);
  expect((await f.h.api("POST", `/../v2/workspaces/${f.workspaceId}/releases`, { expectedActiveVersion: 1 })).status).toBe(201);
  expect((await f.h.api("POST", "/../v2/deployments", { expectedRevision: 1, reason: "synthetic recreation fixture" })).status).toBe(201);
  const e = await evidence(f, [c.source.clusterId], [f.routeId, newId]);
  expect(e.revisions.at(-1)!.routes.some(x => x.routeId === f.routeId)).toBe(false);
  expect(attributeRouteHistoryV2(e, event(f, c, ts))).toMatchObject({ workspaceId: f.workspaceId, effectiveRevision: null });
  expect(attributeRouteHistoryV2(e, event(f, c, e.revisions.at(-1)!.visibleAt, newId))).toMatchObject({ workspaceId: f.workspaceId, effectiveRevision: null });
}));
async function syntheticRevision(f: Fixture, revision: number, missing = false) {
  // Explicit repository fixture: rollback HTTP remains planned; this does not pretend to execute it.
  const recordedAt = (await f.h.sql.query<{ ts: string }>("select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as ts")).rows[0]!.ts;
  const key = { instanceId: f.instanceId, epoch: 1, revision };
  await f.db.transaction(tx => appendRouteHistory(tx, ctx, { ...key, recordedAt, previous: { epoch: 1, revision: revision - 1 }, genesis: false,
    reason: missing ? "publish" : revision === 3 ? "rollback" : "publish", rollbackOf: !missing && revision === 3 ? { epoch: 1, revision: 1 } : null,
    configHash: `sha256:${"a".repeat(64)}`, routes: revision === 2 ? [] : [{ routeId: f.routeId, workspaceId: f.workspaceId, serviceId: f.serviceId, releaseVersion: 1 }],
  }));
  await confirmRouteHistory(f.db, ctx, key);
}
it("preserves an explicit synthetic rollback as a new revision, never effectiveRevision", async () => withFixture(async f => {
  const c = await f.registered(); await deliver(f, c);
  await syntheticRevision(f, 2); await syntheticRevision(f, 3);
  const e = await evidence(f, [c.source.clusterId]);
  expect(e.revisions.at(-1)!.rollbackOf).toEqual({ epoch: 1, revision: 1 });
  expect(attributeRouteHistoryV2(e, event(f, c, e.revisions.at(-1)!.visibleAt))).toMatchObject({ workspaceId: f.workspaceId, effectiveRevision: null });
}));
it("fails closed on a missing predecessor despite valid cluster history", async () => withFixture(async f => {
  const c = await f.registered(); await deliver(f, c); await syntheticRevision(f, 3, true);
  const e = await evidence(f, [c.source.clusterId]);
  expect(e.revisionsComplete).toBe(false);
  expect(attributeRouteHistoryV2(e, event(f, c, e.revisions.at(-1)!.visibleAt))).toMatchObject({ workspaceId: null, reason: "attribution-evidence-missing" });
}));
it("bounds requested cluster identities before querying history", async () => withFixture(async f => {
  await expect(evidence(f, Array(201).fill(randomUUID()))).rejects.toThrow(/window/i);
}));
it("does not assign a historically ambiguous route to either workspace", async () => withFixture(async f => {
  const c = await f.registered(); await deliver(f, c);
  const ts = (await f.h.sql.query<{ ts: string }>("select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as ts")).rows[0]!.ts;
  // Explicit conflicting historical fixture; never derived from current Workspace/path names.
  await f.db.transaction(tx => appendRouteHistory(tx, ctx, { instanceId: f.instanceId, epoch: 1, revision: 2, recordedAt: ts,
    previous: { epoch: 1, revision: 1 }, genesis: false, reason: "publish", rollbackOf: null, configHash: `sha256:${"b".repeat(64)}`,
    routes: [{ routeId: f.routeId, workspaceId: f.otherWorkspaceId, serviceId: f.otherServiceId, releaseVersion: 1 }],
  }));
  await confirmRouteHistory(f.db, ctx, { instanceId: f.instanceId, epoch: 1, revision: 2 });
  const e = await evidence(f, [c.source.clusterId]);
  expect(e.identities.find(x => x.routeId === f.routeId)!.workspaceIds).toHaveLength(2);
  expect(attributeRouteHistoryV2(e, event(f, c, e.revisions.at(-1)!.visibleAt))).toMatchObject({ workspaceId: null, reason: "ambiguous-route" });
}));
it("keeps incomplete persisted cluster history untrusted", async () => withFixture(async f => {
  const c = await f.registered(); await deliver(f, c);
  // Explicit incomplete-history fault injection; guards remain enabled and no confirmed fact is overwritten.
  await f.h.sql.query(`insert into analytics_cluster_events(instance_id,cluster_id,sequence,previous_event_id,authorization_id,operation,provenance,actor,complete)
    select instance_id,cluster_id,sequence+1,id,id,'revoke','cp-cluster-lifecycle','{"type":"system","id":"synthetic-incomplete-fixture"}'::jsonb,false
    from analytics_cluster_events where cluster_id=$1 and operation='authorize'`, [c.source.clusterId]);
  const id = await f.db.transaction(tx => authorizeClusterDelivery(tx, c.ctx, c.source));
  await confirmClusterAssociation(f.db, id);
  const e = await evidence(f, [c.source.clusterId]);
  expect(e.clusterHistory.every(x => !x.trusted)).toBe(true);
  expect(attributeRouteHistoryV2(e, event(f, c, e.clusterHistory.at(-1)!.validFrom))).toMatchObject({ workspaceId: null, reason: "unknown-cluster" });
}));
