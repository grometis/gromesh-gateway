import { describe, expect, it } from "vitest";
import { CompileError, compile, placeholderVariables, resolveVariables, type GatewayState } from "../src/index.js";

// WS-V2: VarRef resolution is pure and deterministic: the same release and the same values give the same state.
const SVC = "6a1f3c2e-0b7d-4c1a-9f10-a00000000001";
const state = (varRefs: GatewayState["services"][number]["varRefs"]): GatewayState => ({
  services: [{ id: SVC, name: "svc", protocol: "http", host: "variable.invalid", port: 1, path: "/", varRefs }],
  routes: [{ id: "6a1f3c2e-0b7d-4c1a-9f10-a00000000002", name: "r", serviceId: SVC, paths: ["/r"] }],
  consumers: [],
  keyAuthCredentials: [],
  plugins: [],
});
const values = (o: Record<string, string>) => new Map(Object.entries(o).map(([k, value]) => [k, { value, version: 1 }]));
const issues = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    if (err instanceof CompileError) return err.issues;
  }
  return [];
};

describe("resolveVariables (WS-V2)", () => {
  it("substitutes each field with its typed value and reports what it used, deterministically", () => {
    const s = state({ host: "H", port: "P", protocol: "S", path: "B" });
    const run = () => resolveVariables(s, new Set(["H", "P", "S", "B"]), values({ H: "api.example.com", P: "8443", S: "https", B: "/v1" }));
    const out = run();
    expect(out.state.services[0]).toMatchObject({ host: "api.example.com", port: 8443, protocol: "https", path: "/v1" });
    expect(out.state.services[0]).not.toHaveProperty("varRefs");
    expect([...out.used.keys()].sort()).toEqual(["B", "H", "P", "S"]);
    expect(JSON.stringify(run().state)).toBe(JSON.stringify(out.state));
  });

  it("refuses an undeclared variable, a missing value and a value the field refuses, at the field's path", () => {
    expect(issues(() => resolveVariables(state({ host: "H" }), new Set(), values({ H: "x.example" })))).toEqual([{ path: "services[0].host", message: "variable H is not declared in this release" }]);
    expect(issues(() => resolveVariables(state({ host: "H" }), new Set(["H"]), values({})))[0]!.message).toMatch(/has no value on this instance/);
    for (const [field, value] of [["port", "70000"], ["port", "abc"], ["protocol", "ftp"], ["path", "v1"], ["host", "bad host"]] as const) {
      expect(issues(() => resolveVariables(state({ [field]: "V" }), new Set(["V"]), values({ V: value })))[0]?.path, `${field}=${value}`).toBe(`services[0].${field}`);
    }
  });

  it("never lets a reference reach Kong unresolved: v1 refuses it, placeholders only check the structure", () => {
    expect(issues(() => compile(state({ host: "H" })))[0]!.path).toBe("services[0].host");
    const p = placeholderVariables(state({ host: "H", port: "P" }));
    expect(p.services[0]).toMatchObject({ host: "variable.invalid", port: 1 });
    expect(p.services[0]).not.toHaveProperty("varRefs");
  });
});
