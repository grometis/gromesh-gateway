import { createHash, createHmac, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DB, type Db } from "../../src/db/db.js";
import { collectorTokenStates } from "../../src/analytics/collector-tokens.js";
import { ENCRYPTION_KEYS, startHarness, uniq, type Harness } from "./harness.js";

const fingerprint = (token: string) => `sha256:${createHash("sha256").update(`gromesh-collector-token/v1\n${token}`).digest("hex")}`;
const A = fingerprint("a".repeat(40));
const B = fingerprint("b".repeat(40));
const C = fingerprint("c".repeat(40));
const LAB = { stage: "dev" as const, convergenceDeadlineMs: 600_000 };
interface Node { id: string; token: string; registrationToken: string; }
interface ShareVector {
  name: string;
  clusters: Record<string, { online: boolean; fingerprints: { current: string; previous: string | null } | null }[]>;
  expected: Record<string, { collectorTokenShared: boolean; collectorTokenUnverified: boolean; collectorTokenRotating: boolean }>;
}
const vectors = JSON.parse(readFileSync(new URL("../../../../contracts/examples/analytics-v2.example.json", import.meta.url), "utf8")) as { collectorTokenShare: { cases: ShareVector[] } };
let h: Harness;
let replica: Harness;
let base: string;
let base2: string;

