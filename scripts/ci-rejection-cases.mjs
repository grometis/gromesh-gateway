import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import * as evidence from './ci-evidence.mjs';

const secret = 'SYNTHETIC_SECRET_do_not_publish_9X7';
test('CLI rejection is one closed JSON record without hostile context', () => {
  const result = spawnSync(process.execPath, ['scripts/ci-supply-chain.mjs', secret], {
    encoding: 'utf8', env: { ...process.env, IMAGE_NAME: secret, TARGET_ARCH: secret,
      GITHUB_JOB: secret, GITHUB_RUN_ID: secret, GITHUB_RUN_ATTEMPT: secret },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.includes(secret), false);
  assert.deepEqual(JSON.parse(result.stderr), { code: 'SUPPLY_COMMAND', artifact: 'sbom' });
});
test('rejection codes form a frozen exported enum', () => {
  assert.ok(Object.isFrozen(evidence.RejectionCode));
  assert.equal(evidence.RejectionCode?.SUPPLY_COMMAND, 'SUPPLY_COMMAND');
});

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateSbom, validateDigest, validateSupplyChain, jobContext, safeText } from './ci-supply-chain.mjs';
import { localImageIdentity, publishedImageIdentity, manifestConfig, sha256 } from './ci-image-identity.mjs';
import { archiveConfig, writeDockerSave } from './fixtures/docker-save.mjs';
import { validatePrImageSbom } from './ci-pr-sbom.mjs';

const C = evidence.RejectionCode;
const id = `sha256:${'b'.repeat(64)}`;
const env = { IMAGE_NAME: 'agent', TARGET_ARCH: 'arm64', RUNNER_ARCH: 'ARM64',
  GITHUB_SHA: 'a'.repeat(40), LOCAL_IMAGE_ID: id, LOCAL_SBOM_DIGEST: id, LOCAL_IDENTITY_KIND: 'docker-daemon',
  GITHUB_JOB: 'image-scan', GITHUB_RUN_ID: '1234', GITHUB_RUN_ATTEMPT: '2', SYNTHETIC_PASSWORD: secret };
const context = jobContext(env, false, 'pr');
const publication = { ...env, EXPECTED_DIGEST: id, PUBLISHED_SHA: env.GITHUB_SHA,
  PUBLISHED_ARCH: 'arm64', GITHUB_REPOSITORY_OWNER: 'gromesh', PUBLISHED_CONFIG_ID: id,
  PUBLISHED_IMAGE: `ghcr.io/gromesh/gromesh-agent:${env.GITHUB_SHA}-arm64` };
