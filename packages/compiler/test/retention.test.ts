import { describe, expect, it } from "vitest";
import { compile, CompileError, diffGatewayStates, hashConfig, platformPlugins, type GatewayState } from "../src/index.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const state = (): GatewayState => ({
  services: [{ id: id(1), name: "api", protocol: "http", host: "echo", port: 80 }],
  routes: [2, 3, 4].map((n) => ({ id: id(n), name: `route-${n}`, serviceId: id(1), paths: [`/route-${n}`] })),
  consumers: [], keyAuthCredentials: [], plugins: [],
});
const options = { platformPlugins: platformPlugins({ environmentId: id(10), httpLogEndpoint: "http://vector:8080/kong" }) };

describe("route analytics retention", () => {
  it("keeps legacy hashes for omitted/null retention, emitting no new Kong route fields", () => {
    const input = state();
    const baseline = compile(input, options);
    const fields = baseline.plugins.find((p) => p.name === "http-log")!.config.custom_fields_by_lua;
    expect(fields).not.toHaveProperty("retention_days");
    input.routes.forEach((route) => { route.analyticsRetentionDays = null; });
    expect(hashConfig(compile(input, options))).toBe(hashConfig(baseline));
    expect(compile(input, options).routes[0]).not.toHaveProperty("analyticsRetentionDays");
  });

  it("deterministically resolves explicit route values with fallback for unset and unmatched routes", () => {
    const input = state();
    input.routes[0]!.analyticsRetentionDays = 1;
    input.routes[1]!.analyticsRetentionDays = 7;
    const original = structuredClone(input);
    const config = compile(input, options);
    expect(config.plugins.find((p) => p.name === "http-log")!.config.custom_fields_by_lua).toHaveProperty("retention_days",
      `local days = {["${id(2)}"]=1,["${id(3)}"]=7}; local route = kong.router.get_route(); return (route and days[route.id]) or 7`);
    expect(hashConfig(compile({ ...input, routes: [...input.routes].reverse() }, options))).toBe(hashConfig(config));
    expect(hashConfig(config)).not.toBe(hashConfig(compile(state(), options)));
    expect(input).toEqual(original);
    expect(compile(input).plugins).toEqual([]);
    expect(config.routes.every((route) => !("analyticsRetentionDays" in route))).toBe(true);
  });

  it.each([0, 8, 1.5, NaN, Infinity])("rejects invalid retention before Lua interpolation: %s", (value) => {
    const input = state();
    input.routes[0]!.analyticsRetentionDays = value;
    expect(() => compile(input, options)).toThrow(CompileError);
    try { compile(input, options); } catch (error) {
      expect((error as CompileError).issues).toContainEqual({ path: "routes[0].analyticsRetentionDays", message: "must be an integer between 1 and 7 or null" });
    }
  });

  it("detects retention-only imports even without platform plugins and normalizes legacy defaults", () => {
    const before = state();
    const after = state();
    after.routes[0]!.analyticsRetentionDays = 1;
    expect(diffGatewayStates(before, after)).toEqual([expect.objectContaining({
      kind: "routes", id: id(2), change: "modified", after: expect.objectContaining({ analyticsRetentionDays: 1 }),
    })]);
    after.routes[0]!.analyticsRetentionDays = null;
    expect(diffGatewayStates(before, after)).toEqual([]);
  });
});
