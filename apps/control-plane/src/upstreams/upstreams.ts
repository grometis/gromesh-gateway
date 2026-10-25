import { Body, Controller, Delete, Get, HttpCode, Inject, Injectable, Module, Param, Post, Put, Query } from "@nestjs/common";
import { hashIssues, type Target, type Upstream } from "@gromesh/compiler";
import { and, asc, eq, gt, ilike, or, sql, type SQL } from "drizzle-orm";
import type { TargetWrite, UpstreamHealthchecks, UpstreamWrite } from "../api-types.js";
import { audit } from "../audit/audit.js";
import { Ctx, RequiredPermission, RequiredRole, type RequestContext } from "../auth/auth.js";
import { contractBody, contractBodyV2 } from "../common/contract.js";
import { decodeCursor, parseLimit, toPage } from "../common/pagination.js";
import { conflict, notFound, unprocessable } from "../common/problem.js";
import { assertDestination, destinationPolicy, targetHost, type DestinationPolicy } from "../common/destinations.js";
import { APP_CONFIG, type AppConfig } from "../config.js";
import { DB, type Db, type Executor } from "../db/db.js";
import { services, targets, upstreams, type TargetRow, type UpstreamRow } from "../db/schema.js";
import { markDraftChanged, requireEnvironment, uuidParam } from "../environments/environments.js";
import { refuseVarRefs, type WithVarRefs } from "../workspaces/var-refs.js";

/* ---------------- mapping ---------------- */

type StoredHealthchecks = UpstreamRow["healthchecks"];

/** Defaults filled in, so a read shows what Kong will apply; an absent check is null (off). */
export function normalizeHealthchecks(h: UpstreamHealthchecks | undefined): StoredHealthchecks {
  const active = h?.active
    ? {
        type: h.active.type,
        ...(h.active.type === "tcp" ? {} : { httpPath: h.active.httpPath ?? "/" }),
        intervalSeconds: h.active.intervalSeconds ?? 10,
        healthyThreshold: h.active.healthyThreshold ?? 2,
        unhealthyThreshold: h.active.unhealthyThreshold ?? 3,
        timeoutSeconds: h.active.timeoutSeconds ?? 1,
      }
    : null;
  const passive = h?.passive ? { unhealthyHttpFailures: h.passive.unhealthyHttpFailures ?? 5, unhealthyTimeouts: h.passive.unhealthyTimeouts ?? 3 } : null;
  return { active, passive };
}

const optional = <T>(v: T | null): T | undefined => (v === null ? undefined : v);

export function toUpstream(r: UpstreamRow) {
  const hashing = r.algorithm === "consistent-hashing";
  return Object.fromEntries(
    Object.entries({
      id: r.id,
      name: r.name,
      algorithm: r.algorithm as NonNullable<UpstreamWrite["algorithm"]>,
      hashOn: r.hashOn as NonNullable<UpstreamWrite["hashOn"]>,
      hashFallback: r.hashFallback as NonNullable<UpstreamWrite["hashFallback"]>,
      hashOnHeader: hashing ? optional(r.hashOnHeader) : undefined,
      hashFallbackHeader: hashing ? optional(r.hashFallbackHeader) : undefined,
      hashOnCookie: hashing ? optional(r.hashOnCookie) : undefined,
      hashOnCookiePath: hashing ? optional(r.hashOnCookiePath) : undefined,
      healthchecks: r.healthchecks,
      tags: r.tags,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }).filter(([, v]) => v !== undefined),
  ) as {
    id: string;
    name: string;
    algorithm: NonNullable<UpstreamWrite["algorithm"]>;
    hashOn: NonNullable<UpstreamWrite["hashOn"]>;
    hashFallback: NonNullable<UpstreamWrite["hashFallback"]>;
    hashOnHeader?: string;
    hashFallbackHeader?: string;
    hashOnCookie?: string;
    hashOnCookiePath?: string;
    healthchecks: StoredHealthchecks;
    tags: string[];
    createdAt: string;
    updatedAt: string;
  };
}

export function toTarget(r: TargetRow) {
  return { id: r.id, upstreamId: r.upstreamId, target: r.target, weight: r.weight, tags: r.tags, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() };
}

