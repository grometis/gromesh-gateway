import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { buildSnapshot, type GatewayState } from "../src/index.js";

const read = (rel: string) => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));
const schema = read("../../../contracts/snapshot.schema.json");
const ajv = new Ajv2020.default({ allErrors: true, strict: false });
addFormats.default(ajv);
const validateEnvelope = ajv.compile(schema);

describe("contracts/snapshot.schema.json", () => {
  it("accepts the contract example", () => {
    const ok = validateEnvelope(read("../../../contracts/examples/snapshot.example.json"));
    expect(validateEnvelope.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it("accepts what the compiler produces, including platform plugins", () => {
    const state = read("./fixtures/basic.state.json") as GatewayState;
    const snap = buildSnapshot(
      state,
      { version: 3, environmentId: "00000000-0000-4000-8000-0000000000e1" },
      { platformPlugins: [{ id: "6a1f3c2e-0b7d-4c1a-9f10-000000000099", name: "prometheus" }] },
    );
    expect(validateEnvelope(snap)).toBe(true);
  });

  it("rejects an entity without the managed tag", () => {
    const example = read("../../../contracts/examples/snapshot.example.json");
    example.config.services[0].tags = [];
    expect(validateEnvelope(example)).toBe(false);
  });
});
