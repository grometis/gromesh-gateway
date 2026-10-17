import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test, type APIRequestContext, type Browser } from "@playwright/test";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const COMPOSE = fileURLToPath(new URL("../deploy/compose/docker-compose.yml", import.meta.url));
const CP = process.env.CP_URL ?? "http://127.0.0.1:3000/api/v1";
const PROXY = process.env.KONG_PROXY_URL ?? "http://127.0.0.1:8000";
// The stack's bootstrap admin (deploy/compose/docker-compose.yml) unless overridden.
const ADMIN = { email: process.env.BOOTSTRAP_ADMIN_EMAIL ?? "admin@gromesh.dev", password: process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "gromesh-dev-admin" };
const exec = promisify(execFile);

interface Entity { id: string }
interface Cluster extends Entity {
  registrationToken: string;
  status: string;
  nodes: { appliedVersion: number | null }[];
}
interface Publication { version: number; rollbackOf: number | null }
interface AuditEvent { action: string; entityId: string | null; environmentId: string | null; actor: { id: string; name?: string } }

/** An API client logged in as `credentials`: the session cookie lives in the context, the CSRF token here. */
async function login(browser: Browser, credentials: { email: string; password: string }) {
  const context = await browser.newContext({ baseURL: CP });
  const request = context.request;
  const res = await request.post(`${CP}/auth/login`, { data: credentials });
  expect(res.status(), `login as ${credentials.email}`).toBe(200);
  const csrf = ((await (await request.get(`${CP}/auth/csrf`)).json()) as { csrfToken: string }).csrfToken;
  const api = async <T>(method: string, path: string, status: number, data?: unknown): Promise<T> => {
    const response = await request.fetch(CP + path, { method, data, timeout: 5000, headers: { "x-csrf-token": csrf } });
    // Do not include response bodies: creation responses can contain credentials.
    expect(response.status(), `${method} ${path}`).toBe(status);
    return (status === 204 ? undefined : await response.json()) as T;
  };
  return { api, request, close: () => context.close() };
}

async function compose(args: string[], registrationToken?: string, extraEnv: Record<string, string> = {}) {
  await exec("docker", ["compose", ...(process.env.COMPOSE_FILE ? [] : ["-f", COMPOSE]), ...args], {
    cwd: ROOT,
    timeout: 180_000,
    // Registration tokens go only to this child, never argv or the parent environment.
    env: { ...process.env, ...extraEnv, ...(registrationToken ? { GROMESH_REGISTRATION_TOKEN: registrationToken } : {}) },
  });
}

/**
 * The collector of one cluster: Vector recreated with that cluster's id (the compose default is a placeholder).
 * ClickHouse and its users come up first when the stack was started without the observability profile (CI).
 */
async function collector(clusterId?: string) {
  await compose(["--profile", "observability", "up", "-d", "--wait", "clickhouse"]);
  // One-shot: `up --wait` would treat its clean exit as a failure, `run` waits for it to finish.
  await compose(["--profile", "observability", "run", "--rm", "--no-deps", "clickhouse-init"]);
  await compose(["--profile", "observability", "up", "-d", "--wait", "--force-recreate", "--no-deps", "vector"], undefined, clusterId ? { GROMESH_CLUSTER_ID: clusterId } : {});
}

/** What the agent protocol serves to a node of `clusterId`: the snapshot must be the same for every cluster. */
async function agentSnapshot(request: APIRequestContext, registrationToken: string) {
  const base = CP.replace(/\/api\/v1$/, "") + "/agent/v1";
  const registered = await request.post(`${base}/register`, {
    headers: { authorization: `Bearer ${registrationToken}` },
    data: { nodeId: `e2e-${randomUUID()}`, hostname: "e2e", kongVersion: "3.9.3", agentVersion: "0.1.0" },
  });
  expect(registered.status(), "agent registration").toBe(200);
  const { nodeToken } = (await registered.json()) as { nodeToken: string };
  const current = await request.get(`${base}/snapshots/current`, { headers: { authorization: `Bearer ${nodeToken}` } });
  expect(current.status()).toBe(200);
  return (await current.json()) as { hash: string };
}

async function converge(api: <T>(method: string, path: string, status: number) => Promise<T>, clusterId: string, version: number) {
  await expect.poll(async () => {
    const cluster = await api<Cluster>("GET", `/clusters/${clusterId}`, 200);
    return cluster.status === "converged" && cluster.nodes.length > 0 && cluster.nodes.every((node) => node.appliedVersion === version);
  }, { timeout: 10_000, intervals: [100, 200, 500], message: `Cluster must converge to version ${version}` }).toBe(true);
}

/** Gateway traffic goes through a context without the admin cookie. */
const proxy = (request: APIRequestContext, path: string, headers?: Record<string, string>) => request.get(PROXY + path, { headers });

