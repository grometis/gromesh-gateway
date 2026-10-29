import { HttpException, HttpStatus, Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, isNotNull, ne, sql } from "drizzle-orm";
import { audit } from "../audit/audit.js";
import type { RequestContext } from "../auth/auth.js";
import type { Held } from "../auth/permissions.js";
import { ProblemException, unprocessable } from "../common/problem.js";
import { APP_CONFIG, type AppConfig } from "../config.js";
import { DB, type Db, type Executor } from "../db/db.js";
import { clusters, deployments, environments, instance, releases, roleBindings, workspaceActiveRelease, workspaceCreationPolicy, workspaces } from "../db/schema.js";
import { toRoleBinding } from "../access/access.js";
import { normalizeSlug, proposeSlug, slugProblem } from "./slug.js";
import { SLUG_LOCK_KEY } from "./workspaces.js";

/** contracts/control-plane-v2.openapi.yaml#/components/schemas/WorkspaceWrite */
export interface WorkspaceWrite {
  name: string;
  description?: string;
  slug?: string;
}
export type WorkspaceUpdate = Partial<Pick<WorkspaceWrite, "name" | "description">>;
type Mode = "restricted-request" | "autonomous" | "admin-only";
/** contracts/control-plane-v2.openapi.yaml#/components/schemas/WorkspaceCreationPolicyWrite */
export interface CreationPolicyWrite {
  mode: Mode;
  creatorBecomesAdmin: boolean;
}

export type WorkspaceRow = { id: string; key: string; name: string; description: string | null; slug: string | null; status: "active" | "archived" };

/** No release exists before the workspace composition (N2), and none was provisioned by a promotion. */
export const toWorkspace = (w: WorkspaceRow) => ({
  id: w.id,
  key: w.key,
  name: w.name,
  ...(w.description !== null ? { description: w.description } : {}),
  slug: w.slug!,
  status: w.status,
  activeRelease: null,
  provisionedByPromotion: null,
});

/** GW-ADMIN-01: never configured means restricted-request, and creating grants nothing. */
const DEFAULT_POLICY = { mode: "restricted-request" as Mode, creatorBecomesAdmin: false, updatedAt: null, updatedBy: null };

/** A 409 whose `code` the caller acts on (WorkspaceProblem), with a slug it may send instead (never applied). */
const refused = (code: string, detail: string, extra: { suggestedSlug?: string; path?: string } = {}) =>
  new HttpException(
    {
      type: `https://gromesh.dev/problems/${code}`,
      title: "Conflict",
      status: HttpStatus.CONFLICT,
      code,
      detail,
      ...(extra.path ? { errors: [{ path: extra.path, message: detail }] } : {}),
      ...(extra.suggestedSlug ? { suggestedSlug: extra.suggestedSlug } : {}),
    },
    HttpStatus.CONFLICT,
  );

