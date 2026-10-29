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

const canonical = (row: Record<string, unknown>) => JSON.stringify(Object.keys(row).sort().map((k) => [k, row[k]]));

/**
 * The workspace of one event. `copies` are every stored row of its id (the event alone by default): if any two differ
 * in any column it is a conflict, attributed to nobody whatever their order. Otherwise the route must be a route of
 * exactly one workspace in the latest revision recorded at or before ts or in the one just before it (the window of a
 * rollout or a rollback, which is a new revision).
 */
export function attributionOf(a: Attribution, event: AnalyticsRow, copies: AnalyticsRow[] = [event]): AttributionResult {
  if (new Set(copies.map(canonical)).size > 1) return { workspace: null, reason: "conflicting-copies" };
  if (event.environmentId !== a.instanceId) return { workspace: null, reason: "foreign-instance" };
  if (!a.clusters.includes(event.clusterId)) return { workspace: null, reason: "unknown-cluster" };
  if (event.routeId === null) return { workspace: null, reason: "no-route" };
  const at = Date.parse(event.ts);
  const window = [...a.revisions]
    .sort((x, y) => x.epoch - y.epoch || x.revision - y.revision)
    .filter((r) => Date.parse(r.recordedAt) <= at)
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
