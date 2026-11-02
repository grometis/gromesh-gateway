import { openSync, closeSync, writeSync, ftruncateSync } from 'node:fs';

// Sparse, standard ustar archives exercise the real reader without Docker or large layer allocations.
export function writeTar(path, entries) {
  const fd = openSync(path, 'w');
  let offset = 0;
  try {
    for (const { name, bytes = '', size = Buffer.byteLength(bytes), type = '0' } of entries) {
      const header = Buffer.alloc(512);
      header.write(name, 0, 100);
      for (const [at, length, value] of [[100, 8, 420], [108, 8, 0], [116, 8, 0], [124, 12, size], [136, 12, 0]]) {
        header.write(value.toString(8).padStart(length - 1, '0') + '\0', at, length);
      }
      header.fill(32, 148, 156);
      header.write(type, 156, 1);
      header.write('ustar\0', 257, 6);
      const checksum = header.reduce((sum, byte) => sum + byte, 0);
      header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
      writeSync(fd, header, 0, 512, offset);
      if (Buffer.byteLength(bytes)) writeSync(fd, Buffer.from(bytes), 0, Buffer.byteLength(bytes), offset + 512);
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    ftruncateSync(fd, offset + 1024);
  } finally { closeSync(fd); }
}

export const archiveConfig = arch => JSON.stringify({ architecture: arch, os: 'linux', rootfs: {
  type: 'layers', diff_ids: ['sha256:' + '1'.repeat(64), 'sha256:' + '2'.repeat(64)],
} });
export function writeDockerSave(path, { config = archiveConfig('arm64'), blobPaths = false, manifests, missingConfig = false,
  missingLayer = false, layerSize = 1024, configType = '0' } = {}) {
  const configName = blobPaths ? 'blobs/sha256/config' : 'config.json';
  const layers = blobPaths ? ['blobs/sha256/first', 'blobs/sha256/second'] : ['first/layer.tar', 'second/layer.tar'];
  writeTar(path, [
    { name: 'manifest.json', bytes: JSON.stringify(manifests ?? [{ Config: configName, RepoTags: null, Layers: layers }]) },
    ...(!missingConfig ? [{ name: configName, bytes: config, type: configType }] : []),
    { name: layers[0], size: layerSize },
    ...(!missingLayer ? [{ name: layers[1], size: 2048 }] : []),
  ]);
}
