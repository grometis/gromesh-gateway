import { openGateway } from "./gateway-sidebar";
import { navigateGlobal } from "./global-navigation";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, mockSession, test } from "./fixtures";

const A = "7c1d2e3f-4a5b-4c6d-8e7f-00000000000a";
const B = "7c1d2e3f-4a5b-4c6d-8e7f-00000000000b";
const stamp = "2026-11-03T12:00:00Z";
const workspace = (id: string, archived = false) => ({ id, key: id, name: `Workspace ${id === A ? "A" : "B"}`, slug: id === A ? "alpha" : "beta", status: archived ? "archived" : "active", activeRelease: null });
const environment = (id: string) => ({ id, name: `Legado ${id === A ? "A" : "B"}`, publishMode: "manual", hasUnpublishedChanges: false, currentVersion: null, createdAt: stamp, updatedAt: stamp });
const service = (id: string) => ({ id: `service-${id}`, workspaceId: id, upstreamId: null, name: `Service ${id === A ? "A" : "B"}`, host: "echo.internal", protocol: "http", port: 80, path: null, enabled: true, tags: [], createdAt: stamp, updatedAt: stamp });
const user = { id: A, name: "Ana", email: "ana@example.test", role: "viewer" as const, active: true, createdAt: stamp, updatedAt: stamp };
const v2 = (id = A, section = "services") => `/workspaces/${id}/${section}`;
const v1 = (id = A, section = "services") => `/e/${id}/${section}`;
interface FakeState { workspaceStatus?: number; legacyStatus?: number; archived?: boolean; listIds?: string[]; listStatus?: number }

async function setup(page: Page, state: FakeState = {}) {
  const sent: string[] = [];
  await page.route(/^https?:\/\/[^/]+\/api\/v[12]\//, (route) => {
    const path = new URL(route.request().url()).pathname;
    sent.push(path);
    const json = (data: unknown, status = 200) => route.fulfill({ status, json: data });
    if (path === "/api/v1/auth/csrf") return json({ csrfToken: "csrf" });
    if (path === "/api/v2/workspace-creation-policy") return json({ mode: "restricted-request", creatorBecomesAdmin: false, updatedAt: null, updatedBy: null, workspacesMode: "disabled", stage: "dev", caller: { canCreate: false, canRequest: false, canDecide: false } });
    if (path === "/api/v2/workspaces") return json({ items: (state.listIds ?? [B]).map((id) => workspace(id)), nextCursor: null }, state.listStatus);
    if (path === "/api/v1/environments") return json({ items: [A, B].map(environment), nextCursor: null });
    if (path === "/api/v1/tokens") return json({ items: [], nextCursor: null });
    for (const id of [A, B]) {
      if (path === `/api/v2/workspaces/${id}`) return json(workspace(id, state.archived), state.workspaceStatus);
      if (path === `/api/v1/environments/${id}`) return json(environment(id), state.legacyStatus);
      if (path === `/api/v2/workspaces/${id}/services`) return json({ items: [service(id)], nextCursor: null });
      if (path === `/api/v2/workspaces/${id}/services/service-${id}`) return json(service(id));
      if (path === `/api/v2/workspaces/${id}/releases` || path === `/api/v2/workspaces/${id}/variables`) return json([]);
      if (path.startsWith(`/api/v2/workspaces/${id}/`)) return json({ items: [], nextCursor: null });
      if (path === `/api/v1/environments/${id}/analytics/summary`) return json({ title: "Analytics unavailable", status: 502 }, 502);
      if (path.startsWith(`/api/v1/environments/${id}/`)) return json({ items: [], nextCursor: null });
    }
    return json({ title: "Unexpected request", status: 404 }, 404);
  });
  await mockSession(page, user);
  await page.context().addCookies([{ name: "gromesh_session", value: "navigation-test", url: test.info().project.use.baseURL! }]);
  return sent;
}
async function audit(page: Page) {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(result.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);
}

