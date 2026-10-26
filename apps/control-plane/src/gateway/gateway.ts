import { Body, Controller, Delete, Get, HttpCode, Inject, Injectable, Module, Param, Post, Put, Query } from "@nestjs/common";
import type { GatewayState, Route, Service } from "@gromesh/compiler";
import { and, asc, count, eq, gt, ilike, or, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { RouteWrite, ServiceWrite } from "../api-types.js";
import { audit } from "../audit/audit.js";
import { Ctx, RequiredPermission, RequiredRole, type RequestContext } from "../auth/auth.js";
import { contractBody } from "../common/contract.js";
import { decodeCursor, parseLimit, toPage } from "../common/pagination.js";
import { conflict, notFound, unprocessable } from "../common/problem.js";
import { assertDestination, destinationPolicy, type DestinationPolicy } from "../common/destinations.js";
import { APP_CONFIG, type AppConfig } from "../config.js";
import { DB, type Db, type Executor } from "../db/db.js";
import { consumerValues, keyAuthValues } from "../consumers/consumers.js";
import { basicAuthCredentials, consumers, jwtCredentials, keyAuthCredentials, plugins, routes, services, targets, upstreams, type RouteRow, type ServiceRow } from "../db/schema.js";
import { basicAuthState, basicAuthValues, jwtState, jwtValues } from "../consumers/credentials.js";
import { loadCertificates, restoreCertificates } from "../certificates/certificates.js";
import { targetState, targetValues, upstreamState, upstreamValues } from "../upstreams/upstreams.js";
import { pluginValues } from "../plugins/plugins.js";
import { credentialContext, type Encryptor, pluginSecretContext } from "../crypto/crypto.js";
import type { PluginCatalog } from "../plugin-catalog/catalog.js";
import { markDraftChanged, requireEnvironment, uuidParam } from "../environments/environments.js";
import { anonymousOf, namesConsumer } from "../workspaces/anonymous.js";
import { assertStateFree } from "../workspaces/instance-uniqueness.js";

/* ---------------- mapping ---------------- */

const optional = <T>(v: T | null | undefined): T | undefined => (v === null ? undefined : v);
const dropUndefined = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export function toService(r: ServiceRow) {
  return dropUndefined({
    id: r.id,
    name: r.name,
    protocol: r.protocol as ServiceWrite["protocol"],
    host: r.host,
    port: r.port,
    path: r.path,
    retries: optional(r.retries),
    connectTimeoutMs: optional(r.connectTimeoutMs),
    readTimeoutMs: optional(r.readTimeoutMs),
    writeTimeoutMs: optional(r.writeTimeoutMs),
    enabled: r.enabled,
    tags: r.tags,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  });
}

export function toRoute(r: RouteRow) {
  return dropUndefined({
    id: r.id,
    name: r.name,
    serviceId: r.serviceId,
    protocols: r.protocols as NonNullable<RouteWrite["protocols"]>,
    methods: optional(r.methods),
    hosts: optional(r.hosts),
    paths: optional(r.paths),
    headers: optional(r.headers),
    stripPath: r.stripPath,
    preserveHost: r.preserveHost,
    analyticsRetentionDays: r.analyticsRetentionDays,
    tags: r.tags,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  });
}

export function serviceValues(body: ServiceWrite | Service) {
  return {
    name: body.name,
    protocol: body.protocol,
    host: body.host,
    port: body.port,
    path: body.path ?? null,
    retries: body.retries ?? null,
    connectTimeoutMs: body.connectTimeoutMs ?? null,
    readTimeoutMs: body.readTimeoutMs ?? null,
    writeTimeoutMs: body.writeTimeoutMs ?? null,
    enabled: body.enabled ?? true,
    tags: body.tags ?? [],
  };
}

export function routeValues(body: RouteWrite | Route) {
  const list = (v: string[] | undefined) => (v && v.length > 0 ? v : null);
  return {
    name: body.name,
    serviceId: body.serviceId,
    protocols: body.protocols ?? ["http", "https"],
    methods: list(body.methods?.map((m) => m.toUpperCase())),
    hosts: list(body.hosts),
    paths: list(body.paths),
    headers: body.headers && Object.keys(body.headers).length > 0 ? body.headers : null,
    stripPath: body.stripPath ?? true,
    preserveHost: body.preserveHost ?? false,
    analyticsRetentionDays: body.analyticsRetentionDays ?? null,
    tags: body.tags ?? [],
  };
}

/** Keyset pagination on (name, id) + optional name search. */
function listFilter(envCol: PgColumn, nameCol: PgColumn, idCol: PgColumn, envId: string, q: unknown, cursor: unknown): SQL {
  const parts: (SQL | undefined)[] = [eq(envCol, envId)];
  if (typeof q === "string" && q.trim()) parts.push(ilike(nameCol, `%${q.trim().replace(/[%_\\]/g, "\\$&")}%`));
  const c = decodeCursor(cursor);
  if (c) parts.push(or(gt(nameCol, c.k), and(eq(nameCol, c.k), gt(idCol, c.id))));
  return and(...parts)!;
}

/* ---------------- state for the compiler ---------------- */

/** Everything in the environment's draft that affects traffic, in the compiler's domain model. */
export async function loadGatewayState(tx: Executor, envId: string, enc: Encryptor, catalog: PluginCatalog): Promise<GatewayState> {
  const [svcRows, routeRows, consumerRows, keyRows, jwtRows, basicRows, pluginRows, upstreamRows, targetRows, certs] = await Promise.all([
    tx.select().from(services).where(eq(services.environmentId, envId)),
    tx.select().from(routes).where(eq(routes.environmentId, envId)),
    tx.select().from(consumers).where(eq(consumers.environmentId, envId)),
    tx.select().from(keyAuthCredentials).where(eq(keyAuthCredentials.environmentId, envId)),
    tx.select().from(jwtCredentials).where(eq(jwtCredentials.environmentId, envId)),
    tx.select().from(basicAuthCredentials).where(eq(basicAuthCredentials.environmentId, envId)),
    tx.select().from(plugins).where(eq(plugins.environmentId, envId)),
    tx.select().from(upstreams).where(eq(upstreams.environmentId, envId)),
    tx.select().from(targets).where(eq(targets.environmentId, envId)),
    loadCertificates(tx, envId, enc),
  ]);
  return {
    services: svcRows.map((s) => {
      const { createdAt: _c, updatedAt: _u, ...svc } = toService(s);
      return svc;
    }),
    routes: routeRows.map((r) => {
      const { createdAt: _c, updatedAt: _u, ...route } = toRoute(r);
      return route;
    }),
    consumers: consumerRows.map((c) => ({ id: c.id, username: c.username, customId: c.customId, aclGroups: c.aclGroups, tags: c.tags })),
    keyAuthCredentials: keyRows.map((k) => ({ id: k.id, consumerId: k.consumerId, key: enc.open(k.key, credentialContext(k.id)), tags: k.tags, ...(k.pendingReprovision ? { pendingReprovision: true } : {}) })),
    jwtCredentials: jwtRows.map((j) => jwtState(j, enc)),
    basicAuthCredentials: basicRows.map((b) => basicAuthState(b, enc)),
    plugins: pluginRows.map((p) => ({
      id: p.id,
      name: p.name,
      enabled: p.enabled,
      scope: { serviceId: p.serviceId, routeId: p.routeId, consumerId: p.consumerId },
      config: catalog.mapSecrets(p.name, p.config, (v, path) => enc.open(v, pluginSecretContext(p.id, path))),
      protocols: optional(p.protocols) ?? catalog.defaultProtocols(p.name),
      tags: p.tags,
    })),
    upstreams: upstreamRows.map(upstreamState),
    targets: targetRows.map(targetState),
    certificates: certs,
  };
}

/** The routes of the draft that are workspace-default (the rest are legacy-preserved). */
export async function workspaceDefaultRoutes(tx: Executor, envId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: routes.id })
    .from(routes)
    .where(and(eq(routes.environmentId, envId), eq(routes.pathCompatibility, "workspace-default")))
    .orderBy(asc(routes.id));
  return rows.map((r) => r.id);
}

