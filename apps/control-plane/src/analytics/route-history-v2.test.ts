import { expect, it } from "vitest";
import { attributeRouteHistoryV2 } from "./route-history-v2.js";
import { copyStateOf, mergeCopyStates, type RequestCopyState } from "./copy-state.js";
import { attributionFixtures, evidence, ids, k1, k2, request, revision, time } from "./route-history-v2.fixtures.js";

it.each(attributionFixtures())("route-history-v2: $name", (c) => {
  expect(attributeRouteHistoryV2(c.evidence, c.request)).toEqual(c.expected);
});

it("never attributes an old deleted identity by a recreated route's path", () => {
  const e = evidence();
  const newMap = revision(2).routes.map((r) => r.routeId === ids.route ? { ...r, routeId: ids.recreated } : r);
  const result = attributeRouteHistoryV2({ ...e, revisions: [revision(1), { ...revision(2), routes: newMap }, { ...revision(3), routes: newMap }] }, request({ ts: "2026-11-04T12:30:00Z" }));
  expect(result).toEqual({ policy: "route-history-v2", workspaceId: null, reason: "route-not-deployed", effectiveRevision: null, candidateRevisions: [k2, { epoch: 1, revision: 3 }] });
});

it("does not use the workspace, names, paths or slug claimed by an event", () => {
  const result = attributeRouteHistoryV2(evidence(), request({ workspaceId: ids.b, workspaceName: "Other", slug: "other", path: "/other/same", serviceName: "other" }));
  expect(result.workspaceId).toBe(ids.a);
  expect(result.effectiveRevision).toBeNull();
});

it("refuses a legacy event even if its environment happens to equal the instance id", () => {
  const r = request();
  expect(attributeRouteHistoryV2(evidence(), { ...r, copies: [{ ...r.copies[0]!, provenance: "legacy" }] }).reason).toBe("attribution-evidence-missing");
});

it("does not infer a complete timeline, copy set or identity directory from missing rows", () => {
  const e = evidence(); const r = request();
  expect(attributeRouteHistoryV2({ ...e, revisionsComplete: false }, r).reason).toBe("attribution-evidence-missing");
  expect(attributeRouteHistoryV2(e, { ...r, copiesComplete: false }).reason).toBe("attribution-evidence-missing");
  expect(attributeRouteHistoryV2({ ...e, identities: e.identities.map((i) => ({ ...i, complete: false })) }, r).reason).toBe("attribution-evidence-missing");
});

it("requires proof of a first revision instead of treating a truncated anchor as genesis", () => {
  const e = evidence();
  expect(attributeRouteHistoryV2({ ...e, firstRevision: null }, request({ ts: "2026-11-04T10:30:00Z" })).reason).toBe("attribution-evidence-missing");
  expect(attributeRouteHistoryV2({ ...e, revisions: [{ ...revision(2), previous: null }] }, request()).reason).toBe("attribution-evidence-missing");
});

it("rejects a missing epoch bridge and an event before the proven map visibility", () => {
  const e = evidence();
  const epoch = { ...revision(3), epoch: 2, revision: 1, previous: null };
  expect(attributeRouteHistoryV2({ ...e, revisions: [...e.revisions, epoch] }, request({ ts: time(13) })).reason).toBe("attribution-evidence-missing");
  expect(attributeRouteHistoryV2({ ...e, revisions: [revision(1), { ...revision(2), visibleAt: time(12) }] }, request()).reason).toBe("attribution-evidence-missing");
});

it("is repeatable and independent of revision, route, identity, membership and copy order", () => {
  for (const c of attributionFixtures()) {
    const reversed = {
      ...c.evidence,
      revisions: [...c.evidence.revisions].reverse().map((r) => ({ ...r, routes: [...r.routes].reverse() })),
      identities: [...c.evidence.identities].reverse().map((i) => ({ ...i, workspaceIds: [...i.workspaceIds].reverse() })),
      clusterHistory: [...c.evidence.clusterHistory].reverse(),
    };
    const copies = { ...c.request, copies: [...c.request.copies].reverse() };
    const before = structuredClone({ evidence: c.evidence, request: c.request });
    const reversedBefore = structuredClone({ evidence: reversed, request: copies });
    expect(attributeRouteHistoryV2(reversed, copies), c.name).toEqual(c.expected);
    expect(attributeRouteHistoryV2(c.evidence, c.request), c.name).toEqual(c.expected);
    expect(attributeRouteHistoryV2(c.evidence, c.request), c.name).toEqual(c.expected);
    expect({ evidence: c.evidence, request: c.request }).toEqual(before);
    expect({ evidence: reversed, request: copies }).toEqual(reversedBefore);
  }
});

