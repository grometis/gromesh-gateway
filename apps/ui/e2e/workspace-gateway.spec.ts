import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, mockSession, test } from "./fixtures";
import { checkLayout } from "./layout";
import { invalidBody, v2BodyErrors } from "./v2-bodies";
import type { Me } from "../src/api/client";
import type { Workspace, WorkspaceRoute, WorkspaceService } from "../src/api/client-v2";

// WS-S1: Services and Routes of the selected workspace through API v2. A stateful fake of the v2 contract (the
// contract mock serves only v1) answers workspaces, services, routes and upstreams; the v1 environments mirror it.
const NOW = "2026-10-30T12:00:00Z";
let seq = 0;
const uuid = () => `5b2f9c40-1d2e-4f3a-8b4c-${String(++seq).padStart(12, "0")}`;
const admin: Me = { id: uuid(), name: "Ana Souza", email: "ana@gromesh.dev", role: "admin", active: true, environmentRoles: [], createdAt: NOW, updatedAt: NOW };
const problem = (status: number, extra: object = {}) => ({ status, contentType: "application/problem+json", json: { type: "about:blank", title: "Problem", status, ...extra } });

interface Upstream { id: string; name: string; workspaceId: string }
interface Fake {
  workspaces: Workspace[];
  services: WorkspaceService[];
  routes: WorkspaceRoute[];
  /** Which workspace holds each route: kept beside the fake's routes, since a WorkspaceRoute carries no workspaceId. */
  routeOwner: Map<string, string>;
  upstreams: Upstream[];
  dirty: Set<string>;
  /** Workspaces whose v1 environment publishes automatically. */
  autoPublish?: Set<string>;
  paused?: "import";
  hold?: { kind: "workspace" | "environment"; ready: Promise<void> };
  failed?: "workspace" | "environment";
  routeErrors?: { path: string; message: string }[];
  requests: { method: string; path: string; body: unknown }[];
}

