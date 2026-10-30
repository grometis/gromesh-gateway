import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";

// The MVP's definition of done, on a Helm install in kind (e2e/kind/run.sh prepares the cluster and the ids):
// admin login → service + route + key-auth + rate-limiting → publish → the cluster converges → traffic through the
// gateway shows up in the dashboard → rollback → the audit log shows everything, with its author.
const CP = process.env.CP_URL!;
const PROXY = process.env.KONG_PROXY_URL!;
const ADMIN = { email: process.env.E2E_ADMIN_EMAIL!, password: process.env.E2E_ADMIN_PASSWORD! };
const envId = process.env.E2E_ENV_ID!;
const clusterId = process.env.E2E_CLUSTER_ID!;
const exec = promisify(execFile);
const namespace = process.env.E2E_NAMESPACE!;
const selector = process.env.E2E_DATA_PLANE_SELECTOR!;

interface Entity { id: string }
interface Cluster { status: string; nodes: { nodeId: string; lastSeenAt: string; appliedVersion: number | null; online: boolean }[] }
interface Publication { version: number; rollbackOf: number | null }
interface Pod {
  metadata: { name: string; uid: string };
  spec: { nodeName: string };
  status: { containerStatuses: { name: string; containerID: string; restartCount: number; state: { running?: unknown } }[] };
}

async function dataPlanePod(): Promise<Pod> {
  const { stdout } = await exec("kubectl", ["-n", namespace, "get", "pods", "-l", selector, "-o", "json"], { timeout: 15_000 });
  const { items } = JSON.parse(stdout) as { items: Pod[] };
  expect(items).toHaveLength(1);
  return items[0]!;
}

