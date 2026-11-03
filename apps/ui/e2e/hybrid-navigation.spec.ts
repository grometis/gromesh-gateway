import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import type { Me } from "../src/api/client";
import { expect, mockSession, test } from "./fixtures";
import { checkLayout } from "./layout";

const W = "7c1d2e3f-4a5b-4c6d-8e7f-000000000001";
const OTHER = "7c1d2e3f-4a5b-4c6d-8e7f-00000000000b";
const S = "7c1d2e3f-4a5b-4c6d-8e7f-000000000002";
const C = "7c1d2e3f-4a5b-4c6d-8e7f-000000000003";
const environment = (id: string) => ({ id, name: id === W ? "Pedidos" : "Catálogo", publishMode: "manual", currentVersion: 3, hasUnpublishedChanges: true });
const workspace = (id: string) => ({ id, key: id, name: id === W ? "Pedidos" : "Catálogo", slug: id === W ? "pedidos" : "catalogo", status: "active", activeRelease: null });
const menu = (page: Page) => page.getByRole("navigation", { name: "Menu principal" });

async function setup(page: Page, role: Me["role"] = "admin", environmentRoles: Me["environmentRoles"] = []) {
  await mockSession(page, { id: S, name: "Ana Souza", email: "ana@example.test", role, environmentRoles, active: true, createdAt: "2026-10-15T12:00:00Z", updatedAt: "2026-10-15T12:00:00Z" });
  await page.context().addCookies([{ name: "gromesh_session", value: "navigation-test", url: test.info().project.use.baseURL! }]);
  await page.route("**/api/v1/environments", (route) => route.fulfill({ json: { items: [environment(W), environment(OTHER)] } }));
  await page.route("**/api/v1/environments/*", (route) => route.fulfill({ json: environment(new URL(route.request().url()).pathname.split("/").at(-1)!) }));
  await page.route("**/api/v2/workspace-creation-policy", (route) => route.fulfill({ json: {
    mode: "restricted-request", creatorBecomesAdmin: false, updatedAt: null, updatedBy: null,
    workspacesMode: "disabled", stage: "dev", caller: { canCreate: false, canRequest: false, canDecide: false },
  } }));
  await page.route("**/api/v2/workspaces/*", (route) => route.fulfill({ json: workspace(new URL(route.request().url()).pathname.split("/").at(-1)!) }));
  await page.route("**/api/v2/workspaces/*/releases", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v2/workspaces/*/variables", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v2/workspaces", (route) => route.fulfill({ json: { items: [workspace(W), workspace(OTHER)], nextCursor: null } }));
}

const workspaceLinks = [
  ["Visão geral", "overview"], ["Serviços", "services"], ["Rotas", "routes"], ["Consumidores", "consumers"],
  ["Plugins", "plugins"], ["Upstreams", "upstreams"], ["Certificados", "certificates"], ["Variáveis", "variables"],
  ["Requisições", "requests"], ["Métricas", "metrics"], ["Releases", "releases"],
  ["Revisar snapshot (legado)", "publish"], ["Snapshots publicados (legado)", "publications"], ["Clusters (legado)", "clusters"],
] as const;

async function assertActive(page: Page, label: string) {
  const active = menu(page).locator('a[aria-current="page"]');
  await expect(active).toHaveCount(1);
  await expect(active).toHaveAccessibleName(label);
}

async function auditMenu(page: Page) {
  await checkLayout(page, { focusWithin: ".menu" });
  // Audit the full shell: grouping and compact labels must not introduce accessibility regressions.
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(result.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
}

for (const width of [390, 1440]) {
  test(`C groups, all destinations, identity and axe at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await setup(page);
    await page.goto(`/e/${W}/overview`);
    await expect(page.getByRole("region", { name: "Identidade da instância" })).toContainText("Instância DEV");
    await expect(menu(page).getByRole("heading", { level: 2 })).toHaveText([
      "Plataforma", "Workspace selecionado", "Gateway", "Operações e publicações", "Administração da instância", "Minha conta",
    ], { useInnerText: true });
    await expect(menu(page).getByRole("link")).toHaveCount(18);
    for (const [name, path] of workspaceLinks) {
      const link = menu(page).getByRole("link", { name, exact: true });
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute("href", `/e/${W}/${path}`);
    }
    for (const [name, href] of [["Workspaces", "/workspaces"], ["Usuários", "/users"], ["Auditoria", "/audit"], ["Tokens", "/tokens"]]) {
      await expect(menu(page).getByRole("link", { name, exact: true })).toHaveAttribute("href", href!);
    }
    await expect(menu(page).getByRole("button", { name: "Sair", exact: true })).toBeVisible();
    await expect(menu(page)).not.toContainText(/Aprovações|Grupos de usuários|Configurações|nesta fase|configuração v2/);
    await assertActive(page, "Visão geral");
    await auditMenu(page);
    await info.attach(`hybrid-menu-${width}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
    if (width === 390) await expect(page.getByRole("button", { name: "Recolher menu", exact: true })).toBeHidden();
  });

  test(`keyboard reaches navigation, logout and content with visible focus at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await setup(page);
    await page.goto(`/e/${W}/services`);
    await expect(menu(page).getByRole("link", { name: "Serviços", exact: true })).toHaveAttribute("aria-current", "page");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Pular para o conteúdo" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main-content")).toBeFocused();

    // Traverse the actual tab order, including both selectors, every link and logout.
    await page.getByRole("link", { name: "gromesh, início" }).focus();
    const reached = new Set<string>();
    for (let step = 0; step < 45; step++) {
      await page.keyboard.press("Tab");
      const focused = page.locator(":focus");
      if (await focused.getAttribute("id") === "main-content") continue;
      const inMenu = await focused.evaluate((element) => element.closest(".menu") !== null);
      if (!inMenu) break;
      expect(await focused.evaluate((element) => element.matches(":focus-visible") && getComputedStyle(element).outlineStyle !== "none")).toBe(true);
      const name = await focused.getAttribute("aria-label");
      if (name) reached.add(name);
      if (await focused.textContent() === "Sair") reached.add("Sair");
    }
    for (const name of ["Workspaces", ...workspaceLinks.map(([label]) => label), "Usuários", "Auditoria", "Tokens", "Sair"]) expect(reached.has(name), `${name} is keyboard reachable`).toBe(true);
    await menu(page).getByRole("link", { name: "Revisar snapshot (legado)", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(`/e/${W}/publish`);
    await assertActive(page, "Revisar snapshot (legado)");
  });
}

test("desktop collapse keeps accessible links and legacy distinctions; resizing restores full mobile labels", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await setup(page);
  await page.goto(`/e/${W}/services`);
  await expect(menu(page).getByRole("link", { name: "Serviços", exact: true })).toHaveAttribute("aria-current", "page");
  const fullWidth = (await page.locator(".menu").boundingBox())!.width;
  const links = await menu(page).getByRole("link").evaluateAll((nodes) => nodes.map((node) => [node.getAttribute("href"), node.getAttribute("aria-label")]));
  const toggle = page.getByRole("button", { name: "Recolher menu", exact: true });
  await toggle.focus();
  await page.keyboard.press("Enter");
  const expand = page.getByRole("button", { name: "Expandir menu", exact: true });
  await expect(expand).toBeFocused();
  await expect(expand).toHaveAttribute("aria-expanded", "false");
  expect((await page.locator(".menu").boundingBox())!.width).toBeLessThan(fullWidth);
  expect(await menu(page).getByRole("link").evaluateAll((nodes) => nodes.map((node) => [node.getAttribute("href"), node.getAttribute("aria-label")]))).toEqual(links);
  await expect(menu(page).getByRole("link", { name: "Snapshots publicados (legado)", exact: true })).toContainText("legado");
  await auditMenu(page);
  await info.attach("hybrid-menu-collapsed", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  await menu(page).getByRole("link", { name: "Consumidores", exact: true }).click();
  await assertActive(page, "Consumidores");
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(menu(page).getByRole("link", { name: "Consumidores", exact: true })).toHaveText("Consumidores", { useInnerText: true });
  await auditMenu(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Expandir menu", exact: true }).focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Recolher menu", exact: true })).toHaveAttribute("aria-expanded", "true");
  await assertActive(page, "Consumidores");
});

const deepLinks = [
  ...workspaceLinks.map(([name, path]) => [`/e/${W}/${path}`, name]),
  [`/e/${W}/services/${S}`, "Serviços"], [`/e/${W}/consumers/${C}`, "Consumidores"], [`/e/${W}/publications/2`, "Snapshots publicados (legado)"],
  ["/workspaces", "Workspaces"], ["/tokens", "Tokens"], ["/users", "Usuários"], ["/audit", "Auditoria"],
] as const;
for (const [path, label] of deepLinks) {
  test(`current deep link and hard refresh: ${path}`, async ({ page }) => {
    await setup(page);
    await page.goto(`${path}?navigation=keep#detail`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await assertActive(page, label!);
    await expect(page).toHaveURL(`${path}?navigation=keep#detail`);
    await page.reload();
    await assertActive(page, label!);
    await expect(page).toHaveURL(`${path}?navigation=keep#detail`);
  });
}

test("existing entry, parent and analytics alias retain their current destinations", async ({ page }) => {
  await setup(page);
  await page.goto("/");
  await expect(page).toHaveURL(`/e/${W}/services`);
  await page.goto(`/e/${W}`);
  await expect(page).toHaveURL(`/e/${W}/services`);
  await page.goto(`/e/${W}/analytics?routeId=${S}#traffic`);
  await expect(page).toHaveURL(`/e/${W}/metrics?routeId=${S}#traffic`);
  await assertActive(page, "Métricas");
});

for (const role of ["admin", "editor", "viewer"] as const) {
  test(`${role} keeps current navigation permissions and direct admin guards`, async ({ page }) => {
    await setup(page, role);
    await page.goto(`/e/${W}/overview`);
    for (const [name, path] of workspaceLinks) {
      await menu(page).getByRole("link", { name, exact: true }).click();
      await expect(page).toHaveURL(`/e/${W}/${path}`);
      await assertActive(page, name);
    }
    for (const [name, path] of [["Usuários", "/users"], ["Auditoria", "/audit"]]) {
      await expect(menu(page).getByRole("link", { name, exact: true })).toHaveCount(role === "admin" ? 1 : 0);
      await page.goto(path!);
      if (role === "admin") await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
      else await expect(page.getByRole("alert")).toHaveText("Você não tem permissão para acessar esta página.");
    }
  });
}

test("workspace overrides preserve the legacy selector and do not grant instance administration", async ({ page }) => {
  await setup(page, "viewer", [{ environmentId: W, role: "admin" }, { environmentId: OTHER, role: "none" }]);
  await page.goto(`/e/${W}/consumers`);
  await expect(page.getByLabel("Ambiente (legado)", { exact: true }).locator("option")).toHaveText(["Pedidos"]);
  await expect(menu(page).getByRole("link", { name: "Usuários", exact: true })).toHaveCount(0);
  await expect(menu(page).getByRole("link", { name: "Clusters (legado)", exact: true })).toBeVisible();
  await expect(page.locator(".who")).toContainText("Administrador");
});