async function fakeApi(page: Page, fake: Fake) {
  const env = (w: Workspace) => ({ id: w.id, name: w.name, publishMode: fake.autoPublish?.has(w.id) ? "auto" : "manual", ...(fake.paused ? { autoPublishPausedReason: fake.paused } : {}), currentVersion: null, hasUnpublishedChanges: fake.dirty.has(w.id), createdAt: NOW, updatedAt: NOW });
  const record = (method: string, path: string, body: unknown) => fake.requests.push({ method, path, body });
  // Everything the v1 screens around the gateway read for these workspaces; publishing or deploying is recorded.
  // Match APIs at the origin root, never Vite modules such as /src/api/client.ts.
  await page.route(/^https?:\/\/[^/]+\/api\/v1\/environments(?:\/|\?|$)/, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api\/v1/, "");
    record(request.method(), path, null);
    if (path === "/environments") return route.fulfill({ json: { items: fake.workspaces.map(env), nextCursor: null } });
    const [, wsId, rest] = /^\/environments\/([^/]+)(\/.*)?$/.exec(path) ?? [];
    const w = fake.workspaces.find((x) => x.id === wsId);
    if (!w) return route.fulfill(problem(404));
    if (!rest) {
      if (fake.hold?.kind === "environment") await fake.hold.ready;
      if (fake.failed === "environment") return route.fulfill(problem(503));
      return route.fulfill({ json: env(w) });
    }
    if (rest === "/plugins") return route.fulfill({ json: { items: [{ id: "route-plugin", name: "rate-limiting", enabled: true, scope: { routeId: legacyRoute.id }, config: { minute: 5 }, createdAt: NOW, updatedAt: NOW }], nextCursor: null } });
    if (rest === "/publish-preview") return route.fulfill({ json: { currentVersion: null, draftHash: `sha256:${"a".repeat(64)}`, hasChanges: true, changes: [] } });
    if (rest === "/clusters") return route.fulfill({ json: { items: [] } });
    // Keep the old fallback observable: read-only legacy scenarios must never call it.
    const v1Route = /^\/routes\/([^/]+)$/.exec(rest ?? "");
    if (v1Route && request.method() === "PUT") {
      const body = request.postDataJSON() as Record<string, unknown>;
      fake.requests[fake.requests.length - 1]!.body = body;
      const current = fake.routes.find((r) => r.id === v1Route[1] && fake.routeOwner.get(r.id) === w.id);
      if (!current) return route.fulfill(problem(404));
      const errors = v2BodyErrors("routes", { paths: ["/"], ...body }).filter((e) => e.path !== "paths");
      if (errors.length > 0) return route.fulfill(invalidBody(errors));
      const { pathCompatibility: _p, ...v1 } = { ...current, ...body, updatedAt: NOW } as WorkspaceRoute;
      Object.assign(current, v1);
      fake.dirty.add(w.id);
      return route.fulfill({ json: v1 });
    }
    return route.fulfill({ json: { items: [], nextCursor: null } });
  });
  await page.route(/^https?:\/\/[^/]+\/api\/v2\//, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api\/v2/, "");
    const method = request.method();
    const body = (request.postData() ? request.postDataJSON() : null) as Record<string, unknown> | null;
    record(method, path, body);
    if (path === "/workspace-creation-policy") {
      return route.fulfill({ json: { mode: "autonomous", creatorBecomesAdmin: false, updatedAt: null, updatedBy: null, workspacesMode: "lab", stage: "dev", caller: { canCreate: true, canRequest: false, canDecide: false } } });
    }
    if (path === "/workspaces" && method === "GET") return route.fulfill({ json: { items: fake.workspaces, nextCursor: null } });
    if (path === "/workspaces" && method === "POST") {
      const w: Workspace = { id: uuid(), key: uuid(), name: String(body!.name), slug: String(body!.slug), status: "active", activeRelease: null };
      fake.workspaces.push(w);
      return route.fulfill({ status: 201, json: w });
    }
    const [, wsId, kind, entityId] = /^\/workspaces\/([^/]+)(?:\/(services|routes|upstreams)(?:\/([^/]+))?)?$/.exec(path) ?? [];
    const w = fake.workspaces.find((x) => x.id === wsId);
    if (!w) return route.fulfill(problem(404));
    if (!kind) {
      if (fake.hold?.kind === "workspace") await fake.hold.ready;
      if (fake.failed === "workspace") return route.fulfill(problem(503));
      return route.fulfill({ json: w });
    }
    if (kind === "upstreams") return route.fulfill({ json: { items: fake.upstreams.filter((u) => u.workspaceId === w.id), nextCursor: null } });
    if (method === "DELETE" && kind === "routes") {
      fake.routes = fake.routes.filter((r) => r.id !== entityId || fake.routeOwner.get(r.id) !== w.id);
      fake.routeOwner.delete(entityId!);
      fake.dirty.add(w.id);
      return route.fulfill({ status: 204 });
    }
    if (method !== "GET") {
      const errors = v2BodyErrors(kind as "services" | "routes", body);
      if (errors.length > 0) return route.fulfill(invalidBody(errors));
    }
    if (kind === "services") {
      const own = fake.services.filter((s) => s.workspaceId === w.id);
      if (method === "GET" && !entityId) return route.fulfill({ json: { items: own, nextCursor: null } });
      const current = own.find((s) => s.id === entityId);
      if (method === "GET") return current ? route.fulfill({ json: current }) : route.fulfill(problem(404));
      const upstreams = fake.upstreams.filter((u) => u.workspaceId === w.id);
      const upstream = upstreams.find((u) => u.id === body!.upstreamId);
      if (body!.upstreamId && !upstream) return route.fulfill(problem(422, { errors: [{ path: "upstreamId", message: "unknown upstream in this workspace" }] }));
      if (upstream && body!.host !== upstream.name) return route.fulfill(problem(422, { errors: [{ path: "host", message: "must be the upstream's name" }] }));
      if (!upstream && upstreams.some((u) => u.name === body!.host)) {
        return route.fulfill(problem(422, { errors: [{ path: "upstreamId", message: `host ${String(body!.host)} is an upstream of this workspace: refer to it by upstreamId` }] }));
      }
      if (own.some((s) => s.name === body!.name && s.id !== entityId)) return route.fulfill(problem(409, { detail: "An entity with the same unique field already exists" }));
      const saved = { ...(current ?? { id: uuid(), workspaceId: w.id, createdAt: NOW }), ...body, updatedAt: NOW } as WorkspaceService;
      fake.services = [...fake.services.filter((s) => s.id !== saved.id), saved];
      fake.dirty.add(w.id);
      return route.fulfill({ status: current ? 200 : 201, json: saved });
    }
    const own = fake.routes.filter((r) => fake.routeOwner.get(r.id) === w.id);
    if (method === "GET" && !entityId) {
      const serviceId = url.searchParams.get("serviceId");
      return route.fulfill({ json: { items: own.filter((r) => !serviceId || r.serviceId === serviceId), nextCursor: null } });
    }
    const current = own.find((r) => r.id === entityId);
    if (fake.routeErrors) return route.fulfill(problem(422, { errors: fake.routeErrors }));
    if (!fake.services.some((s) => s.workspaceId === w.id && s.id === body!.serviceId)) {
      return route.fulfill(problem(422, { errors: [{ path: "serviceId", message: "unknown service in this environment" }] }));
    }
    if (current?.pathCompatibility === "legacy-preserved" && "stripPath" in body! && body!.stripPath !== current.stripPath) {
      return route.fulfill(problem(409, { code: "path-compatibility", errors: [{ path: "stripPath", message: "differs from the legacy route's" }] }));
    }
    const saved = {
      ...(current ?? { id: uuid(), pathCompatibility: "workspace-default", createdAt: NOW }),
      ...body, stripPath: body!.stripPath ?? current?.stripPath ?? false, updatedAt: NOW,
    } as WorkspaceRoute;
    fake.routes = [...fake.routes.filter((r) => r.id !== saved.id), saved];
    fake.routeOwner.set(saved.id, w.id);
    fake.dirty.add(w.id);
    return route.fulfill({ status: current ? 200 : 201, json: saved });
  });
}

