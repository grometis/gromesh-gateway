import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
  SetMetadata,
} from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";
import { Reflector } from "@nestjs/core";
import type { Request, Response } from "express";
import type { Actor, UserRow } from "../db/schema.js";
import { clientAddress } from "../common/client-address.js";
import { ProblemException } from "../common/problem.js";
import { DB, type Db } from "../db/db.js";
import { effectiveRole, environmentOf, lower, RANK, type Role } from "./environment-access.js";
import { notFound } from "../common/problem.js";
import { and, eq } from "drizzle-orm";
import { environmentRoles, roleBindings } from "../db/schema.js";
import { type Held, type Permission, permissionsIn, requiredPermission, type Scope, tokenPermissions, v1BindingById, workspaceExists } from "./permissions.js";
import { sessionCookie, SessionService } from "./sessions.js";

/** `ggt_` plus 32 random bytes in unpadded base64url (43 characters), as the contract's pattern says. */
export const TOKEN_PATTERN = /^ggt_[A-Za-z0-9_-]{43}$/;

/** What a bearer token resolves to: the owner, the token, and the lower of the two roles. */
export interface ResolvedBearer {
  user: UserRow;
  token: { id: string; name: string; role: Role };
  role: Role;
}

/** Provided by the tokens module; injected by symbol so the guard does not import it (no module cycle). */
export const BEARER_RESOLVER = Symbol("BEARER_RESOLVER");
export interface BearerResolver {
  resolve(bearer: string, ip: string | null): Promise<ResolvedBearer | null>;
}

/** Counts the calls to the v1 operations the controlled migration will cut (decision H-9; src/instance). */
export const API_V1_USAGE = Symbol("API_V1_USAGE");
export interface ApiV1UsageRecorder {
  /** A token call it counts, from before its authentication until `end`: no confirmation passes it. */
  begin(): symbol;
  end(call: symbol): void;
  /** In memory, never the database: the call goes on whatever happens to its count. null: a session (the UI). */
  record(token: { id: string; name: string; ownerId: string } | null): void;
}

/**
 * The v1 operations the cut reaches: those under /environments/{envId} and /clusters/{clusterId} (their route has the
 * parameter), and GET and POST /environments.
 */
function cutByMigration(req: Request): boolean {
  if (typeof req.params.envId === "string" || typeof req.params.clusterId === "string") return true;
  const route = (req as Request & { route?: { path?: unknown } }).route?.path;
  return route === "/api/v1/environments" && (req.method === "GET" || req.method === "POST");
}

export type { Role } from "./environment-access.js";

export interface RequestContext {
  actor: Actor;
  ip: string | null;
  role: Role;
  /**
   * Holds platform.admin where the operation runs (a global admin, or a platform-admin binding of the instance), capped
   * by the token: the admin of an environment or of a Workspace is not the platform admin.
   */
  platformAdmin?: boolean;
}

/** What the guard attaches to an authenticated request. */
export interface AuthenticatedRequest extends Request {
  user?: UserRow;
  session?: { idHash: string; csrfToken: string };
  /** How the request authenticated: a session, or an API token (then the effective role is capped by it). */
  auth?: ({ via: "session" } | { via: "token"; tokenId: string; tokenName: string; tokenRole: Role }) & { role: Role; permissions: ReadonlySet<Held> };
}

const ROLE_KEY = "gromesh:required-role";
const SESSION_ONLY_KEY = "gromesh:session-only";
const PERMISSION_KEY = "gromesh:required-permission";
const V1_PERMISSION_KEY = "gromesh:v1-permission";
export const CSRF_HEADER = "x-csrf-token";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Mirrors `x-required-role` in the contract. Every handler must declare one. */
export const RequiredRole = (role: Role) => SetMetadata(ROLE_KEY, role);

/** Explicitly unauthenticated endpoints (health probes, login, the agent protocol with its own guard). */
export const Public = () => SetMetadata(ROLE_KEY, "public");

/** Operations an API token may not call (token and user management, the session itself): a session only. */
export const SessionOnly = () => SetMetadata(SESSION_ONLY_KEY, true);

/** v2: mirrors `x-required-permission` and `x-scope` (where the permission is checked) in control-plane-v2. */
export type PermissionScope = "instance" | "workspace" | "binding";
export const RequiredPermission = (permission: Permission, scope: PermissionScope) => SetMetadata(PERMISSION_KEY, { permission, scope });

/**
 * v1: the permission an operation needs when it is not the default for its role, any of them (publishing needs
 * release.publish, rolling back release.rollback, deleting an environment platform.admin, its clusters platform
 * administration or the v1 admin of that environment).
 */
export const V1Permission = (...anyOf: Held[]) => SetMetadata(V1_PERMISSION_KEY, anyOf);