it.each(["environmentId", "clusterId", "routeId", "serviceId", "ts", "consumerId", "method", "path", "status", "latencyKongMs", "latencyUpstreamMs", "latencyTotalMs", "clientIp", "requestSize", "responseSize", "retentionDays", "futureLogicalColumn"])("detects conflicting copies before any filtering: %s", (column) => {
  const r = request(); const copy = r.copies[0]!;
  const value = copy.content[column];
  const changed = typeof value === "number" ? value + 1 : typeof value === "string" ? `${value}-different` : "different";
  const other = { ...copy, content: { ...copy.content, [column]: changed } };
  expect(attributeRouteHistoryV2(evidence(), { ...r, copies: [copy, other] }).reason).toBe("conflicting-copies");
  expect(attributeRouteHistoryV2(evidence(), { ...r, copies: [other, copy] }).reason).toBe("conflicting-copies");
});

it("retains a known conflict after only one copy remains physically available", () => {
  const r = request(); const copy = r.copies[0]!;
  const conflict = mergeCopyStates(copyStateOf(copy.id, copy.content), copyStateOf(copy.id, { ...copy.content, retentionDays: 1 }));
  expect(attributeRouteHistoryV2(evidence(), { ...r, retainedCopyState: conflict }).reason).toBe("conflicting-copies");
  expect(attributeRouteHistoryV2(evidence(), { ...r, retainedCopyState: { ...conflict, id: "another-id" } }).reason).toBe("attribution-evidence-missing");
});

it("refuses corrupt retained conflict evidence instead of losing it in a merge", () => {
  const r = request();
  const corrupt = { id: ids.request, minContent: undefined, maxContent: undefined } as unknown as RequestCopyState;
  expect(attributeRouteHistoryV2(evidence(), { ...r, retainedCopyState: corrupt }).reason).toBe("attribution-evidence-missing");
});

it("keeps a nanosecond before a revision boundary outside the new map", () => {
  const e = evidence(); const one = revision(1);
  const history = { ...e, revisions: [{ ...one, routes: one.routes.filter((r) => r.routeId !== ids.route) }, revision(2)] };
  expect(attributeRouteHistoryV2(history, request({ ts: "2026-11-04T10:59:59.999999999Z" }))).toEqual({ policy: "route-history-v2", workspaceId: null, reason: "route-not-deployed", effectiveRevision: null, candidateRevisions: [k1] });
  expect(attributeRouteHistoryV2(history, request({ ts: "2026-11-04T11:00:00.000000001Z" })).workspaceId).toBe(ids.a);
});

it("refuses regressive clocks, impossible instants and observations that precede the event", () => {
  const e = evidence();
  expect(attributeRouteHistoryV2({ ...e, revisions: [revision(1), { ...revision(2), recordedAt: time(9), visibleAt: time(9) }] }, request()).reason).toBe("attribution-evidence-missing");
  for (const ts of ["2026-02-30T11:00:00Z", "2026-11-04T24:00:00Z", "2026-11-04T11:00:00", "bad", "2026-11-04T11:00:00.0000000001Z"]) {
    expect(attributeRouteHistoryV2(e, request({ ts })).reason).toBe("attribution-evidence-missing");
  }
  expect(attributeRouteHistoryV2({ ...e, asOf: time(11) }, request()).reason).toBe("attribution-evidence-missing");
});

it("does not accept a forged genesis on the previous candidate", () => {
  const e = evidence();
  expect(attributeRouteHistoryV2({ ...e, revisions: [{ ...revision(2), previous: null }, revision(3)] }, request({ ts: "2026-11-04T12:30:00Z" })).reason).toBe("attribution-evidence-missing");
});

it("refuses a cross-epoch bridge that skips another known revision", () => {
  const e = evidence();
  const bridge = { ...revision(3), epoch: 2, revision: 1, previous: k1 };
  const current = { ...revision(4), epoch: 2, revision: 2, previous: { epoch: 2, revision: 1 } };
  expect(attributeRouteHistoryV2({ ...e, revisions: [...e.revisions, bridge, current] }, request({ ts: "2026-11-04T13:30:00Z" })).reason).toBe("attribution-evidence-missing");
});

it("does not accept an anchor timestamp before the certified genesis", () => {
  const e = evidence();
  const anchor = { ...revision(2), recordedAt: time(9), visibleAt: time(9) };
  expect(attributeRouteHistoryV2({ ...e, revisions: [anchor, revision(3)] }, request({ ts: "2026-11-04T12:30:00Z" })).reason).toBe("attribution-evidence-missing");
});

it("rejects an inconsistent genesis even when the event precedes the claimed first instant", () => {
  const e = evidence();
  expect(attributeRouteHistoryV2({ ...e, firstRevision: { ...k1, recordedAt: time(12) } }, request()).reason).toBe("attribution-evidence-missing");
});

it("orders equal recorded instants by epoch and revision without inventing the served revision", () => {
  const e = evidence();
  const two = { ...revision(2), recordedAt: time(10), visibleAt: time(10) };
  expect(attributeRouteHistoryV2({ ...e, revisions: [two, revision(1)] }, request({ ts: time(10) }))).toEqual({ policy: "route-history-v2", workspaceId: ids.a, reason: null, effectiveRevision: null, candidateRevisions: [k1, k2] });
});

