import { readFileSync } from "node:fs";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject, randomUUID, sign, verify } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentContractsV2, contractsV2 } from "../../src/common/contract.js";
import { ENCRYPTOR, type Encryptor, instanceSigningKeyContext } from "../../src/crypto/crypto.js";
import { runMigrations } from "../../src/db/migrate.js";
import type { Jws } from "../../src/instance/signing-keys.js";
import { type ApiClient, startHarness, uniq, type Harness } from "./harness.js";

// N2-D3a: isolation admissions, probe report chains, pendencies and releases in the control plane (agent protocol v2,
// control-plane-v2 getClusterIsolation and releaseIsolationContainment). A database of its own: the instance keys are
// instance-wide and the tests revoke them.
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://gromesh:gromesh@127.0.0.1:5432/gromesh";
const name = `gromesh_isolation_${Date.now()}_${process.pid}`;
const justification = "isolation drill of the test suite";
const text = (b64: string) => Buffer.from(b64, "base64url").toString("utf8");
const b64 = (value: string | Buffer) => Buffer.from(value).toString("base64url");

/** The reference verifier of the contract's Signatures, for instance-signed documents. */
function acceptsInstance(jws: Jws, typ: string, trust: { kid: string; publicKey: string }[]): Record<string, unknown> | null {
  const json = text(jws.protected);
  const seen = [...json.matchAll(/"((?:[^"\\]|\\.)*)"\s*:/g)].map((m) => m[1]);
  const header = JSON.parse(json) as Record<string, unknown>;
  if (new Set(seen).size !== seen.length || seen.length !== 3 || header.alg !== "EdDSA" || header.typ !== typ) return null;
  const x = trust.find((k) => k.kid === header.kid)?.publicKey;
  if (!x) return null;
  const ok = verify(null, Buffer.from(`${jws.protected}.${jws.payload}`, "ascii"), createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" }), Buffer.from(jws.signature, "base64url"));
  return ok ? (JSON.parse(text(jws.payload)) as Record<string, unknown>) : null;
}

/** A pod's isolation-probe: its own key, its seq and the digest of its last signed payload. */
class Probe {
  readonly key: KeyObject;
  readonly publicKey: string;
  seq = 0;
  prev: string | null = null;
  constructor(
    readonly podUid = randomUUID(),
    readonly bootId = randomUUID(),
    readonly nodeName = "worker-1",
  ) {
    const pair = generateKeyPairSync("ed25519");
    this.key = pair.privateKey;
    this.publicKey = pair.publicKey.export({ format: "jwk" }).x!;
  }
  request() {
    return { podUid: this.podUid, podName: `kong-${this.podUid.slice(0, 5)}`, nodeName: this.nodeName, bootId: this.bootId, probePublicKey: this.publicKey };
  }
  /** Signs any payload text with any header: the building block of the negative controls. */
  signRaw(payload: string, header = '{"alg":"EdDSA","typ":"gromesh-probe-report+json"}', key = this.key): Jws {
    const p = b64(header);
    const body = b64(payload);
    return { protected: p, payload: body, signature: sign(null, Buffer.from(`${p}.${body}`, "ascii"), key).toString("base64url") };
  }
  claims(clusterId: string, admissionId: string, extra: Record<string, unknown> = {}, seq = this.seq + 1, prev = this.prev) {
    return { clusterId, podUid: this.podUid, bootId: this.bootId, admissionId, seq, prevDigest: seq === 1 ? null : prev, state: "ok", failedCapabilities: [], challenge: null, leaseRemainingMs: 30000, final: false, ...extra };
  }
  /** The next report of its chain. */
  next(clusterId: string, admissionId: string, extra: Record<string, unknown> = {}): Jws {
    const payload = JSON.stringify(this.claims(clusterId, admissionId, extra));
    this.seq++;
    this.prev = `sha256:${createHash("sha256").update(payload).digest("hex")}`;
    return this.signRaw(payload);
  }
}