@Injectable()
export class WorkspaceAdminService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** The stage this instance has, or would take on first use; null while unknown (WS-M0: creation refused). */
  private async stage(tx: Executor): Promise<"dev" | "hml" | "prd" | null> {
    const [row] = await tx.select({ stage: instance.stage }).from(instance);
    return row?.stage ?? this.config.workspacesDeployments?.stage ?? this.config.instanceStage ?? null;
  }

  private async policy(tx: Executor) {
    const [row] = await tx.select().from(workspaceCreationPolicy);
    return row
      ? { mode: row.mode, creatorBecomesAdmin: row.creatorBecomesAdmin, updatedAt: row.updatedAt.toISOString(), updatedBy: row.updatedBy }
      : DEFAULT_POLICY;
  }

  /** Who may create under a policy: workspace.create (the guard's), and in admin-only also platform administration. */
  private static creates(mode: Mode, held: ReadonlySet<Held>): boolean {
    return held.has("workspace.create") && (mode !== "admin-only" || held.has("platform.admin"));
  }

  async policyFor(held: ReadonlySet<Held>) {
    const policy = await this.policy(this.db);
    const stage = await this.stage(this.db);
    const open = this.config.workspacesDeployments !== null && stage === "dev";
    const creates = WorkspaceAdminService.creates(policy.mode, held);
    return {
      ...policy,
      workspacesMode: this.config.workspacesDeployments !== null ? ("lab" as const) : ("disabled" as const),
      stage,
      caller: {
        canCreate: open && creates,
        canRequest: open && policy.mode === "restricted-request" && held.has("workspace.request"),
        canDecide: open && policy.mode !== "autonomous" && creates,
      },
    };
  }

  async setPolicy(ctx: RequestContext, held: ReadonlySet<Held>, body: CreationPolicyWrite) {
    await this.db.transaction(async (tx) => {
      const before = await this.policy(tx);
      await tx
        .insert(workspaceCreationPolicy)
        .values({ mode: body.mode, creatorBecomesAdmin: body.creatorBecomesAdmin, updatedBy: ctx.actor.id })
        .onConflictDoUpdate({ target: workspaceCreationPolicy.singleton, set: { mode: body.mode, creatorBecomesAdmin: body.creatorBecomesAdmin, updatedBy: ctx.actor.id, updatedAt: sql`now()` } });
      const after = await this.policy(tx);
      await audit(tx, ctx, { action: "workspace_creation_policy.update", entityType: "workspace_creation_policy", before, after });
    });
    return this.policyFor(held);
  }

  /**
   * createWorkspace (WS-M0), in the contract's order: Workspaces mode, stage, policy, body. The workspace is an
   * environment row (N1: the same id), so v1 sees it as an environment without clusters; it gets no release, no
   * deployment and no binding beyond the creator's workspace-admin when the policy says so.
   */
  async create(ctx: RequestContext, held: ReadonlySet<Held>, body: WorkspaceWrite) {
    if (this.config.workspacesDeployments === null) throw refused("workspaces-mode-disabled", "Workspaces mode is disabled on this instance");
    const stage = await this.stage(this.db);
    if (stage !== "dev") throw new ProblemException(HttpStatus.FORBIDDEN, stage === null ? "The instance stage is not configured; workspaces are created only on dev" : `Workspaces are created only on dev; this instance is ${stage} (a promotion provisions them)`);
    const slug = body.slug ?? normalizeSlug(body.name);
    const problem = slugProblem(slug);
    if (problem !== null) throw unprocessable("Invalid slug", [{ path: "slug", message: problem === "reserved" ? "reserved slug" : "must match ^[a-z][a-z0-9-]{1,39}$, without a trailing or doubled hyphen" }]);
    return this.db.transaction(async (tx) => {
      const policy = await this.policy(tx);
      if (!WorkspaceAdminService.creates(policy.mode, held)) {
        throw new ProblemException(HttpStatus.FORBIDDEN, policy.mode === "admin-only" ? "Only platform administration creates workspaces on this instance" : "Requires permission workspace.create");
      }
      // The lock every slug assignment takes: two creations never get the same slug, and the 409 is decided here.
      await tx.execute(sql`select pg_advisory_xact_lock(${SLUG_LOCK_KEY})`);
      const taken = new Set((await tx.select({ slug: workspaces.slug }).from(workspaces).where(isNotNull(workspaces.slug))).map((r) => r.slug!));
      const suggestion = () => {
        const p = proposeSlug(slug, taken);
        return slugProblem(p.slug) === null && !taken.has(p.slug) ? p.slug : undefined;
      };
      if (taken.has(slug)) throw refused("slug-taken", "Another workspace of this instance has this slug", { path: "slug", suggestedSlug: suggestion() });
      const [named] = await tx.select({ id: environments.id }).from(environments).where(eq(environments.name, body.name));
      if (named) throw refused("name-taken", "Another workspace of this instance has this name", { path: "name", suggestedSlug: suggestion() });
      const [env] = await tx.insert(environments).values({ name: body.name, description: body.description ?? null }).returning();
      // The trigger created the workspace row with the environment; the slug is the one given or derived, as is.
      const [ws] = await tx
        .update(workspaces)
        .set({ slug, slugStatus: "derived", slugReason: null, updatedAt: sql`now()` })
        .where(eq(workspaces.id, env!.id))
        .returning();
      const after = toWorkspace({ id: ws!.id, key: ws!.key, name: env!.name, description: env!.description, slug: ws!.slug, status: ws!.status });
      await audit(tx, ctx, { action: "workspace.create", entityType: "workspace", entityId: after.id, environmentId: after.id, after });
      // Platform administration already administers every workspace: a binding would only add a grant to revoke.
      if (policy.creatorBecomesAdmin && !held.has("platform.admin")) {
        const [binding] = await tx
          .insert(roleBindings)
          .values({ subjectType: "user", subjectId: ctx.actor.id, scopeType: "workspace", workspaceId: after.id, role: "workspace-admin", grantedBy: ctx.actor.id, grantedByPlatform: false })
          .returning();
        const granted = toRoleBinding(binding!);
        await audit(tx, ctx, { action: "role_binding.create", entityType: "role_binding", entityId: granted.id, environmentId: after.id, after: granted });
      }
      return after;
    });
  }

  private async row(tx: Executor, workspaceId: string, lock: boolean): Promise<WorkspaceRow> {
    // Environment before workspace, the order every writer takes them.
    const q = tx
      .select({ id: workspaces.id, key: workspaces.key, name: environments.name, description: environments.description, slug: workspaces.slug, status: workspaces.status })
      .from(environments)
      .innerJoin(workspaces, eq(workspaces.id, environments.id))
      .where(eq(environments.id, workspaceId));
    const [row] = lock ? await q.for("update") : await q;
    if (!row) throw new ProblemException(HttpStatus.NOT_FOUND, "Workspace not found");
    return row;
  }

  /** updateWorkspace: name and description only; the id, the key and the slug never change. */
  async update(ctx: RequestContext, workspaceId: string, body: WorkspaceUpdate) {
    return this.db.transaction(async (tx) => {
      const current = await this.row(tx, workspaceId, true);
      if (current.status === "archived") throw refused("workspace-archived", "The workspace is archived");
      if (body.name !== undefined && body.name !== current.name) {
        const [named] = await tx.select({ id: environments.id }).from(environments).where(and(eq(environments.name, body.name), ne(environments.id, workspaceId)));
        if (named) throw refused("name-taken", "Another workspace of this instance has this name", { path: "name" });
      }
      await tx
        .update(environments)
        .set({ ...(body.name !== undefined ? { name: body.name } : {}), ...(body.description !== undefined ? { description: body.description } : {}), updatedAt: sql`now()` })
        .where(eq(environments.id, workspaceId));
      const before = toWorkspace(current);
      const after = toWorkspace(await this.row(tx, workspaceId, false));
      await audit(tx, ctx, { action: "workspace.update", entityType: "workspace", entityId: workspaceId, environmentId: workspaceId, before, after });
      return after;
    });
  }

  /**
   * archiveWorkspace: deletes nothing. Refused while anything it published may still be served or composed: an active
   * release that is not a tombstone, a v1 snapshot published for it, or a cluster registered in it.
   */
  async archive(ctx: RequestContext, workspaceId: string) {
    await this.db.transaction(async (tx) => {
      const current = await this.row(tx, workspaceId, true);
      if (current.status === "archived") return;
      const [active] = await tx
        .select({ origin: releases.origin })
        .from(workspaceActiveRelease)
        .innerJoin(releases, and(eq(releases.workspaceId, workspaceActiveRelease.workspaceId), eq(releases.version, workspaceActiveRelease.version)))
        .where(eq(workspaceActiveRelease.workspaceId, workspaceId));
      if (active && active.origin !== "tombstone") throw refused("active-release", "The workspace has an active release with entities; remove it with a tombstone promotion first");
      // What the nodes serve is the latest revision, converged or not: a member there is still served.
      const [latest] = await tx.select({ members: deployments.members }).from(deployments).orderBy(desc(deployments.epoch), desc(deployments.revision)).limit(1);
      const member = latest?.members.find((m) => m.workspaceId === workspaceId);
      if (member) {
        const [release] = await tx.select({ origin: releases.origin }).from(releases).where(and(eq(releases.workspaceId, workspaceId), eq(releases.version, member.releaseVersion)));
        if (release?.origin !== "tombstone") throw refused("deployed", "The workspace is a member of the latest deployment revision");
      }
      const [env] = await tx.select({ currentVersion: environments.currentVersion }).from(environments).where(eq(environments.id, workspaceId));
      if (env!.currentVersion !== null) throw refused("published-configuration", "A configuration was published for this workspace (v1 snapshot)");
      const [cluster] = await tx.select({ id: clusters.id }).from(clusters).where(eq(clusters.environmentId, workspaceId)).limit(1);
      if (cluster) throw refused("clusters", "A cluster is registered in this workspace");
      await tx.update(workspaces).set({ status: "archived", updatedAt: sql`now()` }).where(eq(workspaces.id, workspaceId));
      await audit(tx, ctx, { action: "workspace.archive", entityType: "workspace", entityId: workspaceId, environmentId: workspaceId, before: toWorkspace(current), after: toWorkspace({ ...current, status: "archived" }) });
    });
  }
}
