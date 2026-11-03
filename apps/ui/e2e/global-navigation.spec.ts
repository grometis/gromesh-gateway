import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, mockSession, test } from "./fixtures";
import { navigateGlobal, openGlobalMenu } from "./global-navigation";

const W = "7c1d2e3f-4a5b-4c6d-8e7f-00000000000a";
const E = "7c1d2e3f-4a5b-4c6d-8e7f-00000000000b";
const stamp = "2026-11-03T12:00:00Z";
const workspace = (id: string) => ({ id, key: id, name: "Workspace autorizado", slug: "autorizado", status: "active", activeRelease: null });
const environment = (id: string) => ({ id, name: "Ambiente confirmado", publishMode: "manual", currentVersion: null, hasUnpublishedChanges: false, createdAt: stamp, updatedAt: stamp });
const paths = { global: "/tokens", v2: `/workspaces/${W}/services`, v1: `/e/${E}/services` };

async function setup(page: Page, options: { role?: "viewer" | "admin"; stage?: string | null; contextStatus?: number; logoutStatus?: number } = {}) {
  const sent: string[] = [];
  await page.route(/^https?:\/\/[^/]+\/api\/v[12]\//, (route) => {
    const path = new URL(route.request().url()).pathname;
    sent.push(path);
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (path === "/api/v1/auth/csrf") return json({ csrfToken: "csrf" });
    if (path === "/api/v1/auth/logout") return options.logoutStatus ? json({ title: "Forbidden", status: options.logoutStatus }, options.logoutStatus)
      : route.fulfill({ status: 204, headers: { "Set-Cookie": "gromesh_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0" } });
    if (path === "/api/v2/workspace-creation-policy") return json({ mode: "restricted-request", creatorBecomesAdmin: false, updatedAt: null, updatedBy: null, workspacesMode: "disabled", stage: options.stage === undefined ? "dev" : options.stage, caller: { canCreate: false, canRequest: false, canDecide: false } });
    if (path === "/api/v2/workspaces") return json({ items: [workspace(W)], nextCursor: null });
    if (path === "/api/v1/environments") return json({ items: [environment(E)] });
    if (path === "/api/v1/tokens" || path === "/api/v1/users/me/tokens" || path === "/api/v1/users" || path === "/api/v1/audit-events") return json({ items: [], nextCursor: null });
    for (const id of [W, E]) {
      if (path === `/api/v2/workspaces/${id}`) return json(workspace(id), options.contextStatus);
      if (path === `/api/v1/environments/${id}`) return json(environment(id), options.contextStatus);
      if (path === `/api/v2/workspaces/${id}/releases`) return json([]);
      if (path.startsWith(`/api/v2/workspaces/${id}/`) || path.startsWith(`/api/v1/environments/${id}/`)) return json({ items: [], nextCursor: null });
    }
    return json({ title: "Unexpected request", status: 404 }, 404);
  });
  await mockSession(page, { id: W, name: "Ana Souza", email: "ana@example.test", role: options.role ?? "viewer", environmentRoles: [{ environmentId: E, role: "admin" }], active: true, createdAt: stamp, updatedAt: stamp });
  await page.context().addCookies([{ name: "gromesh_session", value: "global-navigation", url: test.info().project.use.baseURL! }]);
  return sent;
}
const nav = (page: Page) => page.getByRole("navigation", { name: "Navegação global", exact: true });
async function fits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
}
async function audit(page: Page) {
  await fits(page);
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
}

