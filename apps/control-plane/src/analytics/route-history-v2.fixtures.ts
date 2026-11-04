import type { AnalyticsRow } from "./attribution.js";
import type { RouteHistoryEvidence, RouteHistoryRequest, RouteHistoryResult, RouteHistoryRevision } from "./route-history-v2.js";

export const ids = {
  instance: "10000000-0000-4000-8000-000000000001", foreign: "10000000-0000-4000-8000-000000000002",
  a: "20000000-0000-4000-8000-000000000001", b: "20000000-0000-4000-8000-000000000002",
  route: "30000000-0000-4000-8000-000000000001", otherRoute: "30000000-0000-4000-8000-000000000002", recreated: "30000000-0000-4000-8000-000000000003",
  service: "40000000-0000-4000-8000-000000000001", otherService: "40000000-0000-4000-8000-000000000002",
  cluster: "50000000-0000-4000-8000-000000000001", request: "653b06fb-b7b4-685b-d4b9-b2109eeaf6c7",
} as const;
export const time = (hour: number) => `2026-11-04T${String(hour).padStart(2, "0")}:00:00Z`;
export const k1 = { epoch: 1, revision: 1 };
export const k2 = { epoch: 1, revision: 2 };
export const k3 = { epoch: 1, revision: 3 };
export function revision(number: number): RouteHistoryRevision {
  return {
    epoch: 1, revision: number, recordedAt: time(9 + number), visibleAt: time(9 + number),
    previous: number === 1 ? null : { epoch: 1, revision: number - 1 }, complete: true, reason: "publish", rollbackOf: null,
    routes: [
      { routeId: ids.route, workspaceId: ids.a, serviceId: ids.service, releaseVersion: 1 },
      { routeId: ids.otherRoute, workspaceId: ids.b, serviceId: ids.otherService, releaseVersion: 1 },
    ],
  };
}
export function evidence(): RouteHistoryEvidence {
  return {
    instanceId: ids.instance, asOf: time(18), revisionsComplete: true,
    firstRevision: { ...k1, recordedAt: time(10) }, revisions: [revision(1), revision(2)],
    identities: [
      { routeId: ids.route, workspaceIds: [ids.a], complete: true },
      { routeId: ids.otherRoute, workspaceIds: [ids.b], complete: true },
    ],
    clusterHistory: [{ clusterId: ids.cluster, instanceId: ids.instance, validFrom: time(0), validUntil: null, trusted: true }],
  };
}
export function request(content: Partial<AnalyticsRow> = {}): RouteHistoryRequest {
  return {
    copiesComplete: true, retainedCopyState: null,
    copies: [{ id: ids.request, provenance: "workspace-v2", ingestedAt: time(17), content: {
      environmentId: ids.instance, clusterId: ids.cluster, routeId: ids.route, serviceId: ids.service,
      ts: "2026-11-04T11:30:00Z", consumerId: null, method: "GET", path: "/shared", status: 200,
      latencyKongMs: 1, latencyUpstreamMs: 2, latencyTotalMs: 3, clientIp: "192.0.2.1",
      requestSize: "9007199254740993", responseSize: "10", retentionDays: 7, ...content,
    } }],
  };
}
const attributed = (workspaceId: string, candidateRevisions = [k1, k2]): RouteHistoryResult => ({
  policy: "route-history-v2", workspaceId, reason: null, effectiveRevision: null, candidateRevisions,
});
const denied = (reason: Exclude<RouteHistoryResult["reason"], null>, candidateRevisions: { epoch: number; revision: number }[] = []): RouteHistoryResult => ({
  policy: "route-history-v2", workspaceId: null, reason, effectiveRevision: null, candidateRevisions,
});
export interface AttributionFixture { name: string; evidence: RouteHistoryEvidence; request: RouteHistoryRequest; expected: RouteHistoryResult }

