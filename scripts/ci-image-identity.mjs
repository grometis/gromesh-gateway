import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { directoryPath, requireValid } from './ci-evidence.mjs';

const digest = /^sha256:[0-9a-f]{64}$/;
export const sha256 = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
function checkedDigest(value) { requireValid(typeof value === 'string' && digest.test(value)); return value; }
export function manifestConfig(bytes, expected) {
  requireValid(sha256(bytes) === checkedDigest(expected));
  const manifest = JSON.parse(bytes);
  requireValid(manifest.schemaVersion === 2 && Array.isArray(manifest.layers));
  return checkedDigest(manifest.config?.digest);
}

// No registry lookup: Descriptor exists with the containerd store. Its platform manifest
// is read from docker save, hashed, and linked to the independently inspected config ID.
// The classic graphdriver has no local distribution manifest: Syft uses the config ID.
// Do not invent a manifest digest by hashing Docker's unrelated manifest.json export.
export function localImageIdentity(image, { env = process.env, execute = spawnSync } = {}) {
  const run = args => {
    const result = execute('docker', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    requireValid(result.status === 0);
    return result.stdout;
  };
  const metadata = JSON.parse(run(['image', 'inspect', image, '--format', '{{json .}}']));
  const id = checkedDigest(metadata.Id);
  requireValid(metadata.Os === 'linux' && ['amd64', 'arm64'].includes(metadata.Architecture));
  if (metadata.Descriptor == null) {
    return { id, arch: metadata.Architecture, kind: 'classic-config', sbomDigest: id };
  }
  const work = mkdtempSync(join(directoryPath(env.RUNNER_TEMP), 'image-identity-'));
  try {
    const archive = join(work, 'image.tar');
    run(['image', 'save', '--output', archive, id]);
    const blob = descriptor => {
      const value = checkedDigest(descriptor.digest);
      const result = execute('tar', ['-xOf', archive, `blobs/sha256/${value.slice(7)}`],
        { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      requireValid(result.status === 0 && sha256(result.stdout) === value);
      return result.stdout;
    };
    let descriptor = metadata.Descriptor;
    let bytes = blob(descriptor);
    let manifest = JSON.parse(bytes);
    // A native single-platform build may still be wrapped in an OCI index.
    if (manifest.manifests) {
      const matches = manifest.manifests.filter(item => item.platform?.os === 'linux' && item.platform?.architecture === metadata.Architecture);
      requireValid(matches.length === 1);
      descriptor = matches[0];
      bytes = blob(descriptor);
      manifest = JSON.parse(bytes);
    }
    requireValid(manifestConfig(bytes, descriptor.digest) === id);
    // Also verify the saved config's content rather than trusting a descriptor label.
    blob(manifest.config);
    return { id, arch: metadata.Architecture, kind: 'containerd-manifest', sbomDigest: descriptor.digest };
  } finally { rmSync(work, { recursive: true, force: true }); }
}

export function publishedImageIdentity(image, { env = process.env, execute = spawnSync } = {}) {
  const identity = localImageIdentity(image, { env, execute });
  requireValid(identity.arch === env.TARGET_ARCH);
  // Publication is checked by immutable digest, never by a mutable tag alone.
  checkedDigest(env.EXPECTED_DIGEST);
  const result = execute('docker', ['buildx', 'imagetools', 'inspect', '--raw',
    `${image.replace(/:[^/:]+$/, '')}@${env.EXPECTED_DIGEST}`],
  { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  requireValid(result.status === 0 && manifestConfig(result.stdout, env.EXPECTED_DIGEST) === identity.id);
  return identity;
}

if (import.meta.main) {
  try {
    requireValid(process.argv.length === 3);
    const identity = publishedImageIdentity(process.argv[2]);
    appendFileSync(process.env.GITHUB_OUTPUT,
      `sbom-digest=${identity.sbomDigest}\nidentity-kind=${identity.kind}\npublished-config=${identity.id}\n`);
  } catch { console.error('CI supply chain rejected.'); process.exitCode = 1; }
}
