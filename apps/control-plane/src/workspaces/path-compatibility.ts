import { createHash } from "node:crypto";
import { Body, Controller, HttpCode, Inject, Injectable, Module, Param, Post } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { RequiredPermission, SessionOnly } from "../auth/auth.js";
import { contractBodyV2, inlineBody } from "../common/contract.js";
import { conflict, notFound, unprocessable } from "../common/problem.js";
import { DB, type Db } from "../db/db.js";
import { routes, services, workspaces } from "../db/schema.js";
import { uuidParam } from "../environments/environments.js";
import { backfillWorkspaces } from "./workspaces.js";

interface ConversionRequest {
  dryRun: boolean;
  expectedDiffDigest?: string;
}

/**
 * The path Kong 3.9 sends upstream with path_handling v0 (its default; the compiler sets no other): the service path
 * and what is left of the request (all of it, or what follows the matched path when stripped) joined with one slash,
 * the request's trailing slash kept. Checked against Kong itself (kong-3.9-path-handling-v0.json).
 */
export function kongUpstreamPath(servicePath: string | null, requestPath: string, stripped: string): string {
  const base = servicePath ?? "/";
  const postfix = requestPath.slice(stripped.length);
  if (base === "/") return postfix.startsWith("/") ? postfix : `/${postfix}`;
  // The root request leaves the service path as it is; a request stripped whole ends as the request does.
  if (requestPath === "/") return base;
  if (postfix === "") return `${base.replace(/\/+$/, "")}${requestPath.endsWith("/") ? "/" : ""}`;
  if (postfix.startsWith("/")) return base.endsWith("/") ? base + postfix.slice(1) : base + postfix;
  return base.endsWith("/") ? base + postfix : `${base}/${postfix}`;
}

// What follows the route's path in a request; a character no path holds, shown as {rest}.
const REST = "\u0000";
const show = (v: string) => v.replaceAll(REST, "{rest}");

/** The request exactly at the path, then one going on past it. */
function samples(servicePath: string | null, path: string, strip: boolean, publicPath: string): string {
  const rest = path.endsWith("/") ? REST : `/${REST}`;
  return [path, path + rest]
    .map((request) => {
      const prefixed = publicPath + request.slice(path.length);
      return `${show(strip ? request : prefixed)} -> ${show(kongUpstreamPath(servicePath, strip ? request : prefixed, strip ? path : ""))}`;
    })
    .join("; ");
}

/**
 * What converting a legacy-preserved route to the workspace default (decision D1) changes, path by path: today the
 * upstream receives what its strip_path gives; in the workspace default the public path is /<slug><path> (a regex
 * ~/<slug>(?:<regex>)) and the full path, prefix included, reaches the upstream (stripPath false). A regex matches a
 * sequence only the request decides: {match} is it, {rest} what follows. The digest covers everything the paths
 * depend on (the route's paths and stripPath, its service's path and the slug), so any change to them changes it.
 */
export function routePathDiff(route: { id: string; paths: string[] | null; stripPath: boolean; pathCompatibility: string }, service: { id: string; path: string | null }, slug: string) {
  const join = (base: string | null, tail: string) => `${(base ?? "/").replace(/\/+$/, "")}${tail}`;
  const paths = (route.paths ?? []).map((p) => {
    if (p.startsWith("~")) {
      const publicPath = `~/${slug}(?:${p.slice(1)})`;
      return {
        publicPath,
        upstreamBefore: `${p}: {match}{rest} -> ${route.stripPath ? join(service.path, "/{rest}") : join(service.path, "{match}{rest}")}`,
        upstreamAfter: `${publicPath}: /${slug}{match}{rest} -> ${join(service.path, `/${slug}{match}{rest}`)}`,
      };
    }
    const publicPath = `/${slug}${p}`;
    return { publicPath, upstreamBefore: samples(service.path, p, route.stripPath, p), upstreamAfter: samples(service.path, p, false, publicPath) };
  });
  const inputs = { routeId: route.id, paths: route.paths ?? [], stripPath: route.stripPath, serviceId: service.id, servicePath: service.path, slug };
  const diffDigest = `sha256:${createHash("sha256").update(JSON.stringify({ inputs, paths })).digest("hex")}`;
  return { routeId: route.id, pathCompatibility: route.pathCompatibility as "legacy-preserved" | "workspace-default", diffDigest, paths };
}

@Injectable()
export class PathCompatibilityService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * The dry run is the inventory of a route: what its paths reach today and in the workspace default. The conversion
   * itself waits for the workspace composition (N2): until then no data plane carries the prefix, so a converted
   * route would publish neither what it does today nor what the diff shows (stripPath false without the prefix).
   * Every route keeps its traffic; the request is refused with nothing changed.
   */
  async convert(workspaceId: string, routeId: string, body: ConversionRequest) {
    // The prefix is the slug: a workspace an older replica created without one gets it now (N1-X1).
    await this.db.transaction((tx) => backfillWorkspaces(tx));
    const [row] = await this.db
      .select({ route: routes, service: { id: services.id, path: services.path }, slug: workspaces.slug })
      .from(routes)
      .innerJoin(services, eq(services.id, routes.serviceId))
      .innerJoin(workspaces, eq(workspaces.id, routes.environmentId))
      .where(and(eq(routes.id, routeId), eq(routes.environmentId, workspaceId)));
    if (!row) throw notFound("Route");
    const diff = routePathDiff(row.route, row.service, row.slug!);
    if (body.dryRun) return diff;
    if (row.route.pathCompatibility === "workspace-default") throw conflict("The route is already in the workspace default");
    if (!row.route.paths || row.route.paths.length === 0) throw unprocessable("Invalid route", [{ path: "paths", message: "a route without a path cannot take the workspace prefix; give it one first" }]);
    if (body.expectedDiffDigest !== diff.diffDigest) throw conflict("The route changed since the dry run: run it again");
    throw conflict("The conversion takes effect with the workspace composition (N2); until then the route keeps its traffic");
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
    @Param("workspaceId", uuidParam()) workspaceId: string,
    @Param("routeId", uuidParam()) routeId: string,
    @Body(contractBodyV2(inlineBody("/workspaces/{workspaceId}/routes/{routeId}/path-compatibility", "post"))) body: ConversionRequest,
  ) {
    return this.paths.convert(workspaceId, routeId, body);
  }
}

@Module({ controllers: [PathCompatibilityController], providers: [PathCompatibilityService] })
export class PathCompatibilityModule {}
