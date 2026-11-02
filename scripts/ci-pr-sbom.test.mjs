import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { archiveConfig, writeDockerSave } from './fixtures/docker-save.mjs';
import { sha256 } from './ci-image-identity.mjs';
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

// Captured inventories stay untouched on disk; the transport models a fresh archive scan with the same inventory.
const archiveDigest = {
  amd64: 'sha256:a73a979342142b643d33acfa68c16faf0063d2dc64e4c7429c0b75881470dbd9',
  arm64: 'sha256:87233fbd3ee5d6dc9764176a4e35c4b1826375ed0e07d3b0a6efdb0aa22c6a44',
};
for (const [revision, name, arch] of [
  ...['agent', 'control-plane', 'ui'].flatMap(name => ['amd64', 'arm64'].map(arch => ['b43bee3', name, arch])),
  ['431e1fe', 'ui', 'arm64'], ['pr-agent', 'agent', 'arm64'],
]) {
  for (const corruption of ['none', 'partial', 'extra file', 'wrong image', 'wrong arch', 'syft failure', 'inspect failure']) {
    test(`PR SBOM ${revision} ${name} ${arch}: ${corruption}`, t => {
      const temporary = mkdtempSync(join(realpathSync(tmpdir()), 'pr-sbom-'));
      t.after(() => rmSync(temporary, { recursive: true, force: true }));
      const directory = new URL(`./fixtures/sbom/${revision}/`, import.meta.url);
      const context = revision === 'pr-agent' ? { GITHUB_SHA: '820bb3a2c5c7563c4ed16824db94fd5c2b979457', RUNNER_ARCH: 'ARM64' } : Object.fromEntries(readFileSync(new URL(`gromesh-${name}-${arch}.context.env`, directory), 'utf8')
        .trim().split(/\s+/).map(pair => { const i = pair.indexOf('='); return [pair.slice(0, i), pair.slice(i + 1)]; }));
      const doc = JSON.parse(readFileSync(new URL(`gromesh-${name}-${arch}.spdx.json`, directory)));
      const config = archiveConfig(arch);
      const id = sha256(config);
      const image = `gromesh-scan/${name}:pr`;
      let generated = false;
      let archive;
      let saves = 0;
      const execute = (command, args) => {
        assert.equal(command, 'docker');
        if (args[0] === 'image') {
          assert.deepEqual(args.slice(0, 3), ['image', 'inspect', image]);
          return { status: corruption === 'inspect failure' ? 1 : 0,
            stdout: JSON.stringify({ Id: id, Os: 'linux', Architecture: corruption === 'wrong arch' ? 's390x' : arch }) };
        }
        if (args[0] === 'save') {
          assert.equal(saves++, 0, 'one export per scan');
          archive = args[3];
          assert.deepEqual(args, ['save', id, '-o', archive]);
          writeDockerSave(archive, { config });
          return { status: 0 };
        }
        generated = true;
        assert.equal(args[0], 'run');
        const syft = args.find(arg => arg.startsWith('anchore/syft:'));
        const workflow = readFileSync(new URL('../.github/workflows/images.yml', import.meta.url), 'utf8');
        assert.ok(workflow.includes(syft));
        assert.match(syft, /^anchore\/syft:v1\.18\.1@sha256:[0-9a-f]{64}$/);
        assert.equal(args[args.indexOf(syft) + 1], 'docker-archive:/image/image.tar');
        const sourceName = args[args.indexOf('--source-name') + 1];
        assert.equal(sourceName, `gromesh-${name}-${arch}-${context.GITHUB_SHA}-${id.slice(7)}`);
        assert.equal(args[args.indexOf('--source-version') + 1], context.GITHUB_SHA);
        assert.equal(args.at(-1), `spdx-json=/out/gromesh-${name}-${arch}.spdx.json`);
        assert.ok(args.includes(`${archive}:/image/image.tar:ro`));
        assert.equal(args.some(arg => arg.includes('docker.sock')), false);
        const out = args.find(arg => arg.endsWith(':/out')).slice(0, -5);
        const rebound = JSON.parse(JSON.stringify(doc).replaceAll(doc.name, sourceName));
        const container = rebound.packages.find(pkg => pkg.primaryPackagePurpose === 'CONTAINER');
        container.checksums.find(c => c.algorithm === 'SHA256').checksumValue = archiveDigest[arch].slice(7);
        container.externalRefs[0].referenceLocator = `pkg:oci/${sourceName}@${archiveDigest[arch]}?arch=`;
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
  assert.match(scan, /rejectionLine\(error, \{ artifact: "sbom", image: b.name, mode: "pr" \}\)/);
  assert.match(scan, /if \(sbomRejected\) process.exitCode = 1/);
  assert.doesNotMatch(scan, /SBOM rejected|CI supply chain rejected/);
});

test('images workflow scans the identity archive and retains the published digest in source-name', t => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'images-workflow-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const archive = join(root, 'private image.tar');
  writeFileSync(archive, 'private');
  const workflow = readFileSync(new URL('../.github/workflows/images.yml', import.meta.url), 'utf8');
  const step = workflow.slice(workflow.indexOf('      - name: Generate SPDX JSON SBOM'), workflow.indexOf('      - name: Validate all supply chain artifacts'));
  const shell = step.slice(step.indexOf('        run: |') + '        run: |'.length).trim().split('\n').map(line => line.replace(/^          /, '')).join('\n');
  // A shell function captures the command boundary; it never invokes a Docker executable.
  const result = spawnSync('bash', ['-e', '-c', 'docker() { printf "%s\\0" "$@" > "$CAPTURE"; }\n' + shell], {
    cwd: root, encoding: 'utf8', env: { ...process.env, IMAGE_ARCHIVE: archive, IMAGE_NAME: 'agent', TARGET_ARCH: 'arm64',
      GITHUB_SHA: 'a'.repeat(40), PUBLISHED_DIGEST: `sha256:${'b'.repeat(64)}`, CAPTURE: join(root, 'args') },
  });
  assert.equal(result.status, 0, result.stderr);
  const args = readFileSync(join(root, 'args'), 'utf8').split('\0').slice(0, -1);
  assert.ok(args.includes(`${archive}:/image/image.tar:ro`));
  assert.ok(args.includes('docker-archive:/image/image.tar'));
  assert.equal(args.some(arg => arg.includes('docker.sock') || arg.startsWith('docker:')), false);
  assert.equal(args[args.indexOf('--source-name') + 1], `gromesh-agent-arm64-${'a'.repeat(40)}-${'b'.repeat(64)}`);
  assert.equal(args[args.indexOf('--source-version') + 1], 'a'.repeat(40));
  const cleanup = workflow.slice(workflow.indexOf('      - name: Remove private image archive'), workflow.indexOf('      - name: Attach SBOM'));
  assert.match(cleanup, /if: always\(\)/);
  const remove = cleanup.split('        run: ')[1].trim();
  assert.equal(spawnSync('bash', ['-e', '-c', remove], { env: { ...process.env, IMAGE_ARCHIVE: archive } }).status, 0);
  assert.throws(() => readFileSync(archive));
});
