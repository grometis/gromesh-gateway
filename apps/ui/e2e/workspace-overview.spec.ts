import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import type { Consumer, Me, Plugin, Schemas } from "../src/api/client";
import type { Workspace, WorkspaceRoute, WorkspaceService } from "../src/api/client-v2";
import type { components } from "../src/api/schema-v2";
import { expect, mockSession, test } from "./fixtures";
import { navigateGlobal } from "./global-navigation";

const A = "7c1d2e3f-4a5b-4c6d-8e7f-00000000000a";
const B = "7c1d2e3f-4a5b-4c6d-8e7f-00000000000b";
const stamp = "2026-11-03T12:00:00Z";
const resources = ["services", "routes", "consumers", "plugins", "upstreams", "certificates"];
const labels = ["Serviços", "Rotas", "Consumidores", "Plugins", "Upstreams", "Certificados", "Variáveis"];
const workspace = (id: string, status: Workspace["status"] = "active", activeRelease: number | null | undefined = 3): Workspace => ({
  id, key: id, name: `Workspace ${id === A ? "A" : "B"} ${"Pedidos ".repeat(8)}`.trim(), slug: id === A ? "alpha" : "beta", description: "Gateway de pedidos", status,
  ...(activeRelease !== undefined ? { activeRelease } : {}),
});
const overview = (id = A) => `/workspaces/${id}/overview`;
const indicator = (page: Page, label: string) => page.getByRole("article", { name: `Indicador: ${label}`, exact: true });
const service = (id: string, index: number): WorkspaceService => ({ id: `resource-${id}-${index}`, workspaceId: id, name: `Recurso ${index}`, protocol: "http", host: "echo.internal", port: 80, path: null, enabled: true, tags: [], upstreamId: null, createdAt: stamp, updatedAt: stamp });
const routeItem = (id: string, index: number): WorkspaceRoute => ({ id: `route-${id}-${index}`, serviceId: `resource-${id}-0`, name: `Rota ${index}`, protocols: ["http"], paths: [`/orders-${index}`], methods: ["GET"], hosts: [], stripPath: false, preserveHost: false, pathCompatibility: "workspace-default", tags: [], createdAt: stamp, updatedAt: stamp });
function inventoryItem(resource: string, id: string, index: number): WorkspaceService | WorkspaceRoute | Consumer | Plugin | Schemas["Upstream"] | components["schemas"]["WorkspaceCertificate"] {
  const base = { id: `resource-${id}-${index}`, tags: [], createdAt: stamp, updatedAt: stamp };
  switch (resource) {
    case "routes": return routeItem(id, index);
    case "consumers": return { ...base, username: `consumer-${index}`, customId: null };
    case "plugins": return { ...base, name: "correlation-id", enabled: true, scope: { serviceId: `resource-${id}-0` }, config: {} };
    case "upstreams": return { ...base, name: `upstream-${index}`, algorithm: "round-robin", hashOn: "none", hashFallback: "none", healthchecks: {} };
    case "certificates": return { ...base, cert: "PUBLIC-PEM", key: "REDACTED", snis: [`orders-${index}.example.test`] };
    default: return service(id, index);
  }
}
interface FakeState {
  workspaceStatus?: number;
  archived?: boolean;
  role?: Me["role"];
  listStatus?: number;
  activeRelease?: number | null | "absent";
  counts?: number;
  cursor?: string | null;
  resourceStatus?: Partial<Record<string, number>>;
  releasesStatus?: number;
  hold?: { resource: string; ready: Promise<void> };
}

