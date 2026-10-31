import { refuseAutoPublish } from "../common/draft-only.js";
import { workspaceTransaction } from "../common/workspace-transaction.js";
import { randomUUID } from "node:crypto";
import { Body, Controller, Delete, Get, HttpCode, Inject, Injectable, Module, Param, Post, Put, Query } from "@nestjs/common";
import { platformPlugins, type Plugin } from "@gromesh/compiler";
import { and, asc, eq, gt, isNull, or, sql, type SQL } from "drizzle-orm";
import type { PluginWrite } from "../api-types.js";
import { audit } from "../audit/audit.js";
import { Ctx, RequiredPermission, RequiredRole, type RequestContext } from "../auth/auth.js";
import { contractBody, contractBodyV2 } from "../common/contract.js";
import { decodeCursor, parseLimit, toPage } from "../common/pagination.js";
import { notFound, unprocessable, type FieldError } from "../common/problem.js";
import { pluginPrivilegedIssues, requirePlatformAdmin } from "../common/privileged.js";
import { vaultReferenceIssues } from "../common/vault-references.js";
import { APP_CONFIG, type AppConfig } from "../config.js";
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
    @Inject(APP_CONFIG) private readonly config: AppConfig,
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

  async create(ctx: RequestContext, envId: string, body: PluginWrite, options: { draftOnly?: boolean } = {}) {
    const id = randomUUID();
    requirePlatformAdmin(ctx, pluginPrivilegedIssues(body));
    const merged = this.withSecrets(body, null);
    if (!options.draftOnly) await this.validate(id, merged);
    return workspaceTransaction(this.db, envId, async (tx) => {
      if (options.draftOnly) {
        await refuseAutoPublish(tx, envId);
        this.checkWorkspacePlugin(envId, merged);
        await this.validate(id, merged);
        await this.checkWorkspaceAuthentication(tx, envId, id, merged);
      }
      await requireEnvironment(tx, envId);
      await this.checkScope(tx, envId, merged);
      const [row] = await tx.insert(plugins).values({ id, environmentId: envId, ...pluginValues(id, merged, this.enc, this.catalog) }).returning();
      const after = this.publicPlugin(row!);
      await markDraftChanged(tx, envId);
      await audit(tx, ctx, { action: "plugin.create", entityType: "plugin", entityId: id, environmentId: envId, after });
      return after;
    });
  }

  async replace(ctx: RequestContext, envId: string, pluginId: string, body: PluginWrite, options: { draftOnly?: boolean } = {}) {
    // v1 validates before taking the lock; v2 merges and validates again from the row held by the workspace writer.
    const current = await this.requirePlugin(this.db, envId, pluginId);
    // Replacing a privileged plugin with an ordinary one would still change what the platform admin put live.
    requirePlatformAdmin(ctx, [...pluginPrivilegedIssues(current), ...pluginPrivilegedIssues(body)]);
    const validated = options.draftOnly ? null : this.withSecrets(body, current);
    if (validated) await this.validate(pluginId, validated);
    return workspaceTransaction(this.db, envId, async (tx) => {
      if (options.draftOnly) await refuseAutoPublish(tx, envId);
      const locked = await this.requirePlugin(tx, envId, pluginId);
      let merged = validated ?? body;
      if (options.draftOnly) {
        // A v1 writer may have changed both privileges and secrets while this writer waited for the workspace.
        requirePlatformAdmin(ctx, [...pluginPrivilegedIssues(locked), ...pluginPrivilegedIssues(body)]);
        this.checkWorkspacePlugin(envId, locked, false);
        merged = this.withSecrets(body, locked);
        this.checkWorkspacePlugin(envId, merged);
        await this.validate(pluginId, merged);
        await this.checkWorkspaceAuthentication(tx, envId, pluginId, merged);
      }
      const before = this.publicPlugin(locked);
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

  async remove(ctx: RequestContext, envId: string, pluginId: string, options: { draftOnly?: boolean } = {}) {
    await workspaceTransaction(this.db, envId, async (tx) => {
      if (options.draftOnly) await refuseAutoPublish(tx, envId);
      const before = toPlugin(await this.requirePlugin(tx, envId, pluginId));
      if (options.draftOnly) this.checkWorkspacePlugin(envId, before, false);
      requirePlatformAdmin(ctx, pluginPrivilegedIssues(before));
      await tx.delete(plugins).where(eq(plugins.id, pluginId));
      await markDraftChanged(tx, envId);
      await audit(tx, ctx, { action: "plugin.delete", entityType: "plugin", entityId: pluginId, environmentId: envId, before: this.redacted(before) });
    });
  }

  /** v2 reservations apply even to platform admins here: exceptions have their own future contract. */
  private checkWorkspacePlugin(workspaceId: string, body: Pick<PluginWrite, "name" | "config" | "scope" | "tags">, writing = true): void {
    const mandatory = this.config.platformHttpLogEndpoint
      ? platformPlugins({ httpLogEndpoint: this.config.platformHttpLogEndpoint, environmentId: workspaceId }) : [];
    const errors: FieldError[] = [];
    if (body.name.startsWith("gromesh-") || mandatory.some(p => p.name === body.name)) {
      errors.push({ path: "name", message: "reserved mandatory platform plugin" });
    }
    if (writing) {
      if (["ldap-auth", "session", "hmac-auth", "acme", "oauth2"].includes(body.name)) errors.push({ path: "name", message: "plugin is not available to a Workspace" });
      body.tags?.forEach((tag, i) => { if (tag.startsWith("gromesh-")) errors.push({ path: `tags.${i}`, message: "tags gromesh-* are reserved" }); });
      errors.push(...this.catalog.importConfigErrors(body.name, body.config ?? {}));
    }
    if (errors.length) throw unprocessable("Invalid workspace plugin", errors);
  }

  /** Only key-auth/basic-auth/jwt are modelled in the core; two distinct effective mechanisms are forbidden. */
  private async checkWorkspaceAuthentication(tx: Executor, envId: string, id: string, body: PluginWrite): Promise<void> {
    const auth = new Set(["key-auth", "basic-auth", "jwt"]);
    if (!auth.has(body.name)) return;
    if (body.scope?.consumerId) throw unprocessable("Invalid workspace plugin", [{ path: "scope.consumerId", message: "an authenticator cannot be scoped to a consumer" }]);
    if (body.enabled === false) return;
    const all = await tx.select().from(plugins).where(eq(plugins.environmentId, envId));
    const candidates = [...all.filter(p => p.id !== id).map(p => ({ name: p.name, enabled: p.enabled, scope: { serviceId: p.serviceId, routeId: p.routeId, consumerId: p.consumerId } })), body];
    const ownRoutes = await tx.select().from(routes).where(eq(routes.environmentId, envId));
    for (const route of ownRoutes) {
      const names = new Set(candidates.filter(p => auth.has(p.name) && p.enabled !== false && !p.scope?.consumerId &&
        (!p.scope?.routeId || p.scope.routeId === route.id) && (!p.scope?.serviceId || p.scope.serviceId === route.serviceId)).map(p => p.name));
      if (names.size > 1) throw unprocessable("Invalid workspace plugin", [{ path: "name", message: "at most one effective authentication mechanism per route is allowed" }]);
    }
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

  /** Catalog rules (ours), then the config itself is validated by the pinned Kong. */
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
    const exists = async (table: typeof services | typeof routes | typeof consumers, refId: string) =>
      (await tx.select({ id: table.id }).from(table).where(and(eq(table.id, refId), eq(table.environmentId, envId)))).length > 0;
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
 * control-plane-v2 shares the v1 service (H-9); its writes remain draft-only under the workspace lock.
 */
@Controller("api/v2/workspaces/:workspaceId/plugins")
export class WorkspacePluginsController {
  constructor(private readonly plugins: PluginsService) {}

  @Get()
  @RequiredPermission("workspace.read", "workspace")
  list(@Param("workspaceId", uuidParam()) workspaceId: string, @Query() query: Record<string, unknown>) {
    return this.plugins.list(workspaceId, query);
  }

  @Post()
  @RequiredPermission("gateway.write", "workspace")
  create(@Ctx() ctx: RequestContext, @Param("workspaceId", uuidParam()) workspaceId: string, @Body(contractBodyV2("WorkspacePluginWrite")) body: PluginWrite) {
    return this.plugins.create(ctx, workspaceId, body, { draftOnly: true });
  }

  @Put(":pluginId")
  @RequiredPermission("gateway.write", "workspace")
  replace(@Ctx() ctx: RequestContext, @Param("workspaceId", uuidParam()) workspaceId: string, @Param("pluginId", uuidParam()) pluginId: string, @Body(contractBodyV2("WorkspacePluginWrite")) body: PluginWrite) {
    return this.plugins.replace(ctx, workspaceId, pluginId, body, { draftOnly: true });
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
    await this.plugins.remove(ctx, workspaceId, pluginId, { draftOnly: true });
  }
}

@Module({ imports: [PluginCatalogModule], controllers: [PluginsController, WorkspacePluginsController], providers: [PluginsService, KongValidator], exports: [PluginsService] })
export class PluginsModule {}