/** Column values; hashing fields only survive with consistent-hashing (the 422 rules already ran). */
export function upstreamValues(body: UpstreamWrite | Upstream) {
  const algorithm = body.algorithm ?? "round-robin";
  const hashing = algorithm === "consistent-hashing";
  const hashOn = hashing ? (body.hashOn ?? "none") : "none";
  const hashFallback = hashing ? (body.hashFallback ?? "none") : "none";
  return {
    name: body.name,
    algorithm,
    hashOn,
    hashFallback,
    hashOnHeader: hashOn === "header" ? (body.hashOnHeader ?? null) : null,
    hashFallbackHeader: hashFallback === "header" ? (body.hashFallbackHeader ?? null) : null,
    hashOnCookie: hashOn === "cookie" ? (body.hashOnCookie ?? null) : null,
    hashOnCookiePath: hashOn === "cookie" ? (body.hashOnCookiePath ?? "/") : null,
    healthchecks: normalizeHealthchecks(body.healthchecks ?? undefined),
    tags: body.tags ?? [],
  };
}

export function targetValues(body: TargetWrite | Target) {
  return { target: body.target, weight: body.weight ?? 100, tags: body.tags ?? [] };
}

/** The compiler's domain model of an upstream row. */
export function upstreamState(r: UpstreamRow): Upstream {
  const { createdAt: _c, updatedAt: _u, ...u } = toUpstream(r);
  return u;
}

export function targetState(r: TargetRow): Target {
  return { id: r.id, upstreamId: r.upstreamId, target: r.target, weight: r.weight, tags: r.tags };
}

const escapeLike = (q: string) => q.replace(/[%_\\]/g, "\\$&");

/* ---------------- service ---------------- */

@Injectable()
export class UpstreamsService {
  private readonly destinations: DestinationPolicy;

  constructor(@Inject(DB) private readonly db: Db, @Inject(APP_CONFIG) config: AppConfig) {
    this.destinations = destinationPolicy(config);
  }

  async list(envId: string, query: Record<string, unknown>) {
    await requireEnvironment(this.db, envId);
    const limit = parseLimit(query.limit);
    const parts: (SQL | undefined)[] = [eq(upstreams.environmentId, envId)];
    if (typeof query.q === "string" && query.q.trim()) parts.push(ilike(upstreams.name, `%${escapeLike(query.q.trim())}%`));
    const c = decodeCursor(query.cursor);
    if (c) parts.push(or(gt(upstreams.name, c.k), and(eq(upstreams.name, c.k), gt(upstreams.id, c.id))));
    const rows = await this.db.select().from(upstreams).where(and(...parts)).orderBy(asc(upstreams.name), asc(upstreams.id)).limit(limit + 1);
    return toPage(rows, limit, (r) => r.name, toUpstream);
  }

  async get(envId: string, upstreamId: string) {
    return toUpstream(await this.requireUpstream(this.db, envId, upstreamId));
  }

  async create(ctx: RequestContext, envId: string, body: UpstreamWrite) {
    checkUpstream(body);
    assertDestination("name", body.name, this.destinations, "upstream");
    return this.db.transaction(async (tx) => {
      await requireEnvironment(tx, envId);
      const [row] = await tx.insert(upstreams).values({ environmentId: envId, ...upstreamValues(body) }).returning();
      const after = toUpstream(row!);
      await markDraftChanged(tx, envId);
      await audit(tx, ctx, { action: "upstream.create", entityType: "upstream", entityId: after.id, environmentId: envId, after });
      return after;
    });
  }

  async replace(ctx: RequestContext, envId: string, upstreamId: string, body: UpstreamWrite) {
    checkUpstream(body);
    assertDestination("name", body.name, this.destinations, "upstream");
    return this.db.transaction(async (tx) => {
      const current = await this.requireUpstream(tx, envId, upstreamId, true);
      if (current.name !== body.name) await refuseWhileReferenced(tx, envId, current.name, "renamed");
      const before = toUpstream(current);
      const [row] = await tx
        .update(upstreams)
        .set({ ...upstreamValues(body), updatedAt: sql`now()` })
        .where(eq(upstreams.id, upstreamId))
        .returning();
      const after = toUpstream(row!);
      await markDraftChanged(tx, envId);
      await audit(tx, ctx, { action: "upstream.update", entityType: "upstream", entityId: upstreamId, environmentId: envId, before, after });
      return after;
    });
  }

