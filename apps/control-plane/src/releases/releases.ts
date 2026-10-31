import { workspaceTransaction } from "../common/workspace-transaction.js";
import { createHash } from "node:crypto";
import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Injectable, Module, Param, Post } from "@nestjs/common";
import {
  buildSnapshotV2,
  CompileError,
  contentDigest,
  type DeploymentMember as ComposedMember,
  type GatewayState,
  type InstanceValue,
  jcs,
  type KongDeclarativeConfig,
  placeholderVariables,
  platformPlugins,
  resolveVariables,
  type WorkspaceContent,
} from "@gromesh/compiler";
import { and, asc, desc, eq, inArray, max, notInArray, sql } from "drizzle-orm";
import { audit } from "../audit/audit.js";
import { Ctx, RequiredPermission, type RequestContext } from "../auth/auth.js";
import { contractBodyV2, inlineBody } from "../common/contract.js";
import { destinationIssues, destinationPolicy, type DestinationPolicy } from "../common/destinations.js";
import { conflict, deliveryRefused, notFound, ProblemException, unprocessable } from "../common/problem.js";
import { stateVaultReferenceIssues } from "../common/vault-references.js";
import { APP_CONFIG, type AppConfig } from "../config.js";
import { deploymentContext, ENCRYPTOR, Encryptor, releaseContext, variableValueContext } from "../crypto/crypto.js";
import { DB, type Db, type Executor, type Tx } from "../db/db.js";
import {
  contentActivations,
  contentRevocations,
  deploymentLease,
  deployments,
  deploymentStates,
  instance,
  releases,
  workspaceActiveRelease,
  workspaces,
  workspaceVariables,
  workspaceVariableValues,
  type DeploymentMember,
  type InstanceRow,
  type ReleaseRow,
} from "../db/schema.js";
import { v2ExpectedNodes } from "../deployments/deployments.js";
import { requireEnvironment, uuidParam } from "../environments/environments.js";
import { type Declaration, valueProblem } from "../workspaces/variables.js";
import { loadGatewayState } from "../gateway/gateway.js";
import { PluginCatalog, PluginCatalogModule } from "../plugin-catalog/catalog.js";

type DeploymentState = (typeof deploymentStates.$inferSelect)["state"];
type Settings = NonNullable<AppConfig["workspacesDeployments"]>;
type Stage = Settings["stage"];

/** The epoch of the instance's deployments until the snapshots → releases migration opens the next one (D5). */
const FIRST_EPOCH = 1;
const forbidden = (detail: string) => new ProblemException(HttpStatus.FORBIDDEN, detail);
const PUBLISH_BODY = inlineBody("/workspaces/{workspaceId}/releases", "post");

interface PublishBody {
  message?: string;
  expectedActiveVersion?: number | null;
}

/** A release's content opened: the workspace's draft without credentials, which are values of each instance. */
/** The release keeps the draft's variable declarations (never a value: those stay on each instance, WS-V1). */
type ReleaseVariable = { name: string; type: string; secret: boolean; required: boolean; validation?: Record<string, unknown> };
type ReleaseState = GatewayState & { variables?: ReleaseVariable[] };

/**
 * The release content in the contract's model (WorkspaceContent): every entity as {id, spec}. Plugin secrets and
 * certificate keys stay sealed in the release and enter the digest only as an HMAC under the instance's fingerprint key,
 * so a digest that leaves through the API is no oracle for them (until variables carry them as VarRef, N1-X4b).
 */
