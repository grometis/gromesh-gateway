import { canonicalJson } from "./hash.js";
import type { KongDeclarativeConfig } from "./model.js";

export const ENTITY_KINDS = ["services", "routes", "consumers", "keyauth_credentials", "plugins"] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export interface EntityChange {
  kind: EntityKind;
  id: string;
  /** name/username/key-less label for display; credentials never expose the key */
  label: string;
  change: "added" | "removed" | "modified";
  before?: unknown;
  after?: unknown;
}

/** Entity-level diff between two compiled configs (used by the publish preview and rollback). */
export function diffConfigs(before: KongDeclarativeConfig | null, after: KongDeclarativeConfig): EntityChange[] {
  const changes: EntityChange[] = [];
  for (const kind of ENTITY_KINDS) {
    const prev = new Map<string, Record<string, unknown>>(
      ((before?.[kind] ?? []) as unknown as Record<string, unknown>[]).map((e) => [e.id as string, e]),
    );
    const next = new Map<string, Record<string, unknown>>(
      (after[kind] as unknown as Record<string, unknown>[]).map((e) => [e.id as string, e]),
    );
    for (const [id, entity] of next) {
      const old = prev.get(id);
      if (!old) changes.push({ kind, id, label: label(kind, entity), change: "added", after: redact(kind, entity) });
      else if (canonicalJson(old) !== canonicalJson(entity))
        changes.push({ kind, id, label: label(kind, entity), change: "modified", before: redact(kind, old), after: redact(kind, entity) });
    }
    for (const [id, entity] of prev) {
      if (!next.has(id)) changes.push({ kind, id, label: label(kind, entity), change: "removed", before: redact(kind, entity) });
    }
  }
  return changes;
}

function label(kind: EntityKind, e: Record<string, unknown>): string {
  if (kind === "consumers") return String(e.username ?? e.custom_id ?? e.id);
  if (kind === "keyauth_credentials") return `key-auth credential of consumer ${String(e.consumer)}`;
  return String(e.name ?? e.id);
}

function redact(kind: EntityKind, e: Record<string, unknown>): Record<string, unknown> {
  return kind === "keyauth_credentials" ? { ...e, key: "REDACTED" } : e;
}
