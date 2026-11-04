import type { AnalyticsRow, UnattributedReason } from "./attribution.js";
import { copyStateOf, mergeCopyStates, readCopyState, type RequestCopyState } from "./copy-state.js";

export interface RevisionRef { readonly epoch: number; readonly revision: number }
export interface RouteHistoryRevision extends RevisionRef {
  readonly recordedAt: string;
  /** Committed visibility evidence, never inferred from recordedAt, heartbeat or event ingestion. */
  readonly visibleAt: string;
  readonly previous: RevisionRef | null;
  readonly complete: boolean;
  readonly reason: "publish" | "rollback" | "promotion" | "reconcile" | "mandatory-plugins" | "values";
  readonly rollbackOf: RevisionRef | null;
  readonly routes: readonly { readonly routeId: string; readonly workspaceId: string; readonly serviceId: string; readonly releaseVersion: number }[];
}
export interface RouteHistoryEvidence {
  readonly instanceId: string;
  /** The caller certifies one consistent observation; the policy never consults the current clock. */
  readonly asOf: string;
  /** Proof that the supplied timeline covers the event and its required anchors, not merely a successful query. */
  readonly revisionsComplete: boolean;
  readonly firstRevision: (RevisionRef & { readonly recordedAt: string }) | null;
  readonly revisions: readonly RouteHistoryRevision[];
  readonly identities: readonly { readonly routeId: string; readonly workspaceIds: readonly string[]; readonly complete: boolean }[];
  readonly clusterHistory: readonly { readonly clusterId: string; readonly instanceId: string; readonly validFrom: string; readonly validUntil: string | null; readonly trusted: boolean }[];
}
export interface RouteHistoryCopy {
  readonly id: string;
  readonly provenance: "workspace-v2" | "legacy" | "unknown";
  readonly content: Readonly<AnalyticsRow>;
  readonly ingestedAt?: string;
}
export interface RouteHistoryRequest {
  readonly copiesComplete: boolean;
  readonly copies: readonly RouteHistoryCopy[];
  readonly retainedCopyState: RequestCopyState | null;
}
export type RouteHistoryReason = UnattributedReason | "attribution-evidence-missing";
interface ResultContext {
  readonly policy: "route-history-v2";
  readonly effectiveRevision: null;
  readonly candidateRevisions: readonly RevisionRef[];
}
export type RouteHistoryResult = ResultContext & (
  { readonly workspaceId: string; readonly reason: null } |
  { readonly workspaceId: null; readonly reason: RouteHistoryReason }
);

const context = (candidateRevisions: readonly RevisionRef[]) => ({ policy: "route-history-v2" as const, effectiveRevision: null, candidateRevisions });
const denied = (reason: RouteHistoryReason, candidates: readonly RevisionRef[] = []): RouteHistoryResult => ({ ...context(candidates), workspaceId: null, reason });
const missing = () => denied("attribution-evidence-missing");
const ref = (r: RevisionRef): RevisionRef => ({ epoch: r.epoch, revision: r.revision });
const key = (r: RevisionRef) => `${r.epoch}:${r.revision}`;
const validRef = (r: RevisionRef | null) => r != null && Number.isSafeInteger(r.epoch) && r.epoch > 0 && Number.isSafeInteger(r.revision) && r.revision > 0;
const compare = (a: RevisionRef, b: RevisionRef) => a.epoch - b.epoch || a.revision - b.revision;

/** Stored UTC instants, kept at nanosecond precision rather than rounded across a revision boundary. */
function instant(value: string): bigint | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
  if (!m) return null;
  const ms = Date.parse(`${value.slice(0, 19)}Z`);
  const d = new Date(ms);
  if (!Number.isFinite(ms) || d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() + 1 !== Number(m[2]) || d.getUTCDate() !== Number(m[3]) ||
    d.getUTCHours() !== Number(m[4]) || d.getUTCMinutes() !== Number(m[5]) || d.getUTCSeconds() !== Number(m[6])) return null;
  return BigInt(ms) * 1_000_000n + BigInt((m[7] ?? "").padEnd(9, "0"));
}

interface Recorded {
  revision: RouteHistoryRevision;
  at: bigint;
  visibleAt: bigint;
  content: string;
}

function revisionsOf(e: RouteHistoryEvidence, asOf: bigint): Recorded[] | null {
  const byKey = new Map<string, Recorded>();
  for (const r of e.revisions) {
    const at = instant(r.recordedAt), visibleAt = instant(r.visibleAt);
    if (!validRef(r) || at === null || visibleAt === null || visibleAt < at || visibleAt > asOf ||
      (r.previous !== null && (!validRef(r.previous) || compare(r.previous, r) >= 0))) return null;
    if (r.routes.some((v) => !v.routeId || !v.workspaceId || !v.serviceId || !Number.isSafeInteger(v.releaseVersion) || v.releaseVersion < 1)) return null;
    const routes = [...new Set(r.routes.map((v) => JSON.stringify([v.routeId, v.workspaceId, v.serviceId, v.releaseVersion])))].sort();
    const content = JSON.stringify([r.epoch, r.revision, String(at), String(visibleAt), r.previous === null ? null : key(r.previous), r.complete, r.reason, r.rollbackOf === null ? null : key(r.rollbackOf), routes]);
    const prior = byKey.get(key(r));
    if (prior && prior.content !== content) return null;
    byKey.set(key(r), { revision: r, at, visibleAt, content });
  }
  const ordered = [...byKey.values()].sort((a, b) => compare(a.revision, b.revision));
  if (ordered.some((r, i) => i > 0 && r.at < ordered[i - 1]!.at)) return null;
  for (const [i, r] of ordered.entries()) {
    const previous = r.revision.previous === null ? undefined : byKey.get(key(r.revision.previous));
    if (previous && ordered[i - 1] !== previous) return null;
  }
  return ordered;
}