/** Fresh, hand-derived scenarios; no production function computes the expected owner or reason. */
export function attributionFixtures(): AttributionFixture[] {
  const e = evidence(); const r = request(); const first = revision(1); const second = revision(2);
  const withoutRoute = (v: RouteHistoryRevision) => ({ ...v, routes: v.routes.filter((x) => x.routeId !== ids.route) });
  const rollback = { ...revision(3), reason: "rollback" as const, rollbackOf: k1 };
  const epoch = { ...revision(3), epoch: 2, revision: 1, previous: k2 };
  const recreated = { ...second, routes: second.routes.map((v) => v.routeId === ids.route ? { ...v, routeId: ids.recreated } : v) };
  return [
    { name: "01 unique historical owner", evidence: e, request: r, expected: attributed(ids.a) },
    { name: "02 different workspaces with the same path", evidence: e, request: request({ routeId: ids.otherRoute, serviceId: ids.otherService }), expected: attributed(ids.b) },
    { name: "03 removed route remains in the previous revision", evidence: { ...e, revisions: [first, withoutRoute(second)] }, request: r, expected: attributed(ids.a) },
    { name: "04 recreated route has a new technical identity", evidence: { ...e, revisions: [first, recreated], identities: [...e.identities, { routeId: ids.recreated, workspaceIds: [ids.a], complete: true }] }, request: request({ routeId: ids.recreated }), expected: attributed(ids.a) },
    { name: "05 historically ambiguous route identity", evidence: { ...e, identities: [{ routeId: ids.route, workspaceIds: [ids.a, ids.b], complete: true }] }, request: r, expected: denied("ambiguous-route", [k1, k2]) },
    { name: "06 non-adjacent revision contradicts the claimed unique identity", evidence: { ...e, revisions: [{ ...first, routes: first.routes.map((v) => v.routeId === ids.route ? { ...v, workspaceId: ids.b } : v) }, second, revision(3)] }, request: request({ ts: "2026-11-04T12:30:00Z" }), expected: denied("ambiguous-route", [k2, k3]) },
    { name: "07 service change does not move the workspace owner", evidence: { ...e, revisions: [first, { ...second, routes: second.routes.map((v) => v.routeId === ids.route ? { ...v, serviceId: ids.otherService } : v) }] }, request: r, expected: attributed(ids.a) },
    { name: "08 rollback is a new revision, never the served revision", evidence: { ...e, revisions: [first, withoutRoute(second), rollback] }, request: request({ ts: "2026-11-04T12:30:00Z" }), expected: attributed(ids.a, [k2, k3]) },
    { name: "09 epoch change has an explicit predecessor", evidence: { ...e, revisions: [first, second, epoch] }, request: request({ ts: "2026-11-04T12:30:00Z" }), expected: attributed(ids.a, [k2, { epoch: 2, revision: 1 }]) },
    { name: "10 exact timestamp boundary includes the new revision", evidence: { ...e, revisions: [withoutRoute(first), second] }, request: request({ ts: time(11) }), expected: attributed(ids.a) },
    { name: "11 event before the proven first revision", evidence: e, request: request({ ts: time(9) }), expected: denied("before-first-revision") },
    { name: "12 incomplete candidate map", evidence: { ...e, revisions: [first, { ...second, complete: false }] }, request: r, expected: denied("attribution-evidence-missing") },
    { name: "13 required previous revision is absent", evidence: { ...e, revisions: [second] }, request: r, expected: denied("attribution-evidence-missing") },
    { name: "14 cluster has no trusted historical association", evidence: { ...e, clusterHistory: [] }, request: r, expected: denied("unknown-cluster") },
    { name: "15 event belongs to another instance", evidence: e, request: request({ environmentId: ids.foreign }), expected: denied("foreign-instance") },
    { name: "16 route id absent", evidence: e, request: request({ routeId: null }), expected: denied("no-route") },
    { name: "17 identical request copies ignore ingestion metadata", evidence: e, request: { ...r, copies: [r.copies[0]!, { ...r.copies[0]!, ingestedAt: time(18) }] }, expected: attributed(ids.a) },
    { name: "18 conflicting request copies have no representative", evidence: e, request: { ...r, copies: [r.copies[0]!, request({ status: 500 }).copies[0]!] }, expected: denied("conflicting-copies") },
    { name: "19 delayed event uses its timestamp and historical cluster", evidence: { ...e, revisions: [first, second, withoutRoute(revision(3))], clusterHistory: [{ ...e.clusterHistory[0]!, validUntil: time(12) }, { ...e.clusterHistory[0]!, instanceId: ids.foreign, validFrom: time(12) }] }, request: request({ ts: "2026-11-04T10:30:00Z" }), expected: attributed(ids.a, [k1]) },
    { name: "20 historical identity evidence unavailable", evidence: { ...e, identities: [] }, request: r, expected: denied("attribution-evidence-missing") },
  ];
}
