import { createHash } from 'node:crypto';

export const repository = 'grometis/gromesh-gateway';
export const requiredStages = Object.freeze(['install','generated-client','contracts','typecheck','unit-integration','build','charts','ui-acceptance','agent','isolation','compose-e2e','kind-e2e','migration-regression','dependency-scan','image-scan']);
const testStages=['unit-integration','ui-acceptance','agent','isolation','compose-e2e','kind-e2e','migration-regression'];
const refuse = reason => { throw new Error(`Jenkins policy refused: ${reason}`); };
export const isSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
export const isDigest = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);

function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  refuse('non-JSON canonical value');
}
export const canonicalJson = canonical;
export const canonicalHash = value => createHash('sha256').update(canonical(value)).digest('hex');

export function validateSource(source) {
  if (!source || source.repository !== repository || !isSha(source.sha)) refuse('source repository or full SHA');
  if (typeof source.branch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(source.branch)
      || source.branch.includes('..') || source.branch.includes('//')) refuse('branch');
  if (!['push','pull_request','manual'].includes(source.event)) refuse('event');
  if (source.event === 'pull_request') {
    if (!Number.isSafeInteger(source.pr) || source.pr < 1 || !isSha(source.baseSha)) refuse('PR identity');
    if(source.headSha!==undefined && !isSha(source.headSha))refuse('PR head SHA');
  } else if (source.pr !== null || source.baseSha !== null) refuse('unexpected PR identity');
  return source;
}

export function assertCompleteCi(result, expected) {
  // expected is resolved by the trusted coordinator, never from an uploaded PR artifact.
  validateSource(expected?.source); validateSource(result?.source);
  if (result.schema !== 'gromesh-jenkins-ci/v1' || canonicalHash(result.source) !== canonicalHash(expected.source)
      || !isSha(expected.pipelineSha) || result.pipelineSha !== expected.pipelineSha) refuse('CI source/pipeline identity');
  if(result.source.event==='pull_request' && (!isSha(result.source.headSha) || result.source.headSha===result.source.sha))refuse('PR tested merge and head identities required');
  if (!/^[1-9][0-9]*$/.test(expected.buildId) || result.build?.id !== expected.buildId || result.build?.job !== expected.job
      || !/^gromesh-gateway\/gromesh-ci\/gromesh-(main|prs|branches)$/.test(expected.job)) refuse('CI build identity');
  const path = expected.job.split('/').map(p => `/job/${p}`).join('') + `/${expected.buildId}/`;
  if (result.build.url !== 'https://jenkins.grometis.com' + path) refuse('CI official build URL');
  if (!/^v26\.(?:1[3-9]|[2-9][0-9])\.[0-9]+$/.test(result.tools?.node ?? '') || result.tools?.pnpm !== '10.28.0'
      || !/^go1\.27\.(?:[2-9]|[1-9][0-9]+)$/.test(result.tools?.go ?? '')) refuse('CI toolchain');
  if (!Array.isArray(result.stages) || result.stages.length !== requiredStages.length) refuse('CI incomplete stages');
  const ids = new Set();
  for (const stage of result.stages) {
    if (!requiredStages.includes(stage.id) || ids.has(stage.id) || stage.status !== 'SUCCESS' || stage.exitCode !== 0
        || !Number.isFinite(stage.durationMs) || stage.durationMs < 0 || !Array.isArray(stage.artifacts)) refuse('CI failed, skipped or duplicate stage');
    ids.add(stage.id);
    if(stage.complete!==true||stage.outputTruncated===true||stage.artifacts.length<2
      ||!['stdout.log','stderr.log'].every(p=>stage.artifacts.some(a=>a.path===p&&a.kind==='log'))
      ||stage.artifacts.some(a=>!a||!Number.isSafeInteger(a.bytes)||a.bytes<0||!/^[a-f0-9]{64}$/.test(a.sha256??'')||!(/^(stdout|stderr)\.log$|^kong-candidate\.(json|log)$|^screenshots\/[A-Za-z0-9._-]+\.png$/).test(a.path??'')))refuse('CI execution evidence missing or truncated');
    if(testStages.includes(stage.id)&&(!stage.tests?.known||!Number.isSafeInteger(stage.tests.passed)||stage.tests.passed<1
      ||stage.tests.failed!==0||!Number.isSafeInteger(stage.tests.skipped)||stage.tests.skipped<0))refuse('CI test counts missing/failed');
    if(stage.id==='ui-acceptance'&&!stage.artifacts.some(a=>a.kind==='screenshot'&&a.path.startsWith('screenshots/')))refuse('UI screenshot missing');
    if (stage.id === 'image-scan' && canonical([...stage.platforms ?? []].sort()) !== canonical(['linux/amd64','linux/arm64'])) refuse('CI scan platform matrix');
  }
  return result;
}

export function assertPublishable(source, result, expected) {
  validateSource(source);
  if (source.event !== 'push' || source.branch !== 'main' || source.pr !== null) refuse('PR/manual/tag cannot publish official images');
  assertCompleteCi(result, expected);
  if (canonicalHash(source) !== canonicalHash(result.source) || expected.job !== 'gromesh-gateway/gromesh-ci/gromesh-main') refuse('publication CI identity');
  return result;
}
