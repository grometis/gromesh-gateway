import { asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { Executor } from "../db/db.js";
import { environments, workspaces } from "../db/schema.js";
import { proposeSlug } from "./slug.js";

/** Serializes slug assignment across replicas, so two workspaces never get the same proposal. */
export const SLUG_LOCK_KEY = 0x6772_7773; // "grws"

async function takenSlugs(tx: Executor): Promise<Set<string>> {
  const rows = await tx.select({ slug: workspaces.slug }).from(workspaces).where(isNotNull(workspaces.slug));
  return new Set(rows.map((r) => r.slug!));
}

/** Gives the workspace of a new environment its slug, inside the transaction that created the environment. */
export async function assignSlug(tx: Executor, workspaceId: string, name: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${SLUG_LOCK_KEY})`);
  const proposal = proposeSlug(name, await takenSlugs(tx));
  await tx
    .update(workspaces)
    .set({ slug: proposal.slug, slugStatus: proposal.status, slugReason: proposal.reason ?? null, updatedAt: sql`now()` })
    .where(eq(workspaces.id, workspaceId));
}

/**
 * Fills in the slug of every workspace that has none: those the N1 migration created from existing environments (and
 * any environment an older replica created during a rolling upgrade). Oldest environment first, so the result does not
 * depend on which replica runs it; idempotent.
 */
export async function backfillWorkspaces(tx: Executor): Promise<number> {
  await tx.execute(sql`select pg_advisory_xact_lock(${SLUG_LOCK_KEY})`);
  const pending = await tx
    .select({ id: workspaces.id, name: environments.name })
    .from(workspaces)
    .innerJoin(environments, eq(environments.id, workspaces.id))
    .where(isNull(workspaces.slug))
    .orderBy(asc(environments.createdAt), asc(environments.id));
  if (pending.length === 0) return 0;
  const taken = await takenSlugs(tx);
  for (const w of pending) {
    const proposal = proposeSlug(w.name, taken);
    taken.add(proposal.slug);
    await tx
      .update(workspaces)
      .set({ slug: proposal.slug, slugStatus: proposal.status, slugReason: proposal.reason ?? null, updatedAt: sql`now()` })
      .where(eq(workspaces.id, w.id));
  }
  return pending.length;
}