  async remove(ctx: RequestContext, envId: string, upstreamId: string) {
    await this.db.transaction(async (tx) => {
      const current = await this.requireUpstream(tx, envId, upstreamId, true);
      await refuseWhileReferenced(tx, envId, current.name, "deleted");
      await tx.delete(upstreams).where(eq(upstreams.id, upstreamId));
      await markDraftChanged(tx, envId);
      await audit(tx, ctx, { action: "upstream.delete", entityType: "upstream", entityId: upstreamId, environmentId: envId, before: toUpstream(current) });
    });
  }

  /* targets */

  async listTargets(envId: string, upstreamId: string, query: Record<string, unknown>) {
    await this.requireUpstream(this.db, envId, upstreamId);
    const limit = parseLimit(query.limit);
    const c = decodeCursor(query.cursor);
    const rows = await this.db
      .select()
      .from(targets)
      .where(and(eq(targets.upstreamId, upstreamId), c ? or(gt(targets.target, c.k), and(eq(targets.target, c.k), gt(targets.id, c.id))) : undefined))
      .orderBy(asc(targets.target), asc(targets.id))
      .limit(limit + 1);
    return toPage(rows, limit, (r) => r.target, toTarget);
  }

  async createTarget(ctx: RequestContext, envId: string, upstreamId: string, body: TargetWrite) {
    checkTarget(body);
    assertDestination("target", targetHost(body.target), this.destinations, "target");
    return this.db.transaction(async (tx) => {
      await this.requireUpstream(tx, envId, upstreamId);
      const [row] = await tx.insert(targets).values({ environmentId: envId, upstreamId, ...targetValues(body) }).returning();
      const after = toTarget(row!);
      await markDraftChanged(tx, envId);
      await audit(tx, ctx, { action: "target.create", entityType: "target", entityId: after.id, environmentId: envId, after });
      return after;
    });
  }

  async replaceTarget(ctx: RequestContext, envId: string, upstreamId: string, targetId: string, body: TargetWrite) {
    checkTarget(body);
    assertDestination("target", targetHost(body.target), this.destinations, "target");
    return this.db.transaction(async (tx) => {
      const before = toTarget(await this.requireTarget(tx, envId, upstreamId, targetId));
      const [row] = await tx
        .update(targets)
        .set({ ...targetValues(body), updatedAt: sql`now()` })
        .where(eq(targets.id, targetId))
        .returning();
      const after = toTarget(row!);
      await markDraftChanged(tx, envId);
      await audit(tx, ctx, { action: "target.update", entityType: "target", entityId: targetId, environmentId: envId, before, after });
      return after;
    });
  }

  async removeTarget(ctx: RequestContext, envId: string, upstreamId: string, targetId: string) {
    await this.db.transaction(async (tx) => {
      const before = toTarget(await this.requireTarget(tx, envId, upstreamId, targetId));
      await tx.delete(targets).where(eq(targets.id, targetId));
      await markDraftChanged(tx, envId);
      await audit(tx, ctx, { action: "target.delete", entityType: "target", entityId: targetId, environmentId: envId, before });
    });
  }

  /* helpers */

  private async requireUpstream(tx: Executor, envId: string, upstreamId: string, lock = false): Promise<UpstreamRow> {
    const query = tx.select().from(upstreams).where(and(eq(upstreams.id, upstreamId), eq(upstreams.environmentId, envId)));
    const [row] = lock ? await query.for("update") : await query;
    if (!row) throw notFound("Upstream");
    return row;
  }

  private async requireTarget(tx: Executor, envId: string, upstreamId: string, targetId: string): Promise<TargetRow> {
    await this.requireUpstream(tx, envId, upstreamId);
    const [row] = await tx.select().from(targets).where(and(eq(targets.id, targetId), eq(targets.upstreamId, upstreamId)));
    if (!row) throw notFound("Target");
    return row;
  }
}