const purl = locator => ({ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: locator });
const doc = () => ({
  spdxVersion: 'SPDX-2.3', dataLicense: 'CC0-1.0', SPDXID: 'SPDXRef-DOCUMENT', name: context.sourceName,
  documentNamespace: `https://anchore.com/syft/image/${context.sourceName}-12345678-1234-4123-8123-123456789abc`,
  creationInfo: { created: '2026-11-02T00:00:00Z', creators: ['Organization: Anchore, Inc', 'Tool: syft-1.18.1'] },
  packages: [{ SPDXID: 'SPDXRef-Lib', name: 'lib', downloadLocation: 'NOASSERTION', filesAnalyzed: false,
    externalRefs: [purl('pkg:apk/alpine/lib@1')] },
  { SPDXID: 'SPDXRef-Root', name: context.sourceName, versionInfo: env.GITHUB_SHA,
    downloadLocation: 'NOASSERTION', filesAnalyzed: false, primaryPackagePurpose: 'CONTAINER',
    checksums: [{ algorithm: 'SHA256', checksumValue: id.slice(7) }],
    externalRefs: [purl(`pkg:oci/${context.sourceName}@${id}?arch=arm64&tag=${id.slice(7)}`)] }],
  files: [{ SPDXID: 'SPDXRef-File', fileName: 'usr/lib/lib', checksums: [{ algorithm: 'SHA1', checksumValue: 'a'.repeat(40) }] }],
  relationships: [{ spdxElementId: 'SPDXRef-DOCUMENT', relatedSpdxElement: 'SPDXRef-Root', relationshipType: 'DESCRIBES' },
    { spdxElementId: 'SPDXRef-Lib', relatedSpdxElement: 'SPDXRef-File', relationshipType: 'CONTAINS' }],
});
const cases = new Map();
function add(code, action, artifact = 'sbom') {
  assert.equal(cases.has(code), false, `duplicate case ${code}`);
  cases.set(code, { action, artifact });
}
function sbom(code, mutate) {
  add(code, root => {
    const value = doc(); mutate(value);
    writeFileSync(join(root, 'gromesh-agent-arm64.spdx.json'), JSON.stringify(value));
    validateSbom(root, context);
  });
}
for (const [code, mutate] of [
  ['OBJECT_TYPE', d => { d.creationInfo = null; }],
  ['OBJECT_FIELDS', d => { d[secret] = secret; }],
  ['OBJECT_REQUIRED', d => { delete d.creationInfo; }],
  ['ARRAY_BUDGET', d => { d.packages = []; }],
  ['TEXT_BUDGET', d => { d.packages[0].name = ''; }],
  ['TEXT_CHARACTERS', d => { d.packages[0].name = secret; }],
  ['TEXT_PATTERN', d => { d.packages[0].name = 'lib?'; }],
  ['STRUCTURED_TRAVERSAL', d => { d.packages[0].name = 'lib..x'; }],
  ['STRUCTURED_WORD_BUDGET', d => { d.packages[0].name = 'x'.repeat(32); }],
  ['PROSE_LOCATION', d => { d.packages[0].description = 'lib..x'; }],
  ['PROSE_CREDENTIAL', d => { d.packages[0].description = 'a password phrase'; }],
  ['PROSE_TERMINOLOGY', d => { d.packages[0].description = 'a token phrase'; }],
  ['PROSE_ENCODED_CREDENTIAL', d => { d.packages[0].description = 'dG9rZW49YWJjMTIz'; }],
  ['PROSE_WORD_BUDGET', d => { d.packages[0].description = 'a'.repeat(32); }],
  ['DOWNLOAD_REF_SENSITIVE', d => { d.packages[0].downloadLocation = 'github:owner/repo#token-1'; }],
  ['DOWNLOAD_REF_FORMAT', d => { d.packages[0].downloadLocation = 'github:owner/repo#latest'; }],
  ['GITHUB_REPOSITORY', d => { d.packages[0].downloadLocation = `github:${'a-'.repeat(20)}b/repo`; }],
  ['DOWNLOAD_HOST', d => { d.packages[0].downloadLocation = 'https://127.0.0.1/repo'; }],
  ['DOWNLOAD_HOST_LABEL', d => { d.packages[0].downloadLocation = 'https://bad-.example/repo'; }],
  ['DOWNLOAD_HOST_SENSITIVE', d => { d.packages[0].downloadLocation = 'https://token.example/repo'; }],
  ['DOWNLOAD_HOST_ENTROPY', d => { d.packages[0].downloadLocation = 'https://abcd0123456789efghijkl.example/repo'; }],
  ['DOWNLOAD_SHORTHAND', d => { d.packages[0].downloadLocation = 'github:owner/repo#'; }],
  ['DOWNLOAD_URL', d => { d.packages[0].downloadLocation = 'https://user@host.example/repo'; }],
  ['DOWNLOAD_PORT', d => { d.packages[0].downloadLocation = 'https://host.example:444/repo'; }],
  ['DOWNLOAD_PATH', d => { d.packages[0].downloadLocation = 'https://host.example/a//b'; }],
  ['DOWNLOAD_PATH_SENSITIVE', d => { d.packages[0].downloadLocation = 'https://host.example/token/value'; }],
  ['IDENTIFIER_BUDGET', d => {
    d.files[0].fileName = `usr/${'a/'.repeat(90)}b`;
    d.files[0].SPDXID = `SPDXRef-File-${d.files[0].fileName.replaceAll('/', '-')}-${'b'.repeat(16)}`;
  }],
  ['TIMESTAMP', d => { d.creationInfo.created = '2026-02-31T00:00:00Z'; }],
  ['IMAGE_PATH_SEGMENTS', d => { d.files[0].fileName = 'usr/../lib'; }],
  ['IMAGE_PATH_ROOT', d => { d.files[0].fileName = '/outside/lib'; }],
  ['IMAGE_PATH_SENSITIVE', d => { d.files[0].fileName = 'usr/.env'; }],
  ['IMAGE_PATH_HOST', d => { d.files[0].fileName = 'usr/runner/work'; }],
  ['CHECKSUM_ALGORITHM', d => { d.files[0].checksums[0].algorithm = 'SHA3'; }],
  ['CHECKSUM_LENGTH', d => { d.files[0].checksums[0].checksumValue = 'a'; }],
  ['CHECKSUM_UNIQUE', d => { d.files[0].checksums.push(d.files[0].checksums[0]); }],
  ['PURL_CATEGORY', d => { d.packages[0].externalRefs[0].referenceCategory = 'SECURITY'; }],
  ['OCI_PACKAGE', d => { d.packages[0].externalRefs = [purl('pkg:oci/lib')]; }],
  ['OCI_CHECKSUM', d => { delete d.packages[1].checksums; }],
  ['OCI_ROOT_CHECKSUM', d => { d.packages[1].checksums[0].checksumValue = 'c'.repeat(64); }],
  ['OCI_PURL_DIGEST', d => { d.packages[1].externalRefs[0].referenceLocator = d.packages[1].externalRefs[0].referenceLocator.replace(id, `sha256:${'c'.repeat(64)}`); }],
  ['OCI_SOURCE_NAME', d => { d.packages[1].externalRefs[0].referenceLocator = d.packages[1].externalRefs[0].referenceLocator.replace(context.sourceName, 'other'); }],
  ['OCI_SOURCE_TAG', d => { d.packages[1].externalRefs[0].referenceLocator = d.packages[1].externalRefs[0].referenceLocator.replace(/tag=.*/, 'tag=' + 'c'.repeat(64)); }],
  ['OCI_PURL_ARCH', d => { d.packages[1].externalRefs[0].referenceLocator = d.packages[1].externalRefs[0].referenceLocator.replace('arch=arm64', 'arch=amd64'); }],
  ['OCI_LOCATOR', d => { d.packages[1].externalRefs[0].referenceLocator += '&unknown=value'; }],
  ['PURL_ENCODING', d => { d.packages[0].externalRefs = [purl('pkg:apk/alpine/%zz@1')]; }],
  ['PURL_COMPONENT', d => { d.packages[0].externalRefs = [purl('pkg:apk/alpine/%2f@1')]; }],
  ['PURL_GRAMMAR', d => { d.packages[0].externalRefs = [purl('pkg:gem/lib@1')]; }],
  ['PURL_VERSION', d => { d.packages[0].externalRefs = [purl('pkg:apk/alpine/lib@')]; }],
  ['PURL_NAME', d => { d.packages[0].externalRefs = [purl('pkg:apk/alpine//lib@1')]; }],
  ['RUNTIME_VERSION', d => { d.packages[0].externalRefs = [purl('pkg:generic/lib@1')]; }],
  ['RUNTIME_PACKAGE', d => { d.packages[0].externalRefs = [purl('pkg:generic/node@26.13.0')]; }],
  ['APK_NAME', d => { d.packages[0].externalRefs = [purl('pkg:apk/lib@1')]; }],
  ['NPM_NAME', d => { d.packages[0].externalRefs = [purl('pkg:npm/lib+extra@1')]; }],
  ['PURL_SUBPATH', d => { d.packages[0].externalRefs = [purl('pkg:apk/alpine/lib@1#src')]; }],
  ['PURL_QUALIFIER', d => { d.packages[0].externalRefs = [purl('pkg:apk/alpine/lib@1?arch=arm64&arch=arm64')]; }],
  ['PURL_QUALIFIER_VALUE', d => { d.packages[0].externalRefs = [purl('pkg:apk/alpine/lib@1?upstream=lib:other')]; }],
  ['PURL_QUALIFIER_KEY', d => { d.packages[0].externalRefs = [purl('pkg:npm/lib@1?arch=arm64')]; }],
  ['APK_ARCH', d => { d.packages[0].externalRefs = [purl('pkg:apk/alpine/lib@1?arch=x86_64')]; }],
  ['APK_DISTRO', d => { d.packages[0].externalRefs = [purl('pkg:apk/alpine/lib@1?distro=other')]; }],
  ['APK_EPOCH', d => { d.packages[0].externalRefs = [purl('pkg:apk/alpine/lib@1?epoch=x')]; }],
  ['SAFE_TEXT_SENSITIVE', d => { d.packages[0].externalRefs = [purl('pkg:apk/alpine/lib@1?upstream=token')]; }],
  ['SAFE_TEXT_WORD_BUDGET', d => { d.packages[0].externalRefs = [purl(`pkg:apk/alpine/lib@1?upstream=${'a'.repeat(32)}`)]; }],
  ['LICENSE_SENSITIVE', d => { d.packages[0].licenseDeclared = 'token'; }],
  ['LICENSE_TOKENS', d => { d.packages[0].licenseDeclared = 'MIT++'; }],
  ['LICENSE_TOKEN_BUDGET', d => { d.packages[0].licenseDeclared = ' '; }],
  ['LICENSE_SENTINEL', d => { d.packages[0].licenseDeclared = 'NONE OR MIT'; }],
  ['LICENSE_TERM', d => { d.packages[0].licenseDeclared = 'AND'; }],
  ['LICENSE_REFERENCE', d => { d.packages[0].licenseDeclared = 'LicenseRef-absent'; }],
  ['LICENSE_PARENTHESES', d => { d.packages[0].licenseDeclared = '(MIT'; }],
  ['LICENSE_EXPRESSION', d => { d.packages[0].licenseDeclared = 'MIT BSD'; }],
  ['EXTRACTED_LICENSE_ID', d => { d.hasExtractedLicensingInfos = [{ licenseId: 'MIT', extractedText: 'MIT' }]; }],
  ['EXTRACTED_LICENSE_TEXT', d => { d.hasExtractedLicensingInfos = [{ licenseId: 'LicenseRef-custom', extractedText: secret }]; }],
  ['COMMENT', d => { d.comment = secret; }],
  ['COPYRIGHT', d => { d.packages[0].copyrightText = secret; }],
  ['SPDX_HEADER', d => { d.spdxVersion = 'SPDX-3.0'; }],
  ['SPDX_NAME', d => { d.name = secret; }],
  ['SPDX_NAMESPACE', d => { d.documentNamespace = secret; }],
  ['SPDX_CREATORS', d => { d.creationInfo.creators[1] = 'Tool: other'; }],
  ['SPDX_ID_UNIQUE', d => { d.packages[0].SPDXID = d.SPDXID; }],
  ['HOMEPAGE_PACKAGE', d => { d.packages[0].homepage = 'https://host.example'; }],
  ['ROOT_VERSION', d => { d.packages[1].versionInfo = 'c'.repeat(40); }],
  ['FILES_ANALYZED', d => { d.packages[0].filesAnalyzed = 'false'; }],
  ['VERIFICATION_CODE', d => { d.packages[0].packageVerificationCode = {}; }],
  ['PACKAGE_ATTRIBUTION', d => { d.packages[0].supplier = 'some person'; }],
  ['PACKAGE_PURPOSE', d => { d.packages[0].primaryPackagePurpose = 'UNKNOWN'; }],
  ['SOURCE_INFO', d => { d.packages[0].sourceInfo = 'unrecognized source'; }],
  ['ROOT_CONTAINER', d => { d.packages.pop(); }],
  ['ROOT_PURL', d => { delete d.packages[1].externalRefs; }],
  ['ROOT_DESCRIBES', d => { d.relationships[0].relatedSpdxElement = 'SPDXRef-Lib'; }],
  ['FILE_TYPES', d => { d.files[0].fileTypes = ['UNKNOWN']; }],
  ['DOCUMENT_DESCRIBES', d => { d.documentDescribes = ['SPDXRef-absent']; }],
  ['RELATION_COMMENT', d => { d.relationships[1].comment = secret; }],
  ['RELATION_REFERENCE', d => { d.relationships[1].relatedSpdxElement = 'SPDXRef-absent'; }],
  ['RELATION_TYPE', d => { d.relationships[1].relationshipType = 'UNKNOWN'; }],
]) sbom(code, mutate);
for (const [code, type, locator, category = 'SECURITY'] of [
  ['CPE_CATEGORY', 'cpe23Type', 'cpe:2.3:a:lib:lib:1:*:*:*:*:*:*:*', 'PACKAGE-MANAGER'],
  ['CPE_TYPE', 'unknown', 'lib'],
  ['CPE_GRAMMAR', 'cpe23Type', 'cpe::2.3:a:lib:lib:1:*:*:*:*:*:*:*'],
  ['CPE23_GRAMMAR', 'cpe23Type', 'cpe:2.3:a:lib'],
  ['CPE22_GRAMMAR', 'cpe22Type', 'cpe:2.2:a:lib'],
  ['CPE_PART', 'cpe23Type', 'cpe:2.3:x:lib:lib:1:*:*:*:*:*:*:*'],
  ['CPE_SENSITIVE', 'cpe23Type', 'cpe:2.3:a:password:lib:1:*:*:*:*:*:*:*'],
]) sbom(code, d => { d.packages[0].externalRefs = [{ referenceCategory: category, referenceType: type, referenceLocator: locator }]; });

