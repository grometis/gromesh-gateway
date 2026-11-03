import { openGateway } from "./gateway-sidebar";
import { navigateGlobal, openGlobalMenu } from "./global-navigation";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, mockSession, test } from "./fixtures";
import { checkLayout } from "./layout";

const A = "7c1d2e3f-4a5b-4c6d-8e7f-00000000000a";
const B = "7c1d2e3f-4a5b-4c6d-8e7f-00000000000b";
const stamp = "2026-11-03T12:00:00Z";
const person = { id: A, name: "Ana Souza", email: "ana@example.test", role: "viewer" as const, active: true, createdAt: stamp, updatedAt: stamp };
const environment = (id: string) => ({ id, name: id === A ? "producao" : "Pedidos", publishMode: "manual", currentVersion: 0, hasUnpublishedChanges: false, createdAt: stamp, updatedAt: stamp });
const workspace = (id: string) => ({ id, key: id, name: id === A ? "Pedidos v2" : "Catálogo v2", slug: id === A ? "pedidos" : "catalogo", status: "active", activeRelease: null });

async function setup(page: Page, options: { stage?: string | null; policyStatus?: number; envStatus?: number; envs?: string[]; workspaceStatus?: number } = {}) {
  await mockSession(page, person);
  await page.context().addCookies([{ name: "gromesh_session", value: "context-test", url: test.info().project.use.baseURL! }]);
  await page.route("**/api/v1/environments", (route) => route.fulfill({ status: options.envStatus ?? 200, json: { items: (options.envs ?? [A]).map(environment) } }));
  await page.route("**/api/v1/environments/*", (route) => route.fulfill({ json: environment(new URL(route.request().url()).pathname.split("/").at(-1)!) }));
  await page.route("**/api/v2/workspace-creation-policy", (route) => route.fulfill({ status: options.policyStatus ?? 200, json: {
    mode: "restricted-request", creatorBecomesAdmin: false, updatedAt: null, updatedBy: null,
    workspacesMode: "disabled", stage: options.stage === undefined ? "dev" : options.stage,
    caller: { canCreate: false, canRequest: false, canDecide: false },
  } }));
  await page.route("**/api/v2/workspaces/*", (route) => route.fulfill({ status: options.workspaceStatus ?? 200, json: workspace(new URL(route.request().url()).pathname.split("/").at(-1)!) }));
  await page.route("**/api/v2/workspaces/*/releases", (route) => route.fulfill({ json: [] }));
  await page.route(/\/api\/v2\/workspaces(?:\?|$)/, (route) => route.fulfill({ json: { items: [A, B].map(workspace), nextCursor: null } }));
}

