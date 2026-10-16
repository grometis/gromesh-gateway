// Shared compose acceptance client; invoked by tests/load/run.sh.
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function login() {
  const base = process.env.CP_URL ?? 'http://127.0.0.1:3000/api/v1';
  const response = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: process.env.BOOTSTRAP_ADMIN_EMAIL ?? 'admin@gromesh.dev', password: process.env.BOOTSTRAP_ADMIN_PASSWORD ?? 'gromesh-dev-admin' }),
    signal: AbortSignal.timeout(10000),
  });
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (response.status !== 200 || !cookie) throw new Error(`Login failed: HTTP ${response.status}`);
  return async function api(method, path, expected, body) {
    const headers = { cookie };
    if (method !== 'GET') {
      const csrf = await fetch(`${base}/auth/csrf`, { headers: { cookie }, signal: AbortSignal.timeout(10000) });
      if (!csrf.ok) throw new Error(`CSRF failed: HTTP ${csrf.status}`);
      headers['x-csrf-token'] = (await csrf.json()).csrfToken;
    }
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    // Do not print response bodies: registration and credentials are one-time-visible secrets.
    if (res.status !== expected) { await res.body?.cancel(); throw new Error(`${method} ${path}: HTTP ${res.status}, expected ${expected}`); }
    return res.status === 204 ? undefined : res.json();
  };
}
export async function converge(api, clusterId, version, nodes = 1, timeout = 30000) {
  const start = performance.now();
  do {
    const cluster = await api('GET', `/clusters/${clusterId}`, 200);
    if (cluster.status === 'converged' && cluster.nodes.length === nodes && cluster.nodes.every((node) => node.appliedVersion === version && node.state === 'applied' && node.kongHealthy)) return performance.now() - start;
    await sleep(100);
  } while (performance.now() - start < timeout);
  throw new Error(`Cluster did not converge to version ${version} within ${timeout} ms`);
}
