import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { test } from "vitest";
import { parse } from "yaml";

// P4-X0: the export/import contract (operations, GromeshConfigV1 and its examples), before any handler exists.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const contract: Doc = parse(read('../../../../contracts/control-plane.openapi.yaml'));
// JSON documents of the contract's own examples, mutated case by case.
type Doc = any;
const example: Doc = JSON.parse(read('../../../../contracts/examples/gromesh-config-v1.example.json'));
const ajv = new Ajv2020.default({ allErrors: true, strict: false });
addFormats.default(ajv);
ajv.addSchema({ ...contract, $id: 'control-plane' });
const validate = (name: string, value: unknown, expected = true) => {
  const validator = ajv.getSchema(`control-plane#/components/schemas/${name}`);
  assert.ok(validator, name);
  assert.equal(validator!(value), expected, `${name}: ${ajv.errorsText(validator!.errors)}`);
};
const request = (overrides: Record<string, unknown> = {}) => ({ document: structuredClone(example), mode: 'merge', dryRun: true, ...overrides });
const changed = (mutate: (doc: Doc) => void) => {
  const doc = structuredClone(example);
  mutate(doc);
  return doc;
};

test('new operations are planned, have the required roles and session/token security', () => {
  const exported = contract.paths['/environments/{envId}/export'].get;
  const imported = contract.paths['/environments/{envId}/import'].post;
  assert.equal(exported['x-gromesh-planned'], true);
  assert.equal(imported['x-gromesh-planned'], true);
  assert.equal(exported['x-required-role'], 'viewer');
  assert.equal(imported['x-required-role'], 'editor');
  assert.deepEqual(exported.security, [{ cookieAuth: [] }, { bearerApiToken: [] }]);
  assert.deepEqual(imported.security, [{ cookieAuth: [], csrfToken: [] }, { bearerApiToken: [] }]);
  assert.deepEqual(exported.responses[200].content['application/yaml'].schema, exported.responses[200].content['application/json'].schema);
  for (const status of [401, 403, 404, 422]) assert.ok(imported.responses[status]);
  // Conflicts are errors[] entries of the 422 report, not a separate 409.
  assert.equal(imported.responses[409], undefined);
});

test('YAML and JSON export examples are identical and reusable as an import document', () => {
  assert.deepEqual(parse(read('../../../../contracts/examples/gromesh-config-v1.example.yaml')), example);
  validate('GromeshConfigV1Export', example);
  validate('GromeshConfigV1', example);
  validate('EnvironmentImportRequest', request());
});

test('an explicitly empty document supports clearing a draft in replace mode', () => {
  const document: Doc = { apiVersion: 'gromesh/v1', services: [], routes: [], consumers: [], plugins: [], upstreams: [], certificates: [] };
  validate('EnvironmentImportRequest', request({ document, mode: 'replace', dryRun: false }));
  delete document.certificates;
  validate('EnvironmentImportRequest', request({ document, mode: 'replace' }), false);
});

test('Gromesh rejects foreign formats, unknown fields and database foreign keys', () => {
  for (const mutate of <((d: Doc) => void)[]>[
    (d) => { d.apiVersion = 'gromesh/v2'; },
    (d) => { d._format_version = '3.0'; },
    (d) => { d.services[0].connect_timeout = 100; },
    (d) => { d.routes[0].serviceId = '00000000-0000-4000-8000-000000000005'; },
    (d) => { delete d.routes[0].service; },
    (d) => { d.consumers[0].foreign = true; },
    (d) => { d.plugins[0].scope.serviceId = '00000000-0000-4000-8000-000000000005'; },
    (d) => { d.upstreams[0].targets[0].unknown = true; },
    (d) => { d.upstreams[0].healthchecks.active.unknown = true; },
    (d) => { d.upstreams[0].healthchecks.passive.unknown = true; },
    (d) => { d.certificates[0].subject = 'computed'; },
  ]) validate('GromeshConfigV1', changed(mutate), false);
});

test('consumers and scope references require at least one non-empty natural identifier', () => {
  validate('GromeshConfigV1', changed((d) => { delete d.consumers[0].username; d.consumers[0].customId = null; }), false);
  validate('GromeshConfigV1', changed((d) => { d.plugins[0].scope.consumer = {}; }), false);
  validate('GromeshConfigV1', changed((d) => { d.plugins[0].scope.consumer = { customId: 'partner-001' }; }));
  validate('GromeshConfigV1', changed((d) => { d.consumers[0].aclGroups = ['partners', 'partners']; }), false);
});

test('write attributes retain the existing model constraints', () => {
  for (const mutate of <((d: Doc) => void)[]>[
    (d) => { d.services[0].port = 65536; },
    (d) => { d.routes[0].protocols = ['tcp']; },
    (d) => { d.upstreams[0].targets[0].weight = -1; },
    (d) => { d.upstreams[0].healthchecks.active.timeoutSeconds = 0; },
    (d) => { d.certificates[0].snis = ['api.*.example.com']; },
  ]) validate('GromeshConfigV1', changed(mutate), false);
});

test('export schemas prohibit credential keys, plaintext passwords, hashes and unredacted JWT/certificate secrets', () => {
  for (const mutate of <((d: Doc) => void)[]>[
    (d) => { d.consumers[0].keyAuthCredentials[0].key = 'REDACTED'; },
    (d) => { delete d.consumers[0].keyAuthCredentials[0].keyHint; },
    (d) => { d.consumers[0].basicAuthCredentials[0].password = 'REDACTED'; },
    (d) => { d.consumers[0].basicAuthCredentials[0].passwordHash = 'synthetic-hash'; },
    (d) => { d.consumers[0].jwtCredentials[0].secret = 'synthetic-secret'.repeat(3); },
    (d) => { delete d.consumers[0].jwtCredentials[0].secret; },
    (d) => { d.certificates[0].key = 'synthetic-private-key'; },
  ]) validate('GromeshConfigV1Export', changed(mutate), false);
});

