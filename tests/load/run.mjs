// Run from repo root: tests/load/run.sh. Records baseline.json with acceptance status; any failed assertion exits nonzero.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, cpus, totalmem, platform, release, arch } from 'node:os';
import { resolve } from 'node:path';
import { login, converge, sleep } from './api.mjs';
import { assertLoadEvidence } from './evidence.mjs';
const exec = promisify(execFile);
const composeArgs = ['compose', '-f', resolve('deploy/compose/docker-compose.yml')];
const compose = (args, extra = {}) => exec('docker', [...composeArgs, ...args], { env: { ...process.env, POSTGRES_PORT: process.env.POSTGRES_PORT ?? '55433', ...extra }, timeout: 90000, maxBuffer: 1024 * 1024 });
const api = await login();
const running = (await compose(['ps', '--status', 'running', '-q', 'agent'])).stdout.trim();
if (running) throw new Error('Compose agent is running; use a dedicated stack or stop it before this test');
const kong = (await compose(['ps', '-q', 'kong'])).stdout.trim();
if (!kong) throw new Error('Compose Kong is not running');
const machine = {
  os: `${platform()} ${release()} ${arch()}`, cpu: cpus()[0].model, logicalCpus: cpus().length, memoryGiB: Math.round(totalmem() / 1024 ** 3),
  docker: JSON.parse((await exec('docker', ['info', '--format', '{{json .}}'])).stdout),
  kongImage: (await exec('docker', ['inspect', '--format', '{{.Config.Image}}', kong])).stdout.trim(),
};
// Store only non-sensitive machine capacity, never daemon environment/configuration.
machine.docker = { version: machine.docker.ServerVersion, os: machine.docker.OperatingSystem, architecture: machine.docker.Architecture, cpus: machine.docker.NCPU, memoryGiB: Math.round(machine.docker.MemTotal / 1024 ** 3) };
const work = await mkdtemp(resolve(tmpdir(), 'gromesh-load-'));
let env, cluster, service, route, consumer, child, agentStarted = false;
const plugins = [];
let result, failure;
const publications = [];
const containerName = `gromesh-w8-load-${process.pid}`;
let stopping = false;
const stop = () => { stopping = true; child?.kill('SIGTERM'); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
try {
  env = await api('POST', '/environments', 201, { name: `load-${Date.now()}`, publishMode: 'manual' });
  const path = `/environments/${env.id}`;
  cluster = await api('POST', `${path}/clusters`, 201, { name: 'load-compose' });
  const spec = { name: 'load-echo', protocol: 'http', host: 'echo', port: 80 };
  service = await api('POST', `${path}/services`, 201, spec);
  route = await api('POST', `${path}/routes`, 201, { name: 'load-echo', serviceId: service.id, paths: ['/w8-load'] });
  for (const plugin of [{ name: 'key-auth', config: { key_names: ['apikey'] } }, { name: 'rate-limiting', config: { minute: 6000000, policy: 'local' } }]) {
    plugins.push(await api('POST', `${path}/plugins`, 201, { ...plugin, scope: { routeId: route.id } }));
  }
  consumer = await api('POST', `${path}/consumers`, 201, { username: 'load-client' });
  const credential = await api('POST', `${path}/consumers/${consumer.id}/key-auth`, 201, {});
  const initial = await api('POST', `${path}/snapshots`, 201, { message: 'W8-X1 load setup' });
  agentStarted = true;
  await compose(['up', '-d', '--no-deps', '--force-recreate', 'agent'], { GROMESH_REGISTRATION_TOKEN: cluster.registrationToken });
  await converge(api, cluster.id, initial.version);
  const proxy = process.env.KONG_PROXY_URL ?? 'http://127.0.0.1:8000';
  const denied = await fetch(`${proxy}/w8-load`, { signal: AbortSignal.timeout(5000) });
  await denied.body?.cancel();
  if (denied.status !== 401) throw new Error(`Key-auth negative check: expected 401, got ${denied.status}`);
  child = spawn('docker', ['run', '--rm', '--name', containerName, '--network', `container:${kong}`, '--user', `${process.getuid()}:${process.getgid()}`, '-v', `${resolve('tests/load')}:/tests:ro`, '-v', `${work}:/out`, '-e', 'K6_API_KEY', '-e', 'K6_URL', '-e', 'GOMAXPROCS=2', '-e', 'K6_NO_USAGE_REPORT=true', 'grafana/k6:0.57.0', 'run', '/tests/kong.js'], {
    env: { ...process.env, K6_API_KEY: credential.key, K6_URL: process.env.K6_URL ?? 'http://127.0.0.1:8000/w8-load' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let exited = false;
  const done = new Promise((res) => { child.once('error', (error) => res({ error })); child.once('exit', (code, signal) => { exited = true; res({ code, signal }); }); });
  await new Promise((ready, reject) => {
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => {
      process.stdout.write(chunk);
      output = (output + chunk.toString()).slice(-4096);
      if (output.includes('W8_LOAD_READY')) ready();
    });
    child.once('error', reject);
    child.once('exit', () => reject(new Error('k6 exited before readiness')));
  });
  const start = performance.now();
  for (let i = 0; i < 5; i++) {
    await sleep(Math.max(0, 8000 + i * 10000 - (performance.now() - start)));
    if (stopping || exited) throw new Error('k6 stopped before five publications completed');
    await api('PUT', `${path}/services/${service.id}`, 200, { ...spec, tags: [`load-${i + 1}`] });
    const startedAtSeconds = (performance.now() - start) / 1000;
    const published = await api('POST', `${path}/snapshots`, 201, { expectedCurrentVersion: i + 1, message: `Load publication ${i + 1}/5` });
    await converge(api, cluster.id, published.version, 1, 10000);
    publications.push({ version: published.version, startedAtSeconds, convergedAtSeconds: (performance.now() - start) / 1000 });
    console.log(`Publication ${i + 1}/5 applied during load`);
  }
  const exit = await done;
  if (exit.error) throw exit.error;
  const summary = JSON.parse(await readFile(resolve(work, 'summary.json'), 'utf8'));
  result = { recordedAt: new Date().toISOString(), machine, tool: 'grafana/k6:0.57.0', scenario: { rate: 1000, durationSeconds: 60, plugins: ['key-auth', 'rate-limiting'], overhead: 'X-Kong-Proxy-Latency (ms), excludes upstream latency' }, publications, metrics: summary.metrics };
  if (exit.code !== 0) throw new Error(`k6 failed: code=${exit.code}, signal=${exit.signal}`);
  assertLoadEvidence(summary, publications);
} catch (error) {
  failure = error;
  if (!result) {
    try { result = { recordedAt: new Date().toISOString(), machine, tool: 'grafana/k6:0.57.0', publications, metrics: JSON.parse(await readFile(resolve(work, 'summary.json'), 'utf8')).metrics }; } catch { /* No summary if k6 never started. */ }
  }
} finally {
  child?.kill('SIGTERM');
  const errors = [];
  async function clean(action) { try { await action(); } catch (err) { errors.push(err); } }
  if (child) await clean(async () => {
    try { await exec('docker', ['rm', '-f', containerName]); } catch (error) {
      if ((await exec('docker', ['ps', '-aq', '--filter', `name=^${containerName}$`])).stdout.trim()) throw error;
    }
  });
  if (env) {
    const path = `/environments/${env.id}`;
    // Publish empty state before stopping the agent, so no load route/credential remains in Kong.
    for (const plugin of plugins) await clean(() => api('DELETE', `${path}/plugins/${plugin.id}`, 204));
    if (route) await clean(() => api('DELETE', `${path}/routes/${route.id}`, 204));
    if (service) await clean(() => api('DELETE', `${path}/services/${service.id}`, 204));
    if (consumer) await clean(() => api('DELETE', `${path}/consumers/${consumer.id}`, 204));
    if (agentStarted) await clean(async () => {
      const empty = await api('POST', `${path}/snapshots`, 201, { message: 'W8-X1 cleanup' });
      await converge(api, cluster.id, empty.version);
    });
    if (agentStarted) await clean(() => compose(['rm', '-s', '-f', 'agent']));
    if (cluster) await clean(() => api('DELETE', `/clusters/${cluster.id}`, 204));
    await clean(() => api('DELETE', path, 204));
  }
  await clean(() => api('POST', '/auth/logout', 204));
  await rm(work, { recursive: true, force: true });
  process.off('SIGINT', stop); process.off('SIGTERM', stop);
  if (errors.length) failure = new AggregateError([...(failure ? [failure] : []), ...errors], 'Load/cleanup failed');
}
if (result) await writeFile(new URL('./baseline.json', import.meta.url), JSON.stringify({ ...result, accepted: !failure, ...(failure ? { failure: failure.message } : {}) }, null, 2) + '\n');
if (failure) throw failure;
console.log(`PASS: p95 Kong proxy latency=${result.metrics.kong_proxy_latency_ms.values['p(95)']} ms, 5xx=${result.metrics.kong_5xx.values.count}, requests=${result.metrics.http_reqs.values.count}`);
