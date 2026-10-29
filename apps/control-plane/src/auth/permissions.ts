import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Executor } from "../db/db.js";
import { environmentRoles, roleBindings, users, workspaces, type UserRow } from "../db/schema.js";
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

/** A stable id in UUID v5 shape, the same on every instance. */
function stableId(name: string): string {
  const h = createHash("sha1").update(name).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}
export const builtinRoleId = (name: BuiltinRole): string => stableId(`gromesh-role:${name}`);

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

/** What a v1 `x-required-role` requires by default, as one permission (an operation may name its own: V1Permission). */
export function requiredPermission(role: Role, inWorkspace: boolean): Permission {
  if (role === "viewer") return "workspace.read";
  if (role === "editor") return "gateway.write";
  return inWorkspace ? "workspace.admin" : "platform.admin";
}

export type Scope = { type: "instance" } | { type: "workspace"; workspaceId: string };

/**
 * A v1 environment role seen as a binding of its workspace (read-only: v1 changes it). It is read from
 * environment_roles itself, never copied, so no writer (an older replica included) can leave it out of step.
 */
export interface V1Binding {
  id: string;
  subjectId: string;
  workspaceId: string;
  /** null: none, a deny that prevails over every grant there. */
  role: BuiltinRole | null;
  createdAt: Date;
}
export const v1BindingId = (userId: string, workspaceId: string): string => stableId(`gromesh-v1-binding:${userId}:${workspaceId}`);
export async function v1Bindings(tx: Executor, where: { subjectId?: string; workspaceId?: string }): Promise<V1Binding[]> {
  const rows = await tx
    .select()
    .from(environmentRoles)
    .where(
      and(
        where.subjectId ? eq(environmentRoles.userId, where.subjectId) : undefined,
        where.workspaceId ? eq(environmentRoles.environmentId, where.workspaceId) : undefined,
      ),
    );
  return rows.map((r) => ({
    id: v1BindingId(r.userId, r.environmentId),
    subjectId: r.userId,
    workspaceId: r.environmentId,
    role: r.role === "none" ? null : LEGACY_ROLE[r.role],
    createdAt: r.createdAt,
  }));
}

/** The v1 binding with this id, if any (its id derives from the user and the workspace, so the roles are scanned). */
export async function v1BindingById(tx: Executor, id: string): Promise<V1Binding | undefined> {
  return (await v1Bindings(tx, {})).find((b) => b.id === id);
}

/**
 * Everything a user may do in a scope. At instance scope: its global v1 role translated plus its instance grants. In a
 * workspace: its v1 environment role there if it has one (none: nothing at all, whatever was granted), else its global
 * role; plus its v2 grants of the instance and of the workspace. A global admin is platform administration everywhere.
 * One statement reads all of it, so the decision sees a single snapshot: a grant revoked and a deny lifted in between
 * never combine into access no committed state gave.
 */
export async function permissionsIn(tx: Executor, user: UserRow, scope: Scope): Promise<Set<Held>> {
  const workspaceId = scope.type === "workspace" ? scope.workspaceId : null;
  const { rows } = await tx.execute<{ global: Role | null; v1: Role | "none" | null; grants: { role: string | null; permissions: string[] | null }[] }>(sql`
    select
      (select ${users.role} from ${users} where ${users.id} = ${user.id}) as global,
      (select ${environmentRoles.role} from ${environmentRoles} where ${environmentRoles.userId} = ${user.id} and ${environmentRoles.environmentId} = ${workspaceId}) as v1,
      coalesce((
        select json_agg(json_build_object('role', ${roleBindings.role}, 'permissions', ${roleBindings.permissions}))
        from ${roleBindings}
        where ${roleBindings.subjectId} = ${user.id}
          and ${roleBindings.revokedAt} is null
          and (${roleBindings.expiresAt} is null or ${roleBindings.expiresAt} > now())
          and (${roleBindings.scopeType} = 'instance' or ${roleBindings.workspaceId} = ${workspaceId})
      ), '[]'::json) as grants`);
  const { global, v1, grants } = rows[0]!;
  // A user deleted meanwhile holds nothing.
  if (global === null) return new Set();
  const globalAdmin = global === "admin";
  const own = workspaceId !== null && !globalAdmin ? v1 : null;
  if (own === "none") return new Set();
  const out = new Set<Held>(own ? roleSet(LEGACY_ROLE[own]) : legacyPermissions(global, globalAdmin));
  for (const r of grants) {
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

/** The workspace is archived: read-only for every mutation in its scope (WS-M0). */
export async function workspaceArchived(tx: Executor, workspaceId: string): Promise<boolean> {
  const [row] = await tx.select({ status: workspaces.status }).from(workspaces).where(eq(workspaces.id, workspaceId));
  return row?.status === "archived";
}
