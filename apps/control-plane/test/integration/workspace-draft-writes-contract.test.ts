import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { contractsV2 } from "../../src/common/contract.js";

interface Operation {
  operationId?: string;
  description?: string;
  "x-gromesh-planned"?: boolean;
  "x-required-permission"?: string;
  responses?: Record<string, { description?: string }>;
}
const doc = parse(readFileSync(new URL("../../../../contracts/control-plane-v2.openapi.yaml", import.meta.url), "utf8")) as { paths: Record<string, Record<string, Operation>> };
const operations = Object.entries(doc.paths).flatMap(([path, item]) => Object.entries(item).map(([method, op]) => ({ path, method, op })));
const ids = [
  "createConsumer",
  "replaceConsumer",
  "deleteConsumer",
  "createKeyAuthCredential",
  "deleteKeyAuthCredential",
  "rotateKeyAuthCredential",
  "createJwtCredential",
  "deleteJwtCredential",
  "rotateJwtCredential",
  "createBasicAuthCredential",
  "deleteBasicAuthCredential",
  "replaceConsumerAclGroups",
  "createUpstream",
  "replaceUpstream",
  "deleteUpstream",
  "createTarget",
  "replaceTarget",
  "deleteTarget",
  "createCertificate",
  "replaceCertificate",
  "deleteCertificate",
  "deletePlugin",
  "declareWorkspaceVariable",
  "deleteWorkspaceVariable",
];

describe("complementary draft-only v2 contract (WS-R4)", () => {
  it.each(ids)("documents %s as draft-only and validates the auto-publish refusal", (id) => {
    const matches = operations.filter(({ op }) => op.operationId === id);
    expect(matches).toHaveLength(1);
    const { path, method, op } = matches[0]!;
    expect(op["x-gromesh-planned"]).toBeUndefined();
    expect(op["x-required-permission"]).toBe("gateway.write");
    expect(op.description).toContain("Edits the draft only (no publish, no deployment)");
    expect(op.description).toContain("(publishMode auto) it answers 409 auto-publish and writes nothing");
    expect(op.responses?.["409"]?.description).toContain("auto-publish");
    const pointer = `#/paths/${path.replaceAll("~", "~0").replaceAll("/", "~1")}/${method}/responses/409/content/application~1problem+json/schema`;
    const validate = contractsV2.validator(pointer);
    expect(validate({ type: "https://gromesh.dev/problems/auto-publish", title: "Conflict", status: 409, code: "auto-publish", detail: "Switch to manual publishing" })).toBe(true);
  });
  it("keeps instance-local values outside the draft-only refusal", () => {
    const op = operations.find(({ op }) => op.operationId === "setWorkspaceValue")!.op;
    expect(op.description).not.toContain("auto-publish");
  });
});
