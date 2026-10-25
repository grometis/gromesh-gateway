import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Injectable, Module, Param, Post, Req } from "@nestjs/common";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { audit } from "../audit/audit.js";
import { type AuthenticatedRequest, Ctx, RequiredPermission, type RequestContext, SessionOnly } from "../auth/auth.js";
import { BUILTIN_ROLES, builtinRoleId, type Held, isBuiltinRole, type Permission } from "../auth/permissions.js";
import { contractBodyV2 } from "../common/contract.js";
import { notFound, ProblemException, unprocessable, type FieldError } from "../common/problem.js";
import { DB, type Db } from "../db/db.js";
import { roleBindings, users, type RoleBindingRow } from "../db/schema.js";
import { uuidParam } from "../environments/environments.js";

/** contracts/control-plane-v2.openapi.yaml#/components/schemas/RoleBindingWrite (the core profile of N1). */
interface RoleBindingWrite {
  subjectType: "user" | "group";
  subjectId: string;
  role?: string;
  permissions?: Permission[];
  effect?: "allow" | "deny";
  expiresAt?: string | null;
  justification?: string | null;
}

type BindingScope = { type: "instance" } | { type: "workspace"; workspaceId: string };

/** Never granted inside a workspace: administering the platform is an instance matter. */
const PLATFORM_ONLY: ReadonlySet<Permission> = new Set(["platform.admin", "instance.read", "workspace.create", "groups.manage", "reconcile.execute", "promotion.import"]);
const EMERGENCY_MAX_MS = 7 * 24 * 60 * 60 * 1000;

export function toRoleBinding(r: RoleBindingRow) {
  return {
    id: r.id,
    scope: { type: r.scopeType, workspaceId: r.workspaceId },
    subjectType: r.subjectType,
    subjectId: r.subjectId,
    effect: r.effect,
    // v1-environment-role: written by the v1 environment roles (read-only here); v2: granted through this API.
    origin: r.origin,
    ...(r.role !== null ? { role: r.role } : { permissions: r.permissions ?? [] }),
    expiresAt: r.expiresAt?.toISOString() ?? null,
    justification: r.justification,
    grantedBy: r.grantedBy ?? "",
    createdAt: r.createdAt.toISOString(),
    revokedAt: r.revokedAt?.toISOString() ?? null,
  };
}

const granted = (body: Pick<RoleBindingWrite, "role" | "permissions">): Permission[] =>
  body.role !== undefined && isBuiltinRole(body.role) ? [...BUILTIN_ROLES[body.role]] : [...(body.permissions ?? [])];

@Injectable()
export class AccessService {
  constructor(@Inject(DB) private readonly db: Db) {}

  roles() {
    return Object.entries(BUILTIN_ROLES).map(([name, permissions]) => ({ id: builtinRoleId(name as keyof typeof BUILTIN_ROLES), name, permissions: [...permissions], builtin: true }));
  }

  async list(scope: BindingScope) {
    const rows = await this.db
      .select()
      .from(roleBindings)
      .where(scope.type === "workspace" ? eq(roleBindings.workspaceId, scope.workspaceId) : eq(roleBindings.scopeType, "instance"))
      .orderBy(asc(roleBindings.createdAt), asc(roleBindings.id));
    return rows.map(toRoleBinding);
  }

