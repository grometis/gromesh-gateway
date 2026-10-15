import { Body, Controller, Delete, Get, HttpCode, Inject, Injectable, Module, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { asc, eq, sql } from "drizzle-orm";
import type { EnvironmentWrite } from "../api-types.js";
import { audit } from "../audit/audit.js";
import { Ctx, RequiredRole, type RequestContext } from "../auth/auth.js";
import { contractBody } from "../common/contract.js";
import { notFound } from "../common/problem.js";
import { DB, type Db, type Executor } from "../db/db.js";
import { environments, type EnvironmentRow } from "../db/schema.js";

export const uuidParam = () => new ParseUUIDPipe({ errorHttpStatusCode: 404 });

export function toEnvironment(r: EnvironmentRow) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    publishMode: r.publishMode,
    currentVersion: r.currentVersion,
    hasUnpublishedChanges: r.hasUnpublishedChanges,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** 404 unless the environment exists. With `lock`, holds a row lock until the transaction ends. */
export async function requireEnvironment(tx: Executor, envId: string, lock = false): Promise<EnvironmentRow> {
  const q = tx.select().from(environments).where(eq(environments.id, envId));
  const [row] = lock ? await q.for("update") : await q;
  if (!row) throw notFound("Environment");
  return row;
}

/** Every edit of gateway entities flags the draft as different from what is published. */
export async function markDraftChanged(tx: Executor, envId: string): Promise<void> {
  await tx.update(environments).set({ hasUnpublishedChanges: true, updatedAt: sql`now()` }).where(eq(environments.id, envId));
}

@Injectable()
export class EnvironmentsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async list() {
    const rows = await this.db.select().from(environments).orderBy(asc(environments.name));
    return { items: rows.map(toEnvironment) };
  }

  async get(envId: string) {
    return toEnvironment(await requireEnvironment(this.db, envId));
  }

  async create(ctx: RequestContext, body: EnvironmentWrite) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(environments)
        .values({ name: body.name, description: body.description ?? null, publishMode: body.publishMode ?? "manual" })
        .returning();
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
      const before = toEnvironment(await requireEnvironment(tx, envId, true));
      // TODO(W3-X1): 409 while clusters are registered (contract).
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
  list() {
    return this.envs.list();
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
  async remove(@Ctx() ctx: RequestContext, @Param("envId", uuidParam()) envId: string) {
    await this.envs.remove(ctx, envId);
  }
}

@Module({ controllers: [EnvironmentsController], providers: [EnvironmentsService] })
export class EnvironmentsModule {}
