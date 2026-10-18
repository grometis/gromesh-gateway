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
      'local route = kong.router.get_route(); for _, tag in ipairs((route and route.tags) or {}) do local days = string.match(tag, "^gromesh%-retention:([1-7])$"); if days then return tonumber(days) end end; return 7');
    expect(config.routes[0]!.tags).toContain("gromesh-retention:1");
    expect(config.routes[1]!.tags).toContain("gromesh-retention:7");
    expect(config.routes[2]!.tags).toEqual(["managed-by:gromesh"]);
    expect(hashConfig(compile({ ...input, routes: [...input.routes].reverse() }, options))).toBe(hashConfig(config));
    expect(hashConfig(config)).not.toBe(hashConfig(compile(state(), options)));
    expect(input).toEqual(original);
    expect(compile(input).plugins).toEqual([]);
    expect(config.routes.every((route) => !("analyticsRetentionDays" in route))).toBe(true);
  });

  it("uses the same Lua regardless of route count or UUID case, stripping forged user tags", () => {
    const input = state();
    input.routes[0]!.id = "ABCDEF00-0000-4000-8000-000000000002";
    input.routes[0]!.analyticsRetentionDays = 1;
    input.routes[0]!.tags = ["gromesh-retention:7", "team:api", "gromesh-retention:bad"];
    input.routes[1]!.tags = ["gromesh-retention:1"];
    const original = structuredClone(input);
    const config = compile(input, options);
    const fields = config.plugins.find((p) => p.name === "http-log")!.config.custom_fields_by_lua;
    expect(config.routes.find((r) => r.id === input.routes[0]!.id)!.tags).toEqual(["gromesh-retention:1", "managed-by:gromesh", "team:api"]);
    expect(config.routes.find((r) => r.id === id(3))!.tags).toEqual(["managed-by:gromesh"]);
    expect(input).toEqual(original);
    input.routes = Array.from({ length: 1000 }, (_, i) => ({
      id: id(100 + i), name: `many-${i}`, serviceId: id(1), paths: [`/many-${i}`], analyticsRetentionDays: i % 7 + 1,
    }));
    expect(compile(input, options).plugins.find((p) => p.name === "http-log")!.config.custom_fields_by_lua).toEqual(fields);
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
