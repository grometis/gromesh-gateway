import { and, asc, eq } from "drizzle-orm";
import type { Executor } from "../db/db.js";
import { clusters, environmentRoles, environments, type UserRow } from "../db/schema.js";
import { notFound } from "../common/problem.js";

export type Role = "viewer" | "editor" | "admin";
export type EnvironmentRole = Role | "none";
export const RANK: Record<Role, number> = { viewer: 1, editor: 2, admin: 3 };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const lower = (a: Role, b: Role): Role => (RANK[a] <= RANK[b] ? a : b);

/** A global admin is admin everywhere; anyone else gets the environment's role if one is set, else the global one. */
export function effectiveRole(user: Pick<UserRow, "role">, override: EnvironmentRole | undefined): EnvironmentRole {
  if (user.role === "admin") return "admin";
  // An unknown stored value hides the environment rather than granting anything.
  if (override !== undefined && override !== "none" && !(override in RANK)) return "none";
  return override ?? user.role;
}

/** The user's environment roles, in a stable order. */
export async function environmentRolesOf(db: Executor, userId: string): Promise<{ environmentId: string; role: EnvironmentRole }[]> {
  return db
    .select({ environmentId: environmentRoles.environmentId, role: environmentRoles.role })
    .from(environmentRoles)
    .where(eq(environmentRoles.userId, userId))
    .orderBy(asc(environmentRoles.environmentId));
}

/** The environment a request is about (from `{envId}`, or the environment of `{clusterId}`); 404 when it does not exist. */
export async function environmentOf(db: Executor, params: Partial<Record<string, string | string[]>>): Promise<{ environmentId: string; via: "envId" | "clusterId" } | null> {
  const envId = typeof params.envId === "string" ? params.envId : undefined;
  const clusterId = typeof params.clusterId === "string" ? params.clusterId : undefined;
  if (envId !== undefined) {
    if (!UUID.test(envId)) throw notFound("Environment");
    const [row] = await db.select({ id: environments.id }).from(environments).where(eq(environments.id, envId));
    if (!row) throw notFound("Environment");
    return { environmentId: row.id, via: "envId" };
  }
  if (clusterId !== undefined) {
    if (!UUID.test(clusterId)) throw notFound("Cluster");
    const [row] = await db.select({ environmentId: clusters.environmentId }).from(clusters).where(eq(clusters.id, clusterId));
    if (!row) throw notFound("Cluster");
    return { environmentId: row.environmentId, via: "clusterId" };
  }
  return null;
}

/**
 * The environment a request is about (from `{envId}`, or the environment of `{clusterId}`) and the user's effective
 * role there; null when the route belongs to no environment. A missing environment and one the user may not see
 * answer the same 404, so neither existence nor absence is revealed.
 */
export async function environmentAccess(
  db: Executor,
  user: UserRow,
  params: Partial<Record<string, string | string[]>>,
): Promise<{ environmentId: string; role: Role } | null> {
  const envId = typeof params.envId === "string" ? params.envId : undefined;
  const clusterId = typeof params.clusterId === "string" ? params.clusterId : undefined;
  let environmentId: string | undefined;
  if (envId !== undefined) {
    if (!UUID.test(envId)) throw notFound("Environment");
    const [row] = await db.select({ id: environments.id }).from(environments).where(eq(environments.id, envId));
    if (!row) throw notFound("Environment");
    environmentId = row.id;
  } else if (clusterId !== undefined) {
    if (!UUID.test(clusterId)) throw notFound("Cluster");
    const [row] = await db.select({ environmentId: clusters.environmentId }).from(clusters).where(eq(clusters.id, clusterId));
    if (!row) throw notFound("Cluster");
    environmentId = row.environmentId;
  } else {
    return null;
  }
  const [override] = await db
    .select({ role: environmentRoles.role })
    .from(environmentRoles)
    .where(and(eq(environmentRoles.userId, user.id), eq(environmentRoles.environmentId, environmentId)));
  const role = effectiveRole(user, override?.role);
  if (role === "none") throw envId !== undefined ? notFound("Environment") : notFound("Cluster");
  return { environmentId, role };
}
