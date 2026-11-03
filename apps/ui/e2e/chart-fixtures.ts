import type { Schemas } from "../src/api/client";

// Fixed values and UTC timestamps for identical before/after captures; no live telemetry or secrets.
const values = [
  { requests: 0, errors4xx: 0, errors5xx: 0, errorRate: 0, p50Ms: null, p95Ms: null, p99Ms: null },
  { requests: 600, errors4xx: 20, errors5xx: 1, errorRate: 0.035, p50Ms: 0.00013, p95Ms: 0.0013, p99Ms: 0.013 },
  { requests: 650, errors4xx: 1, errors5xx: 2, errorRate: 3 / 650, p50Ms: 18.2, p95Ms: 48.9, p99Ms: 131.5 },
  { requests: 120, errors4xx: 4, errors5xx: 0, errorRate: 4 / 120, p50Ms: null, p95Ms: 48.9, p99Ms: 120 },
];

export function chartSummary(interval: "5m" | "1h" = "5m"): Schemas["AnalyticsSummary"] {
  const start = Date.UTC(2026, 9, 17, 23, 55);
  const step = interval === "5m" ? 300_000 : 3_600_000;
  return {
    from: new Date(start).toISOString(), to: new Date(start + values.length * step).toISOString(), interval,
    totals: { requests: 1370, errors4xx: 25, errors5xx: 3, errorRate: 28 / 1370, p50Ms: 18.2, p95Ms: 48.9, p99Ms: 131.5 },
    series: values.map((value, i) => ({ ts: new Date(start + i * step).toISOString(), ...value })),
  };
}