async function setup(page: Page, state: FakeState = {}) {
  const sent: { path: string; search: string; method: string }[] = [];
  const user: Me = { id: A, name: "Ana", email: "ana@example.test", role: state.role ?? "admin", active: true, createdAt: stamp, updatedAt: stamp };
  await page.route(/^https?:\/\/[^/]+\/api\/v[12]\//, async route => {
    const request = route.request();
    const { pathname: path, search } = new URL(request.url());
    sent.push({ path, search, method: request.method() });
    const json = (data: unknown, status = 200) => route.fulfill({ status, json: data });
    if (path === "/api/v1/auth/csrf") return json({ csrfToken: "csrf" });
    if (path === "/api/v2/workspace-creation-policy") return json({ stage: "dev", workspacesMode: "enabled", mode: "restricted-request", creatorBecomesAdmin: false, updatedAt: null, updatedBy: null, caller: { canCreate: false, canRequest: false, canDecide: false } });
    if (path === "/api/v1/environments" || path === "/api/v1/tokens") return json({ items: [], nextCursor: null });
    if (path === "/api/v2/workspaces") return json({ items: [workspace(A), workspace(B)], nextCursor: null }, state.listStatus);
    for (const id of [A, B]) {
      if (path === `/api/v2/workspaces/${id}`) {
        const data = workspace(id, state.archived ? "archived" : "active", state.activeRelease === "absent" ? undefined : state.activeRelease);
        if (state.activeRelease === "absent") delete data.activeRelease;
        return json(data, state.workspaceStatus);
      }
      if (path === `/api/v2/workspaces/${id}/releases`) return state.releasesStatus
        ? json({ title: "Unavailable", status: state.releasesStatus }, state.releasesStatus)
        : json(Array.from({ length: 7 }, (_, index) => ({ workspaceId: id, version: index + 1, contentDigest: `sha256:${"a".repeat(64)}`, origin: "local", contentOriginVersion: index + 1, contentFirstActivatedAt: null, originPromotionId: null, contentRevoked: false, createdAt: stamp, createdBy: { name: "Ana" }, message: `Resumo ${index + 1}` })));
      const resource = path.slice(`/api/v2/workspaces/${id}/`.length);
      if (path.startsWith(`/api/v2/workspaces/${id}/`) && [...resources, "variables"].includes(resource)) {
        if (id === A && state.hold?.resource === resource) await state.hold.ready;
        const status = state.resourceStatus?.[resource];
        if (status) return json({ title: "Unavailable", status }, status);
        if (resource === "variables") return json([]);
        const items = Array.from({ length: state.counts ?? (id === A ? 1 : 2) }, (_, index) => inventoryItem(resource, id, index));
        // A switch cancels the held A request; its fixture must tolerate that cancellation.
        const response = json({ items, nextCursor: state.cursor ?? null });
        return id === A && state.hold?.resource === resource ? response.catch(() => {}) : response;
      }
    }
    return json({ title: "Unexpected request", status: 500 }, 500);
  });
  await mockSession(page, user);
  await page.context().addCookies([{ name: "gromesh_session", value: "overview-test", url: test.info().project.use.baseURL! }]);
  return sent;
}