/**
 * Session cookie → user, then the contract's role ladder. Mutations additionally need the session's CSRF
 * token in `X-CSRF-Token` (double submit: the browser sends the cookie on its own, only our client the header).
 * `Authorization: Bearer ggt_…` is an API token: it is used alone (any cookie is ignored), needs no CSRF token
 * because a browser never sends it on its own, and acts with the lower of its role and its owner's current role.
 * On a route of one environment (`{envId}`, or a cluster's) the owner's role is the effective one there: the
 * environment's role when set, else the global one; an environment the user may not see answers 404.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    @Inject(BEARER_RESOLVER) private readonly tokens: BearerResolver,
    @Inject(DB) private readonly db: Db,
    @Inject(API_V1_USAGE) private readonly usage: ApiV1UsageRecorder,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const meta = <T>(key: string) => this.reflector.getAllAndOverride<T | undefined>(key, [context.getHandler(), context.getClass()]);
    const required = meta<Role | "public">(ROLE_KEY);
    const v2 = meta<{ permission: Permission; scope: PermissionScope }>(PERMISSION_KEY);
    if (required === "public") return true;
    if (!required && !v2) {
      // Fail closed: a handler without RequiredRole or RequiredPermission is a bug, not a public endpoint.
      throw new ProblemException(HttpStatus.FORBIDDEN, "Endpoint has no role requirement");
    }
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    // Counted once the caller is known, whatever the decision (a call refused, even for a token on a session-only
    // operation, still depends on v1).
    const counted = !v2 && cutByMigration(req);
    // A token call the cut depends on is tracked from before its authentication: the counting never confirms past it.
    const call = counted && req.header("authorization") !== undefined ? this.usage.begin() : undefined;
    let caller: Awaited<ReturnType<AuthGuard["authenticate"]>>;
    try {
      caller = await this.authenticate(context, req, meta<boolean>(SESSION_ONLY_KEY) === true, counted);
      if (counted) this.usage.record(caller.token ? { id: caller.token.id, name: caller.token.name, ownerId: caller.user.id } : null);
    } finally {
      if (call) this.usage.end(call);
    }
    const decision = v2 ? await this.decideV2(caller, v2, req.params) : await this.decideV1(caller, required as Role, meta<Held[]>(V1_PERMISSION_KEY), req.params);
    req.user = caller.user;
    req.auth = caller.token ? { via: "token", tokenId: caller.token.id, tokenName: caller.token.name, tokenRole: caller.token.role, ...decision } : { via: "session", ...decision };
    if (caller.session) req.session = { idHash: caller.session.idHash, csrfToken: caller.session.csrfToken };
    return true;
  }

  /** A bearer token (alone, no CSRF) or the session cookie with its CSRF token on mutations. */
  private async authenticate(context: ExecutionContext, req: AuthenticatedRequest, sessionOnly: boolean, counted: boolean) {
    const authorization = req.header("authorization");
    if (authorization !== undefined) {
      if (sessionOnly && !counted) throw new ProblemException(HttpStatus.UNAUTHORIZED, "This operation requires a session, not an API token");
      const bearer = /^Bearer\s+(\S+)$/i.exec(authorization)?.[1] ?? "";
      // An unparsable value is resolved as any other invalid token: same answer, same failure counter.
      const resolved = await this.tokens.resolve(TOKEN_PATTERN.test(bearer) ? bearer : "ggt_invalid", clientAddress(req));
      if (!resolved) throw new ProblemException(HttpStatus.UNAUTHORIZED, "Invalid or expired API token");
      if (sessionOnly) {
        // The token is known now: its call counts before the refusal.
        this.usage.record({ id: resolved.token.id, name: resolved.token.name, ownerId: resolved.user.id });
        throw new ProblemException(HttpStatus.UNAUTHORIZED, "This operation requires a session, not an API token");
      }
      return { user: resolved.user, token: resolved.token, session: null };
    }
    const id = sessionCookie(req.headers.cookie);
    const session = id ? await this.sessions.resolve(id) : null;
    if (!session) throw new ProblemException(HttpStatus.UNAUTHORIZED, "Authentication required");
    if (!SAFE_METHODS.has(req.method) && !sameToken(req.header(CSRF_HEADER), session.csrfToken)) {
      throw new ProblemException(HttpStatus.FORBIDDEN, "CSRF token missing or invalid");
    }
    // A slid expiry goes back to the browser, so the cookie's own Max-Age slides with it.
    if (session.renewed && id) context.switchToHttp().getResponse<Response>().setHeader("Set-Cookie", this.sessions.cookie(id));
    return { user: session.user, token: null, session };
  }

  /**
   * v1 (decision H-9): the operation's role becomes a permission, checked like any v2 one, in the environment (the
   * workspace) of `{envId}` or of `{clusterId}`, else at instance scope. Without v2 bindings this is exactly the role
   * ladder of the v1 contract; an environment the caller may not read answers 404, as before.
   */
  private async decideV1(caller: Caller, required: Role, override: Held[] | undefined, params: Params) {
    const place = await environmentOf(this.db, params);
    const scope: Scope = place ? { type: "workspace", workspaceId: place.environmentId } : { type: "instance" };
    const owner = await permissionsIn(this.db, caller.user, scope);
    if (place && !owner.has("workspace.read")) throw notFound(place.via === "envId" ? "Environment" : "Cluster");
    const permissions = caller.token ? tokenPermissions(caller.token.role, owner) : owner;
    const needed = override ?? [requiredPermission(required, place !== null)];
    if (!needed.some((p) => permissions.has(p))) throw new ProblemException(HttpStatus.FORBIDDEN, `Requires role ${required}`);
    // The v1 role services still read (masking): the effective one there, capped by the token.
    const own = place ? await this.legacyRole(caller.user, place.environmentId) : caller.user.role;
    return { role: caller.token ? lower(caller.token.role, own) : own, permissions };
  }

  /** v2: the permission in the operation's scope; a workspace (or binding) the caller may not see answers 404. */
  private async decideV2(caller: Caller, { permission, scope }: { permission: Permission; scope: PermissionScope }, params: Params) {
    let where: Scope = { type: "instance" };
    if (scope === "workspace") {
      const workspaceId = typeof params.workspaceId === "string" ? params.workspaceId : "";
      if (!UUID.test(workspaceId) || !(await workspaceExists(this.db, workspaceId))) throw notFound("Workspace");
      where = { type: "workspace", workspaceId };
    } else if (scope === "binding") {
      const bindingId = typeof params.bindingId === "string" ? params.bindingId : "";
      const [binding] = UUID.test(bindingId) ? await this.db.select().from(roleBindings).where(eq(roleBindings.id, bindingId)) : [];
      const v1 = !binding && UUID.test(bindingId) ? await v1BindingById(this.db, bindingId) : undefined;
      if (binding) where = binding.scopeType === "workspace" ? { type: "workspace", workspaceId: binding.workspaceId! } : { type: "instance" };
      else if (v1) where = { type: "workspace", workspaceId: v1.workspaceId };
      else throw notFound("Role binding");
    }
    const owner = await permissionsIn(this.db, caller.user, where);
    if (where.type === "workspace" && !owner.has("workspace.read")) throw notFound(scope === "binding" ? "Role binding" : "Workspace");
    const permissions = caller.token ? tokenPermissions(caller.token.role, owner) : owner;
    if (!permissions.has(permission)) throw new ProblemException(HttpStatus.FORBIDDEN, `Requires permission ${permission}`);
    const own = where.type === "workspace" ? await this.legacyRole(caller.user, where.workspaceId) : caller.user.role;
    return { role: caller.token ? lower(caller.token.role, own) : own, permissions };
  }

  /** The v1 role in a workspace: its override (none counts as viewer for masking: access came from a binding). */
  private async legacyRole(user: UserRow, workspaceId: string): Promise<Role> {
    const [override] = await this.db
      .select({ role: environmentRoles.role })
      .from(environmentRoles)
      .where(and(eq(environmentRoles.userId, user.id), eq(environmentRoles.environmentId, workspaceId)));
    const role = effectiveRole(user, override?.role);
    return role === "none" ? "viewer" : role;
  }
}