for (const width of [390, 1440]) {
  test(`v2 deep link, refresh and same-namespace links at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const sent = await setup(page);
    const url = `${v2()}?x=1#y`;
    await page.goto(url);
    await expect(page.getByRole("link", { name: "Service A", exact: true })).toBeVisible();
    await openGateway(page);
    // A is authorized by its GET although it is not in the loaded list page.
    await expect(page.getByLabel("Workspace v2", { exact: true })).toHaveValue(A);
    await expect(page.getByLabel("Ambiente (legado)", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Publicação", exact: true, includeHidden: true })).toHaveCount(0);
    await expect(page).toHaveURL(url);
    await page.reload();
    await expect(page.getByRole("link", { name: "Service A", exact: true })).toBeVisible();
    await expect(page).toHaveURL(url);
    await audit(page);
    const closeGateway = page.getByRole("button", { name: "Fechar menu Gateway", exact: true });
    if (await closeGateway.isVisible()) await closeGateway.click();
    await page.getByRole("link", { name: "Service A", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Service A", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Routes do Workspace", exact: true })).toHaveAttribute("href", `${v2(A, "routes")}?serviceId=service-${A}`);
    expect(sent.some((p) => p.startsWith("/api/v1/environments"))).toBe(false);
  });

  test(`legacy deep link, refresh, redirect and analytics alias at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await setup(page, { listIds: [A, B] });
    await page.goto(`/e/${A}?x=1#y`);
    await expect(page).toHaveURL(`${v1()}?x=1#y`);
    await expect(page.getByRole("heading", { name: "Services", exact: true })).toBeVisible();
    const url = `${v1(A, "analytics")}?x#y`;
    await page.goto(url);
    await expect(page).toHaveURL(`${v1(A, "metrics")}?x#y`);
    await expect(page.getByRole("heading", { name: "Métricas", exact: true })).toBeVisible();
    await page.reload();
    await expect(page).toHaveURL(`${v1(A, "metrics")}?x#y`);
    await expect(page.getByRole("heading", { name: "Métricas", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Publicação", exact: true })).toBeVisible();
    await openGateway(page);
    await expect(page.getByLabel("Ambiente (legado)", { exact: true })).toHaveValue(A);
    await expect(page.getByRole("navigation", { name: "Menu principal" }).getByRole("link", { name: "Serviços", exact: true })).toHaveAttribute("href", v1());
    await audit(page);
  });

  for (const state of [
    { name: "403", options: { workspaceStatus: 403 }, text: "Você não tem permissão para acessar este contexto." },
    { name: "404", options: { workspaceStatus: 404 }, text: "Não encontrado ou indisponível para sua conta." },
    { name: "API failure", options: { workspaceStatus: 502 }, text: "Não foi possível verificar o contexto. Tente novamente." },
    { name: "archived", options: { archived: true }, text: "arquivado · somente leitura" },
    { name: "no Workspace", options: { listIds: [] }, text: "Nenhum Workspace disponível." },
  ]) {
    test(`${state.name} stays explicit with axe at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const sent = await setup(page, state.options);
      const url = state.name === "no Workspace" ? "/workspaces" : `${v2()}?x#y`;
      await page.goto(url);
      if (state.name === "archived") await openGateway(page);
      await expect(page.getByText(state.text, { exact: state.name !== "archived" })).toBeVisible();
      await expect(page).toHaveURL(url);
      if (state.name !== "archived" && state.name !== "no Workspace") {
        await expect(page.getByRole("link", { name: "Service A", exact: true })).toHaveCount(0);
        expect(sent).not.toContain(`/api/v2/workspaces/${A}/services`);
      }
      if (state.name === "archived") {
        const close = page.getByRole("button", { name: "Fechar menu Gateway", exact: true });
        if (await close.isVisible()) await close.click();
        await expect(page.getByRole("button", { name: "Novo service", exact: true })).toHaveCount(0);
      }
      await audit(page);
    });
  }

  test(`pending, network failure, unknown route and login states pass axe at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const sent = await setup(page);
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    await page.route(`**/api/v2/workspaces/${A}`, async (route) => { await ready; await route.abort("failed"); });
    await page.goto(v2());
    await expect(page.getByText("Verificando contexto…", { exact: true })).toBeVisible();
    await audit(page);
    release();
    await expect(page.getByRole("alert").filter({ hasText: "Não foi possível verificar o contexto." })).toBeVisible();
    expect(sent.some((p) => p.startsWith("/api/v1/environments"))).toBe(false);
    await audit(page);
    await page.goto(`${v2(A, "overview")}?x#y`);
    await expect(page.getByText("Rota não encontrada.", { exact: true })).toBeVisible();
    await expect(page).toHaveURL(`${v2(A, "overview")}?x#y`);
    await audit(page);
    await page.route(`**/api/v2/workspaces/${B}`, (route) => route.fulfill({ status: 401, json: { title: "Unauthorized", status: 401 } }));
    await page.goto(v2(B));
    await expect(page).toHaveURL("/login");
    await expect(page.getByRole("heading", { name: "Entrar", exact: true })).toBeVisible();
    await audit(page);
  });
}

