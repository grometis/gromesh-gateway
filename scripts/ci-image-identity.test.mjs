import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localImageIdentity, publishedImageIdentity, manifestConfig, sha256 } from './ci-image-identity.mjs';

const config = JSON.stringify({ architecture: 'arm64', os: 'linux', rootfs: { type: 'layers', diff_ids: [] } });
const id = sha256(config);
const manifest = JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json',
  config: { digest: id, size: config.length, mediaType: 'application/vnd.oci.image.config.v1+json' }, layers: [] });
const manifestDigest = sha256(manifest);
const platform = { os: 'linux', architecture: 'arm64' };
const index = JSON.stringify({ schemaVersion: 2, manifests: [{ digest: manifestDigest, platform }] });

for (const kind of ['classic', 'containerd', 'containerd-index']) {
  for (const corrupt of ['none', 'inspect failure', 'bad ID', 'wrong OS', ...(kind === 'classic' ? [] :
    ['save failure', 'missing manifest', 'altered manifest', 'wrong config reference', 'altered config', 'missing config', 'ambiguous platform'])]) {
    test(`independent local identity ${kind}: ${corrupt}`, t => {
      const temp = mkdtempSync(join(realpathSync(tmpdir()), 'image-identity-test-'));
      t.after(() => rmSync(temp, { recursive: true, force: true }));
      let manifestBytes = corrupt === 'wrong config reference' ? manifest.replace(id, `sha256:${'e'.repeat(64)}`) : manifest;
      const platformDigest = sha256(manifestBytes);
      const indexBytes = JSON.stringify({ schemaVersion: 2, manifests: [
        { digest: platformDigest, platform }, ...(corrupt === 'ambiguous platform' ? [{ digest: platformDigest, platform }] : []),
      ] });
      const descriptorDigest = kind === 'containerd-index' ? sha256(indexBytes) : platformDigest;
      const execute = (command, args) => {
        if (command === 'docker' && args[1] === 'inspect') return {
          status: corrupt === 'inspect failure' ? 1 : 0, stdout: JSON.stringify({ Id: corrupt === 'bad ID' ? 'arbitrary' : id,
            Os: corrupt === 'wrong OS' ? 'windows' : 'linux', Architecture: 'arm64',
            ...(kind === 'classic' ? {} : { Descriptor: { digest: descriptorDigest } }) }),
        };
        if (command === 'docker' && args[1] === 'save') return { status: corrupt === 'save failure' ? 1 : 0, stdout: '' };
        assert.equal(command, 'tar');
        const digest = `sha256:${args.at(-1).split('/').at(-1)}`;
        const bytes = digest === sha256(indexBytes) ? indexBytes : digest === platformDigest ? manifestBytes : config;
        const absent = digest === platformDigest && corrupt === 'missing manifest' || digest === id && corrupt === 'missing config';
        return { status: absent ? 1 : 0,
          stdout: (digest === platformDigest && corrupt === 'altered manifest' || digest === id && corrupt === 'altered config') ? bytes + ' ' : bytes };
      };
      const action = () => localImageIdentity('image:pr', { env: { RUNNER_TEMP: temp }, execute });
      // Ambiguity only applies to an index; a direct descriptor already selects one manifest.
      if (corrupt === 'none' || corrupt === 'ambiguous platform' && kind === 'containerd') {
        assert.deepEqual(action(), { id, arch: 'arm64', kind: kind === 'classic' ? 'classic-config' : 'containerd-manifest',
          sbomDigest: kind === 'classic' ? id : platformDigest });
      } else assert.throws(action);
      assert.deepEqual(readdirSync(temp), []);
    });
  }
}

test('published raw manifest must hash to the expected digest and identify the inspected config', () => {
  assert.equal(manifestConfig(manifest, manifestDigest), id);
  assert.throws(() => manifestConfig(manifest + '\n', manifestDigest));
  assert.throws(() => manifestConfig(manifest, id));
  assert.throws(() => manifestConfig(index, sha256(index)));
  for (const bytes of ['{}', '{', JSON.stringify({ schemaVersion: 2, layers: [], config: { digest: 'short' } })]) {
    assert.throws(() => manifestConfig(bytes, sha256(bytes)));
  }
});


for (const corrupt of ['none', 'registry failure', 'tag race', 'wrong config', 'wrong architecture']) {
  test(`publication independently links config to immutable manifest: ${corrupt}`, () => {
    const published = corrupt === 'wrong config' ? manifest.replace(id, `sha256:${'e'.repeat(64)}`) : manifest;
    const expected = sha256(published);
    const execute = (command, args) => {
      assert.equal(command, 'docker');
      if (args[1] === 'inspect') return { status: 0, stdout: JSON.stringify({ Id: id, Os: 'linux', Architecture: 'arm64' }) };
      assert.deepEqual(args, ['buildx', 'imagetools', 'inspect', '--raw', `ghcr.io/example/app@${expected}`]);
      return { status: corrupt === 'registry failure' ? 1 : 0, stdout: corrupt === 'tag race' ? published + ' ' : published };
    };
    const action = () => publishedImageIdentity('ghcr.io/example/app:tag', { execute,
      env: { EXPECTED_DIGEST: expected, TARGET_ARCH: corrupt === 'wrong architecture' ? 'amd64' : 'arm64' } });
    if (corrupt === 'none') assert.equal(action().id, id);
    else assert.throws(action);
  });
}
