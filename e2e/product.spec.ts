import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test, type APIRequestContext } from "@playwright/test";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const COMPOSE = fileURLToPath(new URL("../deploy/compose/docker-compose.yml", import.meta.url));
const CP = process.env.CP_URL ?? "http://127.0.0.1:3000/api/v1";
const PROXY = process.env.KONG_PROXY_URL ?? "http://127.0.0.1:8000";
const exec = promisify(execFile);

interface Entity { id: string }
interface Cluster extends Entity {
  registrationToken: string;
  status: string;
  nodes: { appliedVersion: number | null }[];
}
interface Publication { version: number; rollbackOf: number | null }

async function api<T>(request: APIRequestContext, method: string, path: string, status: number, data?: unknown): Promise<T> {
  const response = await request.fetch(CP + path, { method, data, timeout: 5000 });
  // Do not include response bodies: creation responses can contain credentials.
  expect(response.status(), `${method} ${path}`).toBe(status);
  return (status === 204 ? undefined : await response.json()) as T;
}

async function compose(args: string[], registrationToken?: string) {
  await exec("docker", ["compose", ...(process.env.COMPOSE_FILE ? [] : ["-f", COMPOSE]), ...args], {
    cwd: ROOT,
    timeout: 60_000,
    // Registration tokens go only to this child, never argv or the parent environment.
    env: { ...process.env, ...(registrationToken ? { GROMESH_REGISTRATION_TOKEN: registrationToken } : {}) },
  });
}

async function converge(request: APIRequestContext, clusterId: string, version: number) {
  await expect.poll(async () => {
    const cluster = await api<Cluster>(request, "GET", `/clusters/${clusterId}`, 200);
    return cluster.status === "converged" && cluster.nodes.length > 0 && cluster.nodes.every((node) => node.appliedVersion === version);
  }, { timeout: 10_000, intervals: [100, 200, 500], message: `Cluster must converge to version ${version}` }).toBe(true);
}

test("UI publication, key-auth traffic and rollback on the real compose stack", async ({ page, request }) => {
  const name = `e2e-${randomUUID()}`;
  const path = `/${name}`;
  const env = await api<Entity>(request, "POST", "/environments", 201, { name, publishMode: "manual" });
  let clusterId: string | undefined;
  let agentStarted = false;
  try {
    const cluster = await api<Cluster>(request, "POST", `/environments/${env.id}/clusters`, 201, { name: "product-edge" });
    clusterId = cluster.id;
    expect(Boolean(cluster.registrationToken)).toBe(true);
    // The first version must be empty so rollback removes the route created through the UI.
    const baseline = await api<Publication>(request, "POST", `/environments/${env.id}/snapshots`, 201, { message: "Empty baseline" });
    agentStarted = true;
    await compose(["up", "-d", "--no-deps", "--force-recreate", "agent"], cluster.registrationToken);
    await converge(request, cluster.id, baseline.version);
    expect((await request.get(PROXY + path)).status()).toBe(404);

    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel("E-mail").fill("product-e2e@gromesh.dev");
    await page.getByLabel("Senha").fill("dev-only-e2e");
    await page.getByRole("button", { name: "Entrar" }).click();
    await page.getByLabel("Environment", { exact: true }).selectOption(env.id);
    await expect(page.getByRole("heading", { name: "Services", exact: true })).toBeVisible();
    // Also exercise /me and SPA fallback against the production static server.
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

    await page.getByRole("button", { name: "Publicar", exact: true }).click();
    const publish = page.getByRole("dialog", { name: /^Publicar/ });
    await expect(publish.locator('[data-change="added"]')).toHaveCount(2);
    const published = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith(`/environments/${env.id}/snapshots`));
    await publish.getByRole("button", { name: "Publicar", exact: true }).click();
    const publicationResponse = await published;
    expect(publicationResponse.status()).toBe(201);
    const uiVersion = await publicationResponse.json() as Publication;
    await expect(publish).toBeHidden();
    await converge(request, cluster.id, uiVersion.version);
    expect((await request.get(PROXY + path)).status()).toBe(200);

    await api(request, "POST", `/environments/${env.id}/plugins`, 201, {
      name: "key-auth", scope: { routeId: createdRoute.id }, config: { key_names: ["apikey"] },
    });
    const consumer = await api<Entity>(request, "POST", `/environments/${env.id}/consumers`, 201, { username: name });
    const credential = await api<{ key: string }>(request, "POST", `/environments/${env.id}/consumers/${consumer.id}/key-auth`, 201, {});
    expect(Boolean(credential.key)).toBe(true);
    const secured = await api<Publication>(request, "POST", `/environments/${env.id}/snapshots`, 201, { expectedCurrentVersion: uiVersion.version });
    await converge(request, cluster.id, secured.version);
    expect((await request.get(PROXY + path)).status()).toBe(401);
    const authorized = await request.get(PROXY + path, { headers: { apikey: credential.key } });
    expect(authorized.status()).toBe(200);
    expect(await authorized.text()).toContain("Hostname");

    const rollback = await api<Publication>(request, "POST", `/environments/${env.id}/snapshots/${baseline.version}/rollback`, 201);
    expect(rollback.rollbackOf).toBe(baseline.version);
    expect(rollback.version).toBeGreaterThan(secured.version);
    await converge(request, cluster.id, rollback.version);
    expect((await request.get(PROXY + path)).status()).toBe(404);
    expect((await request.get(PROXY + path, { headers: { apikey: credential.key } })).status()).toBe(404);
  } finally {
    try {
      if (agentStarted) await compose(["stop", "agent"]);
    } finally {
      try {
        if (clusterId) await api(request, "DELETE", `/clusters/${clusterId}`, 204);
      } finally {
        await api(request, "DELETE", `/environments/${env.id}`, 204);
      }
    }
  }
});