const releaseV1 = { workspaceId: A, version: 1, contentDigest: `sha256:${"a".repeat(64)}`, origin: "local", contentOriginVersion: 1,
  contentFirstActivatedAt: null, originPromotionId: null, contentRevoked: false, createdAt: stamp, createdBy: { name: "Ana" }, message: "" };

for (const namespace of ["legacy", "v2"] as const) {
  for (const status of [403, 404]) {
    test(`${namespace} 200→${status} unmounts the authorized content without changing the URL`, async ({ page }) => {
      const sent = await setup(page);
      await mockSession(page, { ...user, role: "admin" });
      const url = `${namespace === "legacy" ? v1() : v2(A, "releases")}?x=1#y`;
      await page.goto(url);
      const content = namespace === "legacy" ? page.getByRole("link", { name: "Service A", exact: true }) : page.getByRole("heading", { name: "Releases", exact: true });
      await expect(content).toBeVisible();
      const endpoint = namespace === "legacy" ? `/api/v1/environments/${A}` : `/api/v2/workspaces/${A}`;
      let finish!: () => void;
      const held = new Promise<void>((resolve) => { finish = resolve; });
      let started!: () => void;
      const requested = new Promise<void>((resolve) => { started = resolve; });
      await page.route(`**${endpoint}`, async (route) => {
        started();
        await held;
        return route.fulfill({ status, json: { title: "Access refused", status } });
      });
      if (namespace === "v2") await page.route(`**/api/v2/workspaces/${A}/releases`, (route) => route.request().method() === "POST"
        ? route.fulfill({ status: 201, json: releaseV1 }) : route.fallback());
      try {
        await page.getByRole("button", { name: namespace === "legacy" ? "Novo service" : "Publicar release", exact: true }).click();
        if (namespace === "v2") await page.getByRole("button", { name: "Confirmar publicação", exact: true }).click();
        await requested;
        await expect(content).toBeVisible();
      } finally { finish(); }
      await expect(page.getByRole("alert").filter({ hasText: status === 403
        ? "Você não tem permissão para acessar este contexto." : "Não encontrado ou indisponível para sua conta." })).toBeVisible();
      await expect(content).toHaveCount(0);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page).toHaveURL(url);
      if (namespace === "v2") expect(sent.some((path) => path.startsWith("/api/v1/environments"))).toBe(false);
    });
  }
}

test("v2 publication confirmation survives pending and completed Workspace refresh", async ({ page }) => {
  await setup(page);
  await page.goto(v2(A, "releases"));
  await page.getByRole("button", { name: "Publicar release", exact: true }).click();
  let finish!: () => void;
  const held = new Promise<void>((resolve) => { finish = resolve; });
  let started!: () => void;
  const requested = new Promise<void>((resolve) => { started = resolve; });
  await page.route(`**/api/v2/workspaces/${A}`, async (route) => {
    started();
    await held;
    return route.fulfill({ json: { ...workspace(A), activeRelease: 1 } });
  });
  await page.route(`**/api/v2/workspaces/${A}/releases`, (route) => route.fulfill({
    status: route.request().method() === "POST" ? 201 : 200,
    json: route.request().method() === "POST" ? releaseV1 : [releaseV1],
  }));
  const confirmation = page.getByRole("status").filter({ hasText: "Release v1 publicada. Nenhum deployment foi criado." });
  try {
    await page.getByRole("button", { name: "Confirmar publicação", exact: true }).click();
    await requested;
    await expect(confirmation).toBeVisible();
    await expect(page.getByText("Verificando contexto…", { exact: true })).toHaveCount(0);
  } finally { finish(); }
  await expect(page.getByText("Release ativa: v1.", { exact: false })).toBeVisible();
  await expect(confirmation).toBeVisible();
});

test("back/forward preserve each URL; explicit A to B drops entity IDs and filters", async ({ page }) => {
  await setup(page, { listIds: [A, B] });
  const from = `${v2(A, `services/service-${A}`)}?x=1#y`;
  await page.goto(from);
  await expect(page.getByRole("heading", { name: "Service A", exact: true })).toBeVisible();
  await page.getByLabel("Workspace v2", { exact: true }).selectOption(B);
  await expect(page).toHaveURL(v2(B));
  await expect(page.getByRole("link", { name: "Service B", exact: true })).toBeVisible();
  await expect(page.locator("main")).not.toContainText("Service A");
  await page.goBack();
  await expect(page).toHaveURL(from);
  await expect(page.getByRole("heading", { name: "Service A", exact: true })).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(v2(B));
  await expect(page.getByRole("link", { name: "Service B", exact: true })).toBeVisible();
  await navigateGlobal(page, "Tokens de API");
  await expect(page.getByText("Escopo: minha conta nesta instância", { exact: true })).toBeVisible();
  await expect(page.locator("main")).not.toContainText("Service B");
  await expect(page.locator("nav a[href^='/workspaces/']")).toHaveCount(0);
});