function evidenceValue() {
  return { suite: 'product-e2e', jobId: 'e2e:1234:2', runId: 1234, runAttempt: 2, sha: env.GITHUB_SHA,
    status: 'PASS', runnerArch: 'arm64', toolVersions: { node: '26.13.0' },
    counts: { total: 1, passed: 1, failed: 0, skipped: 0, flaky: 0 }, countUnit: 'tests', durationMs: 1 };
}
for (const [code, mutate] of [
  ['SCHEMA_INTEGER', d => { d.runId = -1; }],
  ['SCHEMA_STRING', d => { d.sha = 2; }],
  ['SCHEMA_CONTROL', d => { d.sha = '\u0000'; }],
  ['SCHEMA_ENUM', d => { d.status = 'OTHER'; }],
  ['SCHEMA_PATTERN', d => { d.sha = 'invalid'; }],
  ['EVIDENCE_TOOLS', d => { d.toolVersions = {}; }],
  ['EVIDENCE_JOB_ID', d => { d.jobId = 'e2e:1234:3'; }],
  ['EVIDENCE_BLOCKED', d => { d.status = 'BLOCKED'; d.failureCategory = 'SETUP'; }],
  ['EVIDENCE_MEASURED', d => { delete d.counts; }],
  ['EVIDENCE_TOTAL', d => { d.counts.total = 0; }],
  ['EVIDENCE_COUNTS', d => { d.counts.total = 2; }],
  ['EVIDENCE_PASS', d => { d.counts.passed = 0; d.counts.failed = 1; }],
  ['EVIDENCE_FAILURE', d => { d.failureCategory = 'UNKNOWN'; }],
]) add(code, () => { const d = evidenceValue(); mutate(d); evidence.validateEvidence(d); }, 'evidence');
for (const [code, extra, mode = 'images', kong = false] of [
  ['JOB_IMAGE_ARCH', { IMAGE_NAME: secret }], ['JOB_RUNNER_ARCH', { RUNNER_ARCH: 'X64' }],
  ['JOB_MODE', {}, secret], ['JOB_PR_KONG', { IMAGE_NAME: 'kong' }, 'pr', true],
  ['LOCAL_IDENTITY_KIND', { LOCAL_IDENTITY_KIND: secret }, 'pr'],
  ['PUBLISHED_CONTEXT', { PUBLISHED_SHA: secret }], ['PUBLISHED_IMAGE', { PUBLISHED_IMAGE: secret }],
  ['PUBLISHED_CONFIG', { PUBLISHED_CONFIG_ID: secret }], ['DIGEST_FORMAT', { EXPECTED_DIGEST: secret }],
]) add(code, () => jobContext({ ...publication, ...extra }, kong, mode));

