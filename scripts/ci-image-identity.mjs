import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, openSync, closeSync, readSync, fstatSync, mkdtempSync, rmSync } from 'node:fs';
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

function dockerArchiveIdentity(archive) {
  return checkedOperation(RejectionCode.IMAGE_BLOB, () => {
    const fd = openSync(archive, 'r');
    try {
      const length = fstatSync(fd).size;
      const read = (offset, size) => {
        requireValid(Number.isSafeInteger(size) && size >= 0 && size <= 16 * 1024 * 1024, RejectionCode.IMAGE_BLOB);
        const bytes = Buffer.alloc(size);
        requireValid(readSync(fd, bytes, 0, size, offset) === size, RejectionCode.IMAGE_BLOB);
        return bytes;
      };
      const string = bytes => bytes.toString('utf8').replace(/\0.*$/s, '');
      const number = bytes => {
        // Go's archive/tar also accepts base-256 sizes in addition to octal ustar fields.
        const value = bytes[0] & 128 ? bytes.reduce((n, byte, i) => n * 256n + BigInt(i === 0 ? byte & 127 : byte), 0n) :
          (/^[0-7]+$/.test(string(bytes).trim()) ? BigInt('0o' + string(bytes).trim()) : -1n);
        requireValid(value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER), RejectionCode.IMAGE_BLOB);
        return Number(value);
      };
      const entries = new Map();
      let offset = 0;
      let extended = {};
      while (offset + 512 <= length) {
        const header = read(offset, 512);
        if (header.every(byte => byte === 0)) break;
        const checksum = header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);
        requireValid(number(header.subarray(148, 156)) === checksum, RejectionCode.IMAGE_BLOB);
        const size = number(header.subarray(124, 136));
        const type = header[156];
        const prefix = string(header.subarray(345, 500));
        const name = (prefix ? prefix + '/' : '') + string(header.subarray(0, 100));
        const start = offset + 512;
        if (type === 120 || type === 103) {
          const bytes = read(start, size);
          for (let cursor = 0; cursor < size;) {
            const space = bytes.indexOf(32, cursor);
            const count = Number(bytes.subarray(cursor, space).toString());
            requireValid(space > cursor && Number.isSafeInteger(count) && count > space - cursor + 1 && cursor + count <= size && bytes[cursor + count - 1] === 10, RejectionCode.IMAGE_BLOB);
            const record = bytes.subarray(space + 1, cursor + count - 1).toString('utf8');
            const separator = record.indexOf('=');
            requireValid(separator > 0, RejectionCode.IMAGE_BLOB);
            const key = record.slice(0, separator);
            // Docker's PAX timestamps do not affect identity; path/size apply to the next member.
            requireValid(type !== 103 || !['path', 'size'].includes(key), RejectionCode.IMAGE_BLOB);
            if (['path', 'size'].includes(key)) extended[key] = record.slice(separator + 1);
            cursor += count;
          }
        } else if (type === 76) {
          extended.path = string(read(start, size));
        } else {
          const path = extended.path ?? name;
          const actualSize = extended.size === undefined ? size : Number(extended.size);
          requireValid(Number.isSafeInteger(actualSize) && actualSize >= 0 && start + actualSize <= length, RejectionCode.IMAGE_BLOB);
          if (type === 0 || type === 48) {
            requireValid(!entries.has(path) && entries.size < 100_000, RejectionCode.IMAGE_BLOB);
            entries.set(path, { offset: start, size: actualSize });
          }
          offset = start + Math.ceil(actualSize / 512) * 512;
          extended = {};
          continue;
        }
        offset = start + Math.ceil(size / 512) * 512;
      }
      const member = name => {
        requireValid(typeof name === 'string' && entries.has(name), RejectionCode.IMAGE_BLOB);
        return entries.get(name);
      };
      const contents = name => { const entry = member(name); return read(entry.offset, entry.size); };
      const parse = bytes => checkedOperation(RejectionCode.JSON_SYNTAX, () => JSON.parse(bytes));
      const manifest = parse(contents('manifest.json'));
      requireValid(Array.isArray(manifest) && manifest.length === 1 && Array.isArray(manifest[0]?.Layers), RejectionCode.MANIFEST_SHAPE);
      const configBytes = contents(manifest[0].Config);
      const config = parse(configBytes);
      requireValid(config?.os === 'linux' && ['amd64', 'arm64'].includes(config?.architecture), RejectionCode.IMAGE_PLATFORM);
      const diffIds = config.rootfs?.diff_ids;
      requireValid(Array.isArray(diffIds) && diffIds.length === manifest[0].Layers.length, RejectionCode.MANIFEST_SHAPE);
      const id = sha256(configBytes);
      // Syft 1.18.1/stereoscope v0.0.11 docker/manifest.go hashes this reconstructed manifest, independently of the daemon store.
      const reconstructed = { schemaVersion: 2, mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
        config: { mediaType: 'application/vnd.docker.container.image.v1+json', size: configBytes.length, digest: id },
        layers: diffIds.length ? diffIds.map((diffId, i) => ({ mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip',
          size: member(manifest[0].Layers[i]).size, digest: checkedDigest(diffId) })) : null };
      return { id, arch: config.architecture, kind: 'docker-archive', sbomDigest: sha256(JSON.stringify(reconstructed)), archive };
    } finally { closeSync(fd); }
  });
}

export function localImageIdentity(image, { env = process.env, archive, execute = spawnSync } = {}) {
  const run = args => {
    const result = checkedOperation(RejectionCode.DOCKER_COMMAND, () => execute('docker', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
    requireValid(result.status === 0, RejectionCode.DOCKER_COMMAND);
    return result.stdout;
  };
  const metadata = checkedOperation(RejectionCode.JSON_SYNTAX, () => JSON.parse(run(['image', 'inspect', image, '--format', '{{json .}}'])));
  const id = checkedDigest(metadata?.Id);
  requireValid(metadata.Os === 'linux' && ['amd64', 'arm64'].includes(metadata.Architecture), RejectionCode.IMAGE_PLATFORM);
  archive ??= join(directoryPath(env.RUNNER_TEMP), 'image.tar');
  run(['save', id, '-o', archive]);
  const identity = dockerArchiveIdentity(archive);
  requireValid(identity.id === id, RejectionCode.IMAGE_CONFIG);
  requireValid(identity.arch === metadata.Architecture, RejectionCode.IMAGE_PLATFORM_MATCH);
  return identity;
}

export function publishedImageIdentity(image, { env = process.env, archive, execute = spawnSync } = {}) {
  const identity = localImageIdentity(image, { env, archive, execute });
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
    const work = checkedOperation(RejectionCode.FILE_ACCESS, () => mkdtempSync(join(directoryPath(process.env.RUNNER_TEMP), 'image-identity-')));
    try {
      const identity = publishedImageIdentity(process.argv[2], { archive: join(work, 'image.tar') });
      checkedOperation(RejectionCode.FILE_ACCESS, () => appendFileSync(process.env.GITHUB_OUTPUT,
        `image-archive=${identity.archive}\nsbom-digest=${identity.sbomDigest}\nidentity-kind=${identity.kind}\npublished-config=${identity.id}\n`));
    } catch (error) { checkedOperation(RejectionCode.FILE_ACCESS, () => rmSync(work, { recursive: true, force: true })); throw error; }
  } catch (error) { console.error(rejectionLine(error, { artifact: 'digest', mode: process.env.IMAGE_NAME === 'kong' ? 'kong-digest' : 'images' })); process.exitCode = 1; }
}