it("coalesces identical revision evidence, but refuses conflicting immutable maps", () => {
  const e = evidence(); const second = revision(2);
  const reordered = { ...second, routes: [...second.routes].reverse() };
  expect(attributeRouteHistoryV2({ ...e, revisions: [...e.revisions, reordered] }, request()).workspaceId).toBe(ids.a);
  expect(attributeRouteHistoryV2({ ...e, revisions: [...e.revisions, { ...second, visibleAt: time(12) }] }, request()).reason).toBe("attribution-evidence-missing");
});

it("uses half-open historical cluster intervals and refuses overlapping ownership", () => {
  const e = evidence(); const c = e.clusterHistory[0]!;
  const clusterHistory = [{ ...c, validUntil: time(11) }, { ...c, validFrom: time(11), instanceId: ids.foreign }];
  expect(attributeRouteHistoryV2({ ...e, clusterHistory }, request({ ts: "2026-11-04T10:59:59.999999999Z" })).workspaceId).toBe(ids.a);
  expect(attributeRouteHistoryV2({ ...e, clusterHistory }, request({ ts: time(11) })).reason).toBe("unknown-cluster");
  expect(attributeRouteHistoryV2({ ...e, clusterHistory: [c, { ...c, instanceId: ids.foreign }] }, request()).reason).toBe("unknown-cluster");
});

it("keeps copy scalar types and lossless sizes distinct", () => {
  const r = request(); const c = r.copies[0]!;
  for (const changed of [{ requestSize: "9007199254740994" }, { requestSize: 9007199254740993n }, { status: "200" }]) {
    expect(attributeRouteHistoryV2(evidence(), { ...r, copies: [c, { ...c, content: { ...c.content, ...changed } }] }).reason).toBe("conflicting-copies");
  }
});

it("fails closed for an empty copy set, mixed ids and unknown provenance", () => {
  const r = request(); const c = r.copies[0]!;
  expect(attributeRouteHistoryV2(evidence(), { ...r, copies: [] }).reason).toBe("attribution-evidence-missing");
  expect(attributeRouteHistoryV2(evidence(), { ...r, copies: [c, { ...c, id: "another-id" }] }).reason).toBe("attribution-evidence-missing");
  expect(attributeRouteHistoryV2(evidence(), { ...r, copies: [{ ...c, provenance: "unknown" }] }).reason).toBe("attribution-evidence-missing");
});

it("accepts frozen evidence and never mutates shared caller objects", () => {
  const freeze = (value: unknown): void => {
    if (value !== null && typeof value === "object") {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
  };
  for (const c of attributionFixtures()) {
    freeze(c.evidence); freeze(c.request);
    expect(attributeRouteHistoryV2(c.evidence, c.request), c.name).toEqual(c.expected);
  }
});

it("keeps the original reason precedence when several exclusion rules hold", () => {
  const r = request({ environmentId: ids.foreign, clusterId: "unknown-cluster", routeId: null });
  const c = r.copies[0]!;
  expect(attributeRouteHistoryV2(evidence(), { ...r, copies: [c, { ...c, content: { ...c.content, status: 500 } }] }).reason).toBe("conflicting-copies");
  expect(attributeRouteHistoryV2(evidence(), r).reason).toBe("foreign-instance");
  expect(attributeRouteHistoryV2(evidence(), request({ clusterId: "unknown-cluster", routeId: null })).reason).toBe("unknown-cluster");
  expect(attributeRouteHistoryV2(evidence(), request({ routeId: null })).reason).toBe("no-route");
});

it("does not become uniquely attributed again after a later historical owner is known", () => {
  const e = evidence();
  const future = { ...revision(3), routes: revision(3).routes.map((r) => r.routeId === ids.route ? { ...r, workspaceId: ids.b } : r) };
  expect(attributeRouteHistoryV2({ ...e, revisions: [...e.revisions, future] }, request({ ts: "2026-11-04T10:30:00Z" })).reason).toBe("ambiguous-route");
});

it("keeps boundaries within the same millisecond exact", () => {
  const e = evidence(); const one = revision(1);
  const boundary = "2026-11-04T11:00:00.000000500Z";
  const revisions = [{ ...one, routes: one.routes.filter((r) => r.routeId !== ids.route) }, { ...revision(2), recordedAt: boundary, visibleAt: boundary }];
  expect(attributeRouteHistoryV2({ ...e, revisions }, request({ ts: "2026-11-04T11:00:00.000000499Z" })).reason).toBe("route-not-deployed");
  expect(attributeRouteHistoryV2({ ...e, revisions }, request({ ts: boundary })).workspaceId).toBe(ids.a);
});

it("gives the literal result for every permutation of the supplied revisions", () => {
  const permutations = <T,>(items: readonly T[]): T[][] => items.length === 0 ? [[]] : items.flatMap((item, i) => permutations(items.filter((_, j) => i !== j)).map((rest) => [item, ...rest]));
  for (const c of attributionFixtures()) {
    for (const revisions of permutations(c.evidence.revisions)) {
      const copies = c.request.copies.map((copy) => ({ ...copy, content: Object.fromEntries(Object.entries(copy.content).reverse()) as typeof copy.content }));
      expect(attributeRouteHistoryV2({ ...c.evidence, revisions }, { ...c.request, copies }), c.name).toEqual(c.expected);
    }
  }
});