/** Services of the environment that point at the upstream by name: it may not be renamed or deleted under them. */
async function refuseWhileReferenced(tx: Executor, envId: string, name: string, verb: "renamed" | "deleted"): Promise<void> {
  const users = await tx
    .select({ name: services.name })
    .from(services)
    .where(and(eq(services.environmentId, envId), eq(services.host, name)))
    .orderBy(asc(services.name));
  if (users.length > 0) {
    throw conflict(`Upstream "${name}" cannot be ${verb} while services use it as host: ${users.map((s) => s.name).join(", ")}`);
  }
}

/** Rules the contract states in prose: the hashing combinations. */
function checkUpstream(body: UpstreamWrite): void {
  const issues = hashIssues(body, "");
  if (issues.length > 0) throw unprocessable("Invalid upstream", issues);
}

function checkTarget(body: TargetWrite): void {
  const port = Number(/:([0-9]{1,5})$/.exec(body.target)?.[1]);
  if (!(port >= 1 && port <= 65535)) throw unprocessable("Invalid target", [{ path: "target", message: "port must be between 1 and 65535" }]);
}

/* ---------------- controllers ---------------- */

@Controller("environments/:envId/upstreams")
export class UpstreamsController {
  constructor(private readonly upstreams: UpstreamsService) {}

  @Get()
  @RequiredRole("viewer")
  list(@Param("envId", uuidParam()) envId: string, @Query() query: Record<string, unknown>) {
    return this.upstreams.list(envId, query);
  }

  @Post()
  @RequiredRole("editor")
  create(@Ctx() ctx: RequestContext, @Param("envId", uuidParam()) envId: string, @Body(contractBody("UpstreamWrite")) body: UpstreamWrite) {
    return this.upstreams.create(ctx, envId, body);
  }

  @Get(":upstreamId")
  @RequiredRole("viewer")
  get(@Param("envId", uuidParam()) envId: string, @Param("upstreamId", uuidParam()) upstreamId: string) {
    return this.upstreams.get(envId, upstreamId);
  }

  @Put(":upstreamId")
  @RequiredRole("editor")
  replace(
    @Ctx() ctx: RequestContext,
    @Param("envId", uuidParam()) envId: string,
    @Param("upstreamId", uuidParam()) upstreamId: string,
    @Body(contractBody("UpstreamWrite")) body: UpstreamWrite,
  ) {
    return this.upstreams.replace(ctx, envId, upstreamId, body);
  }

  @Delete(":upstreamId")
  @HttpCode(204)
  @RequiredRole("editor")
  async remove(@Ctx() ctx: RequestContext, @Param("envId", uuidParam()) envId: string, @Param("upstreamId", uuidParam()) upstreamId: string) {
    await this.upstreams.remove(ctx, envId, upstreamId);
  }

  @Get(":upstreamId/targets")
  @RequiredRole("viewer")
  listTargets(@Param("envId", uuidParam()) envId: string, @Param("upstreamId", uuidParam()) upstreamId: string, @Query() query: Record<string, unknown>) {
    return this.upstreams.listTargets(envId, upstreamId, query);
  }

  @Post(":upstreamId/targets")
  @RequiredRole("editor")
  createTarget(
    @Ctx() ctx: RequestContext,
    @Param("envId", uuidParam()) envId: string,
    @Param("upstreamId", uuidParam()) upstreamId: string,
    @Body(contractBody("TargetWrite")) body: TargetWrite,
  ) {
    return this.upstreams.createTarget(ctx, envId, upstreamId, body);
  }

  @Put(":upstreamId/targets/:targetId")
  @RequiredRole("editor")
  replaceTarget(
    @Ctx() ctx: RequestContext,
    @Param("envId", uuidParam()) envId: string,
    @Param("upstreamId", uuidParam()) upstreamId: string,
    @Param("targetId", uuidParam()) targetId: string,
    @Body(contractBody("TargetWrite")) body: TargetWrite,
  ) {
    return this.upstreams.replaceTarget(ctx, envId, upstreamId, targetId, body);
  }

  @Delete(":upstreamId/targets/:targetId")
  @HttpCode(204)
  @RequiredRole("editor")
  async removeTarget(
    @Ctx() ctx: RequestContext,
    @Param("envId", uuidParam()) envId: string,
    @Param("upstreamId", uuidParam()) upstreamId: string,
    @Param("targetId", uuidParam()) targetId: string,
  ) {
    await this.upstreams.removeTarget(ctx, envId, upstreamId, targetId);
  }
}

