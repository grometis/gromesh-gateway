import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { test } from "vitest";
import { parse } from "yaml";

// P5-C0: environment roles in the contract, before any handler exists.
type Doc = any;
const contract: Doc = parse(readFileSync(new URL("../../../../contracts/control-plane.openapi.yaml", import.meta.url), "utf8"));
const ajv = new Ajv2020.default({ allErrors: true, strict: false });
addFormats.default(ajv);
ajv.addSchema({ ...contract, $id: "control-plane" });
const valid = (name: string, value: unknown) => ajv.getSchema(`control-plane#/components/schemas/${name}`)!(value);
const env = "0b3c6b5e-8d1f-4a51-9c64-2f0f6d1f8a11";

test("the new operations are planned, global-admin only, and the write needs CSRF", () => {
  const path = contract.paths["/users/{userId}/environment-roles"];
  for (const op of [path.get, path.put]) {
    assert.equal(op["x-gromesh-planned"], true);
    assert.equal(op["x-required-role"], "admin");
  }
  assert.deepEqual(path.get.security, [{ cookieAuth: [] }]);
  assert.deepEqual(path.put.security, [{ cookieAuth: [], csrfToken: [] }]);
  assert.ok(path.put.responses[422] && path.put.responses[404]);
});

test("an environment role is viewer, editor, admin or none, one object per environment", () => {
  for (const role of ["viewer", "editor", "admin", "none"]) assert.equal(valid("EnvironmentRoles", { items: [{ environmentId: env, role }] }), true);
  assert.equal(valid("EnvironmentRoles", { items: [] }), true);
  assert.equal(valid("EnvironmentRoles", { items: [{ environmentId: env, role: "owner" }] }), false);
  assert.equal(valid("EnvironmentRoles", { items: [{ environmentId: "not-a-uuid", role: "viewer" }] }), false);
  assert.equal(valid("EnvironmentRoles", { items: [{ environmentId: env, role: "viewer", extra: true }] }), false);
  assert.equal(valid("EnvironmentRoles", {}), false);
});

test("/me keeps the user and adds environmentRoles; the conventions state the effective-role rules", () => {
  const me = contract.paths["/me"].get.responses[200].content["application/json"];
  assert.equal(me.schema.$ref, "#/components/schemas/Me");
  assert.equal(valid("Me", me.example), true);
  assert.equal(valid("Me", { ...me.example, environmentRoles: undefined }), true);
  const text: string = contract.info.description;
  for (const rule of ["answers 404, never 403", "An environment `admin` does not manage users", "min(the token's role, its owner's effective role", "a global admin sees all"]) {
    assert.ok(text.includes(rule), rule);
  }
});
