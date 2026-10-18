import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parse } from "yaml";
import { contracts } from "../../src/common/contract.js";

const routeId = "00000000-0000-4000-8000-000000000001";
const serviceId = "00000000-0000-4000-8000-000000000002";
const document = (route: Record<string, unknown>) => ({
  apiVersion: "gromesh/v1",
  services: [{ name: "api", protocol: "http", host: "api.internal", port: 80 }],
  routes: [route],
  consumers: [],
  plugins: [],
  upstreams: [],
  certificates: [],
});

function validateRetention(value: unknown, expected: boolean) {
  const retention = value === undefined ? {} : { analyticsRetentionDays: value };
  const write = { name: "sensitive", serviceId, paths: ["/sensitive"], ...retention };
  const exported = { name: "sensitive", service: "api", paths: ["/sensitive"], ...retention };
  const config = document(exported);
  const cases: [string, unknown][] = [
    ["RouteWrite", write],
    ["Route", { ...write, id: routeId, createdAt: "2026-10-18T00:00:00Z", updatedAt: "2026-10-18T00:00:00Z" }],
    ["GromeshConfigRoute", exported],
    ["GromeshConfigV1", config],
    ["GromeshConfigV1Export", config],
    ["EnvironmentImportRequest", { document: config, mode: "merge", dryRun: true }],
  ];
  for (const [schema, data] of cases) {
    const validator = contracts.validator(schema);
    const valid = validator(data);
    expect(valid, `${schema}: ${JSON.stringify(validator.errors)}`).toBe(expected);
  }
}

test.each([undefined, null, 1, 7])("route contracts accept analyticsRetentionDays=%s", (value) => {
  validateRetention(value, true);
});

test.each([0, 8, 1.5, -1, "1", true])("route contracts reject analyticsRetentionDays=%s", (value) => {
  validateRetention(value, false);
});

test("an exported route still rejects unknown fields next to the new one", () => {
  const validator = contracts.validator("GromeshConfigRoute");
  expect(validator({ name: "sensitive", service: "api", paths: ["/sensitive"], analyticsRetentionDays: 1, bogus: 1 })).toBe(false);
});

test("retention remains an optional planned property in both route models", () => {
  type Schema = { required?: string[]; properties: Record<string, Record<string, unknown>> };
  const contract = parse(readFileSync(new URL("../../../../contracts/control-plane.openapi.yaml", import.meta.url), "utf8")) as {
    components: { schemas: Record<string, Schema> };
  };
  for (const name of ["RouteWrite", "GromeshConfigRoute"]) {
    const schema = contract.components.schemas[name]!;
    expect(schema.required).not.toContain("analyticsRetentionDays");
    expect(schema.properties.analyticsRetentionDays!["x-gromesh-planned"]).toBe(true);
  }
  expect(contract.components.schemas.GromeshConfigRoute!.properties.analyticsRetentionDays!.$ref)
    .toBe("#/components/schemas/RouteWrite/properties/analyticsRetentionDays");
});