async function audit(page: Page) {
  await checkLayout(page, { focusWithin: await page.getByLabel("Ambiente (legado)", { exact: true }).isVisible() ? ".menu" : ".global-header" });
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(result.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
}

for (const width of [390, 1440]) {
  for (const state of [
    { name: "DEV", options: { stage: "dev" }, text: "Instância DEV" },
    { name: "HML", options: { stage: "hml" }, text: "Instância HML" },
    { name: "PRD", options: { stage: "prd" }, text: "Instância PRD" },
    { name: "unknown", options: { stage: null }, text: "Instância não identificada" },
    { name: "policy denied", options: { policyStatus: 403 }, text: "Instância não identificada" },
    { name: "policy failure", options: { policyStatus: 502 }, text: "Instância não identificada" },
    { name: "no legacy environment", options: { envs: [] }, text: "Nenhum ambiente legado disponível." },
    { name: "many legacy environments", options: { envs: [A, B] }, text: "Ambiente (legado)" },
    { name: "legacy list denied", options: { envStatus: 403 }, text: "Sem permissão para listar ambientes legados." },
    { name: "legacy list failure", options: { envStatus: 502 }, text: "Não foi possível carregar os ambientes legados." },
    { name: "invalid selection", options: { envs: [B] }, text: "Ambiente legado indisponível para esta URL." },
    { name: "workspace denied", options: { workspaceStatus: 403 }, text: "Ambiente (legado)" },
    { name: "workspace failure", options: { workspaceStatus: 502 }, text: "Ambiente (legado)" },
  ]) {
    test(`${state.name}: identity/context layout and axe at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await setup(page, state.options);
      await page.goto(`/e/${A}/releases`);
      const identity = page.getByRole("region", { name: "Identidade da instância" });
      await expect(identity).toContainText(new URL(test.info().project.use.baseURL!).origin);
      await openGateway(page);
      await expect(state.text.startsWith("Instância") ? page.locator(".instance-context") : page.locator(".menu")).toContainText(state.text);
      await expect(page.getByLabel("Ambiente (legado)", { exact: true })).toBeVisible();
      await expect(page.getByLabel("Workspace v2", { exact: true })).toBeVisible();
      await expect(page.getByLabel("Workspace v2", { exact: true })).toHaveValue("");
      await expect(page.getByLabel("Workspace v2", { exact: true }).locator('option[value=""]')).toHaveText("Abrir um Workspace v2…");
      await expect(page.getByRole("link", { name: "Ir para Workspaces", exact: true })).toHaveCount(0);
      if (state.name === "invalid selection") await expect(page.getByLabel("Ambiente (legado)", { exact: true })).toHaveValue("");
      const close = page.getByRole("button", { name: "Fechar menu Gateway", exact: true });
      if (await close.isVisible()) await close.click();
      await openGlobalMenu(page, "Minha conta");
      await expect(page.locator(".global-account .global-panel-context")).toContainText("Ana Souza");
      await expect(page).toHaveURL(new RegExp(`/e/${A}/releases$`));
      await audit(page);
      await testInfo.attach(`context-${width}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
    });
  }

  test(`loading sources keep identities unconfirmed at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await setup(page);
    let releaseMetadata!: () => void;
    const metadataReady = new Promise<void>((resolve) => { releaseMetadata = resolve; });
    await page.route("**/api/v1/environments", async (route) => { await metadataReady; await route.fulfill({ json: { items: [environment(A)] } }); });
    await page.route("**/api/v2/workspace-creation-policy", async (route) => { await metadataReady; await route.fulfill({ json: { stage: "hml" } }); });
    await page.goto(`/e/${A}/releases`);
    await expect(page.getByRole("region", { name: "Identidade da instância" })).toContainText("Instância não identificada");
    await openGateway(page);
    await expect(page.locator("#env-context-message")).toHaveText("Carregando ambientes legados…");
    await audit(page);
    const close = page.getByRole("button", { name: "Fechar menu Gateway", exact: true });
    if (await close.isVisible()) await close.click();
    releaseMetadata();
    await expect(page.getByRole("region", { name: "Identidade da instância" })).toContainText("Instância HML");
    await openGateway(page);
    await expect(page.locator(".gateway-context")).toContainText("producao");
    await expect(page.locator(".workspace-context")).toHaveCount(0);
  });

  test(`deep links, refresh and explicit global scope at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await setup(page, { envs: [A, B] });
    await page.goto(`/e/${A}/releases`);
    await openGateway(page);
    await expect(page.locator(".gateway-context")).toContainText("producao");
    await page.getByLabel("Workspace v2", { exact: true }).selectOption(B);
    await expect(page).toHaveURL(`/workspaces/${B}/releases`);
    await openGateway(page);
    await expect(page.locator(".workspace-context")).toContainText("/catalogo");
    await expect(page.locator(".instance-context")).toContainText("Instância DEV");
    await page.reload();
    await expect(page.locator("main h1")).toBeVisible();
    await openGateway(page);
    await expect(page.getByLabel("Workspace v2", { exact: true })).toHaveValue(B);
    await expect(page.getByLabel("Ambiente (legado)", { exact: true })).toHaveCount(0);
    await expect(page.locator(".workspace-context")).toContainText("/catalogo");
    const close = page.getByRole("button", { name: "Fechar menu Gateway", exact: true });
    if (await close.isVisible()) await close.click();
    await navigateGlobal(page, "Tokens de API");
    await expect(page.getByText("Escopo: minha conta nesta instância", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Ambiente (legado)", { exact: true })).toHaveCount(0);
    await expect(page.locator(".context-return")).toHaveCount(0);
    await audit(page);
    await page.reload();
    await expect(page.getByLabel("Ambiente (legado)", { exact: true })).toHaveCount(0);
    await expect(page.locator(".context-return")).toHaveCount(0);
  });
}

test("login shows origin without requesting protected instance metadata", async ({ page }) => {
  let reads = 0;
  await page.route("**/api/v2/workspace-creation-policy", (route) => { reads++; return route.fulfill({ status: 403, json: {} }); });
  await page.goto("/login");
  await expect(page.locator(".login-origin")).toContainText(new URL(test.info().project.use.baseURL!).origin);
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.locator(".login-origin")).toBeVisible();
    await expect(page.locator(".login-origin .instance-origin")).toBeVisible();
    const result = await new AxeBuilder({ page }).include(".login").withRules(["color-contrast"]).analyze();
    expect(result.violations).toEqual([]);
    expect(result.incomplete).toEqual([]);
  }
  expect(reads).toBe(0);
});
