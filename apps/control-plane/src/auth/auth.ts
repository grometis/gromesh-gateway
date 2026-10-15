import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  HttpStatus,
  Injectable,
  SetMetadata,
} from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";
import { Reflector } from "@nestjs/core";
import type { Request, Response } from "express";
import type { Actor, UserRow } from "../db/schema.js";
import { ProblemException } from "../common/problem.js";
import { sessionCookie, SessionService } from "./sessions.js";

export type Role = "viewer" | "editor" | "admin";
const RANK: Record<Role, number> = { viewer: 1, editor: 2, admin: 3 };

export interface RequestContext {
  actor: Actor;
  ip: string | null;
  role: Role;
}

/** What the guard attaches to an authenticated request. */
export interface AuthenticatedRequest extends Request {
  user?: UserRow;
  session?: { idHash: string; csrfToken: string };
}

const ROLE_KEY = "gromesh:required-role";
export const CSRF_HEADER = "x-csrf-token";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Mirrors `x-required-role` in the contract. Every handler must declare one. */
export const RequiredRole = (role: Role) => SetMetadata(ROLE_KEY, role);

/** Explicitly unauthenticated endpoints (health probes, login, the agent protocol with its own guard). */
export const Public = () => SetMetadata(ROLE_KEY, "public");

/**
 * Session cookie → user, then the contract's role ladder. Mutations additionally need the session's CSRF
 * token in `X-CSRF-Token` (double submit: the browser sends the cookie on its own, only our client the header).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<Role | "public" | undefined>(ROLE_KEY, [context.getHandler(), context.getClass()]);
    if (required === "public") return true;
    if (!required) {
      // Fail closed: a handler without RequiredRole is a bug, not a public endpoint.
      throw new ProblemException(HttpStatus.FORBIDDEN, "Endpoint has no role requirement");
    }
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const id = sessionCookie(req.headers.cookie);
    const session = id ? await this.sessions.resolve(id) : null;
    if (!session) throw new ProblemException(HttpStatus.UNAUTHORIZED, "Authentication required");
    if (!SAFE_METHODS.has(req.method) && !sameToken(req.header(CSRF_HEADER), session.csrfToken)) {
      throw new ProblemException(HttpStatus.FORBIDDEN, "CSRF token missing or invalid");
    }
    if (RANK[session.user.role] < RANK[required]) throw new ProblemException(HttpStatus.FORBIDDEN, `Requires role ${required}`);
    // A slid expiry goes back to the browser, so the cookie's own Max-Age slides with it.
    if (session.renewed && id) context.switchToHttp().getResponse<Response>().setHeader("Set-Cookie", this.sessions.cookie(id));
    req.user = session.user;
    req.session = { idHash: session.idHash, csrfToken: session.csrfToken };
    return true;
  }
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
  return { actor: { type: "user", id: req.user.id, name: req.user.name }, ip: req.ip ?? null, role: req.user.role };
});
