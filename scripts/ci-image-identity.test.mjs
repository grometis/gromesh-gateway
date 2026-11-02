import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localImageIdentity, publishedImageIdentity, manifestConfig, sha256 } from './ci-image-identity.mjs';
import { archiveConfig, writeDockerSave, writeTar } from './fixtures/docker-save.mjs';

const config = archiveConfig('arm64');
const id = sha256(config);
// Field order and media types match stereoscope v0.0.11's Go json.Marshal golden file.
const reconstructed = `{"schemaVersion":2,"mediaType":"application/vnd.docker.distribution.manifest.v2+json","config":{"mediaType":"application/vnd.docker.container.image.v1+json","size":${Buffer.byteLength(config)},"digest":"${id}"},"layers":[{"mediaType":"application/vnd.docker.image.rootfs.diff.tar.gzip","size":1024,"digest":"sha256:${'1'.repeat(64)}"},{"mediaType":"application/vnd.docker.image.rootfs.diff.tar.gzip","size":2048,"digest":"sha256:${'2'.repeat(64)}"}]}`;
const manifest = JSON.stringify({ schemaVersion: 2, config: { digest: id }, layers: [] });
const manifestDigest = sha256(manifest);
function temporary(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'image-identity-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
for (const store of ['classic', 'containerd']) {
  for (const corrupt of ['none', 'inspect failure', 'bad ID', 'wrong OS', 'save failure', 'multiple images',
    'missing config', 'wrong config', 'missing layer', 'layer count', 'config symlink', 'wrong archive arch']) {
    test(`single docker-save identity ${store}: ${corrupt}`, t => {
      const root = temporary(t);
      const archive = join(root, 'image.tar');
      let saves = 0;
      const execute = (command, args) => {
        assert.equal(command, 'docker');
        if (args[1] === 'inspect') return { status: corrupt === 'inspect failure' ? 1 : 0,
          stdout: JSON.stringify({ Id: corrupt === 'bad ID' ? 'arbitrary' : id, Os: corrupt === 'wrong OS' ? 'windows' : 'linux', Architecture: 'arm64',
            ...(store === 'containerd' ? { Descriptor: { digest: 'intentionally-ignored' } } : {}) }) };
        assert.deepEqual(args, ['save', id, '-o', archive]);
        saves++;
        writeDockerSave(archive, { blobPaths: store === 'containerd', missingConfig: corrupt === 'missing config',
          missingLayer: corrupt === 'missing layer', configType: corrupt === 'config symlink' ? '2' : '0',
          config: corrupt === 'wrong config' ? config + ' ' : corrupt === 'wrong archive arch' ? archiveConfig('amd64') :
            corrupt === 'layer count' ? config.replace(/,"sha256:2+"/, '') : config,
          ...(corrupt === 'multiple images' ? { manifests: [{}, {}] } : {}) });
        return { status: corrupt === 'save failure' ? 1 : 0, stdout: '' };
      };
      const action = () => localImageIdentity('image:pr', { env: { RUNNER_TEMP: root }, archive, execute });
      if (corrupt === 'none') {
        assert.deepEqual(action(), { id, arch: 'arm64', kind: 'docker-archive', sbomDigest: sha256(reconstructed), archive });
        assert.equal(saves, 1);
        assert.notEqual(sha256(reconstructed), id, 'classic store does not imply config checksum');
      } else assert.throws(action);
    });
  }
}
test('archive reconstruction matches the upstream Go golden bytes including real layer sizes', t => {
  const root = temporary(t);
  const archive = join(root, 'image.tar');
  const upstream = JSON.parse(readFileSync(new URL('./fixtures/stereoscope-docker-manifest.fixture.json', import.meta.url)));
  const expected = JSON.parse(upstream.manifest);
  const configId = 'sha256:881a352c4517dbf5e561a08dd1c7cf65f6c4349d3ab9b13e95210800e12b14a8';
  const execute = (command, args) => {
    assert.equal(command, 'docker');
    if (args[1] === 'inspect') return { status: 0, stdout: JSON.stringify({ Id: configId, Os: 'linux', Architecture: 'amd64' }) };
    assert.deepEqual(args, ['save', configId, '-o', archive]);
    writeTar(archive, [
      { name: 'manifest.json', bytes: JSON.stringify([{ Config: 'config.json', Layers: expected.layers.map((_, i) => `layer-${i}.tar`) }]) },
      { name: 'config.json', bytes: upstream.config },
      ...expected.layers.map((layer, i) => ({ name: `layer-${i}.tar`, size: layer.size })),
    ]);
    return { status: 0 };
  };
  assert.equal(localImageIdentity('image', { env: { RUNNER_TEMP: root }, archive, execute }).sbomDigest, sha256(upstream.manifest));
});
test('published raw manifest must hash to the expected digest and identify the config', () => {
  assert.equal(manifestConfig(manifest, manifestDigest), id);
  for (const [bytes, digest] of [[manifest + '\n', manifestDigest], [manifest, id], ['{}', sha256('{}')],
    ['{', sha256('{')], ['null', sha256('null')]]) assert.throws(() => manifestConfig(bytes, digest));
});
for (const corrupt of ['none', 'registry failure', 'tag race', 'wrong config', 'wrong architecture']) {
  test(`publication adds immutable registry identity to the same archive: ${corrupt}`, t => {
    const root = temporary(t);
    const archive = join(root, 'image.tar');
    const published = corrupt === 'wrong config' ? manifest.replace(id, `sha256:${'e'.repeat(64)}`) : manifest;
    const expected = sha256(published);
    let saves = 0;
    const execute = (command, args) => {
      assert.equal(command, 'docker');
      if (args[1] === 'inspect') return { status: 0, stdout: JSON.stringify({ Id: id, Os: 'linux', Architecture: 'arm64' }) };
      if (args[0] === 'save') { saves++; writeDockerSave(archive); return { status: 0 }; }
      assert.deepEqual(args, ['buildx', 'imagetools', 'inspect', '--raw', `ghcr.io/example/app@${expected}`]);
      return { status: corrupt === 'registry failure' ? 1 : 0, stdout: corrupt === 'tag race' ? published + ' ' : published };
    };
    const action = () => publishedImageIdentity('ghcr.io/example/app:tag', { archive, execute,
      env: { RUNNER_TEMP: root, EXPECTED_DIGEST: expected, TARGET_ARCH: corrupt === 'wrong architecture' ? 'amd64' : 'arm64' } });
    if (corrupt === 'none') {
      const identity = action();
      assert.equal(identity.id, id);
      assert.equal(identity.sbomDigest, sha256(reconstructed));
      assert.equal(identity.archive, archive);
    } else assert.throws(action);
    assert.equal(saves, 1);
  });
}

test('docker-save PAX paths and timestamps preserve the reconstructed digest', t => {
  const root = temporary(t);
  const archive = join(root, 'image.tar');
  const paxRecord = (key, value) => {
    const body = ` ${key}=${value}\n`;
    let length = Buffer.byteLength(body) + 1;
    while (length !== Buffer.byteLength(body) + String(length).length) length = Buffer.byteLength(body) + String(length).length;
    return `${length}${body}`;
  };
  const configPath = 'blobs/sha256/config';
  const execute = (command, args) => {
    assert.equal(command, 'docker');
    if (args[1] === 'inspect') return { status: 0, stdout: JSON.stringify({ Id: id, Os: 'linux', Architecture: 'arm64' }) };
    writeTar(archive, [
      { name: 'manifest.json', bytes: JSON.stringify([{ Config: configPath, Layers: ['first', 'second'] }]) },
      { name: 'PaxHeaders/config', type: 'x', bytes: paxRecord('path', configPath) + paxRecord('mtime', '1700000000.123456789') },
      { name: 'ignored-name', bytes: config }, { name: 'first', size: 1024 }, { name: 'second', size: 2048 },
    ]);
    return { status: 0 };
  };
  assert.equal(localImageIdentity('image', { archive, execute }).sbomDigest, sha256(reconstructed));
});
for (const corrupt of ['layer size changed', 'truncated', 'header checksum', 'duplicate member']) {
  test(`archive identity uses actual member sizes and rejects ambiguous bytes: ${corrupt}`, t => {
    const root = temporary(t);
    const archive = join(root, 'image.tar');
    const execute = (command, args) => {
      assert.equal(command, 'docker');
      if (args[1] === 'inspect') return { status: 0, stdout: JSON.stringify({ Id: id, Os: 'linux', Architecture: 'arm64' }) };
      writeDockerSave(archive, { layerSize: corrupt === 'layer size changed' ? 1025 : 1024 });
      if (corrupt === 'truncated') truncateSync(archive, 700);
      if (corrupt === 'header checksum') {
        const bytes = readFileSync(archive); bytes[0] ^= 1; writeFileSync(archive, bytes);
      }
      if (corrupt === 'duplicate member') writeTar(archive, [{ name: 'manifest.json', bytes: '[]' }, { name: 'manifest.json', bytes: '[]' }]);
      return { status: 0 };
    };
    const action = () => localImageIdentity('image', { archive, execute });
    if (corrupt === 'layer size changed') {
      assert.equal(action().sbomDigest, sha256(reconstructed.replace('"size":1024', '"size":1025')));
      assert.notEqual(action().sbomDigest, sha256(reconstructed));
    } else assert.throws(action, error => error.code === 'IMAGE_BLOB');
  });
}

test('scratch config reconstructs the nil Go layer slice as JSON null', t => {
  const root = temporary(t);
  const archive = join(root, 'image.tar');
  const bytes = '{"architecture":"arm64","os":"linux","rootfs":{"type":"layers","diff_ids":[]}}';
  const configId = sha256(bytes);
  const execute = (command, args) => {
    assert.equal(command, 'docker');
    if (args[1] === 'inspect') return { status: 0, stdout: JSON.stringify({ Id: configId, Os: 'linux', Architecture: 'arm64' }) };
    writeTar(archive, [{ name: 'manifest.json', bytes: '[{"Config":"config.json","Layers":[]}]' }, { name: 'config.json', bytes }]);
    return { status: 0 };
  };
  const expected = `{"schemaVersion":2,"mediaType":"application/vnd.docker.distribution.manifest.v2+json","config":{"mediaType":"application/vnd.docker.container.image.v1+json","size":${bytes.length},"digest":"${configId}"},"layers":null}`;
  assert.equal(localImageIdentity('image', { archive, execute }).sbomDigest, sha256(expected));
});