add('SAFE_TEXT_LOCATION', () => safeText('a..b'));
add('SAFE_TEXT_ENTROPY', () => safeText('abcde fghij klmno pqrst uvwxy 01234 56789'));
add('SUPPLY_COMMAND', root => validateSupplyChain({ command: secret, workspace: root }));
add('WORKSPACE_REQUIRED', () => validateSupplyChain({ command: 'pr', env }));
add('TEMPORARY_REQUIRED', root => validateSupplyChain({ command: 'images', workspace: root, env: publication }));
add('EXACT_FILE', root => validateSbom(root, context));
add('DIGEST_CONTENT', root => {
  writeFileSync(join(root, 'agent-arm64.txt'), secret); validateDigest(root, context);
}, 'digest');
add('JSON_SYNTAX', root => {
  writeFileSync(join(root, 'gromesh-agent-arm64.spdx.json'), secret); validateSbom(root, context);
});
add('JSON_CANONICAL', root => {
  writeFileSync(join(root, 'gromesh-agent-arm64.spdx.json'), JSON.stringify(doc()).replace('"spdxVersion":', `"spdxVersion":"${secret}","spdxVersion":`));
  validateSbom(root, context);
});
add('FILE_SYMLINK', root => {
  writeFileSync(join(root, 'target'), secret); symlinkSync(join(root, 'target'), join(root, 'link'));
  evidence.readRegularFile(join(root, 'link'), 8192);
});
add('FILE_ACCESS', root => evidence.readRegularFile(join(root, secret), 8192));
add('FILE_BUDGET', root => {
  writeFileSync(join(root, 'data'), secret); evidence.readRegularFile(join(root, 'data'), 1);
});
add('FILE_ENCODING', root => {
  writeFileSync(join(root, 'data'), Buffer.from([255])); evidence.readRegularFile(join(root, 'data'), 8192);
});
add('DIRECTORY_PATH', root => {
  symlinkSync(root, join(root, 'link')); evidence.directoryPath(join(root, 'link'));
});
for (const [code, names, contents] of [
  ['EVIDENCE_SUITES', [], []], ['EVIDENCE_SUITE', [secret], []],
  ['DIRECTORY_BUDGET', ['product-e2e'], [['a', secret], ['b', secret]]],
  ['DIRECTORY_COUNT', ['product-e2e'], []],
  ['EVIDENCE_FILENAME', ['product-e2e'], [['a', secret]]],
  ['EVIDENCE_CONTROL', ['product-e2e'], [['product-e2e.json', JSON.stringify(evidenceValue()) + '\n']]],
]) add(code, root => {
  for (const [name, bytes] of contents) writeFileSync(join(root, name), bytes);
  evidence.validateDirectory(root, names);
}, 'evidence');
const generateEnv = { ...env, EVIDENCE_OUTCOME: 'success', EVIDENCE_TOOL_VERSIONS: '{}' };
const reportValue = { stats: { expected: 1, unexpected: 0, skipped: 0, flaky: 0, duration: 1 }, hidden: secret };
function generate(root, extra = {}, reports = [reportValue]) {
  const directory = join(root, 'out'); mkdirSync(directory);
  const paths = reports.map((data, i) => {
    const path = join(root, `report-${i}.json`); writeFileSync(path, JSON.stringify(data)); return path;
  });
  evidence.generateEvidence({ suite: 'product-e2e', directory, report: paths, env: { ...generateEnv, ...extra } });
}
add('NUMERIC_ID', root => generate(root, { GITHUB_RUN_ID: secret }), 'evidence');
add('EVIDENCE_OUTCOME', root => generate(root, { EVIDENCE_OUTCOME: secret }), 'evidence');
add('REPORTS', root => generate(root, {}, Array(17).fill(reportValue)), 'evidence');
add('REPORT_REQUIRED', root => generate(root, {}, []), 'evidence');
add('REPORT_STATS', root => generate(root, {}, [{ hidden: secret }]), 'evidence');
add('REPORT_DURATION', root => generate(root, {}, [{ stats: { ...reportValue.stats, duration: secret } }]), 'evidence');
add('REPORT_UNIT', root => generate(root, {}, [reportValue, { ...reportValue, countUnit: 'commands' }]), 'evidence');
add('EVIDENCE_EXECUTION', root => generate(root, { EVIDENCE_OUTCOME: 'skipped' }), 'evidence');
add('REPORT_PATH', root => {
  const file = join(root, 'report.json'); writeFileSync(file, JSON.stringify(reportValue));
  symlinkSync(root, join(root, 'link'));
  evidence.generateEvidence({ suite: 'product-e2e', directory: root, report: join(root, 'link', 'report.json'), env: generateEnv });
}, 'evidence');
for (const [code, args] of [
  ['CLI_ARGUMENTS', ['generate']], ['CLI_COMMAND', [secret]], ['CLI_OPTIONS', ['validate', '--unknown']],
]) add(code, () => {
  const result = spawnSync(process.execPath, ['scripts/ci-evidence.mjs', ...args], { env: { ...process.env, ...env }, encoding: 'utf8' });
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  const value = JSON.parse(result.stderr);
  assert.equal(value.code, code);
  // Exercise the real CLI and feed its code-only failure through the same non-disclosure checks below.
  throw new evidence.Rejection(value.code, value.artifact);
}, 'evidence');
const config = archiveConfig('arm64');
const configId = sha256(config);
const manifest = JSON.stringify({ schemaVersion: 2, layers: [], config: { digest: configId } });
const manifestId = sha256(manifest);
add('MANIFEST_DIGEST', () => manifestConfig(manifest + secret, manifestId), 'digest');
add('MANIFEST_SHAPE', () => manifestConfig('{}', sha256('{}')), 'digest');
// Transport doubles write real private archives; no Docker, registry or network is invoked.
function identityTransport({ metadata = {}, archive = {}, commandFailure = false, published = manifest } = {}) {
  return (command, args) => {
    assert.equal(command, 'docker');
    if (args[1] === 'inspect') return { status: commandFailure ? 1 : 0, stdout: JSON.stringify({ Id: configId, Os: 'linux', Architecture: 'arm64', ...metadata }) };
    if (args[0] === 'save') { writeDockerSave(args[3], archive); return { status: 0 }; }
    assert.equal(args[0], 'buildx');
    return { status: 0, stdout: published };
  };
}
add('DOCKER_COMMAND', root => localImageIdentity('image', { env: { RUNNER_TEMP: root }, execute: identityTransport({ commandFailure: true }) }), 'digest');
add('IMAGE_PLATFORM', root => localImageIdentity('image', { env: { RUNNER_TEMP: root }, execute: identityTransport({ metadata: { Os: 'windows' } }) }), 'digest');
add('IMAGE_BLOB', root => localImageIdentity('image', { env: { RUNNER_TEMP: root }, execute: identityTransport({ archive: { missingConfig: true } }) }), 'digest');
add('IMAGE_PLATFORM_MATCH', root => localImageIdentity('image', { env: { RUNNER_TEMP: root }, execute: identityTransport({ metadata: { Architecture: 'amd64' } }) }), 'digest');
add('IMAGE_CONFIG', root => localImageIdentity('image', { env: { RUNNER_TEMP: root }, execute: identityTransport({ archive: { config: config + ' ' } }) }), 'digest');
add('PUBLISHED_ARCH', root => publishedImageIdentity('image:tag', { env: { ...publication, RUNNER_TEMP: root, TARGET_ARCH: 'amd64' }, execute: identityTransport() }), 'digest');
add('PUBLISHED_MANIFEST', root => {
  const published = manifest.replace(configId, id);
  publishedImageIdentity('image:tag', { env: { ...publication, RUNNER_TEMP: root, EXPECTED_DIGEST: sha256(published) }, execute: identityTransport({ published }) });
}, 'digest');
add('PR_ARCH', root => validatePrImageSbom('image', 'agent', { env: { ...env, TARGET_ARCH: 'amd64', RUNNER_ARCH: 'X64', RUNNER_TEMP: root }, execute: identityTransport() }));
add('SYFT_COMMAND', root => validatePrImageSbom('image', 'agent', { env: { ...env, RUNNER_TEMP: root }, execute: (command, args, options) => {
  if (args[0] === 'run') { assert.equal(options.stdio, undefined); return { status: 1, stdout: secret, stderr: secret }; }
  return identityTransport()(command, args);
} }));