export function releaseContent(state: ReleaseState, enc: Encryptor, catalog: PluginCatalog): WorkspaceContent {
  const secret = (owner: string, path: string, value: string) => `hmac-sha256:${enc.fingerprint(["release-secret", owner, path, value].join("\0"))}`;
  const spec = <T extends { id: string }>(e: T) => {
    const { id, ...rest } = e;
    return { id, spec: rest };
  };
  return {
    // The contract's service fields only: upstreamId for a v2 service bound to one, never the internal binding flag; a
    // field that names a variable is the VarRef (the value lives on each instance, WS-V2).
    services: state.services.map(({ binding, upstreamId, varRefs, ...s }) =>
      spec({ ...s, ...(binding === "explicit" && upstreamId ? { upstreamId } : {}), ...Object.fromEntries(Object.entries(varRefs ?? {}).map(([field, name]) => [field, { $var: name }])) }),
    ),
    routes: state.routes.map(spec),
    consumers: state.consumers.map(({ id, aclGroups, ...rest }) => ({ id, aclGroups: aclGroups ?? [], spec: rest })),
    credentials: [],
    plugins: state.plugins.map((p) => spec({ ...p, config: catalog.mapSecrets(p.name, p.config ?? {}, (v, path) => secret(p.id, path.join("."), v)) })),
    upstreams: (state.upstreams ?? []).map(spec),
    targets: (state.targets ?? []).map(({ id, upstreamId, ...rest }) => ({ id, upstreamId, spec: rest })),
    certificates: (state.certificates ?? []).map((c) => spec({ ...c, key: secret(c.id, "key", c.key) })),
    variables: (state.variables ?? []).map(({ name, type, secret, required, validation }) => ({ name, type, secret, required, ...(validation ? { validation } : {}) })),
  };
}

/**
 * An answer's issues without any substituted value. A message about a field filled from a variable never quotes it
 * (it is replaced by a fixed text: masking value by value fails when values overlap, a prefix hiding the rest of a
 * longer one); any other message is masked longest value first, as a second line of defence.
 */
const redacted = (issues: { path: string; message: string }[], secrets: readonly string[], fromVariables: readonly string[] = []) => {
  const longestFirst = [...new Set(secrets.filter((s) => s.length > 0))].sort((a, b) => b.length - a.length);
  return issues.map((i) =>
    fromVariables.some((p) => i.path === p || i.path.startsWith(`${p}.`) || i.path.startsWith(`${p}[`))
      ? { ...i, message: "refused for a value that comes from a variable (not shown)" }
      : { ...i, message: longestFirst.reduce((m, s) => m.split(s).join("REDACTED"), i.message) },
  );
};

const withoutCredentials = (state: GatewayState): ReleaseState => ({ ...state, keyAuthCredentials: [], jwtCredentials: [], basicAuthCredentials: [] });

/** The database clock after any lock wait: deadlines are compared with it, never with a replica's clock. */
async function clock(tx: Executor): Promise<Date> {
  const { rows } = await tx.execute<{ now: Date | string }>(sql`select clock_timestamp() as now`);
  return new Date(rows[0]!.now);
}

/** The machine's current state of a deployment: its highest transition. */
export async function deploymentState(tx: Executor, epoch: number, revision: number): Promise<{ state: DeploymentState; seq: number } | undefined> {
  const [row] = await tx
    .select({ state: deploymentStates.state, seq: deploymentStates.seq })
    .from(deploymentStates)
    .where(and(eq(deploymentStates.epoch, epoch), eq(deploymentStates.revision, revision)))
    .orderBy(desc(deploymentStates.seq))
    .limit(1);
  return row;
}

/** Appends the transitions, in order; the caller holds the deployment lease row, so seqs never race. */
export async function transition(tx: Executor, epoch: number, revision: number, steps: [DeploymentState, string][]): Promise<void> {
  let seq = (await deploymentState(tx, epoch, revision))?.seq ?? 0;
  for (const [state, reason] of steps) await tx.insert(deploymentStates).values({ epoch, revision, seq: ++seq, state, reason });
}

/** The shortest path the contract's machine allows from `from` to failed on the convergence deadline. */
const TO_FAILED: Partial<Record<DeploymentState, DeploymentState[]>> = {
  active: ["converging", "degraded", "failed"],
  converging: ["degraded", "failed"],
  degraded: ["failed"],
};

