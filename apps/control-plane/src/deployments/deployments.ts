import { Body, Controller, Get, HttpCode, Inject, Injectable, Module, Param, Post, Put, Req, Res, UseGuards } from "@nestjs/common";
import { jcs, type KongDeclarativeConfig } from "@gromesh/compiler";
import type { Request, Response } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { AgentBearerGuard, AgentGatewayModule, AgentGatewayService, agentContext, bearer } from "../agent-gateway/agent-gateway.js";
import { audit } from "../audit/audit.js";
import { collectorTokenEvidence, reconcileCollectorTokens, type CollectorTokenFingerprints } from "../analytics/collector-tokens.js";
import { Ctx, Public, RequiredPermission, type RequestContext, SessionOnly } from "../auth/auth.js";
import { AGENT_CHANNEL } from "../clusters/clusters.js";
import { agentBodyV2, contractBodyV2, inlineBody } from "../common/contract.js";
import { deliveryRefused, notFound, unprocessable } from "../common/problem.js";
import { APP_CONFIG, type AppConfig } from "../config.js";
import { deploymentContext, ENCRYPTOR, Encryptor } from "../crypto/crypto.js";
import { DB, type Db, type Executor, type Tx } from "../db/db.js";
import {
  clusterNodes,
  clusters,
  contentActivations,
  deploymentLease,
  deployments,
  environments,
  instance,
  isolationAdmissions,
  isolationPendencies,
  isolationReports,
  workspaces,
  type ClusterNodeRow,
  type ClusterRow,
  type DeploymentMember,
  type DeploymentRow,
} from "../db/schema.js";
import { uuidParam } from "../environments/environments.js";
import { deploymentState, transition } from "../releases/releases.js";
import { evidenceOf, type Evidence, type ProbeEvidence } from "./evidence.js";

/** A node silent for longer is offline: its cluster is degraded, never converged (InstanceCluster.status). */
export const OFFLINE_SECONDS = 45;
/** Probe states of a conclusive round that passed (PodIsolationState; violation is conclusive but fails). */
const PASSING = ["ok", "verifying", "kong-unavailable", "guard-missing"];
const OPEN_PENDENCIES = ["communication-failure", "confirmed-violation", "unconfirmed-isolation"] as const;

const DEGRADING: Evidence[] = ["revision-mismatch", "served-config-divergence", "kong-hash-divergence", "revision-regression"];

/** agent-protocol-v2 StatusReport. */
export interface StatusReportV2 {
  nodeId: string;
  epoch: number;
  appliedRevision: number | null;
  appliedHash: string | null;
  failedRevision?: number | null;
  failedHash?: string | null;
  failureStatus?: number | null;
  failureReason?: "kong-rejected" | "instance-mismatch" | "invalid-envelope";
  kongConfigHash?: string | null;
  kongHealthy: boolean;
  analytics?: string;
  collectorTokenFingerprints?: CollectorTokenFingerprints;
  isolationState?: string;
}

interface NodeView {
  clusterId: string;
  node: ClusterNodeRow | undefined;
  nodeId: string;
  online: boolean;
  /** Kong reported unhealthy in the node's latest status: degraded, never converged. */
  healthy: boolean;
  failed: boolean;
  evidence: Evidence;
}

const SYSTEM: RequestContext = { actor: { type: "system", id: "delivery" }, ip: null, role: "viewer" };

async function clock(tx: Executor): Promise<Date> {
  const { rows } = await tx.execute<{ now: Date | string }>(sql`select clock_timestamp() as now`);
  return new Date(rows[0]!.now);
}

/** The instance's latest deployment revision (any state but rejected): what every v2 cluster is served. */
export async function latestDeployment(tx: Executor): Promise<DeploymentRow | undefined> {
  const [row] = await tx.select().from(deployments).orderBy(desc(deployments.epoch), desc(deployments.revision)).limit(1);
  return row;
}

/**
 * A new deployment's expected nodes (D2; C-16): every registered node of the v2 clusters, online or not (an offline
 * one keeps the revision degraded, never converged; nodes are never deregistered yet).
 */
export async function v2ExpectedNodes(tx: Executor): Promise<{ clusterId: string; nodeId: string }[]> {
  const rows = await tx
    .select({ clusterId: clusterNodes.clusterId, nodeId: clusterNodes.nodeId })
    .from(clusterNodes)
    .innerJoin(clusters, eq(clusters.id, clusterNodes.clusterId))
    .where(eq(clusters.deliveryProtocol, "v2"))
    .orderBy(clusterNodes.clusterId, clusterNodes.nodeId);
  return rows;
}

