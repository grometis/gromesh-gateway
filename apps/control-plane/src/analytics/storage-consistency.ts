import { copyStateOf, mergeCopyStates, readCopyState } from "./copy-state.js";

export interface StorageCopy {
  readonly id: string;
  readonly provenance: "workspace-v2" | "legacy" | "unknown";
  /** Original decoded logical columns only; transport/ingestion metadata stays outside. */
  readonly content: Readonly<Record<string, unknown>>;
}
interface EvidenceBase {
  readonly id: string;
  readonly expiresAt: string;
  readonly provenanceComplete: boolean;
}
export type StorageCopyEvidence = EvidenceBase & (
  { readonly kind: "identical"; readonly content: Readonly<Record<string, unknown>> } |
  { readonly kind: "conflicting-copies" }
);
export interface StorageBudget {
  readonly maxRows: number;
  /** Decoded canonical bytes, not ClickHouse scanned/compressed bytes or a query-budget proof. */
  readonly maxDecodedBytes: number;
}
export class StorageConsistencyError extends Error {
  constructor(readonly code: "analytics-budget-exceeded" | "analytics-not-ready", message: string) {
    super(message);
    this.name = "StorageConsistencyError";
  }
}
const invalid = (): never => { throw new StorageConsistencyError("analytics-not-ready", "Invalid storage consistency evidence"); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function instant(value: unknown): bigint {
  if (typeof value !== "string") return invalid();
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
  if (!m) return invalid();
  const ms = Date.parse(`${m[1]}Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== m[1]) return invalid();
  return BigInt(ms) * 1_000_000n + BigInt((m[2] ?? "").padEnd(9, "0"));
}
function expiry(content: Readonly<Record<string, unknown>>): string {
  const days = content.retentionDays;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 7) return invalid();
  // Current raw storage is DateTime64(3); refuse unsupported event precision rather than rounding its content.
  if (typeof content.ts !== "string" || !/T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(content.ts)) return invalid();
  const result = new Date(Number((instant(content.ts) + BigInt(days) * 86_400_000_000_000n) / 1_000_000n)).toISOString();
  if (result.length !== 24) return invalid();
  return result;
}
function identical(id: string, content: Readonly<Record<string, unknown>>, provenanceComplete: boolean): StorageCopyEvidence {
  // copyStateOf validates every scalar, including future columns, before taking an immutable flat copy.
  copyStateOf(id, content);
  return Object.freeze({ kind: "identical", id, content: Object.freeze({ ...content }), expiresAt: expiry(content), provenanceComplete });
}

function validated(p: StorageCopyEvidence): StorageCopyEvidence {
  if (!uuid.test(p.id) || typeof p.provenanceComplete !== "boolean") return invalid();
  instant(p.expiresAt);
  if (p.kind === "identical") {
    const result = identical(p.id, p.content, p.provenanceComplete);
    if (p.expiresAt !== result.expiresAt) return invalid();
    return result;
  }
  if (p.kind === "conflicting-copies") return Object.freeze({ kind: p.kind, id: p.id, expiresAt: p.expiresAt, provenanceComplete: p.provenanceComplete });
  return invalid();
}

/**
 * Fold ALL observed copies before scope/time/status filters. Conflicts become sticky without retaining PII-bearing
 * representatives beyond their own TTL. No database, clock, IO, attribution, or proof of source completeness here.
 */
export function foldStorageCopies(input: {
  readonly id: string;
  readonly previous: StorageCopyEvidence | null;
  readonly copies: Iterable<StorageCopy>;
  readonly budget: StorageBudget;
}): { readonly evidence: StorageCopyEvidence | null; readonly usage: { readonly rows: number; readonly decodedBytes: number } } {
  const { id, budget } = input;
  if (!uuid.test(id) || !Number.isSafeInteger(budget.maxRows) || budget.maxRows < 1 || budget.maxRows > 5_000_000 ||
    !Number.isSafeInteger(budget.maxDecodedBytes) || budget.maxDecodedBytes < 1 || budget.maxDecodedBytes > 256 * 1024 * 1024) return invalid();
  let rows = 0, decodedBytes = 0;
  const consume = (bytes: number) => {
    decodedBytes += bytes;
    if (rows > budget.maxRows || decodedBytes > budget.maxDecodedBytes)
      throw new StorageConsistencyError("analytics-budget-exceeded", "Storage consistency budget exceeded");
  };
  let evidence: StorageCopyEvidence | null = null;
  if (input.previous) {
    if (input.previous.id !== id) return invalid();
    evidence = validated(input.previous);
    consume(evidence.kind === "identical"
      ? Buffer.byteLength(copyStateOf(id, evidence.content).minContent, "utf8")
      : Buffer.byteLength(JSON.stringify(evidence), "utf8"));
  }
  for (const copy of input.copies) {
    if (copy.id !== id) return invalid();
    const next = identical(id, copy.content, copy.provenance === "workspace-v2");
    rows++;
    consume(Buffer.byteLength(copyStateOf(id, copy.content).minContent, "utf8"));
    if (!evidence) { evidence = next; continue; }
    const provenanceComplete = evidence.provenanceComplete && next.provenanceComplete;
    const expiresAt = instant(evidence.expiresAt) >= instant(next.expiresAt) ? evidence.expiresAt : next.expiresAt;
    const conflict = evidence.kind === "conflicting-copies" || readCopyState(mergeCopyStates(
      copyStateOf(id, evidence.content), copyStateOf(id, copy.content),
    )).kind === "conflicting-copies";
    evidence = conflict
      ? Object.freeze({ kind: "conflicting-copies", id, expiresAt, provenanceComplete })
      : identical(id, copy.content, provenanceComplete);
  }
  return { evidence, usage: { rows, decodedBytes } };
}
export type StorageDecision =
  | { readonly kind: "not-ready"; readonly reason: "incomplete-copies" | "incomplete-conflict-history" | "incoherent-snapshot" | "missing-evidence" | "unknown-provenance" | "future-event" }
  | { readonly kind: "expired" }
  | { readonly kind: "conflicting-copies" }
  | { readonly kind: "ready"; readonly id: string; readonly content: Readonly<Record<string, unknown>> };
/** These are caller-certified obligations, never inferred from matching generation strings or successful queries. */
export function evaluateStorageEvidence(evidence: StorageCopyEvidence | null, proof: {
  readonly asOf: string;
  readonly copiesComplete: boolean;
  readonly conflictHistoryComplete: boolean;
  readonly coherentSnapshot: boolean;
}): StorageDecision {
  const asOf = instant(proof.asOf);
  if (proof.coherentSnapshot !== true) return { kind: "not-ready", reason: "incoherent-snapshot" };
  if (proof.copiesComplete !== true) return { kind: "not-ready", reason: "incomplete-copies" };
  if (proof.conflictHistoryComplete !== true) return { kind: "not-ready", reason: "incomplete-conflict-history" };
  if (!evidence) return { kind: "not-ready", reason: "missing-evidence" };
  evidence = validated(evidence);
  if (asOf >= instant(evidence.expiresAt)) return { kind: "expired" };
  if (evidence.kind === "conflicting-copies") return { kind: "conflicting-copies" };
  if (!evidence.provenanceComplete) return { kind: "not-ready", reason: "unknown-provenance" };
  if (asOf < instant(evidence.content.ts)) return { kind: "not-ready", reason: "future-event" };
  return { kind: "ready", id: evidence.id, content: evidence.content };
}