/** control-plane-v2: the same service in the workspace with the environment's id (decision H-9). */
@Controller("api/v2/workspaces/:workspaceId/upstreams")
export class WorkspaceUpstreamsController {
  constructor(private readonly upstreams: UpstreamsService) {}

  @Get()
  @RequiredPermission("workspace.read", "workspace")
  list(@Param("workspaceId", uuidParam()) workspaceId: string, @Query() query: Record<string, unknown>) {
    return this.upstreams.list(workspaceId, query);
  }

  @Post()
  @RequiredPermission("gateway.write", "workspace")
  create(@Ctx() ctx: RequestContext, @Param("workspaceId", uuidParam()) workspaceId: string, @Body(contractBodyV2("WorkspaceUpstreamWrite")) body: UpstreamWrite) {
    return this.upstreams.create(ctx, workspaceId, body);
  }

  @Get(":upstreamId")
  @RequiredPermission("workspace.read", "workspace")
  get(@Param("workspaceId", uuidParam()) workspaceId: string, @Param("upstreamId", uuidParam()) upstreamId: string) {
    return this.upstreams.get(workspaceId, upstreamId);
  }

  @Put(":upstreamId")
  @RequiredPermission("gateway.write", "workspace")
  replace(
    @Ctx() ctx: RequestContext,
    @Param("workspaceId", uuidParam()) workspaceId: string,
    @Param("upstreamId", uuidParam()) upstreamId: string,
    @Body(contractBodyV2("WorkspaceUpstreamWrite")) body: UpstreamWrite,
  ) {
    return this.upstreams.replace(ctx, workspaceId, upstreamId, body);
  }

  @Delete(":upstreamId")
  @HttpCode(204)
  @RequiredPermission("gateway.write", "workspace")
  async remove(@Ctx() ctx: RequestContext, @Param("workspaceId", uuidParam()) workspaceId: string, @Param("upstreamId", uuidParam()) upstreamId: string) {
    await this.upstreams.remove(ctx, workspaceId, upstreamId);
  }

  @Get(":upstreamId/targets")
  @RequiredPermission("workspace.read", "workspace")
  listTargets(@Param("workspaceId", uuidParam()) workspaceId: string, @Param("upstreamId", uuidParam()) upstreamId: string, @Query() query: Record<string, unknown>) {
    return this.upstreams.listTargets(workspaceId, upstreamId, query);
  }

  @Post(":upstreamId/targets")
  @RequiredPermission("gateway.write", "workspace")
  createTarget(
    @Ctx() ctx: RequestContext,
    @Param("workspaceId", uuidParam()) workspaceId: string,
    @Param("upstreamId", uuidParam()) upstreamId: string,
    @Body(contractBodyV2("WorkspaceTargetWrite")) body: WithVarRefs<TargetWrite, "target">,
  ) {
    return this.upstreams.createTarget(ctx, workspaceId, upstreamId, refuseVarRefs(body, ["target"]));
  }

  @Put(":upstreamId/targets/:targetId")
  @RequiredPermission("gateway.write", "workspace")
  replaceTarget(
    @Ctx() ctx: RequestContext,
    @Param("workspaceId", uuidParam()) workspaceId: string,
    @Param("upstreamId", uuidParam()) upstreamId: string,
    @Param("targetId", uuidParam()) targetId: string,
    @Body(contractBodyV2("WorkspaceTargetWrite")) body: WithVarRefs<TargetWrite, "target">,
  ) {
    return this.upstreams.replaceTarget(ctx, workspaceId, upstreamId, targetId, refuseVarRefs(body, ["target"]));
  }

  @Delete(":upstreamId/targets/:targetId")
  @HttpCode(204)
  @RequiredPermission("gateway.write", "workspace")
  async removeTarget(
    @Ctx() ctx: RequestContext,
    @Param("workspaceId", uuidParam()) workspaceId: string,
    @Param("upstreamId", uuidParam()) upstreamId: string,
    @Param("targetId", uuidParam()) targetId: string,
  ) {
    await this.upstreams.removeTarget(ctx, workspaceId, upstreamId, targetId);
  }
}

@Module({ controllers: [UpstreamsController, WorkspaceUpstreamsController], providers: [UpstreamsService] })
export class UpstreamsModule {}
