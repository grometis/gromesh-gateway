import { CompileError } from "./errors.js";
import type { Plugin } from "./model.js";

export interface PlatformPluginOptions {
  httpLogEndpoint: string;
  /** The environment every log line is tagged with; the cluster id is added by each cluster's own collector. */
  environmentId: string;
  queue?: {
    maxBatchSize?: number;
    maxCoalescingDelaySeconds?: number;
    /** Per worker; size for peak events/second times the intended outage window. */
    maxEntries?: number;
    /** Defaults to 60 seconds so a short collector outage does not discard the queued batch. */
    maxRetryTimeSeconds?: number;
  };
}

/**
 * Stable IDs keep repeated publication deterministic; these plugins are global. The snapshot stays identical for
 * every cluster of the environment: nothing cluster-specific goes in here.
 */
export function platformPlugins(options: PlatformPluginOptions): Plugin[] {
  const issues: { path: string; message: string }[] = [];
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(options.environmentId)) issues.push({ path: "platformPlugins.environmentId", message: "must be a UUID" });
  try {
    const url = new URL(options.httpLogEndpoint);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
  } catch {
    issues.push({ path: "platformPlugins.httpLogEndpoint", message: "must be an HTTP(S) URL without credentials, query or fragment" });
  }
  const queue = {
    max_batch_size: options.queue?.maxBatchSize ?? 100,
    max_coalescing_delay: options.queue?.maxCoalescingDelaySeconds ?? 1,
    max_entries: options.queue?.maxEntries ?? 10000,
    max_retry_time: options.queue?.maxRetryTimeSeconds ?? 60,
  };
  for (const [field, value] of Object.entries(queue)) {
    const integer = field === "max_batch_size" || field === "max_entries";
    if (!Number.isFinite(value) || value < (integer ? 1 : 0) || (integer && !Number.isInteger(value))) {
      issues.push({ path: `platformPlugins.queue.${field}`, message: integer ? "must be a positive integer" : "must be a non-negative finite number" });
    }
  }
  if (queue.max_batch_size > queue.max_entries) {
    issues.push({ path: "platformPlugins.queue.max_batch_size", message: "must not exceed max_entries" });
  }
  if (issues.length) throw new CompileError(issues);

  return [
    {
      id: "14f9de7e-3701-4c69-b7f7-b8b5622c0101",
      name: "prometheus",
      config: { per_consumer: false, status_code_metrics: true, latency_metrics: true, bandwidth_metrics: true },
    },
    {
      id: "14f9de7e-3701-4c69-b7f7-b8b5622c0102",
      name: "http-log",
      config: {
        http_endpoint: options.httpLogEndpoint,
        method: "POST",
        content_type: "application/json",
        timeout: 5000,
        queue,
        custom_fields_by_lua: {
          environment_id: `return "${options.environmentId.toLowerCase()}"`,
        },
      },
    },
  ];
}
