import { sql } from "drizzle-orm";
import type { Db, Executor, Tx } from "../db/db.js";
import { deliveryRefused } from "./problem.js";
import { pgCode, retryingTransaction } from "./retry.js";

export const ARCHIVE_LOCK_CLASS = 0x6772_7761; // "grwa"
/** Canonical UUID + existing archive namespace, extended to 64 bits to avoid the old 32-bit birthday collisions.
 * PostgreSQL keeps bigint advisory keys separate from all (class, key) int32 locks used for other purposes.
 * A hash collision only serializes an unrelated workspace; it can never bypass mutual exclusion.
 */
export const archiveLockKey = (workspaceId: string) => sql`hashtextextended(${workspaceId}::uuid::text, ${ARCHIVE_LOCK_CLASS})`;

export async function lockWorkspaces(tx: Executor, workspaceIds: readonly string[]): Promise<void> {
  for (const id of [...new Set(workspaceIds.map((id) => id.toLowerCase()))].sort()) {
    await tx.execute(sql`select pg_advisory_xact_lock(${archiveLockKey(id)})`);
  }
}

export async function workspaceTimeouts(tx: Executor): Promise<void> {
  await tx.execute(sql`set local lock_timeout = '5s'`);
  await tx.execute(sql`set local statement_timeout = '15s'`);
}

/** Every shared-state writer takes this lock before entity, environment, uniqueness or lease locks.
 * Only transactional effects belong in work: an aborted attempt rolls its audit and NOTIFY back as well.
 */
export function workspaceTransaction<T>(db: Db, workspaceIds: string | readonly string[], work: (tx: Tx) => Promise<T>, config?: Parameters<Db["transaction"]>[1]): Promise<T> {
  return retryingTransaction(() => db.transaction(async (tx) => {
    await workspaceTimeouts(tx);
    await lockWorkspaces(tx, typeof workspaceIds === "string" ? [workspaceIds] : workspaceIds);
    return work(tx);
  }, config)).catch((err: unknown) => {
    // Only workspace writers opt into these timeouts; preserve error semantics of other APIs.
    if (["55P03", "57014"].includes(pgCode(err) ?? "")) {
      throw deliveryRefused("concurrent-update", "A concurrent change exceeded the workspace transaction timeout; send it again");
    }
    throw err;
  });
}