async function restartAgent() {
  const before = await dataPlanePod();
  const agent = before.status.containerStatuses.find((c) => c.name === "agent")!;
  const kong = before.status.containerStatuses.find((c) => c.name === "kong")!;
  expect(agent.containerID).toMatch(/^containerd:\/\//);
  // The agent uses scratch (no shell/kill). Stop only its container through kind's CRI;
  // kubelet restarts it in the same pod, preserving emptyDir and the running gateway.
  await exec("docker", ["exec", before.spec.nodeName, "crictl", "stop", "--timeout", "1", agent.containerID.replace(/^containerd:\/\//, "")], { timeout: 30_000 });
  await expect.poll(async () => {
    const after = await dataPlanePod();
    expect(after.metadata.uid).toBe(before.metadata.uid);
    expect(after.status.containerStatuses.find((c) => c.name === "kong")!.containerID).toBe(kong.containerID);
    const restarted = after.status.containerStatuses.find((c) => c.name === "agent")!;
    return restarted.restartCount > agent.restartCount && restarted.containerID !== agent.containerID && Boolean(restarted.state.running);
  }, { timeout: 60_000, intervals: [500, 1000, 2000], message: "kubelet must restart only the agent container" }).toBe(true);
}

async function login(browser: Browser) {
  const context = await browser.newContext({ baseURL: CP });
  const res = await context.request.post(`${CP}/auth/login`, { data: ADMIN });
  expect(res.status(), "API login").toBe(200);
  const csrf = ((await (await context.request.get(`${CP}/auth/csrf`)).json()) as { csrfToken: string }).csrfToken;
  const api = async <T>(method: string, path: string, status: number, data?: unknown): Promise<T> => {
    const response = await context.request.fetch(CP + path, { method, data, timeout: 15_000, headers: { "x-csrf-token": csrf } });
    expect(response.status(), `${method} ${path}`).toBe(status);
    return (status === 204 ? undefined : await response.json()) as T;
  };
  return { api, close: () => context.close() };
}

async function converge(api: <T>(m: string, p: string, s: number) => Promise<T>, version: number) {
  await expect.poll(async () => {
    const cluster = await api<Cluster>("GET", `/clusters/${clusterId}`, 200);
    return cluster.status === "converged" && cluster.nodes.length === 1 && cluster.nodes.every((n) => n.online && n.appliedVersion === version);
  }, { timeout: 90_000, intervals: [500, 1000, 2000], message: `cluster must converge to v${version}` }).toBe(true);
}

const proxy = (request: APIRequestContext, path: string, headers?: Record<string, string>) => request.get(PROXY + path, { headers, timeout: 15_000 });

async function uiLogin(page: Page) {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("E-mail").fill(ADMIN.email);
  await page.getByLabel("Senha").fill(ADMIN.password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.getByLabel("Workspace", { exact: true }).selectOption(envId);
  await expect(page.getByRole("heading", { name: "Services", exact: true })).toBeVisible();
}

test("MVP: install → publish → converge → traffic in the dashboard → rollback → audit", async ({ page, browser, playwright }) => {
  // Full UUIDs remain intact; an 8-hex suffix can trigger whole-segment ID masking.
  const name = `mvp-${randomUUID()}`;
  const path = `/${name}`;
  const admin = await login(browser);
  const { api } = admin;
  const traffic = await playwright.request.newContext();
  try {
    // Service and route through the UI.
    await uiLogin(page);
    await page.getByRole("button", { name: "Novo service" }).click();
    const service = page.getByRole("dialog", { name: "Novo service" });
    await service.getByLabel("Nome").fill(name);
    await service.getByLabel("Host").fill("echo");
    await service.getByLabel("Porta").fill("80");
    await service.getByRole("button", { name: "Salvar" }).click();
    await expect(service).toBeHidden();
    await page.getByRole("navigation", { name: "Menu principal" }).getByRole("link", { name: "Routes", exact: true }).click();
    await page.getByRole("button", { name: "Nova route" }).click();
    const route = page.getByRole("dialog", { name: "Nova route" });
    await route.getByLabel("Nome").fill(name);
    await route.getByLabel("Service", { exact: true }).selectOption({ label: name });
    await route.getByLabel("Paths").fill(path);
    const routeCreated = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith(`/environments/${envId}/routes`));
    await route.getByRole("button", { name: "Salvar" }).click();
    const createdRoute = (await (await routeCreated).json()) as Entity;
    await expect(route).toBeHidden();

    // key-auth and rate-limiting on the route, a consumer with a key.
    await api("POST", `/environments/${envId}/plugins`, 201, { name: "key-auth", scope: { routeId: createdRoute.id }, config: { key_names: ["apikey"] } });
    await api("POST", `/environments/${envId}/plugins`, 201, { name: "rate-limiting", scope: { routeId: createdRoute.id }, config: { minute: 1000, policy: "local" } });
    const consumer = await api<Entity>("POST", `/environments/${envId}/consumers`, 201, { username: name });
    const credential = await api<{ key: string }>("POST", `/environments/${envId}/consumers/${consumer.id}/key-auth`, 201, {});

    // Publish through the UI (the data plane is NotReady until now) and wait for the cluster.
    await page.getByRole("region", { name: "Publicação" }).getByRole("button", { name: /^Publicar v\d+$/ }).click();
    const publish = page.getByRole("region", { name: "Revisar e publicar" });
    await expect(publish.locator('[data-change="added"]')).toHaveCount(8); // service, route, consumer, key, key-auth, rate-limiting and the 2 platform plugins
    const published = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith(`/environments/${envId}/snapshots`));
    await publish.getByRole("button", { name: /^Publicar v\d+$/ }).click();
    const v1 = (await (await published).json()) as Publication;
    await expect(publish).toBeHidden();
    await converge(api, v1.version);

    await test.step("agent container restart preserves nodeId without duplicating the cluster node", async () => {
      const before = await api<Cluster>("GET", `/clusters/${clusterId}`, 200);
      expect(before.nodes).toHaveLength(1);
      await restartAgent();
      await expect.poll(async () => {
        const after = await api<Cluster>("GET", `/clusters/${clusterId}`, 200);
        expect(after.nodes).toHaveLength(1);
        expect(after.nodes[0]!.nodeId).toBe(before.nodes[0]!.nodeId);
        return after.nodes[0]!.lastSeenAt > before.nodes[0]!.lastSeenAt;
      }, { timeout: 30_000, intervals: [500, 1000], message: "the same node must report after restart" }).toBe(true);
      await converge(api, v1.version);
    });

    // Traffic: rejected without the key, served with it, rate-limit headers present.
    expect((await proxy(traffic, path)).status()).toBe(401);
    for (let i = 0; i < 5; i++) {
      const ok = await proxy(traffic, `${path}?n=${i}`, { apikey: credential.key });
      expect(ok.status()).toBe(200);
      expect(ok.headers()["x-ratelimit-limit-minute"]).toBe("1000");
    }

    // The dashboard sees the traffic, tagged with this environment and cluster.
    const from = new Date(Date.now() - 10 * 60_000).toISOString();
    await expect.poll(async () => {
      const to = new Date(Date.now() + 60_000).toISOString();
      const page = await api<{ items: { path: string; status: number; environmentId: string; clusterId: string }[] }>("GET", `/environments/${envId}/requests?from=${from}&to=${to}&limit=50`, 200);
      const rows = page.items.filter((r) => r.path === path && r.status === 200);
      return rows.length >= 5 && rows.every((r) => r.environmentId === envId && r.clusterId === clusterId);
    }, { timeout: 30_000, intervals: [1000, 2000], message: "traffic must reach the analytics API" }).toBe(true);
    await page.getByRole("navigation", { name: "Menu principal" }).getByRole("link", { name: "Métricas" }).click();
    await page.getByLabel("Período", { exact: true }).selectOption("1h");
    await expect(page.locator("dl.stat-cards")).toContainText(/Requisições\s*[1-9]/);
    await page.getByRole("navigation", { name: "Menu principal" }).getByRole("link", { name: "Requisições" }).click();
    await page.getByRole("button", { name: "Filtrar" }).click();
    await expect(page.getByRole("cell", { name: path, exact: true }).first()).toBeVisible();

    // Rollback through the UI to the version before this publication: nothing is published yet, so publish an empty
    // baseline first? No: the first publication is v1, so a rollback target does not exist. Use a second publication.
    await api("PUT", `/environments/${envId}/services/${(await api<{ items: Entity[] }>("GET", `/environments/${envId}/services`, 200)).items[0]!.id}`, 200, { name, protocol: "http", host: "echo", port: 8080 });
    const v2 = await api<Publication>("POST", `/environments/${envId}/snapshots`, 201, { message: "move to 8080" });
    await converge(api, v2.version);
    await page.getByRole("navigation", { name: "Menu principal" }).getByRole("link", { name: "Publicações", exact: true }).click();
    await page.getByRole("button", { name: `Restaurar v${v1.version}` }).first().click();
    const restore = page.getByRole("dialog", { name: `Restaurar v${v1.version}` });
    await expect(restore.locator("[data-change]")).toHaveCount(1);
    const rolledBack = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith(`/snapshots/${v1.version}/rollback`));
    await restore.getByRole("button", { name: "Confirmar rollback" }).click();
    const v3 = (await (await rolledBack).json()) as Publication;
    expect(v3.rollbackOf).toBe(v1.version);
    await converge(api, v3.version);
    expect((await proxy(traffic, path, { apikey: credential.key })).status()).toBe(200);

    // The audit log, in the UI and the API, shows the publications with their author.
    await page.getByRole("navigation", { name: "Menu principal" }).getByRole("link", { name: "Auditoria" }).click();
    await page.getByLabel("ID do environment").fill(envId);
    await page.getByLabel("Tipo de entidade").fill("snapshot");
    await page.getByRole("button", { name: "Filtrar" }).click();
    await expect(page.getByRole("heading", { name: "snapshot.rollback" }).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "snapshot.publish" }).first()).toBeVisible();
    const me = await api<{ id: string; name: string }>("GET", "/me", 200);
    const audit = await api<{ items: { action: string; entityId: string | null; actor: { id: string } }[] }>("GET", `/audit-events?environmentId=${envId}&limit=200`, 200);
    const actions = audit.items.map((e) => e.action);
    for (const expected of ["service.create", "route.create", "plugin.create", "consumer.create", "keyauth.create", "snapshot.publish", "snapshot.rollback"]) {
      expect(actions, expected).toContain(expected);
    }
    expect(audit.items.filter((e) => e.action.startsWith("snapshot.")).every((e) => e.actor.id === me.id)).toBe(true);
    expect(JSON.stringify(audit)).not.toContain(credential.key);
  } finally {
    await traffic.dispose();
    await admin.close();
  }
});