describe("isolation admissions and reports (N2-D3a)", () => {
  let h: Harness;
  let replica: Harness;
  let enc: Encryptor;
  let base: string;
  let replicaBase: string;
  let dbUrl: string;
  const v2 = (client: ApiClient, method: string, path: string, body?: unknown, headers?: Record<string, string>) => client(method, `/../v2${path}`, body, headers);
  const trust = async () => ((await v2(h.api, "GET", "/instance/signing-keys")).body.items as { kid: string; publicKey: string; status: string }[]).filter((k) => k.status !== "revoked");
  const ensureKey = async () => {
    if ((await trust()).some((k) => k.status === "active")) return;
    expect((await v2(h.api, "POST", "/instance/signing-keys", { validUntil: new Date(Date.now() + 30 * 86_400_000).toISOString() })).status).toBe(201);
  };

  async function agent(token: string, method: string, path: string, body?: unknown, server = base) {
    const res = await fetch(`${server}/agent/v2/isolation${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, body: raw ? JSON.parse(raw) : undefined };
  }

  /** A fresh cluster with one registered node: every scenario has its own admissions and pendencies. */
  async function cluster() {
    const env = (await h.api("POST", "/environments", { name: uniq("iso") })).body.id as string;
    const created = await h.api("POST", `/environments/${env}/clusters`, { name: "edge" });
    expect(created.status).toBe(201);
    const registered = await fetch(`${base}/agent/v1/register`, {
      method: "POST",
      headers: { authorization: `Bearer ${created.body.registrationToken}`, "content-type": "application/json" },
      body: JSON.stringify({ nodeId: "node-1", hostname: "host", kongVersion: "3.9.4", agentVersion: "0.2.0" }),
    });
    const node = (await registered.json()) as { nodeToken: string; clusterId: string };
    const c = {
      envId: env,
      id: node.clusterId,
      token: node.nodeToken,
      call: (method: string, path: string, body?: unknown, server = base) => agent(node.nodeToken, method, path, body, server),
      ask: async (probe: Probe) => {
        const res = await agent(node.nodeToken, "POST", "/admission-requests", probe.request());
        expect(res.status, JSON.stringify(res.body)).toBe(202);
        return res.body as { requestId: string; outcome: string; challenge: string };
      },
      poll: async (requestId: string, server = base) => {
        const res = await agent(node.nodeToken, "GET", `/admission-requests/${requestId}`, undefined, server);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        const validate = agentContractsV2.validator("AdmissionRequestStatus");
        expect(validate(structuredClone(res.body)), JSON.stringify(validate.errors)).toBe(true);
        return res.body as { requestId: string; outcome: string; challenge: string; admission?: Jws; reason?: string };
      },
      send: async (...reports: Jws[]) => {
        const res = await agent(node.nodeToken, "POST", "/reports", { reports });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        const validate = agentContractsV2.validator("ReportAcks");
        expect(validate(structuredClone(res.body)), JSON.stringify(validate.errors)).toBe(true);
        return res.body as { acks: { admissionId: string; ackedSeq: number }[]; rejected: { index: number; reason: string }[] };
      },
      isolation: async () => {
        const res = await v2(h.api, "GET", `/clusters/${node.clusterId}/isolation`);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        const validate = contractsV2.validator("ClusterIsolation");
        expect(validate(structuredClone(res.body)), JSON.stringify(validate.errors)).toBe(true);
        return res.body as { pods: Record<string, unknown>[]; pendencies: { id: string; kind: string; releasable: boolean; capability: string | null; podUid: string | null }[] };
      },
    };
    return c;
  }
  type Cluster = Awaited<ReturnType<typeof cluster>>;

  /** Admits a probe whose cluster has no other open admission (or whose others already answered). */
  async function admit(c: Cluster, probe: Probe) {
    const asked = await c.ask(probe);
    const status = await c.poll(asked.requestId);
    expect(status.outcome, JSON.stringify(status)).toBe("granted");
    const claims = acceptsInstance(status.admission!, "gromesh-admission+json", await trust());
    expect(claims).not.toBeNull();
    return { requestId: asked.requestId, admissionId: claims!.admissionId as string, claims: claims!, jws: status.admission! };
  }
  const pendencyRows = async (clusterId: string) => (await h.sql.query("select * from isolation_pendencies where cluster_id = $1 order by opened_at", [clusterId])).rows;
  const reportCount = async (admissionId: string) => (await h.sql.query("select count(*)::int as n from isolation_reports where admission_id = $1", [admissionId])).rows[0].n as number;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}"`);
    await admin.end();
    const url = new URL(ADMIN_URL);
    url.pathname = `/${name}`;
    dbUrl = url.toString();
    await runMigrations(dbUrl);
    h = await startHarness({ databaseUrl: url.toString() });
    replica = await startHarness({ databaseUrl: url.toString() });
    enc = h.app.get<Encryptor>(ENCRYPTOR);
    base = (await h.app.getUrl()).replace("[::1]", "127.0.0.1");
    replicaBase = (await replica.app.getUrl()).replace("[::1]", "127.0.0.1");
    await ensureKey();
  }, 120_000);
  afterAll(async () => {
    await replica?.close();
    await h?.close();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  }, 60_000);

  it("records the request with a new challenge before deciding, then grants it signed after recording", async () => {
    const c = await cluster();
    const probe = new Probe();
    const asked = await c.ask(probe);
    expect(asked).toMatchObject({ outcome: "pending" });
    expect(asked.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Recorded and committed before any decision; the challenge is the cluster's latest.
    const [row] = (await h.sql.query("select outcome, admission_id, challenge from isolation_admissions where id = $1", [asked.requestId])).rows;
    expect(row).toEqual({ outcome: "pending", admission_id: null, challenge: asked.challenge });
    expect((await c.call("GET", "/challenge")).body).toEqual({ challenge: asked.challenge });
    const granted = await c.poll(asked.requestId);
    expect(granted.outcome).toBe("granted");
    expect(granted.challenge).toBe(asked.challenge);
    const keys = await trust();
    const claims = acceptsInstance(granted.admission!, "gromesh-admission+json", keys)!;
    expect(claims).toMatchObject({ clusterId: c.id, podUid: probe.podUid, nodeName: "worker-1", bootId: probe.bootId, probePublicKey: probe.publicKey });
    expect(agentContractsV2.validator("AdmissionClaims")(claims)).toBe(true);
    expect(Object.keys(claims)).toEqual(["clusterId", "podUid", "nodeName", "bootId", "admissionId", "probePublicKey", "startDeadline"]);
    const deadline = Date.parse(claims.startDeadline as string) - Date.now();
    expect(deadline).toBeGreaterThan(4 * 60_000);
    expect(deadline).toBeLessThanOrEqual(5 * 60_000 + 5_000);
    // Negative control of the verifier: the same document is not a release, nor trusted without its key.
    expect(acceptsInstance(granted.admission!, "gromesh-isolation-release+json", keys)).toBeNull();
    expect(acceptsInstance(granted.admission!, "gromesh-admission+json", [])).toBeNull();
    const [stored] = (await h.sql.query("select admission_id, kid, state, admission from isolation_admissions where id = $1", [asked.requestId])).rows;
    expect(stored).toMatchObject({ admission_id: claims.admissionId, state: "open", admission: granted.admission });
    expect(keys.map((k) => k.kid)).toContain(stored.kid);
    // Decided once: the poll answers the same document; no pending challenge is left.
    expect((await c.poll(asked.requestId)).admission).toEqual(granted.admission);
    expect((await c.call("GET", "/challenge")).body).toEqual({ challenge: null });
    const actions = (await h.sql.query("select action from audit_events where entity_id in ($1, $2) order by at", [asked.requestId, claims.admissionId])).rows.map((r) => r.action);
    expect(actions).toEqual(["isolation.admission.request", "isolation.admission.grant"]);
  });

  it("refuses repeated, malformed and foreign requests", async () => {
    const c = await cluster();
    const other = await cluster();
    const probe = new Probe();
    const asked = await c.ask(probe);
    // The same (podUid, bootId) while pending, and once granted.
    expect((await c.call("POST", "/admission-requests", probe.request())).status).toBe(409);
    await c.poll(asked.requestId);
    expect((await c.call("POST", "/admission-requests", { ...probe.request(), probePublicKey: new Probe().publicKey })).status).toBe(409);
    for (const body of [{ ...probe.request(), bootId: "x" }, { ...probe.request(), probePublicKey: "short" }, { ...new Probe().request(), extra: 1 }]) {
      expect((await c.call("POST", "/admission-requests", body)).status, JSON.stringify(body)).toBe(422);
    }
    // Another cluster's request is unknown here; no node token, no answer.
    expect((await other.call("GET", `/admission-requests/${asked.requestId}`)).status).toBe(404);
    expect((await c.call("GET", `/admission-requests/${randomUUID()}`)).status).toBe(404);
    expect((await agent("A".repeat(43), "GET", "/challenge")).status).toBe(401);
    expect((await agent("A".repeat(43), "POST", "/admission-requests", new Probe().request())).status).toBe(401);
    expect((await (await fetch(`${base}/agent/v2/isolation/releases`)).status)).toBe(401);
  });

  it("holds a new admission until every other open admission answers its challenge in a contiguous chain", async () => {
    const c = await cluster();
    const pa = new Probe();
    const a = await admit(c, pa);
    const pb = new Probe();
    const b = await c.ask(pb);
    expect((await c.poll(b.requestId)).outcome).toBe("pending");
    // A reports, but not this challenge: still pending.
    expect(await c.send(pa.next(c.id, a.admissionId, { challenge: "Q2hhbGxlbmdlLW5vdC10aGlzLW9uZS0x" }))).toEqual({ acks: [{ admissionId: a.admissionId, ackedSeq: 1 }], rejected: [] });
    expect((await c.poll(b.requestId)).outcome).toBe("pending");
    // A answers it: B is granted.
    await c.send(pa.next(c.id, a.admissionId, { challenge: b.challenge }));
    const bGranted = await c.poll(b.requestId);
    expect(bGranted.outcome).toBe("granted");
    const bAdmission = acceptsInstance(bGranted.admission!, "gromesh-admission+json", await trust())!;
    // C needs A and B. A answers after a gap: not contiguous, not an answer, until the gap is filled.
    const pc = new Probe();
    const cReq = await c.ask(pc);
    const seq3 = pa.next(c.id, a.admissionId);
    const seq4 = pa.next(c.id, a.admissionId, { challenge: cReq.challenge });
    expect(JSON.parse(text(seq4.payload)).seq).toBe(4);
    expect(await c.send(seq4)).toEqual({ acks: [{ admissionId: a.admissionId, ackedSeq: 2 }], rejected: [] });
    // B answers; A's answer is still behind the gap.
    await c.send(pb.next(c.id, bAdmission.admissionId as string, { challenge: cReq.challenge }));
    expect((await c.poll(cReq.requestId)).outcome).toBe("pending");
    expect(await c.send(seq3)).toEqual({ acks: [{ admissionId: a.admissionId, ackedSeq: 4 }], rejected: [] });
    expect((await c.poll(cReq.requestId)).outcome).toBe("granted");
  });

  it("admits only on the cluster's current challenge: an answer to a superseded one grants nothing", async () => {
    const c = await cluster();
    const pa = new Probe();
    const a = await admit(c, pa);
    const b = await c.ask(new Probe());
    // A answers B's challenge, then another request supersedes it before B is decided.
    await c.send(pa.next(c.id, a.admissionId, { challenge: b.challenge }));
    const pd = new Probe();
    const d = await c.ask(pd);
    expect((await c.call("GET", "/challenge")).body).toEqual({ challenge: d.challenge });
    expect((await c.poll(b.requestId)).outcome).toBe("pending");
    // Control: the same answer to the current challenge admits D.
    await c.send(pa.next(c.id, a.admissionId, { challenge: d.challenge }));
    const dGranted = await c.poll(d.requestId);
    expect(dGranted.outcome).toBe("granted");
    // B is current again with its own challenge, but D (admitted since) has not answered it: still pending.
    expect((await c.call("GET", "/challenge")).body).toEqual({ challenge: b.challenge });
    expect((await c.poll(b.requestId)).outcome).toBe("pending");
    const dAdmission = acceptsInstance(dGranted.admission!, "gromesh-admission+json", await trust())!.admissionId as string;
    await c.send(pd.next(c.id, dAdmission, { challenge: b.challenge }));
    expect((await c.poll(b.requestId)).outcome).toBe("granted");
  });

  it("orders the cluster's challenges as recorded under its lock, never by when a transaction began", async () => {
    const c = await cluster();
    const pa = new Probe();
    const a = await admit(c, pa);
    const y = await c.ask(new Probe());
    const x = await c.ask(new Probe());
    // X recorded after Y, but its transaction began first (its timestamp is earlier): X's challenge is still current.
    await h.sql.query("update isolation_admissions set requested_at = (select requested_at from isolation_admissions where id = $2) - interval '1 second' where id = $1", [x.requestId, y.requestId]);
    expect((await c.call("GET", "/challenge")).body).toEqual({ challenge: x.challenge });
    await c.send(pa.next(c.id, a.admissionId, { challenge: y.challenge }));
    expect((await c.poll(y.requestId)).outcome).toBe("pending");
    // Control: the answer to the current one admits X.
    await c.send(pa.next(c.id, a.admissionId, { challenge: x.challenge }));
    expect((await c.poll(x.requestId)).outcome).toBe("granted");
    const seqs = (await h.sql.query("select challenge_seq from isolation_admissions where cluster_id = $1 order by challenge_seq", [c.id])).rows.map((r) => r.challenge_seq);
    expect(seqs).toEqual([1, 2, 3]);
  });

  it("assigns one challenge order per cluster even when replicas record requests at once", async () => {
    const c = await cluster();
    const asked = await Promise.all(Array.from({ length: 6 }, (_, i) => c.call("POST", "/admission-requests", new Probe().request(), i % 2 ? replicaBase : base)));
    expect(asked.map((r) => r.status)).toEqual([202, 202, 202, 202, 202, 202]);
    const { rows } = await h.sql.query("select challenge from isolation_admissions where cluster_id = $1 order by challenge_seq desc limit 1", [c.id]);
    expect((await c.call("GET", "/challenge")).body).toEqual({ challenge: rows[0].challenge });
    expect((await h.sql.query("select array_agg(challenge_seq order by challenge_seq) as s from isolation_admissions where cluster_id = $1", [c.id])).rows[0].s).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("decides each violation after a release by its own seq: one after a pass, above a gap, opens a pendency", async () => {
    const c = await cluster();
    const pa = new Probe();
    const a = await admit(c, pa);
    await c.send(pa.next(c.id, a.admissionId, { state: "violation", failedCapabilities: ["CAP-3"] }));
    const [first] = (await c.isolation()).pendencies;
    expect((await v2(h.api, "POST", `/clusters/${c.id}/isolation-releases`, { pendencyId: first!.id, justification })).status).toBe(201);
    // seq 2 passes (the probe took the release), seq 3 is missing, seq 4 is a new violation.
    const pass = pa.next(c.id, a.admissionId, { state: "verifying" });
    pa.next(c.id, a.admissionId);
    const fresh = pa.next(c.id, a.admissionId, { state: "violation", failedCapabilities: ["CAP-4"] });
    expect(await c.send(pass, fresh)).toEqual({ acks: [{ admissionId: a.admissionId, ackedSeq: 2 }], rejected: [] });
    expect((await c.isolation()).pendencies).toEqual([expect.objectContaining({ kind: "confirmed-violation", capability: "CAP-4" })]);
    // Control: sticky violations right after a release, in order, stay covered (also above a gap of violations).
    const c2 = await cluster();
    const pq = new Probe();
    const q = await admit(c2, pq);
    await c2.send(pq.next(c2.id, q.admissionId, { state: "violation", failedCapabilities: ["CAP-3"] }));
    const [p2] = (await c2.isolation()).pendencies;
    expect((await v2(h.api, "POST", `/clusters/${c2.id}/isolation-releases`, { pendencyId: p2!.id, justification })).status).toBe(201);
    const sticky = pq.next(c2.id, q.admissionId, { state: "violation", failedCapabilities: ["CAP-3"] });
    const stickyAgain = pq.next(c2.id, q.admissionId, { state: "violation", failedCapabilities: ["CAP-3"] });
    expect(await c2.send(sticky, stickyAgain)).toEqual({ acks: [{ admissionId: q.admissionId, ackedSeq: 3 }], rejected: [] });
    expect((await c2.isolation()).pendencies).toEqual([]);
  });

  it("counts an authenticated violation when it arrives, even above a gap, and never an answer with reports waiting there", async () => {
    const c = await cluster();
    const pa = new Probe();
    const a = await admit(c, pa);
    const b = await c.ask(new Probe());
    const clean = pa.next(c.id, a.admissionId, { challenge: b.challenge });
    pa.next(c.id, a.admissionId);
    const violation = pa.next(c.id, a.admissionId, { state: "violation", failedCapabilities: ["CAP-2"] });
    expect(await c.send(clean, violation)).toEqual({ acks: [{ admissionId: a.admissionId, ackedSeq: 1 }], rejected: [] });
    expect((await pendencyRows(c.id)).map((p) => [p.lifecycle, p.capability, p.admission_id])).toEqual([["confirmed-violation", "CAP-2", a.admissionId]]);
    expect(await c.poll(b.requestId)).toMatchObject({ outcome: "refused", reason: "pendency-open" });
    // Control: the same gap with a clean report above it opens nothing, but B waits until the gap is filled.
    const c2 = await cluster();
    const pq = new Probe();
    const q = await admit(c2, pq);
    const e = await c2.ask(new Probe());
    const answer = pq.next(c2.id, q.admissionId, { challenge: e.challenge });
    const missing = pq.next(c2.id, q.admissionId);
    const above = pq.next(c2.id, q.admissionId);
    expect(await c2.send(answer, above)).toEqual({ acks: [{ admissionId: q.admissionId, ackedSeq: 1 }], rejected: [] });
    expect(await pendencyRows(c2.id)).toEqual([]);
    expect((await c2.poll(e.requestId)).outcome).toBe("pending");
    await c2.send(missing);
    expect((await c2.poll(e.requestId)).outcome).toBe("granted");
  });

  it("decides a cluster's requests one at a time across replicas: two at once never admit each other unanswered", async () => {
    const c = await cluster();
    const asked = await Promise.all([new Probe(), new Probe(), new Probe()].map((p) => c.ask(p)));
    const decided = await Promise.all(asked.map((r, i) => c.poll(r.requestId, i % 2 ? replicaBase : base)));
    expect(decided.map((d) => d.outcome).sort()).toEqual(["granted", "pending", "pending"]);
  });

  it("never grants by time: after 45 s on the control plane's clock the request is refused (timeout), and may be asked again", async () => {
    const c = await cluster();
    const pa = new Probe();
    await admit(c, pa);
    const pb = new Probe();
    const b = await c.ask(pb);
    expect((await c.poll(b.requestId)).outcome).toBe("pending");
    await h.sql.query("update isolation_admissions set requested_at = now() - interval '46 seconds' where id = $1", [b.requestId]);
    expect(await c.poll(b.requestId)).toMatchObject({ outcome: "refused", reason: "timeout" });
    expect((await c.call("GET", "/challenge")).body).toEqual({ challenge: null });
    // Refused once, it stays refused, and a new request (new challenge) is recorded.
    expect((await c.poll(b.requestId)).outcome).toBe("refused");
    const again = await c.ask(pb);
    expect(again.challenge).not.toBe(b.challenge);
    expect((await c.poll(again.requestId)).outcome).toBe("pending");
    // Control: 44 s is not yet a timeout.
    await h.sql.query("update isolation_admissions set requested_at = now() - interval '44 seconds' where id = $1", [again.requestId]);
    expect((await c.poll(again.requestId)).outcome).toBe("pending");
  });

  it("measures the 45 s on the clock read after the cluster's lock, not when the poll began", { timeout: 60_000 }, async () => {
    const c = await cluster();
    const asked = await c.ask(new Probe());
    await h.sql.query("update isolation_admissions set requested_at = clock_timestamp() - interval '43 seconds' where id = $1", [asked.requestId]);
    const holder = new pg.Client({ connectionString: dbUrl });
    await holder.connect();
    let polled!: Promise<{ status: number; body: { outcome: string; reason?: string } }>;
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock($1, hashtext($2))", [0x6772_6973, c.id]);
      polled = c.call("GET", `/admission-requests/${asked.requestId}`);
      // The poll waits on the lock from before the 45 s until after them.
      for (let i = 0; ; i++) {
        const { rows } = await h.sql.query("select count(*)::int as n from pg_locks l join pg_stat_activity a on a.pid = l.pid where not l.granted and a.datname = current_database()");
        if (rows[0].n > 0) break;
        if (i > 300) throw new Error("the poll never waited on the lock");
        await new Promise((r) => setTimeout(r, 10));
      }
      expect((await h.sql.query("select requested_at > clock_timestamp() - interval '45 seconds' as early from isolation_admissions where id = $1", [asked.requestId])).rows[0].early).toBe(true);
      while ((await h.sql.query("select requested_at > clock_timestamp() - interval '45.2 seconds' as early from isolation_admissions where id = $1", [asked.requestId])).rows[0].early) await new Promise((r) => setTimeout(r, 100));
    } finally {
      await holder.query("commit").catch(() => undefined);
      await holder.end();
    }
    const res = await polled;
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: "refused", reason: "timeout" });
  });

  it("verifies every report with the probe key bound to its admission, before reading it, and refuses anything else", async () => {
    const c = await cluster();
    const pa = new Probe();
    const a = await admit(c, pa);
    const pb = new Probe();
    const b = await c.ask(pb);
    await c.send(pa.next(c.id, a.admissionId, { challenge: b.challenge }));
    const bAdmission = acceptsInstance((await c.poll(b.requestId)).admission!, "gromesh-admission+json", await trust())!;
    const other = await cluster();
    const stranger = new Probe();
    const good = JSON.stringify(pa.claims(c.id, a.admissionId));
    const bad: [string, Jws, string][] = [
      ["a key bound to no admission", pa.signRaw(good, undefined, stranger.key), "bad-signature"],
      ["the key of another admission, naming this one", pb.signRaw(good), "unknown-admission"],
      ["kid in the header", pa.signRaw(good, '{"alg":"EdDSA","kid":"x","typ":"gromesh-probe-report+json"}'), "bad-signature"],
      ["embedded jwk", pa.signRaw(good, `{"alg":"EdDSA","typ":"gromesh-probe-report+json","jwk":{"kty":"OKP","crv":"Ed25519","x":"${pa.publicKey}"}}`), "bad-signature"],
      ["no typ", pa.signRaw(good, '{"alg":"EdDSA"}'), "bad-signature"],
      ["the admission typ", pa.signRaw(good, '{"alg":"EdDSA","typ":"gromesh-admission+json"}'), "bad-signature"],
      ["duplicated header member", pa.signRaw(good, '{"alg":"EdDSA","typ":"gromesh-probe-report+json","typ":"gromesh-probe-report+json"}'), "bad-signature"],
      ["alg none", pa.signRaw(good, '{"alg":"none","typ":"gromesh-probe-report+json"}'), "bad-signature"],
      ["crit header member", pa.signRaw(good, '{"alg":"EdDSA","typ":"gromesh-probe-report+json","crit":["exp"]}'), "bad-signature"],
      ["payload member outside ProbeReport", pa.signRaw(JSON.stringify({ ...JSON.parse(good), extra: 1 })), "bad-signature"],
      ["duplicated payload member", pa.signRaw(good.replace('"seq":2', '"seq":2,"seq":2')), "bad-signature"],
      ["payload changed after signing", { ...pa.signRaw(good), payload: b64(good.replace('"ok"', '"no-proof"')) }, "bad-signature"],
      ["an instance-signed document", (await c.poll(b.requestId)).admission!, "bad-signature"],
      ["another pod", pa.signRaw(JSON.stringify({ ...JSON.parse(good), podUid: randomUUID() })), "other-pod"],
      ["another boot", pa.signRaw(JSON.stringify({ ...JSON.parse(good), bootId: randomUUID() })), "other-boot"],
      ["another cluster", pa.signRaw(JSON.stringify({ ...JSON.parse(good), clusterId: other.id })), "unknown-admission"],
      ["an unknown admission", pa.signRaw(JSON.stringify({ ...JSON.parse(good), admissionId: randomUUID() })), "unknown-admission"],
    ];
    expect(good).toContain('"seq":2');
    const before = await reportCount(a.admissionId);
    const res = await c.send(...bad.map(([, jws]) => jws));
    expect(res.rejected).toEqual(bad.map(([, , reason], index) => ({ index, reason })));
    expect(res.acks).toEqual([]);
    expect(await reportCount(a.admissionId)).toBe(before);
    expect(await reportCount(bAdmission.admissionId as string)).toBe(0);
    // Through another cluster's node token, a valid report of this cluster is unknown there.
    const valid = pa.next(c.id, a.admissionId);
    expect((await other.send(valid)).rejected).toEqual([{ index: 0, reason: "bad-signature" }]);
    // Control: the same valid report through its own cluster is accepted.
    expect(await c.send(valid)).toEqual({ acks: [{ admissionId: a.admissionId, ackedSeq: 2 }], rejected: [] });
    expect((await c.call("POST", "/reports", { reports: [] })).status).toBe(422);
    expect((await c.call("POST", "/reports", { reports: [{ protected: "a", payload: "b" }] })).status).toBe(422);
  });

  it("accepts the contract vector's probe report byte for byte from the probe key bound to its admission", async () => {
    const vector = JSON.parse(readFileSync(new URL("../../../../contracts/examples/isolation-signatures.example.json", import.meta.url), "utf8"));
    const claims = vector.admissionClaims as Record<string, string>;
    const seed = Buffer.from(vector.testOnlySeedsHex.probe, "hex");
    const probe = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
    expect(createPublicKey(probe).export({ format: "jwk" }).x).toBe(claims.probePublicKey);
    // The vector's cluster, node and admission, as the control plane would hold them.
    const env = (await h.api("POST", "/environments", { name: uniq("vector") })).body.id as string;
    const token = "V".repeat(43);
    await h.sql.query("insert into clusters (id, environment_id, name, registration_token_hash) values ($1, $2, 'vector', $3)", [claims.clusterId, env, createHash("sha256").update("unused-registration").digest("hex")]);
    await h.sql.query("insert into cluster_nodes (cluster_id, node_id, token_hash, hostname, kong_version, agent_version) values ($1, 'node-v', $2, 'h', '3.9.4', '0.2.0')", [claims.clusterId, createHash("sha256").update(token).digest("hex")]);
    await h.sql.query(
      `insert into isolation_admissions (cluster_id, node_id, pod_uid, pod_name, node_name, boot_id, probe_public_key, challenge, challenge_seq, outcome, decided_at, admission_id, state, admission, kid)
       values ($1, 'node-v', $2, 'kong-v', $3, $4, $5, $6, 1, 'granted', now(), $7, 'open', $8, $9)`,
      [claims.clusterId, claims.podUid, claims.nodeName, claims.bootId, claims.probePublicKey, vector.reportClaims.challenge, claims.admissionId, JSON.stringify(vector.admission), vector.trustSet.keys[0].kid],
    );
    const send = (reports: Jws[]) => agent(token, "POST", "/reports", { reports });
    // An instance-signed document (and every mustRefuse case) is never a report.
    const refused = await send([vector.admission, ...vector.mustRefuse.map((m: { jws: Jws }) => m.jws)]);
    expect(refused.body.rejected.every((r: { reason: string }) => r.reason === "bad-signature")).toBe(true);
    expect(refused.body.rejected).toHaveLength(1 + vector.mustRefuse.length);
    const accepted = await send([vector.report]);
    expect(accepted.body).toEqual({ acks: [{ admissionId: claims.admissionId, ackedSeq: 1 }], rejected: [] });
    const [row] = (await h.sql.query("select digest, challenge, state from isolation_reports where admission_id = $1 and seq = 1", [claims.admissionId])).rows;
    expect(row).toEqual({ digest: `sha256:${createHash("sha256").update(Buffer.from(vector.report.payload, "base64url")).digest("hex")}`, challenge: vector.reportClaims.challenge, state: "ok" });
  });

  it("keeps a gap until filled, acks once repeated identical reports, and opens confirmed-violation on a fork of the chain", async () => {
    const c = await cluster();
    const pa = new Probe();
    const a = await admit(c, pa);
    const r1 = pa.next(c.id, a.admissionId);
    const r2 = pa.next(c.id, a.admissionId);
    const r3 = pa.next(c.id, a.admissionId);
    expect(await c.send(r1, r3)).toEqual({ acks: [{ admissionId: a.admissionId, ackedSeq: 1 }], rejected: [] });
    // Stored behind the gap is a mutation too: audited with what arrived, the ack where the chain stops.
    const [stored] = (await h.sql.query("select actor, before, after from audit_events where action = 'isolation.reports' and entity_id = $1", [a.admissionId])).rows;
    expect(stored).toMatchObject({ actor: { type: "agent", id: "node-1" }, before: { ackedSeq: 0 }, after: { ackedSeq: 1, received: [1, 3] } });
    expect(await c.send(r1)).toEqual({ acks: [{ admissionId: a.admissionId, ackedSeq: 1 }], rejected: [] });
    expect(await c.send(r2)).toEqual({ acks: [{ admissionId: a.admissionId, ackedSeq: 3 }], rejected: [] });
    expect(await pendencyRows(c.id)).toEqual([]);
    // The same seq with other content: refused, and the cluster holds a confirmed violation.
    const fork = pa.signRaw(JSON.stringify(pa.claims(c.id, a.admissionId, { state: "inconclusive" }, 2, JSON.parse(text(r2.payload)).prevDigest)));
    expect(await c.send(fork)).toEqual({ acks: [], rejected: [{ index: 0, reason: "integrity-conflict" }] });
    const [p] = await pendencyRows(c.id);
    expect(p).toMatchObject({ lifecycle: "confirmed-violation", capability: "integrity-conflict", admission_id: a.admissionId });
    // A new admission of the cluster is refused while it is open.
    const asked = await c.ask(new Probe());
    expect(await c.poll(asked.requestId)).toMatchObject({ outcome: "refused", reason: "pendency-open" });
  });

  it("stops the chain where prevDigest is not the digest of the previous payload", async () => {
    const c = await cluster();
    const pa = new Probe();
    const a = await admit(c, pa);
    await c.send(pa.next(c.id, a.admissionId));
    const broken = pa.signRaw(JSON.stringify(pa.claims(c.id, a.admissionId, {}, 2, "sha256:" + "f".repeat(64))));
    expect(await c.send(broken)).toEqual({ acks: [{ admissionId: a.admissionId, ackedSeq: 1 }], rejected: [{ index: 0, reason: "integrity-conflict" }] });
    expect((await pendencyRows(c.id)).map((p) => [p.lifecycle, p.capability])).toEqual([["confirmed-violation", "integrity-conflict"]]);
  });

  it("opens confirmed-violation on a violation report, refuses admissions, and releases it only for the platform admin with CSRF", { timeout: 120_000 }, async () => {
    const c = await cluster();
    const pa = new Probe();
    const a = await admit(c, pa);
    await c.send(pa.next(c.id, a.admissionId, { state: "violation", failedCapabilities: ["CAP-3"] }));
    const view = await c.isolation();
    expect(view.pendencies).toEqual([expect.objectContaining({ kind: "confirmed-violation", capability: "CAP-3", releasable: true, podUid: pa.podUid, scope: "cluster" })]);
    expect(view.pods[0]).toMatchObject({ state: "violation", admission: "open", failedCapabilities: ["CAP-3"], lastSeq: 1 });
    const pendencyId = view.pendencies[0]!.id;
    const asked = await c.ask(new Probe());
    expect(await c.poll(asked.requestId)).toMatchObject({ outcome: "refused", reason: "pendency-open" });
    // Who may not release it.
    const editor = await h.as("editor");
    const workspaceAdmin = await h.as("viewer");
    expect((await v2(h.api, "POST", `/workspaces/${c.envId}/role-bindings`, { subjectType: "user", subjectId: workspaceAdmin.id, role: "workspace-admin" })).status).toBe(201);
    const token = (await h.api("POST", "/users/me/tokens", { name: uniq("iso"), role: "admin", expiresInDays: 1 })).body.token as string;
    const bearer: ApiClient = (method, path, body) => h.anonymous(method, path, body, { authorization: `Bearer ${token}` });
    const session = await h.login(h.admin.email, h.admin.password);
    const noCsrf: ApiClient = (method, path, body) => h.anonymous(method, path, body, { cookie: session.cookie! });
    const release = (client: ApiClient, body: unknown = { pendencyId, justification }, cluster = c.id) => v2(client, "POST", `/clusters/${cluster}/isolation-releases`, body);
    expect((await release(editor.api)).status).toBe(403);
    expect((await release(workspaceAdmin.api)).status).toBe(403);
    expect((await release(bearer)).status).toBe(401);
    expect((await release(noCsrf)).status).toBe(403);
    expect((await release(h.anonymous)).status).toBe(401);
    expect((await release(h.api, { pendencyId, justification: "short" })).status).toBe(422);
    expect((await release(h.api, { pendencyId: randomUUID(), justification })).status).toBe(404);
    expect((await release(h.api, { pendencyId, justification }, (await cluster()).id)).status).toBe(404);
    expect((await v2(editor.api, "GET", `/clusters/${c.id}/isolation`)).status).toBe(403);
    expect((await c.call("GET", "/releases")).body).toEqual({ items: [] });
    expect((await pendencyRows(c.id))[0].lifecycle).toBe("confirmed-violation");
    // The platform admin releases it: signed, served to the agents for 15 min, audited.
    const released = await release(h.api);
    expect(released.status, JSON.stringify(released.body)).toBe(201);
    expect((await release(h.api)).status).toBe(409);
    const { items } = (await c.call("GET", "/releases")).body as { items: Jws[] };
    expect(items).toHaveLength(1);
    const claims = acceptsInstance(items[0]!, "gromesh-isolation-release+json", await trust())!;
    expect(claims).toMatchObject({ clusterId: c.id, pendencyId, kind: "confirmed-violation" });
    expect(agentContractsV2.validator("IsolationReleaseClaims")(claims)).toBe(true);
    const ttl = Date.parse(claims.expiresAt as string) - Date.now();
    expect(ttl).toBeGreaterThan(14 * 60_000);
    expect(ttl).toBeLessThanOrEqual(15 * 60_000 + 5_000);
    expect(acceptsInstance(items[0]!, "gromesh-admission+json", await trust())).toBeNull();
    expect((await other(c)).items).toEqual([]);
    const [audited] = (await h.sql.query("select after from audit_events where action = 'isolation.release' and entity_id = $1", [pendencyId])).rows;
    expect(audited.after).toMatchObject({ justification, lifecycle: "released" });
    // The probe's sticky violation reports until it takes the release reopen nothing; a pass, then a new violation, does.
    await c.send(pa.next(c.id, a.admissionId, { state: "violation", failedCapabilities: ["CAP-3"] }));
    expect((await c.isolation()).pendencies).toEqual([]);
    await c.send(pa.next(c.id, a.admissionId, { state: "verifying" }));
    await c.send(pa.next(c.id, a.admissionId, { state: "violation", failedCapabilities: ["CAP-1"] }));
    expect((await c.isolation()).pendencies).toEqual([expect.objectContaining({ kind: "confirmed-violation", capability: "CAP-1" })]);
    // An expired release is no longer served.
    await h.sql.query("update isolation_releases set expires_at = now() - interval '1 second' where pendency_id = $1", [pendencyId]);
    expect((await c.call("GET", "/releases")).body).toEqual({ items: [] });

    async function other(of: Cluster) {
      const another = await cluster();
      expect(another.id).not.toBe(of.id);
      return (await another.call("GET", "/releases")).body as { items: Jws[] };
    }
  });

  it("names in a release every open admission of the pendency's scope, each through the seq acknowledged so far", async () => {
    const c = await cluster();
    const pa = new Probe();
    const a = await admit(c, pa);
    const pb = new Probe();
    const askB = await c.ask(pb);
    await c.send(pa.next(c.id, a.admissionId, { challenge: askB.challenge }));
    const b = acceptsInstance((await c.poll(askB.requestId)).admission!, "gromesh-admission+json", await trust())!.admissionId as string;
    await c.send(pb.next(c.id, b));
    // C closes (Kong stopped) before the release: no longer open, not named.
    const pc = new Probe();
    const askC = await c.ask(pc);
    await c.send(pa.next(c.id, a.admissionId, { challenge: askC.challenge }), pb.next(c.id, b, { challenge: askC.challenge }));
    const cAdmission = acceptsInstance((await c.poll(askC.requestId)).admission!, "gromesh-admission+json", await trust())!.admissionId as string;
    await c.send(pc.next(c.id, cAdmission, { final: true, finalReason: "pod-terminated", kongStopConfirmed: true }));
    // Another cluster's open admission is never named either.
    const other = await cluster();
    const elsewhere = await admit(other, new Probe());
    // A violates at seq 3; B's seq 4 arrives above a gap (seq 3 missing): stored, not acknowledged, not counted.
    expect((await c.send(pa.next(c.id, a.admissionId, { state: "violation", failedCapabilities: ["CAP-1"] }))).acks).toEqual([{ admissionId: a.admissionId, ackedSeq: 3 }]);
    pb.next(c.id, b);
    expect((await c.send(pb.next(c.id, b))).acks).toEqual([{ admissionId: b, ackedSeq: 2 }]);
    const [p] = (await c.isolation()).pendencies;
    expect((await v2(h.api, "POST", `/clusters/${c.id}/isolation-releases`, { pendencyId: p!.id, justification })).status).toBe(201);
    const [release] = ((await c.call("GET", "/releases")).body as { items: Jws[] }).items;
    const claims = acceptsInstance(release!, "gromesh-isolation-release+json", await trust())!;
    const validate = agentContractsV2.validator("IsolationReleaseClaims");
    expect(validate(structuredClone(claims)), JSON.stringify(validate.errors)).toBe(true);
    expect(Object.keys(claims)).toEqual(["clusterId", "pendencyId", "kind", "expiresAt", "admissions"]);
    expect(claims.admissions).toEqual([{ admissionId: a.admissionId, throughSeq: 3 }, { admissionId: b, throughSeq: 2 }]);
    const named = (claims.admissions as { admissionId: string }[]).map((x) => x.admissionId);
    expect(named).not.toContain(cAdmission);
    expect(named).not.toContain(elsewhere.admissionId);
    // Negative control of the schema: the same claims without admissions are not a release.
    const { admissions: _, ...without } = claims;
    expect(validate(without)).toBe(false);
  });

  it("an answer in violation is no answer: the chain must be clean from the answer on", async () => {
    const c = await cluster();
    const pa = new Probe();
    const a = await admit(c, pa);
    const b = await c.ask(new Probe());
    await c.send(pa.next(c.id, a.admissionId, { challenge: b.challenge, state: "violation", failedCapabilities: ["CAP-2"] }));
    expect(await c.poll(b.requestId)).toMatchObject({ outcome: "refused", reason: "pendency-open" });
    // Released, the next request is still held while the violation is the latest answer.
    const [p] = (await c.isolation()).pendencies;
    expect((await v2(h.api, "POST", `/clusters/${c.id}/isolation-releases`, { pendencyId: p!.id, justification })).status).toBe(201);
    const next = await c.ask(new Probe());
    await c.send(pa.next(c.id, a.admissionId, { challenge: next.challenge, state: "violation", failedCapabilities: ["CAP-2"] }));
    expect((await c.poll(next.requestId)).outcome).toBe("pending");
    await c.send(pa.next(c.id, a.admissionId, { challenge: next.challenge, state: "verifying" }));
    expect((await c.poll(next.requestId)).outcome).toBe("granted");
  });

  it("alerts a silent admission after 60 s without holding admissions, and turns it into unconfirmed-isolation after 10 min", { timeout: 120_000 }, async () => {
    const c = await cluster();
    const pa = new Probe();
    const a = await admit(c, pa);
    await c.send(pa.next(c.id, a.admissionId));
    await h.sql.query("update isolation_admissions set last_report_at = now() - interval '59 seconds' where admission_id = $1", [a.admissionId]);
    expect((await c.isolation()).pendencies).toEqual([]);
    await h.sql.query("update isolation_admissions set last_report_at = now() - interval '61 seconds' where admission_id = $1", [a.admissionId]);
    const view = await c.isolation();
    expect(view.pendencies).toEqual([expect.objectContaining({ kind: "communication-failure", releasable: false, scope: "cluster" })]);
    expect(view.pods[0]).toMatchObject({ reporting: "communication-failure" });
    const commId = view.pendencies[0]!.id;
    expect((await v2(h.api, "POST", `/clusters/${c.id}/isolation-releases`, { pendencyId: commId, justification })).status).toBe(409);
    // An alert only: a new admission is decided by the challenge rule.
    const pb = new Probe();
    const b = await c.ask(pb);
    expect((await c.poll(b.requestId)).outcome).toBe("pending");
    // The same chain resumes without violation: closed (chain-resumed), and that answer admits B.
    await c.send(pa.next(c.id, a.admissionId, { challenge: b.challenge }));
    expect((await pendencyRows(c.id)).map((p) => [p.lifecycle, p.close_reason])).toEqual([["closed", "chain-resumed"]]);
    expect((await c.poll(b.requestId)).outcome).toBe("granted");
    // 10 min without the chain: unconfirmed-isolation, which holds every new admission.
    const bAdmission = (await h.sql.query("select admission_id from isolation_admissions where id = $1", [b.requestId])).rows[0].admission_id as string;
    await h.sql.query("update isolation_admissions set last_report_at = now() - interval '61 seconds' where admission_id = $1", [a.admissionId]);
    await c.isolation();
    await h.sql.query("update isolation_admissions set last_report_at = now() - interval '601 seconds' where admission_id = $1", [a.admissionId]);
    const later = await c.isolation();
    const unconfirmed = later.pendencies.find((p) => p.kind === "unconfirmed-isolation")!;
    expect(unconfirmed).toMatchObject({ releasable: true, podUid: pa.podUid });
    expect(later.pods.find((p) => p.podUid === pa.podUid)).toMatchObject({ reporting: "unconfirmed-isolation" });
    const pc = new Probe();
    const cReq = await c.ask(pc);
    expect(await c.poll(cReq.requestId)).toMatchObject({ outcome: "refused", reason: "pendency-open" });
    // Released: the orphan admission is closed without proof and stops holding; the others still answer.
    expect((await v2(h.api, "POST", `/clusters/${c.id}/isolation-releases`, { pendencyId: unconfirmed.id, justification })).status).toBe(201);
    expect((await h.sql.query("select state, close_reason from isolation_admissions where admission_id = $1", [a.admissionId])).rows[0]).toEqual({ state: "closed-without-proof", close_reason: "released" });
    const dReq = await c.ask(new Probe());
    expect((await c.poll(dReq.requestId)).outcome).toBe("pending");
    await c.send(pb.next(c.id, bAdmission, { challenge: dReq.challenge }));
    expect((await c.poll(dReq.requestId)).outcome).toBe("granted");
  });

  it("closes an admission only with a final report confirming Kong stopped over a complete chain, or a node-reboot report", async () => {
    const c = await cluster();
    const pa = new Probe();
    const a = await admit(c, pa);
    await c.send(pa.next(c.id, a.admissionId));
    await c.send(pa.next(c.id, a.admissionId));
    const r3 = pa.next(c.id, a.admissionId);
    const r4 = pa.next(c.id, a.admissionId, { final: true, finalReason: "pod-terminated", kongStopConfirmed: true });
    // The final report behind a gap closes nothing until the chain is complete.
    await c.send(r4);
    expect((await h.sql.query("select state from isolation_admissions where admission_id = $1", [a.admissionId])).rows[0].state).toBe("open");
    const held = await c.ask(new Probe());
    expect((await c.poll(held.requestId)).outcome).toBe("pending");
    await c.send(r3);
    expect((await h.sql.query("select state, close_reason, kong_stop_confirmed from isolation_admissions where admission_id = $1", [a.admissionId])).rows[0]).toEqual({ state: "closed", close_reason: "kong-stop-confirmed", kong_stop_confirmed: true });
    // Closed, it no longer holds new admissions.
    expect((await c.poll(held.requestId)).outcome).toBe("granted");
    const view = await c.isolation();
    expect(view.pods.find((p) => p.podUid === pa.podUid)).toMatchObject({ admission: "closed", reporting: "closed", kongStopConfirmed: true, lastSeq: 4 });
    // node-reboot: the probe reports the previous boot's end with the same key; the new boot is a new admission.
    const pb = new Probe();
    const c2 = await cluster();
    const b = await admit(c2, pb);
    await c2.send(pb.next(c2.id, b.admissionId));
    await c2.send(pb.next(c2.id, b.admissionId, { final: true, finalReason: "node-reboot", kongStopConfirmed: false }));
    expect((await h.sql.query("select state, close_reason from isolation_admissions where admission_id = $1", [b.admissionId])).rows[0]).toEqual({ state: "closed", close_reason: "node-reboot" });
  });

  it("keeps open, and holding, an admission whose final report could not confirm Kong stopped", async () => {
    const c = await cluster();
    const pa = new Probe();
    const a = await admit(c, pa);
    await c.send(pa.next(c.id, a.admissionId));
    await c.send(pa.next(c.id, a.admissionId, { final: true, finalReason: "pod-terminated", kongStopConfirmed: false }));
    expect((await h.sql.query("select state from isolation_admissions where admission_id = $1", [a.admissionId])).rows[0].state).toBe("open");
    const held = await c.ask(new Probe());
    expect((await c.poll(held.requestId)).outcome).toBe("pending");
  });

  // N2-F3: the pod stopped between the grant and the probe's adoption. Its probe closes the admission with a final seq 1.
  it("closes an admission the probe never adopted with a final seq 1, audited as never served, and the rollout goes on", async () => {
    const c = await cluster();
    const pa = new Probe();
    const a = await admit(c, pa);
    const next = await c.ask(new Probe());
    expect((await c.poll(next.requestId)).outcome).toBe("pending");
    const closing = pa.next(c.id, a.admissionId, { state: "awaiting-admission", leaseRemainingMs: null, final: true, finalReason: "pod-terminated", kongStopConfirmed: true });
    expect((await c.send(closing)).acks).toEqual([{ admissionId: a.admissionId, ackedSeq: 1 }]);
    // Its ack was lost and the agent sends it again: an identical retransmission is idempotent, never a conflict.
    expect(await c.send(closing)).toEqual({ acks: [{ admissionId: a.admissionId, ackedSeq: 1 }], rejected: [] });
    expect((await h.sql.query("select state, close_reason from isolation_admissions where admission_id = $1", [a.admissionId])).rows[0]).toEqual({ state: "closed", close_reason: "kong-stop-confirmed" });
    const audited = await h.sql.query("select after from audit_events where action = 'isolation.admission.close' and entity_id = $1", [a.admissionId]);
    expect(audited.rows[0].after).toMatchObject({ seq: 1, neverServed: true });
    // The replacement pod is admitted without any release: the closed admission no longer holds the cluster.
    expect((await c.poll(next.requestId)).outcome).toBe("granted");
    expect(await pendencyRows(c.id)).toEqual([]);
    const view = await c.isolation();
    expect(view.pods.find((p) => p.podUid === pa.podUid)).toMatchObject({ admission: "closed", lastSeq: 1, state: "awaiting-admission" });
    // Never admitted again: the same (podUid, bootId) asks in vain.
    expect((await c.call("POST", "/admission-requests", pa.request())).status).toBe(409);
  });

  it("never lets a closing erase evidence: a report past the final one, or a forged seq 1 final over a chain, is an integrity conflict", async () => {
    // A report above the final one.
    const c = await cluster();
    const pa = new Probe();
    const a = await admit(c, pa);
    await c.send(pa.next(c.id, a.admissionId, { state: "awaiting-admission", leaseRemainingMs: null, final: true, finalReason: "pod-terminated", kongStopConfirmed: true }));
    const past = await c.send(pa.next(c.id, a.admissionId, { state: "ok" }));
    expect(past.rejected).toEqual([{ index: 0, reason: "integrity-conflict" }]);
    expect((await pendencyRows(c.id)).map((p) => [p.lifecycle, p.capability])).toEqual([["confirmed-violation", "integrity-conflict"]]);
    // A final seq 1 claiming no adoption over a chain that already began: the same seq with other content.
    const c2 = await cluster();
    const pb = new Probe();
    const b = await admit(c2, pb);
    await c2.send(pb.next(c2.id, b.admissionId));
    const forged = pb.signRaw(JSON.stringify(pb.claims(c2.id, b.admissionId, { state: "awaiting-admission", leaseRemainingMs: null, final: true, finalReason: "pod-terminated", kongStopConfirmed: true }, 1, null)));
    expect((await c2.send(forged)).rejected).toEqual([{ index: 0, reason: "integrity-conflict" }]);
    expect((await h.sql.query("select state from isolation_admissions where admission_id = $1", [b.admissionId])).rows[0].state).toBe("open");
    expect((await pendencyRows(c2.id)).map((p) => p.lifecycle)).toEqual(["confirmed-violation"]);
    // A second final report after one that could not confirm Kong stopped, in both arrival orders and in one batch.
    for (const order of ["in order", "reversed", "one batch"]) {
      const cx = await cluster();
      const px = new Probe();
      const x = await admit(cx, px);
      const first = px.next(cx.id, x.admissionId, { state: "awaiting-admission", leaseRemainingMs: null, final: true, finalReason: "pod-terminated", kongStopConfirmed: false });
      const second = px.next(cx.id, x.admissionId, { final: true, finalReason: "pod-terminated", kongStopConfirmed: true });
      const sent = order === "one batch" ? [await cx.send(first, second)] : order === "reversed" ? [await cx.send(second), await cx.send(first)] : [await cx.send(first), await cx.send(second)];
      expect(sent.flatMap((r) => r.rejected.map((j) => j.reason)), order).toEqual(["integrity-conflict"]);
      expect((await h.sql.query("select state from isolation_admissions where admission_id = $1", [x.admissionId])).rows[0].state, order).toBe("open");
      expect((await pendencyRows(cx.id)).map((p) => p.lifecycle), order).toEqual(["confirmed-violation"]);
    }
    // A final report below a report already stored (above a gap) is the same conflict, whatever the arrival order.
    const c3 = await cluster();
    const pc = new Probe();
    const d = await admit(c3, pc);
    const s1 = pc.next(c3.id, d.admissionId, { final: true, finalReason: "pod-terminated", kongStopConfirmed: true });
    const s2 = pc.next(c3.id, d.admissionId);
    await c3.send(s2);
    expect((await c3.send(s1)).rejected).toEqual([{ index: 0, reason: "integrity-conflict" }]);
    expect((await pendencyRows(c3.id)).map((p) => p.lifecycle)).toEqual(["confirmed-violation"]);
  });

  // F3-D2: whether an admission ever served comes only from verified reports; unknown never closes anything.
  it("tells never-served-verified, served and unknown apart from verified reports only", async () => {
    const servedOf = async (c: Cluster, podUid: string) => (await c.isolation()).pods.find((p) => p.podUid === podUid)!.servedState;
    // Granted and silent: unknown, and the admission stays open and holding (no closing on missing evidence).
    const c = await cluster();
    const silent = new Probe();
    const s = await admit(c, silent);
    expect(await servedOf(c, silent.podUid)).toBe("unknown");
    expect((await h.sql.query("select state from isolation_admissions where admission_id = $1", [s.admissionId])).rows[0].state).toBe("open");
    const held = await c.ask(new Probe());
    expect((await c.poll(held.requestId)).outcome).toBe("pending");
    // Closed by its probe before adoption: never-served-verified.
    const c1 = await cluster();
    const p1 = new Probe();
    const a1 = await admit(c1, p1);
    await c1.send(p1.next(c1.id, a1.admissionId, { state: "awaiting-admission", leaseRemainingMs: null, final: true, finalReason: "pod-terminated", kongStopConfirmed: true }));
    expect(await servedOf(c1, p1.podUid)).toBe("never-served-verified");
    // A report past that final one: integrity conflict, and the admission counts as served from then on.
    await c1.send(p1.next(c1.id, a1.admissionId, { state: "ok" }));
    expect(await servedOf(c1, p1.podUid)).toBe("served");
    // Adopted (any report other than such a seq 1 final), then closed normally: served.
    const c2 = await cluster();
    const p2 = new Probe();
    const a2 = await admit(c2, p2);
    await c2.send(p2.next(c2.id, a2.admissionId));
    await c2.send(p2.next(c2.id, a2.admissionId, { final: true, finalReason: "pod-terminated", kongStopConfirmed: true }));
    expect(await servedOf(c2, p2.podUid)).toBe("served");
    // A seq 1 final that could not confirm Kong stopped: served (never never-served), and still open.
    const c3 = await cluster();
    const p3 = new Probe();
    const a3 = await admit(c3, p3);
    await c3.send(p3.next(c3.id, a3.admissionId, { state: "awaiting-admission", leaseRemainingMs: null, final: true, finalReason: "pod-terminated", kongStopConfirmed: false }));
    expect(await servedOf(c3, p3.podUid)).toBe("served");
    expect((await h.sql.query("select state from isolation_admissions where admission_id = $1", [a3.admissionId])).rows[0].state).toBe("open");
    // A seq 1 final in violation, then a report past it (the conflict finds that violation already open): served.
    const c5 = await cluster();
    const p5 = new Probe();
    const a5 = await admit(c5, p5);
    await c5.send(p5.next(c5.id, a5.admissionId, { state: "violation", failedCapabilities: ["CAP-1"], leaseRemainingMs: null, final: true, finalReason: "pod-terminated", kongStopConfirmed: true }));
    expect(await servedOf(c5, p5.podUid)).toBe("served");
    expect((await c5.send(p5.next(c5.id, a5.admissionId, { state: "ok" }))).rejected).toEqual([{ index: 0, reason: "integrity-conflict" }]);
    expect(await servedOf(c5, p5.podUid)).toBe("served");
    // Released by the admin afterwards, it stays served: a release is no proof of never serving.
    const pend = (await c5.isolation()).pendencies.find((p) => p.kind === "confirmed-violation")!;
    expect((await v2(h.api, "POST", `/clusters/${c5.id}/isolation-releases`, { pendencyId: pend.id, justification: "lab: pod deleted, violation reviewed" })).status).toBe(201);
    expect(await servedOf(c5, p5.podUid)).toBe("served");
    // A report the probe key did not sign is refused before it is stored: it moves nothing.
    const c4 = await cluster();
    const p4 = new Probe();
    const a4 = await admit(c4, p4);
    const forged = new Probe().signRaw(JSON.stringify(p4.claims(c4.id, a4.admissionId, { state: "awaiting-admission", leaseRemainingMs: null, final: true, finalReason: "pod-terminated", kongStopConfirmed: true }, 1, null)));
    expect((await c4.send(forged)).rejected).toHaveLength(1);
    expect(await servedOf(c4, p4.podUid)).toBe("unknown");
  });

  it("keeps a confirmed violation open after its admission closes: deleting the pod never erases it", async () => {
    const c = await cluster();
    const pa = new Probe();
    const a = await admit(c, pa);
    await c.send(pa.next(c.id, a.admissionId, { state: "violation", failedCapabilities: ["CAP-3"] }));
    await c.send(pa.next(c.id, a.admissionId, { state: "violation", failedCapabilities: ["CAP-3"], final: true, finalReason: "pod-terminated", kongStopConfirmed: true }));
    expect((await h.sql.query("select state from isolation_admissions where admission_id = $1", [a.admissionId])).rows[0].state).toBe("closed");
    expect((await pendencyRows(c.id)).map((p) => [p.lifecycle, p.capability])).toEqual([["confirmed-violation", "CAP-3"]]);
    const replacement = await c.ask(new Probe());
    expect((await c.poll(replacement.requestId))).toMatchObject({ outcome: "refused", reason: "pendency-open" });
  });

  it("refuses with no-signing-key when no active key covers now, and counts the open admissions a revoked key signed", { timeout: 90_000 }, async () => {
    const c = await cluster();
    const a = await admit(c, new Probe());
    const [{ kid }] = (await h.sql.query("select kid from isolation_admissions where admission_id = $1", [a.admissionId])).rows;
    const revoked = await v2(h.api, "POST", `/instance/signing-keys/${kid}/revoke`, { justification });
    expect(revoked.status).toBe(200);
    const { rows } = await h.sql.query("select count(*)::int as n from isolation_admissions where kid = $1 and state = 'open'", [kid]);
    expect(revoked.body.openAdmissions).toBe(rows[0].n);
    expect(revoked.body.openAdmissions).toBeGreaterThanOrEqual(1);
    for (const k of await trust()) if (k.status !== "revoked") expect((await v2(h.api, "POST", `/instance/signing-keys/${k.kid}/revoke`, { justification })).status).toBe(200);
    const fresh = await cluster();
    const asked = await fresh.ask(new Probe());
    expect(await fresh.poll(asked.requestId)).toMatchObject({ outcome: "refused", reason: "no-signing-key" });
    expect((await h.sql.query("select admission_id, admission from isolation_admissions where id = $1", [asked.requestId])).rows[0]).toEqual({ admission_id: null, admission: null });
    // A release cannot be signed either: nothing is released.
    const pa = new Probe();
    await ensureKey();
    const x = await admit(fresh, pa);
    await fresh.send(pa.next(fresh.id, x.admissionId, { state: "violation", failedCapabilities: ["CAP-5"] }));
    for (const k of await trust()) if (k.status !== "revoked") expect((await v2(h.api, "POST", `/instance/signing-keys/${k.kid}/revoke`, { justification })).status).toBe(200);
    const [p] = (await fresh.isolation()).pendencies;
    expect((await v2(h.api, "POST", `/clusters/${fresh.id}/isolation-releases`, { pendencyId: p!.id, justification })).status).toBe(409);
    expect((await fresh.isolation()).pendencies).toHaveLength(1);
    expect((await fresh.call("GET", "/releases")).body).toEqual({ items: [] });
    await ensureKey();
  });

  it("grants nothing when the control plane cannot prove its state", { timeout: 90_000 }, async () => {
    const c = await cluster();
    const asked = await c.ask(new Probe());
    // The cluster's decisions are held by another session: no decision, the request stays pending.
    const holder = new pg.Client({ connectionString: dbUrl });
    await holder.connect();
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock($1, hashtext($2))", [0x6772_6973, c.id]);
      const res = await c.call("GET", `/admission-requests/${asked.requestId}`);
      expect(res.status).toBeGreaterThanOrEqual(500);
      await holder.query("rollback");
    } finally {
      await holder.end();
    }
    expect((await h.sql.query("select outcome from isolation_admissions where id = $1", [asked.requestId])).rows[0].outcome).toBe("pending");
    // The signing key does not open (sealed for another row): the grant is rolled back with it, nothing is recorded.
    const [{ kid, private_key }] = (await h.sql.query("select kid, private_key from instance_signing_keys where revoked_at is null and retired_at is null order by valid_from desc limit 1")).rows;
    const seed = enc.open(private_key, instanceSigningKeyContext(kid));
    await h.sql.query("update instance_signing_keys set private_key = $2 where kid = $1", [kid, enc.seal(seed, instanceSigningKeyContext("C".repeat(43)))]);
    try {
      const res = await c.call("GET", `/admission-requests/${asked.requestId}`);
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(JSON.stringify(res.body)).not.toContain(seed);
      expect((await h.sql.query("select outcome, admission_id, admission from isolation_admissions where id = $1", [asked.requestId])).rows[0]).toEqual({ outcome: "pending", admission_id: null, admission: null });
      expect((await h.sql.query("select count(*)::int as n from audit_events where action = 'isolation.admission.grant' and after->>'requestId' = $1", [asked.requestId])).rows[0].n).toBe(0);
    } finally {
      await h.sql.query("update instance_signing_keys set private_key = $2 where kid = $1", [kid, private_key]);
    }
    expect((await c.poll(asked.requestId)).outcome).toBe("granted");
  });
});
