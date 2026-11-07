import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, mockSession, test } from "./fixtures";
import { openGateway } from "./gateway-sidebar";
import { navigateGlobal, openGlobalMenu } from "./global-navigation";

const W = "7c1d2e3f-4a5b-4c6d-8e7f-00000000000a";
const E = "7c1d2e3f-4a5b-4c6d-8e7f-00000000000b";
const S = "7c1d2e3f-4a5b-4c6d-8e7f-00000000000c";
const stamp = "2026-11-03T12:00:00Z";
const workspace = (id: string, archived = false) => ({ id, key: id, name: id === W ? "Pedidos autorizados" : "Outro Workspace", slug: id === W ? "pedidos" : "outro", status: archived ? "archived" : "active", activeRelease: null });
const environment = { id: E, name: "Ambiente autorizado", publishMode: "manual", hasUnpublishedChanges: false, currentVersion: null, createdAt: stamp, updatedAt: stamp };
const service = (id: string) => ({ id: S, workspaceId: id, name: "Serviço autorizado", upstreamId: null, host: "echo.internal", protocol: "http", port: 80, path: null, enabled: true, tags: [], createdAt: stamp, updatedAt: stamp });
const v2 = (section = "services") => `/workspaces/${W}/${section}`;
const v1 = (section = "services") => `/e/${E}/${section}`;
const nav = (page: Page) => page.getByRole("navigation", { name: "Menu principal", exact: true });
const trigger = (page: Page) => page.getByRole("button", { name: /^Abrir menu Gateway · /, includeHidden: true });
const drawer = (page: Page) => page.getByRole("dialog", { name: /^Navegação Gateway do / });

interface State { status?: number; archived?: boolean }
async function setup(page: Page, state: State = {}) {
  const sent: string[] = [];
  await page.route(/^https?:\/\/[^/]+\/api\/v[12]\//, (route) => {
    const path = new URL(route.request().url()).pathname;
    sent.push(path);
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: status >= 400 ? { title: "Unavailable", status } : body });
    if (path === "/api/v1/auth/csrf") return json({ csrfToken: "csrf" });
    if (path === "/api/v2/workspace-creation-policy") return json({ mode: "restricted-request", creatorBecomesAdmin: false, updatedAt: null, updatedBy: null, workspacesMode: "disabled", stage: "dev", caller: { canCreate: false, canRequest: false, canDecide: false } });
    if (path === "/api/v2/workspaces") return json({ items: [workspace(E)], nextCursor: null });
    if (path === "/api/v1/environments") return json({ items: [environment], nextCursor: null });
    if (path === `/api/v1/environments/${E}`) return json(environment, state.status);
    if (path === "/api/v1/users/me/tokens" || path === "/api/v1/tokens" || path === "/api/v1/users" || path === "/api/v1/audit-events") return json({ items: [], nextCursor: null });
    for (const id of [W, E]) {
      if (path === `/api/v2/workspaces/${id}`) return json(workspace(id, state.archived), state.status);
      if (path === `/api/v2/workspaces/${id}/services`) return json({ items: [service(id)], nextCursor: null });
      if (path === `/api/v2/workspaces/${id}/services/${S}`) return json(service(id));
      if (path === `/api/v2/workspaces/${id}/consumers/${S}`) return json({ id: S, environmentId: id, username: "Consumidor autorizado", customId: null, tags: [], createdAt: stamp, updatedAt: stamp });
      if (path === `/api/v2/workspaces/${id}/releases` || path === `/api/v2/workspaces/${id}/variables`) return json([]);
      if (path.startsWith(`/api/v2/workspaces/${id}/`)) return json({ items: [], nextCursor: null });
    }
    if (path === `/api/v1/environments/${E}/consumers/${S}`) return json({ id: S, environmentId: E, username: "Consumidor autorizado", customId: null, tags: [], createdAt: stamp, updatedAt: stamp });
    if (path.startsWith(`/api/v1/environments/${E}/`)) return json({ items: [], nextCursor: null });
    return json({}, 404);
  });
  await mockSession(page, { id: W, name: "Ana", email: "ana@example.test", role: "admin", active: true, createdAt: stamp, updatedAt: stamp });
  await page.context().addCookies([{ name: "gromesh_session", value: "sidebar", url: test.info().project.use.baseURL! }]);
  return sent;
}
async function fits(page: Page) {
  const layout = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    overflowing: Array.from(document.querySelectorAll("body *")).flatMap((node) => {
      const { left, right, width } = node.getBoundingClientRect();
      return width > 0 && (width > innerWidth || right > innerWidth)
        ? [{ element: `${node.tagName.toLowerCase()}.${Array.from(node.classList).join(".")}`, left, right, width }]
        : [];
    }),
  }));
  expect(layout.scrollWidth, JSON.stringify(layout.overflowing)).toBeLessThanOrEqual(page.viewportSize()!.width);
}
async function audit(page: Page) {
  await fits(page);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
}