test("late authorization and resources of A never enter B", async ({ page }) => {
  await setup(page, { listIds: [A, B] });
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  let delivered!: () => void;
  const delivery = new Promise<void>((resolve) => { delivered = resolve; });
  await page.route(`**/api/v2/workspaces/${A}`, async (route) => { await ready; await route.fulfill({ json: workspace(A) }).catch(() => {}); delivered(); });
  await page.goto(v2());
  await expect(page.getByText("Verificando contexto…", { exact: true })).toBeVisible();
  await page.getByLabel("Workspace v2", { exact: true }).selectOption(B);
  await expect(page.getByRole("link", { name: "Service B", exact: true })).toBeVisible();
  release();
  await delivery;
  await expect(page.locator("main")).not.toContainText("Service A");
  await expect(page.locator(".gateway-context")).toContainText("Workspace B");
  await page.unroute(`**/api/v2/workspaces/${A}`);
  let releaseServices!: () => void;
  const servicesReady = new Promise<void>((resolve) => { releaseServices = resolve; });
  let servicesDelivered!: () => void;
  const servicesDelivery = new Promise<void>((resolve) => { servicesDelivered = resolve; });
  await page.route(`**/api/v2/workspaces/${A}/services`, async (route) => { await servicesReady; await route.fulfill({ json: { items: [service(A)], nextCursor: null } }).catch(() => {}); servicesDelivered(); });
  await page.getByLabel("Workspace v2", { exact: true }).selectOption(A);
  await expect(page.locator(".gateway-context")).toContainText("Workspace A");
  await page.getByLabel("Workspace v2", { exact: true }).selectOption(B);
  await expect(page.getByRole("link", { name: "Service B", exact: true })).toBeVisible();
  releaseServices();
  await servicesDelivery;
  await expect(page.locator("main")).not.toContainText("Service A");
});

test("v2 failure never becomes legacy; legacy failure never selects a v2 Workspace", async ({ page }) => {
  const state: FakeState = { workspaceStatus: 404 };
  await setup(page, state);
  await page.goto(v2());
  await expect(page.getByText("Não encontrado ou indisponível para sua conta.", { exact: true })).toBeVisible();
  // This ID still has a valid v1 environment and its original v1 Overview.
  await page.goto(`${v1(A, "overview")}?x#y`);
  await expect(page.getByRole("heading", { name: "Visão geral", exact: true })).toBeVisible();
  await expect(page.getByLabel("Ambiente (legado)", { exact: true })).toHaveValue(A);
  state.workspaceStatus = 200;
  state.legacyStatus = 404;
  await page.goto(v1());
  await expect(page.getByText("Não encontrado ou indisponível para sua conta.", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Services", exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(v1());
  await page.goto(v2());
  await expect(page.getByRole("link", { name: "Service A", exact: true })).toBeVisible();
});

test("401 clears mounted data and existing login returns to pathname, query and hash", async ({ page }) => {
  const state: FakeState = {};
  await setup(page, state);
  await page.goto(v2());
  await expect(page.getByRole("link", { name: "Service A", exact: true })).toBeVisible();
  state.workspaceStatus = 401;
  await page.getByLabel("Workspace v2", { exact: true }).selectOption(B);
  await expect(page).toHaveURL("/login");
  await expect(page.locator("body")).not.toContainText("Service A");
  state.workspaceStatus = 200;
  await page.getByLabel("E-mail").fill(user.email);
  await page.getByLabel("Senha").fill("test-password");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page).toHaveURL(v2(B));
  await expect(page.getByRole("link", { name: "Service B", exact: true })).toBeVisible();
  state.workspaceStatus = 401;
  const target = `${v2()}?x=1#y`;
  await page.goto(target);
  await expect(page).toHaveURL("/login");
  state.workspaceStatus = 200;
  await page.getByLabel("E-mail").fill(user.email);
  await page.getByLabel("Senha").fill("test-password");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page).toHaveURL(target);
  await expect(page.getByRole("link", { name: "Service A", exact: true })).toBeVisible();
});