for (const width of [390, 600]) {
  test(`compact groups stack with full-width readable panels at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await setup(page, { role: "admin" });
    await page.goto(paths.v1);
    await expect(page.locator("main h1")).toBeVisible();
    const names = ["Operações", "Instância", "Minha conta"] as const;
    for (const name of names) {
      await openGlobalMenu(page, name);
      const buttons = await Promise.all(names.map((label) => nav(page).getByRole("button", { name: label, exact: true }).boundingBox()));
      for (const [index, box] of buttons.entries()) {
        expect(box).not.toBeNull();
        expect(box!.x).toBeCloseTo(buttons[0]!.x, 0);
        expect(box!.width).toBeCloseTo(buttons[0]!.width, 0);
        expect(box!.width).toBeGreaterThanOrEqual(width * 0.9);
        if (index > 0) expect(box!.y).toBeGreaterThanOrEqual(buttons[index - 1]!.y + buttons[index - 1]!.height);
      }
      const panel = nav(page).getByRole("region", { name, exact: true });
      await expect(panel).toBeVisible();
      const panelBox = (await panel.boundingBox())!;
      const triggerBox = buttons[names.indexOf(name)]!;
      expect(panelBox.width).toBeGreaterThanOrEqual(width * 0.9);
      expect(panelBox.x).toBeCloseTo(triggerBox.x, 0);
      expect(panelBox.width).toBeCloseTo(triggerBox.width, 0);
      expect(panelBox.y).toBeGreaterThanOrEqual(triggerBox.y + triggerBox.height);
      const nextButton = buttons[names.indexOf(name) + 1];
      if (nextButton) expect(nextButton.y).toBeGreaterThanOrEqual(panelBox.y + panelBox.height);
      const links = panel.getByRole("link");
      await expect(links.first()).toHaveAttribute("href", /./);
      expect(await links.count()).toBeGreaterThan(0);
      for (const link of await links.all()) expect((await link.boundingBox())!.width).toBeGreaterThanOrEqual(200);
      expect(await panel.locator("*").evaluateAll((nodes) => nodes.filter((node) =>
        node.textContent?.trim() && node.scrollWidth > node.clientWidth,
      ).map((node) => node.textContent))).toEqual([]);
      await expect(nav(page).locator('.global-trigger[aria-expanded="true"]')).toHaveCount(1);
      await fits(page);
    }
  });
}

for (const width of [390, 768, 1440]) {
  for (const scope of ["global", "v2", "v1"] as const) {
    for (const stage of ["dev", null]) {
      test(`${scope}, stage ${stage ?? "unknown"}: disclosures, context, layout and axe at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        const sent = await setup(page, { stage });
        const path = `${paths[scope]}?direct=1#kept`;
        await page.goto(path);
        await expect(page.locator("main h1")).toBeVisible();
        await expect(page.getByRole("region", { name: "Identidade da instância" })).toContainText(stage ? "Instância DEV" : "Instância não identificada");
        await expect(page.getByRole("link", { name: "gromesh, início", exact: true })).toHaveAttribute("href", "/");
        await page.reload();
        await expect(page.locator("main h1")).toBeVisible();
        await expect(page).toHaveURL(path);
        await audit(page);

        await openGlobalMenu(page, "Operações");
        const operations = nav(page).getByRole("region", { name: "Operações", exact: true });
        await expect(operations).toHaveAttribute("tabindex", "0");
        await expect(nav(page).getByRole("heading", { name: "Legado v1", exact: true })).toBeVisible();
        const expected = [
          ["Releases", scope === "v2" ? `/workspaces/${W}/releases` : scope === "v1" ? `/e/${E}/releases` : null, "Requer Workspace ou ambiente legado"],
          ["Requisições", scope === "v1" ? `/e/${E}/requests` : null, "Requer ambiente legado"],
          ["Métricas", scope === "v1" ? `/e/${E}/metrics` : null, "Requer ambiente legado"],
          ["Revisar snapshot", scope === "v1" ? `/e/${E}/publish` : null, "Requer ambiente legado"],
          ["Publicações", scope === "v1" ? `/e/${E}/publications` : null, "Requer ambiente legado"],
          ["Clusters (legado)", scope === "v1" ? `/e/${E}/clusters` : null, "Requer ambiente legado"],
        ];
        for (const [label, href, requirement] of expected) {
          if (href) await expect(nav(page).getByRole("link", { name: label!, exact: true })).toHaveAttribute("href", href);
          else {
            const item = nav(page).locator("[aria-disabled=true]").filter({ hasText: label! });
            await expect(item).not.toHaveAttribute("href");
            await expect(item).toHaveAccessibleDescription(requirement!);
            await expect(item).toHaveAccessibleName(label!);
          }
        }
        await expect(nav(page).getByText("Histórico operacional", { exact: true })).toHaveCount(0);
        await expect(nav(page).getByRole("menu")).toHaveCount(0);
        if (scope === "global" && width === 390) {
          expect(await operations.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
          await operations.focus();
          await expect(operations).toBeFocused();
          await operations.press("End");
          await expect.poll(() => operations.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
        }
        await audit(page);
        await openGlobalMenu(page, "Instância");
        await expect(nav(page).getByRole("button", { name: "Operações", exact: true, includeHidden: true })).toHaveAttribute("aria-expanded", "false");
        await expect(nav(page).getByRole("link", { name: "Workspaces", exact: true })).toHaveAttribute("href", "/workspaces");
        await expect(nav(page).getByRole("link", { name: /Usuários|Auditoria|Visão geral da instância|Configurações|Grupos|Aprovações/ })).toHaveCount(0);
        await audit(page);
        await openGlobalMenu(page, "Minha conta");
        await expect(nav(page).getByText("Ana Souza", { exact: true })).toBeVisible();
        await expect(nav(page).getByText("ana@example.test", { exact: true })).toBeVisible();
        await expect(nav(page).getByText(`Papel legado: ${scope === "v1" ? "Administrador" : "Leitor"}`, { exact: true })).toBeVisible();
        await expect(nav(page).getByRole("link", { name: "Tokens de API", exact: true })).toHaveAttribute("href", "/tokens");
        await expect(nav(page).getByRole("button", { name: "Sair", exact: true })).toBeVisible();
        await audit(page);
        await page.keyboard.press("Escape");
        await expect(nav(page).getByRole("button", { name: "Minha conta", exact: true, includeHidden: true })).toBeFocused();
        await audit(page);
        if (scope === "v2") expect(sent.some((p) => p.startsWith("/api/v1/environments"))).toBe(false);
      });
    }
  }

  test(`admin and direct protected URLs retain current guards at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await setup(page, { role: "admin" });
    await page.goto("/workspaces");
    await openGlobalMenu(page, "Instância");
    for (const [label, path] of [["Usuários", "/users"], ["Auditoria", "/audit"]]) {
      await navigateGlobal(page, label!);
      await expect(page).toHaveURL(path!);
      await expect(page.locator("main")).toBeFocused();
      await expect(nav(page).getByRole("button", { name: "Instância", exact: true, includeHidden: true })).toHaveAttribute("aria-expanded", "false");
    }
    await setup(page, { role: "viewer" });
    for (const path of ["/users", "/audit"]) {
      await page.goto(path);
      await expect(page.getByRole("alert")).toContainText("Você não tem permissão");
      await openGlobalMenu(page, "Instância");
      await expect(nav(page).getByRole("link", { name: /Usuários|Auditoria/ })).toHaveCount(0);
    }
  });

  test(`keyboard, outside click, focus exit, navigation and history at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await setup(page);
    await page.goto(paths.v2);
    await expect(page.locator("main h1")).toBeVisible();
    if (width <= 600) await page.getByRole("button", { name: "Menus globais", exact: true }).click();
    const instance = nav(page).getByRole("button", { name: "Instância", exact: true, includeHidden: true });
    await instance.focus();
    await page.keyboard.press("Enter");
    await expect(instance).toBeFocused();
    await expect(instance).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Tab");
    await expect(nav(page).getByRole("link", { name: "Workspaces", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(instance).toBeFocused();
    await expect(instance).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("Space");
    await expect(instance).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(instance).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(instance).toHaveAttribute("aria-expanded", "false");
    await expect(nav(page).getByRole("button", { name: "Operações", exact: true, includeHidden: true })).toBeFocused();
    expect(await page.evaluate(() => { const style = getComputedStyle(document.activeElement!); return style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0; })).toBe(true);
    await openGlobalMenu(page, "Operações");
    await page.getByRole("region", { name: "Identidade da instância", exact: true }).click();
    await expect(nav(page).getByRole("button", { name: "Operações", exact: true, includeHidden: true })).toHaveAttribute("aria-expanded", "false");
    await openGlobalMenu(page, "Operações");
    const main = page.locator("main");
    const mainBox = await main.boundingBox();
    // The open panel covers the heading at tablet width; click exposed content.
    await main.click({ position: { x: mainBox!.width - 8, y: 8 } });
    await expect(nav(page).getByRole("button", { name: "Operações", exact: true, includeHidden: true })).toHaveAttribute("aria-expanded", "false");
    await openGlobalMenu(page, "Instância");
    await page.locator("main").focus();
    await expect(instance).toHaveAttribute("aria-expanded", "false");
    await openGlobalMenu(page, "Operações");
    const routes = page.getByRole("navigation", { name: "Menu principal", exact: true }).getByRole("link", { name: "Rotas", exact: true });
    // This link is also covered at tablet width; keyboard navigation remains available.
    await routes.focus();
    await routes.press("Enter");
    await expect(page).toHaveURL(`/workspaces/${W}/routes`);
    await expect(page.locator("main")).toBeFocused();
    await navigateGlobal(page, "Releases");
    await expect(page).toHaveURL(`/workspaces/${W}/releases`);
    await expect(page.locator("main")).toBeFocused();
    await openGlobalMenu(page, "Operações");
    await expect(nav(page).getByRole("link", { name: "Releases", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(nav(page).getByRole("button", { name: "Operações", exact: true, includeHidden: true })).not.toHaveAttribute("aria-current");
    await expect(nav(page).locator('[aria-current="page"]')).toHaveCount(1);
    await navigateGlobal(page, "Tokens de API");
    await expect(page).toHaveURL("/tokens");
    await openGlobalMenu(page, "Operações");
    await expect(nav(page).locator("[aria-disabled=true]")).toHaveCount(6);
    await page.goBack();
    await expect(page).toHaveURL(`/workspaces/${W}/releases`);
    await expect(nav(page).getByRole("button", { name: "Operações", exact: true, includeHidden: true })).toHaveAttribute("aria-expanded", "false");
    await page.goForward();
    await expect(page).toHaveURL("/tokens");
    await fits(page);
  });
}

test("breakpoint transitions restore focus from a link hidden before matchMedia.change", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await setup(page);
  await page.goto("/tokens");
  await openGlobalMenu(page, "Instância");
  await nav(page).getByRole("link", { name: "Workspaces", exact: true }).focus();
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(page.getByRole("button", { name: "Menus globais", exact: true })).toBeFocused();
  await expect(nav(page).getByRole("button", { name: "Instância", exact: true, includeHidden: true })).toBeHidden();
  await openGlobalMenu(page, "Minha conta");
  await nav(page).getByRole("link", { name: "Tokens de API", exact: true }).focus();
  await page.setViewportSize({ width: 768, height: 900 });
  await expect(nav(page).getByRole("button", { name: "Minha conta", exact: true, includeHidden: true })).toBeFocused();
  await expect(nav(page).getByRole("button", { name: "Minha conta", exact: true, includeHidden: true })).toHaveAttribute("aria-expanded", "false");
  await fits(page);
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(page.getByRole("button", { name: "Menus globais", exact: true })).toBeFocused();
  await page.setViewportSize({ width: 768, height: 900 });
  await expect(nav(page).getByRole("button", { name: "Minha conta", exact: true })).toBeFocused();
  await openGlobalMenu(page, "Instância");
  await nav(page).getByRole("link", { name: "Workspaces", exact: true }).focus();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(nav(page).getByRole("link", { name: "Workspaces", exact: true })).toBeFocused();
});

test("logout failure remains visible; successful logout follows the existing session flow", async ({ page }) => {
  const state = { logoutStatus: 403 };
  await setup(page, state);
  await page.goto("/tokens");
  await openGlobalMenu(page, "Minha conta");
  await nav(page).getByRole("button", { name: "Sair", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Você não tem permissão");
  await expect(page).toHaveURL("/tokens");
  await page.locator("main").focus();
  await expect(nav(page).getByRole("button", { name: "Minha conta", exact: true })).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("alert")).toBeVisible();
  state.logoutStatus = 0;
  await openGlobalMenu(page, "Minha conta");
  await nav(page).getByRole("button", { name: "Sair", exact: true }).click();
  await expect(page).toHaveURL("/login");
  await expect(nav(page)).toHaveCount(0);
});

for (const status of [403, 404, 502]) {
  test(`unconfirmed v1 and v2 context (${status}) never enables operations`, async ({ page }) => {
    await setup(page, { contextStatus: status });
    for (const path of [paths.v1, paths.v2]) {
      await page.goto(path);
      await expect(page.getByRole("alert").first()).toBeVisible();
      await openGlobalMenu(page, "Operações");
      await expect(nav(page).locator("[aria-disabled=true]")).toHaveCount(6);
      await expect(nav(page).locator(".global-operations a")).toHaveCount(0);
    }
  });
}
