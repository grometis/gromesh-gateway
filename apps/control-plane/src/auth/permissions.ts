import { createHash } from "node:crypto";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { Executor } from "../db/db.js";
import { environmentRoles, roleBindings, workspaces, type UserRow } from "../db/schema.js";
import { effectiveRole, type Role } from "./environment-access.js";

/** The v2 permission catalog and built-in roles (contracts/control-plane-v2.openapi.yaml, info; a test compares). */
export const PERMISSIONS = [
  "instance.read", "platform.admin", "workspace.read", "workspace.create", "workspace.admin", "workspace.request", "gateway.write",
  "values.write", "members.read", "members.manage", "groups.read", "groups.manage", "release.publish", "release.rollback",
  "release.revoke", "reconcile.execute", "promotion.read", "promotion.request", "promotion.approve", "promotion.execute",
  "promotion.import", "rollback.emergency",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const VIEWER: Permission[] = ["workspace.read", "members.read", "promotion.read"];
const EDITOR: Permission[] = [...VIEWER, "gateway.write"];
const PUBLISHER: Permission[] = [...EDITOR, "release.publish", "release.rollback", "promotion.request"];
const WORKSPACE_ADMIN: Permission[] = [...PUBLISHER, "workspace.admin", "members.manage", "values.write", "release.revoke"];
export const BUILTIN_ROLES = {
  viewer: VIEWER,
  editor: EDITOR,
  publisher: PUBLISHER,
  approver: ["workspace.read", "members.read", "promotion.read", "promotion.approve"],
  "workspace-admin": WORKSPACE_ADMIN,
  "platform-admin": [
    "instance.read", "platform.admin", "workspace.read", "workspace.create", "workspace.admin", "workspace.request", "gateway.write",
    "values.write", "members.read", "members.manage", "groups.read", "groups.manage", "release.publish", "release.rollback",
    "release.revoke", "reconcile.execute", "promotion.read", "promotion.request", "promotion.approve", "promotion.execute", "promotion.import",
  ],
} as const satisfies Record<string, readonly Permission[]>;
export type BuiltinRole = keyof typeof BUILTIN_ROLES;
export const isBuiltinRole = (name: string): name is BuiltinRole => Object.hasOwn(BUILTIN_ROLES, name);

/** A built-in role's stable id (UUID v5 shape of its name), the same on every instance. */
export function builtinRoleId(name: BuiltinRole): string {
  const h = createHash("sha1").update(`gromesh-role:${name}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

/**
 * v1 roles as v2 permissions (decision H-9: one authorization for both APIs). In a workspace the v1 role is the
 * effective one there; a global admin is platform-admin everywhere. The ladder viewer < editor < admin maps onto
 * nested role sets, so "role ≥ required" is exactly "holds the required permission" and min(token, owner) is exactly the
 * intersection: v1 keeps every decision it made.
 */
export const LEGACY_ROLE: Record<Role, BuiltinRole> = { viewer: "viewer", editor: "editor", admin: "workspace-admin" };
export const legacyPermissions = (role: Role, globalAdmin: boolean): readonly Permission[] => BUILTIN_ROLES[globalAdmin ? "platform-admin" : LEGACY_ROLE[role]];

/** What a v1 `x-required-role` requires, as one permission. */
export function requiredPermission(role: Role, inWorkspace: boolean): Permission {
  if (role === "viewer") return "workspace.read";
  if (role === "editor") return "gateway.write";
  return inWorkspace ? "workspace.admin" : "platform.admin";
}

export type Scope = { type: "instance" } | { type: "workspace"; workspaceId: string };

/** Active bindings of a user in a scope (a workspace's include the instance's). */
async function bindingPermissions(tx: Executor, userId: string, scope: Scope): Promise<Set<Permission>> {
  const rows = await tx
    .select({ role: roleBindings.role, permissions: roleBindings.permissions })
    .from(roleBindings)
    .where(
      and(
        eq(roleBindings.subjectId, userId),
        isNull(roleBindings.revokedAt),
        or(isNull(roleBindings.expiresAt), gt(roleBindings.expiresAt, sql`now()`)),
        scope.type === "instance" ? eq(roleBindings.scopeType, "instance") : or(eq(roleBindings.scopeType, "instance"), eq(roleBindings.workspaceId, scope.workspaceId)),
      ),
    );
  const out = new Set<Permission>();
  for (const r of rows) {
    if (r.role !== null && isBuiltinRole(r.role)) for (const p of BUILTIN_ROLES[r.role]) out.add(p);
    for (const p of r.permissions ?? []) if ((PERMISSIONS as readonly string[]).includes(p)) out.add(p as Permission);
  }
  return out;
}

/**
 * Everything a user may do in a scope: its v1 role translated, plus its bindings. In a workspace the v1 role is the
 * environment's override (none hides it), else the global role; at instance scope, the global role.
 */
export async function permissionsIn(tx: Executor, user: UserRow, scope: Scope): Promise<Set<Permission>> {
  const out = await bindingPermissions(tx, user.id, scope);
  if (scope.type === "instance") {
    for (const p of legacyPermissions(user.role, user.role === "admin")) out.add(p);
    return out;
  }
  const [override] = await tx
    .select({ role: environmentRoles.role })
    .from(environmentRoles)
    .where(and(eq(environmentRoles.userId, user.id), eq(environmentRoles.environmentId, scope.workspaceId)));
  const role = effectiveRole(user, override?.role);
  if (role !== "none") for (const p of legacyPermissions(role, user.role === "admin")) out.add(p);
  return out;
}

/** A token acts with its own role's permissions intersected with its owner's current ones (GW-RBAC-12). */
export const tokenPermissions = (tokenRole: Role, owner: ReadonlySet<Permission>): Set<Permission> =>
  new Set(legacyPermissions(tokenRole, tokenRole === "admin").filter((p) => owner.has(p)));

/** The workspace exists (as an environment's), or null. */
export async function workspaceExists(tx: Executor, workspaceId: string): Promise<boolean> {
  const [row] = await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId));
  return row !== undefined;
}
