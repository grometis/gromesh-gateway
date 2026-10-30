import { randomUUID } from "node:crypto";
import { Body, Controller, Delete, Get, HttpCode, Inject, Injectable, Module, Param, Post, Put, Query } from "@nestjs/common";
import type { Plugin } from "@gromesh/compiler";
import { and, asc, eq, gt, isNull, or, sql, type SQL } from "drizzle-orm";
import type { PluginWrite } from "../api-types.js";
import { audit } from "../audit/audit.js";
import { Ctx, RequiredPermission, RequiredRole, type RequestContext } from "../auth/auth.js";
import { contractBody } from "../common/contract.js";
import { decodeCursor, parseLimit, toPage } from "../common/pagination.js";
import { notFound, unprocessable, type FieldError } from "../common/problem.js";
import { pluginPrivilegedIssues, requirePlatformAdmin } from "../common/privileged.js";
import { vaultReferenceIssues } from "../common/vault-references.js";
import { DB, type Db, type Executor } from "../db/db.js";
import { consumers, plugins, routes, services, type PluginRow } from "../db/schema.js";
import { markDraftChanged, requireEnvironment, uuidParam } from "../environments/environments.js";
import { pluginSecretContext, ENCRYPTOR, Encryptor } from "../crypto/crypto.js";
import { PluginCatalog, PluginCatalogModule, SECRET_PLACEHOLDER } from "../plugin-catalog/catalog.js";
import { KongValidator } from "./kong-validator.js";
import { anonymousOf, anonymousResolves } from "../workspaces/anonymous.js";

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

/** Column values for a plugin whose config is in clear: its secret fields are sealed. */
export function pluginValues(id: string, body: PluginWrite | Plugin, enc: Encryptor, catalog: PluginCatalog) {
  return {
    name: body.name,
    enabled: body.enabled ?? true,
    serviceId: body.scope?.serviceId ?? null,
    routeId: body.scope?.routeId ?? null,
    consumerId: body.scope?.consumerId ?? null,
    config: catalog.mapSecrets(body.name, body.config ?? {}, (v, path) => enc.seal(v, pluginSecretContext(id, path))),
    protocols: body.protocols && body.protocols.length > 0 ? body.protocols : catalog.defaultProtocols(body.name) ?? null,
    tags: body.tags ?? [],
  };
}

/* ---------------- service ---------------- */

