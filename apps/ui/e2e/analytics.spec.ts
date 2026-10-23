import type { Page } from "@playwright/test";
import { expect, mockSession, test } from "./fixtures";

// W6-C1 acceptance against the contract mock: Prism answers the summary and request examples of the contract.
const envId = "11111111-1111-4111-8111-111111111111";
const actor = { id: "33333333-3333-4333-8333-333333333333", name: "Ana" };

async function login(page: Page, role: "admin" | "viewer" = "admin") {
  await mockSession(page, { ...actor, email: "ana@gromesh.dev", role, active: true, createdAt: "2026-10-15T12:00:00Z", updatedAt: "2026-10-15T12:00:00Z" });
  const environment = { id: envId, name: "Produção", publishMode: "manual", currentVersion: 2, hasUnpublishedChanges: false };
  await page.route("**/api/v1/environments", (route) => route.fulfill({ json: { items: [environment] } }));
  await page.route(`**/api/v1/environments/${envId}`, (route) => route.fulfill({ json: environment }));
  await page.goto("/login");
  await page.getByLabel("E-mail").fill("ana@gromesh.dev");
  await page.getByLabel("Senha").fill("test-password");
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("heading", { name: "Services" })).toBeVisible();
}

const menu = (page: Page) => page.getByRole("navigation", { name: "Menu principal" });

test("o dashboard renderiza os totais e as séries do período", async ({ page }) => {
  await login(page);
  const summary = page.waitForRequest((r) => r.url().includes("/analytics/summary?"));
  await menu(page).getByRole("link", { name: "Métricas" }).click();
  const url = new URL((await summary).url());
  expect(url.searchParams.get("interval")).toBe("5m"); // the 6 h preset
  expect(Date.parse(url.searchParams.get("to")!) - Date.parse(url.searchParams.get("from")!)).toBe(6 * 3_600_000);

  const totals = page.getByRole("region", { name: "Totais do período" }).or(page.locator("dl.stat-cards"));
  await expect(totals).toContainText("1.250");
  await expect(totals).toContainText("3,44%");
  await expect(totals).toContainText("48,9 ms");
  const charts = page.locator("figure.chart");
  await expect(charts).toHaveCount(3);
  await expect(charts.first().locator("path[data-series=requests]")).toHaveAttribute("d", /^M.*L.*/);
  await expect(charts.nth(2).locator("path[data-series]")).toHaveCount(3);
  // The legend swatches stay 10×10: the plot's full-width rule must not reach them.
  const swatches = charts.locator(".chart-legend .chart-swatch");
  await expect(swatches).toHaveCount(6);
  for (const box of await swatches.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON()))) {
    expect({ width: box.width, height: box.height }).toEqual({ width: 10, height: 10 });
  }

  // A 7-day period asks for hourly buckets.
  const weekly = page.waitForRequest((r) => r.url().includes("interval=1h"));
  await page.getByLabel("Período", { exact: true }).selectOption("7d");
  await weekly;
});

test("o card Top rotas ranqueia pelo critério escolhido e leva ao explorador filtrado pela rota", async ({ page }) => {
  await login(page);
  const top = page.waitForRequest((r) => r.url().includes("/analytics/top-routes?"));
  await menu(page).getByRole("link", { name: "Métricas" }).click();
  const url = new URL((await top).url());
  expect(url.searchParams.get("by")).toBe("requests");
  expect(url.searchParams.get("limit")).toBe("10");
  const table = page.getByRole("table", { name: "Top rotas" });
  await expect(table.getByRole("link", { name: "orders" })).toBeVisible();
  await expect(table).toContainText("900");
  await expect(table).toContainText("Sem rota"); // traffic that matched no route
  await expect(table).toContainText("(removida)"); // a route that no longer exists keeps its id

  const byErrors = page.waitForRequest((r) => r.url().includes("by=errors"));
  await page.getByLabel("Critério").selectOption("errors");
  await byErrors;

  // The row opens the explorer with the route already applied.
  const filtered = page.waitForRequest((r) => r.url().includes("/requests?") && r.url().includes("routeId=2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f"));
  await table.getByRole("link", { name: "orders" }).click();
  await filtered;
  await expect(page).toHaveURL(/\/requests\?routeId=2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f$/);
  await expect(page.getByRole("heading", { name: "Requisições" })).toBeVisible();
});

