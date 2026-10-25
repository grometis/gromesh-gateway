import { createHash } from "node:crypto";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { Executor } from "../db/db.js";
import { roleBindings, workspaces, type UserRow } from "../db/schema.js";
import type { Role } from "./environment-access.js";

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
 * A v1 power with no v2 equivalent in a workspace: the admin of an environment manages its clusters (v2 keeps clusters
 * to platform administration). Only the v1 translation holds it; no binding grants it.
 */
export const LEGACY_CLUSTERS = "legacy.cluster.admin";
export type Held = Permission | typeof LEGACY_CLUSTERS;

/**
 * v1 roles as v2 permissions (decision H-9: one authorization for both APIs): viewer → viewer; editor → publisher (a
 * v1 editor edits, publishes and rolls back); admin of an environment → workspace-admin plus its clusters; a global
 * admin → platform-admin (plus clusters) everywhere. The ladder maps onto nested sets, so "role ≥ required" is exactly
 * "holds the operation's permission" and min(token, owner) exactly the intersection: v1 keeps every decision it made.
 */
export const LEGACY_ROLE: Record<Role, BuiltinRole> = { viewer: "viewer", editor: "publisher", admin: "workspace-admin" };
export function legacyPermissions(role: Role, globalAdmin: boolean): readonly Held[] {
  if (globalAdmin) return [...BUILTIN_ROLES["platform-admin"], LEGACY_CLUSTERS];
  return role === "admin" ? [...BUILTIN_ROLES["workspace-admin"], LEGACY_CLUSTERS] : BUILTIN_ROLES[LEGACY_ROLE[role]];
}
const roleSet = (role: string): readonly Held[] =>
  role === "workspace-admin" ? [...BUILTIN_ROLES["workspace-admin"], LEGACY_CLUSTERS] : isBuiltinRole(role) ? BUILTIN_ROLES[role] : [];

/**
 * The binding a v1 environment role is (the same mapping as the N1 migration): it replaces the global role in that
 * workspace; none is a deny that prevails over every grant there.
 */
export function v1EnvironmentBinding(userId: string, workspaceId: string, role: Role | "none") {
  const common = { subjectId: userId, scopeType: "workspace" as const, workspaceId, origin: "v1-environment-role" as const };
  return role === "none" ? { ...common, role: null, permissions: [] as string[], effect: "deny" as const } : { ...common, role: LEGACY_ROLE[role], permissions: null, effect: "allow" as const };
}

/** What a v1 `x-required-role` requires by default, as one permission (an operation may name its own: V1Permission). */
export function requiredPermission(role: Role, inWorkspace: boolean): Permission {
  if (role === "viewer") return "workspace.read";
  if (role === "editor") return "gateway.write";
  return inWorkspace ? "workspace.admin" : "platform.admin";
}

export type Scope = { type: "instance" } | { type: "workspace"; workspaceId: string };

/**
 * Everything a user may do in a scope. At instance scope: its global v1 role translated plus its instance grants. In a
 * workspace: its v1 environment role there if it has one (none: nothing at all, whatever was granted), else its global
 * role; plus its v2 grants of the instance and of the workspace. A global admin is platform administration everywhere.
 */
export async function permissionsIn(tx: Executor, user: UserRow, scope: Scope): Promise<Set<Held>> {
  const rows = await tx
    .select({ role: roleBindings.role, permissions: roleBindings.permissions, effect: roleBindings.effect, origin: roleBindings.origin, scopeType: roleBindings.scopeType })
    .from(roleBindings)
    .where(
      and(
        eq(roleBindings.subjectId, user.id),
        isNull(roleBindings.revokedAt),
        or(isNull(roleBindings.expiresAt), gt(roleBindings.expiresAt, sql`now()`)),
        scope.type === "instance" ? eq(roleBindings.scopeType, "instance") : or(eq(roleBindings.scopeType, "instance"), eq(roleBindings.workspaceId, scope.workspaceId)),
      ),
    );
  const globalAdmin = user.role === "admin";
  const v1 = scope.type === "workspace" && !globalAdmin ? rows.find((r) => r.origin === "v1-environment-role") : undefined;
  if (v1?.effect === "deny") return new Set();
  const out = new Set<Held>(v1 ? roleSet(v1.role ?? "") : legacyPermissions(user.role, globalAdmin));
  for (const r of rows) {
    if (r.origin !== "v2" || r.effect !== "allow") continue;
    if (r.role !== null) for (const p of roleSet(r.role)) if (p !== LEGACY_CLUSTERS) out.add(p);
    for (const p of r.permissions ?? []) if ((PERMISSIONS as readonly string[]).includes(p)) out.add(p as Permission);
  }
  return out;
}

/** A token acts with its own role's permissions intersected with its owner's current ones (GW-RBAC-12). */
export const tokenPermissions = (tokenRole: Role, owner: ReadonlySet<Held>): Set<Held> =>
  new Set(legacyPermissions(tokenRole, tokenRole === "admin").filter((p) => owner.has(p)));

/** The workspace exists (as an environment's), or null. */
export async function workspaceExists(tx: Executor, workspaceId: string): Promise<boolean> {
  const [row] = await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId));
  return row !== undefined;
}
