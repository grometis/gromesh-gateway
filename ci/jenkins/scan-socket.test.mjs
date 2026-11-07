import test from 'node:test';
import assert from 'node:assert/strict';
import { scannerDockerArguments } from '../../scripts/image-scan-arguments.mjs';
test('a changed-image scanner mounts only the selected dedicated rootless socket',()=>{
 const args=scannerDockerArguments('unix:///run/user/1000/docker.sock',1000);
 assert.ok(args.includes('/run/user/1000/docker.sock:/run/gromesh/docker.sock:ro'));
 assert.ok(args.includes('DOCKER_HOST=unix:///run/gromesh/docker.sock'));
 assert.doesNotMatch(JSON.stringify(args),/\/var\/run\/docker.sock/);
});
test('scanner refuses a foreign user socket, TCP engine and conventional socket when explicitly set',()=>{
 for(const s of ['unix:///run/user/1001/docker.sock','tcp://192.168.15.3:2375','unix:///var/run/docker.sock'])assert.throws(()=>scannerDockerArguments(s,1000));
});
