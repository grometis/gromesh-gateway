import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { directoryPath, requireValid, RejectionCode, checkedOperation, rejectionLine } from './ci-evidence.mjs';

const digest = /^sha256:[0-9a-f]{64}$/;
export const sha256 = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
function checkedDigest(value) { requireValid(typeof value === 'string' && digest.test(value), RejectionCode.DIGEST_FORMAT); return value; }
export function manifestConfig(bytes, expected) {
  requireValid(sha256(bytes) === checkedDigest(expected), RejectionCode.MANIFEST_DIGEST);
  const manifest = checkedOperation(RejectionCode.JSON_SYNTAX, () => JSON.parse(bytes));
  requireValid(manifest?.schemaVersion === 2 && Array.isArray(manifest.layers), RejectionCode.MANIFEST_SHAPE);
  return checkedDigest(manifest.config?.digest);
}

// No registry lookup: Descriptor exists with the containerd store. Its platform manifest
// is read from docker save, hashed, and linked to the independently inspected config ID.
// The classic graphdriver has no local distribution manifest: Syft uses the config ID.
// Do not invent a manifest digest by hashing Docker's unrelated manifest.json export.
export function localImageIdentity(image, { env = process.env, execute = spawnSync } = {}) {
  const run = args => {
    const result = checkedOperation(RejectionCode.DOCKER_COMMAND, () => execute('docker', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
    requireValid(result.status === 0, RejectionCode.DOCKER_COMMAND);
    return result.stdout;
  };
  const metadata = checkedOperation(RejectionCode.JSON_SYNTAX, () => JSON.parse(run(['image', 'inspect', image, '--format', '{{json .}}'])));
  const id = checkedDigest(metadata?.Id);
  requireValid(metadata.Os === 'linux' && ['amd64', 'arm64'].includes(metadata.Architecture), RejectionCode.IMAGE_PLATFORM);
  if (metadata.Descriptor == null) {
    return { id, arch: metadata.Architecture, kind: 'classic-config', sbomDigest: id };
  }
  const work = checkedOperation(RejectionCode.FILE_ACCESS, () => mkdtempSync(join(directoryPath(env.RUNNER_TEMP), 'image-identity-')));
  try {
    const archive = join(work, 'image.tar');
    run(['image', 'save', '--output', archive, id]);
    const blob = descriptor => {
      const value = checkedDigest(descriptor?.digest);
      const result = checkedOperation(RejectionCode.IMAGE_BLOB, () => execute('tar', ['-xOf', archive, `blobs/sha256/${value.slice(7)}`],
        { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
      requireValid(result.status === 0 && sha256(result.stdout) === value, RejectionCode.IMAGE_BLOB);
      return result.stdout;
    };
    let descriptor = metadata.Descriptor;
    let bytes = blob(descriptor);
    let manifest = checkedOperation(RejectionCode.JSON_SYNTAX, () => JSON.parse(bytes));
    // A native single-platform build may still be wrapped in an OCI index.
    if (manifest?.manifests) {
      requireValid(Array.isArray(manifest.manifests), RejectionCode.MANIFEST_SHAPE);
      const matches = manifest.manifests.filter(item => item?.platform?.os === 'linux' && item.platform?.architecture === metadata.Architecture);
      requireValid(matches.length === 1, RejectionCode.IMAGE_PLATFORM_MATCH);
      descriptor = matches[0];
      bytes = blob(descriptor);
      manifest = checkedOperation(RejectionCode.JSON_SYNTAX, () => JSON.parse(bytes));
    }
    requireValid(manifestConfig(bytes, descriptor.digest) === id, RejectionCode.IMAGE_CONFIG);
    // Also verify the saved config's content rather than trusting a descriptor label.
    blob(manifest.config);
    return { id, arch: metadata.Architecture, kind: 'containerd-manifest', sbomDigest: descriptor.digest };
  } finally { checkedOperation(RejectionCode.FILE_ACCESS, () => rmSync(work, { recursive: true, force: true })); }
}

export function publishedImageIdentity(image, { env = process.env, execute = spawnSync } = {}) {
  const identity = localImageIdentity(image, { env, execute });
  requireValid(identity.arch === env.TARGET_ARCH, RejectionCode.PUBLISHED_ARCH);
  // Publication is checked by immutable digest, never by a mutable tag alone.
  checkedDigest(env.EXPECTED_DIGEST);
  const result = checkedOperation(RejectionCode.PUBLISHED_MANIFEST, () => execute('docker', ['buildx', 'imagetools', 'inspect', '--raw',
    `${image.replace(/:[^/:]+$/, '')}@${env.EXPECTED_DIGEST}`],
  { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  requireValid(result.status === 0 && manifestConfig(result.stdout, env.EXPECTED_DIGEST) === identity.id, RejectionCode.PUBLISHED_MANIFEST);
  return identity;
}

if (import.meta.main) {
  try {
    requireValid(process.argv.length === 3, RejectionCode.CLI_ARGUMENTS);
    const identity = publishedImageIdentity(process.argv[2]);
    checkedOperation(RejectionCode.FILE_ACCESS, () => appendFileSync(process.env.GITHUB_OUTPUT,
      `sbom-digest=${identity.sbomDigest}\nidentity-kind=${identity.kind}\npublished-config=${identity.id}\n`));
  } catch (error) { console.error(rejectionLine(error, { artifact: 'digest', mode: process.env.IMAGE_NAME === 'kong' ? 'kong-digest' : 'images' })); process.exitCode = 1; }
}