test("v2 catalog uses confirmed GET outside the list; collapse preserves accessible links, tooltip and detail parent", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const sent = await setup(page);
  await page.goto(v2(`services/${S}`));
  await expect(page.getByRole("heading", { name: "Serviço autorizado", exact: true })).toBeVisible();
  await expect(page.locator(".gateway-context")).toContainText("Pedidos autorizados");
  await expect(page.locator(".gateway-context")).toContainText("/pedidos · ativo");
  const links = nav(page).getByRole("link");
  await expect(links).toHaveCount(9);
  for (const [label, path] of [["Visão geral", "overview"], ["Serviços", "services"], ["Rotas", "routes"], ["Consumidores", "consumers"], ["Plugins", "plugins"], ["Upstreams", "upstreams"], ["Certificados", "certificates"], ["Variáveis", "variables"]]) {
    const link = nav(page).getByRole("link", { name: label!, exact: true });
    await expect(link).toHaveAttribute("href", v2(path));
    await expect(link).not.toHaveAttribute("aria-disabled");
    if (path !== "services") await expect(link).not.toHaveAttribute("aria-current");
  }
  await expect(nav(page).getByRole("link", { name: "Serviços", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(nav(page).getByRole("link", { name: "Releases", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Voltar à visão geral da instância", exact: true })).toHaveAttribute("href", "/");
  await audit(page);
  await testInfo.attach("gateway-expanded", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  const collapse = page.getByRole("button", { name: "Recolher menu Gateway", exact: true });
  await collapse.click();
  await expect(page.getByRole("button", { name: "Expandir menu Gateway", exact: true })).toBeFocused();
  await expect(page.getByRole("button", { name: "Expandir menu Gateway", exact: true })).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".gateway-desktop")).toHaveCSS("width", "136px");
  const services = nav(page).getByRole("link", { name: "Serviços", exact: true });
  await services.focus();
  await expect(nav(page).getByRole("tooltip", { name: "Serviços", exact: true })).toBeVisible();
  await audit(page);
  await testInfo.attach("gateway-collapsed", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  await services.press("Escape");
  await expect(nav(page).getByRole("tooltip", { name: "Serviços", exact: true })).toBeHidden();
  const certificates = nav(page).getByRole("link", { name: "Certificados", exact: true });
  await certificates.click();
  await expect(page).toHaveURL(v2("certificates"));
  await expect(page.getByRole("heading", { level: 1, name: "Certificados", exact: true })).toBeVisible();
  await expect(certificates).toHaveAttribute("aria-current", "page");
  await expect(services).not.toHaveAttribute("aria-current");
  await expect(nav(page).locator('[aria-current="page"]')).toHaveCount(1);
  const upstreams = nav(page).getByRole("link", { name: "Upstreams", exact: true });
  await expect(upstreams).not.toHaveAttribute("aria-disabled");
  await upstreams.click();
  await expect(page).toHaveURL(v2("upstreams"));
  await expect(page.getByRole("heading", { level: 1, name: "Upstreams", exact: true })).toBeVisible();
  await expect(upstreams).toHaveAttribute("aria-current", "page");
  await expect(services).not.toHaveAttribute("aria-current");
  await expect(nav(page).locator('[aria-current="page"]')).toHaveCount(1);
  await expect(page.locator(".gateway-desktop")).toHaveCSS("width", "136px");
  await page.getByRole("button", { name: "Expandir menu Gateway", exact: true }).click();
  await expect(page.locator(".gateway-desktop")).toHaveCSS("width", "200px");
  await expect(upstreams).toHaveAttribute("aria-current", "page");
  const consumers = nav(page).getByRole("link", { name: "Consumidores", exact: true });
  await expect(consumers).toHaveAttribute("href", v2("consumers"));
  await expect(consumers).not.toHaveAttribute("aria-disabled");
  await consumers.click();
  await expect(page).toHaveURL(v2("consumers"));
  await expect(consumers).toHaveAttribute("aria-current", "page");
  await page.goto(v2(`consumers/${S}`));
  await expect(page.getByRole("heading", { name: "Consumidor Consumidor autorizado", exact: true })).toBeVisible();
  await expect(consumers).toHaveAttribute("href", v2("consumers"));
  await expect(consumers).toHaveAttribute("aria-current", "page");
  await expect(nav(page).locator('[aria-current="page"]')).toHaveCount(1);
  const overview = nav(page).getByRole("link", { name: "Visão geral", exact: true });
  await overview.click();
  await expect(page).toHaveURL(v2("overview"));
  await expect(page.getByRole("heading", { name: "Visão geral do Workspace", exact: true })).toBeVisible();
  await expect(overview).toHaveAttribute("href", v2("overview"));
  await expect(overview).toHaveAttribute("aria-current", "page");
  await expect(overview).not.toHaveAttribute("aria-disabled");
  await expect(services).not.toHaveAttribute("aria-current");
  expect(sent.some((p) => p.startsWith("/api/v1/environments"))).toBe(false);
  await navigateGlobal(page, "Releases");
  await expect(nav(page).getByRole("link", { name: "Releases e implantação", exact: true })).toHaveAttribute("aria-current", "page");
});

test("desktop sidebar keeps collapse and instance return in the viewport while scrolling a long page", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1200 });
  await setup(page);
  await page.route(`**/api/v2/workspaces/${W}/services`, (route) => route.fulfill({ json: {
    items: Array.from({ length: 40 }, (_, index) => ({
      ...service(W), id: `7c1d2e3f-4a5b-4c6d-8e7f-${String(index + 1).padStart(12, "0")}`, name: `Serviço ${index + 1}`,
    })),
    nextCursor: null,
  } }));
  await page.goto(v2());
  await expect(page.getByRole("link", { name: "Serviço 40", exact: true })).toBeAttached();
  const collapse = page.getByRole("button", { name: "Recolher menu Gateway", exact: true });
  const home = page.getByRole("link", { name: "Voltar à visão geral da instância", exact: true });
  await page.evaluate(() => window.scrollTo(0, innerHeight));
  await expect(collapse).toBeInViewport({ ratio: 1 });
  await expect(home).toBeInViewport({ ratio: 1 });
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(1200);
  await expect.poll(() => page.evaluate(() => Math.ceil(window.scrollY + innerHeight) >= document.documentElement.scrollHeight)).toBe(true);
  await expect(collapse).toBeInViewport({ ratio: 1 });
  await expect(home).toBeInViewport({ ratio: 1 });
});

test("legacy catalog stays in /e, consumer detail selects parent, Workspace selector enters v2", async ({ page }) => {
  const sent = await setup(page);
  await page.goto(v1(`consumers/${S}`));
  await expect(page.getByRole("heading", { name: "Consumidor Consumidor autorizado", exact: true })).toBeVisible();
  await expect(page.locator(".gateway-context")).toContainText("Ambiente (legado)");
  const sections = ["overview", "services", "routes", "consumers", "plugins", "upstreams", "certificates", "variables", "releases"];
  expect(await nav(page).locator("a").evaluateAll((nodes) => nodes.map((n) => n.getAttribute("href")))).toEqual(sections.map(v1));
  await expect(nav(page).getByRole("link", { name: "Consumidores", exact: true })).toHaveAttribute("aria-current", "page");
  expect(sent).not.toContain(`/api/v2/workspaces/${E}`);
  await nav(page).getByRole("link", { name: "Serviços", exact: true }).click();
  await expect(page.getByLabel("Workspace v2", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Workspace v2", { exact: true }).locator('option[value=""]')).toHaveText("Abrir um Workspace v2…");
  await expect(page.getByLabel("Ambiente (legado)", { exact: true })).toHaveValue(E);
  await expect(page.getByRole("link", { name: "Ir para Workspaces", exact: true })).toHaveCount(0);
  await page.getByLabel("Workspace v2", { exact: true }).selectOption(E);
  await expect(page).toHaveURL(`/workspaces/${E}/services`);
  await expect(nav(page).locator('a[href^="/e/"]')).toHaveCount(0);
});

for (const path of ["/tokens", "/users", "/audit", "/workspaces"]) {
  test(`no Gateway or implicit selection at ${path}`, async ({ page }) => {
    await setup(page);
    await page.goto(v2());
    await expect(nav(page)).toBeVisible();
    await page.goto(path);
    await expect(page.locator("main h1")).toBeVisible();
    await expect(nav(page)).toHaveCount(0);
    await expect(trigger(page)).toHaveCount(0);
    await expect(page.locator(".gateway-context")).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Navegação global", exact: true })).toBeVisible();
  });
}

for (const namespace of ["v2", "v1"] as const) {
  for (const status of [403, 404]) {
    test(`${namespace}: access loss ${status} clears previous context`, async ({ page }) => {
      const state: State = {};
      await setup(page, state);
      await page.goto(namespace === "v2" ? v2() : v1());
      await expect(nav(page)).toBeVisible();
      await navigateGlobal(page, "Tokens de API");
      await expect(page).toHaveURL("/tokens");
      await expect(page.getByRole("heading", { name: "Tokens de API", exact: true })).toBeVisible();
      await expect(nav(page)).toHaveCount(0);
      state.status = status;
      await page.goBack();
      await expect(page.getByRole("alert").first()).toBeVisible();
      await expect(nav(page)).toHaveCount(0);
      await expect(page.locator(".gateway-context")).toHaveCount(0);
      await expect(page.locator(".gateway-desktop")).toHaveCount(0);
    });
  }
}

test("archived Workspace keeps navigation readable and existing write gates", async ({ page }) => {
  await setup(page, { archived: true });
  await page.goto(v2());
  await expect(page.locator(".gateway-context")).toContainText("arquivado · somente leitura");
  await expect(nav(page).locator("a")).toHaveCount(9);
  await expect(page.getByRole("button", { name: "Novo serviço", exact: true })).toHaveCount(0);
  const certificates = nav(page).getByRole("link", { name: "Certificados", exact: true });
  await expect(certificates).toHaveAttribute("href", v2("certificates"));
  await expect(certificates).not.toHaveAttribute("aria-disabled");
  await certificates.click();
  await expect(page).toHaveURL(v2("certificates"));
  await expect(page.getByRole("heading", { level: 1, name: "Certificados", exact: true })).toBeVisible();
  await expect(certificates).toHaveAttribute("aria-current", "page");
  await expect(nav(page).locator('[aria-current="page"]')).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Novo certificado", exact: true })).toHaveCount(0);
  const upstreams = nav(page).getByRole("link", { name: "Upstreams", exact: true });
  await expect(upstreams).toHaveAttribute("href", v2("upstreams"));
  await expect(upstreams).not.toHaveAttribute("aria-disabled");
  await upstreams.click();
  await expect(page).toHaveURL(v2("upstreams"));
  await expect(page.getByRole("heading", { level: 1, name: "Upstreams", exact: true })).toBeVisible();
  await expect(upstreams).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("button", { name: "Novo upstream", exact: true })).toHaveCount(0);
  const consumers = nav(page).getByRole("link", { name: "Consumidores", exact: true });
  await expect(consumers).toHaveAttribute("href", v2("consumers"));
  await expect(consumers).not.toHaveAttribute("aria-disabled");
  await consumers.click();
  await expect(page).toHaveURL(v2("consumers"));
  await expect(consumers).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("button", { name: "Novo consumidor", exact: true })).toHaveCount(0);
  const overview = nav(page).getByRole("link", { name: "Visão geral", exact: true });
  await expect(overview).toHaveAttribute("href", v2("overview"));
  await overview.click();
  await expect(page).toHaveURL(v2("overview"));
  await expect(overview).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".gateway-context")).toContainText("arquivado · somente leitura");
  await expect(page.getByRole("link", { name: "Novo serviço", exact: true })).toHaveCount(0);
});

