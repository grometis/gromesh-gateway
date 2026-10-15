import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
  SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import type { Actor } from "../db/schema.js";
import { ProblemException } from "../common/problem.js";
import { APP_CONFIG, type AppConfig } from "../config.js";

export type Role = "viewer" | "editor" | "admin";
const RANK: Record<Role, number> = { viewer: 1, editor: 2, admin: 3 };

export interface AuthUser {
  id: string;
  name: string;
  role: Role;
}

export interface RequestContext {
  actor: Actor;
  ip: string | null;
  role: Role;
}

const ROLE_KEY = "gromesh:required-role";

/** Mirrors `x-required-role` in the contract. Every handler must declare one. */
export const RequiredRole = (role: Role) => SetMetadata(ROLE_KEY, role);

/** Explicitly unauthenticated endpoints (health probes, login). */
export const Public = () => SetMetadata(ROLE_KEY, "public");

/**
 * Temporary until week 5: AUTH_MODE=dev runs requests as a built-in admin.
 * W5 replaces `resolveUser` with real authentication; the role check below stays as is.
 */
export const DEV_USER = {
  id: "00000000-0000-4000-8000-000000000001", name: "Dev Admin", role: "admin" as const,
  email: "admin@gromesh.dev", active: true,
  createdAt: "2026-10-15T00:00:00.000Z", updatedAt: "2026-10-15T00:00:00.000Z",
};

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, @Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role | "public" | undefined>(ROLE_KEY, [context.getHandler(), context.getClass()]);
    if (required === "public") return true;
    if (!required) {
      // Fail closed: a handler without RequiredRole is a bug, not a public endpoint.
      throw new ProblemException(HttpStatus.FORBIDDEN, "Endpoint has no role requirement");
    }
    const req = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const user = this.resolveUser(req);
    if (!user) throw new ProblemException(HttpStatus.UNAUTHORIZED, "Authentication required");
    if (RANK[user.role] < RANK[required]) throw new ProblemException(HttpStatus.FORBIDDEN, `Requires role ${required}`);
    req.user = user;
    return true;
  }

  private resolveUser(_req: Request): AuthUser | null {
    return this.config.authMode === "dev" ? DEV_USER : null;
  }
}

/** Who did it and from where — passed to services for the audit log. */
export const Ctx = createParamDecorator((_data: unknown, context: ExecutionContext): RequestContext => {
  const req = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
  const user = req.user ?? DEV_USER;
  return { actor: { type: "user", id: user.id, name: user.name }, ip: req.ip ?? null, role: user.role };
});
