import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { contractsV2 } from "../../src/common/contract.js";

interface Example { summary: string; value: Record<string, unknown> }
interface Media {
  schema: { $ref: string };
  examples: Record<string, { $ref: string }>;
}
interface Operation {
  operationId: string;
  description: string;
  security?: Record<string, string[]>[];
  "x-gromesh-planned": boolean;
  "x-gromesh-phase": string;
  "x-required-permission": string;
  "x-scope": string;
  "x-gromesh-requirements": string[];
  parameters?: { $ref: string }[];
  requestBody?: { content: Record<string, Media> };
  responses: Record<string, { content?: Record<string, Media> }>;
}
const read = (file: string) => readFileSync(new URL(`../../../../contracts/${file}`, import.meta.url), "utf8");
const doc = parse(read("control-plane-v2.openapi.yaml")) as {
  paths: Record<string, { get: Operation; post: Operation }>;
  info: { description: string };
  components: { schemas: { WorkspaceGlobalPluginWrite: { properties: { name: { enum: string[] } } } } };
};
const path = "/workspaces/{workspaceId}/global-plugins";
const ops = doc.paths[path]!;
const vector = JSON.parse(read("examples/workspace-global-plugins.example.json")) as {
  requests: Record<string, Example>;
  responses: Record<string, Example>;
  conflicts: Record<string, Example>;
  validation: Record<string, Example>;
  invalidWrites: Record<string, unknown>[];
};
const validate = (schema: string, value: unknown) => {
  const fn = contractsV2.validator(schema);
  return { valid: fn(structuredClone(value)), errors: fn.errors };
};
const pointer = `#/paths/${path.replaceAll("/", "~1")}`;