@Injectable()
export class PluginsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENCRYPTOR) private readonly enc: Encryptor,
    private readonly catalog: PluginCatalog,
    private readonly validator: KongValidator,
  ) {}

  /** Every plugin the API returns has its secrets redacted, whatever the caller's role: they are write-only. */
  private publicPlugin(row: PluginRow) {
    return this.redacted(toPlugin(row));
  }

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
    return toPage(rows, limit, (r) => r.name, (r) => this.publicPlugin(r));
  }

  async get(envId: string, pluginId: string) {
    return this.publicPlugin(await this.requirePlugin(this.db, envId, pluginId));
  }

  async create(ctx: RequestContext, envId: string, body: PluginWrite) {
    const id = randomUUID();
    requirePlatformAdmin(ctx, pluginPrivilegedIssues(body));
    const merged = this.withSecrets(body, null);
    await this.validate(id, merged);
    return this.db.transaction(async (tx) => {
      await requireEnvironment(tx, envId);
      await this.checkScope(tx, envId, merged);
      const [row] = await tx.insert(plugins).values({ id, environmentId: envId, ...pluginValues(id, merged, this.enc, this.catalog) }).returning();
      const after = this.publicPlugin(row!);
      await markDraftChanged(tx, envId);
      await audit(tx, ctx, { action: "plugin.create", entityType: "plugin", entityId: id, environmentId: envId, after });
      return after;
    });
  }

  async replace(ctx: RequestContext, envId: string, pluginId: string, body: PluginWrite) {
    // The stored secrets are read before validation, which runs outside the transaction (it calls Kong).
    const current = await this.requirePlugin(this.db, envId, pluginId);
    // Replacing a privileged plugin with an ordinary one would still change what the platform admin put live.
    requirePlatformAdmin(ctx, [...pluginPrivilegedIssues(current), ...pluginPrivilegedIssues(body)]);
    const merged = this.withSecrets(body, current);
    await this.validate(pluginId, merged);
    return this.db.transaction(async (tx) => {
      const before = this.publicPlugin(await this.requirePlugin(tx, envId, pluginId));
      await this.checkScope(tx, envId, merged);
      const [row] = await tx
        .update(plugins)
        .set({ ...pluginValues(pluginId, merged, this.enc, this.catalog), updatedAt: sql`now()` })
        .where(eq(plugins.id, pluginId))
        .returning();
      const after = this.publicPlugin(row!);
      await markDraftChanged(tx, envId);
      await audit(tx, ctx, { action: "plugin.update", entityType: "plugin", entityId: pluginId, environmentId: envId, before, after });
      return after;
    });
  }

  /**
   * "REDACTED" in a secret field means "keep what is stored": the body is completed from `current` before Kong
   * validates it. A new plugin, a renamed one or a secret never set has nothing to keep: 422 on that field.
   */
  private withSecrets(body: PluginWrite, current: PluginRow | null): PluginWrite {
    const stored = current && current.name === body.name ? this.catalog.mapSecrets(current.name, current.config, (v, path) => this.enc.open(v, pluginSecretContext(current.id, path))) : null;
    const { config, missing } = this.catalog.mergeSecrets(body.name, body.config ?? {}, stored);
    if (missing.length > 0) {
      throw unprocessable(
        "Invalid plugin",
        missing.map((path) => ({ path, message: `"${SECRET_PLACEHOLDER}" is a placeholder: send the secret itself` })),
      );
    }
    return { ...body, config };
  }

  async remove(ctx: RequestContext, envId: string, pluginId: string) {
    await this.db.transaction(async (tx) => {
      const before = toPlugin(await this.requirePlugin(tx, envId, pluginId));
      requirePlatformAdmin(ctx, pluginPrivilegedIssues(before));
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
  async validate(id: string, body: PluginWrite): Promise<void> {
    const entry = this.catalog.find(body.name);
    if (!entry) throw unprocessable("Invalid plugin", [{ path: "name", message: `unknown plugin "${body.name}"` }]);
    if (!entry.supportedInDbless) {
      throw unprocessable("Invalid plugin", [{ path: "name", message: `plugin "${body.name}" needs Kong's database and cannot run DB-less` }]);
    }
    const names = body.config?.key_names;
    if (body.name === "key-auth" && names !== undefined &&
      (!Array.isArray(names) || names.length === 0 || !names.every((name: unknown) => typeof name === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(name)))) {
      throw unprocessable("Invalid plugin", [{ path: "config.key_names", message: "must be a non-empty array of names matching ^[A-Za-z0-9._-]{1,64}$" }]);
    }
    const references = vaultReferenceIssues(body.config ?? {}, "config");
    if (references.length > 0) throw unprocessable("Invalid plugin", references);
    await this.validator.validatePlugin({ id, ...body });
  }

  private async checkScope(tx: Executor, envId: string, body: PluginWrite): Promise<void> {
    const s = body.scope ?? {};
    const errors: FieldError[] = [];
    // Service/route DELETE locks its row before cascading to plugins: take those scope locks before UPDATE too,
    // or a scope change can hold the plugin while waiting on its deleting parent. Consumer locking is unchanged.
    const exists = async (table: typeof services | typeof routes | typeof consumers, refId: string) => {
      const q = tx.select({ id: table.id }).from(table).where(and(eq(table.id, refId), eq(table.environmentId, envId)));
      return (await (table === consumers ? q : q.for("key share"))).length > 0;
    };
    if (s.serviceId && !(await exists(services, s.serviceId))) errors.push({ path: "scope.serviceId", message: "unknown service in this environment" });
    if (s.routeId && !(await exists(routes, s.routeId))) errors.push({ path: "scope.routeId", message: "unknown route in this environment" });
    if (s.consumerId && !(await exists(consumers, s.consumerId))) errors.push({ path: "scope.consumerId", message: "unknown consumer in this environment" });
    const anonymous = anonymousOf(body.config);
    if (anonymous !== null && !(await anonymousResolves(tx, envId, anonymous))) errors.push({ path: "config.anonymous", message: "unknown consumer in this environment" });
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

/**
 * control-plane-v2: the same service in the workspace with the environment's id (decision H-9). Writing waits for
 * the platform-only capabilities (pre/post-function, file-log, *_by_lua, ambient cloud credentials) of the F-1 track.
 */
@Controller("api/v2/workspaces/:workspaceId/plugins")
export class WorkspacePluginsController {
  constructor(private readonly plugins: PluginsService) {}

  @Get()
  @RequiredPermission("workspace.read", "workspace")
  list(@Param("workspaceId", uuidParam()) workspaceId: string, @Query() query: Record<string, unknown>) {
    return this.plugins.list(workspaceId, query);
  }

  @Get(":pluginId")
  @RequiredPermission("workspace.read", "workspace")
  get(@Param("workspaceId", uuidParam()) workspaceId: string, @Param("pluginId", uuidParam()) pluginId: string) {
    return this.plugins.get(workspaceId, pluginId);
  }

  @Delete(":pluginId")
  @HttpCode(204)
  @RequiredPermission("gateway.write", "workspace")
  async remove(@Ctx() ctx: RequestContext, @Param("workspaceId", uuidParam()) workspaceId: string, @Param("pluginId", uuidParam()) pluginId: string) {
    await this.plugins.remove(ctx, workspaceId, pluginId);
  }
}

@Module({ imports: [PluginCatalogModule], controllers: [PluginsController, WorkspacePluginsController], providers: [PluginsService, KongValidator], exports: [PluginsService] })
export class PluginsModule {}
