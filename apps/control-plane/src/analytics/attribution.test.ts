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