/** The isolation module's per-cluster lock (its admissions, reports and pendencies are decided under it). */
const ISOLATION_LOCK_CLASS = 0x6772_6973; // "gris"

async function isolationLock(tx: Executor, clusterId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(${ISOLATION_LOCK_CLASS}, hashtext(${clusterId}))`);
}

/**
 * Every delivery transaction takes the instance's single lease row first, then cluster and node rows: one order for
 * publishes, deployments, status reports, served deployments and protocol switches, so replicas never deadlock.
 */
async function leaseFirst(tx: Executor) {
  const [lease] = await tx.select().from(deploymentLease).for("update");
  return lease!;
}

/** A refusal the transaction must not undo (the node's marker is committed first, then the 409 leaves). */
class Refusal {
  constructor(readonly code: string, readonly detail: string) {}
}

@Injectable()
export class DeliveryService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ENCRYPTOR) private readonly enc: Encryptor,
    private readonly gateway: AgentGatewayService,
  ) {}

  private get enabled() {
    return this.config.workspacesDeployments !== null;
  }

  /**
   * The delivery rules in front of every v2 agent call: Workspaces mode on, the node's cluster in v2. A v2-pending
   * cluster becomes v2 here once the activation gate holds (system transition, audited).
   */
  private async deliverable(tx: Tx, cluster: ClusterRow): Promise<Refusal | null> {
    if (!this.enabled) return new Refusal("workspaces-mode-disabled", "Workspaces mode is disabled on this instance");
    if (cluster.deliveryProtocol === "v1") return new Refusal("delivery-protocol-v1", "This cluster receives v1 snapshots");
    if (cluster.deliveryProtocol === "v2-pending") {
      if (!(await this.activateCluster(tx, cluster.id))) {
        return new Refusal("delivery-protocol-switching", "This cluster is switching to v2: the activation gate does not hold yet");
      }
      // The activation commits even when the call is then refused: the latest revision takes the joined nodes (and the
      // lease) in the same transaction, so no path leaves it active and "empty" for the next deployment to supersede.
      await this.evaluate(tx);
    }
    return null;
  }

  /**
   * GET /agent/v2/deployments/current: the latest revision as JCS (RFC 8785), so the config member is exactly the
   * bytes whose md5 is the deployment's kongConfigHash (agent protocol v2, "Expected Kong hash").
   */
  async current(req: Request, res: Response) {
    const served = await this.db.transaction(async (tx) => {
      await leaseFirst(tx);
      const { cluster } = await this.gateway.node(tx, bearer(req));
      if (this.enabled && cluster.deliveryProtocol !== "v1") await reconcileCollectorTokens(tx);
      const refused = await this.deliverable(tx, cluster);
      if (refused) return refused;
      const row = await latestDeployment(tx);
      if (!row) return null;
      // A deadline may have passed with no agent reporting: the machine moves before the revision is served.
      await this.evaluate(tx);
      return row;
    });
    if (served instanceof Refusal) throw deliveryRefused(served.code, served.detail);
    if (!served) throw notFound("Deployment");
    res.setHeader("X-Gromesh-Epoch", String(served.epoch));
    res.setHeader("X-Gromesh-Revision", String(served.revision));
    res.setHeader("ETag", served.configHash);
    res.setHeader("Cache-Control", "private, no-cache");
    const tags = (req.headers["if-none-match"] ?? "").split(",").map((t) => t.trim().replace(/^W\//, "").replace(/^"|"$/g, ""));
    if (tags.includes(served.configHash)) {
      res.status(304).end();
      return;
    }
    const [self] = await this.db.select().from(instance);
    const members = served.members as DeploymentMember[];
    const slugs = new Map((await this.db.select({ id: workspaces.id, slug: workspaces.slug }).from(workspaces).where(inArray(workspaces.id, members.map((m) => m.workspaceId)))).map((w) => [w.id, w.slug]));
    const envelope = {
      schemaVersion: 2,
      instanceId: self!.id,
      epoch: served.epoch,
      revision: served.revision,
      hash: served.configHash,
      createdAt: served.createdAt.toISOString(),
      reason: served.reason,
      members: members.map((m) => ({ workspaceId: m.workspaceId, slug: slugs.get(m.workspaceId)!, releaseVersion: m.releaseVersion, contentDigest: m.contentDigest })),
      ...(served.mandatoryPluginsVersion === null ? {} : { mandatoryPluginsVersion: served.mandatoryPluginsVersion }),
      ...(served.valuesDigest === null ? {} : { valuesDigest: served.valuesDigest }),
      // Opened only here, on the way to the agent.
      config: this.enc.openJson<KongDeclarativeConfig>(served.config, deploymentContext(served.epoch, served.revision)),
    };
    res.status(200).type("application/json").send(jcs(envelope));
  }

  /** POST /agent/v2/status: records what the agent declares; only evaluate() decides whether it counts. */
  async report(req: Request, body: StatusReportV2) {
    const refusal = await this.db.transaction(async (tx) => {
      await leaseFirst(tx);
      // Lease, then the isolation lock of the node's cluster, then its rows: the isolation module takes its lock before
      // any row of the cluster (an admission's foreign key), so the activation gate below never inverts it.
      const { cluster: unlocked } = await this.gateway.node(tx, bearer(req));
      await isolationLock(tx, unlocked.id);
      const { cluster, node } = await this.gateway.node(tx, bearer(req), true);
      if (body.nodeId !== node.nodeId) throw unprocessable("Node identity does not match token", [{ path: "nodeId", message: "must match the registered node" }]);
      if (!this.enabled || cluster.deliveryProtocol === "v1") return this.deliverable(tx, cluster);
      const current = await latestDeployment(tx);
      const epoch = current?.epoch ?? 1;
      if (body.epoch < epoch) return (await this.deliverable(tx, cluster)) ?? new Refusal("epoch-outdated", `The instance's epoch is ${epoch}`);
      const named = async (revision: number | null | undefined, hash: string | null | undefined) => {
        if (revision == null) return true;
        const [row] = await tx.select({ hash: deployments.configHash }).from(deployments).where(and(eq(deployments.epoch, body.epoch), eq(deployments.revision, revision)));
        return row?.hash === hash;
      };
      if (body.epoch > epoch || !(await named(body.appliedRevision, body.appliedHash)) || !(await named(body.failedRevision, body.failedHash))) {
        return (await this.deliverable(tx, cluster)) ?? new Refusal("unknown-deployment", "No deployment of this instance has that epoch, revision and hash");
      }
      const where = and(eq(clusterNodes.clusterId, cluster.id), eq(clusterNodes.nodeId, node.nodeId));
      if (body.appliedRevision !== null && node.verifiedEpoch === body.epoch && node.verifiedRevision !== null && body.appliedRevision < node.verifiedRevision) {
        const refused = await this.deliverable(tx, cluster);
        if (refused) return refused;
        // Not recorded: the node keeps its last report and shows revision-regression until it reports the current one.
        await tx.update(clusterNodes).set({ failureReason: "revision-regression", lastSeenAt: sql`now()` }).where(where);
        await audit(tx, agentContext(req, node.nodeId), { action: "agent.status.refused", entityType: "node", entityId: node.nodeId, environmentId: cluster.environmentId, after: { clusterId: cluster.id, code: "revision-regression", appliedRevision: body.appliedRevision, verifiedRevision: node.verifiedRevision } });
        return new Refusal("revision-regression", `The node was verified at revision ${node.verifiedRevision}`);
      }
      // Token evidence is independent of applied revisions: pending nodes must be able to supply the gate's input.
      // A switching refusal commits this observation, never an applied revision or a delivered configuration.
      const tokenEvidence = collectorTokenEvidence(this.enc, body.collectorTokenFingerprints);
      try {
        await tx.update(clusterNodes).set({ collectorTokenEvidence: tokenEvidence, collectorTokenReportedAt: sql`clock_timestamp()`, lastSeenAt: sql`clock_timestamp()` }).where(where);
      } catch (error: unknown) {
        // Drizzle includes the HMAC parameters in its message/stack; retain only known HTTP conflict semantics.
        let current: unknown = error;
        let code: string | undefined;
        for (let i = 0; i < 3 && current && typeof current === "object"; i++) {
          if ("code" in current && typeof current.code === "string" && ["23505", "23503", "40P01", "40001"].includes(current.code)) {
            code = current.code;
            break;
          }
          current = "cause" in current ? current.cause : null;
        }
        throw Object.assign(new Error("Collector token evidence could not be recorded"), code ? { code } : {});
      }
      if (JSON.stringify(node.collectorTokenEvidence) !== JSON.stringify(tokenEvidence)) {
        await audit(tx, agentContext(req, node.nodeId), {
          action: "agent.collector-token", entityType: "node", entityId: node.nodeId, environmentId: cluster.environmentId,
          after: { clusterId: cluster.id, currentKeyHint: tokenEvidence?.currentHint ?? null, previousKeyHint: tokenEvidence?.previousHint ?? null },
        });
      }
      await reconcileCollectorTokens(tx);
      const refused = await this.deliverable(tx, cluster);
      if (refused) return refused;
      const state = current && body.failedRevision === current.revision ? "failed" : current && body.appliedRevision === current.revision ? "applied" : "applying";
      await tx
        .update(clusterNodes)
        .set({
          epoch: body.epoch,
          appliedRevision: body.appliedRevision,
          deploymentHash: body.appliedHash,
          kongConfigHash: body.appliedRevision === null ? null : body.kongConfigHash ?? null,
          failedRevision: body.failedRevision ?? null,
          failedDeploymentHash: body.failedHash ?? null,
          failureReason: body.failureReason ?? null,
          state,
          kongHealthy: body.kongHealthy,
          reportedAt: sql`clock_timestamp()`,
          lastSeenAt: sql`clock_timestamp()`,
        })
        .where(where);
      if (node.state !== state || node.appliedRevision !== body.appliedRevision || node.failedRevision !== (body.failedRevision ?? null)) {
        await audit(tx, agentContext(req, node.nodeId), {
          action: "agent.status",
          entityType: "node",
          entityId: node.nodeId,
          environmentId: cluster.environmentId,
          after: { clusterId: cluster.id, epoch: body.epoch, state, appliedRevision: body.appliedRevision, failedRevision: body.failedRevision ?? null, failureReason: body.failureReason ?? null, kongHealthy: body.kongHealthy },
        });
      }
      await this.evaluate(tx);
      return null;
    });
    if (refusal) throw deliveryRefused(refusal.code, refusal.detail);
  }

  /**
   * The convergence of the latest deployment (agent protocol v2, "Applied revision and convergence evidence"). Under
   * the lease row, so publishes and evaluations from every replica move the machine one at a time.
   */
  async evaluate(tx: Tx): Promise<NodeView[]> {
    const lease = await leaseFirst(tx);
    const dep = await latestDeployment(tx);
    if (!dep) return [];
    const now = await clock(tx);
    const views = await this.nodeViews(tx, dep, now);
    const current = (await deploymentState(tx, dep.epoch, dep.revision))?.state;
    if (!current || ["rejected", "superseded", "failed"].includes(current)) return views;
    const verified = views.length > 0 && views.every((v) => v.online && v.healthy && v.evidence === "verified");
    if (current === "converged") {
      // The history stays converged; a cluster that joined later and proved it still records the first activation.
      if (verified) await this.activate(tx, dep, now);
      return views;
    }
    const holdsLease = lease.revision === dep.revision;
    if (holdsLease && lease.deadlineAt && lease.deadlineAt <= now) {
      const path: Record<string, string[]> = { active: ["converging", "degraded", "failed"], converging: ["degraded", "failed"], degraded: ["failed"] };
      await transition(tx, dep.epoch, dep.revision, (path[current] ?? []).map((s) => [s as "failed", "convergence deadline"]));
      await this.freeLease(tx);
      return views;
    }
    if (views.length === 0) {
      // No expected node: none joined yet, or every expected cluster returned to v1. Nothing proves the revision, so it
      // never converges. One that was waiting for nodes (converging, or recorded with nodes and holding the lease) is
      // degraded, whoever holds the lease, and the next deployment supersedes it; one that never had a node stays active.
      if (current === "converging" || (current === "active" && holdsLease)) {
        const left: ["converging" | "degraded", string][] = current === "active" ? [["converging", "some node has not applied yet"]] : [];
        left.push(["degraded", "every expected cluster left; nothing applied"]);
        await transition(tx, dep.epoch, dep.revision, left);
      }
      if (holdsLease) await this.freeLease(tx);
      return views;
    }
    // Nodes to wait for (a cluster that turned v2 after a revision recorded without nodes joined): the revision takes the
    // free lease and its convergence deadline from now, so it fails instead of waiting forever.
    if (!holdsLease && lease.revision === null && this.config.workspacesDeployments) {
      await tx.update(deploymentLease).set({ revision: dep.revision, operation: "deploy", owner: SYSTEM.actor, startedAt: now, deadlineAt: new Date(now.getTime() + this.config.workspacesDeployments.convergenceDeadlineMs) });
    }
    const takesLease = holdsLease || (lease.revision === null && !!this.config.workspacesDeployments);
    const converged = verified;
    const degraded = views.some((v) => !v.online || !v.healthy || v.failed || DEGRADING.includes(v.evidence));
    const steps: ["converging" | "degraded" | "converged", string][] = [];
    if (converged) {
      if (current === "degraded") steps.push(["converging", "nodes back"]);
      steps.push(["converged", "every expected node applied with revision and hash"]);
    } else if (degraded) {
      if (current === "active") steps.push(["converging", "some node has not applied yet"]);
      if (current !== "degraded") steps.push(["degraded", "node failed, offline, Kong unhealthy or evidence diverges"]);
    } else if (current === "active" || current === "degraded") {
      steps.push(["converging", current === "active" ? "some node has not applied yet" : "nodes back"]);
    }
    if (steps.length > 0) await transition(tx, dep.epoch, dep.revision, steps);
    if (converged) {
      await this.activate(tx, dep, now);
      if (takesLease) await this.freeLease(tx);
    }
    return views;
  }

  /** The first convergence of each member's content here (G-2): insert once, never moved. */
  private async activate(tx: Executor, dep: DeploymentRow, now: Date) {
    for (const m of dep.members as DeploymentMember[]) {
      await tx.insert(contentActivations).values({ workspaceId: m.workspaceId, contentDigest: m.contentDigest, firstActivatedAt: now, deploymentRevision: dep.revision }).onConflictDoNothing();
    }
  }

  private async freeLease(tx: Executor) {
    await tx.update(deploymentLease).set({ revision: null, operation: null, owner: null, startedAt: null, deadlineAt: null });
  }

  /**
   * The expected nodes of `dep` now: those recorded with it whose cluster is still v2, plus the nodes seen since a
   * cluster that became v2 after the revision joined. Each with the evidence that it applied the revision.
   */
  private async nodeViews(tx: Executor, dep: DeploymentRow, now: Date): Promise<NodeView[]> {
    const v2 = await tx.select().from(clusters).where(eq(clusters.deliveryProtocol, "v2"));
    const v2Ids = new Set(v2.map((c) => c.id));
    const expected = new Map<string, { clusterId: string; nodeId: string }>();
    for (const e of dep.expectedNodes as { clusterId: string; nodeId: string }[]) if (v2Ids.has(e.clusterId)) expected.set(`${e.clusterId}/${e.nodeId}`, e);
    // A cluster that became v2 after the revision was recorded joins with every registered node.
    const joined = v2.filter((c) => c.deliveryProtocolChangedAt && c.deliveryProtocolChangedAt > dep.createdAt);
    if (joined.length > 0) {
      const rows = await tx.select({ clusterId: clusterNodes.clusterId, nodeId: clusterNodes.nodeId }).from(clusterNodes).where(inArray(clusterNodes.clusterId, joined.map((c) => c.id)));
      for (const r of rows) expected.set(`${r.clusterId}/${r.nodeId}`, r);
    }
    const views: NodeView[] = [];
    for (const e of expected.values()) {
      const [node] = await tx.select().from(clusterNodes).where(and(eq(clusterNodes.clusterId, e.clusterId), eq(clusterNodes.nodeId, e.nodeId)));
      const online = !!node && now.getTime() - node.lastSeenAt.getTime() <= OFFLINE_SECONDS * 1000;
      const failed = !!node && node.epoch === dep.epoch && node.failedRevision === dep.revision && node.failedDeploymentHash === dep.configHash;
      const evidence = node ? await this.evidence(tx, dep, node, now) : "awaiting-status";
      if (node) await this.auditEvidence(tx, dep, node, evidence);
      // Not reported yet is not unhealthy: kong_healthy only means something once a v2 status set it.
      views.push({ ...e, node, online, healthy: !node || node.epoch === null || node.kongHealthy, failed, evidence });
    }
    return views;
  }

  /** The node's evidence, recording the highest revision it was verified at (revision-regression is measured against it). */
  private async evidence(tx: Executor, dep: DeploymentRow, node: ClusterNodeRow, now: Date): Promise<Evidence> {
    const evidence = await this.currentEvidence(tx, dep, node, now);
    if (evidence === "verified" && (node.verifiedEpoch !== dep.epoch || node.verifiedRevision === null || node.verifiedRevision < dep.revision)) {
      await tx.update(clusterNodes).set({ verifiedEpoch: dep.epoch, verifiedRevision: dep.revision }).where(and(eq(clusterNodes.clusterId, node.clusterId), eq(clusterNodes.nodeId, node.nodeId)));
    }
    return evidence;
  }

  /**
   * The node's evidence now, by evidenceOf: its status, the newest acknowledged report of its open admission and when it
   * arrived. Writes nothing. The only reading of current evidence: cluster_nodes.evidence and verified_revision are what
   * the node once proved (audit and regression), never proof that it still does (D-3).
   */
  private async currentEvidence(tx: Executor, dep: DeploymentRow, node: ClusterNodeRow, now: Date): Promise<Evidence> {
    // A refused regression is not recorded: the node shows it until it reports the current revision.
    if (node.failureReason === "revision-regression") return "revision-regression";
    const [admission] = await tx
      .select()
      .from(isolationAdmissions)
      .where(and(eq(isolationAdmissions.clusterId, node.clusterId), eq(isolationAdmissions.nodeId, node.nodeId), eq(isolationAdmissions.outcome, "granted"), eq(isolationAdmissions.state, "open")))
      .orderBy(desc(isolationAdmissions.decidedAt))
      .limit(1);
    let probe: ProbeEvidence | null = null;
    let receivedAt: Date | null = null;
    if (admission && admission.ackedSeq > 0) {
      const [report] = await tx
        .select({ payload: isolationReports.payload, receivedAt: isolationReports.receivedAt })
        .from(isolationReports)
        .where(and(eq(isolationReports.admissionId, admission.admissionId!), eq(isolationReports.seq, admission.ackedSeq)));
      if (report) {
        probe = JSON.parse(Buffer.from(report.payload, "base64url").toString("utf8")) as ProbeEvidence;
        receivedAt = report.receivedAt;
      }
    }
    return evidenceOf(
      {
        clusterId: node.clusterId,
        nodeId: node.nodeId,
        podUid: admission?.podUid ?? null,
        admissionId: admission?.admissionId ?? null,
        epoch: dep.epoch,
        revision: dep.revision,
        configHash: dep.configHash,
        kongConfigHash: dep.kongConfigHash!,
        lastVerifiedRevision: node.verifiedEpoch === dep.epoch ? node.verifiedRevision ?? 0 : 0,
        revisionRecordedAt: dep.createdAt,
        now,
      },
      { nodeId: node.nodeId, epoch: node.epoch, appliedRevision: node.appliedRevision, appliedHash: node.deploymentHash, kongConfigHash: node.kongConfigHash },
      probe,
      receivedAt,
    );
  }

  /** A divergence of evidence is audited once when it opens and once when it clears (agent protocol v2). */
  private async auditEvidence(tx: Executor, dep: DeploymentRow, node: ClusterNodeRow, evidence: Evidence) {
    if (node.evidence === evidence) return;
    const was = DEGRADING.includes(node.evidence as Evidence);
    const is = DEGRADING.includes(evidence);
    await tx.update(clusterNodes).set({ evidence }).where(and(eq(clusterNodes.clusterId, node.clusterId), eq(clusterNodes.nodeId, node.nodeId)));
    if (!was && !is) return;
    const [cluster] = await tx.select({ environmentId: clusters.environmentId }).from(clusters).where(eq(clusters.id, node.clusterId));
    const event = (action: string, from: string | null, to: string) =>
      audit(tx, SYSTEM, { action, entityType: "node", entityId: node.nodeId, environmentId: cluster!.environmentId, before: { evidence: from }, after: { clusterId: node.clusterId, epoch: dep.epoch, revision: dep.revision, evidence: to } });
    // One divergence turning into another closes the first and opens the second.
    if (was) await event("deployment.evidence.cleared", node.evidence, evidence);
    if (is) await event("deployment.evidence.opened", node.evidence, evidence);
  }

  /**
   * The activation gate (v2-pending -> v2): every node of the cluster seen in the last 45 s has an open admission
   * whose latest acknowledged round was conclusive and passed, and no pendency of the cluster is open.
   */
  private async activateCluster(tx: Tx, clusterId: string): Promise<boolean> {
    // One consistent view of admissions, reports and pendencies: the isolation module's cluster lock, then the row.
    await isolationLock(tx, clusterId);
    const [cluster] = await tx.select().from(clusters).where(eq(clusters.id, clusterId)).for("update");
    if (cluster!.deliveryProtocol === "v2") return true;
    if (cluster!.deliveryProtocol !== "v2-pending") return false;
    // The current agent learns its first epoch from delivery before it can report: keep the new gate lab-only/off.
    const collectorTokenGate = this.config.workspacesDeployments?.collectorTokenGate === true;
    if (collectorTokenGate) {
      const tokenState = (await reconcileCollectorTokens(tx)).get(clusterId);
      if (!tokenState || tokenState.shared || tokenState.unverified) return false;
    }
    // Every registered node is expected (none is deregistered yet), and a node without an open admission (a v1-mode
    // agent) holds the gate: one writer per Kong.
    const nodes = await tx.select({ nodeId: clusterNodes.nodeId }).from(clusterNodes).where(eq(clusterNodes.clusterId, clusterId));
    if (nodes.length === 0) return false;
    const [pendency] = await tx.select({ id: isolationPendencies.id }).from(isolationPendencies).where(and(eq(isolationPendencies.clusterId, clusterId), inArray(isolationPendencies.lifecycle, [...OPEN_PENDENCIES]))).limit(1);
    if (pendency) return false;
    for (const n of nodes) {
      const [passing] = await tx
        .select({ id: isolationAdmissions.id })
        .from(isolationAdmissions)
        .where(
          and(
            eq(isolationAdmissions.clusterId, clusterId),
            eq(isolationAdmissions.nodeId, n.nodeId),
            eq(isolationAdmissions.state, "open"),
            sql`${isolationAdmissions.lastConclusiveAt} is not null`,
            inArray(isolationAdmissions.lastState, PASSING),
            sql`jsonb_array_length(${isolationAdmissions.lastFailed}) = 0`,
          ),
        )
        .limit(1);
      if (!passing) return false;
    }
    await tx.update(clusters).set({ deliveryProtocol: "v2", deliveryProtocolChangedAt: sql`clock_timestamp()` }).where(eq(clusters.id, clusterId));
    await audit(tx, SYSTEM, {
      action: "cluster.delivery-protocol",
      entityType: "cluster",
      entityId: clusterId,
      environmentId: cluster!.environmentId,
      before: { deliveryProtocol: "v2-pending" },
      after: { deliveryProtocol: "v2", reason: `activation gate: every node passed a conclusive round, no pendency open${collectorTokenGate ? ", collector token exclusive" : ""}`, nodes: nodes.map((n) => n.nodeId) },
    });
    return true;
  }

  /** setClusterDeliveryProtocol: the only explicit change of a cluster's flow (D2, D5); session, audited. */
  async setProtocol(ctx: RequestContext, clusterId: string, body: { protocol: "v1" | "v2"; reason: string }) {
    return this.db.transaction(async (tx) => {
      await leaseFirst(tx);
      await isolationLock(tx, clusterId);
      const [cluster] = await tx.select().from(clusters).where(eq(clusters.id, clusterId)).for("update");
      if (!cluster) throw notFound("Cluster");
      const from = cluster.deliveryProtocol;
      let to: ClusterRow["deliveryProtocol"];
      if (body.protocol === "v2") {
        if (!this.enabled) throw deliveryRefused("workspaces-mode-disabled", "Workspaces mode is disabled on this instance");
        if (from !== "v1") throw deliveryRefused("delivery-protocol-unchanged", `The cluster is already ${from}`);
        to = "v2-pending";
      } else {
        if (from === "v1") throw deliveryRefused("delivery-protocol-unchanged", "The cluster is already v1");
        if (from === "v2") {
          const [env] = await tx.select({ currentVersion: environments.currentVersion }).from(environments).where(eq(environments.id, cluster.environmentId));
          if (env?.currentVersion == null) throw deliveryRefused("no-v1-snapshot", "The cluster's environment has no published v1 snapshot to return to");
        }
        to = "v1";
      }
      await tx.update(clusters).set({ deliveryProtocol: to, deliveryProtocolChangedAt: sql`clock_timestamp()` }).where(eq(clusters.id, clusterId));
      await audit(tx, ctx, {
        action: "cluster.delivery-protocol",
        entityType: "cluster",
        entityId: clusterId,
        environmentId: cluster.environmentId,
        before: { deliveryProtocol: from },
        after: { deliveryProtocol: to, reason: body.reason },
      });
      // The nodes' v1 event streams close and reconnect into the new rules; a cluster leaving v2 leaves the
      // expected nodes of the current deployment, which re-evaluates.
      await tx.execute(sql`select pg_notify(${AGENT_CHANNEL}, ${JSON.stringify({ clusterId })})`);
      const views = from === "v2" ? await this.evaluate(tx) : [];
      return this.toInstanceCluster(tx, { ...cluster, deliveryProtocol: to }, views);
    });
  }

  /** A cluster as the instance sees it now (InstanceCluster): its status from current evidence only (D-3). */
  async clusterView(clusterId: string) {
    return this.db.transaction(async (tx) => {
      const [cluster] = await tx.select().from(clusters).where(eq(clusters.id, clusterId));
      if (!cluster) throw notFound("Cluster");
      return this.toInstanceCluster(tx, cluster, []);
    });
  }

  /**
   * converged only while every node is online and its current evidence is verified for the latest deployment; degraded
   * when a node is offline, failed, Kong unhealthy, its evidence diverges, or it lost the evidence of a revision it had
   * proved; converging otherwise (also while the cluster waits for its activation: nothing proved in it yet).
   */
  private async toInstanceCluster(tx: Executor, cluster: ClusterRow, views: NodeView[]) {
    const now = await clock(tx);
    const nodes = await tx.select().from(clusterNodes).where(eq(clusterNodes.clusterId, cluster.id)).orderBy(clusterNodes.nodeId);
    const online = (n: ClusterNodeRow) => now.getTime() - n.lastSeenAt.getTime() <= OFFLINE_SECONDS * 1000;
    const evidence = new Map(views.filter((v) => v.clusterId === cluster.id).map((v) => [v.nodeId, v.evidence]));
    const dep = cluster.deliveryProtocol === "v2" ? await latestDeployment(tx) : undefined;
    if (dep) for (const n of nodes) if (!evidence.has(n.nodeId)) evidence.set(n.nodeId, await this.currentEvidence(tx, dep, n, now));
    let status: "no-nodes" | "converged" | "converging" | "degraded" = "no-nodes";
    if (nodes.length > 0) {
      if (cluster.deliveryProtocol === "v1") {
        status = nodes.some((n) => !online(n) || n.state === "failed") ? "degraded" : nodes.every((n) => n.state === "applied") ? "converged" : "converging";
      } else if (nodes.some((n) => !online(n))) {
        status = "degraded";
      } else if (dep) {
        const proved = (n: ClusterNodeRow) => n.verifiedEpoch === dep.epoch && n.verifiedRevision !== null && n.verifiedRevision >= dep.revision;
        const lost = (n: ClusterNodeRow) => {
          const e = evidence.get(n.nodeId)!;
          const failed = n.epoch === dep.epoch && n.failedRevision === dep.revision && n.failedDeploymentHash === dep.configHash;
          return failed || (n.epoch !== null && !n.kongHealthy) || DEGRADING.includes(e) || (e !== "verified" && proved(n));
        };
        status = nodes.some(lost) ? "degraded" : nodes.every((n) => evidence.get(n.nodeId) === "verified") ? "converged" : "converging";
      } else {
        status = "converging";
      }
    }
    return {
      id: cluster.id,
      name: cluster.name,
      status,
      nodes: nodes.map((n) => ({
        nodeId: n.nodeId,
        hostname: n.hostname,
        state: n.state,
        epoch: n.epoch,
        appliedRevision: n.appliedRevision,
        appliedHash: n.deploymentHash,
        kongHealthy: n.kongHealthy,
        lastSeenAt: n.lastSeenAt.toISOString(),
        online: online(n),
        kongConfigHash: n.kongConfigHash,
        ...(evidence.has(n.nodeId) ? { evidence: evidence.get(n.nodeId) } : {}),
      })),
      createdAt: cluster.createdAt.toISOString(),
      deliveryProtocol: cluster.deliveryProtocol,
      environmentId: cluster.environmentId,
    };
  }
}