/**
 * Replaces the environment's draft with `state`, keeping entity ids. The routes of `workspaceDefault` are restored
 * workspace-default (a rollback passes the version's own list); without it, a route keeps the classification its id
 * has in the draft being replaced (import), and any other route is legacy-preserved.
 */
export async function restoreGatewayState(
  tx: Executor,
  envId: string,
  state: GatewayState,
  enc: Encryptor,
  catalog: PluginCatalog,
  workspaceDefault?: readonly string[],
): Promise<void> {
  // A version whose plugin falls back to a consumer it does not hold (written before the rule) is not restored.
  for (const plugin of state.plugins) {
    const anonymous = anonymousOf(plugin.config);
    if (anonymous !== null && !state.consumers.some((c) => namesConsumer(anonymous, c))) throw conflict("A plugin of this configuration uses as anonymous a consumer it does not hold");
  }
  // Nor one holding a credential or server name another workspace holds now (decision H-5).
  await assertStateFree(tx, envId, state, enc);
  const keep = new Set(workspaceDefault ?? (await workspaceDefaultRoutes(tx, envId)));
  const lost = state.routes.filter((r) => keep.has(r.id) && !(r.paths && r.paths.length > 0));
  if (lost.length > 0) {
    throw unprocessable("A workspace-default route keeps at least one path", lost.map((r) => ({ path: `routes.${r.name}.paths`, message: "required for a workspace-default route" })));
  }
  // Dependents first: plugins and credentials reference the rest, routes reference services (ON DELETE RESTRICT).
  await tx.delete(plugins).where(eq(plugins.environmentId, envId));
  await tx.delete(keyAuthCredentials).where(eq(keyAuthCredentials.environmentId, envId));
  await tx.delete(jwtCredentials).where(eq(jwtCredentials.environmentId, envId));
  await tx.delete(basicAuthCredentials).where(eq(basicAuthCredentials.environmentId, envId));
  await tx.delete(routes).where(eq(routes.environmentId, envId));
  await tx.delete(consumers).where(eq(consumers.environmentId, envId));
  await tx.delete(services).where(eq(services.environmentId, envId));
  // Targets go with their upstream (ON DELETE CASCADE); SNIs with their certificate.
  await tx.delete(upstreams).where(eq(upstreams.environmentId, envId));
  if ((state.upstreams ?? []).length > 0) {
    await tx.insert(upstreams).values(state.upstreams!.map((u) => ({ id: u.id, environmentId: envId, ...upstreamValues(u) })));
  }
  if ((state.targets ?? []).length > 0) {
    await tx.insert(targets).values(state.targets!.map((t) => ({ id: t.id, environmentId: envId, upstreamId: t.upstreamId, ...targetValues(t) })));
  }
  await restoreCertificates(tx, envId, state.certificates ?? [], enc);
  if (state.services.length > 0) {
    await tx.insert(services).values(state.services.map((s) => ({ id: s.id, environmentId: envId, ...serviceValues(s) })));
  }
  if (state.routes.length > 0) {
    await tx.insert(routes).values(
      state.routes.map((r) => ({ id: r.id, environmentId: envId, ...routeValues(r), pathCompatibility: keep.has(r.id) ? ("workspace-default" as const) : ("legacy-preserved" as const) })),
    );
  }
  if (state.consumers.length > 0) {
    await tx.insert(consumers).values(state.consumers.map((c) => ({ id: c.id, environmentId: envId, ...consumerValues(c), aclGroups: c.aclGroups ?? [] })));
  }
  if (state.keyAuthCredentials.length > 0) {
    await tx
      .insert(keyAuthCredentials)
      .values(state.keyAuthCredentials.map((k) => ({ environmentId: envId, ...keyAuthValues(k, enc) })));
  }
  if ((state.jwtCredentials ?? []).length > 0) {
    await tx.insert(jwtCredentials).values(state.jwtCredentials!.map((j) => ({ environmentId: envId, ...jwtValues(j, enc) })));
  }
  if ((state.basicAuthCredentials ?? []).length > 0) {
    await tx.insert(basicAuthCredentials).values(state.basicAuthCredentials!.map((b) => ({ environmentId: envId, ...basicAuthValues(b, enc) })));
  }
  if (state.plugins.length > 0) {
    await tx.insert(plugins).values(state.plugins.map((p) => ({ id: p.id, environmentId: envId, ...pluginValues(p.id, p, enc, catalog) })));
  }
}