@Injectable()
export class ReleasesService {
  private readonly destinations: DestinationPolicy;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ENCRYPTOR) private readonly enc: Encryptor,
    private readonly catalog: PluginCatalog,
  ) {
    this.destinations = destinationPolicy(config);
  }

  /**
   * D4: deployment and activation are off unless a disposable laboratory turned them on (N3-K1: 409
   * workspaces-mode-disabled, nothing recorded). Publishing a release never needs it.
   */
  private settings(): Settings {
    const settings = this.config.workspacesDeployments;
    if (!settings) throw deliveryRefused("workspaces-mode-disabled", "Workspaces mode is disabled on this instance");
    return settings;
  }

  /** Reading is harmless: with Workspaces mode off there is simply no release. */
  async list(workspaceId: string) {
    await this.requireWorkspace(this.db, workspaceId);
    const rows = await this.db.select().from(releases).where(eq(releases.workspaceId, workspaceId)).orderBy(desc(releases.version));
    return this.toReleases(this.db, rows);
  }

  /**
   * The single lease row: every release and deployment of the instance, from any replica, goes through it one at a
   * time. A live lease refuses with 409. Dev only (403). Only a deployment (`expire`) fails a lease past its deadline:
   * publishing a release treats it as free and writes no deployment transition (D4), so it stays inert with the
   * Workspaces mode off.
   */
  private async lease(tx: Tx, stage: Stage | null, expire: boolean) {
    const [lease] = await tx.select().from(deploymentLease).for("update");
    const self = await this.instance(tx, stage);
    if (self.stage !== "dev") throw forbidden(`Local publishing and deployment exist only on dev; this instance is ${self.stage}`);
    const now = await clock(tx);
    if (lease!.revision !== null) {
      if (lease!.deadlineAt && lease!.deadlineAt > now) throw conflict(`Deployment revision ${lease!.revision} holds the deployment lease`);
      if (expire) await this.expire(tx, lease!.revision);
    }
    return { self, now };
  }

  /**
   * publishRelease (dev only): freezes the workspace draft into an immutable release, which becomes the workspace's
   * active release. It deploys nothing and grants nothing (decision D4): only createDeployment composes a revision,
   * so it is allowed with Workspaces deployments off.
   */
  async publish(ctx: RequestContext, workspaceId: string, body: PublishBody) {
    const stage = this.config.workspacesDeployments?.stage ?? this.config.instanceStage ?? null;
    return workspaceTransaction(this.db, workspaceId, async (tx) => {
      const { self } = await this.lease(tx, stage, false);

      // Every edit and import of the draft updates this row in its own transaction (markDraftChanged): holding it, the
      // draft read below is one committed state, never half of an edit in flight (as v1 publish). Environment before
      // workspace, the order an environment's deletion takes them (its cascade), so the two never deadlock.
      await requireEnvironment(tx, workspaceId, true);
      const ws = await this.requireWorkspace(tx, workspaceId, true);
      if (!ws.slug) throw unprocessable("The workspace cannot be published", [{ path: "slug", message: "the workspace has no slug yet" }]);
      const [active] = await tx.select().from(workspaceActiveRelease).where(eq(workspaceActiveRelease.workspaceId, workspaceId));
      if (body.expectedActiveVersion !== undefined && body.expectedActiveVersion !== (active?.version ?? null)) {
        throw conflict(`Active release is ${active?.version ?? "none"}, expected ${body.expectedActiveVersion ?? "none"}`);
      }

      const draft = await loadGatewayState(tx, workspaceId, this.enc, this.catalog);
      const forbiddenIssues = [...destinationIssues(draft, this.destinations), ...stateVaultReferenceIssues(draft)];
      if (forbiddenIssues.length > 0) throw unprocessable("The draft cannot be published", forbiddenIssues);
      const declared = await tx.select().from(workspaceVariables).where(eq(workspaceVariables.workspaceId, workspaceId)).orderBy(asc(workspaceVariables.name));
      const state: ReleaseState = { ...withoutCredentials(draft), variables: declared.map((v) => ({ name: v.name, type: v.type, secret: v.secret, required: v.required, ...(v.validation ? { validation: v.validation } : {}) })) };
      const content = releaseContent(state, this.enc, this.catalog);
      const digest = contentDigest(content);
      // The release must compose on its own (prefix, guard, reserved names): what only fails against the other
      // workspaces surfaces at createDeployment.
      try {
        // Variables keep their place until a deployment resolves them: the structure is checked with placeholders.
        buildSnapshotV2([{ id: workspaceId, slug: ws.slug, state: placeholderVariables(await this.withCredentials(tx, workspaceId, state)), releaseVersion: 1, content }], { instanceId: self.id, epoch: FIRST_EPOCH, revision: 1 });
      } catch (err) {
        if (err instanceof CompileError) throw unprocessable("The draft cannot be published", err.issues);
        throw err;
      }
      const activeRow = active ? await this.findRelease(tx, workspaceId, active.version) : undefined;
      if (activeRow?.contentDigest === digest) throw conflict("Nothing to publish: the draft equals the active release");

      const [{ last }] = (await tx.select({ last: max(releases.version) }).from(releases).where(eq(releases.workspaceId, workspaceId))) as [{ last: number | null }];
      const version = (last ?? 0) + 1;
      const [first] = await tx
        .select({ version: releases.version })
        .from(releases)
        .where(and(eq(releases.workspaceId, workspaceId), eq(releases.contentDigest, digest)))
        .orderBy(asc(releases.version))
        .limit(1);
      const [release] = await tx
        .insert(releases)
        .values({
          workspaceId,
          version,
          content: this.enc.sealJson(state, releaseContext(workspaceId, version)),
          contentDigest: digest,
          origin: "local",
          message: body.message ?? null,
          createdBy: ctx.actor,
          contentOriginVersion: first?.version ?? version,
        })
        .returning();
      // The slug is part of every public path from the first release on.
      await tx.update(workspaces).set({ slugLockedAt: sql`coalesce(${workspaces.slugLockedAt}, now())` }).where(eq(workspaces.id, workspaceId));

      // The revision that composes it is unknown until the next createDeployment.
      await tx
        .insert(workspaceActiveRelease)
        .values({ workspaceId, version, deploymentRevision: null })
        .onConflictDoUpdate({ target: workspaceActiveRelease.workspaceId, set: { version, deploymentRevision: null } });
      // The values of variables this release no longer declares end with it (contract: kept until a release without
      // the declaration is active). Only the names are audited.
      const kept = (state.variables ?? []).map((v) => v.name);
      const purged = await tx
        .delete(workspaceVariableValues)
        .where(and(eq(workspaceVariableValues.workspaceId, workspaceId), kept.length > 0 ? notInArray(workspaceVariableValues.name, kept) : undefined))
        .returning({ name: workspaceVariableValues.name });
      if (purged.length > 0) {
        await audit(tx, ctx, { action: "workspace_variable.value.purge", entityType: "workspace_variable", environmentId: workspaceId, after: { names: [...new Set(purged.map((p) => p.name))].sort(), release: version } });
      }
      await audit(tx, ctx, {
        action: "release.publish",
        entityType: "release",
        entityId: `${workspaceId}:${version}`,
        environmentId: workspaceId,
        after: { version, contentDigest: digest, message: body.message ?? null },
      });
      return (await this.toReleases(tx, [release!]))[0]!;
    });
  }

  /**
   * createDeployment (dev only, decision D4): composes every workspace's active release into the instance's next
   * revision through the compiler, fixes configHash, kongConfigHash (md5 of the JCS bytes served to the agents, N3-K1)
   * and the expected nodes. A composition the compiler refuses records nothing (422).
   */
  async deploy(ctx: RequestContext, body: { expectedRevision: number | null; reason: string }) {
    const settings = this.settings();
    return this.db.transaction(async (tx) => {
      const { self, now } = await this.lease(tx, settings.stage, true);
      const latest = await this.currentRevision(tx);
      if (body.expectedRevision !== (latest ?? null)) throw conflict(`Current revision is ${latest ?? "none"}, expected ${body.expectedRevision ?? "none"}`);
      const deployment = await this.compose(tx, ctx, self, settings, now);
      await audit(tx, ctx, {
        action: "deployment.create",
        entityType: "deployment",
        entityId: `${deployment.epoch}:${deployment.revision}`,
        environmentId: null,
        after: { reason: body.reason, epoch: deployment.epoch, revision: deployment.revision, configHash: deployment.configHash, kongConfigHash: deployment.kongConfigHash, members: deployment.members, expectedNodes: deployment.expectedNodes },
      });
      return {
        epoch: deployment.epoch,
        revision: deployment.revision,
        state: deployment.state,
        members: deployment.members,
        configHash: deployment.configHash,
        kongConfigHash: deployment.kongConfigHash,
        convergence: deployment.expectedNodes.length === 0 ? "no-nodes" : "converging",
        clusters: [],
      };
    });
  }

  /** The next revision of the instance: every workspace's active release. */
  private async compose(tx: Tx, ctx: RequestContext, self: InstanceRow, settings: Settings, now: Date) {
    const memberRows = (await tx.select().from(workspaceActiveRelease).orderBy(asc(workspaceActiveRelease.workspaceId))).map((o) => ({ workspaceId: o.workspaceId, version: o.version }));
    if (memberRows.length === 0) throw unprocessable("Nothing to deploy", [{ path: "workspaces", message: "no workspace has a release" }]);
    const slugs = new Map((await tx.select({ id: workspaces.id, slug: workspaces.slug }).from(workspaces).where(inArray(workspaces.id, memberRows.map((m) => m.workspaceId)))).map((w) => [w.id, w.slug]));
    const members: ComposedMember[] = [];
    const recorded: DeploymentMember[] = [];
    // WS-V2: each release's variables resolved from this instance's current values, checked again as the fields they
    // fill (shape, forbidden destinations); a missing or refused value rejects the deployment before any node.
    const usedValues: { workspaceId: string; name: string; version: number; sha256: string }[] = [];
    // Secret values substituted into the composition: never in an answer, whatever refuses it.
    const secretValues: string[] = [];
    // The paths of the services whose fields came from variables, in every form an issue may name them.
    const fromVariables: string[] = [];
    for (const m of memberRows) {
      const state = await this.openRelease(tx, m.workspaceId, m.version);
      const content = releaseContent(state, this.enc, this.catalog);
      let resolved: ReleaseState;
      const where = `workspaces.${slugs.get(m.workspaceId)}`;
      const values = await this.instanceValues(tx, m.workspaceId);
      // Against the declarations the release froze: every required one has a value here, and each value fits its
      // declaration (type, validation) as it stands in the release, not as the draft has it now.
      const declared = state.variables ?? [];
      const valueIssues = declared.flatMap((d) => {
        const v = values.get(d.name);
        if (!v) return d.required ? [{ path: `${where}.variables.${d.name}`, message: "required variable without a value on this instance" }] : [];
        const problem = valueProblem({ type: d.type as Declaration["type"], secret: d.secret, validation: d.validation as Declaration["validation"] }, v.value);
        return problem ? [{ path: `${where}.variables.${d.name}`, message: `the value ${problem}` }] : [];
      });
      if (valueIssues.length > 0) throw unprocessable("A variable of a release cannot be resolved on this instance", valueIssues);
      // Every substituted value is kept out of an answer: a value set as secret after the release froze its declaration
      // (or any other) never shows in a refusal.
      for (const d of declared) if (values.get(d.name)) secretValues.push(values.get(d.name)!.value);
      const memberIndex = memberRows.indexOf(m);
      state.services.forEach((svc, j) => {
        if (svc.varRefs && Object.keys(svc.varRefs).length > 0) fromVariables.push(`${where}.services[${j}]`, `services[${j}]`, `workspaces[${memberIndex}].services[${j}]`);
      });
      try {
        const out = resolveVariables(state, new Set(declared.map((v) => v.name)), values);
        resolved = { ...out.state, variables: state.variables };
        for (const [name, v] of out.used) usedValues.push({ workspaceId: m.workspaceId, name, version: v.version, sha256: createHash("sha256").update(v.value).digest("hex") });
      } catch (err) {
        if (err instanceof CompileError) throw unprocessable("A variable of a release cannot be resolved on this instance", redacted(err.issues.map((i) => ({ path: `${where}.${i.path}`, message: i.message })), secretValues, fromVariables));
        throw err;
      }
      const forbidden = destinationIssues(resolved, this.destinations);
      if (forbidden.length > 0) throw unprocessable("A variable's value is a forbidden destination", redacted(forbidden.map((i) => ({ ...i, path: `${where}.${i.path}` })), secretValues, fromVariables));
      members.push({ id: m.workspaceId, slug: slugs.get(m.workspaceId)!, state: await this.withCredentials(tx, m.workspaceId, resolved), releaseVersion: m.version, content });
      recorded.push({ workspaceId: m.workspaceId, releaseVersion: m.version, contentDigest: contentDigest(content) });
    }
    recorded.sort((a, b) => (a.workspaceId < b.workspaceId ? -1 : 1));

    const [{ last }] = (await tx.select({ last: max(deployments.revision) }).from(deployments).where(eq(deployments.epoch, FIRST_EPOCH))) as [{ last: number | null }];
    const revision = (last ?? 0) + 1;
    const endpoint = this.config.platformHttpLogEndpoint;
    let config: KongDeclarativeConfig;
    let configHash: string;
    let kongConfigHash: string;
    try {
      // The composed config is instance-wide: the platform plugins carry the instance id where v1 carries the environment's.
      const envelope = buildSnapshotV2(
        members,
        { instanceId: self.id, epoch: FIRST_EPOCH, revision, reason: "publish", createdAt: now.toISOString() },
        endpoint ? { platformPlugins: platformPlugins({ httpLogEndpoint: endpoint, environmentId: self.id }) } : undefined,
      );
      config = envelope.config;
      configHash = envelope.hash;
      // What Kong computes for the bytes the agent posts as {"config": "<JCS>"} (agent protocol v2, "Expected Kong hash").
      kongConfigHash = createHash("md5").update(jcs(config), "utf8").digest("hex");
    } catch (err) {
      // Nothing is recorded and nothing is served (composed → rejected never persists).
      if (err instanceof CompileError) throw unprocessable("The instance's composition refuses this deployment", redacted(err.issues, secretValues, fromVariables));
      throw err;
    }
    // D2: only the nodes of clusters explicitly in v2 are expected (agent protocol v2, "Delivery protocol per cluster").
    const expectedNodes = await v2ExpectedNodes(tx);
    await tx.insert(deployments).values({
      epoch: FIRST_EPOCH,
      revision,
      members: recorded,
      expectedNodes,
      config: this.enc.sealJson(config, deploymentContext(FIRST_EPOCH, revision)),
      configHash,
      kongConfigHash,
      // The values this revision composed (names, versions and value hashes under the instance's key; never a value).
      // HMAC-SHA256 under the instance's key, written as the contract's Digest (sha256:<hex>).
      valuesDigest: usedValues.length > 0 ? `sha256:${this.enc.fingerprint(JSON.stringify(usedValues.sort((a, b) => (a.workspaceId + a.name < b.workspaceId + b.name ? -1 : 1))))}` : null,
      reason: "publish",
      createdBy: ctx.actor,
      createdAt: now,
    });
    const previous = await this.currentRevision(tx, revision);
    await transition(tx, FIRST_EPOCH, revision, [
      ["composed", "deployment requested"],
      ["active", "recorded, expected nodes fixed"],
    ]);
    if (previous) await this.supersede(tx, previous);
    const state: DeploymentState = "active";
    // No expected node yet: the revision stays active and never converges by itself (nothing proves it); a cluster
    // that turns v2 later joins its expected nodes at activation. Only a revision with nodes to wait for holds the lease.
    if (expectedNodes.length > 0) {
      await tx
        .update(deploymentLease)
        .set({ revision, operation: "deploy", owner: ctx.actor, startedAt: now, deadlineAt: new Date(now.getTime() + settings.convergenceDeadlineMs) });
    }
    await tx.update(workspaceActiveRelease).set({ deploymentRevision: revision });
    return { epoch: FIRST_EPOCH, revision, state, members: recorded, configHash, kongConfigHash, expectedNodes };
  }

  /** The latest revision of the instance's epoch (before `below` when given), if any. */
  private async currentRevision(tx: Executor, below?: number): Promise<number | undefined> {
    const [row] = await tx
      .select({ revision: deployments.revision })
      .from(deployments)
      .where(and(eq(deployments.epoch, FIRST_EPOCH), below === undefined ? undefined : sql`${deployments.revision} < ${below}`))
      .orderBy(desc(deployments.revision))
      .limit(1);
    return row?.revision;
  }

  /**
   * A new deployment supersedes the previous one where the machine allows it (converged, degraded or failed). One still
   * active was recorded without an expected node (one with nodes holds the lease, so no deployment gets here) and
   * never held the lease: it closes by the direct edge active → superseded (x-gromesh-empty-revision).
   */
  private async supersede(tx: Executor, revision: number) {
    const current = await deploymentState(tx, FIRST_EPOCH, revision);
    if (!current) return;
    if (current.state === "active") {
      await transition(tx, FIRST_EPOCH, revision, [["superseded", "a new deployment replaces a revision with no expected node"]]);
    } else if (["converged", "degraded", "failed"].includes(current.state)) {
      await transition(tx, FIRST_EPOCH, revision, [["superseded", "new deployment"]]);
    }
  }

  /** A lease past its deadline: its deployment fails (C-16) and the lease is free again. */
  private async expire(tx: Executor, revision: number) {
    const current = await deploymentState(tx, FIRST_EPOCH, revision);
    const path = current ? TO_FAILED[current.state] : undefined;
    if (path) await transition(tx, FIRST_EPOCH, revision, path.map((s) => [s, "convergence deadline"]));
    await tx.update(deploymentLease).set({ revision: null, operation: null, owner: null, startedAt: null, deadlineAt: null });
  }

  /** D1: the instance row, created on first use with the configured stage; a different stage later is refused. */
  /** The configured stage creates the row once; with none configured only an existing row tells the stage. */
  private async instance(tx: Executor, stage: Stage | null): Promise<InstanceRow> {
    if (stage !== null) await tx.insert(instance).values({ stage }).onConflictDoNothing();
    const [row] = await tx.select().from(instance);
    if (!row) throw forbidden("The instance stage is not configured (GROMESH_INSTANCE_STAGE); local publishing exists only on dev");
    if (stage !== null && row.stage !== stage) throw conflict(`The instance stage is ${row.stage}; it never changes (configured: ${stage})`);
    return row;
  }

  /** This instance's current value of every variable of the workspace, opened when sealed (never logged). */
  private async instanceValues(tx: Executor, workspaceId: string): Promise<Map<string, InstanceValue>> {
    const rows = await tx
      .selectDistinctOn([workspaceVariableValues.name])
      .from(workspaceVariableValues)
      .where(eq(workspaceVariableValues.workspaceId, workspaceId))
      .orderBy(workspaceVariableValues.name, desc(workspaceVariableValues.version));
    return new Map(rows.map((r) => [r.name, { version: r.version, value: r.sealed ? this.enc.open(r.value, variableValueContext(workspaceId, r.name, r.version)) : r.value }]));
  }

  /** The credentials of the workspace now (values of this instance), for the consumers the release carries. */
  private async withCredentials(tx: Executor, workspaceId: string, state: ReleaseState): Promise<GatewayState> {
    const live = await loadGatewayState(tx, workspaceId, this.enc, this.catalog);
    const consumers = new Set(state.consumers.map((c) => c.id));
    return {
      ...state,
      keyAuthCredentials: live.keyAuthCredentials.filter((k) => consumers.has(k.consumerId)),
      jwtCredentials: (live.jwtCredentials ?? []).filter((j) => consumers.has(j.consumerId)),
      basicAuthCredentials: (live.basicAuthCredentials ?? []).filter((b) => consumers.has(b.consumerId)),
    };
  }

  private async openRelease(tx: Executor, workspaceId: string, version: number): Promise<ReleaseState> {
    const row = await this.findRelease(tx, workspaceId, version);
    if (!row) throw new Error(`active release ${workspaceId}:${version} is missing`);
    return this.enc.openJson<ReleaseState>(row.content, releaseContext(workspaceId, version));
  }

  private async findRelease(tx: Executor, workspaceId: string, version: number): Promise<ReleaseRow | undefined> {
    const [row] = await tx.select().from(releases).where(and(eq(releases.workspaceId, workspaceId), eq(releases.version, version)));
    return row;
  }

  private async requireWorkspace(tx: Executor, workspaceId: string, lock = false) {
    const query = tx.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    const [row] = await (lock ? query.for("update") : query);
    if (!row) throw notFound("Workspace");
    return row;
  }

  private async toReleases(tx: Executor, rows: ReleaseRow[]) {
    if (rows.length === 0) return [];
    const workspaceId = rows[0]!.workspaceId;
    const digests = [...new Set(rows.map((r) => r.contentDigest))];
    const activations = new Map(
      (await tx.select().from(contentActivations).where(and(eq(contentActivations.workspaceId, workspaceId), inArray(contentActivations.contentDigest, digests)))).map((a) => [a.contentDigest, a]),
    );
    const revoked = new Set(
      (await tx.select({ digest: contentRevocations.contentDigest }).from(contentRevocations).where(and(eq(contentRevocations.workspaceId, workspaceId), inArray(contentRevocations.contentDigest, digests)))).map((r) => r.digest),
    );
    return rows.map((r) => ({
      workspaceId: r.workspaceId,
      version: r.version,
      contentDigest: r.contentDigest,
      origin: r.origin,
      promotionId: r.promotionId,
      rollbackOf: r.rollbackOf,
      contentOriginVersion: r.contentOriginVersion,
      contentFirstActivatedAt: activations.get(r.contentDigest)?.firstActivatedAt.toISOString() ?? null,
      originPromotionId: r.originPromotionId,
      contentRevoked: revoked.has(r.contentDigest),
      ...(r.message === null ? {} : { message: r.message }),
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}

@Controller("api/v2/workspaces/:workspaceId/releases")
export class ReleasesController {
  constructor(private readonly releasesService: ReleasesService) {}

  @Get()
  @RequiredPermission("workspace.read", "workspace")
  list(@Param("workspaceId", uuidParam()) workspaceId: string) {
    return this.releasesService.list(workspaceId);
  }

  @Post()
  @HttpCode(201)
  @RequiredPermission("release.publish", "workspace")
  publish(@Ctx() ctx: RequestContext, @Param("workspaceId", uuidParam()) workspaceId: string, @Body(contractBodyV2(PUBLISH_BODY)) body: PublishBody) {
    return this.releasesService.publish(ctx, workspaceId, body);
  }
}

@Controller("api/v2/deployments")
export class DeploymentsController {
  constructor(private readonly releasesService: ReleasesService) {}

  @Post()
  @HttpCode(201)
  @RequiredPermission("release.publish", "instance")
  deploy(@Ctx() ctx: RequestContext, @Body(contractBodyV2(inlineBody("/deployments", "post"))) body: { expectedRevision: number | null; reason: string }) {
    return this.releasesService.deploy(ctx, body);
  }
}

@Module({ imports: [PluginCatalogModule], controllers: [ReleasesController, DeploymentsController], providers: [ReleasesService], exports: [ReleasesService] })
export class ReleasesModule {}
