import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, mockSession, test } from "./fixtures";
import { checkLayout } from "./layout";
import { openGateway } from "./gateway-sidebar";

const A = "7c1d2e3f-4a5b-4c6d-8e7f-00000000000a";
const B = "7c1d2e3f-4a5b-4c6d-8e7f-00000000000b";
const S = "9c1d2e3f-4a5b-4c6d-8e7f-000000000001";
const stamp = "2026-11-03T12:00:00Z";
const longName = "nome-sem-espacos-".repeat(10);
const workspace = (id: string, archived = false) => ({ id, key: id, name: `Workspace ${id === A ? "A" : "B"} ${longName}`, slug: id === A ? "alpha" : "beta", status: archived ? "archived" : "active", activeRelease: null });
const environment = (id: string) => ({ id, name: `Legado ${id === A ? "A" : "B"}`, publishMode: "manual", hasUnpublishedChanges: false, currentVersion: null, createdAt: stamp, updatedAt: stamp });
const service = (id: string) => ({ id: S, workspaceId: id, upstreamId: null, name: `Serviço ${id === A ? "A" : "B"} <interno> ${longName}`, protocol: "http", host: "echo.internal", port: 80, path: null, enabled: true, tags: [], createdAt: stamp, updatedAt: stamp });
const path = (id = A) => `/workspaces/${id}/services`;
const trail = (page: Page) => page.getByRole("navigation", { name: "Trilha", exact: true });
interface State { status?: number; archived?: boolean; empty?: boolean; pendingDraft?: boolean }

async function setup(page: Page, state: State = {}) {
  const requests: string[] = [];
  await page.route(/^https?:\/\/[^/]+\/api\/v[12]\//, (route) => {
    const url = new URL(route.request().url());
    requests.push(`${route.request().method()} ${url.pathname}`);
    const json = (data: unknown, status = 200) => route.fulfill({ status, json: data });
    if (url.pathname === "/api/v1/auth/csrf") return json({ csrfToken: "csrf" });
    if (url.pathname === "/api/v2/workspace-creation-policy") return json({ mode: "restricted-request", creatorBecomesAdmin: false, updatedAt: null, updatedBy: null, workspacesMode: "disabled", stage: "dev", caller: { canCreate: false, canRequest: false, canDecide: false } });
    if (url.pathname === "/api/v1/environments") return json({ items: [A, B].map(environment), nextCursor: null });
    if (url.pathname === "/api/v2/workspaces") return json({ items: state.empty ? [] : [A, B].map((id) => workspace(id, state.archived)), nextCursor: null });
    if (url.pathname === "/api/v1/tokens") return json({ items: [], nextCursor: null });
    for (const id of [A, B]) {
      if (url.pathname === `/api/v2/workspaces/${id}`) return state.status
        ? json({ title: "Failure", status: state.status }, state.status) : json(workspace(id, state.archived));
      if (url.pathname === `/api/v1/environments/${id}`) return json({ ...environment(id), hasUnpublishedChanges: state.pendingDraft ?? false });
      if (url.pathname === `/api/v1/environments/${id}/publish-preview`) return json({ currentVersion: null, hasChanges: true, changes: [] });
      if ([`/api/v2/workspaces/${id}/services`, `/api/v1/environments/${id}/services`].includes(url.pathname)) return json({ items: state.empty ? [] : [service(id)], nextCursor: null });
      if ([`/api/v2/workspaces/${id}/services/${S}`, `/api/v1/environments/${id}/services/${S}`].includes(url.pathname)) return json(service(id));
      if (url.pathname === `/api/v2/workspaces/${id}/releases`) return json([]);
      if (url.pathname === `/api/v2/workspaces/${id}/variables`) return json([]);
      if (["routes", "consumers", "plugins", "upstreams", "certificates"].some((section) => url.pathname === `/api/v2/workspaces/${id}/${section}`)
        || url.pathname === `/api/v1/environments/${id}/clusters`) return json({ items: [], nextCursor: null });
      if (url.pathname === `/api/v2/workspaces/${id}/consumers/${S}`) return json({ id: S, username: `Cliente ${id === A ? "A" : "B"}`, customId: null, tags: [], createdAt: stamp, updatedAt: stamp });
      if (["key-auth", "jwt", "basic-auth"].some((kind) => url.pathname === `/api/v2/workspaces/${id}/consumers/${S}/${kind}`)) return json({ items: [], nextCursor: null });
    }
    return json({ title: `Unexpected request: ${url.pathname}`, status: 404 }, 404);
  });
  await mockSession(page, { id: A, name: "Ana", email: "ana@example.test", role: "admin", active: true, createdAt: stamp, updatedAt: stamp });
  await page.context().addCookies([{ name: "gromesh_session", value: "breadcrumbs-test", url: test.info().project.use.baseURL! }]);
  return requests;
}

