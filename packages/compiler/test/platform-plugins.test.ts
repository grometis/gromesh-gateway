import { describe, expect, it } from "vitest";
import { compile, CompileError, hashConfig, platformPlugins, type GatewayState } from "../src/index.js";

const options = {
  httpLogEndpoint: "http://vector:8080/kong",
  environmentId: "00000000-0000-4000-8000-0000000000e1",
};
const state: GatewayState = { services: [], routes: [], consumers: [], keyAuthCredentials: [], plugins: [] };

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