const legacyWs: Workspace = { id: uuid(), key: uuid(), name: "Legado", slug: "legado", status: "active", activeRelease: 7 };
const legacyService: WorkspaceService = { id: uuid(), workspaceId: legacyWs.id, name: "boletos", protocol: "http", host: "boletos.internal", port: 80, enabled: true, upstreamId: null, createdAt: NOW, updatedAt: NOW };
const legacyRoute = {
  id: uuid(), name: "boletos-api", serviceId: legacyService.id, paths: ["/boletos"], protocols: ["http", "https"], stripPath: true,
  preserveHost: false, pathCompatibility: "legacy-preserved", createdAt: NOW, updatedAt: NOW,
} as WorkspaceRoute;

function newFake(): Fake {
  return {
    workspaces: [{ ...legacyWs }], services: [{ ...legacyService }], routes: [{ ...legacyRoute }], routeOwner: new Map([[legacyRoute.id, legacyWs.id]]),
    upstreams: [], dirty: new Set(), requests: [],
  };
}

async function signIn(page: Page, fake: Fake) {
  await fakeApi(page, fake);
  await mockSession(page, admin);
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(admin.email);
  await page.getByLabel("Senha").fill("s3nha-de-teste");
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("heading", { name: "Services", exact: true })).toBeVisible();
}

const menu = (page: Page) => page.getByRole("navigation", { name: "Menu principal" });
const selector = (page: Page) => page.getByLabel("Workspace", { exact: true });

function trackRouteWrites(page: Page) {
  const writes: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (["PUT", "POST", "DELETE"].includes(request.method()) && /^\/api\/v[12]\/.*\/routes(?:\/|$)/.test(path)) {
      writes.push(`${request.method()} ${path}`);
    }
  });
  return writes;
}

