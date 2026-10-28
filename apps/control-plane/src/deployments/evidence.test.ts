import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { evidenceOf, type ExpectedOfNode } from "./evidence.js";

// The control plane's reading of convergence evidence against the contract's normative vector (N3-K1): every case.
const vector = JSON.parse(readFileSync(new URL("../../../../contracts/examples/delivery-v2.example.json", import.meta.url), "utf8")) as {
  expected: Record<string, unknown>;
  cases: { name: string; expected?: Record<string, unknown>; status?: Record<string, unknown>; probe?: Record<string, unknown>; receivedAt?: string; evidence: string }[];
};

const expectedOf = (e: Record<string, unknown>): ExpectedOfNode => ({
  ...(e as unknown as ExpectedOfNode),
  revisionRecordedAt: new Date(e.revisionRecordedAt as string),
  now: new Date(e.now as string),
});

it.each(vector.cases.map((c) => [c.name, c] as const))("reads %s as the contract does", (_name, c) => {
  const status = c.status ? { nodeId: c.status.nodeId as string, epoch: c.status.epoch as number, appliedRevision: c.status.appliedRevision as number | null, appliedHash: c.status.appliedHash as string | null, kongConfigHash: (c.status.kongConfigHash as string | null | undefined) ?? null } : null;
  expect(evidenceOf(expectedOf(c.expected ?? vector.expected), status, (c.probe ?? null) as never, c.receivedAt ? new Date(c.receivedAt) : null)).toBe(c.evidence);
});

it("covers every ConvergenceEvidence value", () => {
  expect(new Set(vector.cases.map((c) => c.evidence)).size).toBe(7);
});
