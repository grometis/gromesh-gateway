import { Body, Controller, Delete, Get, HttpCode, Inject, Injectable, Module, Param, ParseUUIDPipe, Patch, Post, Req } from "@nestjs/common";
import { and, asc, eq, sql } from "drizzle-orm";
import type { EnvironmentWrite } from "../api-types.js";
import { audit } from "../audit/audit.js";
import { type AuthenticatedRequest, Ctx, RequiredRole, type RequestContext, V1Permission } from "../auth/auth.js";
import { contractBody } from "../common/contract.js";
import { conflict, notFound, workspaceArchived } from "../common/problem.js";
import { DB, type Db, type Executor } from "../db/db.js";
import { clusters, environmentRoles, environments, type EnvironmentRow, type UserRow, workspaces } from "../db/schema.js";
import { assignSlug, SLUG_LOCK_KEY } from "../workspaces/workspaces.js";
import { lockTablesForWrite, UNIQUE_KINDS } from "../workspaces/instance-uniqueness.js";

export const uuidParam = () => new ParseUUIDPipe({ errorHttpStatusCode: 404 });

export function toEnvironment(r: EnvironmentRow) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    publishMode: r.publishMode,
    currentVersion: r.currentVersion,
    hasUnpublishedChanges: r.hasUnpublishedChanges,
    // An imported draft waits for an explicit publish; only auto mode has something to pause.
    autoPublishPausedReason: r.publishMode === "auto" && r.draftRequiresPublish ? (r.draftPauseReason ?? "import") : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** 404 unless the environment exists. With `lock`, holds a row lock until the transaction ends. */
export async function requireEnvironment(tx: Executor, envId: string, lock = false): Promise<EnvironmentRow> {
  // A writer that locks the environment is refused once its workspace is archived (the guard's check runs before the
  // transaction; this one is serialized with archiveWorkspace), checked before the row lock.
  if (lock) await refuseArchived(tx, envId);
  const q = tx.select().from(environments).where(eq(environments.id, envId));
  const [row] = lock ? await q.for("update") : await q;
  if (!row) throw notFound("Environment");
  return row;
}

/** One lock per workspace between archiveWorkspace (exclusive) and the writers in it (shared). */
export const ARCHIVE_LOCK_CLASS = 0x6772_7761; // "grwa"
export const archiveLock = (tx: Executor, workspaceId: string, mode: "shared" | "exclusive") =>
  tx.execute(mode === "shared"
    ? sql`select pg_advisory_xact_lock_shared(${ARCHIVE_LOCK_CLASS}, hashtext(${workspaceId}))`
    : sql`select pg_advisory_xact_lock(${ARCHIVE_LOCK_CLASS}, hashtext(${workspaceId}))`);

/**
 * 409 workspace-archived when the workspace is archived. The shared archive lock waits for an archive in flight and
 * keeps the next one out until this transaction ends. A writer takes it before locking the environment or the
 * workspace row, and archiveWorkspace takes the exclusive one before them, so the two never wait on each other.
 */
export async function refuseArchived(tx: Executor, workspaceId: string): Promise<void> {
  await archiveLock(tx, workspaceId, "shared");
  const [w] = await tx.select({ status: workspaces.status }).from(workspaces).where(eq(workspaces.id, workspaceId));
  if (w?.status === "archived") throw workspaceArchived();
}

