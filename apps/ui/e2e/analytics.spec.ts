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
  await menu(page).getByRole("link", { name: "Dashboard" }).click();
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

  // A 7-day period asks for hourly buckets.
  const weekly = page.waitForRequest((r) => r.url().includes("interval=1h"));
  await page.getByLabel("Período", { exact: true }).selectOption("7d");
  await weekly;
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

test("o dashboard explica quando o coletor está fora do ar", async ({ page }) => {
  await page.route("**/api/v1/environments/*/analytics/summary?*", (route) =>
    route.fulfill({ status: 502, contentType: "application/problem+json", body: JSON.stringify({ type: "https://gromesh.dev/problems/502", title: "Bad Gateway", status: 502, detail: "Analytics store is unavailable" }) }),
  );
  await login(page);
  await menu(page).getByRole("link", { name: "Dashboard" }).click();
  await expect(page.getByRole("alert")).toContainText("não estão disponíveis");
});
