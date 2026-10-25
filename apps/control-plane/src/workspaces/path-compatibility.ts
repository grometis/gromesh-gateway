import { createHash } from "node:crypto";
import { Body, Controller, HttpCode, Inject, Injectable, Module, Param, Post, Res } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import type { Response } from "express";
import { audit } from "../audit/audit.js";
import { Ctx, RequiredPermission, type RequestContext, SessionOnly } from "../auth/auth.js";
import { contractBodyV2, inlineBody } from "../common/contract.js";
import { conflict, notFound, unprocessable } from "../common/problem.js";
import { DB, type Db, type Executor } from "../db/db.js";
import { routes, services, workspaces } from "../db/schema.js";
import { markDraftChanged, requireEnvironment, uuidParam } from "../environments/environments.js";
import { toRoute } from "../gateway/gateway.js";
import { backfillWorkspaces } from "./workspaces.js";

interface ConversionRequest {
  dryRun: boolean;
  expectedDiffDigest?: string;
}

/** Kong's path to the upstream: the service's path, then the request path (stripped of the matched path or not). */
function upstreamPath(servicePath: string | null, requestPath: string, stripped: string): string {
  const rest = requestPath.startsWith(stripped) ? requestPath.slice(stripped.length) : requestPath;
  const base = (servicePath ?? "/").replace(/\/+$/, "");
  const tail = rest === "" ? "" : rest.startsWith("/") ? rest : `/${rest}`;
  return `${base}${tail}` || "/";
}

/**
 * What converting a legacy-preserved route to the workspace default (decision D1) changes, path by path: today the
 * upstream receives what its strip_path gives; in the workspace default the public path carries the workspace prefix
 * and the full path, prefix included, reaches the upstream (stripPath false). A regex path is shown as written.
 */
export function routePathDiff(route: { id: string; paths: string[] | null; stripPath: boolean; pathCompatibility: string }, servicePath: string | null, slug: string) {
  const paths = (route.paths ?? []).map((p) => {
    const regex = p.startsWith("~");
    const publicPath = regex ? `~/${slug}(?:${p.slice(1)})` : `/${slug}${p === "/" ? "" : p}`;
    return {
      publicPath,
      upstreamBefore: regex ? `${route.stripPath ? "(stripped) " : ""}${p}` : upstreamPath(servicePath, p, route.stripPath ? p : ""),
      upstreamAfter: regex ? publicPath : upstreamPath(servicePath, publicPath, ""),
    };
  });
  const diffDigest = `sha256:${createHash("sha256").update(JSON.stringify({ routeId: route.id, paths })).digest("hex")}`;
  return { routeId: route.id, pathCompatibility: route.pathCompatibility as "legacy-preserved" | "workspace-default", diffDigest, paths };
}

@Injectable()
export class PathCompatibilityService {
  constructor(@Inject(DB) private readonly db: Db) {}

  private async load(tx: Executor, workspaceId: string, routeId: string, lock: boolean) {
    const q = tx
      .select({ route: routes, servicePath: services.path, slug: workspaces.slug })
      .from(routes)
      .innerJoin(services, eq(services.id, routes.serviceId))
      .innerJoin(workspaces, eq(workspaces.id, routes.environmentId))
      .where(and(eq(routes.id, routeId), eq(routes.environmentId, workspaceId)));
    const [row] = lock ? await q.for("update", { of: routes }) : await q;
    if (!row) throw notFound("Route");
    return row;
  }

  /**
   * The only way a migrated route becomes the workspace default: explicit, per route, audited, in the draft only (a
   * publication or promotion follows the normal rules). The dry run returns the diff; the conversion must echo its
   * digest, so what changes is what the caller saw.
   */
  async convert(ctx: RequestContext, workspaceId: string, routeId: string, body: ConversionRequest) {
    // The prefix is the slug: a workspace an older replica created without one gets it now (N1-X1).
    await this.db.transaction((tx) => backfillWorkspaces(tx));
    return this.db.transaction(async (tx) => {
      await requireEnvironment(tx, workspaceId, true);
      const { route, servicePath, slug } = await this.load(tx, workspaceId, routeId, !body.dryRun);
      const diff = routePathDiff(route, servicePath, slug!);
      if (body.dryRun) return diff;
      if (route.pathCompatibility === "workspace-default") throw conflict("The route is already in the workspace default");
      if (!route.paths || route.paths.length === 0) throw unprocessable("Invalid route", [{ path: "paths", message: "a route without a path cannot take the workspace prefix; give it one first" }]);
      if (body.expectedDiffDigest !== diff.diffDigest) throw conflict("The route changed since the dry run: run it again");
      const before = toRoute(route);
      const [row] = await tx
        .update(routes)
        .set({ pathCompatibility: "workspace-default", stripPath: false, updatedAt: sql`now()` })
        .where(eq(routes.id, routeId))
        .returning();
      await markDraftChanged(tx, workspaceId);
      await audit(tx, ctx, { action: "route.path_compatibility.convert", entityType: "route", entityId: routeId, environmentId: workspaceId, before: { ...before, pathCompatibility: route.pathCompatibility }, after: { ...toRoute(row!), pathCompatibility: row!.pathCompatibility, diffDigest: diff.diffDigest } });
      return null;
    });
  }
}

@Controller("api/v2/workspaces/:workspaceId/routes/:routeId/path-compatibility")
export class PathCompatibilityController {
  constructor(private readonly paths: PathCompatibilityService) {}

  @Post()
  @HttpCode(200)
  @RequiredPermission("workspace.admin", "workspace")
  @SessionOnly()
  async convert(
    @Ctx() ctx: RequestContext,
    @Param("workspaceId", uuidParam()) workspaceId: string,
    @Param("routeId", uuidParam()) routeId: string,
    @Body(contractBodyV2(inlineBody("/workspaces/{workspaceId}/routes/{routeId}/path-compatibility", "post"))) body: ConversionRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const diff = await this.paths.convert(ctx, workspaceId, routeId, body);
    if (diff === null) res.status(204);
    return diff ?? undefined;
  }
}

@Module({ controllers: [PathCompatibilityController], providers: [PathCompatibilityService] })
export class PathCompatibilityModule {}