/** Every edit of gateway entities flags the draft as different from what is published. */
export async function markDraftChanged(tx: Executor, envId: string): Promise<void> {
  // Every edit of the draft ends here, in its own transaction: an archive committed meanwhile refuses it.
  await refuseArchived(tx, envId);
  await tx
    .update(environments)
    .set({ hasUnpublishedChanges: true, draftChangedAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(environments.id, envId));
}

@Injectable()
export class EnvironmentsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Only the environments the user may see: a global admin sees all, anyone else all but those set to `none`. */
  async list(user: UserRow) {
    const rows = await this.db
      .select({ env: environments, role: environmentRoles.role })
      .from(environments)
      .leftJoin(environmentRoles, and(eq(environmentRoles.environmentId, environments.id), eq(environmentRoles.userId, user.id)))
      .orderBy(asc(environments.name));
    return { items: rows.filter((r) => user.role === "admin" || r.role !== "none").map((r) => toEnvironment(r.env)) };
  }

  async get(envId: string) {
    return toEnvironment(await requireEnvironment(this.db, envId));
  }

  async create(ctx: RequestContext, body: EnvironmentWrite) {
    return this.db.transaction(async (tx) => {
      // The slug lock before the insert, as createWorkspace takes them: the two creations never wait on each other.
      await tx.execute(sql`select pg_advisory_xact_lock(${SLUG_LOCK_KEY})`);
      const [row] = await tx
        .insert(environments)
        .values({ name: body.name, description: body.description ?? null, publishMode: body.publishMode ?? "manual" })
        .returning();
      // The trigger created its workspace (same id); renaming the environment later never changes the slug.
      await assignSlug(tx, row!.id, body.name);
      const env = toEnvironment(row!);
      await audit(tx, ctx, { action: "environment.create", entityType: "environment", entityId: env.id, environmentId: env.id, after: env });
      return env;
    });
  }

  async update(ctx: RequestContext, envId: string, body: EnvironmentWrite) {
    return this.db.transaction(async (tx) => {
      const before = toEnvironment(await requireEnvironment(tx, envId, true));
      const [row] = await tx
        .update(environments)
        .set({
          name: body.name,
          description: body.description ?? null,
          publishMode: body.publishMode ?? "manual",
          updatedAt: sql`now()`,
        })
        .where(eq(environments.id, envId))
        .returning();
      const after = toEnvironment(row!);
      await audit(tx, ctx, { action: "environment.update", entityType: "environment", entityId: envId, environmentId: envId, before, after });
      return after;
    });
  }

  async remove(ctx: RequestContext, envId: string) {
    await this.db.transaction(async (tx) => {
      // The cascade writes the credential tables: they come before the environment's row, as for every writer.
      await lockTablesForWrite(tx, UNIQUE_KINDS);
      const before = toEnvironment(await requireEnvironment(tx, envId, true));
      const [cluster] = await tx.select({ id: clusters.id }).from(clusters).where(eq(clusters.environmentId, envId)).limit(1);
      if (cluster) throw conflict("Environment still has registered clusters");
      await tx.delete(environments).where(eq(environments.id, envId));
      await audit(tx, ctx, { action: "environment.delete", entityType: "environment", entityId: envId, environmentId: envId, before });
    });
  }
}

@Controller("environments")
export class EnvironmentsController {
  constructor(private readonly envs: EnvironmentsService) {}

  @Get()
  @RequiredRole("viewer")
  list(@Req() req: AuthenticatedRequest) {
    return this.envs.list(req.user!);
  }

  @Post()
  @RequiredRole("admin")
  create(@Ctx() ctx: RequestContext, @Body(contractBody("EnvironmentWrite")) body: EnvironmentWrite) {
    return this.envs.create(ctx, body);
  }

  @Get(":envId")
  @RequiredRole("viewer")
  get(@Param("envId", uuidParam()) envId: string) {
    return this.envs.get(envId);
  }

  @Patch(":envId")
  @RequiredRole("admin")
  update(@Ctx() ctx: RequestContext, @Param("envId", uuidParam()) envId: string, @Body(contractBody("EnvironmentWrite")) body: EnvironmentWrite) {
    return this.envs.update(ctx, envId, body);
  }

  @Delete(":envId")
  @HttpCode(204)
  @RequiredRole("admin")
  // An environment is a workspace: a workspace admin never deletes it (GW-ADMIN-07).
  @V1Permission("platform.admin")
  async remove(@Ctx() ctx: RequestContext, @Param("envId", uuidParam()) envId: string) {
    await this.envs.remove(ctx, envId);
  }
}

@Module({ controllers: [EnvironmentsController], providers: [EnvironmentsService] })
export class EnvironmentsModule {}
