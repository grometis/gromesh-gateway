import { auditEvents } from "../db/schema.js";
import type { Executor } from "../db/db.js";
import type { RequestContext } from "../auth/auth.js";

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  environmentId?: string | null;
  before?: unknown;
  after?: unknown;
}

/** Must be called with the same transaction as the mutation it records. */
export async function audit(tx: Executor, ctx: RequestContext, entry: AuditEntry): Promise<void> {
  await tx.insert(auditEvents).values({
    actor: ctx.actor,
    ip: ctx.ip,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    environmentId: entry.environmentId ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
  });
}