test("UI publication, key-auth traffic, viewer limits, audit and rollback on the real compose stack", async ({ page, browser, playwright }) => {
  const name = `e2e-${randomUUID()}`;
  const path = `/${name}`;
  const admin = await login(browser, ADMIN);
  const { api } = admin;
  const traffic = await playwright.request.newContext();
  const env = await api<Entity>("POST", "/environments", 201, { name, publishMode: "manual" });
  let clusterId: string | undefined;
  let viewerId: string | undefined;
  let agentStarted = false;
  let collectorStarted = false;
  try {
    const cluster = await api<Cluster>("POST", `/environments/${env.id}/clusters`, 201, { name: "product-edge" });
    clusterId = cluster.id;
    expect(Boolean(cluster.registrationToken)).toBe(true);
    // The first version must be empty so rollback removes the route created through the UI.
    const baseline = await api<Publication>("POST", `/environments/${env.id}/snapshots`, 201, { message: "Empty baseline" });
    // The collector comes up before the first request hits the gateway: a failed lookup of gromesh-collector would
    // otherwise be cached by the gateway (dns_not_found_ttl) and the log lines of the next seconds would be lost.
    collectorStarted = true;
    await collector(cluster.id);
    agentStarted = true;
    await compose(["up", "-d", "--no-deps", "--force-recreate", "agent"], cluster.registrationToken);
    await converge(api, cluster.id, baseline.version);
    expect((await proxy(traffic, path)).status()).toBe(404);

    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel("E-mail").fill(ADMIN.email);
    await page.getByLabel("Senha").fill(ADMIN.password);
    await page.getByRole("button", { name: "Entrar" }).click();
    await page.getByLabel("Environment", { exact: true }).selectOption(env.id);
    await expect(page.getByRole("heading", { name: "Services", exact: true })).toBeVisible();
    // Also exercise /me with the cookie and SPA fallback against the production static server.
    await page.reload();
    await expect(page.getByLabel("Environment", { exact: true })).toHaveValue(env.id);

    await page.getByRole("button", { name: "Novo service" }).click();
    const service = page.getByRole("dialog", { name: "Novo service" });
    await service.getByLabel("Nome").fill(name);
    await service.getByLabel("Host").fill("echo");
    await service.getByLabel("Porta").fill("80");
    const serviceCreated = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith(`/environments/${env.id}/services`));
    await service.getByRole("button", { name: "Salvar" }).click();
    expect((await serviceCreated).status()).toBe(201);
    await expect(service).toBeHidden();

    await page.getByRole("navigation", { name: "Menu principal" }).getByRole("link", { name: "Routes", exact: true }).click();
    await page.getByRole("button", { name: "Nova route" }).click();
    const route = page.getByRole("dialog", { name: "Nova route" });
    await route.getByLabel("Nome").fill(name);
    await route.getByLabel("Service", { exact: true }).selectOption({ label: name });
    await route.getByLabel("Paths").fill(path);
    const routeCreated = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith(`/environments/${env.id}/routes`));
    await route.getByRole("button", { name: "Salvar" }).click();
    const routeResponse = await routeCreated;
    expect(routeResponse.status()).toBe(201);
    const createdRoute = await routeResponse.json() as Entity;
    await expect(route).toBeHidden();

    await page.getByRole("region", { name: "Publicação" }).getByRole("button", { name: /^Publicar v\d+$/ }).click();
    const publish = page.getByRole("dialog", { name: /^Publicar/ });
    await expect(publish.locator('[data-change="added"]')).toHaveCount(2);
    const published = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith(`/environments/${env.id}/snapshots`));
    await publish.getByRole("button", { name: "Publicar", exact: true }).click();
    const publicationResponse = await published;
    expect(publicationResponse.status()).toBe(201);
    const uiVersion = await publicationResponse.json() as Publication;
    await expect(publish).toBeHidden();
    await converge(api, cluster.id, uiVersion.version);
    expect((await proxy(traffic, path)).status()).toBe(200);

    // Observability: the publication carries the platform plugins, the snapshot is the same for every cluster of
    // the environment, and traffic through the gateway shows up in the dashboard tagged with this cluster.
    // Two throwaway clusters (nodes registered here never report, so they must not join the real cluster).
    const second = await api<Cluster>("POST", `/environments/${env.id}/clusters`, 201, { name: "product-edge-2" });
    const third = await api<Cluster>("POST", `/environments/${env.id}/clusters`, 201, { name: "product-edge-3" });
    const [fromSecond, fromThird] = await Promise.all([agentSnapshot(admin.request, second.registrationToken), agentSnapshot(admin.request, third.registrationToken)]);
    expect(fromSecond.hash).toBe(fromThird.hash);
    const current = await api<{ hash: string }>("GET", `/environments/${env.id}/snapshots/${uiVersion.version}`, 200);
    expect(fromSecond.hash).toBe(current.hash);
    await api("DELETE", `/clusters/${second.id}`, 204);
    await api("DELETE", `/clusters/${third.id}`, 204);
    const trafficStarted = new Date(Date.now() - 60_000).toISOString();
    // Distinct sub-paths: requests made before the collector carried this cluster's id must not be counted.
    for (let i = 0; i < 3; i++) expect((await proxy(traffic, `${path}/traffic-${i}`)).status()).toBe(200);
    await expect.poll(async () => {
      const to = new Date(Date.now() + 60_000).toISOString();
      const page = await api<{ items: { path: string; status: number; environmentId: string; clusterId: string }[] }>("GET", `/environments/${env.id}/requests?from=${trafficStarted}&to=${to}&limit=50`, 200);
      const rows = page.items.filter((r) => r.path.startsWith(`${path}/traffic-`) && r.status === 200);
      return rows.length >= 3 && rows.every((r) => r.environmentId === env.id && r.clusterId === cluster.id);
    }, { timeout: 45_000, intervals: [500, 1000, 2000], message: "Gateway traffic must reach the analytics API with the environment and cluster ids" }).toBe(true);

    // The publication made through the UI is in the audit log, with its author.
    const me = await api<Entity & { name: string }>("GET", "/me", 200);
    const audit = await api<{ items: AuditEvent[] }>("GET", `/audit-events?environmentId=${env.id}&entityType=snapshot`, 200);
    expect(audit.items).toContainEqual(expect.objectContaining({
      action: "snapshot.publish", entityId: String(uiVersion.version), environmentId: env.id, actor: expect.objectContaining({ id: me.id, name: me.name }),
    }));

    // A viewer sees no edit buttons and gets 403 when it forces a mutation, even with a valid CSRF token.
    const viewerPassword = `viewer-${randomUUID()}`;
    const viewerUser = await api<Entity>("POST", "/users", 201, { email: `${name}@viewer.test`, name: "Viewer", role: "viewer", password: viewerPassword });
    viewerId = viewerUser.id;
    const viewer = await login(browser, { email: `${name}@viewer.test`, password: viewerPassword });
    try {
      await viewer.api("POST", `/environments/${env.id}/services`, 403, { name: `${name}-forced`, protocol: "http", host: "echo", port: 80 });
      const viewerPage = await (await browser.newContext()).newPage();
      await viewerPage.goto("/");
      await viewerPage.getByLabel("E-mail").fill(`${name}@viewer.test`);
      await viewerPage.getByLabel("Senha").fill(viewerPassword);
      await viewerPage.getByRole("button", { name: "Entrar" }).click();
      await viewerPage.getByLabel("Environment", { exact: true }).selectOption(env.id);
      await expect(viewerPage.getByRole("heading", { name: "Services", exact: true })).toBeVisible();
      await expect(viewerPage.getByRole("table", { name: "Services" }).getByText(name, { exact: true })).toBeVisible();
      await expect(viewerPage.getByRole("button", { name: /Novo service|Editar|Excluir|Publicar/ })).toHaveCount(0);
      await expect(viewerPage.getByRole("navigation", { name: "Menu principal" }).getByRole("link", { name: /Usuários|Auditoria/ })).toHaveCount(0);
      await viewerPage.context().close();
    } finally {
      await viewer.close();
    }

    await api("POST", `/environments/${env.id}/plugins`, 201, {
      name: "key-auth", scope: { routeId: createdRoute.id }, config: { key_names: ["apikey"] },
    });
    const consumer = await api<Entity>("POST", `/environments/${env.id}/consumers`, 201, { username: name });
    const credential = await api<{ key: string }>("POST", `/environments/${env.id}/consumers/${consumer.id}/key-auth`, 201, {});
    expect(Boolean(credential.key)).toBe(true);
    const secured = await api<Publication>("POST", `/environments/${env.id}/snapshots`, 201, { expectedCurrentVersion: uiVersion.version });
    await converge(api, cluster.id, secured.version);
    expect((await proxy(traffic, path)).status()).toBe(401);
    const authorized = await proxy(traffic, path, { apikey: credential.key });
    expect(authorized.status()).toBe(200);
    expect(await authorized.text()).toContain("Hostname");

    const rollback = await api<Publication>("POST", `/environments/${env.id}/snapshots/${baseline.version}/rollback`, 201);
    expect(rollback.rollbackOf).toBe(baseline.version);
    expect(rollback.version).toBeGreaterThan(secured.version);
    await converge(api, cluster.id, rollback.version);
    expect((await proxy(traffic, path)).status()).toBe(404);
    expect((await proxy(traffic, path, { apikey: credential.key })).status()).toBe(404);
  } finally {
    try {
      if (agentStarted) await compose(["stop", "agent"]);
      // Back to the placeholder cluster id, so the next run starts from a known collector.
      if (collectorStarted) await collector();
    } finally {
      try {
        if (clusterId) await api("DELETE", `/clusters/${clusterId}`, 204);
      } finally {
        try {
          if (viewerId) await api("DELETE", `/users/${viewerId}`, 204);
        } finally {
          await api("DELETE", `/environments/${env.id}`, 204);
          await api("POST", "/auth/logout", 204);
          await traffic.dispose();
          await admin.close();
        }
      }
    }
  }
});
