import { Body, Controller, Delete, Get, HttpCode, Inject, Injectable, Module, Param, Post, Put, Query } from "@nestjs/common";
import type { GatewayState, Route, Service } from "@gromesh/compiler";
import { and, asc, count, eq, gt, ilike, or, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { RouteWrite, ServiceWrite } from "../api-types.js";
import { audit } from "../audit/audit.js";
import { Ctx, RequiredRole, type RequestContext } from "../auth/auth.js";
import { contractBody } from "../common/contract.js";
import { decodeCursor, parseLimit, toPage } from "../common/pagination.js";
import { conflict, notFound, unprocessable } from "../common/problem.js";
import { DB, type Db, type Executor } from "../db/db.js";
import { consumerValues, keyAuthValues } from "../consumers/consumers.js";
import { consumers, keyAuthCredentials, plugins, routes, services, type RouteRow, type ServiceRow } from "../db/schema.js";
import { pluginValues } from "../plugins/plugins.js";
import { markDraftChanged, requireEnvironment, uuidParam } from "../environments/environments.js";

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
    tags: r.tags,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  });
}

function serviceValues(body: ServiceWrite | Service) {
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

function routeValues(body: RouteWrite | Route) {
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
export async function loadGatewayState(tx: Executor, envId: string): Promise<GatewayState> {
  const [svcRows, routeRows, consumerRows, keyRows, pluginRows] = await Promise.all([
    tx.select().from(services).where(eq(services.environmentId, envId)),
    tx.select().from(routes).where(eq(routes.environmentId, envId)),
    tx.select().from(consumers).where(eq(consumers.environmentId, envId)),
    tx.select().from(keyAuthCredentials).where(eq(keyAuthCredentials.environmentId, envId)),
    tx.select().from(plugins).where(eq(plugins.environmentId, envId)),
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
    consumers: consumerRows.map((c) => ({ id: c.id, username: c.username, customId: c.customId, tags: c.tags })),
    keyAuthCredentials: keyRows.map((k) => ({ id: k.id, consumerId: k.consumerId, key: k.key, tags: k.tags })),
    plugins: pluginRows.map((p) => ({
      id: p.id,
      name: p.name,
      enabled: p.enabled,
      scope: { serviceId: p.serviceId, routeId: p.routeId, consumerId: p.consumerId },
      config: p.config,
      protocols: optional(p.protocols),
      tags: p.tags,
    })),
  };
}

/** Replaces the environment's draft with `state`, keeping entity ids (rollback). */
export async function restoreGatewayState(tx: Executor, envId: string, state: GatewayState): Promise<void> {
  // Dependents first: plugins and credentials reference the rest, routes reference services (ON DELETE RESTRICT).
  await tx.delete(plugins).where(eq(plugins.environmentId, envId));
  await tx.delete(keyAuthCredentials).where(eq(keyAuthCredentials.environmentId, envId));
  await tx.delete(routes).where(eq(routes.environmentId, envId));
  await tx.delete(consumers).where(eq(consumers.environmentId, envId));
  await tx.delete(services).where(eq(services.environmentId, envId));
  if (state.services.length > 0) {
    await tx.insert(services).values(state.services.map((s) => ({ id: s.id, environmentId: envId, ...serviceValues(s) })));
  }
  if (state.routes.length > 0) {
    await tx.insert(routes).values(state.routes.map((r) => ({ id: r.id, environmentId: envId, ...routeValues(r) })));
  }
  if (state.consumers.length > 0) {
    await tx.insert(consumers).values(state.consumers.map((c) => ({ id: c.id, environmentId: envId, ...consumerValues(c) })));
  }
  if (state.keyAuthCredentials.length > 0) {
    await tx
      .insert(keyAuthCredentials)
      .values(state.keyAuthCredentials.map((k) => ({ id: k.id, environmentId: envId, ...keyAuthValues(k) })));
  }
  if (state.plugins.length > 0) {
    await tx.insert(plugins).values(state.plugins.map((p) => ({ id: p.id, environmentId: envId, ...pluginValues(p) })));
  }
}

/* ---------------- service ---------------- */

@Injectable()
export class GatewayService {
  constructor(@Inject(DB) private readonly db: Db) {}

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

  async deleteService(ctx: RequestContext, envId: string, serviceId: string) {
    await this.db.transaction(async (tx) => {
      const before = toService(await this.requireService(tx, envId, serviceId));
      const [ref] = await tx.select({ n: count() }).from(routes).where(eq(routes.serviceId, serviceId));
      if (ref && ref.n > 0) throw conflict(`Service is used by ${ref.n} route(s); delete them first`);
      await tx.delete(services).where(eq(services.id, serviceId));
      await markDraftChanged(tx, envId);
      await audit(tx, ctx, { action: "service.delete", entityType: "service", entityId: serviceId, environmentId: envId, before });
    });
  }

  /* routes */

  async listRoutes(envId: string, query: Record<string, unknown>) {
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
    return toPage(rows, limit, (r) => r.name, toRoute);
  }

  async getRoute(envId: string, routeId: string) {
    return toRoute(await this.requireRoute(this.db, envId, routeId));
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

  private async requireService(tx: Executor, envId: string, serviceId: string): Promise<ServiceRow> {
    const [row] = await tx
      .select()
      .from(services)
      .where(and(eq(services.id, serviceId), eq(services.environmentId, envId)));
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
    const hasMatcher =
      (body.paths?.length ?? 0) > 0 ||
      (body.hosts?.length ?? 0) > 0 ||
      (body.methods?.length ?? 0) > 0 ||
      Object.keys(body.headers ?? {}).length > 0;
    if (!hasMatcher) errors.push({ path: "(body)", message: "must define at least one of paths, hosts, methods or headers" });
    body.paths?.forEach((p, i) => {
      if (!p.startsWith("/") && !p.startsWith("~/")) errors.push({ path: `paths.${i}`, message: "must start with '/' (or '~/' for a regex)" });
    });
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

@Module({ controllers: [ServicesController, RoutesController], providers: [GatewayService] })
export class GatewayModule {}
