// Run: node --test tests/load/evidence.test.mjs
import assert from 'node:assert/strict';
export function assertLoadEvidence(summary, publications) {
  const value = (name, field) => summary.metrics?.[name]?.values?.[field];
  for (const name of ['kong_5xx', 'invalid_responses', 'missing_proxy_latency', 'dropped_iterations']) assert.equal(value(name, 'count'), 0, name);
  assert.equal(value('http_req_failed', 'rate'), 0, 'http_req_failed');
  assert.ok(value('iterations', 'count') >= 60000, '60000 completed iterations required');
  assert.ok(value('http_reqs', 'count') >= 60000, '60000 requests required');
  assert.ok(typeof value('kong_proxy_latency_ms', 'p(95)') === 'number' && Number.isFinite(value('kong_proxy_latency_ms', 'p(95)')) && value('kong_proxy_latency_ms', 'p(95)') >= 0, 'Missing p95 baseline');
  assert.equal(publications.length, 5, 'Five publications required');
  for (const [i, publication] of publications.entries()) {
    assert.equal(publication.version, i + 2, 'Publication sequence');
    assert.ok(publication.startedAtSeconds > 0 && publication.convergedAtSeconds >= publication.startedAtSeconds && publication.convergedAtSeconds < 60, 'Publication must converge during traffic');
  }
}