for (const [code, { action, artifact }] of cases) test(`reachable rejection ${code} emits only public codes/context`, t => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'rejection-cases-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => action(root), error => {
    assert.ok(error instanceof evidence.Rejection, `native error for ${code}`);
    assert.equal(error.code, code);
    // Error messages, causes and stacks are never part of the public diagnostic contract.
    Object.assign(error, { message: secret, stack: secret, cause: { document: doc(), secret }, path: root });
    const line = evidence.rejectionLine(error, { artifact, mode: 'pr', env });
    assert.deepEqual(JSON.parse(line), { code, artifact, image: 'agent', arch: 'arm64', mode: 'pr', jobId: 'image-scan:1234:2' });
    for (const fragment of [secret, root, context.sourceName, env.GITHUB_SHA, 'spdxVersion', 'referenceLocator', 'sha256:', 'lib..x', 'report-', 'password phrase']) {
      assert.equal(line.includes(fragment), false, `${code} leaked document/context`);
    }
    assert.equal(line.includes('\n'), false);
    return true;
  });
});
test('every thrown rule code is enumerated and every enumerated code has an executable negative case', () => {
  const referenced = new Set();
  for (const file of ['ci-evidence.mjs', 'ci-supply-chain.mjs', 'ci-pr-sbom.mjs', 'ci-image-identity.mjs', 'ci-run-evidence.mjs']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    for (const match of source.matchAll(/RejectionCode\.([A-Z_0-9]+)/g)) referenced.add(match[1]);
    assert.doesNotMatch(source, /throw new Error\(/);
    const validations = file === 'ci-evidence.mjs' ? source.slice(source.indexOf('function matchesSchema')) : source;
    for (const match of validations.matchAll(/requireValid\(([\s\S]*?)\);/g)) {
      assert.match(match[1], /, RejectionCode\.[A-Z_0-9]+$/, 'every assertion must name an enum member');
    }
  }
  assert.deepEqual([...referenced].sort(), Object.keys(C).sort());
  assert.deepEqual([...cases.keys()].sort(), Object.keys(C).sort());
});

test('diagnostic context drops every noncanonical or private value', () => {
  const error = new evidence.Rejection(C.COMMENT);
  for (const hostile of [secret, `\n${secret}`, 'unknown', {}, []]) {
    const line = evidence.rejectionLine(error, { artifact: hostile, image: hostile, arch: hostile, mode: hostile,
      env: { IMAGE_NAME: hostile, TARGET_ARCH: hostile, GITHUB_JOB: hostile, GITHUB_RUN_ID: hostile, GITHUB_RUN_ATTEMPT: hostile } });
    assert.deepEqual(JSON.parse(line), { code: C.COMMENT, artifact: 'evidence' });
  }
  for (const key of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) {
    for (const badId of ['0', '01', '1\n', '1234:2', secret, '9007199254740992']) {
      const line = evidence.rejectionLine(error, { env: { ...env, [key]: badId } });
      assert.equal('jobId' in JSON.parse(line), false);
    }
  }
  assert.throws(() => new evidence.Rejection(secret), TypeError);
  assert.throws(() => { error.code = secret; }, TypeError);
  assert.equal(evidence.rejectionLine(new Error(secret), { env: {} }), '{"code":"FILE_ACCESS","artifact":"evidence"}');
});

test('identity rejects JSON scalars and malformed index structures with a rule code', t => {
  for (const raw of ['null', '[]', '1', '"value"']) {
    assert.throws(() => manifestConfig(raw, sha256(raw)), error => error.code === C.MANIFEST_SHAPE);
    assert.throws(() => localImageIdentity('image', { execute: () => ({ status: 0, stdout: raw }) }), error => error.code === C.DIGEST_FORMAT);
  }
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'rejection-index-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifests = { hidden: secret };
  assert.throws(() => localImageIdentity('image', { env: { RUNNER_TEMP: root }, execute: identityTransport({
    archive: { manifests },
  }) }), error => error.code === C.MANIFEST_SHAPE);
});

test('all independent refused artifacts emit one JSON line each and prevent the shell upload step', t => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'rejection-upload-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace'); const temporary = join(root, 'temp');
  const sbomDir = join(workspace, 'dist', 'sbom'); const digestDir = join(temporary, 'digests');
  mkdirSync(sbomDir, { recursive: true }); mkdirSync(digestDir, { recursive: true });
  const sbomFile = join(sbomDir, 'gromesh-agent-arm64.spdx.json');
  const digestFile = join(digestDir, 'agent-arm64.txt');
  const marker = join(root, 'upload');
  for (const [sbomBad, digestBad] of [[true, false], [false, true], [true, true], [false, false]]) {
    writeFileSync(sbomFile, sbomBad ? secret : JSON.stringify(doc()));
    writeFileSync(digestFile, digestBad ? secret : id);
    const result = spawnSync('bash', ['-e', '-c', '"$NODE_BINARY" "$SUPPLY_SCRIPT" images\nprintf uploaded > "$UPLOAD_MARKER"'], {
      encoding: 'utf8', env: { ...process.env, ...publication, NODE_BINARY: process.execPath,
        SUPPLY_SCRIPT: new URL('ci-supply-chain.mjs', import.meta.url).pathname, UPLOAD_MARKER: marker,
        GITHUB_WORKSPACE: workspace, RUNNER_TEMP: temporary },
    });
    assert.equal(result.status, sbomBad || digestBad ? 1 : 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.includes(secret), false);
    const records = result.stderr === '' ? [] : result.stderr.trimEnd().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(records, [
      ...(sbomBad ? [{ code: C.JSON_SYNTAX, artifact: 'sbom' }] : []),
      ...(digestBad ? [{ code: C.DIGEST_CONTENT, artifact: 'digest' }] : []),
    ].map(value => ({ ...value, image: 'agent', arch: 'arm64', mode: 'images', jobId: 'image-scan:1234:2' })));
    if (sbomBad || digestBad) assert.throws(() => readFileSync(marker));
    else assert.equal(readFileSync(marker, 'utf8'), 'uploaded');
  }
});