describe("Workspace-global plugin contract (WS-L9, no handlers)", () => {
  it("keeps both operations planned in L9 with the existing permissions and session mutation", () => {
    for (const [method, id, permission] of [
      ["get", "listWorkspaceGlobalPlugins", "workspace.read"],
      ["post", "createWorkspaceGlobalPlugin", "workspace.admin"],
    ] as const) {
      expect(ops[method]).toMatchObject({ operationId: id, "x-gromesh-planned": true,
        "x-gromesh-phase": "L9", "x-required-permission": permission, "x-scope": "workspace" });
      expect(ops[method]["x-gromesh-requirements"]).toContain("GW-PLG-04");
      for (const status of ["401", "403", "404"]) expect(ops[method].responses[status]).toBeDefined();
    }
    expect(ops.post.security).toEqual([{ cookieAuth: [], csrfToken: [] }]);
    expect(ops.get.parameters?.map(p => p.$ref.split("/").at(-1))).toEqual(["Limit", "Cursor"]);
  });

  it("validates every linked request/response example against its actual operation schema", () => {
    const cases = [
      ["post/requestBody/content/application~1json", ops.post.requestBody!.content["application/json"]!],
      ["get/responses/200/content/application~1json", ops.get.responses["200"]!.content!["application/json"]!],
      ...["201", "409", "422"].map(status => [
        `post/responses/${status}/content/${status === "201" ? "application~1json" : "application~1problem+json"}`,
        ops.post.responses[status]!.content![status === "201" ? "application/json" : "application/problem+json"]!,
      ] as const),
    ] as const;
    for (const [suffix, media] of cases) {
      expect(Object.keys(media.examples).length).toBeGreaterThan(0);
      for (const example of Object.values(media.examples)) {
        const [file, fragment] = example.$ref.split("#/");
        expect(file).toBe("./examples/workspace-global-plugins.example.json");
        const [group, name] = fragment!.split("/") as [keyof typeof vector, string];
        const examples = vector[group] as Record<string, Example>;
        expect(validate(`${pointer}/${suffix}/schema`, examples[name]!.value)).toMatchObject({ valid: true });
      }
    }
  });

  it.each(vector.invalidWrites)("rejects an ineligible L9 name: $name", body => {
    expect(validate("WorkspaceGlobalPluginWrite", body).valid).toBe(false);
  });

  it("classifies every pinned catalog name and never admits a new catalog plugin implicitly", () => {
    const catalog = JSON.parse(readFileSync(new URL("../../src/plugin-catalog/kong-3.9/_catalog.json", import.meta.url), "utf8")) as { items: { name: string }[] };
    const denied = vector.invalidWrites.map(v => v.name).filter(n => !["gromesh-workspace", "unknown-plugin"].includes(String(n)));
    const admitted = doc.components.schemas.WorkspaceGlobalPluginWrite.properties.name.enum;
    expect(new Set([...admitted, ...denied]).size).toBe(admitted.length + denied.length);
    expect([...admitted, ...denied].sort()).toEqual(catalog.items.map(p => p.name).sort());
    for (const name of admitted) expect(validate("WorkspaceGlobalPluginWrite", { name, config: {} }).valid).toBe(true);
    // Config, mandatory names and effective authentication need semantic validation; {} above proves only shape.
  });

  it.each([
    {}, { name: "cors" }, { config: {} }, { name: "cors", config: [] },
    { name: "cors", config: {}, scope: {} }, { name: "cors", config: {}, routeId: "ignored" },
    { name: "cors", config: {}, serviceId: "ignored" }, { name: "cors", config: {}, consumerId: "ignored" },
    { name: "cors", config: {}, workspaceId: "ignored" }, { name: "cors", config: {}, id: "ignored" },
    { name: "cors", config: {}, protocols: [] }, { name: "cors", config: {}, protocols: ["http", "http"] },
    { name: "cors", config: {}, protocols: ["invalid"] }, { name: "cors", config: {}, enabled: "false" },
  ])("rejects malformed or scoped global writes: %j", body => {
    expect(validate("WorkspaceGlobalPluginWrite", body).valid).toBe(false);
  });

  it("accepts disabled logical records but requires a closed, paginated logical response", () => {
    expect(validate("WorkspaceGlobalPluginWrite", { name: "cors", enabled: false, config: {} }).valid).toBe(true);
    const record = vector.responses.created!.value;
    expect(validate("WorkspaceGlobalPlugin", { ...record, enabled: false }).valid).toBe(true);
    expect(validate("WorkspaceGlobalPlugin", { ...record, scope: { routeId: record.id } }).valid).toBe(false);
    expect(validate("WorkspaceGlobalPluginPage", { items: [record] }).valid).toBe(false);
    expect(validate("WorkspaceGlobalPluginPage", { items: [], nextCursor: null }).valid).toBe(true);
    expect(validate("WorkspaceGlobalPluginPage", { items: [], nextCursor: "opaque" }).valid).toBe(true);
    expect(validate("WorkspaceGlobalPluginPage", { items: [], nextCursor: null, derived: [] }).valid).toBe(false);
  });

  it("rejects untyped/misclassified problems and requires useful field paths", () => {
    for (const [group, schema, wrongStatus] of [
      [vector.conflicts, "WorkspaceGlobalPluginConflict", 422],
      [vector.validation, "WorkspaceGlobalPluginValidationProblem", 409],
    ] as const) for (const { value } of Object.values(group)) {
      expect(validate(schema, value).valid).toBe(true);
      expect(validate(schema, { ...value, status: wrongStatus }).valid).toBe(false);
      expect(validate(schema, { ...value, code: "unknown-code" }).valid).toBe(false);
      const { code: _code, ...withoutCode } = value;
      expect(validate(schema, withoutCode).valid).toBe(false);
    }
    const duplicate = vector.conflicts.duplicate!.value;
    expect(validate("WorkspaceGlobalPluginConflict", { ...duplicate, errors: [] }).valid).toBe(false);
    expect(validate("WorkspaceGlobalPluginConflict", { ...duplicate, errors: [{ path: "config", message: "duplicate" }] }).valid).toBe(false);
    const invalid = vector.validation.invalidConfig!.value;
    const { errors: _errors, ...withoutErrors } = invalid;
    for (const value of [withoutErrors, { ...invalid, errors: [] }, { ...invalid, errors: [{ path: "", message: "invalid" }] }]) {
      expect(validate("WorkspaceGlobalPluginValidationProblem", value).valid).toBe(false);
    }
  });

  it("records draft-only, locking and composition guarantees without implementing them", () => {
    for (const text of ["409 auto-publish", "shared Workspace transaction lock", "workspace.global-plugin.create", "redacted after state", "409 concurrent-update"]) {
      expect(ops.post.description).toContain(text);
    }
    for (const text of ["complete replacements", "disabled record", "unsafe-auth-composition", "consumer-required", "Derived IDs are stable", "never a node-global instance"]) {
      expect(doc.info.description).toContain(text);
    }
  });
});