export function routeErrors(body: RouteWrite) {
  const errors: { path: string; message: string }[] = [];
  const hasMatcher =
    (body.paths?.length ?? 0) > 0 ||
    (body.hosts?.length ?? 0) > 0 ||
    (body.methods?.length ?? 0) > 0 ||
    Object.keys(body.headers ?? {}).length > 0;
  if (!hasMatcher) errors.push({ path: "(body)", message: "must define at least one of paths, hosts, methods or headers" });
  body.paths?.forEach((p, i) => {
    if (!p.startsWith("/") && !p.startsWith("~/")) errors.push({ path: `paths.${i}`, message: "must start with '/' (or '~/' for a regex)" });
  });
  return errors;
}

/* ---------------- service ---------------- */

@Injectable()
export class GatewayService {
  private readonly destinations: DestinationPolicy;

  constructor(@Inject(DB) private readonly db: Db, @Inject(APP_CONFIG) config: AppConfig) {
    this.destinations = destinationPolicy(config);
  }

  /* services */

  async listServices(envId: string, query: Record<string, unknown>) {
    await requireEnvironment(this.db, envId);
    const limit = parseLimit(query.limit);
    const rows = await this.db
      .select()
      .from(services)
      .where(listFilter(services.environmentId, services.name, services.id, envId, query.q, query.cursor))
      .orderBy(asc(services.name), asc(services.id))
      .limit(limit + 1);
    return toPage(rows, limit, (r) => r.name, toService);
  }