for (const width of [390, 768]) {
  test(`drawer at ${width}: inert background, Tab trap, close/Escape/backdrop, navigation and axe`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await setup(page);
    await page.goto(v2());
    await expect(trigger(page)).toHaveAccessibleName("Abrir menu Gateway · Pedidos autorizados — Workspace");
    await expect(trigger(page)).toHaveText("Gateway · Pedidos autorizados");
    await expect(trigger(page)).toHaveAttribute("aria-expanded", "false");
    await expect(nav(page)).toHaveCount(0);
    await audit(page);
    await openGlobalMenu(page, "Operações");
    const panelBox = (await page.getByRole("region", { name: "Operações", exact: true }).boundingBox())!;
    const triggerBox = (await trigger(page).boundingBox())!;
    expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(triggerBox.y);
    await openGateway(page);
    const close = drawer(page).getByRole("button", { name: "Fechar menu Gateway", exact: true });
    await expect(close).toBeFocused();
    await expect(trigger(page)).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".global-operations > button")).toHaveAttribute("aria-expanded", "false");
    await page.locator("main").evaluate((node: HTMLElement) => node.focus());
    await expect(close).toBeFocused();
    const home = drawer(page).getByRole("link", { name: "Voltar à visão geral da instância", exact: true });
    await close.press("Shift+Tab");
    await expect(home).toBeFocused();
    await home.press("Tab");
    await expect(close).toBeFocused();
    await expect(page.locator("body")).toHaveCSS("overflow", "hidden");
    await audit(page);
    await testInfo.attach(`gateway-drawer-${width}`, { body: await page.screenshot(), contentType: "image/png" });
    await close.press("Escape");
    await expect(drawer(page)).toHaveCount(0);
    await expect(trigger(page)).toBeFocused();
    await openGateway(page);
    await page.mouse.click(width - 8, 200);
    await expect(drawer(page)).toHaveCount(0);
    await expect(trigger(page)).toBeFocused();
    await openGateway(page);
    await drawer(page).getByRole("button", { name: "Fechar menu Gateway", exact: true }).click();
    await expect(trigger(page)).toBeFocused();
    await openGateway(page);
    await nav(page).getByRole("link", { name: "Rotas", exact: true }).click();
    await expect(page).toHaveURL(v2("routes"));
    await expect(drawer(page)).toHaveCount(0);
    await expect(page.locator("main")).toBeFocused();
    await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
    await fits(page);
  });
}

