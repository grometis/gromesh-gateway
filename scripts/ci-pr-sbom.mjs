import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { directoryPath, requireValid, RejectionCode, checkedOperation, rejectionArtifact } from './ci-evidence.mjs';
import { localImageIdentity } from './ci-image-identity.mjs';
import { jobContext, validateSupplyChain } from './ci-supply-chain.mjs';

const SYFT = 'anchore/syft:v1.18.1@sha256:b8c170b8e51bfc4779ec3ef4399942c57290f5ce76a9c3af564c9d00d4946a6b';
const applications = ['agent', 'control-plane', 'ui'];
const sharedNodeInputs = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json', '.nvmrc'];
const gateInputs = ['.dockerignore', '.github/workflows/ci.yml', '.github/workflows/images.yml',
  'scripts/scan-changed-images.mjs', 'scripts/ci-pr-sbom.mjs', 'scripts/ci-supply-chain.mjs', 'scripts/ci-image-identity.mjs', 'scripts/ci-evidence.mjs'];

export function applicationBuilds(changed) {
  return applications.filter(name => changed.some(file => gateInputs.includes(file) || file.startsWith(`apps/${name}/`) ||
    (name === 'agent' && file.startsWith('apps/isolation/')) ||
    (name !== 'agent' && sharedNodeInputs.includes(file)) ||
    (name === 'control-plane' && (file.startsWith('contracts/') || file.startsWith('packages/compiler/')))));
}

export function validatePrImageSbom(image, name, { env = process.env, execute = spawnSync } = {}) {
  return rejectionArtifact('sbom', () => {
    // Each image gets a fresh exact-file gate. Never mix another build's files or publish PR artifacts.
    const workspace = mkdtempSync(join(directoryPath(env.RUNNER_TEMP), 'pr-sbom-'));
    try {
      const metadata = localImageIdentity(image, { env, execute, archive: join(workspace, 'image.tar') });
      const contextEnv = { ...env, IMAGE_NAME: name, LOCAL_IMAGE_ID: metadata.id,
        LOCAL_SBOM_DIGEST: metadata.sbomDigest, LOCAL_IDENTITY_KIND: metadata.kind };
      const context = jobContext(contextEnv, false, 'pr');
      requireValid(metadata.arch === context.arch, RejectionCode.PR_ARCH);
      const output = join(workspace, 'dist', 'sbom');
      mkdirSync(output, { recursive: true });
      const syft = checkedOperation(RejectionCode.SYFT_COMMAND, () => execute('docker', ['run', '--rm',
        '-v', `${metadata.archive}:/image/image.tar:ro`, '-v', `${output}:/out`,
        SYFT, 'docker-archive:/image/image.tar', '--source-name', context.sourceName, '--source-version', context.sha,
        '-o', `spdx-json=/out/gromesh-${name}-${context.arch}.spdx.json`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
      requireValid(syft.status === 0, RejectionCode.SYFT_COMMAND);
      validateSupplyChain({ command: 'pr', workspace, env: contextEnv });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
}