test('evidence CLI emits one closed record for each refused evidence file', t => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'rejection-evidence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const suite of ['product-e2e', 'mvp-e2e']) writeFileSync(join(root, `${suite}.json`), secret);
  const result = spawnSync(process.execPath, ['scripts/ci-evidence.mjs', 'validate', '--directory', root, 'product-e2e', 'mvp-e2e'], {
    encoding: 'utf8', env: { ...process.env, ...env },
  });
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.equal(result.stderr.includes(secret), false);
  assert.deepEqual(result.stderr.trimEnd().split('\n').map(line => JSON.parse(line)), Array(2).fill({
    code: C.JSON_SYNTAX, artifact: 'evidence', image: 'agent', arch: 'arm64', jobId: 'image-scan:1234:2',
  }));
});

test('native transport exceptions preserve the operation code without the native message', t => {
  const fail = () => { throw new Error(secret); };
  assert.throws(() => localImageIdentity('image', { execute: fail }), error => error.code === C.DOCKER_COMMAND && !error.message.includes(secret));
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'rejection-transport-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => validatePrImageSbom('image', 'agent', { env: { ...env, RUNNER_TEMP: root }, execute: (command, args) => {
    if (args[0] === 'run') return fail();
    return identityTransport()(command, args);
  } }), error => error.code === C.SYFT_COMMAND && !error.message.includes(secret));
  assert.throws(() => publishedImageIdentity('image:tag', { env: { ...publication, RUNNER_TEMP: root }, execute: (command, args) => {
    if (args[0] === 'buildx') return fail();
    return identityTransport()(command, args);
  } }), error => error.code === C.PUBLISHED_MANIFEST && !error.message.includes(secret));
});