  /**
   * The core profile: a user (groups are L2), allow (deny is L3, except the migration's), a built-in role (custom
   * roles are L3) or permissions; never more than the caller holds; rollback.emergency only directly to a user, for
   * at most 7 days, with a justification, by platform administration.
   */
  async create(ctx: RequestContext, held: ReadonlySet<Held>, scope: BindingScope, body: RoleBindingWrite) {
    const errors: FieldError[] = [];
    if (body.subjectType !== "user") errors.push({ path: "subjectType", message: "groups arrive in a later phase (L2)" });
    if ((body.effect ?? "allow") !== "allow") errors.push({ path: "effect", message: "deny bindings arrive in a later phase (L3)" });
    if (body.role !== undefined && !isBuiltinRole(body.role)) errors.push({ path: "role", message: "custom roles arrive in a later phase (L3)" });
    const permissions = granted(body);
    const emergency = permissions.includes("rollback.emergency");
    // The core profile: any expiresAt (null included) belongs to a rollback.emergency grant only.
    if ("expiresAt" in body && !emergency) errors.push({ path: "expiresAt", message: "only a rollback.emergency grant expires in this phase (L4)" });
    if (emergency) {
      const until = body.expiresAt ? Date.parse(body.expiresAt) : NaN;
      if (!(until > Date.now() && until - Date.now() <= EMERGENCY_MAX_MS)) errors.push({ path: "expiresAt", message: "must be in the next 7 days" });
    }
    if (scope.type === "workspace") {
      for (const p of permissions) if (PLATFORM_ONLY.has(p)) errors.push({ path: body.role !== undefined ? "role" : "permissions", message: `${p} is not granted inside a workspace` });
    }
    const [subject] = await this.db.select({ id: users.id, active: users.active }).from(users).where(eq(users.id, body.subjectId));
    if (!subject || !subject.active) errors.push({ path: "subjectId", message: "unknown or inactive user" });
    if (errors.length > 0) throw unprocessable("Invalid role binding", [...new Map(errors.map((e) => [`${e.path}\0${e.message}`, e])).values()]);
    // Never more than the caller holds; an emergency grant is platform administration's.
    const missing = permissions.filter((p) => (p === "rollback.emergency" ? !held.has("platform.admin") : !held.has(p)));
    if (missing.length > 0) throw new ProblemException(HttpStatus.FORBIDDEN, `Cannot grant what you do not hold: ${missing.join(", ")}`);
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(roleBindings)
        .values({
          subjectType: "user",
          subjectId: body.subjectId,
          scopeType: scope.type,
          workspaceId: scope.type === "workspace" ? scope.workspaceId : null,
          role: body.role ?? null,
          permissions: body.role === undefined ? permissions : null,
          expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
          justification: body.justification ?? null,
          grantedBy: ctx.actor.id,
          grantedByPlatform: held.has("platform.admin"),
        })
        .returning();
      const after = toRoleBinding(row!);
      await audit(tx, ctx, { action: "role_binding.create", entityType: "role_binding", entityId: after.id, environmentId: after.scope.workspaceId ?? undefined, after });
      return after;
    });
  }

  /**
   * Immediate: the next request of a session or token is decided without it. A binding granted by a platform admin
   * is revoked only by platform administration; anyone else needs members.manage there and every permission it grants.
   */
  async revoke(ctx: RequestContext, held: ReadonlySet<Held>, bindingId: string) {
    await this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(roleBindings).where(eq(roleBindings.id, bindingId)).for("update");
      if (!row) throw notFound("Role binding");
      if (row.revokedAt) return;
      if (row.origin === "v1-environment-role") throw new ProblemException(HttpStatus.FORBIDDEN, "A v1 environment role: change it through the environment roles of the user");
      // Platform administration revokes any grant; anyone else needs every permission it grants, and never one the
      // platform made (fixed when granted, whatever the grantor became since).
      if (!held.has("platform.admin")) {
        if (row.grantedByPlatform) throw new ProblemException(HttpStatus.FORBIDDEN, "Granted by the platform: only platform administration revokes it");
        const missing = granted({ role: row.role ?? undefined, permissions: (row.permissions ?? []) as Permission[] }).filter((p) => !held.has(p));
        if (missing.length > 0) throw new ProblemException(HttpStatus.FORBIDDEN, `Cannot revoke what you do not hold: ${missing.join(", ")}`);
      }
      await tx.update(roleBindings).set({ revokedAt: sql`now()` }).where(and(eq(roleBindings.id, bindingId), isNull(roleBindings.revokedAt)));
      await audit(tx, ctx, { action: "role_binding.revoke", entityType: "role_binding", entityId: bindingId, environmentId: row.workspaceId ?? undefined, before: toRoleBinding(row) });
    });
  }
}

/** control-plane-v2: roles and role bindings (decision H-9: the same guard serves v1 and v2). */
@Controller("api/v2")
export class AccessController {
  constructor(private readonly access: AccessService) {}

  @Get("roles")
  @RequiredPermission("members.read", "instance")
  roles() {
    return this.access.roles();
  }

  @Get("workspaces/:workspaceId/role-bindings")
  @RequiredPermission("members.read", "workspace")
  listWorkspace(@Param("workspaceId", uuidParam()) workspaceId: string) {
    return this.access.list({ type: "workspace", workspaceId });
  }

  @Post("workspaces/:workspaceId/role-bindings")
  @RequiredPermission("members.manage", "workspace")
  createWorkspace(@Ctx() ctx: RequestContext, @Req() req: AuthenticatedRequest, @Param("workspaceId", uuidParam()) workspaceId: string, @Body(contractBodyV2("RoleBindingWrite")) body: RoleBindingWrite) {
    return this.access.create(ctx, req.auth!.permissions, { type: "workspace", workspaceId }, body);
  }

  @Get("role-bindings")
  @RequiredPermission("members.read", "instance")
  listInstance() {
    return this.access.list({ type: "instance" });
  }

  @Post("role-bindings")
  @RequiredPermission("platform.admin", "instance")
  @SessionOnly()
  createInstance(@Ctx() ctx: RequestContext, @Req() req: AuthenticatedRequest, @Body(contractBodyV2("RoleBindingWrite")) body: RoleBindingWrite) {
    return this.access.create(ctx, req.auth!.permissions, { type: "instance" }, body);
  }

  @Post("role-bindings/:bindingId/revoke")
  @HttpCode(204)
  @RequiredPermission("members.manage", "binding")
  async revoke(@Ctx() ctx: RequestContext, @Req() req: AuthenticatedRequest, @Param("bindingId", uuidParam()) bindingId: string) {
    // The guard decided in the binding's own scope: these are the caller's permissions there (capped by a token).
    await this.access.revoke(ctx, req.auth!.permissions, bindingId);
  }
}

@Module({ controllers: [AccessController], providers: [AccessService] })
export class AccessModule {}