@Controller("agent/v2")
@UseGuards(AgentBearerGuard)
export class AgentDeploymentsController {
  constructor(private readonly delivery: DeliveryService) {}

  // Public skips user RBAC; AgentBearerGuard enforces the node token on every handler.
  @Get("deployments/current")
  @Public()
  current(@Req() req: Request, @Res() res: Response) {
    return this.delivery.current(req, res);
  }

  @Post("status")
  @HttpCode(204)
  @Public()
  report(@Req() req: Request, @Body(agentBodyV2("StatusReport")) body: StatusReportV2) {
    return this.delivery.report(req, body);
  }
}

@Controller("api/v2/clusters")
export class DeliveryProtocolController {
  constructor(private readonly delivery: DeliveryService) {}

  @Put(":clusterId/delivery-protocol")
  @SessionOnly()
  @RequiredPermission("platform.admin", "instance")
  set(@Ctx() ctx: RequestContext, @Param("clusterId", uuidParam()) clusterId: string, @Body(contractBodyV2(inlineBody("/clusters/{clusterId}/delivery-protocol", "put"))) body: { protocol: "v1" | "v2"; reason: string }) {
    return this.delivery.setProtocol(ctx, clusterId, body);
  }
}

@Module({
  imports: [AgentGatewayModule],
  controllers: [AgentDeploymentsController, DeliveryProtocolController],
  providers: [DeliveryService],
  exports: [DeliveryService],
})
export class DeploymentsModule {}