test("CSS releases the desktop column before the Gateway media change handler runs", async ({ page }) => {
  await page.addInitScript(() => {
    const matchMedia = window.matchMedia.bind(window);
    window.matchMedia = (query) => {
      const media = matchMedia(query);
      // Hold only the Gateway's React notification; native CSS still follows the real viewport.
      if (query === "(max-width: 900px)") media.addEventListener("change", (event) => event.stopImmediatePropagation());
      return media;
    };
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await setup(page);
  await page.goto(v2());
  await expect(page.getByRole("heading", { name: "Serviços", exact: true })).toBeVisible();
  for (const collapsed of [false, true]) {
    if (collapsed) await page.getByRole("button", { name: "Recolher menu Gateway", exact: true }).click();
    for (const width of [900, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.locator(".gateway-desktop")).toHaveCount(1);
      await expect(page.locator(".gateway-desktop")).toBeHidden();
      await expect(page.locator("main")).toHaveCSS("width", `${width}px`);
      await fits(page);
    }
    await page.setViewportSize({ width: 901, height: 900 });
    await expect(page.locator(".gateway-desktop")).toBeVisible();
    await expect(page.locator(".gateway-desktop")).toHaveCSS("width", collapsed ? "136px" : "200px");
    await fits(page);
  }
});

test("resize 900/901 remembers focused item, closes drawer, restores desktop match and frees background", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await setup(page);
  await page.goto(v2());
  const service = () => nav(page).getByRole("link", { name: "Serviços", exact: true });
  await service().focus();
  await page.setViewportSize({ width: 900, height: 900 });
  await expect(trigger(page)).toBeFocused();
  await expect(nav(page)).toHaveCount(0);
  await openGateway(page);
  await service().focus();
  await page.setViewportSize({ width: 901, height: 900 });
  await expect(drawer(page)).toHaveCount(0);
  await expect(service()).toBeFocused();
  await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
  await service().click();
  await expect(page.locator("main")).toBeFocused();
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(page.locator("main")).toBeFocused();
  await fits(page);
});

test("switching Workspace in an open drawer closes it and clears denied context with focus on main", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const state: State = {};
  await setup(page, state);
  await page.goto(v2(`services/${S}`));
  await expect(page.getByRole("heading", { name: "Serviço autorizado", exact: true })).toBeVisible();
  await openGateway(page);
  state.status = 403;
  await page.getByLabel("Workspace v2", { exact: true }).selectOption(E);
  await expect(page).toHaveURL(`/workspaces/${E}/services`);
  await expect(page.getByRole("alert")).toContainText("Você não tem permissão");
  await expect(drawer(page)).toHaveCount(0);
  await expect(trigger(page)).toHaveCount(0);
  await expect(page.locator(".gateway-context")).toHaveCount(0);
  await expect(page.locator("main")).toBeFocused();
  await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
  await fits(page);
});

