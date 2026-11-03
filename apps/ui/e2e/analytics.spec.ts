import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { expect, mockSession, test } from "./fixtures";

// W6-C1 acceptance against the contract mock: Prism answers the summary and request examples of the contract.
const envId = "11111111-1111-4111-8111-111111111111";
const actor = { id: "33333333-3333-4333-8333-333333333333", name: "Ana" };

async function login(page: Page, role: "admin" | "viewer" = "admin") {
  await mockSession(page, { ...actor, email: "ana@gromesh.dev", role, active: true, createdAt: "2026-10-15T12:00:00Z", updatedAt: "2026-10-15T12:00:00Z" });
  const environment = { id: envId, name: "Produção", publishMode: "manual", currentVersion: 2, hasUnpublishedChanges: false };
  await page.route("**/api/v1/environments", (route) => route.fulfill({ json: { items: [environment] } }));
  await page.route(`**/api/v1/environments/${envId}`, (route) => route.fulfill({ json: environment }));
  await page.goto(`/e/${envId}/services`);
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

test("requisições mantém classe e status exato exclusivos ao aplicar, limpar e reaplicar", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-11-03T12:00:00Z") });
  await page.route("**/api/v1/environments/*/consumers", (route) => route.fulfill({ json: {
    items: [{ id: "0b7c3c1e-1f2a-4f7e-9c41-0d3c1b2a9e11", username: "Ana", customId: null, tags: [], createdAt: "2026-10-15T12:00:00Z", updatedAt: "2026-10-15T12:00:00Z" }], nextCursor: null,
  } }));
  const queries: URL[] = [];
  await page.route("**/api/v1/environments/*/requests?*", (route) => {
    const url = new URL(route.request().url());
    queries.push(url);
    return url.searchParams.has("status") && url.searchParams.has("statusClass")
      ? route.fulfill({ status: 422, json: { title: "Unprocessable Content", status: 422 } })
      : route.fulfill({ json: { items: [], nextCursor: null } });
  });
  await login(page, "viewer");
  const routeId = "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f";
  await page.goto(`/e/${envId}/requests?routeId=${routeId}`);
  await expect(page.getByRole("heading", { name: "Nenhuma requisição no período." })).toBeVisible();
  expect(queries.at(-1)!.searchParams.get("routeId")).toBe(routeId);
  expect(queries.at(-1)!.searchParams.has("status")).toBe(false);
  expect(queries.at(-1)!.searchParams.has("statusClass")).toBe(false);

  const exact = page.getByLabel("Status exato");
  const statusClass = page.getByLabel("Classe de status");
  const apply = async (expected: { status?: string; statusClass?: string }) => {
    const response = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/v1/environments/${envId}/requests`);
    await page.getByRole("button", { name: "Filtrar", exact: true }).click();
    const result = await response;
    expect(result.status()).toBe(200);
    const query = new URL(result.url()).searchParams;
    expect(query.get("status")).toBe(expected.status ?? null);
    expect(query.get("statusClass")).toBe(expected.statusClass ?? null);
    expect(query.get("routeId")).toBe(routeId);
    expect(query.get("serviceId")).toBe("6f1d2c3b-4a5e-4f60-8b7c-1d2e3f4a5b6c");
    expect(query.get("consumerId")).toBe("0b7c3c1e-1f2a-4f7e-9c41-0d3c1b2a9e11");
    expect(Date.parse(query.get("to")!) - Date.parse(query.get("from")!)).toBe(24 * 3_600_000);
  };
  await page.getByLabel("Período", { exact: true }).selectOption("24h");
  await page.getByLabel("Service", { exact: true }).selectOption("6f1d2c3b-4a5e-4f60-8b7c-1d2e3f4a5b6c");
  await page.getByLabel("Consumer", { exact: true }).selectOption("0b7c3c1e-1f2a-4f7e-9c41-0d3c1b2a9e11");
  await statusClass.selectOption("5xx");
  await apply({ statusClass: "5xx" });
  await exact.fill("500");
  await expect(statusClass).toBeDisabled();
  await expect(statusClass).toHaveValue("");
  await expect(statusClass).toHaveAccessibleDescription("Limpe o status exato para escolher uma classe.");
  await apply({ status: "500" });

  const audit = await new AxeBuilder({ page }).include('form[aria-label="Filtros de requisições"]').withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(audit.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);

  // Keyboard access still reaches the exact field while the class is disabled.
  await page.getByLabel("Período", { exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(exact).toBeFocused();
  await exact.fill("");
  await expect(statusClass).toBeEnabled();
  await expect(statusClass).toHaveValue("");
  await apply({});
  await statusClass.selectOption("4xx");
  await apply({ statusClass: "4xx" });
  await page.clock.setSystemTime(new Date("2026-11-03T12:01:00Z"));
  await apply({ statusClass: "4xx" });
  await statusClass.selectOption("");
  await apply({});
  expect(queries.length).toBeGreaterThanOrEqual(7);
  for (const url of queries) expect(url.searchParams.has("status") && url.searchParams.has("statusClass"), url.search).toBe(false);
});

test("requisições bloqueia status inválido sem envio e mantém o erro 422 do servidor visível", async ({ page }) => {
  const queries: URL[] = [];
  await page.route("**/api/v1/environments/*/requests?*", (route) => {
    const url = new URL(route.request().url());
    queries.push(url);
    return url.searchParams.has("status")
      ? route.fulfill({ status: 422, json: { title: "Unprocessable Content", status: 422, errors: [{ path: "status", message: "Filtro recusado pelo servidor" }] } })
      : route.fulfill({ json: { items: [], nextCursor: null } });
  });
  await login(page, "viewer");
  await menu(page).getByRole("link", { name: "Requisições" }).click();
  await expect(page.getByRole("heading", { name: "Nenhuma requisição no período." })).toBeVisible();
  const count = queries.length;
  for (const invalid of ["99", "600", "404.5", "abc"]) {
    await page.getByLabel("Status exato").fill(invalid);
    await page.getByRole("button", { name: "Filtrar", exact: true }).click();
    await expect(page.getByLabel("Status exato")).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByLabel("Status exato")).toHaveAccessibleDescription(/100 e 599/);
    await expect(page.getByRole("alert")).toContainText("100 e 599");
    expect(queries).toHaveLength(count);
  }
  const rejected = page.waitForResponse((r) => r.url().includes("/requests?") && r.status() === 422);
  await page.getByLabel("Status exato").fill("404");
  await page.getByRole("button", { name: "Filtrar", exact: true }).click();
  const response = await rejected;
  expect(new URL(response.url()).searchParams.has("statusClass")).toBe(false);
  await expect(page.getByRole("alert")).toContainText("Filtro recusado pelo servidor");
  await expect(page.getByLabel("Status exato")).toHaveValue("404");
  await expect(page.getByRole("heading", { name: "Nenhuma requisição no período." })).toHaveCount(0);
  for (const url of queries) expect(url.searchParams.has("status") && url.searchParams.has("statusClass"), url.search).toBe(false);
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
      await latency.getByLabel("Ver como tabela: Latência total", { exact: true }).focus();
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
