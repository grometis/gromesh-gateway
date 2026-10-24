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
import { environmentAccess, lower, RANK, type Role } from "./environment-access.js";
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

export type { Role } from "./environment-access.js";

export interface RequestContext {
  actor: Actor;
  ip: string | null;
  role: Role;
  /** Global role admin, and through a token also the token's role: an environment admin is not the platform admin. */
  platformAdmin?: boolean;
}

/** What the guard attaches to an authenticated request. */
export interface AuthenticatedRequest extends Request {
  user?: UserRow;
  session?: { idHash: string; csrfToken: string };
  /** How the request authenticated: a session, or an API token (then the effective role is capped by it). */
  auth?: ({ via: "session" } | { via: "token"; tokenId: string; tokenName: string }) & { role: Role };
}

const ROLE_KEY = "gromesh:required-role";
const SESSION_ONLY_KEY = "gromesh:session-only";
export const CSRF_HEADER = "x-csrf-token";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Mirrors `x-required-role` in the contract. Every handler must declare one. */
export const RequiredRole = (role: Role) => SetMetadata(ROLE_KEY, role);

/** Explicitly unauthenticated endpoints (health probes, login, the agent protocol with its own guard). */
export const Public = () => SetMetadata(ROLE_KEY, "public");

/** Operations an API token may not call (token and user management, the session itself): a session only. */
export const SessionOnly = () => SetMetadata(SESSION_ONLY_KEY, true);

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
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<Role | "public" | undefined>(ROLE_KEY, [context.getHandler(), context.getClass()]);
    if (required === "public") return true;
    if (!required) {
      // Fail closed: a handler without RequiredRole is a bug, not a public endpoint.
      throw new ProblemException(HttpStatus.FORBIDDEN, "Endpoint has no role requirement");
    }
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = req.header("authorization");
    if (authorization !== undefined) {
      const sessionOnly = this.reflector.getAllAndOverride<boolean | undefined>(SESSION_ONLY_KEY, [context.getHandler(), context.getClass()]);
      if (sessionOnly) throw new ProblemException(HttpStatus.UNAUTHORIZED, "This operation requires a session, not an API token");
      const bearer = /^Bearer\s+(\S+)$/i.exec(authorization)?.[1] ?? "";
      // An unparsable value is resolved as any other invalid token: same answer, same failure counter.
      const resolved = await this.tokens.resolve(TOKEN_PATTERN.test(bearer) ? bearer : "ggt_invalid", clientAddress(req));
      if (!resolved) throw new ProblemException(HttpStatus.UNAUTHORIZED, "Invalid or expired API token");
      const access = await environmentAccess(this.db, resolved.user, req.params);
      const role = access ? lower(resolved.token.role, access.role) : resolved.role;
      if (!atLeast(role, required)) throw new ProblemException(HttpStatus.FORBIDDEN, `Requires role ${required}`);
      req.user = resolved.user;
      req.auth = { via: "token", tokenId: resolved.token.id, tokenName: resolved.token.name, role };
      return true;
    }
    const id = sessionCookie(req.headers.cookie);
    const session = id ? await this.sessions.resolve(id) : null;
    if (!session) throw new ProblemException(HttpStatus.UNAUTHORIZED, "Authentication required");
    if (!SAFE_METHODS.has(req.method) && !sameToken(req.header(CSRF_HEADER), session.csrfToken)) {
      throw new ProblemException(HttpStatus.FORBIDDEN, "CSRF token missing or invalid");
    }
    const access = await environmentAccess(this.db, session.user, req.params);
    const role = access?.role ?? session.user.role;
    if (!atLeast(role, required)) throw new ProblemException(HttpStatus.FORBIDDEN, `Requires role ${required}`);
    // A slid expiry goes back to the browser, so the cookie's own Max-Age slides with it.
    if (session.renewed && id) context.switchToHttp().getResponse<Response>().setHeader("Set-Cookie", this.sessions.cookie(id));
    req.user = session.user;
    req.session = { idHash: session.idHash, csrfToken: session.csrfToken };
    req.auth = { via: "session", role };
    return true;
  }
}

/** Fail closed: a role the ladder does not know (a malformed row, say) never passes. */
function atLeast(role: Role, required: Role): boolean {
  return RANK[role] >= RANK[required];
}

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
  const platformAdmin = user.role === "admin" && role === "admin";
  if (req.auth?.via === "token") {
    return { actor: { type: "user", id: user.id, name: user.name, via: "token", tokenId: req.auth.tokenId, tokenName: req.auth.tokenName }, ip: clientAddress(req), role, platformAdmin };
  }
  return { actor: { type: "user", id: user.id, name: user.name }, ip: clientAddress(req), role, platformAdmin };
}
