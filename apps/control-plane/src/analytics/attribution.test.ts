import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { type AnalyticsRow, type Attribution, attributionOf, readsOf } from "./attribution.js";

// The control plane's attribution against the contract's normative vector (N3-A1, analytics-v2.example.json): every case.
type Row = AnalyticsRow & { id: string };
const vector = JSON.parse(readFileSync(new URL("../../../../contracts/examples/analytics-v2.example.json", import.meta.url), "utf8")) as {
  attributionOf: { attribution: Attribution; cases: { name: string; event: AnalyticsRow; copies?: AnalyticsRow[]; expected: unknown }[] };
  readsOf: { cases: { name: string; rows: Row[]; routeFilter: string | null; expected: unknown }[] };
};
const { attribution } = vector.attributionOf;

it.each(vector.attributionOf.cases.map((c) => [c.name, c] as const))("attributes %s as the contract says", (_name, c) => {
  expect(attributionOf(attribution, c.event, c.copies)).toEqual(c.expected);
  // Order never changes the answer.
  if (c.copies) expect(attributionOf(attribution, c.event, [...c.copies].reverse())).toEqual(c.expected);
});

it.each(vector.readsOf.cases.map((c) => [c.name, c] as const))("reads %s as the contract says", (_name, c) => {
  expect(readsOf(attribution, c.rows, c.routeFilter)).toEqual(c.expected);
});

it("never attributes by the path or by a workspace an event names: only the route in the revisions does", () => {
  const [ok] = vector.attributionOf.cases;
  const forged = { ...ok!.event, path: "/other-workspace/api", workspaceId: "b0000000-0000-4000-8000-00000000000b" };
  expect(attributionOf(attribution, forged)).toEqual(ok!.expected);
  // The revisions' order in the input is irrelevant.
  expect(attributionOf({ ...attribution, revisions: [...attribution.revisions].reverse() }, ok!.event)).toEqual(ok!.expected);
});

it("never depends on the order the revisions come in: every case reads the same with them reversed", () => {
  const reversed = { ...attribution, revisions: [...attribution.revisions].reverse() };
  for (const c of vector.attributionOf.cases) expect(attributionOf(reversed, c.event, c.copies), c.name).toEqual(c.expected);
});

it("treats a difference in any column as a conflict, the path included", () => {
  const [ok] = vector.attributionOf.cases;
  const a = { ...ok!.event, path: "/a" }, b = { ...ok!.event, path: "/b" };
  expect(attributionOf(attribution, a, [a, b])).toEqual({ workspace: null, reason: "conflicting-copies" });
  expect(attributionOf(attribution, a, [a, { ...a }])).toEqual(ok!.expected);
});

it("gives the contract's first reason when several hold", () => {
  const [ok] = vector.attributionOf.cases;
  const e = ok!.event;
  const foreign = { ...e, environmentId: "11111111-1111-4111-8111-111111111111", clusterId: "22222222-2222-4222-8222-222222222222", routeId: null };
  expect(attributionOf(attribution, foreign, [foreign, { ...foreign, status: 500 }]).reason).toBe("conflicting-copies");
  expect(attributionOf(attribution, foreign).reason).toBe("foreign-instance");
  expect(attributionOf(attribution, { ...e, clusterId: "22222222-2222-4222-8222-222222222222", routeId: null }).reason).toBe("unknown-cluster");
  expect(attributionOf(attribution, { ...e, routeId: null, ts: "2000-01-01T00:00:00Z" }).reason).toBe("no-route");
});

it("counts a route listed twice by the same workspace as one owner", () => {
  const [ok] = vector.attributionOf.cases;
  const doubled = { ...attribution, revisions: attribution.revisions.map((r) => ({ ...r, routes: Object.fromEntries(Object.entries(r.routes).map(([w, routes]) => [w, [...routes, ...routes]])) })) };
  expect(attributionOf(doubled, ok!.event)).toEqual(ok!.expected);
});

it("refuses an impossible or malformed instant instead of attributing it", () => {
  const [ok] = vector.attributionOf.cases;
  for (const ts of ["2026-02-30T12:00:00Z", "2026-10-28T24:00:00Z", "2026-10-28T10:30:00", "invalid", "2026-10-28T10:30:00+01:00"]) {
    expect(() => attributionOf(attribution, { ...ok!.event, ts }), ts).toThrow(/RFC 3339/);
  }
  expect(attributionOf(attribution, { ...ok!.event, ts: "2026-10-28T10:30:00.123Z" })).toEqual(ok!.expected);
});