  async getService(envId: string, serviceId: string) {
    return toService(await this.requireService(this.db, envId, serviceId));
  }

  async createService(ctx: RequestContext, envId: string, body: ServiceWrite) {
    assertDestination("host", body.host, this.destinations, "service");
    return this.db.transaction(async (tx) => {
      await requireEnvironment(tx, envId);
      const [row] = await tx.insert(services).values({ environmentId: envId, ...serviceValues(body) }).returning();
      const after = toService(row!);
      await markDraftChanged(tx, envId);
      await audit(tx, ctx, { action: "service.create", entityType: "service", entityId: after.id, environmentId: envId, after });
      return after;
    });
  }

  async replaceService(ctx: RequestContext, envId: string, serviceId: string, body: ServiceWrite) {
    assertDestination("host", body.host, this.destinations, "service");
    return this.db.transaction(async (tx) => {
      const before = toService(await this.requireService(tx, envId, serviceId));
      const [row] = await tx
        .update(services)
        .set({ ...serviceValues(body), updatedAt: sql`now()` })
        .where(eq(services.id, serviceId))
        .returning();
      const after = toService(row!);
      await markDraftChanged(tx, envId);
      await audit(tx, ctx, { action: "service.update", entityType: "service", entityId: serviceId, environmentId: envId, before, after });
      return after;
    });
  }

  /** v2 also refuses while plugins are scoped to the service (v1 deletes them with it). */
  async deleteService(ctx: RequestContext, envId: string, serviceId: string, options: { keepPlugins?: boolean } = {}) {
    await this.db.transaction(async (tx) => {
      // Locked first: a route or plugin created meanwhile (it takes the row's key share) waits, then is counted.
      const before = toService(await this.requireService(tx, envId, serviceId, true));
      const [ref] = await tx.select({ n: count() }).from(routes).where(eq(routes.serviceId, serviceId));
      if (ref && ref.n > 0) throw conflict(`Service is used by ${ref.n} route(s); delete them first`);
      if (options.keepPlugins) {
        const [scoped] = await tx.select({ n: count() }).from(plugins).where(eq(plugins.serviceId, serviceId));
        if (scoped && scoped.n > 0) throw conflict(`Service is used by ${scoped.n} plugin(s); delete them first`);
      }
      await tx.delete(services).where(eq(services.id, serviceId));
      await markDraftChanged(tx, envId);
      await audit(tx, ctx, { action: "service.delete", entityType: "service", entityId: serviceId, environmentId: envId, before });
    });
  }

  /* routes */

  async listRoutes<T = ReturnType<typeof toRoute>>(envId: string, query: Record<string, unknown>, map: (r: RouteRow) => T = toRoute as (r: RouteRow) => T) {
    await requireEnvironment(this.db, envId);
    const limit = parseLimit(query.limit);
    let where = listFilter(routes.environmentId, routes.name, routes.id, envId, query.q, query.cursor);
    if (typeof query.serviceId === "string") where = and(where, eq(routes.serviceId, query.serviceId))!;
    const rows = await this.db
      .select()
      .from(routes)
      .where(where)
      .orderBy(asc(routes.name), asc(routes.id))
      .limit(limit + 1);
    return toPage(rows, limit, (r) => r.name, map);
  }

  async getRoute<T = ReturnType<typeof toRoute>>(envId: string, routeId: string, map: (r: RouteRow) => T = toRoute as (r: RouteRow) => T) {
    return map(await this.requireRoute(this.db, envId, routeId));
  }

