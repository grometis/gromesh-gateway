import type { Page } from "@playwright/test";
import { expect, mockSession, test } from "./fixtures";

// P4-C2: the overview screen (strip, four indicators, requests per hour by success/error, top routes) with pinned
// data, at desktop and phone widths; screenshots go to the job's artifact.
const envId = "3f6b8c1e-2a4d-4e5f-8a9b-0c1d2e3f4a5b";
const id = (n: number) => `9a1b2c3d-4e5f-4a6b-8c7d-${String(n).padStart(12, "0")}`;
const environment = { id: envId, name: "Produção", publishMode: "manual", currentVersion: 7, hasUnpublishedChanges: false };
const start = Date.UTC(2026, 9, 17, 0, 0, 0);
// A working day: quiet at night, a morning and an afternoon peak, an error burst at 14h.
const series = Array.from({ length: 24 }, (_, h) => {
  const requests = Math.round(400 + 2600 * Math.exp(-((h - 10) ** 2) / 8) + 2200 * Math.exp(-((h - 16) ** 2) / 6));
  const errors5xx = h === 14 ? 310 : Math.round(requests * 0.004);
  const errors4xx = Math.round(requests * 0.012);
  return { ts: new Date(start + h * 3_600_000).toISOString(), requests, errors4xx, errors5xx, errorRate: (errors4xx + errors5xx) / requests, p50Ms: 18, p95Ms: 84 + (h === 14 ? 140 : 0), p99Ms: 210 };
});
const sum = (k: "requests" | "errors4xx" | "errors5xx") => series.reduce((a, p) => a + p[k], 0);
const totals = { requests: sum("requests"), errors4xx: sum("errors4xx"), errors5xx: sum("errors5xx"), errorRate: (sum("errors4xx") + sum("errors5xx")) / sum("requests"), p50Ms: 19, p95Ms: 96, p99Ms: 230 };
const top = (by: string) => ({
  from: series[0]!.ts, to: new Date(start + 24 * 3_600_000).toISOString(), by,
  items: [
    { routeId: id(1), routeName: "orders-api", serviceId: id(11), requests: 21450, errors4xx: 260, errors5xx: 312, errorRate: 0.0267, p50Ms: 21, p95Ms: 140, p99Ms: 300 },
    { routeId: id(2), routeName: "catalog-public", serviceId: id(12), requests: 15020, errors4xx: 110, errors5xx: 12, errorRate: 0.0081, p50Ms: 12, p95Ms: 61, p99Ms: 120 },
    { routeId: id(3), routeName: "payments-webhook", serviceId: id(13), requests: 4210, errors4xx: 30, errors5xx: 4, errorRate: 0.0081, p50Ms: 40, p95Ms: 190, p99Ms: 400 },
  ],
});
const node = (n: number, appliedVersion: number) => ({ nodeId: `node-${n}`, hostname: `edge-${n}`, state: "applied", appliedVersion, kongHealthy: true, lastSeenAt: "2026-10-17T12:00:00Z", online: true, error: null });

async function openOverview(page: Page) {
  await mockSession(page, { id: id(30), name: "Ana Souza", email: "ana@gromesh.dev", role: "editor", active: true, createdAt: "2026-10-15T12:00:00Z", updatedAt: "2026-10-15T12:00:00Z" });
  await page.route("**/api/v1/environments", (route) => route.fulfill({ json: { items: [environment] } }));
  await page.route(`**/api/v1/environments/${envId}`, (route) => route.fulfill({ json: environment }));
  await page.route("**/api/v1/environments/*/clusters", (route) => route.fulfill({ json: { items: [{ id: id(20), environmentId: envId, name: "edge-sp", status: "converged", createdAt: "2026-10-15T12:00:00Z", nodes: [node(1, 7), node(2, 7), node(3, 7)] }] } }));
  await page.route("**/api/v1/environments/*/analytics/summary*", (route) => route.fulfill({ json: { from: series[0]!.ts, to: top("requests").to, interval: "1h", totals, series } }));
  await page.route("**/api/v1/environments/*/analytics/top-routes*", (route) => route.fulfill({ json: top(new URL(route.request().url()).searchParams.get("by") ?? "requests") }));
  await page.goto("/login");
  await page.getByLabel("E-mail").fill("ana@gromesh.dev");
  await page.getByLabel("Senha").fill("s3nha-de-teste");
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("heading", { name: "Services" })).toBeVisible();
  await page.getByRole("navigation", { name: "Menu principal" }).getByRole("link", { name: "Visão geral" }).click();
  await expect(page.getByRole("heading", { name: "Visão geral" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Top rotas" })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

for (const viewport of [{ name: "desktop-1440", width: 1440, height: 900 }, { name: "mobile-390", width: 390, height: 844 }]) {
  test(`overview, ${viewport.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openOverview(page);
    const tiles = page.getByRole("definition");
    await expect(page.getByLabel("Indicadores das últimas 24 horas")).toContainText(totals.requests.toLocaleString("pt-BR"));
    await expect(tiles.filter({ hasText: "3/3" })).toBeVisible();
    await expect(page.getByRole("img", { name: /Requisições por hora/ })).toBeVisible();
    const nothing = page.getByRole("region", { name: "Publicação" }).getByRole("button", { name: "Nada para publicar" });
    await expect(nothing).toBeDisabled();
    await expect(nothing).toHaveCSS("background-color", "rgb(228, 236, 234)");
    await expect(nothing).toHaveCSS("color", "rgb(111, 132, 129)");
    await expect(page.getByRole("list", { name: "Legenda" })).toContainText("Sucesso");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    const dir = testInfo.config.rootDir.replace(/\/e2e$/, "") + "/test-results/screenshots";
    await page.screenshot({ path: `${dir}/overview-${viewport.name}.png`, fullPage: true });
  });
}

test("the chart's values are readable as a table, hovering a column shows its hour, and top routes follow the selector", async ({ page }) => {
  await openOverview(page);
  await page.getByText("Ver como tabela").click();
  const table = page.getByRole("table", { name: "Requisições por hora" });
  await expect(table.getByRole("row")).toHaveCount(25);
  const peak = series[14]!;
  await expect(table.getByRole("row").nth(15)).toContainText((peak.errors4xx + peak.errors5xx).toLocaleString("pt-BR"));

  const plot = page.getByRole("img", { name: /Requisições por hora/ });
  const box = (await plot.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
  await expect(page.locator(".chart-tooltip")).toBeVisible();
  await expect(page.locator(".chart-tooltip")).toContainText("sucesso");

  const request = page.waitForRequest((r) => r.url().includes("/analytics/top-routes") && r.url().includes("by=errors"));
  await page.getByLabel("Critério").selectOption("errors");
  await request;
  await expect(page.getByRole("table", { name: "Top rotas" })).toContainText("orders-api");
});
