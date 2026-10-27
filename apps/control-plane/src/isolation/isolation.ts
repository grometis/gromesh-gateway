import { createHash, createPublicKey, type KeyObject, randomBytes, randomUUID, verify } from "node:crypto";
import { Body, Controller, Get, HttpCode, Inject, Injectable, Logger, Module, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { and, asc, desc, eq, gt, inArray, isNotNull, lt, lte, or, sql } from "drizzle-orm";
import { AgentBearerGuard, AgentGatewayModule, AgentGatewayService, agentContext, bearer } from "../agent-gateway/agent-gateway.js";
import { audit } from "../audit/audit.js";
import { Ctx, Public, RequiredPermission, type RequestContext, SessionOnly } from "../auth/auth.js";
import { agentBodyV2, agentContractsV2, contractBodyV2, inlineBody } from "../common/contract.js";
import { conflict, notFound, unprocessable } from "../common/problem.js";
import { DB, type Db, type Executor } from "../db/db.js";
import {
  clusters,
  instanceSigningKeys,
  isolationAdmissions,
  isolationPendencies,
  isolationReleases,
  isolationReports,
  type ClusterRow,
  type IsolationAdmissionRow,
  type IsolationPendencyRow,
} from "../db/schema.js";
import { uuidParam } from "../environments/environments.js";
import { InstanceSigner, type Jws, NoSigningKeyError, SigningKeysModule } from "../instance/signing-keys.js";

/**
 * Serializes every isolation decision of a cluster across replicas (requests, decisions, reports, releases, timers).
 * Every instant is clock_timestamp(), read after the lock: now() is when the transaction began, before any wait.
 */
const CLUSTER_LOCK_CLASS = 0x6772_6973; // "gris"
const DECISION_SECONDS = 45;
const START_DEADLINE_MINUTES = 5;
const COMMUNICATION_SECONDS = 60;
const UNCONFIRMED_MINUTES = 10;
const RELEASE_MINUTES = 15;
const REPORT_TYP = "gromesh-probe-report+json";
/** A round that ended in a conclusive result (passed or violated), whatever Kong's state. */
const CONCLUSIVE = new Set(["ok", "verifying", "kong-unavailable", "guard-missing", "violation"]);
const OPEN_PENDENCY = ["communication-failure", "confirmed-violation", "unconfirmed-isolation"] as const;
const BLOCKING = ["confirmed-violation", "unconfirmed-isolation"] as const;
const SYSTEM: RequestContext = { actor: { type: "system", id: "isolation" }, ip: null, role: "viewer" };

interface AdmissionRequest {
  podUid: string;
  podName: string;
  nodeName: string;
  bootId: string;
  probePublicKey: string;
}
interface ProbeReport {
  clusterId: string;
  podUid: string;
  bootId: string;
  admissionId: string;
  seq: number;
  prevDigest: string | null;
  state: string;
  failedCapabilities: string[];
  challenge: string | null;
  leaseRemainingMs?: number | null;
  final: boolean;
  finalReason?: "pod-terminated" | "node-reboot";
  kongStopConfirmed?: boolean;
}
type Rejection = "bad-signature" | "unknown-admission" | "other-pod" | "other-boot" | "integrity-conflict";

const digestOf = (payload: Buffer) => `sha256:${createHash("sha256").update(payload).digest("hex")}`;

/** Whether a JSON text (already parsed once) repeats a member name in some object. */
function duplicateMembers(json: string): boolean {
  const stack: (Set<string> | null)[] = [];
  for (let i = 0; i < json.length; i++) {
    const c = json[i];
    if (c === '"') {
      let j = i + 1;
      while (json[j] !== '"') j += json[j] === "\\" ? 2 : 1;
      const raw = json.slice(i, j + 1);
      i = j;
      let k = j + 1;
      while (/\s/.test(json[k] ?? "")) k++;
      const members = stack[stack.length - 1];
      if (json[k] === ":" && members) {
        const name = JSON.parse(raw) as string;
        if (members.has(name)) return true;
        members.add(name);
      }
    } else if (c === "{") stack.push(new Set());
    else if (c === "[") stack.push(null);
    else if (c === "}" || c === "]") stack.pop();
  }
  return false;
}

/** UTF-8 JSON object with no repeated member, or null. */
function strictObject(bytes: Buffer): Record<string, unknown> | null {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value) || duplicateMembers(text)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The probe report header is exactly {alg: EdDSA, typ: gromesh-probe-report+json}, each once. */
function reportHeader(protectedB64: string): boolean {
  const header = strictObject(Buffer.from(protectedB64, "base64url"));
  return !!header && Object.keys(header).length === 2 && header.alg === "EdDSA" && header.typ === REPORT_TYP;
}

const probeKey = (x: string): KeyObject | null => {
  try {
    if (Buffer.from(x, "base64url").length !== 32) return null;
    return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
  } catch {
    return null;
  }
};

/** contract: AdmissionRequestStatus. */
const toStatus = (r: IsolationAdmissionRow) => ({
  requestId: r.id,
  outcome: r.outcome,
  challenge: r.challenge,
  ...(r.outcome === "granted" ? { admission: r.admission! } : {}),
  ...(r.outcome === "refused" ? { reason: r.reason! } : {}),
});

/**
 * Fail-closed isolation admissions (agent protocol v2) for the control plane: requests recorded before any decision,
 * grants only by the challenge rule and signed after being recorded, probe report chains verified with the probe key
 * bound to their admission, pendencies, and signed releases. Every decision of a cluster runs under its lock.
 */
@Injectable()
export class IsolationService {
  private readonly logger = new Logger("Isolation");

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly gateway: AgentGatewayService,
    private readonly signer: InstanceSigner,
  ) {}

  private async lock(tx: Executor, clusterId: string): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(${CLUSTER_LOCK_CLASS}, hashtext(${clusterId}))`);
  }

  /** The node's cluster, locked for its isolation decisions. */
  private async agentCluster(tx: Executor, req: Request) {
    const { cluster, node } = await this.gateway.node(tx, bearer(req));
    await this.lock(tx, cluster.id);
    await this.refresh(tx, cluster);
    return { cluster, ctx: agentContext(req, node.nodeId), nodeId: node.nodeId };
  }

  /**
   * The timers, on the control plane's clock: a pending request refused after 45 s; an open admission without a new
   * report in its chain for 60 s opens a communication-failure (an alert), which after 10 min becomes
   * unconfirmed-isolation. Run under the cluster lock before any decision of it.
   */
  private async refresh(tx: Executor, cluster: ClusterRow): Promise<void> {
    const expired = await tx
      .update(isolationAdmissions)
      .set({ outcome: "refused", reason: "timeout", decidedAt: sql`clock_timestamp()` })
      .where(and(eq(isolationAdmissions.clusterId, cluster.id), eq(isolationAdmissions.outcome, "pending"), lte(isolationAdmissions.requestedAt, sql`clock_timestamp() - make_interval(secs => ${DECISION_SECONDS})`)))
      .returning();
    for (const r of expired) await this.auditRefusal(tx, cluster, SYSTEM, r);
    const lastContact = sql`coalesce(${isolationAdmissions.lastReportAt}, ${isolationAdmissions.decidedAt})`;
    const silent = await tx
      .select()
      .from(isolationAdmissions)
      .where(and(eq(isolationAdmissions.clusterId, cluster.id), eq(isolationAdmissions.state, "open"), lte(lastContact, sql`clock_timestamp() - make_interval(secs => ${COMMUNICATION_SECONDS})`)));
    for (const a of silent) {
      const open = await this.openPendencies(tx, a.admissionId!);
      if (open.length === 0) {
        await this.openPendency(tx, cluster, SYSTEM, a, "communication-failure", null);
        continue;
      }
      const [stale] = await tx.select({ yes: sql<boolean>`${lastContact} <= clock_timestamp() - make_interval(mins => ${UNCONFIRMED_MINUTES})` }).from(isolationAdmissions).where(eq(isolationAdmissions.id, a.id));
      if (!stale?.yes) continue;
      for (const p of open.filter((p) => p.lifecycle === "communication-failure")) {
        await tx.update(isolationPendencies).set({ lifecycle: "unconfirmed-isolation", kind: "unconfirmed-isolation" }).where(eq(isolationPendencies.id, p.id));
        await audit(tx, SYSTEM, { action: "isolation.pendency.supersede", entityType: "isolation-pendency", entityId: p.id, environmentId: cluster.environmentId, before: { lifecycle: p.lifecycle }, after: { lifecycle: "unconfirmed-isolation", admissionId: a.admissionId, clusterId: cluster.id } });
        this.logger.warn(`Isolation of admission ${a.admissionId} on cluster ${cluster.id} unconfirmed: no report chain for ${UNCONFIRMED_MINUTES} min`);
      }
    }
  }

  private openPendencies(tx: Executor, admissionId: string): Promise<IsolationPendencyRow[]> {
    return tx.select().from(isolationPendencies).where(and(eq(isolationPendencies.admissionId, admissionId), inArray(isolationPendencies.lifecycle, [...OPEN_PENDENCY])));
  }

  private async openPendency(tx: Executor, cluster: ClusterRow, ctx: RequestContext, a: IsolationAdmissionRow, kind: "communication-failure" | "confirmed-violation", capability: string | null) {
    const [p] = await tx
      .insert(isolationPendencies)
      .values({ clusterId: cluster.id, lifecycle: kind, kind, scope: "cluster", nodeName: a.nodeName, podUid: a.podUid, admissionId: a.admissionId, capability })
      .returning();
    await audit(tx, ctx, { action: "isolation.pendency.open", entityType: "isolation-pendency", entityId: p!.id, environmentId: cluster.environmentId, after: { clusterId: cluster.id, kind, admissionId: a.admissionId, podUid: a.podUid, capability } });
    if (kind === "confirmed-violation") this.logger.warn(`Confirmed isolation violation on cluster ${cluster.id}, admission ${a.admissionId}: ${capability}`);
  }

  private async auditRefusal(tx: Executor, cluster: ClusterRow, ctx: RequestContext, r: IsolationAdmissionRow) {
    await audit(tx, ctx, { action: "isolation.admission.refuse", entityType: "isolation-admission-request", entityId: r.id, environmentId: cluster.environmentId, after: { clusterId: cluster.id, podUid: r.podUid, bootId: r.bootId, reason: r.reason } });
  }

  async request(req: Request, body: AdmissionRequest) {
    if (!probeKey(body.probePublicKey)) throw unprocessable("probePublicKey is not an Ed25519 public key", [{ path: "probePublicKey", message: "must be a base64url Ed25519 public key" }]);
    const row = await this.db.transaction(async (tx) => {
      const { cluster, ctx, nodeId } = await this.agentCluster(tx, req);
      const [taken] = await tx
        .select({ id: isolationAdmissions.id })
        .from(isolationAdmissions)
        .where(and(eq(isolationAdmissions.clusterId, cluster.id), eq(isolationAdmissions.podUid, body.podUid), eq(isolationAdmissions.bootId, body.bootId), inArray(isolationAdmissions.outcome, ["pending", "granted"])));
      if (taken) throw conflict("An admission for this podUid and bootId already exists");
      const [created] = await tx
        .insert(isolationAdmissions)
        .values({
          clusterId: cluster.id,
          nodeId,
          podUid: body.podUid,
          podName: body.podName,
          nodeName: body.nodeName,
          bootId: body.bootId,
          probePublicKey: body.probePublicKey,
          challenge: randomBytes(32).toString("base64url"),
          // Both under the cluster's lock: which challenge is current never depends on when a transaction began.
          challengeSeq: sql`(select coalesce(max(${isolationAdmissions.challengeSeq}), 0) + 1 from ${isolationAdmissions} where ${isolationAdmissions.clusterId} = ${cluster.id})`,
          requestedAt: sql`clock_timestamp()`,
        })
        .returning();
      await audit(tx, ctx, { action: "isolation.admission.request", entityType: "isolation-admission-request", entityId: created!.id, environmentId: cluster.environmentId, after: { clusterId: cluster.id, podUid: body.podUid, podName: body.podName, nodeName: body.nodeName, bootId: body.bootId, probePublicKey: body.probePublicKey } });
      return created!;
    });
    // Committed before any decision: the decision is the poll's (getIsolationAdmissionRequest).
    return toStatus(row);
  }

  async status(req: Request, requestId: string) {
    return this.db.transaction(async (tx) => {
      // The decision depends on what the database proves now; waiting on a lock is not proof of anything.
      await tx.execute(sql`set local lock_timeout = '5s'`);
      const { cluster, ctx } = await this.agentCluster(tx, req);
      const [row] = await tx.select().from(isolationAdmissions).where(and(eq(isolationAdmissions.id, requestId), eq(isolationAdmissions.clusterId, cluster.id)));
      if (!row) throw notFound("Admission request");
      return toStatus(row.outcome === "pending" ? await this.decide(tx, cluster, ctx, row) : row);
    });
  }

  /**
   * Refused when a blocking pendency is open in scope or no key can sign; granted only when every other open admission
   * of the cluster answered this request's challenge in its contiguous chain, without violation; otherwise pending.
   */
  private async decide(tx: Executor, cluster: ClusterRow, ctx: RequestContext, row: IsolationAdmissionRow): Promise<IsolationAdmissionRow> {
    const [blocking] = await tx
      .select({ id: isolationPendencies.id })
      .from(isolationPendencies)
      .where(and(eq(isolationPendencies.clusterId, cluster.id), inArray(isolationPendencies.lifecycle, [...BLOCKING]), or(eq(isolationPendencies.scope, "cluster"), eq(isolationPendencies.nodeName, row.nodeName))))
      .limit(1);
    if (blocking) return this.refuse(tx, cluster, ctx, row, "pendency-open");
    const [key] = await tx
      .select({ kid: instanceSigningKeys.kid })
      .from(instanceSigningKeys)
      .where(and(sql`${instanceSigningKeys.revokedAt} is null`, sql`${instanceSigningKeys.retiredAt} is null`, lte(instanceSigningKeys.validFrom, sql`clock_timestamp()`), gt(instanceSigningKeys.validUntil, sql`clock_timestamp()`)))
      .limit(1);
    if (!key) return this.refuse(tx, cluster, ctx, row, "no-signing-key");
    // Only the cluster's current challenge (the latest pending request's, the one the agents hand out) can admit: an
    // answer to a superseded one says nothing about the time since. The superseded request stays pending, without a
    // new challenge, and is current again once the newer ones are decided.
    const current = await this.currentChallenge(tx, cluster.id);
    if (current?.id !== row.id) return row;
    const unanswered = await tx.execute<{ n: number }>(sql`
      select count(*)::int as n from ${isolationAdmissions} a
      where a.cluster_id = ${cluster.id} and a.state = 'open' and not exists (
        select 1 from ${isolationReports} r
        where r.admission_id = a.admission_id and r.seq <= a.acked_seq and r.challenge = ${row.challenge}
          and not exists (select 1 from ${isolationReports} v where v.admission_id = a.admission_id and v.seq >= r.seq and v.seq <= a.acked_seq and v.state = 'violation')
          and not exists (select 1 from ${isolationReports} g where g.admission_id = a.admission_id and g.seq > a.acked_seq)
      )`);
    // Answered: a report of its contiguous chain carries this challenge, nothing from it on is a violation, and nothing
    // waits above a gap (what it says is not known in order yet).
    if ((unanswered.rows[0]?.n ?? 1) !== 0) return row;
    try {
      return await tx.transaction(async (sp) => {
        const admissionId = randomUUID();
        // Recorded first, then signed: the document only ever names what the database already holds.
        const [granted] = await sp
          .update(isolationAdmissions)
          .set({ outcome: "granted", decidedAt: sql`clock_timestamp()`, admissionId, state: "open", startDeadline: sql`clock_timestamp() + make_interval(mins => ${START_DEADLINE_MINUTES})` })
          .where(and(eq(isolationAdmissions.id, row.id), eq(isolationAdmissions.outcome, "pending")))
          .returning();
        const claims = {
          clusterId: cluster.id,
          podUid: granted!.podUid,
          nodeName: granted!.nodeName,
          bootId: granted!.bootId,
          admissionId,
          probePublicKey: granted!.probePublicKey,
          startDeadline: granted!.startDeadline!.toISOString(),
        };
        const { jws, kid } = await this.signer.sign(sp, "gromesh-admission+json", claims);
        const [signed] = await sp.update(isolationAdmissions).set({ admission: jws, kid }).where(eq(isolationAdmissions.id, row.id)).returning();
        await audit(sp, ctx, { action: "isolation.admission.grant", entityType: "isolation-admission", entityId: admissionId, environmentId: cluster.environmentId, after: { requestId: row.id, ...claims, kid } });
        return signed!;
      });
    } catch (error) {
      if (!(error instanceof NoSigningKeyError)) throw error;
      return this.refuse(tx, cluster, ctx, row, "no-signing-key");
    }
  }

  private async refuse(tx: Executor, cluster: ClusterRow, ctx: RequestContext, row: IsolationAdmissionRow, reason: "pendency-open" | "no-signing-key") {
    const [refused] = await tx.update(isolationAdmissions).set({ outcome: "refused", reason, decidedAt: sql`clock_timestamp()` }).where(eq(isolationAdmissions.id, row.id)).returning();
    await this.auditRefusal(tx, cluster, ctx, refused!);
    return refused!;
  }

  /** The cluster's current challenge: that of the latest request still waiting for its decision. */
  private async currentChallenge(db: Executor, clusterId: string) {
    const [latest] = await db
      .select({ id: isolationAdmissions.id, challenge: isolationAdmissions.challenge })
      .from(isolationAdmissions)
      .where(and(eq(isolationAdmissions.clusterId, clusterId), eq(isolationAdmissions.outcome, "pending"), gt(isolationAdmissions.requestedAt, sql`clock_timestamp() - make_interval(secs => ${DECISION_SECONDS})`)))
      .orderBy(desc(isolationAdmissions.challengeSeq))
      .limit(1);
    return latest;
  }

  async challenge(req: Request) {
    const { cluster } = await this.gateway.node(this.db, bearer(req));
    return { challenge: (await this.currentChallenge(this.db, cluster.id))?.challenge ?? null };
  }

  async releases(req: Request) {
    const { cluster } = await this.gateway.node(this.db, bearer(req));
    const rows = await this.db
      .select({ release: isolationReleases.release })
      .from(isolationReleases)
      .where(and(eq(isolationReleases.clusterId, cluster.id), gt(isolationReleases.expiresAt, sql`clock_timestamp()`)))
      .orderBy(asc(isolationReleases.createdAt), asc(isolationReleases.id));
    return { items: rows.map((r) => r.release) };
  }

  /**
   * Each report is verified over its received bytes with the probe key of an admission of this cluster before its
   * payload is read; the payload must then name that admission, its pod and boot. Stored as received; the chain moves
   * only through contiguous seqs linked by digest, and the ack (the highest contiguous seq) leaves after the commit.
   */
  async reports(req: Request, reports: Jws[]) {
    return this.db.transaction(async (tx) => {
      const { cluster, ctx } = await this.agentCluster(tx, req);
      const admissions = await tx.select().from(isolationAdmissions).where(and(eq(isolationAdmissions.clusterId, cluster.id), isNotNull(isolationAdmissions.admissionId)));
      const keys = new Map<string, KeyObject>();
      for (const a of admissions) if (!keys.has(a.probePublicKey)) keys.set(a.probePublicKey, probeKey(a.probePublicKey)!);
      const validate = agentContractsV2.validator("ProbeReport");
      const rejected: { index: number; reason: Rejection }[] = [];
      const touched = new Map<string, { seqs: Map<number, number>; stored: number[] }>();
      for (const [index, jws] of reports.entries()) {
        const reason = await this.receive(tx, cluster, ctx, jws, admissions, keys, validate, (admissionId, seq, stored) => {
          const entry = touched.get(admissionId) ?? { seqs: new Map<number, number>(), stored: [] };
          entry.seqs.set(seq, index);
          if (stored) entry.stored.push(seq);
          touched.set(admissionId, entry);
        });
        if (reason) rejected.push({ index, reason });
      }
      const acks: { admissionId: string; ackedSeq: number }[] = [];
      for (const [admissionId, { seqs, stored }] of touched) {
        const { from, ackedSeq, state, broken } = await this.advance(tx, cluster, ctx, admissionId);
        if (broken !== null && seqs.has(broken)) rejected.push({ index: seqs.get(broken)!, reason: "integrity-conflict" });
        if (stored.length > 0 || ackedSeq !== from) {
          await audit(tx, ctx, { action: "isolation.reports", entityType: "isolation-admission", entityId: admissionId, environmentId: cluster.environmentId, before: { ackedSeq: from }, after: { ackedSeq, received: stored, state } });
        }
        acks.push({ admissionId, ackedSeq });
      }
      return { acks, rejected: rejected.sort((a, b) => a.index - b.index) };
    });
  }

  private async receive(
    tx: Executor,
    cluster: ClusterRow,
    ctx: RequestContext,
    jws: Jws,
    admissions: IsolationAdmissionRow[],
    keys: Map<string, KeyObject>,
    validate: ReturnType<typeof agentContractsV2.validator>,
    accepted: (admissionId: string, seq: number, stored: boolean) => void,
  ): Promise<Rejection | null> {
    if (!reportHeader(jws.protected)) return "bad-signature";
    const signed = Buffer.from(`${jws.protected}.${jws.payload}`, "ascii");
    const signature = Buffer.from(jws.signature, "base64url");
    const verifiedBy = new Set([...keys].filter(([, key]) => verify(null, signed, key, signature)).map(([x]) => x));
    if (verifiedBy.size === 0) return "bad-signature";
    // Read only now, and only as the schema allows: anything else the probe signed is not a report.
    const bytes = Buffer.from(jws.payload, "base64url");
    const claims = strictObject(bytes);
    if (!claims || !validate(structuredClone(claims))) return "bad-signature";
    const report = claims as unknown as ProbeReport;
    const a = admissions.find((x) => x.admissionId === report.admissionId && verifiedBy.has(x.probePublicKey));
    if (!a || report.clusterId !== cluster.id) return "unknown-admission";
    if (report.podUid !== a.podUid) return "other-pod";
    if (report.bootId !== a.bootId) return "other-boot";
    const digest = digestOf(bytes);
    const [existing] = await tx.select({ digest: isolationReports.digest }).from(isolationReports).where(and(eq(isolationReports.admissionId, a.admissionId!), eq(isolationReports.seq, report.seq)));
    if (existing) {
      if (existing.digest === digest) {
        accepted(a.admissionId!, report.seq, false);
        return null;
      }
      // The probe key signed two different reports with one seq: the chain cannot be trusted.
      if ((await this.openPendencies(tx, a.admissionId!)).every((p) => p.lifecycle !== "confirmed-violation")) {
        await this.openPendency(tx, cluster, ctx, a, "confirmed-violation", "integrity-conflict");
      }
      return "integrity-conflict";
    }
    // Nothing follows a final report: any report above a stored final one (a second final included), or a final one
    // below a report already stored, is the probe key signing past the end of its chain, whatever the arrival order
    // (contract: closing never erases evidence).
    const afterFinal = and(eq(isolationReports.final, true), lt(isolationReports.seq, report.seq));
    const [past] = await tx
      .select({ seq: isolationReports.seq })
      .from(isolationReports)
      .where(and(eq(isolationReports.admissionId, a.admissionId!), report.final ? or(afterFinal, gt(isolationReports.seq, report.seq)) : afterFinal))
      .limit(1);
    if (past) {
      if ((await this.openPendencies(tx, a.admissionId!)).every((p) => p.lifecycle !== "confirmed-violation")) {
        await this.openPendency(tx, cluster, ctx, a, "confirmed-violation", "integrity-conflict");
      }
      return "integrity-conflict";
    }
    await tx.insert(isolationReports).values({
      admissionId: a.admissionId!,
      seq: report.seq,
      protected: jws.protected,
      payload: jws.payload,
      signature: jws.signature,
      digest,
      prevDigest: report.prevDigest,
      state: report.state,
      failedCapabilities: report.failedCapabilities,
      challenge: report.challenge,
      leaseRemainingMs: report.leaseRemainingMs ?? null,
      final: report.final,
      finalReason: report.finalReason ?? null,
      kongStopConfirmed: report.kongStopConfirmed ?? null,
    });
    // Authenticated and bound to its admission: a violation counts when it arrives, even above a gap (the ack still
    // stops at the contiguous prefix). Only the in-order chain can show it is the sticky state a release covers.
    if (report.state === "violation" && !(await this.coveredByRelease(tx, a.admissionId!, report.seq))) await this.violationReceived(tx, cluster, ctx, a, report);
    accepted(a.admissionId!, report.seq, true);
    return null;
  }

  /**
   * A released violation covers the probe's sticky violation reports only while they follow it without a break: this
   * one is covered only when every seq between the contiguous chain (still in violation since the release) and it is
   * known and a violation too. A missing seq could be the pass after which this violation is new.
   */
  private async coveredByRelease(tx: Executor, admissionId: string, seq: number): Promise<boolean> {
    const [a] = await tx.select({ released: isolationAdmissions.violationReleased, acked: isolationAdmissions.ackedSeq }).from(isolationAdmissions).where(eq(isolationAdmissions.admissionId, admissionId));
    if (!a?.released || seq <= a.acked) return false;
    const [between] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(isolationReports)
      .where(and(eq(isolationReports.admissionId, admissionId), gt(isolationReports.seq, a.acked), sql`${isolationReports.seq} < ${seq}`, eq(isolationReports.state, "violation")));
    return (between?.n ?? 0) === seq - 1 - a.acked;
  }

  private async violationReceived(tx: Executor, cluster: ClusterRow, ctx: RequestContext, a: IsolationAdmissionRow, report: ProbeReport) {
    const open = await this.openPendencies(tx, a.admissionId!);
    if (open.some((p) => p.lifecycle === "confirmed-violation")) return;
    const capability = report.failedCapabilities.join(",");
    const silent = open.find((p) => p.lifecycle === "communication-failure");
    if (!silent) return this.openPendency(tx, cluster, ctx, a, "confirmed-violation", capability);
    await tx.update(isolationPendencies).set({ lifecycle: "confirmed-violation", kind: "confirmed-violation", capability }).where(eq(isolationPendencies.id, silent.id));
    await audit(tx, ctx, { action: "isolation.pendency.supersede", entityType: "isolation-pendency", entityId: silent.id, environmentId: cluster.environmentId, before: { lifecycle: silent.lifecycle }, after: { lifecycle: "confirmed-violation", admissionId: a.admissionId, seq: report.seq } });
  }

  /**
   * Moves the acked chain over the next stored seqs while each one's prevDigest is the digest of the one before;
   * a mismatch stops it for good (confirmed-violation) and is returned as `broken`.
   */
  private async advance(tx: Executor, cluster: ClusterRow, ctx: RequestContext, admissionId: string): Promise<{ from: number; ackedSeq: number; state: string | null; broken: number | null }> {
    const [a] = await tx.select().from(isolationAdmissions).where(eq(isolationAdmissions.admissionId, admissionId));
    let current = a!;
    const from = current.ackedSeq;
    let broken: number | null = null;
    for (;;) {
      const [next] = await tx.select().from(isolationReports).where(and(eq(isolationReports.admissionId, admissionId), eq(isolationReports.seq, current.ackedSeq + 1)));
      if (!next) break;
      if (next.prevDigest !== (next.seq === 1 ? null : current.lastDigest)) {
        broken = next.seq;
        if ((await this.openPendencies(tx, admissionId)).every((p) => p.lifecycle !== "confirmed-violation")) await this.openPendency(tx, cluster, ctx, current, "confirmed-violation", "integrity-conflict");
        break;
      }
      const violation = next.state === "violation";
      const open = await this.openPendencies(tx, admissionId);
      for (const p of open) {
        if (p.lifecycle === "communication-failure" && violation) {
          await tx.update(isolationPendencies).set({ lifecycle: "confirmed-violation", kind: "confirmed-violation", capability: next.failedCapabilities.join(",") }).where(eq(isolationPendencies.id, p.id));
          await audit(tx, ctx, { action: "isolation.pendency.supersede", entityType: "isolation-pendency", entityId: p.id, environmentId: cluster.environmentId, before: { lifecycle: p.lifecycle }, after: { lifecycle: "confirmed-violation", admissionId, seq: next.seq } });
        } else if ((p.lifecycle === "communication-failure" || p.lifecycle === "unconfirmed-isolation") && !violation) {
          await tx.update(isolationPendencies).set({ lifecycle: "closed", closedAt: sql`clock_timestamp()`, closeReason: "chain-resumed" }).where(eq(isolationPendencies.id, p.id));
          await audit(tx, ctx, { action: "isolation.pendency.close", entityType: "isolation-pendency", entityId: p.id, environmentId: cluster.environmentId, before: { lifecycle: p.lifecycle }, after: { lifecycle: "closed", reason: "chain-resumed", admissionId, seq: next.seq } });
        }
      }
      const covered = violation && current.violationReleased;
      if (violation && !covered && !open.some((p) => p.lifecycle === "confirmed-violation" || p.lifecycle === "communication-failure")) {
        await this.openPendency(tx, cluster, ctx, current, "confirmed-violation", next.failedCapabilities.join(","));
      }
      const closes = current.state === "open" && next.final && (next.finalReason === "node-reboot" || next.kongStopConfirmed === true);
      [current] = (await tx
        .update(isolationAdmissions)
        .set({
          ackedSeq: next.seq,
          lastDigest: next.digest,
          lastReportAt: sql`clock_timestamp()`,
          lastState: next.state,
          lastFailed: next.failedCapabilities,
          leaseRemainingMs: next.leaseRemainingMs,
          ...(CONCLUSIVE.has(next.state) ? { lastConclusiveAt: sql`clock_timestamp()` } : {}),
          ...(next.final ? { kongStopConfirmed: next.kongStopConfirmed } : {}),
          violationReleased: covered,
          ...(closes ? { state: "closed" as const, closedAt: sql`clock_timestamp()`, closeReason: next.finalReason === "node-reboot" ? "node-reboot" : "kong-stop-confirmed" } : {}),
        })
        .where(eq(isolationAdmissions.admissionId, admissionId))
        .returning()) as [IsolationAdmissionRow];
      // A chain whose seq 1 is final never had a lease: the probe publishes one only after its round's report is durable.
      if (closes) await audit(tx, ctx, { action: "isolation.admission.close", entityType: "isolation-admission", entityId: admissionId, environmentId: cluster.environmentId, after: { state: "closed", reason: current.closeReason, seq: next.seq, neverServed: next.seq === 1 } });
    }
    return { from, ackedSeq: current.ackedSeq, state: current.lastState, broken };
  }

  /**
   * contract: AdmissionServedState (F3-D2), only from reports stored after their signature was verified with the
   * admission's probe key. never-served-verified: its only report is a seq 1 awaiting-admission final confirming Kong
   * stopped and no confirmed violation (integrity conflict included) was ever opened on it; served: any other report
   * or such a violation; unknown (absent here): no report at all. Nothing is ever closed from this view.
   * A conflict raised while another violation of the admission is open records no second pendency, but that open
   * one already makes it served.
   */
  private async servedStates(tx: Executor, admissionIds: string[]): Promise<Map<string, "never-served-verified" | "served">> {
    const out = new Map<string, "never-served-verified" | "served">();
    if (admissionIds.length === 0) return out;
    const chains = await tx
      .select({
        admissionId: isolationReports.admissionId,
        n: sql<number>`count(*)::int`,
        closedUnadopted: sql<boolean>`bool_or(${isolationReports.seq} = 1 and ${isolationReports.final} and ${isolationReports.kongStopConfirmed} is true and ${isolationReports.state} = 'awaiting-admission')`,
      })
      .from(isolationReports)
      .where(inArray(isolationReports.admissionId, admissionIds))
      .groupBy(isolationReports.admissionId);
    const conflicted = new Set(
      (
        await tx
          .select({ admissionId: isolationPendencies.admissionId })
          .from(isolationPendencies)
          .where(and(inArray(isolationPendencies.admissionId, admissionIds), eq(isolationPendencies.kind, "confirmed-violation")))
      ).map((p) => p.admissionId),
    );
    for (const c of chains) out.set(c.admissionId, c.n === 1 && c.closedUnadopted && !conflicted.has(c.admissionId) ? "never-served-verified" : "served");
    return out;
  }

  /** contract: ClusterIsolation. The timers run first, so what it shows is what the next decision would see. */
  async cluster(clusterId: string) {
    return this.db.transaction(async (tx) => {
      const [cluster] = await tx.select().from(clusters).where(eq(clusters.id, clusterId));
      if (!cluster) throw notFound("Cluster");
      await this.lock(tx, cluster.id);
      await this.refresh(tx, cluster);
      const rows = await tx.select().from(isolationAdmissions).where(eq(isolationAdmissions.clusterId, cluster.id)).orderBy(desc(isolationAdmissions.requestedAt), desc(isolationAdmissions.id));
      const pendencies = await tx
        .select()
        .from(isolationPendencies)
        .where(and(eq(isolationPendencies.clusterId, cluster.id), inArray(isolationPendencies.lifecycle, [...OPEN_PENDENCY])))
        .orderBy(asc(isolationPendencies.openedAt), asc(isolationPendencies.id));
      const latest = new Map<string, IsolationAdmissionRow>();
      for (const r of rows) if (!latest.has(`${r.podUid}/${r.bootId}`)) latest.set(`${r.podUid}/${r.bootId}`, r);
      const served = await this.servedStates(tx, [...latest.values()].flatMap((r) => (r.admissionId ? [r.admissionId] : [])));
      const pods = [...latest.values()].map((r) => {
        const held = pendencies.filter((p) => p.admissionId !== null && p.admissionId === r.admissionId).map((p) => p.lifecycle);
        const open = r.outcome === "granted" && r.state === "open";
        return {
          podUid: r.podUid,
          bootId: r.bootId,
          podName: r.podName,
          nodeName: r.nodeName,
          admissionId: r.admissionId,
          state: r.lastState ?? "awaiting-admission",
          admission: r.outcome === "pending" ? "requested" : r.outcome === "refused" ? "refused" : r.state!,
          servedState: (r.admissionId && served.get(r.admissionId)) || "unknown",
          reporting: !open ? "closed" : held.includes("unconfirmed-isolation") ? "unconfirmed-isolation" : held.includes("communication-failure") ? "communication-failure" : "reporting",
          kongStopConfirmed: r.kongStopConfirmed,
          lastSeq: r.ackedSeq,
          lastReportAt: r.lastReportAt?.toISOString() ?? null,
          leaseRemainingMs: r.leaseRemainingMs,
          lastConclusiveAt: r.lastConclusiveAt?.toISOString() ?? null,
          failedCapabilities: r.lastFailed,
        };
      });
      return {
        clusterId: cluster.id,
        pods,
        pendencies: pendencies.map((p) => ({
          id: p.id,
          kind: p.lifecycle as (typeof OPEN_PENDENCY)[number],
          scope: p.scope,
          nodeName: p.nodeName,
          podUid: p.podUid,
          capability: p.capability,
          openedAt: p.openedAt.toISOString(),
          releasable: p.lifecycle !== "communication-failure",
        })),
      };
    });
  }

  /**
   * Closes a confirmed-violation or unconfirmed-isolation pendency (the orphan admission of the latter becomes
   * closed-without-proof) with a release signed after it is recorded, served to the cluster's agents for 15 min.
   * Nothing is released when no key can sign it.
   */
  async release(ctx: RequestContext, clusterId: string, body: { pendencyId: string; justification: string }) {
    await this.db.transaction(async (tx) => {
      const [cluster] = await tx.select().from(clusters).where(eq(clusters.id, clusterId));
      if (!cluster) throw notFound("Cluster");
      await this.lock(tx, cluster.id);
      await this.refresh(tx, cluster);
      const [p] = await tx.select().from(isolationPendencies).where(and(eq(isolationPendencies.id, body.pendencyId), eq(isolationPendencies.clusterId, cluster.id)));
      if (!p) throw notFound("Pendency");
      if (p.lifecycle !== "confirmed-violation" && p.lifecycle !== "unconfirmed-isolation") throw conflict(p.lifecycle === "communication-failure" ? "A communication-failure is not releasable" : "The pendency is not open");
      const kind = p.lifecycle;
      // Every admission open in the pendency's scope as the release is issued (the orphan it closes included), each
      // with the chain acknowledged so far: a probe leaves violation only for reports up to that seq.
      const covered = await tx
        .select({ admissionId: isolationAdmissions.admissionId, throughSeq: isolationAdmissions.ackedSeq })
        .from(isolationAdmissions)
        .where(and(eq(isolationAdmissions.clusterId, cluster.id), eq(isolationAdmissions.state, "open"), p.scope === "node" ? eq(isolationAdmissions.nodeName, p.nodeName ?? "") : undefined))
        .orderBy(asc(isolationAdmissions.decidedAt), asc(isolationAdmissions.admissionId));
      const admissions = covered.map((a) => ({ admissionId: a.admissionId!, throughSeq: a.throughSeq }));
      await tx.update(isolationPendencies).set({ lifecycle: "released", closedAt: sql`clock_timestamp()`, closeReason: "released", releasedBy: ctx.actor, justification: body.justification }).where(eq(isolationPendencies.id, p.id));
      if (p.admissionId) {
        await tx
          .update(isolationAdmissions)
          .set(kind === "unconfirmed-isolation" ? { state: "closed-without-proof", closedAt: sql`clock_timestamp()`, closeReason: "released" } : { violationReleased: true })
          .where(and(eq(isolationAdmissions.admissionId, p.admissionId), kind === "unconfirmed-isolation" ? eq(isolationAdmissions.state, "open") : undefined));
      }
      const { rows } = await tx.execute<{ at: Date }>(sql`select clock_timestamp() + make_interval(mins => ${RELEASE_MINUTES}) as at`);
      const expiresAt = new Date(rows[0]!.at).toISOString();
      let signed: { jws: Jws; kid: string };
      try {
        signed = await this.signer.sign(tx, "gromesh-isolation-release+json", { clusterId: cluster.id, pendencyId: p.id, kind, expiresAt, admissions });
      } catch (error) {
        if (error instanceof NoSigningKeyError) throw conflict("No active instance signing key covers now: nothing was released");
        throw error;
      }
      await tx.insert(isolationReleases).values({ clusterId: cluster.id, pendencyId: p.id, kind, release: signed.jws, kid: signed.kid, expiresAt: sql`${expiresAt}::timestamptz` });
      await audit(tx, ctx, { action: "isolation.release", entityType: "isolation-pendency", entityId: p.id, environmentId: cluster.environmentId, before: { lifecycle: kind }, after: { lifecycle: "released", clusterId: cluster.id, admissionId: p.admissionId, admissions, kid: signed.kid, expiresAt, justification: body.justification } });
    });
    this.logger.warn(`Isolation pendency ${body.pendencyId} of cluster ${clusterId} released by ${ctx.actor.name ?? ctx.actor.id}`);
  }
}

/** agent-protocol-v2, isolation: node token v1 (AgentBearerGuard); the cluster is the token's. */
@Controller("agent/v2/isolation")
@UseGuards(AgentBearerGuard)
export class AgentIsolationController {
  constructor(private readonly isolation: IsolationService) {}

  // Public skips user RBAC; AgentBearerGuard enforces the node token on every handler.
  @Post("admission-requests")
  @HttpCode(202)
  @Public()
  request(@Req() req: Request, @Body(agentBodyV2("AdmissionRequest")) body: AdmissionRequest) {
    return this.isolation.request(req, body);
  }

  @Get("admission-requests/:requestId")
  @Public()
  status(@Req() req: Request, @Param("requestId", uuidParam()) requestId: string) {
    return this.isolation.status(req, requestId);
  }

  @Get("challenge")
  @Public()
  challenge(@Req() req: Request) {
    return this.isolation.challenge(req);
  }

  @Post("reports")
  @HttpCode(200)
  @Public()
  reports(@Req() req: Request, @Body(agentBodyV2(inlineBody("/agent/v2/isolation/reports", "post"))) body: { reports: Jws[] }) {
    return this.isolation.reports(req, body.reports);
  }

  @Get("releases")
  @Public()
  releases(@Req() req: Request) {
    return this.isolation.releases(req);
  }
}

/** control-plane-v2: a cluster's isolation state and the release of its containment pendencies. */
@Controller("api/v2/clusters")
export class ClusterIsolationController {
  constructor(private readonly isolation: IsolationService) {}

  @Get(":clusterId/isolation")
  @RequiredPermission("instance.read", "instance")
  get(@Param("clusterId", uuidParam()) clusterId: string) {
    return this.isolation.cluster(clusterId);
  }

  @Post(":clusterId/isolation-releases")
  @HttpCode(201)
  @SessionOnly()
  @RequiredPermission("platform.admin", "instance")
  async release(@Ctx() ctx: RequestContext, @Param("clusterId", uuidParam()) clusterId: string, @Body(contractBodyV2(inlineBody("/clusters/{clusterId}/isolation-releases", "post"))) body: { pendencyId: string; justification: string }) {
    await this.isolation.release(ctx, clusterId, body);
  }
}

@Module({
  imports: [AgentGatewayModule, SigningKeysModule],
  controllers: [AgentIsolationController, ClusterIsolationController],
  providers: [IsolationService],
})
export class IsolationModule {}
