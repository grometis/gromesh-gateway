import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { applicationBuilds, validatePrImageSbom } from './ci-pr-sbom.mjs';

for (const [file, expected] of [
  ['apps/ui/src/main.tsx', ['ui']], ['apps/ui/Dockerfile', ['ui']],
  ['apps/control-plane/package.json', ['control-plane']], ['packages/compiler/package.json', ['control-plane']],
  ['contracts/control-plane.openapi.yaml', ['control-plane']],
  ['apps/agent/go.mod', ['agent']], ['apps/isolation/go.mod', ['agent']],
  ['pnpm-lock.yaml', ['control-plane', 'ui']], ['package.json', ['control-plane', 'ui']],
  ['pnpm-workspace.yaml', ['control-plane', 'ui']], ['tsconfig.base.json', ['control-plane', 'ui']],
  ['.dockerignore', ['agent', 'control-plane', 'ui']],
  ['scripts/ci-supply-chain.mjs', ['agent', 'control-plane', 'ui']],
  ['scripts/ci-pr-sbom.mjs', ['agent', 'control-plane', 'ui']],
  ['scripts/scan-changed-images.mjs', ['agent', 'control-plane', 'ui']],
  ['.github/workflows/ci.yml', ['agent', 'control-plane', 'ui']],
  ['.github/workflows/images.yml', ['agent', 'control-plane', 'ui']],
  ['TASKS.md', []], ['deploy/helm/data-plane/values.yaml', []],
]) {
  test(`PR image selection covers build input ${file}`, () => {
    assert.deepEqual(applicationBuilds([file]), expected);
  });
}
test('PR build selection deduplicates app and shared changes', () => {
  assert.deepEqual(applicationBuilds(['apps/ui/Dockerfile', 'pnpm-lock.yaml', 'apps/ui/package.json']), ['control-plane', 'ui']);
});

// Only the Docker transport is substituted: generation and rejection use full real inventories and the actual validator.
for (const [revision, name, arch] of [
  ...['agent', 'control-plane', 'ui'].flatMap(name => ['amd64', 'arm64'].map(arch => ['b43bee3', name, arch])),
  ['431e1fe', 'ui', 'arm64'],
]) {
  for (const corruption of ['none', 'partial', 'extra file', 'wrong image', 'wrong arch', 'syft failure', 'inspect failure']) {
    test(`PR SBOM ${revision} ${name} ${arch}: ${corruption}`, t => {
      const temporary = mkdtempSync(join(realpathSync(tmpdir()), 'pr-sbom-'));
      t.after(() => rmSync(temporary, { recursive: true, force: true }));
      const directory = new URL(`./fixtures/sbom/${revision}/`, import.meta.url);
      const context = Object.fromEntries(readFileSync(new URL(`gromesh-${name}-${arch}.context.env`, directory), 'utf8')
        .trim().split(/\s+/).map(pair => { const i = pair.indexOf('='); return [pair.slice(0, i), pair.slice(i + 1)]; }));
      const doc = JSON.parse(readFileSync(new URL(`gromesh-${name}-${arch}.spdx.json`, directory)));
      const root = doc.packages.find(pkg => pkg.primaryPackagePurpose === 'CONTAINER');
      const id = `sha256:${root.checksums.find(c => c.algorithm === 'SHA256').checksumValue}`;
      const image = `gromesh-scan/${name}:pr`;
      let generated = false;
      const execute = (command, args) => {
        assert.equal(command, 'docker');
        if (args[0] === 'image') {
          assert.deepEqual(args.slice(0, 3), ['image', 'inspect', image]);
          return { status: corruption === 'inspect failure' ? 1 : 0,
            stdout: JSON.stringify({ Id: id, Os: 'linux', Architecture: corruption === 'wrong arch' ? 's390x' : arch }) };
        }
        generated = true;
        assert.equal(args[0], 'run');
        const syft = args.find(arg => arg.startsWith('anchore/syft:'));
        const workflow = readFileSync(new URL('../.github/workflows/images.yml', import.meta.url), 'utf8');
        assert.ok(workflow.includes(syft));
        assert.match(syft, /^anchore\/syft:v1\.18\.1@sha256:[0-9a-f]{64}$/);
        assert.equal(args[args.indexOf(syft) + 1], `docker:${id}`);
        const sourceName = args[args.indexOf('--source-name') + 1];
        assert.equal(sourceName, `gromesh-${name}-${arch}-${context.GITHUB_SHA}-${id.slice(7)}`);
        assert.equal(args[args.indexOf('--source-version') + 1], context.GITHUB_SHA);
        assert.equal(args.at(-1), `spdx-json=/out/gromesh-${name}-${arch}.spdx.json`);
        assert.ok(args.includes('/var/run/docker.sock:/var/run/docker.sock:ro'));
        const out = args.find(arg => arg.endsWith(':/out')).slice(0, -5);
        const rebound = JSON.parse(JSON.stringify(doc).replaceAll(doc.name, sourceName));
        const container = rebound.packages.find(pkg => pkg.primaryPackagePurpose === 'CONTAINER');
        container.externalRefs[0].referenceLocator = container.externalRefs[0].referenceLocator.replace(/&tag=[0-9a-f]+$/, `&tag=${id.slice(7)}`);
        if (corruption === 'wrong image') container.checksums.find(c => c.algorithm === 'SHA256').checksumValue = 'd'.repeat(64);
        writeFileSync(join(out, `gromesh-${name}-${arch}.spdx.json`), corruption === 'partial' ? '{"spdxVersion":' : JSON.stringify(rebound));
        if (corruption === 'extra file') writeFileSync(join(out, 'extra.txt'), 'unexpected');
        return { status: corruption === 'syft failure' ? 1 : 0 };
      };
      const env = { GITHUB_SHA: context.GITHUB_SHA, TARGET_ARCH: arch, RUNNER_ARCH: context.RUNNER_ARCH, RUNNER_TEMP: temporary };
      const action = () => validatePrImageSbom(image, name, { env, execute });
      if (corruption === 'none') assert.doesNotThrow(action);
      else assert.throws(action);
      assert.equal(generated, !['wrong arch', 'inspect failure'].includes(corruption));
      assert.deepEqual(readdirSync(temporary), [], 'private SBOM workspace is always removed');
    });
  }
}
test('image-scan runs for dependency and validator changes and validates before completing each build', () => {
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const filter = ci.slice(ci.indexOf('            images:'), ci.indexOf('            heavy:'));
  for (const path of ['apps/**', 'packages/compiler/**', 'contracts/**', 'pnpm-lock.yaml', 'package.json',
    'pnpm-workspace.yaml', 'tsconfig.base.json', '.dockerignore', 'scripts/ci-pr-sbom.mjs', 'scripts/ci-supply-chain.mjs', '.github/workflows/images.yml']) {
    assert.ok(filter.split('\n').some(line => line.trim() === `- ${path}`), path);
  }
  const job = ci.slice(ci.indexOf('  image-scan:'), ci.indexOf('  migration-regression:'));
  assert.match(job, /TARGET_ARCH: \$\{\{ matrix.arch \}\}/);
  assert.doesNotMatch(job, /upload-artifact|packages: write|docker push/);
  const scan = readFileSync(new URL('./scan-changed-images.mjs', import.meta.url), 'utf8');
  assert.match(scan, /applicationBuilds\(changed\)/);
  assert.match(scan, /validatePrImageSbom\(tag, b.name\)/);
  assert.match(scan, /failures\.push\(`\$\{tag\} \(SBOM rejected\)`\)/);
});
