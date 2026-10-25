import { and, eq, or, sql } from "drizzle-orm";
import type { Executor } from "../db/db.js";
import { consumers, plugins } from "../db/schema.js";

/**
 * An authentication plugin's `anonymous` names, by id or username (as Kong resolves it), the consumer a request falls
 * back to. It is a reference like any other: always a consumer of the plugin's own workspace (decision H-1).
 */
export function anonymousOf(config: Record<string, unknown> | null | undefined): string | null {
  const value = config?.anonymous;
  return typeof value === "string" && value !== "" ? value : null;
}

export const namesConsumer = (anonymous: string, consumer: { id: string; username?: string | null }) =>
  consumer.id.toLowerCase() === anonymous.toLowerCase() || (consumer.username != null && consumer.username === anonymous);

export async function anonymousResolves(tx: Executor, envId: string, anonymous: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: consumers.id })
    .from(consumers)
    .where(and(eq(consumers.environmentId, envId), or(sql`${consumers.id}::text = lower(${anonymous})`, eq(consumers.username, anonymous))))
    .limit(1);
  return row !== undefined;
}

/** Whether a plugin of the workspace names the consumer as anonymous by `id` (any case) or, when given, by `username`. */
export async function usedAsAnonymous(tx: Executor, envId: string, refs: { id?: string; username?: string | null }): Promise<boolean> {
  const anonymous = sql`${plugins.config}->>'anonymous'`;
  const matches = [
    refs.id ? sql`lower(${anonymous}) = ${refs.id.toLowerCase()}` : undefined,
    refs.username != null ? sql`${anonymous} = ${refs.username}` : undefined,
  ].filter((m) => m !== undefined);
  if (matches.length === 0) return false;
  const [row] = await tx.select({ id: plugins.id }).from(plugins).where(and(eq(plugins.environmentId, envId), or(...matches))).limit(1);
  return row !== undefined;
}