async function audit(page: Page) {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(result.violations.map(violation => violation.id)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

for (const width of [390, 768, 1440]) {
  test(`deep link, refresh, bounded inventory, navigation and accessibility at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const sent = await setup(page);
    const target = `${overview()}?x=1#y`;
    await page.goto(`/workspaces/${A}?x=1#y`);
    await expect(page).toHaveURL(target);
    await expect(page.getByRole("heading", { level: 1, name: "Visão geral do Workspace" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    for (const label of labels) await expect(indicator(page, label).locator(".workspace-overview-count")).toHaveText(label === "Variáveis" ? "0" : "1");
    const contentReads = sent.filter(request => request.path.startsWith(`/api/v2/workspaces/${A}`));
    expect(contentReads).toHaveLength(8);
    for (const resource of resources) expect(contentReads.filter(request => request.path.endsWith(`/${resource}`)).map(request => request.search)).toEqual(["?limit=200"]);
    expect(sent.some(request => /\/api\/v1\/environments|analytics|audit|\/releases/.test(request.path))).toBe(false);
    for (const label of ["Consumidores", "Upstreams", "Certificados"]) {
      await expect(indicator(page, label)).toContainText("Página v2 em breve");
      await expect(indicator(page, label).getByRole("link")).toHaveCount(0);
    }
    await expect(page.locator("main")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Novo serviço", exact: true })).toBeFocused();
    await audit(page);
    await page.reload();
    await expect(page).toHaveURL(target);
    await expect(indicator(page, "Serviços").locator(".workspace-overview-count")).toHaveText("1");
    await page.getByRole("button", { name: "Consultar Releases recentes", exact: true }).click();
    await expect(page.getByRole("region", { name: "Releases recentes", exact: true })).toContainText("Resumo 7");
    await expect(page.getByRole("region", { name: "Releases recentes", exact: true }).getByRole("listitem")).toHaveCount(5);
    expect(sent.filter(request => request.path.endsWith(`/${A}/releases`))).toHaveLength(1);
    await indicator(page, "Serviços").getByRole("link").click();
    await expect(page).toHaveURL(`/workspaces/${A}/services`);
    await page.goBack();
    await expect(page).toHaveURL(target);
    await indicator(page, "Rotas").getByRole("link").click();
    await expect(page).toHaveURL(`/workspaces/${A}/routes`);
    await page.goBack();
    await page.getByRole("link", { name: "Ver Releases", exact: true }).click();
    await expect(page).toHaveURL(`/workspaces/${A}/releases`);
    await navigateGlobal(page, "Workspaces");
    await expect(page).toHaveURL("/workspaces");
    await expect(page.getByRole("heading", { level: 1, name: "Workspaces", exact: true })).toBeVisible();
    expect(sent.every(request => request.method === "GET")).toBe(true);
  });

  test(`loading, local errors, retry and empty inventory at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    const state: FakeState = { counts: 0, hold: { resource: "services", ready }, resourceStatus: { routes: 403 } };
    const sent = await setup(page, state);
    await page.goto(overview());
    try {
      await expect(indicator(page, "Serviços")).toHaveAttribute("aria-busy", "true");
      await expect(indicator(page, "Rotas").getByRole("alert")).toContainText("Sem permissão de leitura");
      await expect(indicator(page, "Rotas").locator(".workspace-overview-count")).toHaveText("—");
      await expect(indicator(page, "Consumidores").locator(".workspace-overview-count")).toHaveText("0");
      await audit(page);
    } finally { release(); }
    await expect(indicator(page, "Serviços").locator(".workspace-overview-count")).toHaveText("0");
    state.resourceStatus = {};
    await page.getByRole("button", { name: "Tentar novamente: Rotas", exact: true }).click();
    await expect(indicator(page, "Rotas").locator(".workspace-overview-count")).toHaveText("0");
    expect(sent.filter(request => request.path.endsWith(`/${A}/routes`))).toHaveLength(2);
    expect(sent.filter(request => request.path.endsWith(`/${A}/services`))).toHaveLength(1);
    await audit(page);
  });

  test(`archived and permission read-only states at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const state: FakeState = { archived: true };
    await setup(page, state);
    await page.goto(overview());
    await expect(page.getByRole("region", { name: "Requer atenção", exact: true })).toContainText("Workspace arquivado");
    for (const name of ["Novo serviço", "Nova rota", "Publicar release"]) await expect(page.getByRole("link", { name, exact: true })).toHaveCount(0);
    await expect(indicator(page, "Serviços").locator(".workspace-overview-count")).toHaveText("1");
    await audit(page);
    await mockSession(page, { id: A, name: "Ana", email: "ana@example.test", role: "viewer", active: true, createdAt: stamp, updatedAt: stamp });
    state.archived = false;
    await page.reload();
    await expect(page.getByText("Somente leitura nesta visão geral.", { exact: false })).toBeVisible();
    for (const name of ["Novo serviço", "Nova rota", "Publicar release"]) await expect(page.getByRole("link", { name, exact: true })).toHaveCount(0);
    await audit(page);
  });

  for (const status of [401, 403, 404]) {
    test(`Workspace HTTP ${status} with no contextual data at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const sent = await setup(page, { workspaceStatus: status });
      await page.goto(`${overview()}?x#y`);
      if (status === 401) {
        await expect(page).toHaveURL("/login");
        await expect(page.getByRole("heading", { name: "Entrar", exact: true })).toBeVisible();
      } else {
        await expect(page.getByRole("alert")).toContainText(status === 403 ? "Você não tem permissão" : "Não encontrado ou indisponível");
        await expect(page).toHaveURL(`${overview()}?x#y`);
      }
      await expect(page.getByRole("article")).toHaveCount(0);
      expect(sent.some(request => resources.some(resource => request.path.endsWith(`/${resource}`)))).toBe(false);
      await audit(page);
    });
  }
}

test("partial inventory, release absence and history failure retain their meaning", async ({ page }) => {
  const state: FakeState = { counts: 200, cursor: "next-page", activeRelease: "absent", releasesStatus: 503, listStatus: 403 };
  const sent = await setup(page, state);
  await page.goto(overview());
  await expect(indicator(page, "Serviços").locator(".workspace-overview-count")).toHaveText("200+");
  await expect(indicator(page, "Serviços")).toContainText("total não consultado");
  await expect(page.getByRole("region", { name: "Release selecionada", exact: true })).toContainText("Estado da Release não informado");
  await expect(page.getByRole("region", { name: "Requer atenção", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Consultar Releases recentes", exact: true }).click();
  await expect(page.getByRole("region", { name: "Releases recentes", exact: true }).getByRole("alert")).toContainText("Não foi possível consultar");
  state.releasesStatus = undefined;
  await page.getByRole("button", { name: "Tentar novamente: Releases", exact: true }).click();
  await expect(page.getByRole("region", { name: "Releases recentes", exact: true })).toContainText("Resumo 7");
  expect(sent.filter(request => request.path.endsWith(`/${A}/services`))).toHaveLength(1);
  expect(sent.some(request => request.search.includes("cursor="))).toBe(false);
  state.activeRelease = null;
  await page.reload();
  await expect(page.getByRole("region", { name: "Requer atenção", exact: true })).toContainText("Nenhuma Release selecionada");
});

test("switching A to B discards pending A data and on-demand state; history preserves URLs", async ({ page }) => {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const sent = await setup(page, { hold: { resource: "services", ready } });
  const from = `${overview()}?x=1#y`;
  await page.goto(from);
  try {
    await expect(indicator(page, "Serviços")).toHaveAttribute("aria-busy", "true");
    await page.getByRole("button", { name: "Consultar Releases recentes", exact: true }).click();
    await expect(page.getByRole("region", { name: "Releases recentes", exact: true })).toContainText("Resumo 7");
    await page.getByLabel("Workspace v2", { exact: true }).selectOption(B);
    await expect(page).toHaveURL(overview(B));
    await expect(indicator(page, "Serviços").locator(".workspace-overview-count")).toHaveText("2");
    await expect(page.locator("main")).not.toContainText("Workspace A");
    await expect(page.getByRole("button", { name: "Consultar Releases recentes", exact: true })).toBeVisible();
    expect(sent.some(request => request.path.endsWith(`/${B}/releases`))).toBe(false);
  } finally { release(); }
  await expect(indicator(page, "Serviços").locator(".workspace-overview-count")).toHaveText("2");
  await page.goBack();
  await expect(page).toHaveURL(from);
  await expect(indicator(page, "Serviços").locator(".workspace-overview-count")).toHaveText("1");
  await page.goForward();
  await expect(page).toHaveURL(overview(B));
  await expect(indicator(page, "Serviços").locator(".workspace-overview-count")).toHaveText("2");
});
