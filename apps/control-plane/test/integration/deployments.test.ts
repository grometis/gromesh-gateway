import { createHash, generateKeyPairSync, type KeyObject, randomUUID, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { canonicalJson, jcs } from "@gromesh/compiler";
import { contractsV2 } from "../../src/common/contract.js";
import { deploymentContext, ENCRYPTOR, type Encryptor } from "../../src/crypto/crypto.js";
import { runMigrations } from "../../src/db/migrate.js";
import type { Jws } from "../../src/instance/signing-keys.js";
import { type ApiClient, startHarness, uniq, type Harness } from "./harness.js";

// N3-C4: the v2 delivery of an instance deployment (agent protocol v2, "Delivery protocol per cluster" and "Applied
// revision and convergence evidence", N3-K1): one flow per cluster, the activation gate, and convergence only with the
// agent's status AND the probe's signed report agreeing on epoch, revision, hash and Kong's config hash.
type Doc = Record<string, any>;
// Migrated databases and several harnesses: generous limits on a busy machine.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://gromesh:gromesh@127.0.0.1:5432/gromesh";
const LAB = { stage: "dev" as const, convergenceDeadlineMs: 600_000 };
const v2doc = parse(readFileSync(new URL("../../../../contracts/control-plane-v2.openapi.yaml", import.meta.url), "utf8")) as Doc;
const MACHINE = v2doc.components.schemas.DeploymentState["x-gromesh-transitions"] as { initial: string[]; transitions: [string, string, string][] };
const EDGES = new Set(MACHINE.transitions.map(([from, to]) => `${from}>${to}`));
const created: string[] = [];
const b64 = (value: string | Buffer) => Buffer.from(value).toString("base64url");
const KONG_B = "b".repeat(32);

async function freshDatabase(label: string): Promise<string> {
  const name = `gromesh_n3c4_${label}_${Date.now()}_${process.pid}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  created.push(name);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  await runMigrations(url.toString());
  return url.toString();
}

afterAll(async () => {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  for (const name of created) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.end();
});

/** A pod's isolation-probe: its key, seq and chain (as in isolation-admissions.test.ts). */
class Probe {
  readonly key: KeyObject;
  readonly publicKey: string;
  readonly podUid = randomUUID();
  readonly bootId = randomUUID();
  seq = 0;
  prev: string | null = null;
  constructor() {
    const pair = generateKeyPairSync("ed25519");
    this.key = pair.privateKey;
    this.publicKey = pair.publicKey.export({ format: "jwk" }).x!;
  }
  request() {
    return { podUid: this.podUid, podName: `kong-${this.podUid.slice(0, 5)}`, nodeName: "worker-1", bootId: this.bootId, probePublicKey: this.publicKey };
  }
  next(clusterId: string, admissionId: string, extra: Record<string, unknown> = {}): Jws {
    this.seq++;
    const payload = JSON.stringify({ clusterId, podUid: this.podUid, bootId: this.bootId, admissionId, seq: this.seq, prevDigest: this.seq === 1 ? null : this.prev, state: "ok", failedCapabilities: [], challenge: null, leaseRemainingMs: 30000, final: false, ...extra });
    this.prev = `sha256:${createHash("sha256").update(payload).digest("hex")}`;
    const p = b64('{"alg":"EdDSA","typ":"gromesh-probe-report+json"}');
    const body = b64(payload);
    return { protected: p, payload: body, signature: sign(null, Buffer.from(`${p}.${body}`, "ascii"), this.key).toString("base64url") };
  }
}

const v2 = (client: ApiClient, method: string, path: string, body?: unknown) => client(method, `/../v2${path}`, body);

async function agentCall(base: string, token: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/agent/${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await res.text();
  return { status: res.status, headers: res.headers, raw, body: raw ? (JSON.parse(raw) as Doc) : undefined };
}

async function cluster(h: Harness, base: string) {
  const env = (await h.api("POST", "/environments", { name: uniq("dep") })).body.id as string;
  const created = await h.api("POST", `/environments/${env}/clusters`, { name: "edge" });
  expect(created.status).toBe(201);
  const registered = await fetch(`${base}/agent/v1/register`, {
    method: "POST",
    headers: { authorization: `Bearer ${created.body.registrationToken}`, "content-type": "application/json" },
    body: JSON.stringify({ nodeId: "node-1", hostname: "host", kongVersion: "3.9.4", agentVersion: "0.3.0" }),
  });
  const node = (await registered.json()) as { nodeToken: string; clusterId: string };
  return { env, id: node.clusterId, token: node.nodeToken, registrationToken: created.body.registrationToken as string };
}

describe("v2 delivery with Workspaces mode off (D4)", () => {
  it("refuses the v2 endpoints and the switch to v2 with workspaces-mode-disabled; v1 is untouched", async () => {
    const h = await startHarness({ databaseUrl: await freshDatabase("off") });
    try {
      const base = (await h.app.getUrl()).replace("[::1]", "127.0.0.1");
      const c = await cluster(h, base);
      expect((await agentCall(base, c.token, "GET", "v2/deployments/current")).body).toMatchObject({ status: 409, code: "workspaces-mode-disabled" });
      expect((await agentCall(base, c.token, "POST", "v2/status", { nodeId: "node-1", epoch: 1, appliedRevision: null, appliedHash: null, kongHealthy: true })).body).toMatchObject({ code: "workspaces-mode-disabled" });
      const refused = await v2(h.api, "PUT", `/clusters/${c.id}/delivery-protocol`, { protocol: "v2", reason: "laboratory switch test" });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe("workspaces-mode-disabled");
      expect((await h.sql.query(`select delivery_protocol from clusters where id = $1`, [c.id])).rows[0].delivery_protocol).toBe("v1");
      expect((await agentCall(base, c.token, "GET", "v1/snapshots/current")).status).toBe(204);
    } finally {
      await h.close();
    }
  });
});

describe("v2 delivery and convergence in a laboratory", () => {
  let h: Harness;
  let base: string;
  let enc: Encryptor;
  let c: Awaited<ReturnType<typeof cluster>>;
  let ws: string;
  const probe = new Probe();
  let admissionId: string;

  const status = (extra: Record<string, unknown>) => agentCall(base, c.token, "POST", "v2/status", { nodeId: "node-1", epoch: 1, appliedRevision: null, appliedHash: null, kongHealthy: true, ...extra });
  const report = async (extra: Record<string, unknown>) => {
    const res = await agentCall(base, c.token, "POST", "v2/isolation/reports", { reports: [probe.next(c.id, admissionId, extra)] });
    expect(res.status, res.raw).toBe(200);
    expect(res.body!.rejected, res.raw).toEqual([]);
  };
  const latest = async () => (await h.sql.query(`select epoch, revision, config_hash, kong_config_hash, config, members, created_at from deployments order by epoch desc, revision desc limit 1`)).rows[0] as Doc;
  const history = async (revision: number) => (await h.sql.query(`select state from deployment_states where epoch = 1 and revision = $1 order by seq`, [revision])).rows.map((r) => r.state as string);
  /** A new release of the workspace, then the explicit deployment of the instance (D4). */
  const publish = async () => {
    await h.api("POST", `/environments/${ws}/services`, { name: uniq("svc"), protocol: "http", host: "echo", port: 80 });
    const res = await v2(h.api, "POST", `/workspaces/${ws}/releases`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const current = (await h.sql.query(`select max(revision)::int as r from deployments`)).rows[0].r as number | null;
    const deployed = await v2(h.api, "POST", "/deployments", { expectedRevision: current, reason: "laboratory deployment" });
    expect(deployed.status, JSON.stringify(deployed.body)).toBe(201);
    return latest();
  };
  /** The agent's status and the probe's report as a node that really applied `dep` would send them. */
  const applied = (dep: Doc, kong = dep.kong_config_hash as string) => ({ appliedRevision: dep.revision, appliedHash: dep.config_hash, kongConfigHash: kong });
  const signed = (dep: Doc, kong = dep.kong_config_hash as string) => ({ state: "ok", servedKongConfigHash: kong, appliedEpoch: 1, appliedRevision: dep.revision, appliedHash: dep.config_hash, appliedKongConfigHash: kong });

  beforeAll(async () => {
    h = await startHarness({ databaseUrl: await freshDatabase("lab"), workspacesDeployments: LAB });
    base = (await h.app.getUrl()).replace("[::1]", "127.0.0.1");
    enc = h.app.get<Encryptor>(ENCRYPTOR);
    expect((await v2(h.api, "POST", "/instance/signing-keys", { validUntil: new Date(Date.now() + 30 * 86_400_000).toISOString() })).status).toBe(201);
    c = await cluster(h, base);
    ws = (await h.api("POST", "/environments", { name: uniq("ws") })).body.id as string;
    const svc = (await h.api("POST", `/environments/${ws}/services`, { name: uniq("svc"), protocol: "http", host: "echo", port: 80 })).body.id;
    await h.api("POST", `/environments/${ws}/routes`, { name: uniq("route"), serviceId: svc, paths: ["/echo"] });
  }, 120_000);
  afterAll(async () => h?.close());

  it("serves nothing v2 to a v1 cluster, and the switch is explicit, validated and audited", async () => {
    expect((await agentCall(base, c.token, "GET", "v2/deployments/current")).body).toMatchObject({ status: 409, code: "delivery-protocol-v1", type: "https://gromesh.dev/problems/delivery-protocol-v1" });
    const viewer = await h.as("viewer");
    expect((await v2(viewer.api, "PUT", `/clusters/${c.id}/delivery-protocol`, { protocol: "v2", reason: "laboratory switch test" })).status).toBe(403);
    expect((await v2(h.api, "PUT", `/clusters/${c.id}/delivery-protocol`, { protocol: "v2", reason: "short" })).status).toBe(422);

    const res = await v2(h.api, "PUT", `/clusters/${c.id}/delivery-protocol`, { protocol: "v2", reason: "laboratory switch test" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const validate = contractsV2.validator("InstanceCluster");
    expect(validate(structuredClone(res.body)), JSON.stringify(validate.errors)).toBe(true);
    expect(res.body).toMatchObject({ id: c.id, deliveryProtocol: "v2-pending", environmentId: c.env });
    expect((await v2(h.api, "PUT", `/clusters/${c.id}/delivery-protocol`, { protocol: "v2", reason: "laboratory switch test" })).body.code).toBe("delivery-protocol-unchanged");
    const audit = (await h.sql.query(`select before, after from audit_events where action = 'cluster.delivery-protocol' and entity_id = $1`, [c.id])).rows;
    expect(audit).toEqual([{ before: { deliveryProtocol: "v1" }, after: { deliveryProtocol: "v2-pending", reason: "laboratory switch test" } }]);

    // Switching: neither flow delivers anything new until the activation gate.
    const v1 = await agentCall(base, c.token, "GET", "v1/snapshots/current");
    expect(v1.status).toBe(409);
    expect(v1.body!.type).toBe("https://gromesh.dev/problems/delivery-protocol-switching");
    expect((await agentCall(base, c.token, "GET", "v2/deployments/current")).body!.code).toBe("delivery-protocol-switching");
  });

  it("activates v2 only when every node passed a conclusive round with no pendency open", async () => {
    const asked = await agentCall(base, c.token, "POST", "v2/isolation/admission-requests", probe.request());
    expect(asked.status, asked.raw).toBe(202);
    const polled = await agentCall(base, c.token, "GET", `v2/isolation/admission-requests/${asked.body!.requestId}`);
    expect(polled.body!.outcome, polled.raw).toBe("granted");
    admissionId = JSON.parse(Buffer.from(polled.body!.admission.payload, "base64url").toString("utf8")).admissionId;
    // Granted but no round yet: the gate does not hold.
    expect((await agentCall(base, c.token, "GET", "v2/deployments/current")).body!.code).toBe("delivery-protocol-switching");
    await report({ state: "violation", failedCapabilities: ["CAP-1"] });
    expect((await agentCall(base, c.token, "GET", "v2/deployments/current")).body!.code).toBe("delivery-protocol-switching");
    expect((await h.sql.query(`select delivery_protocol from clusters where id = $1`, [c.id])).rows[0].delivery_protocol).toBe("v2-pending");
  });

  it("(after a released violation) activates, then serves the latest revision as canonical JSON with 304 confirming it", async () => {
    // The violation opened a confirmed-violation pendency: released by a platform admin, then a passing round.
    const pendency = (await h.sql.query(`select id from isolation_pendencies where cluster_id = $1 and lifecycle = 'confirmed-violation'`, [c.id])).rows[0];
    expect(pendency).toBeDefined();
    expect((await v2(h.api, "POST", `/clusters/${c.id}/isolation-releases`, { pendencyId: pendency.id, justification: "laboratory violation drill" })).status).toBe(201);
    await report({ state: "verifying" });
    // One writer per Kong: a node without an open admission (a v1-mode agent) online in the cluster holds the gate.
    const v1node = await fetch(`${base}/agent/v1/register`, {
      method: "POST",
      headers: { authorization: `Bearer ${c.registrationToken}`, "content-type": "application/json" },
      body: JSON.stringify({ nodeId: "node-v1", hostname: "host", kongVersion: "3.9.4", agentVersion: "0.3.0" }),
    });
    expect(v1node.status).toBe(200);
    expect((await agentCall(base, c.token, "GET", "v2/deployments/current")).body!.code).toBe("delivery-protocol-switching");
    // Offline is not enough: every registered node is expected. Nodes are never deregistered yet; the row is removed
    // here as a deregistration would.
    await h.sql.query(`update cluster_nodes set last_seen_at = now() - interval '2 minutes' where node_id = 'node-v1'`);
    expect((await agentCall(base, c.token, "GET", "v2/deployments/current")).body!.code).toBe("delivery-protocol-switching");
    await h.sql.query(`delete from cluster_nodes where node_id = 'node-v1'`);
    const none = await agentCall(base, c.token, "GET", "v2/deployments/current");
    expect(none.status, none.raw).toBe(404);
    expect((await h.sql.query(`select delivery_protocol from clusters where id = $1`, [c.id])).rows[0].delivery_protocol).toBe("v2");
    expect((await h.sql.query(`select after from audit_events where action = 'cluster.delivery-protocol' and actor->>'type' = 'system'`)).rows).toHaveLength(1);

    const dep = await publish();
    expect((await h.sql.query(`select expected_nodes from deployments where revision = $1`, [dep.revision])).rows[0].expected_nodes).toEqual([{ clusterId: c.id, nodeId: "node-1" }]);
    expect(await history(dep.revision)).toEqual(["composed", "active"]);
    expect((await h.sql.query(`select revision from deployment_lease`)).rows[0].revision).toBe(dep.revision);

    const res = await agentCall(base, c.token, "GET", "v2/deployments/current");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-gromesh-epoch")).toBe("1");
    expect(res.headers.get("x-gromesh-revision")).toBe(String(dep.revision));
    expect(res.headers.get("etag")).toBe(dep.config_hash);
    const config = enc.openJson<Doc>(dep.config, deploymentContext(1, dep.revision));
    // JCS bytes: the config member is exactly the bytes whose md5 is the deployment's Kong hash.
    expect(res.raw).toBe(jcs(res.body));
    expect(createHash("md5").update(jcs(res.body!.config), "utf8").digest("hex")).toBe(dep.kong_config_hash);
    expect(res.raw).toContain(`"config":${jcs(config)}`);
    expect(`sha256:${createHash("sha256").update(canonicalJson(res.body!.config)).digest("hex")}`).toBe(dep.config_hash);
    expect(res.body!.config).toEqual(config);
    expect(res.body).toMatchObject({ schemaVersion: 2, epoch: 1, revision: dep.revision, hash: dep.config_hash, members: [{ workspaceId: ws, releaseVersion: expect.any(Number) }] });
    const notModified = await agentCall(base, c.token, "GET", "v2/deployments/current", undefined, { "if-none-match": dep.config_hash });
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get("x-gromesh-revision")).toBe(String(dep.revision));
  });

  it("never converges on the agent's declaration alone, and converges once the probe's fresh signed report agrees", async () => {
    const dep = await latest();
    expect((await status(applied(dep))).status).toBe(204);
    expect((await history(dep.revision)).at(-1)).toBe("converging");
    // A report of the same round without the applied evidence (the canary did not serve applied.json's hash yet).
    await report({ state: "verifying", servedKongConfigHash: null });
    await status(applied(dep));
    expect((await history(dep.revision)).at(-1)).toBe("converging");
    // A matching report received before this revision was recorded proves nothing (the 60 s rule: evidence.test.ts).
    await report(signed(dep));
    await h.sql.query(`update isolation_reports set received_at = now() - interval '2 minutes' where admission_id = $1 and seq = $2`, [admissionId, probe.seq]);
    await status(applied(dep));
    expect((await history(dep.revision)).at(-1)).toBe("converging");
    expect((await h.sql.query(`select count(*)::int as n from content_activations`)).rows[0].n).toBe(0);

    await report(signed(dep));
    // Kong reported unhealthy: degraded, never converged, even with every evidence in place.
    await status({ ...applied(dep), kongHealthy: false });
    expect((await history(dep.revision)).at(-1)).toBe("degraded");
    expect((await h.sql.query(`select count(*)::int as n from content_activations`)).rows[0].n).toBe(0);
    await status(applied(dep));
    expect(await history(dep.revision)).toEqual(["composed", "active", "converging", "degraded", "converging", "converged"]);
    expect((await h.sql.query(`select revision from deployment_lease`)).rows[0].revision).toBeNull();
    const activations = (await h.sql.query(`select workspace_id, deployment_revision from content_activations`)).rows;
    expect(activations).toEqual([{ workspace_id: ws, deployment_revision: dep.revision }]);
    expect((await h.sql.query(`select verified_revision from cluster_nodes where cluster_id = $1 and node_id = 'node-1'`, [c.id])).rows[0].verified_revision).toBe(dep.revision);
    // Activated once: the same content converging again later inserts nothing.
    await status(applied(dep));
    expect((await h.sql.query(`select count(*)::int as n from content_activations`)).rows[0].n).toBe(1);
  });

  it("degrades when Kong serves a config other than the declared one, and recovers when they agree again", async () => {
    const dep = await publish();
    await status(applied(dep));
    await report(signed(dep));
    // The probe's canary sees Kong serving B while the agent declares the authorized hash.
    await report({ state: "verifying", servedKongConfigHash: KONG_B });
    await status(applied(dep));
    expect(await history(dep.revision)).toEqual(["composed", "active", "converging", "degraded"]);
    await report(signed(dep));
    await status(applied(dep));
    expect((await history(dep.revision)).slice(-2)).toEqual(["converging", "converged"]);
    // The divergence was audited once when it opened and once when it cleared.
    const audited = (await h.sql.query(`select action, after->>'evidence' as evidence from audit_events where action like 'deployment.evidence.%' and after->>'revision' = $1 order by at`, [String(dep.revision)])).rows;
    expect(audited).toEqual([
      { action: "deployment.evidence.opened", evidence: "served-config-divergence" },
      { action: "deployment.evidence.cleared", evidence: "verified" },
    ]);
  });

  it("degrades when agent and probe agree on a Kong hash the control plane did not derive (other bytes)", async () => {
    const dep = await publish();
    expect(dep.kong_config_hash).not.toBe(KONG_B);
    // First Kong serving B while the agent declares the authorized hash, then both agreeing on B.
    await status(applied(dep));
    await report({ state: "verifying", servedKongConfigHash: KONG_B });
    await status(applied(dep));
    // The probe signs B as applied while the agent still declares the authorized hash: revision-mismatch.
    await report(signed(dep, KONG_B));
    await status(applied(dep));
    // Both on B, a hash the control plane did not derive: kong-hash-divergence.
    await status(applied(dep, KONG_B));
    expect((await history(dep.revision)).at(-1)).toBe("degraded");
    // One divergence turning into another: the first is cleared when the second opens; only the second stays open.
    const audited = (await h.sql.query(`select action, before->>'evidence' as was, after->>'evidence' as evidence from audit_events where action like 'deployment.evidence.%' and after->>'revision' = $1`, [String(dep.revision)])).rows;
    const count = (action: string, field: "was" | "evidence", value: string) => audited.filter((r) => r.action === action && r[field] === value).length;
    expect(count("deployment.evidence.opened", "evidence", "served-config-divergence")).toBe(1);
    expect(count("deployment.evidence.cleared", "was", "served-config-divergence")).toBe(1);
    expect(count("deployment.evidence.opened", "evidence", "revision-mismatch")).toBe(1);
    expect(count("deployment.evidence.cleared", "was", "revision-mismatch")).toBe(1);
    expect(count("deployment.evidence.opened", "evidence", "kong-hash-divergence")).toBe(1);
    expect(count("deployment.evidence.cleared", "was", "kong-hash-divergence")).toBe(0);
    expect((await h.sql.query(`select verified_revision from cluster_nodes where cluster_id = $1 and node_id = 'node-1'`, [c.id])).rows[0].verified_revision).toBeLessThan(dep.revision);
  });

  it("refuses a regression, an unknown deployment and an outdated epoch with their codes", async () => {
    const node = (await h.sql.query(`select verified_revision from cluster_nodes where cluster_id = $1 and node_id = 'node-1'`, [c.id])).rows[0];
    const old = (await h.sql.query(`select config_hash from deployments where revision = $1`, [node.verified_revision - 1])).rows[0];
    const regression = await status({ appliedRevision: node.verified_revision - 1, appliedHash: old.config_hash, kongConfigHash: KONG_B });
    expect(regression.status).toBe(409);
    expect(regression.body!.code).toBe("revision-regression");
    expect((await h.sql.query(`select failure_reason from cluster_nodes where cluster_id = $1 and node_id = 'node-1'`, [c.id])).rows[0]).toEqual({ failure_reason: "revision-regression" });
    expect((await status({ appliedRevision: 999, appliedHash: old.config_hash })).body!.code).toBe("unknown-deployment");
    expect((await status({ epoch: 2 })).body!.code).toBe("unknown-deployment");
  });

  it("fails a deployment whose convergence deadline passed, along the contract's edges, and frees the lease", async () => {
    // The degraded revision of the case before still holds the lease: nothing new can be published or deployed.
    const dep = await latest();
    expect((await h.sql.query(`select revision from deployment_lease`)).rows[0].revision).toBe(dep.revision);
    expect((await v2(h.api, "POST", `/workspaces/${ws}/releases`, {})).status).toBe(409);
    await h.sql.query(`update deployment_lease set deadline_at = now() - interval '1 second'`);
    // Any agent call moves the machine: the deadline is evaluated with the database clock.
    expect((await agentCall(base, c.token, "GET", "v2/deployments/current")).status).toBe(200);
    expect((await history(dep.revision)).slice(-2)).toEqual(["degraded", "failed"]);
    expect((await h.sql.query(`select revision from deployment_lease`)).rows[0].revision).toBeNull();
    // The lease is free again: the next deployment supersedes the failed one.
    const next = await publish();
    expect((await history(dep.revision)).at(-1)).toBe("superseded");
    expect(next.revision).toBe(dep.revision + 1);
  });

  it("returns a v2 cluster to v1 only with a v1 snapshot to return to, keeping the history", async () => {
    const refused = await v2(h.api, "PUT", `/clusters/${c.id}/delivery-protocol`, { protocol: "v1", reason: "controlled return drill" });
    expect(refused.body.code).toBe("no-v1-snapshot");
    await h.api("POST", `/environments/${c.env}/services`, { name: uniq("svc"), protocol: "http", host: "echo", port: 80 });
    expect((await h.api("POST", `/environments/${c.env}/snapshots`, {})).status).toBe(201);
    // The revision of the case before still waits for this cluster's node and holds the lease.
    const waiting = await latest();
    expect((await h.sql.query(`select revision from deployment_lease`)).rows[0].revision).toBe(waiting.revision);
    const back = await v2(h.api, "PUT", `/clusters/${c.id}/delivery-protocol`, { protocol: "v1", reason: "controlled return drill" });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body.deliveryProtocol).toBe("v1");
    // No expected node left: the revision stops waiting (nothing activated) and the lease is free.
    expect((await history(waiting.revision)).at(-1)).toBe("converged");
    expect((await h.sql.query(`select revision from deployment_lease`)).rows[0].revision).toBeNull();
    expect((await h.sql.query(`select count(*)::int as n from content_activations where deployment_revision = $1`, [waiting.revision])).rows[0].n).toBe(0);
    expect((await agentCall(base, c.token, "GET", "v1/snapshots/current")).status).toBe(200);
    expect((await agentCall(base, c.token, "GET", "v2/deployments/current")).body!.code).toBe("delivery-protocol-v1");
    expect((await status({})).body!.code).toBe("delivery-protocol-v1");
    expect((await h.sql.query(`select count(*)::int as n from deployments`)).rows[0].n).toBeGreaterThanOrEqual(4);
  });

  it("refuses an outdated epoch once a newer one exists, and every history follows the contract machine", async () => {
    // A newer epoch (as the snapshots -> releases migration will open): the cluster is v2 again to report.
    await h.sql.query(`update clusters set delivery_protocol = 'v2' where id = $1`, [c.id]);
    const last = await latest();
    const config = enc.sealJson(enc.openJson(last.config, deploymentContext(1, last.revision)), deploymentContext(2, 1));
    await h.sql.query(
      `insert into deployments (epoch, revision, members, expected_nodes, config, config_hash, kong_config_hash, reason, created_by) select 2, 1, members, '[]', $2, config_hash, kong_config_hash, 'publish', created_by from deployments where epoch = 1 and revision = $1`,
      [last.revision, JSON.stringify(config)],
    );
    await h.sql.query(`insert into deployment_states (epoch, revision, seq, state, reason) values (2, 1, 1, 'composed', 't'), (2, 1, 2, 'active', 't')`);
    expect((await status({ epoch: 1 })).body!.code).toBe("epoch-outdated");
    // The verified revision belongs to its epoch: revision 1 of epoch 2 is no regression of epoch 1's.
    await h.sql.query(`update cluster_nodes set failure_reason = null where node_id = 'node-1'`);
    expect((await status({ epoch: 2, ...applied({ revision: 1, config_hash: last.config_hash, kong_config_hash: last.kong_config_hash }) })).status).toBe(204);

    const rows = (await h.sql.query(`select epoch, revision, state from deployment_states order by epoch, revision, seq`)).rows as { epoch: number; revision: number; state: string }[];
    const histories = new Map<string, string[]>();
    for (const r of rows) histories.set(`${r.epoch}/${r.revision}`, [...(histories.get(`${r.epoch}/${r.revision}`) ?? []), r.state]);
    for (const [key, states] of histories) {
      expect(MACHINE.initial, key).toContain(states[0]);
      for (let i = 1; i < states.length; i++) expect(EDGES.has(`${states[i - 1]}>${states[i]}`), `${key}: ${states.join(" > ")}`).toBe(true);
    }
  });
});
