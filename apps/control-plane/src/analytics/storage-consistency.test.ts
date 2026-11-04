import { expect, it } from "vitest";
import { foldStorageCopies, evaluateStorageEvidence } from "./storage-consistency.js";
const id = "12345678-1234-1234-1234-123456789abc";
const content = { environmentId: "10000000-0000-4000-8000-000000000001", clusterId: "20000000-0000-4000-8000-000000000001", routeId: "30000000-0000-4000-8000-000000000001", serviceId: null, consumerId: null, ts: "2026-11-01T00:00:00.000Z", method: "GET", path: "/same", status: 200, latencyKongMs: 1, latencyUpstreamMs: null, latencyTotalMs: 2, clientIp: "192.0.2.123", requestSize: "9007199254740993", responseSize: "10", retentionDays: 1 };
const copy = (delta: Readonly<Record<string, unknown>> = {}) => ({ id, provenance: "workspace-v2" as const, content: { ...content, ...delta } });
const budget = { maxRows: 1000, maxDecodedBytes: 1048576 };
const proof = { asOf: "2026-11-01T12:00:00.000Z", copiesComplete: true, conflictHistoryComplete: true, coherentSnapshot: true };
const fold = (copies: Iterable<ReturnType<typeof copy>>, previous: ReturnType<typeof foldStorageCopies>["evidence"] = null) => foldStorageCopies({ id, previous, copies, budget });
it("deduplicates identical retries exactly and does not mutate input", () => {
    const c = copy();
    const a = fold([c, c]);
    expect(a.evidence?.kind).toBe("identical");
    expect(a.usage.rows).toBe(2);
    const decision = evaluateStorageEvidence(a.evidence, proof);
    expect(decision.kind).toBe("ready");
    c.content.status = 500;
    expect(evaluateStorageEvidence(a.evidence, proof)).toEqual(decision);
});
it.each(["status", "environmentId", "clusterId", "serviceId", "routeId", "retentionDays", "ts", "requestSize", "futureLogicalColumn"])("keeps a conflict in %s without selecting a representative", field => {
    const value = content[field as keyof typeof content];
    const changed = field === "retentionDays" ? 7 : field === "ts" ? "2026-11-01T01:00:00.000Z" : typeof value === "number" ? value + 1 : value === null ? "present" : "different";
    const a = fold([copy(), copy({ [field]: changed })]);
    expect(a.evidence?.kind).toBe("conflicting-copies");
    expect(evaluateStorageEvidence(a.evidence, proof).kind).toBe("conflicting-copies");
    expect(JSON.stringify(a.evidence)).not.toContain(content.clientIp);
    expect(JSON.stringify(a.evidence)).not.toContain(content.path);
});
it("does not lose conflict history when only one copy remains after a restart", () => {
    const conflicted = fold([copy(), copy({ status: 500 })]);
    const restarted = fold([copy()], conflicted.evidence);
    expect(restarted.evidence?.kind).toBe("conflicting-copies");
});
it("detects a late conflict after the first successful read", () => {
    const first = fold([copy()]);
    expect(evaluateStorageEvidence(first.evidence, proof).kind).toBe("ready");
    const later = fold([copy({ status: 500 })], first.evidence);
    expect(evaluateStorageEvidence(later.evidence, proof).kind).toBe("conflicting-copies");
});
it("includes copies outside candidate filters and temporal windows before any filtering", () => {
    const a = fold([copy(), copy({ ts: "2026-10-31T00:00:00.000Z", status: 500, environmentId: "foreign-instance" })]);
    expect(evaluateStorageEvidence(a.evidence, proof).kind).toBe("conflicting-copies");
});
it("retains conflict only until the maximum original expiry, never from ingestion time", () => {
    const a = fold([copy(), copy({ retentionDays: 7 })]);
    expect(a.evidence?.expiresAt).toBe("2026-11-08T00:00:00.000Z");
    expect(evaluateStorageEvidence(a.evidence, { ...proof, asOf: "2026-11-02T00:00:00.000Z" }).kind).toBe("conflicting-copies");
    expect(evaluateStorageEvidence(a.evidence, { ...proof, asOf: "2026-11-08T00:00:00.000Z" }).kind).toBe("expired");
});
it("uses a half-open original TTL for identical rows", () => {
    const a = fold([copy()]);
    expect(evaluateStorageEvidence(a.evidence, { ...proof, asOf: "2026-11-02T00:00:00.000Z" }).kind).toBe("expired");
});
it.each(["copiesComplete", "conflictHistoryComplete", "coherentSnapshot"] as const)("does not infer %s from a successful lookup", field => {
    const a = fold([copy()]);
    expect(evaluateStorageEvidence(a.evidence, { ...proof, [field]: false }).kind).toBe("not-ready");
});
it("does not upgrade unknown provenance from later trusted copies", () => {
    const a = foldStorageCopies({ id, previous: null, copies: [{ ...copy(), provenance: "unknown" }], budget });
    const b = fold([copy()], a.evidence);
    expect(evaluateStorageEvidence(b.evidence, proof).kind).toBe("not-ready");
});
it("is associative, commutative and idempotent across batches", () => {
    const a = copy(), b = copy({ status: 500 }), c = copy({ retentionDays: 7 });
    const direct = fold([a, b, c]);
    expect(fold([c, b, a]).evidence).toEqual(direct.evidence);
    expect(fold([c], fold([a, b]).evidence).evidence).toEqual(direct.evidence);
    expect(fold([a, b, c], direct.evidence).evidence).toEqual(direct.evidence);
});
it("preserves UInt64 and scalar types without numeric rounding", () => {
    const a = fold([copy(), copy({ requestSize: "9007199254740992" })]);
    expect(a.evidence?.kind).toBe("conflicting-copies");
});
it.each([0, 8, 1.5, NaN])("refuses invalid retention %s", retentionDays => {
    expect(() => fold([copy({ retentionDays })])).toThrow();
});
it.each(["2026-02-30T00:00:00.000Z", "2026-11-01T24:00:00Z", "2026-11-01", "bad"])("refuses invalid timestamps %s", ts => {
    expect(() => fold([copy({ ts })])).toThrow();
});
it("refuses grouping another request id", () => {
    expect(() => foldStorageCopies({ id, previous: null, copies: [{ ...copy(), id: "22345678-1234-1234-1234-123456789abc" }], budget })).toThrow();
});
it("throws on row or decoded-byte budget exhaustion", () => {
    expect(() => foldStorageCopies({ id, previous: null, copies: [copy(), copy()], budget: { ...budget, maxRows: 1 } })).toThrow(/budget/i);
    expect(() => foldStorageCopies({ id, previous: null, copies: [copy()], budget: { ...budget, maxDecodedBytes: 1 } })).toThrow(/budget/i);
});
it("does not certify missing evidence as an empty successful request", () => {
    expect(evaluateStorageEvidence(null, proof).kind).toBe("not-ready");
});
it("does not trust a deserialized identical evidence with an extended TTL", () => {
    const a = fold([copy()]).evidence!;
    expect(() => evaluateStorageEvidence({ ...a, expiresAt: "2026-11-08T00:00:00.000Z" }, proof)).toThrow();
});
it("validates deserialized evidence identity before serving", () => {
    const a = fold([copy()]).evidence!;
    expect(() => evaluateStorageEvidence({ ...a, id: "not-a-normative-id" }, proof)).toThrow();
});
it("does not accept a forged typed payload in retained evidence", () => {
    const a = fold([copy()]).evidence!;
    if (a.kind !== "identical")
        throw Error("fixture");
    expect(() => evaluateStorageEvidence({ ...a, content: { ...a.content, futureLogicalColumn: { nested: true } } }, proof)).toThrow();
});
it("never includes sensitive content in a sticky conflict retained beyond the shorter copy's TTL", () => {
    const a = fold([copy(), copy({ retentionDays: 7 })]).evidence!;
    expect(Object.keys(a).sort()).toEqual(["expiresAt", "id", "kind", "provenanceComplete"]);
    expect(evaluateStorageEvidence(a, { ...proof, asOf: "2026-11-07T00:00:00.000Z" })).toEqual({ kind: "conflicting-copies" });
});
it("preserves submillisecond observation boundaries from the PostgreSQL clock", () => {
    const a = fold([copy()]).evidence;
    expect(evaluateStorageEvidence(a, { ...proof, asOf: "2026-11-01T12:00:00.000001Z" }).kind).toBe("ready");
    expect(evaluateStorageEvidence(a, { ...proof, asOf: "2026-11-01T23:59:59.999999999Z" }).kind).toBe("ready");
    expect(evaluateStorageEvidence(a, { ...proof, asOf: "2026-11-02T00:00:00.000000001Z" }).kind).toBe("expired");
});
