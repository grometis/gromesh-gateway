// Run: node --test tests/load/evidence.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertLoadEvidence } from './evidence.mjs';
const summary = () => ({ metrics: Object.fromEntries([
  ['iterations', { count: 60000 }], ['http_reqs', { count: 60000 }],
  ['kong_proxy_latency_ms', { 'p(95)': 1 }], ['kong_5xx', { count: 0 }],
  ['invalid_responses', { count: 0 }], ['missing_proxy_latency', { count: 0 }],
  ['dropped_iterations', { count: 0 }], ['http_req_failed', { rate: 0 }],
].map(([key, values]) => [key, { values }])) });
const publications = () => Array.from({ length: 5 }, (_, i) => ({ version: i + 2, startedAtSeconds: 8 + i * 10, convergedAtSeconds: 9 + i * 10 }));
test('accepts complete 1000 rps evidence with five publications during traffic', () => assert.doesNotThrow(() => assertLoadEvidence(summary(), publications())));
for (const [metric, field, value] of [
  ['kong_5xx', 'count', 1], ['invalid_responses', 'count', 1], ['missing_proxy_latency', 'count', 1],
  ['dropped_iterations', 'count', 1], ['http_req_failed', 'rate', 0.001], ['iterations', 'count', 59999],
  ['kong_proxy_latency_ms', 'p(95)', null], ['kong_proxy_latency_ms', 'p(95)', -1],
]) test(`rejects invalid ${metric} evidence`, () => {
  const data = summary(); data.metrics[metric].values[field] = value;
  assert.throws(() => assertLoadEvidence(data, publications()));
});
test('rejects missing metrics and publications outside the load window', () => {
  const data = summary(); delete data.metrics.kong_5xx;
  assert.throws(() => assertLoadEvidence(data, publications()));
  const pubs = publications(); pubs[4].convergedAtSeconds = 61;
  assert.throws(() => assertLoadEvidence(summary(), pubs));
  assert.throws(() => assertLoadEvidence(summary(), pubs.slice(0, 4)));
});