test("o explorador filtra por classe de status e abre o detalhe de uma requisição", async ({ page }) => {
  await login(page, "viewer");
  await menu(page).getByRole("link", { name: "Requisições" }).click();
  await expect(page.getByRole("cell", { name: "/orders/42" })).toBeVisible();
  // The explorer shows the address as the API sends it: masked for a viewer.
  await expect(page.getByRole("cell", { name: "203.0.113.0" })).toBeVisible();

  const filtered = page.waitForRequest((r) => r.url().includes("statusClass=5xx"));
  await page.getByLabel("Classe de status").selectOption("5xx");
  await page.getByRole("button", { name: "Filtrar" }).click();
  const url = new URL((await filtered).url());
  expect(url.searchParams.has("status")).toBe(false);

  await page.getByRole("cell", { name: "/orders/42" }).click();
  const detail = page.getByRole("dialog", { name: "GET /orders/42" });
  await expect(detail).toContainText("Latência no upstream");
  await expect(detail).toContainText("11 ms");
  await expect(detail).toContainText("1804 bytes");
  await detail.getByRole("button", { name: /Fechar/ }).click();
  await expect(detail).toBeHidden();
});

test("métricas explica na hora quando o coletor está fora do ar (5xx sem nova tentativa)", async ({ page }) => {
  let summaries = 0;
  await page.route("**/api/v1/environments/*/analytics/summary?*", (route) => {
    summaries++;
    return route.fulfill({ status: 502, contentType: "application/problem+json", body: JSON.stringify({ type: "https://gromesh.dev/problems/502", title: "Bad Gateway", status: 502, detail: "Analytics store is unavailable" }) });
  });
  await login(page);
  await menu(page).getByRole("link", { name: "Métricas" }).click();
  // The server answered: no retry delays the message (the default would retry twice, about 3 s).
  await expect(page.getByRole("alert")).toContainText("não estão disponíveis", { timeout: 1500 });
  expect(summaries).toBe(1);
});

test("Métricas is the former Dashboard: the old /analytics address redirects to it", async ({ page }) => {
  await login(page);
  const envId = /\/e\/([^/]+)\//.exec(new URL(page.url()).pathname)![1]!;
  await page.goto(`/e/${envId}/analytics`);
  await expect(page).toHaveURL(new RegExp(`/e/${envId}/metrics$`));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Métricas");
  await expect(menu(page).getByRole("link", { name: "Métricas" })).toHaveAttribute("aria-current", "page");
  await expect(menu(page).getByRole("link", { name: "Dashboard" })).toHaveCount(0);
});

test("métricas e requisições usam estados vazios sem perder os filtros", async ({ page }) => {
  await login(page);
  await page.route("**/api/v1/environments/*/analytics/top-routes?*", (route) => route.fulfill({ json: { by: "requests", items: [] } }));
  await page.goto(`/e/${envId}/metrics`);
  await expect(page.getByRole("heading", { name: "Sem tráfego no período.", exact: true })).toBeVisible();
  await expect(page.getByRole("table", { name: "Top rotas" })).toHaveCount(0);
  await expect(page.getByLabel("Critério")).toBeEnabled();
  await expect(page.locator("figure.chart")).toHaveCount(3);

  await page.route("**/api/v1/environments/*/requests?*", (route) => route.fulfill({ json: { items: [], nextCursor: null } }));
  await page.goto(`/e/${envId}/requests`);
  await expect(page.getByRole("heading", { name: "Nenhuma requisição no período.", exact: true })).toBeVisible();
  await expect(page.getByRole("table", { name: "Requisições", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Filtrar", exact: true })).toBeEnabled();
});
