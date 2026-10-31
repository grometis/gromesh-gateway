import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { copyStateOf, mergeCopyStates, readCopyState } from "./copy-state.js";

const row = {
  ts: "2026-10-28T12:00:00.000Z", environmentId: "instance-a", clusterId: "cluster-a",
  serviceId: null, routeId: "route-a", consumerId: null, method: "GET", path: "/a", status: 200,
  latencyKongMs: 1, latencyUpstreamMs: null, latencyTotalMs: 2, clientIp: "::1",
  requestSize: 9007199254740992n, responseSize: 10n, retentionDays: 7,
};

it("counts retries once before merges and never conflates different request ids", () => {
  const a = copyStateOf("request-a", row);
  expect(mergeCopyStates(a, a)).toEqual(a);
  expect(readCopyState(a)).toEqual({ kind: "identical", content: a.minContent });
  expect(() => mergeCopyStates(a, copyStateOf("request-b", row))).toThrow(/different request ids/);
});

it.each(Object.keys(row))("preserves a conflict in %s, including copies outside read filters", (column) => {
  const a = copyStateOf("request-a", row);
  const value = row[column as keyof typeof row];
  const changed = typeof value === "number" ? value + 1 : typeof value === "bigint" ? value + 1n : value === null ? "present" : `${value}-different`;
  const b = copyStateOf("request-a", { ...row, [column]: changed });
  expect(readCopyState(mergeCopyStates(a, b))).toEqual({ kind: "conflicting-copies" });
  expect(mergeCopyStates(a, b)).toEqual(mergeCopyStates(b, a));
  expect(readCopyState(mergeCopyStates(mergeCopyStates(a, b), a))).toEqual({ kind: "conflicting-copies" });
});

it("is associative across out-of-order blocks, backfill and retried batches", () => {
  const a = copyStateOf("request-a", row);
  const b = copyStateOf("request-a", { ...row, path: "/b" });
  const c = copyStateOf("request-a", { ...row, path: "/c" });
  expect(mergeCopyStates(mergeCopyStates(a, b), c)).toEqual(mergeCopyStates(a, mergeCopyStates(c, b)));
  expect(mergeCopyStates(mergeCopyStates(a, b), mergeCopyStates(c, a))).toEqual(mergeCopyStates(a, mergeCopyStates(b, c)));
});

it("uses exact typed content rather than a digest, numeric coercion or an arbitrary representative", () => {
  const of = (value: unknown) => copyStateOf("request-a", { value });
  for (const [a, b] of [[null, "null"], [1, "1"], [0, -0], [9007199254740992n, 9007199254740993n]]) {
    expect(readCopyState(mergeCopyStates(of(a), of(b)))).toEqual({ kind: "conflicting-copies" });
  }
  expect(copyStateOf("a", { b: 2, a: 1 })).toEqual(copyStateOf("a", { a: 1, b: 2 }));
  for (const value of [undefined, NaN, Infinity, {}, []]) expect(() => of(value)).toThrow(/stored scalar/);
});

it("captures a value at ingestion, unaffected by later mutation of the input", () => {
  const mutable = { ...row };
  const state = copyStateOf("a", mutable);
  mutable.status = 500;
  expect(state).toEqual(copyStateOf("a", row));
});

const vector = JSON.parse(readFileSync(new URL("../../../../contracts/examples/analytics-v2.example.json", import.meta.url), "utf8")) as {
  attributionOf: { cases: { name: string; event: Record<string, unknown>; copies?: Record<string, unknown>[]; expected: { reason: string | null } }[] };
};
it.each(vector.attributionOf.cases)("reduces the normative #195 copies: $name", (c) => {
  const states = (c.copies ?? [c.event]).map((r) => copyStateOf("same-request", r));
  const reduced = states.reduce(mergeCopyStates);
  expect(readCopyState(reduced).kind).toBe(c.expected.reason === "conflicting-copies" ? "conflicting-copies" : "identical");
  expect([...states].reverse().reduce(mergeCopyStates)).toEqual(reduced);
});