  async createRoute(ctx: RequestContext, envId: string, body: RouteWrite) {
    return this.db.transaction(async (tx) => {
      await requireEnvironment(tx, envId);
      await this.checkRoute(tx, envId, body);
      const [row] = await tx.insert(routes).values({ environmentId: envId, ...routeValues(body) }).returning();
      const after = toRoute(row!);
      await markDraftChanged(tx, envId);
      await audit(tx, ctx, { action: "route.create", entityType: "route", entityId: after.id, environmentId: envId, after });
      return after;
    });
  }

  async replaceRoute(ctx: RequestContext, envId: string, routeId: string, body: RouteWrite) {
    return this.db.transaction(async (tx) => {
      const before = toRoute(await this.requireRoute(tx, envId, routeId));
      await this.checkRoute(tx, envId, body);
      const [row] = await tx
        .update(routes)
        .set({ ...routeValues(body), updatedAt: sql`now()` })
        .where(eq(routes.id, routeId))
        .returning();
      const after = toRoute(row!);
      await markDraftChanged(tx, envId);
      await audit(tx, ctx, { action: "route.update", entityType: "route", entityId: routeId, environmentId: envId, before, after });
      return after;
    });
  }

  async deleteRoute(ctx: RequestContext, envId: string, routeId: string) {
    await this.db.transaction(async (tx) => {
      const before = toRoute(await this.requireRoute(tx, envId, routeId));
      await tx.delete(routes).where(eq(routes.id, routeId));
      await markDraftChanged(tx, envId);
      await audit(tx, ctx, { action: "route.delete", entityType: "route", entityId: routeId, environmentId: envId, before });
    });
  }

  /* helpers */

  private async requireService(tx: Executor, envId: string, serviceId: string, lock = false): Promise<ServiceRow> {
    const q = tx
      .select()
      .from(services)
      .where(and(eq(services.id, serviceId), eq(services.environmentId, envId)));
    const [row] = lock ? await q.for("update") : await q;
    if (!row) throw notFound("Service");
    return row;
  }

  private async requireRoute(tx: Executor, envId: string, routeId: string): Promise<RouteRow> {
    const [row] = await tx
      .select()
      .from(routes)
      .where(and(eq(routes.id, routeId), eq(routes.environmentId, envId)));
    if (!row) throw notFound("Route");
    return row;
  }

  /** Rules the contract states in prose (JSON Schema cannot express them). */
  private async checkRoute(tx: Executor, envId: string, body: RouteWrite): Promise<void> {
    const errors: { path: string; message: string }[] = [];
    errors.push(...routeErrors(body));
    const [svc] = await tx
      .select({ id: services.id })
      .from(services)
      .where(and(eq(services.id, body.serviceId), eq(services.environmentId, envId)));
    if (!svc) errors.push({ path: "serviceId", message: "unknown service in this environment" });
    if (errors.length > 0) throw unprocessable("Invalid route", errors);
  }
}

/* ---------------- controllers ---------------- */

@Controller("environments/:envId/services")
export class ServicesController {
  constructor(private readonly gw: GatewayService) {}

  @Get()
  @RequiredRole("viewer")
  list(@Param("envId", uuidParam()) envId: string, @Query() query: Record<string, unknown>) {
    return this.gw.listServices(envId, query);
  }

  @Post()
  @RequiredRole("editor")
  create(@Ctx() ctx: RequestContext, @Param("envId", uuidParam()) envId: string, @Body(contractBody("ServiceWrite")) body: ServiceWrite) {
    return this.gw.createService(ctx, envId, body);
  }

  @Get(":serviceId")
  @RequiredRole("viewer")
  get(@Param("envId", uuidParam()) envId: string, @Param("serviceId", uuidParam()) serviceId: string) {
    return this.gw.getService(envId, serviceId);
  }

  @Put(":serviceId")
  @RequiredRole("editor")
  replace(
    @Ctx() ctx: RequestContext,
    @Param("envId", uuidParam()) envId: string,
    @Param("serviceId", uuidParam()) serviceId: string,
    @Body(contractBody("ServiceWrite")) body: ServiceWrite,
  ) {
    return this.gw.replaceService(ctx, envId, serviceId, body);
  }

  @Delete(":serviceId")
  @HttpCode(204)
  @RequiredRole("editor")
  async remove(@Ctx() ctx: RequestContext, @Param("envId", uuidParam()) envId: string, @Param("serviceId", uuidParam()) serviceId: string) {
    await this.gw.deleteService(ctx, envId, serviceId);
  }
}

@Controller("environments/:envId/routes")
export class RoutesController {
  constructor(private readonly gw: GatewayService) {}

