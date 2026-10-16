// From repo root: node tests/load/backup-runtime.mjs
// Exercises the rendered CronJob command as UID 70 with a read-only rootfs,
// then runs restore-drill against its archive. Requires Docker, Helm and Node 24.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, chmod, readdir, writeFile, utimes, access, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
const exec = promisify(execFile);
const work = await mkdtemp(resolve(tmpdir(), 'gromesh-backup-'));
try {
  await chmod(work, 0o777); // Kubernetes supplies volume access via fsGroup instead.
  const yaml = (await exec('helm', ['template', 'cp', 'deploy/helm/control-plane', '-f', 'deploy/helm/control-plane/ci/values-full.yaml', '--show-only', 'templates/backup-cronjob.yaml'])).stdout;
  const block = yaml.match(/args:\n\s+- \|\n([\s\S]*?)\n\s+resources:/)?.[1];
  assert.ok(block, 'Rendered backup command missing');
  const command = block.split('\n').map((line) => line.replace(/^ {18}/, '')).join('\n');
  const old = resolve(work, 'gromesh-old.dump');
  await writeFile(old, 'old'); await utimes(old, new Date(0), new Date(0));
  const run = (database) => exec('docker', ['run', '--rm', '--network', 'gromesh_default', '--user', '70:70', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--tmpfs', '/tmp:uid=70,gid=70,mode=700', '-v', `${work}:/backups`, '-e', 'DATABASE_URL', '-e', 'RETENTION_DAYS=7', 'postgres:16-alpine', '/bin/sh', '-ec', command], { env: { ...process.env, DATABASE_URL: database }, timeout: 60000 });
  // A failed backup must not prune the existing completed archive.
  await assert.rejects(run('postgresql://gromesh:gromesh@postgres:5432/missing_drill_source'));
  await access(old);
  assert.ok(!(await readdir(work)).some((name) => name.endsWith('.partial')), 'Failed dump left a partial file');
  const completed = await run('postgresql://gromesh:gromesh@postgres:5432/gromesh');
  console.log(completed.stdout.trim());
  assert.ok(!(await readdir(work)).includes('gromesh-old.dump'), 'Retention did not prune old dump');
  const files = (await readdir(work)).filter((name) => name.endsWith('.dump'));
  assert.equal(files.length, 1);
  // Restrict host directory again now the non-root backup process has exited.
  await chmod(work, 0o700);
  const drill = await exec('bash', ['scripts/restore-drill.sh', resolve(work, files[0])], { env: { ...process.env, POSTGRES_PORT: '55433' }, timeout: 60000 });
  console.log(drill.stdout.trim());
  const bad = resolve(work, 'corrupt.dump');
  await writeFile(bad, (await readFile(resolve(work, files[0]))).subarray(0, 40));
  await assert.rejects(exec('bash', ['scripts/restore-drill.sh', bad], { env: { ...process.env, POSTGRES_PORT: '55433' }, timeout: 60000 }));
  console.log('PASS: non-root backup, retention after success, restore of archive and rejection of corrupt dump');
} finally { await rm(work, { recursive: true, force: true }); }