test('import accepts secret input and preservation markers without permitting basic-auth hashes', () => {
  const document = changed((d) => {
    d.consumers[0].keyAuthCredentials[0].key = 'synthetic-key-for-schema-test';
    d.consumers[0].jwtCredentials[0].secret = 'synthetic-secret'.repeat(3);
    d.consumers[0].basicAuthCredentials[0].password = 'synthetic-password';
    d.certificates[0].key = 'synthetic-private-key';
  });
  validate('GromeshConfigV1', document);
  document.consumers[0].keyAuthCredentials[0].key = 'REDACTED';
  document.consumers[0].jwtCredentials[0].secret = 'REDACTED';
  document.consumers[0].basicAuthCredentials[0].password = 'REDACTED';
  validate('GromeshConfigV1', document);
  document.consumers[0].basicAuthCredentials[0].passwordHash = 'synthetic-hash';
  validate('GromeshConfigV1', document, false);
});

test('asymmetric JWT credentials require their public key and forbid shared secrets', () => {
  for (const algorithm of ['RS256', 'ES256']) {
    const document = changed((d) => {
      const credential = d.consumers[0].jwtCredentials[0];
      credential.algorithm = algorithm;
      delete credential.secret;
      credential.rsaPublicKey = 'synthetic-public-key';
    });
    validate('GromeshConfigV1Export', document);
    document.consumers[0].jwtCredentials[0].secret = 'REDACTED';
    validate('GromeshConfigV1', document, false);
    delete document.consumers[0].jwtCredentials[0].secret;
    delete document.consumers[0].jwtCredentials[0].rsaPublicKey;
    validate('GromeshConfigV1', document, false);
  }
});

test('sourceFormat selects the document model and supports serialized YAML/JSON', () => {
  validate('EnvironmentImportRequest', request({ document: read('../../../../contracts/examples/gromesh-config-v1.example.yaml') }));
  validate('EnvironmentImportRequest', request({ document: JSON.stringify(example), sourceFormat: 'gromesh/v1' }));
  const kong = { _format_version: '3.0', services: [], unsupported: { field: true } };
  // Preserve unmodeled Kong data so conversion can report its original paths, including in dry-run.
  validate('EnvironmentImportRequest', request({ document: kong, sourceFormat: 'kong-declarative-3.0' }));
  validate('EnvironmentImportRequest', request({ document: kong }), false);
  validate('EnvironmentImportRequest', request({ document: { ...kong, _format_version: 3 }, sourceFormat: 'kong-declarative-3.0' }), false);
  validate('EnvironmentImportRequest', request({ sourceFormat: 'kong-declarative-2.1' }), false);
  validate('EnvironmentImportRequest', request({ mode: 'append' }), false);
  validate('EnvironmentImportRequest', request({ dryRun: 'true' }), false);
  const missingDryRun: Doc = request();
  delete missingDryRun.dryRun;
  validate('EnvironmentImportRequest', missingDryRun, false);
});

test('serialized documents have a schema length ceiling in addition to the runtime UTF-8 byte limit', () => {
  validate('SerializedConfigDocument', 'a'.repeat(5242880));
  validate('SerializedConfigDocument', 'a'.repeat(5242881), false);
});

test('report uses EntityChange objects in the correct partitions and path/message errors', () => {
  const change = { kind: 'certificates', id: '00000000-0000-4000-8000-000000000004', label: 'api.example.com', change: 'modified', after: { key: 'REDACTED' } };
  const report = { added: [], modified: [change], removed: [], errors: [] };
  validate('EnvironmentImportReport', report);
  validate('EnvironmentImportReport', { ...report, modified: [1] }, false);
  validate('EnvironmentImportReport', { ...report, added: [change] }, false);
  validate('EnvironmentImportReport', { ...report, modified: [], errors: [{ path: 'document.services.0.host', message: 'Invalid host' }] });
  validate('EnvironmentImportReport', { ...report, errors: [{ path: 'document.services.0.host', message: 'Invalid host' }] }, false);
  validate('EnvironmentImportReport', { ...report, errors: [{ message: 'Invalid host' }] }, false);
});

test('a real import is all or nothing: any error is a 422 with the same report and nothing applied', () => {
  const failure = contract.paths['/environments/{envId}/import'].post.responses[422].content['application/problem+json'];
  assert.equal(failure.schema.$ref, '#/components/schemas/EnvironmentImportFailure');
  const problem = { type: 'https://gromesh.dev/problems/422', title: 'Unprocessable Content', status: 422, detail: 'The import was not applied' };
  const errors = [{ path: 'document.services.0.port', message: 'must be <= 65535' }, { path: 'document.routes.0.name', message: 'conflicts with an existing route' }];
  validate('EnvironmentImportFailure', { ...problem, added: [], modified: [], removed: [], errors });
  validate('EnvironmentImportFailure', failure.examples.missingSecret.value);
  // Nothing applied: a failure never carries changes, and always says why.
  validate('EnvironmentImportFailure', { ...problem, added: [{ kind: 'services', id: '00000000-0000-4000-8000-000000000001', label: 'orders', change: 'added' }], modified: [], removed: [], errors }, false);
  validate('EnvironmentImportFailure', { ...problem, added: [], modified: [], removed: [], errors: [] }, false);
  validate('EnvironmentImportFailure', { ...problem, errors }, false);
  assert.match(contract.paths['/environments/{envId}/import'].post.description, /ALL OR NOTHING/);
});
