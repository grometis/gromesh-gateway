import { canonicalJson } from "./hash.js";
import type { KongDeclarativeConfig } from "./model.js";

export const ENTITY_KINDS = ["services", "routes", "consumers", "keyauth_credentials", "jwt_secrets", "basicauth_credentials", "acls", "plugins", "upstreams", "targets", "certificates"] as const;
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
    const prev = new Map<string, Record<string, unknown>>(entities(before, kind).map((e) => [e.id as string, e]));
    const next = new Map<string, Record<string, unknown>>(entities(after, kind).map((e) => [e.id as string, e]));
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

/** A certificate is compared together with its SNIs (a separate Kong entity), so renaming a server name shows up. */
function entities(config: KongDeclarativeConfig | null, kind: EntityKind): Record<string, unknown>[] {
  if (!config) return [];
  if (kind === "certificates") {
    return (config.certificates ?? []).map((c) => ({
      ...c,
      snis: (config.snis ?? []).filter((s) => s.certificate === c.id).map((s) => s.name).sort(),
    }));
  }
  return ((config[kind] ?? []) as unknown as Record<string, unknown>[]);
}

function label(kind: EntityKind, e: Record<string, unknown>): string {
  if (kind === "consumers") return String(e.username ?? e.custom_id ?? e.id);
  if (kind === "keyauth_credentials") return `key-auth credential of consumer ${String(e.consumer)}`;
  if (kind === "jwt_secrets") return `JWT credential ${String(e.key)}`;
  if (kind === "basicauth_credentials") return `basic-auth credential ${String(e.username)}`;
  if (kind === "acls") return `group ${String(e.group)} of consumer ${String(e.consumer)}`;
  if (kind === "targets") return String(e.target);
  if (kind === "certificates") {
    const snis = e.snis as string[];
    return snis.length > 0 ? `certificate ${snis.join(", ")}` : `certificate ${String(e.id)}`;
  }
  return String(e.name ?? e.id);
}

function redact(kind: EntityKind, e: Record<string, unknown>): Record<string, unknown> {
  if (kind === "keyauth_credentials" || kind === "certificates") return { ...e, key: "REDACTED" };
  // The basic-auth password is Kong's hash: a secret too.
  if (kind === "basicauth_credentials") return { ...e, password: "REDACTED" };
  if (kind === "jwt_secrets" && e.secret !== undefined) return { ...e, secret: "REDACTED" };
  return e;
}