async function audit(page: Page) {
  await checkLayout(page);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await trail(page).evaluate((nav) => nav.scrollWidth <= nav.clientWidth)).toBe(true);
}

for (const width of [390, 768, 1440]) {
  test(`integrated catalog breadcrumbs and Consumer detail at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const requests = await setup(page);
    for (const [section, label] of [
      ["overview", "Visão geral"], ["services", "Serviços"], ["routes", "Rotas"],
      ["consumers", "Consumidores"], ["plugins", "Plugins"], ["upstreams", "Upstreams"],
      ["certificates", "Certificados"], ["variables", "Variáveis"], ["releases", "Releases"],
    ]) {
      await page.goto(`/workspaces/${A}/${section}?view=integration#page`);
      await expect(trail(page).locator("li")).toHaveText(section === "overview"
        ? ["Visão geral da instância", workspace(A).name] : ["Visão geral da instância", workspace(A).name, label!]);
      await expect(trail(page).locator('[aria-current="page"]')).toHaveText(section === "overview" ? workspace(A).name : label!);
      const menu = await openGateway(page);
      await expect(menu.getByRole("link")).toHaveCount(9);
      if (section === "releases") await expect(menu.getByRole("link", { name: "Releases e implantação", exact: true })).toHaveAttribute("aria-current", "page");
      else await expect(menu.getByRole("link", { name: label, exact: true })).toHaveAttribute("aria-current", "page");
      const close = page.getByRole("button", { name: "Fechar menu Gateway", exact: true });
      if (await close.isVisible()) await close.click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    await page.goto(`/workspaces/${A}/consumers/${S}?view=detail#credentials`);
    await expect(trail(page).locator("li")).toHaveText(["Visão geral da instância", workspace(A).name, "Consumidores", "Cliente A"]);
    await audit(page);
    await page.reload();
    await expect(trail(page).locator('[aria-current="page"]')).toHaveText("Cliente A");
    await trail(page).getByRole("link", { name: "Consumidores", exact: true }).click();
    await expect(page).toHaveURL(`/workspaces/${A}/consumers`);
    expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
    expect(requests.some((request) => request.startsWith("GET /api/v1/environments/"))).toBe(false);
  });

  test(`detail deep link, refresh, history and breadcrumb links at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const requests = await setup(page);
    const url = `${path()}/${S}?view=details#resource`;
    await page.goto(url);
    await expect(trail(page).locator('[aria-current="page"]')).toHaveText(service(A).name);
    await expect(trail(page).getByRole("link", { name: workspace(A).name, exact: true, includeHidden: true })).toHaveAttribute("href", `/workspaces/${A}`);
    await expect(trail(page).locator("li")).toHaveCount(4);
    if (width === 390) {
      await expect(trail(page).getByRole("link", { name: "Visão geral da instância", exact: true })).toBeHidden();
      await expect(trail(page).getByRole("link", { name: workspace(A).name, exact: true })).toBeHidden();
    }
    await expect(page).toHaveURL(url);
    await audit(page);
    await page.reload();
    await expect(trail(page).locator('[aria-current="page"]')).toHaveText(service(A).name);
    await expect(page).toHaveURL(url);
    await audit(page);
    await trail(page).getByRole("link", { name: "Serviços", exact: true }).click();
    await expect(page).toHaveURL(path());
    await expect(trail(page).locator('[aria-current="page"]')).toHaveText("Serviços");
    await audit(page);
    await page.goBack();
    await expect(page).toHaveURL(url);
    await expect(trail(page).locator('[aria-current="page"]')).toHaveText(service(A).name);
    await page.goForward();
    await expect(page).toHaveURL(path());
    await expect(trail(page).locator('[aria-current="page"]')).toHaveText("Serviços");
    await trail(page).getByRole("link", { name: workspace(A).name, exact: true }).click();
    await expect(page).toHaveURL(`/workspaces/${A}/overview`);
    await expect(trail(page).locator('[aria-current="page"]')).toHaveText(workspace(A).name);
    await trail(page).getByRole("link", { name: "Visão geral da instância", exact: true }).click();
    await expect(page).toHaveURL("/");
    await expect(trail(page).locator("li")).toHaveCount(1);
    expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
    expect(requests.some((request) => request.startsWith("GET /api/v1/environments/"))).toBe(false);
  });

  test(`legacy and global breadcrumbs at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await setup(page);
    await page.goto(`/e/${A}/services/${S}`);
    await expect(trail(page).locator('[aria-current="page"]')).toHaveText(service(A).name);
    await expect(trail(page).getByRole("link", { name: "Ambiente (legado) Legado A", exact: true, includeHidden: true })).toHaveAttribute("href", `/e/${A}`);
    await audit(page);
    await page.reload();
    await expect(trail(page).locator('[aria-current="page"]')).toHaveText(service(A).name);
    await trail(page).getByRole("link", { name: "Serviços", exact: true }).click();
    await expect(page).toHaveURL(`/e/${A}/services`);
    await expect(trail(page).locator('[aria-current="page"]')).toHaveText("Serviços");
    await trail(page).getByRole("link", { name: "Ambiente (legado) Legado A", exact: true }).click();
    await expect(page).toHaveURL(`/e/${A}/services`);
    await page.goto("/tokens");
    await expect(trail(page).locator("li")).toHaveText(["Tokens de API"]);
    await expect(trail(page).getByRole("link")).toHaveCount(0);
    await audit(page);
  });

  test(`instance has exactly one petroleum action with AA contrast at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await setup(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Visão geral da instância", exact: true })).toBeVisible();
    const primary = page.getByRole("link", { name: "Gerenciar Workspaces", exact: true });
    await expect(primary).toHaveAttribute("href", "/workspaces");
    const accented = await page.locator('main button, main a.button').evaluateAll((elements) => elements.filter((el) => {
      const style = getComputedStyle(el);
      const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
      const probe = document.createElement("span"); probe.style.color = accent; document.body.append(probe);
      const color = getComputedStyle(probe).color; probe.remove();
      return style.backgroundColor === color;
    }).map((el) => el.textContent?.trim()));
    expect(accented).toEqual(["Gerenciar Workspaces"]);
    await expect(primary).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect(primary).toHaveCSS("background-color", "rgb(10, 108, 102)");
    await audit(page); // Includes axe color-contrast on the actual primary link.
    await primary.hover();
    await expect(primary).toHaveCSS("background-color", "rgb(8, 86, 80)");
    await audit(page);
    await primary.click();
    await expect(page).toHaveURL("/workspaces");
    await expect(trail(page).locator("li")).toHaveText(["Workspaces"]);
  });

  for (const status of [403, 404]) {
    test(`A to denied B (${status}) and denied cached A do not leak names at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const state: State = {};
      await setup(page, state);
      await page.goto(`${path()}/${S}`);
      await expect(trail(page).locator('[aria-current="page"]')).toHaveText(service(A).name);
      state.status = status;
      await openGateway(page);
      await page.getByLabel("Workspace v2", { exact: true }).selectOption(B);
      await expect(page.getByRole("alert")).toContainText(status === 403 ? "Você não tem permissão" : "Não encontrado ou indisponível");
      await expect(trail(page).locator("li")).toHaveText(["Visão geral da instância", "Serviços"]);
      await expect(trail(page)).not.toContainText(workspace(A).name);
      await expect(trail(page)).not.toContainText(workspace(B).name);
      await audit(page);
      await page.goBack();
      await expect(page).toHaveURL(`${path()}/${S}`);
      await expect(page.getByRole("alert")).toContainText(status === 403 ? "Você não tem permissão" : "Não encontrado ou indisponível");
      await expect(trail(page).locator("li")).toHaveText(["Visão geral da instância", "Serviços", "Serviço"]);
      await expect(trail(page).locator("a")).toHaveCount(1);
      await audit(page);
    });
  }
}

test("pending B discards A before authorization; a late A resource cannot rename B", async ({ page }) => {
  await setup(page);
  let finishA!: () => void;
  const pendingA = new Promise<void>((resolve) => { finishA = resolve; });
  await page.route(`**/api/v2/workspaces/${A}/services/${S}`, async (route) => { await pendingA; await route.fulfill({ json: service(A) }).catch(() => {}); });
  let finishB!: () => void;
  const pendingB = new Promise<void>((resolve) => { finishB = resolve; });
  await page.route(`**/api/v2/workspaces/${B}`, async (route) => { await pendingB; await route.fulfill({ json: workspace(B) }); });
  await page.goto(`${path()}/${S}`);
  await expect(trail(page).locator('[aria-current="page"]')).toHaveText("Serviço");
  await expect(trail(page)).toContainText(workspace(A).name);
  await openGateway(page);
  await page.getByLabel("Workspace v2", { exact: true }).selectOption(B);
  await expect(page.getByText("Verificando contexto…", { exact: true })).toBeVisible();
  await expect(trail(page).locator("li")).toHaveText(["Visão geral da instância", "Serviços"]);
  finishA(); finishB();
  await expect(trail(page)).toContainText(workspace(B).name);
  await expect(trail(page)).not.toContainText(workspace(A).name);
  await expect(trail(page)).not.toContainText(service(A).name);
  await page.getByRole("link", { name: service(B).name, exact: true }).click();
  await expect(trail(page).locator('[aria-current="page"]')).toHaveText(service(B).name);
});

test("archived and empty contexts keep readable trails; 401 follows login", async ({ page }) => {
  const state: State = { archived: true, empty: true };
  await setup(page, state);
  await page.goto(path());
  await expect(trail(page)).toContainText(workspace(A).name);
  await expect(page.getByText("Nenhum serviço ainda.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Novo serviço", exact: true })).toHaveCount(0);
  await audit(page);
  state.status = 401;
  await page.reload();
  await expect(page).toHaveURL("/login");
  await expect(trail(page)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Entrar", exact: true })).toBeVisible();
});

test("publication review and Release confirmation expose only one accented action", async ({ page }) => {
  await setup(page, { pendingDraft: true });
  await page.goto(`/e/${A}/publish`);
  await expect(page.getByRole("heading", { name: "Revisar snapshot (legado)", exact: true })).toBeVisible();
  await expect(page.locator("main button.publish")).toHaveCount(1);
  await expect(page.locator(".publish-box button.publish")).toBeVisible();
  await page.goto(`/workspaces/${A}/releases`);
  await page.getByRole("button", { name: "Publicar release", exact: true }).click();
  await expect(page.locator("main button.publish")).toHaveCount(1);
  await expect(page.getByRole("dialog").getByRole("button", { name: "Confirmar publicação", exact: true })).toHaveClass("publish");
  await page.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(page.locator("main button.publish")).toHaveText("Publicar release");
});
