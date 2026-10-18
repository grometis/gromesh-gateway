import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parse } from "yaml";
import { contracts } from "../../src/common/contract.js";

// B-16 contract: a Kong import with `_transform: false` and a hash salted with a preserved consumer id.
const contract = parse(readFileSync(new URL("../../../../contracts/control-plane.openapi.yaml", import.meta.url), "utf8")) as {
  paths: Record<string, Record<string, { description?: string }>>;
};
const text = contract.paths["/environments/{envId}/import"]!.post!.description!;

test("the import envelope accepts a Kong document with _transform: false, a consumer id and a 40-hex password", () => {
  const request = {
    sourceFormat: "kong-declarative-3.0",
    mode: "merge",
    dryRun: true,
    document: {
      _format_version: "3.0",
      _transform: false,
      consumers: [{ id: "6d1f0b2a-3c4e-4f50-9a6b-7c8d9e0f1a2b", username: "migrated", basicauth_credentials: [{ username: "login", password: "a".repeat(40) }] }],
    },
  };
  const validator = contracts.validator("EnvironmentImportRequest");
  expect(validator(request), JSON.stringify(validator.errors)).toBe(true);
});

test("the text pins the id form, the error paths and the REDACTED rule", () => {
  for (const rule of [
    "lowercase canonical UUID",
    "one error per affected credential at its password path and no other paths",
    "`id` used by a consumer of another environment: the password path and `document.consumers.N.id`",
    "an omitted or REDACTED password still requires",
    "reveals only that the id is unavailable, never where",
  ]) expect(text, rule).toContain(rule);
});
