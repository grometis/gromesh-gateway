import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import test from 'node:test';
const require = createRequire(new URL('../../apps/control-plane/package.json', import.meta.url));
const Ajv = require('ajv/dist/2020.js').default;
const addFormats = require('ajv-formats').default;
const yaml = require('yaml');
const schemas = JSON.parse(readFileSync(new URL('../analytics-v2.schemas.json', import.meta.url), 'utf8'));
const examples = JSON.parse(readFileSync(new URL('../examples/analytics-workspace-v2.example.json', import.meta.url), 'utf8'));
const api = yaml.parse(readFileSync(new URL('../control-plane-v2.openapi.yaml', import.meta.url), 'utf8'));
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(schemas, 'analytics');
const validate = name => ajv.compile({ $ref: `analytics#/components/schemas/${name}` });
const names = { summary:'WorkspaceAnalyticsSummary', timeseries:'WorkspaceAnalyticsTimeseries', topRoutes:'WorkspaceTopRoutes', requests:'WorkspaceRequestPage' };
for (const [key, name] of Object.entries(names)) test(`synthetic ${key} conforms to its workspace schema`, () => {
  const check = validate(name);
  assert.equal(check(examples[key]), true, JSON.stringify(check.errors));
  const invalid = structuredClone(examples[key]); delete invalid.workspaceId;
  assert.equal(check(invalid), false);
  invalid.workspaceId = 'not-a-uuid'; assert.equal(check(invalid), false);
});
test('only planned workspace-scoped operations with current read permission and bounded policies', () => {
  for (const suffix of ['analytics/summary','analytics/timeseries','analytics/top-routes','requests']) {
    const op = api.paths[`/workspaces/{workspaceId}/${suffix}`].get;
    assert.equal(op['x-gromesh-planned'], true);
    assert.equal(op['x-scope'], 'workspace'); assert.equal(op['x-required-permission'], 'workspace.read');
    assert.equal(op['x-gromesh-query-policy'].maxReadRowsPerRequest, 5000000);
    assert.equal(op['x-gromesh-query-policy'].maxConcurrentPerInstance, 8);
    assert.deepEqual(Object.keys(op.responses).sort(), ['200','401','403','404','422','429','502']);
  }
});
test('empty quantiles are nullable but negative or unsafe counts are rejected', () => {
  const check = validate('WorkspaceTrafficStats');
  const stats = examples.summary.totals; assert.equal(check(stats), true);
  for (const requests of [-1, 9007199254740992]) assert.equal(check({ ...stats, requests }), false);
  assert.equal(check({ ...stats, p95Ms:-1 }), false);
});
test('output bounds reject oversized series, pages and rankings', () => {
  assert.equal(validate('WorkspaceAnalyticsTimeseries')({ ...examples.timeseries, series:Array(2001).fill(examples.summary.series[0]) }), false);
  assert.equal(validate('WorkspaceTopRoutes')({ ...examples.topRoutes, items:Array(51).fill({routeId:examples.populatedRequests.items[0].routeId,routeName:null,serviceId:null,...examples.summary.totals}) }), false);
  assert.equal(validate('WorkspaceRequestPage')({ ...examples.requests, items:Array(201).fill(examples.populatedRequests.items[0]) }), false);
});
test('request attribution requires one or two candidate revisions, never an empty or oversized set', () => {
  const check = validate('WorkspaceRequestPage');
  for (const candidateRevisions of [[], Array(3).fill(examples.populatedRequests.items[0].candidateRevisions[0])]) {
    const invalid = structuredClone(examples.populatedRequests);
    invalid.items[0].candidateRevisions = candidateRevisions;
    assert.equal(check(invalid), false);
  }
});
test('nonempty requests preserve fractional timings and maximum UInt64 without claiming an effective revision', () => {
  const check = validate('WorkspaceRequestPage');
  assert.equal(check(examples.populatedRequests), true, JSON.stringify(check.errors));
  const invalid = structuredClone(examples.populatedRequests);
  for (const size of ['18446744073709551616','-1','01',18446744073709551615]) {
    invalid.items[0].requestSize = size; assert.equal(check(invalid), false);
  }
  invalid.items[0].requestSize = '0'; invalid.items[0].effectiveRevision = {epoch:1,revision:7};
  assert.equal(check(invalid), false);
  delete invalid.items[0].effectiveRevision; assert.equal(check(invalid), false);
});
test('zero traffic cannot carry nonzero errors or fabricated latencies', () => {
  const check = validate('WorkspaceTrafficStats'), stats = examples.summary.totals;
  assert.equal(check({...stats,p95Ms:0}), false);
  assert.equal(check({...stats,errors5xx:1}), false);
});