for (const width of [390, 768, 1440]) {
  test(`long authorized names and slugs fit at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await setup(page);
    await page.route(`**/api/v2/workspaces/${W}`, (route) => route.fulfill({ json: {
      ...workspace(W), name: "Workspace de integrações ".repeat(8), slug: "integracoes".repeat(16),
    } }));
    await page.goto(v2());
    await openGateway(page);
    await fits(page);
    if (width <= 900) await drawer(page).getByRole("button", { name: "Fechar menu Gateway", exact: true }).click();
    await fits(page);
  });
}

test("collapsed sidebar keeps controls within two lines and descriptions out of the narrow column", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await setup(page);
  await page.route(/^https?:\/\/[^/]+\/api\/v2\/workspaces(?:\?|$)/, (route) => route.fulfill({ json: {
    items: [workspace(W), workspace(E)], nextCursor: "next",
  } }));
  await page.goto(v2());
  const sidebar = page.locator(".gateway-desktop");
  const more = page.locator(".global-header").getByRole("button", { name: "Carregar mais Workspaces", exact: true });
  const collapse = sidebar.getByRole("button", { name: "Recolher menu Gateway", exact: true });
  await expect(more).toBeVisible();
  await expect(more).toHaveCSS("color", "rgb(224, 229, 235)");
  await expect(more).toHaveCSS("background-color", "rgb(34, 40, 47)");
  await collapse.click();
  await expect(sidebar).toHaveCSS("width", "136px");
  await expect(sidebar.getByRole("combobox")).toHaveCount(0);
  await expect(more).toBeVisible();
  await expect(sidebar.locator(".gateway-requirement")).toHaveCount(0);
  await expect(nav(page).locator("a")).toHaveCount(9);
  await expect(nav(page).locator('[aria-disabled="true"]')).toHaveCount(0);
  const controls = await sidebar.locator("a, button, select, [role=link]").evaluateAll((nodes) => nodes
    .filter((node) => node.getClientRects().length > 0)
    .map((node) => ({ name: node.getAttribute("aria-label") ?? node.textContent, height: node.getBoundingClientRect().height })));
  expect(controls.length).toBeGreaterThan(0);
  for (const control of controls) expect(control.height, control.name ?? "").toBeLessThanOrEqual(64);
  expect(await sidebar.locator("*").evaluateAll((nodes) => nodes
    .filter((node) => node.getClientRects().length > 0 && node.clientWidth > 0)
    .filter((node) => node.scrollWidth > node.clientWidth)
    .map((node) => node.textContent))).toEqual([]);
  const certificates = nav(page).getByRole("link", { name: "Certificados", exact: true });
  await expect(certificates).toHaveAttribute("href", v2("certificates"));
  await expect(certificates).not.toHaveAttribute("aria-disabled");
  await expect(certificates).toHaveAccessibleDescription("Certificados");
  await certificates.focus();
  await expect(nav(page).getByRole("tooltip", { name: "Certificados", exact: true })).toBeVisible();
  await certificates.press("Escape");
  await expect(nav(page).getByRole("tooltip", { name: "Certificados", exact: true })).toBeHidden();
  await testInfo.attach("collapsed-compact-controls", { body: await page.screenshot(), contentType: "image/png" });
  const overview = nav(page).getByRole("link", { name: "Visão geral", exact: true });
  await expect(overview).toHaveAttribute("href", v2("overview"));
  await overview.click();
  await expect(page).toHaveURL(v2("overview"));
  await expect(overview).toHaveAttribute("aria-current", "page");
  await expect(sidebar).toHaveCSS("width", "136px");
  await sidebar.getByRole("button", { name: "Expandir menu Gateway", exact: true }).click();
  await expect(page.locator(".global-header").getByLabel("Workspace v2", { exact: true })).toBeVisible();
  await expect(more).toBeVisible();
});


for (const width of [390, 768, 1440]) {
  for (const [layout, path, heading] of [
    ["Workspace", v2(), "Serviços"],
    ["legado", v1(), "Serviços"],
    ["global", "/tokens", "Tokens de API"],
  ] as const) {
    test(`skip link by keyboard focuses main and preserves the full URL: ${layout} at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      await setup(page);
      await page.goto(`${path}?keep=1#existing`);
      await expect(page.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible();
      if (layout !== "global" && width <= 900) {
        await trigger(page).click();
        await expect(drawer(page)).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(drawer(page)).toBeHidden();
      }
      const before = page.url();
      const skip = page.getByRole("link", { name: "Pular para o conteúdo", exact: true });
      // Shell initially focuses main; walk the real tab order back to the skip link.
      for (let step = 0; step < 60 && !(await skip.evaluate(node => node === document.activeElement)); step++) {
        await page.keyboard.press("Shift+Tab");
      }
      await expect(skip).toBeFocused();
      await expect(skip).toBeVisible();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("main")).toBeFocused();
      expect(page.url()).toBe(before);
      await fits(page);
    });
  }
}