  @Get()
  @RequiredRole("viewer")
  list(@Param("envId", uuidParam()) envId: string, @Query() query: Record<string, unknown>) {
    return this.gw.listRoutes(envId, query);
  }

  @Post()
  @RequiredRole("editor")
  create(@Ctx() ctx: RequestContext, @Param("envId", uuidParam()) envId: string, @Body(contractBody("RouteWrite")) body: RouteWrite) {
    return this.gw.createRoute(ctx, envId, body);
  }

  @Get(":routeId")
  @RequiredRole("viewer")
  get(@Param("envId", uuidParam()) envId: string, @Param("routeId", uuidParam()) routeId: string) {
    return this.gw.getRoute(envId, routeId);
  }

  @Put(":routeId")
  @RequiredRole("editor")
  replace(
    @Ctx() ctx: RequestContext,
    @Param("envId", uuidParam()) envId: string,
    @Param("routeId", uuidParam()) routeId: string,
    @Body(contractBody("RouteWrite")) body: RouteWrite,
  ) {
    return this.gw.replaceRoute(ctx, envId, routeId, body);
  }

  @Delete(":routeId")
  @HttpCode(204)
  @RequiredRole("editor")
  async remove(@Ctx() ctx: RequestContext, @Param("envId", uuidParam()) envId: string, @Param("routeId", uuidParam()) routeId: string) {
    await this.gw.deleteRoute(ctx, envId, routeId);
  }
}

/* ---------------- control-plane-v2: the same services, scoped to a workspace (decision H-9) ---------------- */

/** The workspace is the environment with the same id (N1-X1); a service balances through its host until N2. */
const toWorkspaceService = (envId: string, s: ReturnType<typeof toService>) => ({ ...s, workspaceId: envId, upstreamId: null });
const toWorkspaceRoute = (r: RouteRow) => ({ ...toRoute(r), pathCompatibility: r.pathCompatibility });

@Controller("api/v2/workspaces/:workspaceId/services")
export class WorkspaceServicesController {
  constructor(private readonly gw: GatewayService) {}

  @Get()
  @RequiredPermission("workspace.read", "workspace")
  async list(@Param("workspaceId", uuidParam()) workspaceId: string, @Query() query: Record<string, unknown>) {
    const page = await this.gw.listServices(workspaceId, query);
    return { ...page, items: page.items.map((s) => toWorkspaceService(workspaceId, s)) };
  }

  @Get(":serviceId")
  @RequiredPermission("workspace.read", "workspace")
  async get(@Param("workspaceId", uuidParam()) workspaceId: string, @Param("serviceId", uuidParam()) serviceId: string) {
    return toWorkspaceService(workspaceId, await this.gw.getService(workspaceId, serviceId));
  }

  @Delete(":serviceId")
  @HttpCode(204)
  @RequiredPermission("gateway.write", "workspace")
  async remove(@Ctx() ctx: RequestContext, @Param("workspaceId", uuidParam()) workspaceId: string, @Param("serviceId", uuidParam()) serviceId: string) {
    await this.gw.deleteService(ctx, workspaceId, serviceId, { keepPlugins: true });
  }
}

@Controller("api/v2/workspaces/:workspaceId/routes")
export class WorkspaceRoutesController {
  constructor(private readonly gw: GatewayService) {}

  @Get()
  @RequiredPermission("workspace.read", "workspace")
  list(@Param("workspaceId", uuidParam()) workspaceId: string, @Query() query: Record<string, unknown>) {
    return this.gw.listRoutes(workspaceId, query, toWorkspaceRoute);
  }

  @Get(":routeId")
  @RequiredPermission("workspace.read", "workspace")
  get(@Param("workspaceId", uuidParam()) workspaceId: string, @Param("routeId", uuidParam()) routeId: string) {
    return this.gw.getRoute(workspaceId, routeId, toWorkspaceRoute);
  }

  @Delete(":routeId")
  @HttpCode(204)
  @RequiredPermission("gateway.write", "workspace")
  async remove(@Ctx() ctx: RequestContext, @Param("workspaceId", uuidParam()) workspaceId: string, @Param("routeId", uuidParam()) routeId: string) {
    await this.gw.deleteRoute(ctx, workspaceId, routeId);
  }
}

@Module({ controllers: [ServicesController, RoutesController, WorkspaceServicesController, WorkspaceRoutesController], providers: [GatewayService] })
export class GatewayModule {}
