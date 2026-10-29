/**
 * Workspace attribution of analytics rows (agent-protocol-v2 "Analytics guarantees", N3-A1): a row counts for a
 * workspace only by its route in the deployment revisions in force when it happened, never by its path or any other
 * field of the event, and an id whose stored copies differ is attributed to nobody.
 */

/** One revision of the instance's deployments, with the routes each workspace has in it. */
export interface AttributionRevision {
  epoch: number;
  revision: number;
  recordedAt: string;
  routes: Record<string, string[]>;
}

/** What attribution needs of the instance: its id, its clusters and its revisions (any order). */
export interface Attribution {
  instanceId: string;
  clusters: string[];
  revisions: AttributionRevision[];
}

/** A stored row as attribution reads it: the identifying members, then any other column. */
export interface AnalyticsRow {
  environmentId: string;
  clusterId: string;
  routeId: string | null;
  ts: string;
  [column: string]: unknown;
}

export type UnattributedReason =
  | "conflicting-copies"
  | "foreign-instance"
  | "unknown-cluster"
  | "no-route"
  | "before-first-revision"
  | "route-not-deployed"
  | "ambiguous-route";

export type AttributionResult = { workspace: string; reason: null } | { workspace: null; reason: UnattributedReason };

/**
 * An RFC 3339 UTC instant in milliseconds, refusing anything a lenient parser would normalise (2026-02-30, 24:00): a
 * stored row's ts is a typed DateTime64, so an invalid one is a defect upstream and is never attributed.
 */
function instant(text: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/.exec(text);
  const ms = m ? Date.parse(text) : Number.NaN;
  const d = new Date(ms);
  if (!m || Number.isNaN(ms) || d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() + 1 !== Number(m[2]) || d.getUTCDate() !== Number(m[3]) ||
    d.getUTCHours() !== Number(m[4]) || d.getUTCMinutes() !== Number(m[5]) || d.getUTCSeconds() !== Number(m[6])) {
    throw new TypeError(`not an RFC 3339 UTC instant: ${JSON.stringify(text)}`);
  }
  return ms;
}

const canonical = (row: Record<string, unknown>) => JSON.stringify(Object.keys(row).sort().map((k) => [k, row[k]]));

/**
 * The workspace of one event. `copies` are every stored row of its id (the event alone by default): if any two differ
 * in any column it is a conflict, attributed to nobody whatever their order. Otherwise the route must be a route of
 * exactly one workspace in the latest revision recorded at or before ts or in the one just before it (the window of a
 * rollout or a rollback, which is a new revision). Throws on an instant that is not a valid RFC 3339 UTC one.
 */
export function attributionOf(a: Attribution, event: AnalyticsRow, copies: AnalyticsRow[] = [event]): AttributionResult {
  if (new Set(copies.map(canonical)).size > 1) return { workspace: null, reason: "conflicting-copies" };
  if (event.environmentId !== a.instanceId) return { workspace: null, reason: "foreign-instance" };
  if (!a.clusters.includes(event.clusterId)) return { workspace: null, reason: "unknown-cluster" };
  if (event.routeId === null) return { workspace: null, reason: "no-route" };
  const at = instant(event.ts);
  const window = [...a.revisions]
    .sort((x, y) => x.epoch - y.epoch || x.revision - y.revision)
    .filter((r) => instant(r.recordedAt) <= at)
    .slice(-2);
  if (window.length === 0) return { workspace: null, reason: "before-first-revision" };
  const owners = new Set<string>();
  for (const r of window) for (const [workspace, routes] of Object.entries(r.routes)) if (routes.includes(event.routeId)) owners.add(workspace);
  if (owners.size === 0) return { workspace: null, reason: "route-not-deployed" };
  if (owners.size > 1) return { workspace: null, reason: "ambiguous-route" };
  return { workspace: [...owners][0]!, reason: null };
}

/** Counts over stored rows, each id once: per workspace (optionally of one route), and the unattributed totals. */
export interface AnalyticsReads {
  distinctIds: number;
  byWorkspace: Record<string, number>;
  unattributed: Partial<Record<UnattributedReason, number>>;
}

/**
 * Reads over stored rows keyed by id: every id counts once; a conflicted id counts only in the unattributed totals, so
 * no route filter can reveal it in a workspace.
 */
export function readsOf(a: Attribution, rows: (AnalyticsRow & { id: string })[], routeFilter: string | null = null): AnalyticsReads {
  const byId = new Map<string, AnalyticsRow[]>();
  for (const { id, ...row } of rows) byId.set(id, [...(byId.get(id) ?? []), row as AnalyticsRow]);
  const reads: AnalyticsReads = { distinctIds: byId.size, byWorkspace: {}, unattributed: {} };
  for (const copies of byId.values()) {
    const event = copies[0]!;
    const result = attributionOf(a, event, copies);
    if (result.workspace === null) reads.unattributed[result.reason] = (reads.unattributed[result.reason] ?? 0) + 1;
    else if (routeFilter === null || event.routeId === routeFilter) reads.byWorkspace[result.workspace] = (reads.byWorkspace[result.workspace] ?? 0) + 1;
  }
  return reads;
}
