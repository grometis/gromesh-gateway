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

// FB-P1-01: this fixture can also be served to the base UI for Claude's before/after screenshots.
test.describe("escala e leitura dos gráficos", () => {
  test.use({ timezoneId: "UTC" });
  for (const width of [1440, 390]) {
    test(`máximos, unidades e tabela exata em ${width}px`, async ({ page }) => {
      const { chartSummary } = await import("./chart-fixtures");
      await page.setViewportSize({ width, height: 900 });
      await page.route("**/api/v1/environments/*/analytics/summary?*", (route) => route.fulfill({ json: chartSummary() }));
      await login(page, "viewer");
      await menu(page).getByRole("link", { name: "Métricas" }).click();
      const charts = page.locator("figure.chart");
      await expect(charts).toHaveCount(3);
      await expect(charts.first()).toContainText("Horário local");
      await expect(charts.first()).toContainText("17/10/2026");
      await expect(charts.first()).toContainText("18/10/2026");
      for (const chart of await charts.all()) {
        await expect(chart.getByRole("img")).toBeVisible();
        await expect(chart.getByRole("list", { name: "Legenda" })).toBeVisible();
        // Wait for ResizeObserver: labels stay in CSS pixels at both viewport widths.
        await expect.poll(async () => chart.locator(".chart-plot > svg").evaluate((svg) => Math.abs(Number(svg.getAttribute("width")) - svg.getBoundingClientRect().width))).toBeLessThan(2);
        const bounds = await chart.evaluate((figure) => {
          const grid = [...figure.querySelectorAll<SVGLineElement>(".chart-grid")];
          const top = Math.min(...grid.map((line) => line.y1.baseVal.value));
          const bottom = Math.max(...grid.map((line) => line.y1.baseVal.value));
          return [...figure.querySelectorAll<SVGPathElement>("path[data-series]")].map((path) => {
            const box = path.getBBox();
            return { above: box.y > top, below: box.y + box.height <= bottom + 0.01, left: box.x >= grid[0]!.x1.baseVal.value, right: box.x + box.width <= grid[0]!.x2.baseVal.value + 0.01 };
          });
        });
        expect(bounds.length).toBeGreaterThan(0);
        for (const bound of bounds) expect(bound).toEqual({ above: true, below: true, left: true, right: true });
      }
      const latency = charts.nth(2);
      await latency.getByText("Ver como tabela", { exact: true }).focus();
      await page.keyboard.press("Enter");
      const table = latency.getByRole("table", { name: "Latência total" });
      await expect(table).toBeVisible();
      await expect(table).toContainText("131,5 ms");
      await expect(table).toContainText("0,00013 ms");
      await expect(table).toContainText("Sem dado");
      await expect(table.getByRole("row")).toHaveCount(5);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    });
  }
});
