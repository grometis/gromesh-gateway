import { randomUUID } from "node:crypto";
import { Body, Controller, Delete, Get, HttpCode, Inject, Injectable, Module, Param, Post, Put, Query } from "@nestjs/common";
import type { Plugin } from "@gromesh/compiler";
import { and, asc, eq, gt, isNull, or, sql, type SQL } from "drizzle-orm";
import type { PluginWrite } from "../api-types.js";
import { audit } from "../audit/audit.js";
import { Ctx, RequiredRole, type RequestContext } from "../auth/auth.js";
import { contractBody } from "../common/contract.js";
import { decodeCursor, parseLimit, toPage } from "../common/pagination.js";
import { notFound, unprocessable, type FieldError } from "../common/problem.js";
import { DB, type Db, type Executor } from "../db/db.js";
import { consumers, plugins, routes, services, type PluginRow } from "../db/schema.js";
import { markDraftChanged, requireEnvironment, uuidParam } from "../environments/environments.js";
import { PluginCatalog, PluginCatalogModule } from "../plugin-catalog/catalog.js";
import { KongValidator } from "./kong-validator.js";

/* ---------------- mapping ---------------- */

export function toPlugin(r: PluginRow) {
  return {
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    scope: { serviceId: r.serviceId, routeId: r.routeId, consumerId: r.consumerId },
    config: r.config,
    ...(r.protocols ? { protocols: r.protocols } : {}),
    tags: r.tags,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function pluginValues(body: PluginWrite | Plugin) {
  return {
    name: body.name,
    enabled: body.enabled ?? true,
    serviceId: body.scope?.serviceId ?? null,
    routeId: body.scope?.routeId ?? null,
    consumerId: body.scope?.consumerId ?? null,
    config: body.config ?? {},
    protocols: body.protocols && body.protocols.length > 0 ? body.protocols : null,
    tags: body.tags ?? [],
  };
}

/* ---------------- service ---------------- */

@Injectable()
export class PluginsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly catalog: PluginCatalog,
    private readonly validator: KongValidator,
  ) {}

  async list(envId: string, query: Record<string, unknown>) {
    await requireEnvironment(this.db, envId);
    const limit = parseLimit(query.limit);
    const parts: (SQL | undefined)[] = [eq(plugins.environmentId, envId)];
    if (typeof query.serviceId === "string") parts.push(eq(plugins.serviceId, query.serviceId));
    if (typeof query.routeId === "string") parts.push(eq(plugins.routeId, query.routeId));
    if (typeof query.consumerId === "string") parts.push(eq(plugins.consumerId, query.consumerId));
    if (query.global === "true") parts.push(isNull(plugins.serviceId), isNull(plugins.routeId), isNull(plugins.consumerId));
    const c = decodeCursor(query.cursor);
    if (c) parts.push(or(gt(plugins.name, c.k), and(eq(plugins.name, c.k), gt(plugins.id, c.id))));
    const rows = await this.db
      .select()
      .from(plugins)
      .where(and(...parts))
      .orderBy(asc(plugins.name), asc(plugins.id))
      .limit(limit + 1);
    return toPage(rows, limit, (r) => r.name, toPlugin);
  }

  async get(envId: string, pluginId: string) {
    return toPlugin(await this.requirePlugin(this.db, envId, pluginId));
  }

  async create(ctx: RequestContext, envId: string, body: PluginWrite) {
    const id = randomUUID();
    await this.validate(id, body);
    return this.db.transaction(async (tx) => {
      await requireEnvironment(tx, envId);
      await this.checkScope(tx, envId, body);
      const [row] = await tx.insert(plugins).values({ id, environmentId: envId, ...pluginValues(body) }).returning();
      const after = toPlugin(row!);
      await markDraftChanged(tx, envId);
      await audit(tx, ctx, { action: "plugin.create", entityType: "plugin", entityId: id, environmentId: envId, after: this.redacted(after) });
      return after;
    });
  }

  async replace(ctx: RequestContext, envId: string, pluginId: string, body: PluginWrite) {
    await this.validate(pluginId, body);
    return this.db.transaction(async (tx) => {
      const before = toPlugin(await this.requirePlugin(tx, envId, pluginId));
      await this.checkScope(tx, envId, body);
      const [row] = await tx
        .update(plugins)
        .set({ ...pluginValues(body), updatedAt: sql`now()` })
        .where(eq(plugins.id, pluginId))
        .returning();
      const after = toPlugin(row!);
      await markDraftChanged(tx, envId);
      await audit(tx, ctx, {
        action: "plugin.update",
        entityType: "plugin",
        entityId: pluginId,
        environmentId: envId,
        before: this.redacted(before),
        after: this.redacted(after),
      });
      return after;
    });
  }

  async remove(ctx: RequestContext, envId: string, pluginId: string) {
    await this.db.transaction(async (tx) => {
      const before = toPlugin(await this.requirePlugin(tx, envId, pluginId));
      await tx.delete(plugins).where(eq(plugins.id, pluginId));
      await markDraftChanged(tx, envId);
      await audit(tx, ctx, { action: "plugin.delete", entityType: "plugin", entityId: pluginId, environmentId: envId, before: this.redacted(before) });
    });
  }

  private redacted(p: ReturnType<typeof toPlugin>) {
    return { ...p, config: this.catalog.redactConfig(p.name, p.config) };
  }

  private async requirePlugin(tx: Executor, envId: string, pluginId: string): Promise<PluginRow> {
    const [row] = await tx
      .select()
      .from(plugins)
      .where(and(eq(plugins.id, pluginId), eq(plugins.environmentId, envId)));
    if (!row) throw notFound("Plugin");
    return row;
  }

  /** Catalog rules (ours), then the config itself is validated by Kong — outside any transaction. */
  private async validate(id: string, body: PluginWrite): Promise<void> {
    const entry = this.catalog.find(body.name);
    if (!entry) throw unprocessable("Invalid plugin", [{ path: "name", message: `unknown plugin "${body.name}"` }]);
    if (!entry.supportedInDbless) {
      throw unprocessable("Invalid plugin", [{ path: "name", message: `plugin "${body.name}" needs Kong's database and cannot run DB-less` }]);
    }
    await this.validator.validatePlugin({ id, ...body });
  }

  private async checkScope(tx: Executor, envId: string, body: PluginWrite): Promise<void> {
    const s = body.scope ?? {};
    const errors: FieldError[] = [];
    const exists = async (table: typeof services | typeof routes | typeof consumers, refId: string) =>
      (await tx.select({ id: table.id }).from(table).where(and(eq(table.id, refId), eq(table.environmentId, envId)))).length > 0;
    if (s.serviceId && !(await exists(services, s.serviceId))) errors.push({ path: "scope.serviceId", message: "unknown service in this environment" });
    if (s.routeId && !(await exists(routes, s.routeId))) errors.push({ path: "scope.routeId", message: "unknown route in this environment" });
    if (s.consumerId && !(await exists(consumers, s.consumerId))) errors.push({ path: "scope.consumerId", message: "unknown consumer in this environment" });
    if (errors.length > 0) throw unprocessable("Invalid plugin", errors);
  }
}

