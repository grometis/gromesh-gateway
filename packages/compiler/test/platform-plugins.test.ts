import { describe, expect, it } from "vitest";
import { compile, CompileError, hashConfig, platformPlugins, type GatewayState } from "../src/index.js";

const options = {
  httpLogEndpoint: "http://vector:8080/kong",
  environmentId: "00000000-0000-4000-8000-0000000000e1",
};
const state: GatewayState = { services: [], routes: [], consumers: [], keyAuthCredentials: [], plugins: [] };
const auth = (id: number, config?: Record<string, unknown>, scope?: { consumerId: string }) => ({
  id: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`, name: "key-auth", config, scope,
});
const logFields = (input: GatewayState, platform = platformPlugins(options)) =>
  compile(input, { platformPlugins: platform }).plugins.find((plugin) => plugin.name === "http-log")?.config.custom_fields_by_lua;

describe("platformPlugins", () => {
  it("compiles global metrics and batched HTTP logs with snapshot identity", () => {
    const config = compile(state, { platformPlugins: platformPlugins(options) });
    expect(config.plugins).toEqual([
      expect.objectContaining({ name: "prometheus", enabled: true, config: {
        per_consumer: false, status_code_metrics: true, latency_metrics: true, bandwidth_metrics: true,
      } }),
      expect.objectContaining({ name: "http-log", config: {
        http_endpoint: options.httpLogEndpoint, method: "POST", content_type: "application/json", timeout: 5000,
        queue: { max_batch_size: 100, max_coalescing_delay: 1, max_entries: 10000, max_retry_time: 60 },
        custom_fields_by_lua: {
          environment_id: `return "${options.environmentId}"`,
          key_names: 'return {"apikey"}',
        },
      } }),
    ]);
    for (const plugin of config.plugins) {
      expect(plugin).not.toHaveProperty("service");
      expect(plugin).not.toHaveProperty("route");
      expect(plugin).not.toHaveProperty("consumer");
    }
    expect(state.plugins).toEqual([]);
    expect(hashConfig(config)).toBe(hashConfig(compile(state, { platformPlugins: platformPlugins(options) })));
  });

  it("translates queue options without sharing mutable defaults", () => {
    const plugins = platformPlugins({ ...options, queue: {
      maxBatchSize: 20, maxCoalescingDelaySeconds: 0.5, maxEntries: 200, maxRetryTimeSeconds: 30,
    } });
    expect(plugins[1]?.config?.queue).toEqual({
      max_batch_size: 20, max_coalescing_delay: 0.5, max_entries: 200, max_retry_time: 30,
    });
    expect(platformPlugins(options)[1]?.config?.queue).toHaveProperty("max_batch_size", 100);
  });

  it("derives a sorted union across scopes, including disabled plugins, without mutating the platform defaults", () => {
    const consumerId = "00000000-0000-4000-8000-000000000010";
    const input: GatewayState = { ...state, consumers: [{ id: consumerId, username: "test" }], plugins: [
      auth(1, { key_names: ["x-token", "X.Token", "a_b-9"] }),
      { ...auth(2, { key_names: ["x-token", "z"] }, { consumerId }), enabled: false },
    ] };
    const platform = platformPlugins(options);
    const original = structuredClone(input);
    expect(logFields(input, platform)).toEqual({
      environment_id: `return "${options.environmentId}"`, key_names: 'return {"X.Token","a_b-9","x-token","z"}',
    });
    expect(logFields({ ...input, plugins: [...input.plugins].reverse() }, platform)).toEqual(logFields(input, platform));
    expect(input).toEqual(original);
    expect(platform).toEqual(platformPlugins(options));
    expect(logFields(state, platform)).toHaveProperty("key_names", 'return {"apikey"}');
  });

  it("uses apikey for each omitted key_names and when no key-auth exists", () => {
    expect(logFields({ ...state, plugins: [auth(1, { key_names: ["x-token"] })] })).toHaveProperty("key_names", 'return {"x-token"}');
    expect(logFields({ ...state, plugins: [auth(1)] })).toHaveProperty("key_names", 'return {"apikey"}');
    expect(logFields({ ...state, plugins: [auth(1, { key_names: ["x-token"] }), auth(2, {}, { consumerId: "00000000-0000-4000-8000-000000000010" })],
      consumers: [{ id: "00000000-0000-4000-8000-000000000010", username: "test" }],
    })).toHaveProperty("key_names", 'return {"apikey","x-token"}');
    expect(logFields({ ...state, plugins: [{ id: auth(1).id, name: "rate-limiting", config: { key_names: ["ignored"] } }] }))
      .toHaveProperty("key_names", 'return {"apikey"}');
    expect(logFields({ ...state, plugins: [auth(1, { key_names: ["a".repeat(64)] })] }))
      .toHaveProperty("key_names", `return {"${"a".repeat(64)}"}`);
  });

  it.each([null, "x-token", [], [1], [null], [{}], [""], ["a".repeat(65)], ["x token"], ["x/token"], ["é"], ["x\n"], ['x"}; return "injected']])(
    "rejects invalid key_names before Lua interpolation even without platform plugins: %j", (key_names) => {
      const input = { ...state, plugins: [auth(1, { key_names })] };
      for (const platform of [[], platformPlugins(options)]) {
        expect(() => compile(input, { platformPlugins: platform })).toThrow(CompileError);
        try { compile(input, { platformPlugins: platform }); } catch (error) {
          expect((error as CompileError).issues).toContainEqual(expect.objectContaining({ path: "plugins[0].config.key_names" }));
        }
      }
    },
  );

  it("allows retry retention and capacity to be tuned independently while retaining other defaults", () => {
    const retry = compile(state, { platformPlugins: platformPlugins({ ...options, queue: { maxRetryTimeSeconds: 120 } }) });
    expect(retry.plugins.find((plugin) => plugin.name === "http-log")?.config.queue).toEqual({
      max_batch_size: 100, max_coalescing_delay: 1, max_entries: 10000, max_retry_time: 120,
    });
    const capacity = compile(state, { platformPlugins: platformPlugins({ ...options, queue: { maxEntries: 30000 } }) });
    expect(capacity.plugins.find((plugin) => plugin.name === "http-log")?.config.queue).toEqual({
      max_batch_size: 100, max_coalescing_delay: 1, max_entries: 30000, max_retry_time: 60,
    });
  });

  it.each([
    { environmentId: 'invalid"; return "value' }, { environmentId: "invalid" },
    { httpLogEndpoint: "file:///tmp/log" }, { httpLogEndpoint: "http://user:password@vector/kong" },
    { httpLogEndpoint: "http://vector/kong?apikey=secret" }, { httpLogEndpoint: "http://vector/kong#secret" },
    { queue: { maxBatchSize: 0 } }, { queue: { maxBatchSize: 1.5 } },
    { queue: { maxCoalescingDelaySeconds: -1 } }, { queue: { maxRetryTimeSeconds: Infinity } },
    { queue: { maxBatchSize: 200, maxEntries: 100 } },
    { queue: { maxEntries: 0 } }, { queue: { maxEntries: -1 } },
    { queue: { maxEntries: 100.5 } }, { queue: { maxEntries: NaN } },
    { queue: { maxRetryTimeSeconds: -1 } }, { queue: { maxRetryTimeSeconds: NaN } },
  ])("rejects unsafe or invalid platform configuration: %j", (invalid) => {
    expect(() => platformPlugins({ ...options, ...invalid })).toThrow(CompileError);
  });

  it("rejects a conflicting global plugin through the existing compiler validation", () => {
    expect(() => compile({ ...state, plugins: [{
      id: "00000000-0000-4000-8000-000000000001", name: "http-log",
    }] }, { platformPlugins: platformPlugins(options) })).toThrow(CompileError);
  });
});