async function expectPathlessReadOnly(page: Page) {
  const explanation = "Esta route legada sem paths é somente leitura. Ela exige o fluxo legado apropriado ou uma conversão explícita e auditada; a tela v2 não a edita.";
  const row = page.getByRole("table", { name: "Routes", exact: true }).getByRole("row").filter({ hasText: "boletos-host" });
  await expect(row).toContainText("Legada");
  await expect(row).toContainText(explanation);
  await expect(row.getByRole("button")).toHaveCount(1);
  await expect(row.getByRole("button", { name: "Ver detalhes", exact: true })).toBeVisible();
  const dialog = page.getByRole("dialog", { name: "Detalhes de boletos-host" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(explanation);
  await expect(dialog.locator("dl")).toContainText("boletos-host");
  await expect(dialog.locator("dl")).toContainText("boletos.example");
  await expect(dialog.locator("form, input, textarea, select, [contenteditable=true]")).toHaveCount(0);
  await expect(dialog.getByRole("button")).toHaveCount(2);
  await expect(dialog.getByRole("button", { name: "Fechar", exact: true })).toHaveCount(2);
  return dialog;
}

async function createWorkspace(page: Page, name: string) {
  await menu(page).getByRole("link", { name: "Workspaces", exact: true }).click();
  await page.getByRole("button", { name: "Criar Workspace" }).click();
  const dialog = page.getByRole("dialog", { name: "Criar Workspace" });
  await dialog.getByLabel("Nome").fill(name);
  await dialog.getByRole("button", { name: "Criar", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

async function openSection(page: Page, workspace: string, section: "Services" | "Routes") {
  await selector(page).selectOption({ label: workspace });
  await menu(page).getByRole("link", { name: section, exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: section, exact: true })).toBeVisible();
}

async function createService(page: Page, name: string, host: string) {
  await page.getByRole("button", { name: "Novo service" }).click();
  const dialog = page.getByRole("dialog", { name: "Novo service" });
  await dialog.getByLabel("Nome").fill(name);
  await dialog.getByLabel("Host").fill(host);
  await dialog.getByRole("button", { name: "Salvar" }).click();
  await expect(dialog).toHaveCount(0);
}

async function createRoute(page: Page, name: string, service: string, path: string, slug: string) {
  await page.getByRole("button", { name: "Nova route" }).click();
  const dialog = page.getByRole("dialog", { name: "Nova route" });
  await dialog.getByLabel("Nome").fill(name);
  await dialog.getByLabel("Service", { exact: true }).selectOption({ label: service });
  await dialog.getByLabel("Paths", { exact: true }).fill(path);
  await expect(dialog.getByRole("group", { name: "Path público" })).toContainText(`Prefixo do Workspace: /${slug}`);
  await expect(dialog.getByRole("group", { name: "Path público" })).toContainText(`Path público: /${slug}${path}`);
  await expect(dialog.getByRole("group", { name: "Path público" })).toContainText(`chega ao upstream como /${slug}${path}/x`);
  await dialog.getByRole("button", { name: "Salvar" }).click();
  await expect(dialog).toHaveCount(0);
}

test("two workspaces keep their services and routes apart; nothing crosses, nothing is deployed", async ({ page }) => {
  test.setTimeout(90_000);
  const fake = newFake();
  await signIn(page, fake);
  await createWorkspace(page, "Cobrança");
  await createWorkspace(page, "Recargas");
  const [a, b] = [fake.workspaces[1]!, fake.workspaces[2]!];

  await openSection(page, "Cobrança", "Services");
  await expect(page.getByRole("note", { name: "Estado do Workspace" })).toContainText("Prefixo público /cobranca · nenhuma release ativa");
  await createService(page, "service-a", "cobranca.internal");
  await openSection(page, "Recargas", "Services");
  await createService(page, "service-b", "recargas.internal");
  await openSection(page, "Cobrança", "Routes");
  await createRoute(page, "route-a", "service-a", "/boletos", "cobranca");
  await openSection(page, "Recargas", "Routes");
  await createRoute(page, "route-b", "service-b", "/pix", "recargas");

  // Each workspace shows only its own entities, and its forms only offer its own services.
  const routes = page.getByRole("table", { name: "Routes", exact: true });
  await expect(routes).toContainText("route-b");
  await expect(routes).toContainText("/recargas/pix");
  await expect(routes).not.toContainText("route-a");
  await selector(page).selectOption({ label: "Cobrança" });
  await expect(page).toHaveURL(new RegExp(`/e/${a.id}/routes$`));
  await expect(routes).toContainText("route-a");
  await expect(routes).toContainText("/cobranca/boletos");
  await expect(routes).not.toContainText("route-b");
  await routes.getByRole("button", { name: "Editar", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "Editar route-a" });
  await expect(dialog.getByLabel("Service", { exact: true }).locator("option")).toHaveText(["service-a"]);

  // A request that names Service B (a stale or tampered client) is refused by the server, shown on the Service field.
  const serviceB = fake.services.find((s) => s.name === "service-b")!;
  await page.route(`**/api/v2/workspaces/${a.id}/routes/*`, (route) => route.fallback({ postData: JSON.stringify({ ...route.request().postDataJSON(), serviceId: serviceB.id }) }));
  await dialog.getByRole("button", { name: "Salvar" }).click();
  await expect(dialog.getByText("O service escolhido não pertence a este Workspace.")).toBeVisible();
  await expect(dialog).toBeVisible();
  expect(fake.routes.find((r) => r.name === "route-a")!.serviceId).not.toBe(serviceB.id);
  await page.unroute(`**/api/v2/workspaces/${a.id}/routes/*`);

  // Editing the route: stripPath is an explicit choice and the effect is spelled out before saving.
  await dialog.getByLabel("Paths", { exact: true }).fill("/boletos\n/segunda-via");
  await dialog.getByLabel("Remover o path da route ao encaminhar (stripPath)").check();
  await expect(dialog.getByRole("group", { name: "Path público" })).toContainText("Uma requisição a /cobranca/boletos/x chega ao upstream como /x.");
  await dialog.getByRole("button", { name: "Salvar" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(routes).toContainText("/cobranca/boletos, /cobranca/segunda-via");
  expect(fake.routes.find((r) => r.name === "route-a")).toMatchObject({ paths: ["/boletos", "/segunda-via"], stripPath: true, serviceId: fake.services.find((s) => s.name === "service-a")!.id });

  // Editing the service.
  await menu(page).getByRole("link", { name: "Services", exact: true }).click();
  const services = page.getByRole("table", { name: "Services", exact: true });
  await expect(services).toContainText("service-a");
  await expect(services).not.toContainText("service-b");
  await services.getByRole("button", { name: "Editar", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Editar service-a" });
  await dialog.getByLabel("Porta").fill("8443");
  await dialog.getByLabel("Protocolo").selectOption("https");
  await dialog.getByRole("button", { name: "Salvar" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(services).toContainText("https://cobranca.internal:8443");
  await expect(page.getByRole("note", { name: "Estado do Workspace" })).toContainText("há alterações no rascunho ainda não publicadas");
  await expect(page.getByRole("note", { name: "Estado do Workspace" })).toContainText("Deployment de Workspaces indisponível nesta fase");

  // Nothing was published, released or deployed: only draft writes reached the server.
  const writes = fake.requests.filter((r) => r.method !== "GET");
  expect(writes.filter((r) => !/^\/workspaces(\/[^/]+\/(services|routes)(\/[^/]+)?)?$/.test(r.path)).map((r) => `${r.method} ${r.path}`)).toEqual([]);
  expect(fake.workspaces.map((w) => w.activeRelease)).toEqual([7, null, null]);
  await expect(page.getByRole("button", { name: /implantar|deploy/i })).toHaveCount(0);
  expect(b.id).not.toBe(a.id);
});

test("switching workspace with a form open closes it: no form keeps the previous workspace's entity", async ({ page }) => {
  const fake = newFake();
  const other: Workspace = { id: uuid(), key: uuid(), name: "Recargas", slug: "recargas", status: "active", activeRelease: null };
  fake.workspaces.push(other);
  await signIn(page, fake);
  await selector(page).selectOption({ label: "Recargas" });
  await expect(page).toHaveURL(new RegExp(`/e/${other.id}/services$`));
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/e/${legacyWs.id}/services$`));
  await page.getByRole("table", { name: "Services", exact: true }).getByRole("button", { name: "Editar", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Editar boletos" })).toBeVisible();
  // The browser's forward button changes the workspace under the open dialog.
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/e/${other.id}/services$`));
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("Nenhum service ainda.")).toBeVisible();
  await expect(page.getByText("boletos")).toHaveCount(0);
  await expect(selector(page)).toHaveValue(other.id);
});

for (const stripPath of [true, false]) {
  test(`a legacy route with paths keeps its stored stripPath=${stripPath} in the v2 PUT without conversion`, async ({ page }) => {
    const fake = newFake();
    fake.routes[0] = { ...legacyRoute, stripPath };
    const original = { ...fake.routes[0] };
    const writes = trackRouteWrites(page);
    await signIn(page, fake);
    await menu(page).getByRole("link", { name: "Routes", exact: true }).click();
    const routes = page.getByRole("table", { name: "Routes", exact: true });
    await expect(routes).toContainText("Legada");
    await expect(routes).toContainText("mantém o stripPath que tinha");
    await expect(routes).toContainText("/legado/boletos");
    await expect(page.getByRole("note", { name: "Estado do Workspace" })).toContainText("release ativa v7");
    await routes.getByRole("button", { name: "Editar", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Editar boletos-api" });
    await expect(dialog.getByLabel(/stripPath/)).toHaveCount(0);
    await expect(dialog).toContainText(`stripPath atual: ${stripPath ? "sim" : "não"}`);
    await expect(dialog.getByRole("group", { name: "Path público" })).toContainText(`Uma requisição a /legado/boletos/x chega ao upstream como ${stripPath ? "/x" : "/legado/boletos/x"}.`);
    await dialog.getByLabel("Métodos").fill("GET");
    await dialog.getByRole("button", { name: "Salvar" }).click();
    await expect(dialog).toHaveCount(0);
    expect(writes).toEqual([`PUT /api/v2/workspaces/${legacyWs.id}/routes/${legacyRoute.id}`]);
    const put = fake.requests.find((r) => r.method === "PUT" && r.path === `/workspaces/${legacyWs.id}/routes/${legacyRoute.id}`)!;
    expect(put.body).toMatchObject({ stripPath: original.stripPath, methods: ["GET"] });
    expect(fake.routes[0]).toMatchObject({ pathCompatibility: original.pathCompatibility, stripPath: original.stripPath, methods: ["GET"] });
    expect(fake.requests.some((r) => r.path.includes("path-compatibility"))).toBe(false);
  });
}

test("a service balances through an upstream of its workspace, or goes to a DNS host that is not one", async ({ page }) => {
  const fake = newFake();
  fake.upstreams.push({ id: uuid(), name: "boletos.upstream", workspaceId: legacyWs.id });
  await signIn(page, fake);
  await page.getByRole("button", { name: "Novo service" }).click();
  const dialog = page.getByRole("dialog", { name: "Novo service" });
  await dialog.getByLabel("Nome").fill("boletos-dns");
  await dialog.getByLabel("Host").fill("boletos.upstream");
  await dialog.getByRole("button", { name: "Salvar" }).click();
  await expect(dialog.getByText("Este host é um upstream do Workspace: escolha “Upstream do Workspace”.")).toBeVisible();
  await expect(dialog.getByLabel("Host")).toHaveAttribute("aria-invalid", "true");
  await dialog.getByLabel("Destino", { exact: true }).selectOption("Upstream do Workspace");
  await dialog.getByLabel("Upstream", { exact: true }).selectOption({ label: "boletos.upstream" });
  await dialog.getByRole("button", { name: "Salvar" }).click();
  await expect(dialog).toHaveCount(0);
  const services = page.getByRole("table", { name: "Services", exact: true });
  await expect(services.getByRole("row").filter({ hasText: "boletos-dns" })).toContainText("Upstream");
  expect(fake.services.find((s) => s.name === "boletos-dns")).toMatchObject({ host: "boletos.upstream", upstreamId: fake.upstreams[0]!.id });
});

test("searching services for \"all\" and then opening Routes keeps both lists apart in the cache", async ({ page }) => {
  const fake = newFake();
  fake.services.push({ ...legacyService, id: uuid(), name: "all-in-one", host: "all.internal", path: "/v1" });
  await signIn(page, fake);
  await page.getByLabel("Buscar services").fill("all");
  await expect(page.getByRole("table", { name: "Services", exact: true })).toContainText("all-in-one");
  await menu(page).getByRole("link", { name: "Routes", exact: true }).click();
  await expect(page.getByLabel("Filtrar por service").locator("option")).toHaveText(["Todos os services", "boletos", "all-in-one"]);
  await expect(page.getByRole("table", { name: "Routes", exact: true })).toContainText("Service boletos");
  await page.getByRole("button", { name: "Nova route" }).click();
  const dialog = page.getByRole("dialog", { name: "Nova route" });
  await dialog.getByLabel("Service", { exact: true }).selectOption({ label: "all-in-one" });
  await dialog.getByLabel("Paths", { exact: true }).fill("/orders");
  // The service's path comes first in what the upstream receives.
  const preview = dialog.getByRole("group", { name: "Path público" });
  await expect(preview).toContainText("Uma requisição a /legado/orders/x chega ao upstream como /v1/legado/orders/x.");
  await dialog.getByLabel("Remover o path da route ao encaminhar (stripPath)").check();
  await expect(preview).toContainText("Uma requisição a /legado/orders/x chega ao upstream como /v1/x.");
  await page.getByRole("button", { name: "Cancelar" }).click();
  await menu(page).getByRole("link", { name: "Services", exact: true }).click();
  await expect(page.getByRole("table", { name: "Services", exact: true })).toContainText("boletos");
});

test("a migrated route without paths has read-only details and never writes through v1 or v2", async ({ page }) => {
  const fake = newFake();
  const writes = trackRouteWrites(page);
  const hostOnly = { ...legacyRoute, id: uuid(), name: "boletos-host", paths: [], hosts: ["boletos.example"] } as WorkspaceRoute;
  const original = structuredClone(hostOnly);
  fake.routes.push(hostOnly);
  fake.routeOwner.set(hostOnly.id, legacyWs.id);
  await signIn(page, fake);
  await menu(page).getByRole("link", { name: "Routes", exact: true }).click();
  const row = page.getByRole("table", { name: "Routes", exact: true }).getByRole("row").filter({ hasText: "boletos-host" });
  await row.getByRole("button", { name: "Ver detalhes", exact: true }).click();
  const dialog = await expectPathlessReadOnly(page);
  await dialog.getByRole("button", { name: "Fechar", exact: true }).last().click();
  await expect(dialog).toHaveCount(0);
  expect(writes).toEqual([]);
  expect(fake.requests.filter((r) => r.method !== "GET")).toEqual([]);
  expect(fake.routes.find((r) => r.id === hostOnly.id)).toEqual(original);
});

test("a pathless legacy route stays read-only with auto publishing and keyboard interaction", async ({ page }) => {
  const fake = newFake();
  const writes = trackRouteWrites(page);
  fake.autoPublish = new Set([legacyWs.id]);
  const hostOnly = { ...legacyRoute, id: uuid(), name: "boletos-host", paths: [], hosts: ["boletos.example"] } as WorkspaceRoute;
  const original = structuredClone(hostOnly);
  fake.routes.push(hostOnly);
  fake.routeOwner.set(hostOnly.id, legacyWs.id);
  await signIn(page, fake);
  await menu(page).getByRole("link", { name: "Routes", exact: true }).click();
  const routes = page.getByRole("table", { name: "Routes", exact: true });
  await routes.getByRole("row").filter({ hasText: "boletos-host" }).getByRole("button", { name: "Ver detalhes", exact: true }).press("Enter");
  const dialog = await expectPathlessReadOnly(page);
  await dialog.getByRole("heading").click();
  await page.keyboard.press("Enter");
  await expectPathlessReadOnly(page);
  expect(writes).toEqual([]);
  // The scrollable modal body can receive focus between the header and footer.
  const close = dialog.locator("footer").getByRole("button", { name: "Fechar", exact: true });
  await close.focus();
  await expect(close).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  // Auto publication makes routes with paths read-only too, including legacy routes.
  await expect(routes.getByRole("button", { name: "Editar", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Nova route" })).toHaveCount(0);
  await expect(page.getByRole("note", { name: "Estado do Workspace" })).toContainText("publicação automática");
  expect(writes).toEqual([]);
  expect(fake.requests.filter((r) => r.method !== "GET")).toEqual([]);
  expect(fake.routes.find((r) => r.id === hostOnly.id)).toEqual(original);
});

test("pathless legacy details stay read-only when publishing changes from manual to auto", async ({ page }) => {
  const fake = newFake();
  const writes = trackRouteWrites(page);
  const hostOnly = { ...legacyRoute, id: uuid(), name: "boletos-host", paths: [], hosts: ["boletos.example"] } as WorkspaceRoute;
  const original = structuredClone(hostOnly);
  fake.routes.push(hostOnly);
  fake.routeOwner.set(hostOnly.id, legacyWs.id);
  await signIn(page, fake);
  await menu(page).getByRole("link", { name: "Routes", exact: true }).click();
  const details = page.getByRole("table", { name: "Routes", exact: true }).getByRole("row").filter({ hasText: "boletos-host" }).getByRole("button", { name: "Ver detalhes", exact: true });
  await details.click();
  const dialog = await expectPathlessReadOnly(page);
  // Someone switches the environment to auto after this screen read it.
  fake.autoPublish = new Set([legacyWs.id]);
  await dialog.getByRole("heading").click();
  await page.keyboard.press("Enter");
  await expectPathlessReadOnly(page);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await details.press("Space");
  await expectPathlessReadOnly(page);
  await dialog.getByRole("button", { name: "Fechar", exact: true }).last().press("Enter");
  await expect(dialog).toHaveCount(0);
  // The refreshed screen also sees auto, rather than retaining the earlier manual mode.
  const autoMode = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/environments/${legacyWs.id}` && response.request().method() === "GET");
  await page.reload();
  expect(await (await autoMode).json()).toMatchObject({ publishMode: "auto" });
  await details.press("Enter");
  await expectPathlessReadOnly(page);
  await dialog.getByRole("button", { name: "Fechar", exact: true }).last().press("Enter");
  await expect(dialog).toHaveCount(0);
  expect(writes).toEqual([]);
  expect(fake.requests.filter((r) => r.method !== "GET")).toEqual([]);
  expect(fake.routes.find((r) => r.id === hostOnly.id)).toEqual(original);
});

for (const options of [
  { status: "archived", publishMode: "manual", reason: "arquivado" },
  { status: "active", publishMode: "auto", reason: "publicação automática" },
  { status: "active", publishMode: "auto", paused: "import", reason: "publicação automática" },
  { status: "archived", publishMode: "auto", reason: "arquivado" },
] as const) {
  test(`routes are read-only: ${options.status}, ${options.publishMode}, ${"paused" in options ? options.paused : "unpaused"}`, async ({ page }) => {
    const fake = newFake();
    fake.workspaces[0]!.status = options.status;
    if (options.publishMode === "auto") fake.autoPublish = new Set([legacyWs.id]);
    if ("paused" in options) fake.paused = options.paused;
    await signIn(page, fake);
    await menu(page).getByRole("link", { name: "Routes", exact: true }).click();
    await expect(page.getByRole("table", { name: "Routes", exact: true })).toContainText("boletos-api");
    await expect(page.getByRole("note", { name: "Estado do Workspace" })).toContainText(options.reason);
    await expect(page.getByRole("button", { name: /Nova route|^Editar$|Mais ações para/ })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Publicação", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Plugins", exact: true }).click();
    const plugins = page.getByRole("dialog", { name: "Plugins de boletos-api" });
    await expect(plugins).toContainText("rate-limiting");
    await expect(plugins).toContainText("Plugins por Workspace ainda não são editáveis aqui.");
    await expect(plugins.getByRole("button", { name: /Adicionar plugin|Novo plugin|Editar|Mais ações/ })).toHaveCount(0);
    await expect(plugins.getByRole("checkbox")).toHaveCount(0);
    expect(fake.requests.filter((r) => r.method !== "GET")).toEqual([]);
  });
}

for (const kind of ["workspace", "environment"] as const) {
  test(`routes have no write controls before ${kind} is known`, async ({ page }) => {
    const fake = newFake();
    let release!: () => void;
    fake.hold = { kind, ready: new Promise<void>((resolve) => { release = resolve; }) };
    try {
      await signIn(page, fake);
      await menu(page).getByRole("link", { name: "Routes", exact: true }).click();
      await expect(page.getByRole("table", { name: "Routes", exact: true })).toContainText("boletos-api");
      await expect(page.getByText(/Somente leitura enquanto/)).toBeVisible();
      await expect(page.getByRole("button", { name: /Nova route|^Editar$|Mais ações para/ })).toHaveCount(0);
      expect(fake.requests.filter((r) => r.method !== "GET")).toEqual([]);
    } finally { release(); }
    await expect(page.getByRole("button", { name: "Nova route" })).toBeEnabled();
  });

  test(`routes stay read-only when ${kind} fails`, async ({ page }) => {
    const fake = newFake();
    fake.failed = kind;
    await signIn(page, fake);
    await menu(page).getByRole("link", { name: "Routes", exact: true }).click();
    await expect(page.getByRole("table", { name: "Routes", exact: true })).toContainText("boletos-api");
    await expect(page.getByText(/não foi possível verificar/)).toBeVisible();
    await expect(page.getByRole("button", { name: /Nova route|^Editar$|Mais ações para/ })).toHaveCount(0);
    expect(fake.requests.filter((r) => r.method !== "GET")).toEqual([]);
  });
}

for (const operation of ["create", "edit"] as const) {
  test(`route ${operation} preserves literal and regex commas in preview and v2 payload`, async ({ page }) => {
    const fake = newFake();
    const paths = ["~/items/[0-9]{1,3}", "/a,/b"];
    fake.routes[0]!.paths = paths;
    await signIn(page, fake);
    await menu(page).getByRole("link", { name: "Routes", exact: true }).click();
    await expect(page.getByRole("region", { name: "Publicação", exact: true })).toBeVisible();
    await page.getByRole("button", { name: operation === "create" ? "Nova route" : "Editar", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: operation === "create" ? "Nova route" : "Editar boletos-api" });
    await dialog.getByLabel("Nome", { exact: true }).fill("comma-paths");
    if (operation === "create") await dialog.getByLabel("Paths", { exact: true }).fill(paths.join("\n"));
    await expect(dialog.getByRole("group", { name: "Path público" })).toContainText("~/legado(?:/items/[0-9]{1,3}), /legado/a,/b");
    await dialog.getByRole("button", { name: "Salvar" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("table", { name: "Routes", exact: true })).toContainText("comma-paths");
    const writes = fake.requests.filter((r) => r.method !== "GET");
    expect(writes).toEqual([expect.objectContaining({ method: operation === "create" ? "POST" : "PUT", body: expect.objectContaining({ paths, stripPath: operation === "edit" }) })]);
    expect(fake.routes.find((r) => r.name === "comma-paths")!.paths).toEqual(paths);
  });
}

test("preserveHost validation is visible beside the checkbox and describes it accessibly", async ({ page }) => {
  const fake = newFake();
  fake.routeErrors = [{ path: "preserveHost", message: "must be boolean" }];
  await signIn(page, fake);
  await menu(page).getByRole("link", { name: "Routes", exact: true }).click();
  await page.getByRole("button", { name: "Editar", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Editar boletos-api" });
  await dialog.getByRole("button", { name: "Salvar" }).click();
  const checkbox = dialog.getByRole("checkbox", { name: "Preservar o host original" });
  await expect(checkbox).toHaveAttribute("aria-invalid", "true");
  const description = await checkbox.getAttribute("aria-describedby");
  expect(description).toBeTruthy();
  const error = dialog.locator(`[id="${description}"]`);
  await expect(error).toHaveAttribute("role", "alert");
  await expect(error).toContainText("Preservar o host");
  await expect(checkbox).toHaveAccessibleDescription(await error.innerText());
  expect(fake.requests.filter((r) => r.method !== "GET").map((r) => [r.method, r.path])).toEqual([["PUT", `/workspaces/${legacyWs.id}/routes/${legacyRoute.id}`]]);
});

test("manual publication permits deleting a route through v2 without a publish request", async ({ page }) => {
  const fake = newFake();
  await signIn(page, fake);
  await menu(page).getByRole("link", { name: "Routes", exact: true }).click();
  await page.getByRole("button", { name: "Mais ações para boletos-api" }).click();
  await page.getByRole("menuitem", { name: "Excluir" }).click();
  const dialog = page.getByRole("dialog", { name: "Excluir route" });
  await dialog.getByRole("button", { name: "Excluir", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Nenhuma route encontrada.", { exact: true })).toBeVisible();
  expect(fake.requests.filter((r) => r.method !== "GET").map((r) => [r.method, r.path])).toEqual([["DELETE", `/workspaces/${legacyWs.id}/routes/${legacyRoute.id}`]]);
  expect(fake.routes).toEqual([]);
});

test("manual routes expose v1 plugins only for reading", async ({ page }) => {
  const fake = newFake();
  await signIn(page, fake);
  await menu(page).getByRole("link", { name: "Routes", exact: true }).click();
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Plugins de boletos-api" });
  await expect(dialog).toContainText("rate-limiting");
  await expect(dialog).toContainText("Plugins por Workspace ainda não são editáveis aqui.");
  await expect(dialog.getByRole("button", { name: /Adicionar plugin|Novo plugin|Editar|Mais ações/ })).toHaveCount(0);
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
  expect(fake.requests.filter((r) => r.method !== "GET")).toEqual([]);
});

for (const width of [390, 1440]) {
  test(`workspace routes: layout and axe at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await signIn(page, newFake());
    await menu(page).getByRole("link", { name: "Routes", exact: true }).click();
    await expect(page.getByRole("table", { name: "Routes", exact: true })).toContainText("Legada");
    await checkLayout(page);
    const audit = async (name: string) => {
      const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      expect(result.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${name}: ${v.id}`)).toEqual([]);
    };
    await audit("routes");
    await page.getByRole("button", { name: "Nova route" }).click();
    await page.getByRole("dialog", { name: "Nova route" }).getByLabel("Paths", { exact: true }).fill("/recarga");
    await checkLayout(page, { focusWithin: ".modal" });
    await audit("route form");
  });
}