/* ---------------- controller ---------------- */

@Controller("environments/:envId/plugins")
export class PluginsController {
  constructor(private readonly plugins: PluginsService) {}

  @Get()
  @RequiredRole("viewer")
  list(@Param("envId", uuidParam()) envId: string, @Query() query: Record<string, unknown>) {
    return this.plugins.list(envId, query);
  }

  @Post()
  @RequiredRole("editor")
  create(@Ctx() ctx: RequestContext, @Param("envId", uuidParam()) envId: string, @Body(contractBody("PluginWrite")) body: PluginWrite) {
    return this.plugins.create(ctx, envId, body);
  }

  @Get(":pluginId")
  @RequiredRole("viewer")
  get(@Param("envId", uuidParam()) envId: string, @Param("pluginId", uuidParam()) pluginId: string) {
    return this.plugins.get(envId, pluginId);
  }

  @Put(":pluginId")
  @RequiredRole("editor")
  replace(
    @Ctx() ctx: RequestContext,
    @Param("envId", uuidParam()) envId: string,
    @Param("pluginId", uuidParam()) pluginId: string,
    @Body(contractBody("PluginWrite")) body: PluginWrite,
  ) {
    return this.plugins.replace(ctx, envId, pluginId, body);
  }

  @Delete(":pluginId")
  @HttpCode(204)
  @RequiredRole("editor")
  async remove(@Ctx() ctx: RequestContext, @Param("envId", uuidParam()) envId: string, @Param("pluginId", uuidParam()) pluginId: string) {
    await this.plugins.remove(ctx, envId, pluginId);
  }
}

@Module({ imports: [PluginCatalogModule], controllers: [PluginsController], providers: [PluginsService, KongValidator] })
export class PluginsModule {}