async function call(token: string, method: string, path: string, body?: unknown, target = base) {
  const res = await fetch(`${target}/agent/${path}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await res.text();
  return { status: res.status, raw, body: raw ? JSON.parse(raw) as Record<string, unknown> : undefined };
}
const report = (node: Node, current?: string, previous: string | null = null, extra: Record<string, unknown> = {}, target = base) => call(node.token, "POST", "v2/status", {
  nodeId: "node-1", epoch: 1, appliedRevision: null, appliedHash: null, kongHealthy: true,
  ...(current ? { collectorTokenFingerprints: { current, previous } } : {}), ...extra,
}, target);
const states = () => collectorTokenStates(h.app.get<Db>(DB));
const protocol = async (n: Node) => (await h.sql.query<{ delivery_protocol: string }>("select delivery_protocol from clusters where id = $1", [n.id])).rows[0]!.delivery_protocol;
const switchToV2 = async (n: Node) => {
  const res = await h.api("PUT", `/../v2/clusters/${n.id}/delivery-protocol`, { protocol: "v2", reason: "collector exclusivity laboratory" });
  expect(res.status).toBe(200);
};
async function node(): Promise<Node> {
  const env = await h.api<{ id: string }>("POST", "/environments", { name: uniq("collector") });
  const cluster = await h.api<{ id: string; registrationToken: string }>("POST", `/environments/${env.body.id}/clusters`, { name: "edge" });
  const registered = await call(cluster.body.registrationToken, "POST", "v1/register", { nodeId: "node-1", hostname: "host", kongVersion: "3.9.4", agentVersion: "0.3.0" });
  expect(registered.status).toBe(200);
  const n = { id: cluster.body.id, token: registered.body!.nodeToken as string, registrationToken: cluster.body.registrationToken };
  await switchToV2(n);
  return n;
}
async function admit(n: Node) {
  const keys = generateKeyPairSync("ed25519");
  const podUid = randomUUID();
  const bootId = randomUUID();
  const asked = await call(n.token, "POST", "v2/isolation/admission-requests", { podUid, podName: `kong-${podUid.slice(0, 5)}`, nodeName: "worker", bootId, probePublicKey: keys.publicKey.export({ format: "jwk" }).x });
  expect(asked.status).toBe(202);
  const polled = await call(n.token, "GET", `v2/isolation/admission-requests/${asked.body!.requestId}`);
  expect(polled.body!.outcome).toBe("granted");
  const admission = polled.body!.admission as { payload: string };
  const claims = JSON.parse(Buffer.from(admission.payload, "base64url").toString()) as { admissionId: string };
  const payload = Buffer.from(JSON.stringify({ clusterId: n.id, podUid, bootId, admissionId: claims.admissionId, seq: 1, prevDigest: null, state: "verifying", failedCapabilities: [], challenge: null, leaseRemainingMs: 30000, final: false })).toString("base64url");
  const protectedHeader = Buffer.from('{"alg":"EdDSA","typ":"gromesh-probe-report+json"}').toString("base64url");
  const result = await call(n.token, "POST", "v2/isolation/reports", { reports: [{ protected: protectedHeader, payload, signature: sign(null, Buffer.from(`${protectedHeader}.${payload}`), keys.privateKey).toString("base64url") }] });
  expect(result.body!.rejected).toEqual([]);
}

beforeAll(async () => {
  h = await startHarness({ workspacesDeployments: LAB });
  replica = await startHarness({ workspacesDeployments: LAB });
  base = (await h.app.getUrl()).replace("[::1]", "127.0.0.1");
  base2 = (await replica.app.getUrl()).replace("[::1]", "127.0.0.1");
  expect((await h.api("POST", "/../v2/instance/signing-keys", { validUntil: new Date(Date.now() + 30 * 86_400_000).toISOString() })).status).toBe(201);
}, 60_000);
afterAll(async () => { await replica?.close(); await h?.close(); });

describe("collector token exclusivity (N3-A1 contract, B3)", () => {
  it.each(vectors.collectorTokenShare.cases)("matches the normative vector with HTTP reports and Postgres: $name", async (vector) => {
    const ids = new Map<string, string>();
    try {
      for (const [id, reports] of Object.entries(vector.clusters)) {
        const first = await node(); ids.set(id, first.id);
        for (const [i, sample] of reports.entries()) {
          let token = first.token;
          const nodeId = `node-${i + 1}`;
          if (i > 0) {
            const registered = await call(first.registrationToken, "POST", "v1/register", { nodeId, hostname: "host", kongVersion: "3.9.4", agentVersion: "0.3.0" });
            expect(registered.status).toBe(200); token = registered.body!.nodeToken as string;
          }
          expect((await report({ ...first, token }, sample.fingerprints?.current, sample.fingerprints?.previous ?? null, { nodeId })).status).toBe(409);
          if (!sample.online) await h.sql.query("update cluster_nodes set last_seen_at = clock_timestamp() - interval '46 seconds' where cluster_id = $1 and node_id = $2", [first.id, nodeId]);
        }
      }
      const actual = await states();
      for (const [id, expected] of Object.entries(vector.expected)) expect(actual.get(ids.get(id)!)).toMatchObject({ shared: expected.collectorTokenShared, unverified: expected.collectorTokenUnverified, rotating: expected.collectorTokenRotating });
    } finally {
      for (const id of ids.values()) await h.sql.query("delete from clusters where id = $1", [id]);
    }
  });

  it("rolls back evidence and share transitions when their audit cannot commit", async () => {
    const x = await node(); const y = await node();
    await report(x, A);
    try {
      await h.sql.query(`create function b3_reject_share_audit() returns trigger language plpgsql as $$ begin
        if NEW.action = 'cluster.collector-token-shared' and NEW.entity_id = '${x.id}' then raise exception 'B3 audit failure'; end if;
        return NEW; end $$`);
      await h.sql.query("create trigger b3_reject_share_audit before insert on audit_events for each row execute function b3_reject_share_audit()");
      expect((await report(y, A)).status).toBe(500);
      const row = (await h.sql.query("select collector_token_evidence from cluster_nodes where cluster_id = $1", [y.id])).rows[0];
      expect(row.collector_token_evidence).toBeNull();
      expect((await h.sql.query("select collector_token_shared from clusters where id in ($1, $2)", [x.id, y.id])).rows.every((r) => !r.collector_token_shared)).toBe(true);
      expect((await h.sql.query("select id from audit_events where action = 'cluster.collector-token-shared' and entity_id in ($1, $2)", [x.id, y.id])).rowCount).toBe(0);
    } finally {
      await h.sql.query("drop trigger if exists b3_reject_share_audit on audit_events");
      await h.sql.query("drop function if exists b3_reject_share_audit()");
      await h.sql.query("delete from clusters where id in ($1, $2)", [x.id, y.id]);
    }
  });

  it("records both concurrent reports, HMACs current/previous and audits the share once per cluster", async () => {
    const x = await node(); const y = await node();
    const results = await Promise.all([report(x, A, B), report(y, A, null, {}, base2)]);
    expect(results.map((r) => r.status)).toEqual([409, 409]);
    for (const n of [x, y]) expect((await states()).get(n.id)).toMatchObject({ shared: true, unverified: false, rotating: false });
    const rows = (await h.sql.query("select collector_token_evidence from cluster_nodes where cluster_id = $1", [x.id])).rows;
    const expected = createHmac("sha256", Buffer.from(ENCRYPTION_KEYS.fingerprint, "base64")).update(`gromesh-collector-fingerprint/v1\n${A}`).digest("hex");
    expect(rows[0].collector_token_evidence).toMatchObject({ current: expected, currentHint: A.slice(7, 15) });
    expect(rows[0].collector_token_evidence.previous).toMatch(/^[0-9a-f]{64}$/);
    const persisted = JSON.stringify(rows);
    for (const value of [A, B, "a".repeat(40), "b".repeat(40)]) expect(persisted).not.toContain(value);
    await report(x, A, B); await report(y, A);
    const audit = (await h.sql.query("select before, after from audit_events where action = 'cluster.collector-token-shared' and entity_id in ($1, $2)", [x.id, y.id])).rows;
    expect(audit).toHaveLength(2);
    expect(audit[0].after).toEqual({ shared: true, keyHints: [A.slice(7, 15)] });
    const allAudit = (await h.sql.query("select before, after from audit_events where environment_id in (select environment_id from clusters where id in ($1, $2))", [x.id, y.id])).rows;
    const publicCluster = await h.api("GET", `/clusters/${x.id}`);
    for (const value of [A, B, expected, "a".repeat(40), "b".repeat(40)]) expect(JSON.stringify(allAudit) + JSON.stringify(results) + JSON.stringify(publicCluster.body)).not.toContain(value);
    await h.sql.query("delete from clusters where id in ($1, $2)", [x.id, y.id]);
  });

  it("serializes parallel activation across replicas: exactly one activates, and an active cluster is never disabled", async () => {
    const x = await node(); const y = await node();
    await admit(x); await admit(y);
    const results = await Promise.all([report(x, A), report(y, A, null, {}, base2)]);
    expect(results.map((r) => r.status).sort()).toEqual([204, 409]);
    expect([await protocol(x), await protocol(y)].sort()).toEqual(["v2", "v2-pending"]);
    const active = (await protocol(x)) === "v2" ? x : y;
    const pending = active === x ? y : x;
    expect((await states()).get(active.id)?.shared).toBe(true);
    expect((await call(active.token, "GET", "v2/deployments/current")).status).toBe(404);
    expect(await protocol(active)).toBe("v2");
    expect((await call(pending.token, "GET", "v2/deployments/current")).body?.code).toBe("delivery-protocol-switching");
    // Rolling to B with A still accepted is rotation, not a share and not a reason to interrupt either cluster.
    expect((await report(pending, B, A)).status).toBe(204);
    expect((await states()).get(active.id)).toMatchObject({ shared: false, rotating: true });
    expect(await protocol(pending)).toBe("v2");
    expect((await report(pending, B)).status).toBe(204);
    expect((await states()).get(active.id)).toMatchObject({ shared: false, rotating: false });
    const events = (await h.sql.query("select after from audit_events where action = 'cluster.collector-token-shared' and entity_id = $1 order by at", [active.id])).rows;
    expect(events.map((e) => e.after.shared)).toEqual([true, false]);
    await h.sql.query("delete from clusters where id in ($1, $2)", [x.id, y.id]);
  });

  it("excludes offline/replaced pods, clears stale evidence on registration and rejects foreign node/cluster/instance identities", async () => {
    const x = await node(); const y = await node();
    await admit(x); await report(y, A); await report(x, A);
    expect(await protocol(x)).toBe("v2-pending");
    // No wall-clock sleeps: a deterministic expired online window is the only expiry the contract defines.
    await h.sql.query("update cluster_nodes set last_seen_at = clock_timestamp() - interval '46 seconds' where cluster_id = $1", [y.id]);
    expect((await call(x.token, "GET", "v2/deployments/current")).status).toBe(404);
    expect(await protocol(x)).toBe("v2");
    for (const extra of [{ nodeId: "foreign-node" }, { clusterId: y.id }, { instanceId: randomUUID() }]) expect((await report(x, C, null, extra)).status).toBe(422);
    expect((await call(x.registrationToken, "POST", "v2/status", {})).status).toBe(401);
    const before = (await h.sql.query("select collector_token_evidence, collector_token_reported_at from cluster_nodes where cluster_id = $1", [x.id])).rows;
    expect((await report(x, C, null, { epoch: 2 })).body?.code).toBe("unknown-deployment");
    expect((await report(x, C, null, { appliedRevision: 123, appliedHash: C })).body?.code).toBe("unknown-deployment");
    expect((await h.sql.query("select collector_token_evidence, collector_token_reported_at from cluster_nodes where cluster_id = $1", [x.id])).rows).toEqual(before);
    await h.sql.query("update cluster_nodes set collector_token_reported_at = clock_timestamp() - interval '46 seconds', last_seen_at = clock_timestamp() where cluster_id = $1", [x.id]);
    expect((await states()).get(x.id)).toMatchObject({ unverified: true, shared: false });
    const registered = await call(x.registrationToken, "POST", "v1/register", { nodeId: "node-1", hostname: "replacement", kongVersion: "3.9.4", agentVersion: "0.3.0" });
    expect(registered.status).toBe(200);
    expect((await states()).get(x.id)).toMatchObject({ unverified: true, shared: false });
    expect((await report(x, C)).status).toBe(401);
    const next = { ...x, token: registered.body!.nodeToken as string };
    expect((await report(next)).status).toBe(204);
    expect(await protocol(x)).toBe("v2");
    expect((await states()).get(x.id)?.unverified).toBe(true);
    await h.sql.query("delete from clusters where id in ($1, $2)", [x.id, y.id]);
  });

  it("fails closed for missing/malformed evidence, keeps previous/previous nonblocking, and honors mode/RBAC", async () => {
    const x = await node(); const y = await node();
    await admit(x);
    expect((await report(x)).status).toBe(409);
    expect((await call(x.token, "GET", "v2/deployments/current")).body?.code).toBe("delivery-protocol-switching");
    for (const value of [{ current: "token-secret", previous: null }, { current: A }, { current: A, previous: "expired" }, { current: A, previous: null, secret: "token-secret" }]) {
      const res = await report(x, undefined, null, { collectorTokenFingerprints: value });
      expect(res.status).toBe(422); expect(res.raw).not.toContain("token-secret");
    }
    await report(y, B, C);
    expect((await report(x, A, C)).status).toBe(204);
    expect((await states()).get(x.id)).toMatchObject({ shared: false, rotating: true });
    const viewer = await h.as("viewer");
    expect((await viewer.api("PUT", `/../v2/clusters/${y.id}/delivery-protocol`, { protocol: "v1", reason: "collector test unauthorized" })).status).toBe(403);
    const disabled = await startHarness({ workspacesDeployments: null });
    try {
      const target = (await disabled.app.getUrl()).replace("[::1]", "127.0.0.1");
      const res = await report(y, A, null, {}, target);
      expect(res.body?.code).toBe("workspaces-mode-disabled");
      expect((await states()).get(y.id)).toMatchObject({ shared: false, rotating: true });
    } finally { await disabled.close(); }
    await h.sql.query("delete from clusters where id in ($1, $2)", [x.id, y.id]);
  });
});