function trustedCluster(e: RouteHistoryEvidence, clusterId: string, at: bigint): boolean {
  const associations = e.clusterHistory.filter((c) => c.clusterId === clusterId);
  const active = [];
  for (const c of associations) {
    const from = instant(c.validFrom), until = c.validUntil === null ? null : instant(c.validUntil);
    if (from === null || (c.validUntil !== null && (until === null || until <= from))) return false;
    if (from <= at && (until === null || at < until)) active.push(c);
  }
  return active.length > 0 && active.every((c) => c.trusted === true && c.instanceId === e.instanceId);
}

/**
 * One ID, all original stored columns and retained conflict evidence, before choosing an event representative.
 * The future adapter must certify completeness and a consistent observation; this module performs no IO or auth.
 */
export function attributeRouteHistoryV2(e: RouteHistoryEvidence, request: RouteHistoryRequest): RouteHistoryResult {
  const first = request.copies[0];
  if (!first || !first.id || request.copies.some((c) => c.id !== first.id)) return missing();
  let state: RequestCopyState;
  try {
    state = copyStateOf(first.id, first.content);
    for (const c of request.copies) state = mergeCopyStates(state, copyStateOf(c.id, c.content));
    if (request.retainedCopyState) {
      const { minContent, maxContent } = request.retainedCopyState;
      if (typeof minContent !== "string" || typeof maxContent !== "string" || !minContent || !maxContent || minContent > maxContent) return missing();
      state = mergeCopyStates(state, request.retainedCopyState);
    }
  } catch { return missing(); }
  if (readCopyState(state).kind === "conflicting-copies") return denied("conflicting-copies");
  if (request.copiesComplete !== true) return missing();
  const event = first.content;
  if (!e.instanceId || typeof event.environmentId !== "string" || typeof event.clusterId !== "string") return missing();
  if (event.environmentId !== e.instanceId) return denied("foreign-instance");
  if (request.copies.some((c) => c.provenance !== "workspace-v2")) return missing();
  const at = instant(event.ts), asOf = instant(e.asOf);
  if (at === null || asOf === null || at > asOf) return missing();
  if (!trustedCluster(e, event.clusterId, at)) return denied("unknown-cluster");
  if (event.routeId === null) return denied("no-route");
  if (typeof event.routeId !== "string" || !event.routeId || e.revisionsComplete !== true) return missing();
  const firstAt = e.firstRevision ? instant(e.firstRevision.recordedAt) : null;
  if (e.firstRevision && (!validRef(e.firstRevision) || firstAt === null)) return missing();
  const ordered = revisionsOf(e, asOf);
  if (!ordered) return missing();
  if (e.firstRevision && ordered.some((r) => compare(r.revision, e.firstRevision!) < 0 ||
    r.at < firstAt! || (key(r.revision) === key(e.firstRevision!) && r.at !== firstAt))) return missing();
  if (ordered.some((r) => r.revision.previous === null && (!e.firstRevision || key(r.revision) !== key(e.firstRevision) || r.at !== firstAt))) return missing();
  if (firstAt !== null && at < firstAt) return denied("before-first-revision");
  const current = ordered.filter((r) => r.at <= at).at(-1);
  if (!current) return missing();
  const index = ordered.indexOf(current);
  let candidates: Recorded[];
  if (current.revision.previous === null) {
    if (!e.firstRevision || key(current.revision) !== key(e.firstRevision) || current.at !== firstAt) return missing();
    candidates = [current];
  } else {
    const previous = ordered[index - 1];
    if (!previous || key(previous.revision) !== key(current.revision.previous)) return missing();
    // A retained anchor crossing epochs still needs its bridge, even when the bridge is not a candidate.
    const bridge = previous.revision.previous;
    if (bridge && bridge.epoch !== previous.revision.epoch && !ordered.some((r) => key(r.revision) === key(bridge))) return missing();
    candidates = [previous, current];
  }
  if (candidates.some((r) => r.revision.complete !== true || r.visibleAt > at)) return missing();
  const refs = candidates.map((r) => ref(r.revision));
  const candidateOwners = new Set(candidates.flatMap((r) => r.revision.routes.filter((v) => v.routeId === event.routeId).map((v) => v.workspaceId)));
  if (candidateOwners.size === 0) return denied("route-not-deployed", refs);
  const identities = e.identities.filter((i) => i.routeId === event.routeId);
  const owners = new Set([
    ...ordered.flatMap((r) => r.revision.routes.filter((v) => v.routeId === event.routeId).map((v) => v.workspaceId)),
    ...identities.flatMap((i) => i.workspaceIds),
  ]);
  if (owners.size > 1) return denied("ambiguous-route", refs);
  if (identities.length === 0 || identities.some((i) => i.complete !== true || i.workspaceIds.length === 0 || i.workspaceIds.some((w) => !w))) return missing();
  return { ...context(refs), workspaceId: [...candidateOwners][0]!, reason: null };
}
