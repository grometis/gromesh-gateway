import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contractsV2 } from "../../src/common/contract.js";
import { startHarness, uniq, type Harness } from "./harness.js";

interface HealthCase { name: string; input: Record<string, unknown>; expected: { state: string; reasons: string[]; analytics: string } }
const vector = JSON.parse(readFileSync(new URL("../../../../contracts/examples/analytics-v2.example.json", import.meta.url), "utf8")) as { healthOf: { cases: HealthCase[] } };

describe("N3-B4 agent collector health (real HTTP and Postgres)", () => {
 let h: Harness; let base: string; let clusterId: string; let token: string; let registrationToken: string;
 const report = (body: Record<string, unknown>, credential = token) => fetch(`${base}/agent/v2/status`, { method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: JSON.stringify({ nodeId: "pod-a", epoch: 1, appliedRevision: null, appliedHash: null, kongHealthy: true, ...body }) });
 const health = (c: HealthCase) => ({ ...c.input, ...c.expected, analytics: undefined, observedAt: "2026-10-30T00:00:00Z", lastReceivedAt: null, lastDeliveredAt: null });
 const list = () => h.api("GET", "/../v2/clusters");
 beforeAll(async () => {
  h = await startHarness({ workspacesDeployments: { stage: "dev", convergenceDeadlineMs: 600000 } });
  base = (await h.app.getUrl()).replace("[::1]", "127.0.0.1");
  const env = (await h.api("POST", "/environments", { name: uniq("b4") })).body.id as string;
  const created = await h.api("POST", `/environments/${env}/clusters`, { name: uniq("edge") }); clusterId = created.body.id as string; registrationToken = created.body.registrationToken as string;
  const registered = await fetch(`${base}/agent/v1/register`, { method: "POST", headers: { authorization: `Bearer ${created.body.registrationToken as string}`, "content-type": "application/json" }, body: JSON.stringify({ nodeId: "pod-a", hostname: "pod-a", kongVersion: "3.9.4", agentVersion: "0.1.0" }) });
  token = ((await registered.json()) as { nodeToken: string }).nodeToken;
  // Health is independent of admission/convergence; the existing deployments suite exercises the actual v2 gate.
  await h.sql.query("update clusters set delivery_protocol = 'v2' where id = $1", [clusterId]);
 });
 afterAll(async () => h?.close());

 it("persists every approved health reading, exposes the cluster state, audits only degraded transitions", async () => {
  let degraded = false; let opened = 0; let cleared = 0;
  for (const c of vector.healthOf.cases) {
   const res = await report({ analyticsHealth: health(c), analytics: c.expected.analytics });
   expect(res.status, `${c.name}: ${await res.text()}`).toBe(204);
   const saved = (await h.sql.query("select analytics_health, analytics_received_at from cluster_nodes where cluster_id=$1 and node_id='pod-a'", [clusterId])).rows[0] as { analytics_health: { state: string }; analytics_received_at: Date };
   expect(saved.analytics_health.state).toBe(c.expected.state);
   expect(saved.analytics_received_at.getTime()).toBeGreaterThan(Date.now()-10000);
   const view = await list(); expect(view.status).toBe(200);
   const cluster = (view.body.items as { id: string; analytics: { state: string }; status: string }[]).find((item)=>item.id===clusterId)!;
   expect(cluster.analytics.state,c.name).toBe(c.expected.state);
   expect(cluster.status).toBe("converging");
   const validate = contractsV2.validator("InstanceCluster"); expect(validate(cluster), JSON.stringify(validate.errors)).toBe(true);
   if (!degraded && c.expected.state==="degraded") opened++;
   if (degraded && c.expected.state!=="degraded") cleared++;
   degraded = c.expected.state==="degraded";
  }
  const audit = await h.sql.query("select action, count(*)::int as n from audit_events where entity_id=$1 and action in ('cluster.analytics.degraded','cluster.analytics.cleared') group by action", [clusterId]);
  expect(Object.fromEntries(audit.rows.map((r:{action:string;n:number})=>[r.action,r.n]))).toEqual({"cluster.analytics.degraded":opened,"cluster.analytics.cleared":cleared});
 });
 it("refuses foreign node/cluster identity, wrong token and dishonest healthy state without overwriting health", async () => {
  const c=vector.healthOf.cases[0]!;
  const before=(await h.sql.query("select analytics_health,analytics_received_at from cluster_nodes where cluster_id=$1",[clusterId])).rows;
  expect((await report({nodeId:"pod-b",analyticsHealth:health(c),analytics:c.expected.analytics})).status).toBe(422);
  expect((await report({clusterId,analyticsHealth:health(c),analytics:c.expected.analytics})).status).toBe(422);
  expect((await report({analyticsHealth:health(c),analytics:c.expected.analytics},"invalid-token")).status).toBe(401);
  expect((await report({analyticsHealth:{...health(c),authRefusals:1},analytics:c.expected.analytics})).status).toBe(422);
  expect((await h.sql.query("select analytics_health,analytics_received_at from cluster_nodes where cluster_id=$1",[clusterId])).rows).toEqual(before);
 });
 it("uses CP reception time, expires missing reports, and never exposes a stale report as healthy", async () => {
  const c=vector.healthOf.cases[0]!;
  expect((await report({analyticsHealth:health(c),analytics:c.expected.analytics})).status).toBe(204);
  expect((await list()).body.items.find((item:{id:string})=>item.id===clusterId).analytics.state).toBe("healthy");
  await h.sql.query("update cluster_nodes set analytics_received_at=now()-interval '61 seconds' where cluster_id=$1",[clusterId]);
  expect((await list()).body.items.find((item:{id:string})=>item.id===clusterId).analytics.state).toBe("unknown");
  // A newer legacy agent report without analytics must not keep the old evidence alive.
  expect((await report({})).status).toBe(204);
  expect((await list()).body.items.find((item:{id:string})=>item.id===clusterId).analytics.state).toBe("unknown");
 });
 it("aggregates multiple pods, prioritizes degraded over missing evidence and audits expiry once", async () => {
  const healthy = vector.healthOf.cases.find((c) => c.expected.state === "healthy")!;
  const idle = vector.healthOf.cases.find((c) => c.expected.state === "idle")!;
  const degraded = vector.healthOf.cases.find((c) => c.expected.reasons.includes("auth-refusals"))!;
  expect((await report({ analyticsHealth: health(healthy), analytics: healthy.expected.analytics })).status).toBe(204);
  const registered = await fetch(`${base}/agent/v1/register`, {
   method: "POST", headers: { authorization: `Bearer ${registrationToken}`, "content-type": "application/json" },
   body: JSON.stringify({ nodeId: "pod-b", hostname: "pod-b", kongVersion: "3.9.4", agentVersion: "0.1.0" }),
  });
  const other = ((await registered.json()) as { nodeToken: string }).nodeToken;
  const state = async () => (await list()).body.items.find((item: { id: string }) => item.id === clusterId).analytics.state as string;
  expect(await state()).toBe("unknown");
  expect((await report({ nodeId: "pod-b", analyticsHealth: health(idle), analytics: idle.expected.analytics }, other)).status).toBe(204);
  expect(await state()).toBe("healthy");
  expect((await report({ nodeId: "pod-b", analyticsHealth: health(degraded), analytics: degraded.expected.analytics }, other)).status).toBe(204);
  await h.sql.query("update cluster_nodes set analytics_received_at=now()-interval '61 seconds' where cluster_id=$1 and node_id='pod-a'", [clusterId]);
  expect(await state()).toBe("degraded");
  const countCleared = async () => Number((await h.sql.query("select count(*) from audit_events where entity_id=$1 and action='cluster.analytics.cleared'", [clusterId])).rows[0].count);
  const before = await countCleared();
  await h.sql.query("update cluster_nodes set analytics_received_at=now()-interval '61 seconds' where cluster_id=$1", [clusterId]);
  expect(await state()).toBe("unknown");
  expect(await countCleared()).toBe(before + 1);
  expect(await state()).toBe("unknown");
  expect(await countCleared()).toBe(before + 1);
 });
 it("keeps fingerprint display to key hints and invalidates health when a pod re-registers", async () => {
  const healthy = vector.healthOf.cases.find((c) => c.expected.state === "healthy")!;
  const current = `sha256:${"a".repeat(64)}`;
  expect((await report({ analyticsHealth: health(healthy), analytics: healthy.expected.analytics, collectorTokenFingerprints: { current, previous: null } })).status).toBe(204);
  const view = await list();
  expect(JSON.stringify(view.body)).not.toContain(current);
  const analytics = view.body.items.find((item: { id: string }) => item.id === clusterId).analytics as { nodes: { nodeId: string; collectorTokenKeyHint: string }[] };
  expect(analytics.nodes.find((n) => n.nodeId === "pod-a")?.collectorTokenKeyHint).toBe("aaaaaaaa");
  const registered = await fetch(`${base}/agent/v1/register`, {
   method: "POST", headers: { authorization: `Bearer ${registrationToken}`, "content-type": "application/json" },
   body: JSON.stringify({ nodeId: "pod-a", hostname: "pod-a", kongVersion: "3.9.4", agentVersion: "0.1.0" }),
  });
  token = ((await registered.json()) as { nodeToken: string }).nodeToken;
  const saved = (await h.sql.query("select analytics_health, analytics_received_at, collector_token_fingerprints from cluster_nodes where cluster_id=$1 and node_id='pod-a'", [clusterId])).rows[0];
  expect(saved).toEqual({ analytics_health: null, analytics_received_at: null, collector_token_fingerprints: null });
 });
 it("requires instance.read and does not grant cluster health through a workspace/viewer role", async () => {
  const viewer=await h.as("viewer");
  expect((await viewer.api("GET","/../v2/clusters")).status).toBe(403);
  expect((await h.anonymous("GET","/../v2/clusters")).status).toBe(401);
 });
});