type Params = Partial<Record<string, string | string[]>>;
interface Caller {
  user: UserRow;
  token: { id: string; name: string; role: Role } | null;
  session: { idHash: string; csrfToken: string } | null;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Constant-time comparison; a missing header or a different length is simply invalid. */
function sameToken(given: string | undefined, expected: string): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Who did it and from where — passed to services for the audit log. */
export const Ctx = createParamDecorator((_data: unknown, context: ExecutionContext): RequestContext => {
  const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
  if (!req.user) throw new ProblemException(HttpStatus.UNAUTHORIZED, "Authentication required");
  return contextOf(req);
});

/** The audit actor names the token a request came through; the role is the effective one (in the environment, if any). */
export function contextOf(req: AuthenticatedRequest): RequestContext {
  const user = req.user!;
  const role = req.auth?.role ?? user.role;
  const platformAdmin = req.auth?.permissions.has("platform.admin") ?? false;
  if (req.auth?.via === "token") {
    return { actor: { type: "user", id: user.id, name: user.name, via: "token", tokenId: req.auth.tokenId, tokenName: req.auth.tokenName }, ip: clientAddress(req), role, platformAdmin };
  }
  return { actor: { type: "user", id: user.id, name: user.name }, ip: clientAddress(req), role, platformAdmin };
}
