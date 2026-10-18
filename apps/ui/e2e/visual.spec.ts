import type { Page } from "@playwright/test";
import { expect, mockSession, test } from "./fixtures";

// P4-C1: the "Contraste" identity on Services and on the publish strip, at desktop and phone widths. The data is
// pinned (Prism's examples would vary by field), and the screenshots are uploaded as the job's artifact for review.
const envId = "3f6b8c1e-2a4d-4e5f-8a9b-0c1d2e3f4a5b";
const id = (n: number) => `9a1b2c3d-4e5f-4a6b-8c7d-${String(n).padStart(12, "0")}`;
const environment = { id: envId, name: "Produção", publishMode: "manual", currentVersion: 3, hasUnpublishedChanges: true };
const service = (n: number, name: string, host: string, port: number, extra: object = {}) => ({
  id: id(n), name, protocol: "http", host, port, path: null, enabled: true, tags: [], createdAt: "2026-10-15T12:00:00Z", updatedAt: "2026-10-15T12:00:00Z", ...extra,
});
const services = [
  service(1, "catalog", "catalog.internal", 8080),
  service(2, "checkout", "checkout.upstream", 80),
  service(3, "orders", "orders.internal", 8443, { protocol: "https", path: "/v2" }),
  service(4, "payments", "payments.internal", 9000),
  service(5, "legacy-reports", "reports.legacy.internal", 8080, { enabled: false }),
];
const changes = [
  { kind: "services", id: id(4), label: "payments", change: "added", after: {} },
  { kind: "services", id: id(3), label: "orders", change: "modified", before: {}, after: {} },
  { kind: "routes", id: id(9), label: "payments-api", change: "added", after: {} },
];
const node = (n: number, appliedVersion: number) => ({ nodeId: `node-${n}`, hostname: `edge-${n}`, state: "applied", appliedVersion, kongHealthy: true, lastSeenAt: "2026-10-17T12:00:00Z", online: true, error: null as string | null });
const converging = [{ id: id(20), environmentId: envId, name: "edge-sp", status: "converging", createdAt: "2026-10-15T12:00:00Z", nodes: [node(1, 3), node(2, 3), node(3, 2)] }];

async function openServices(page: Page, clusters = converging) {
  await mockSession(page, { id: id(30), name: "Ana Souza", email: "ana@gromesh.dev", role: "editor", active: true, createdAt: "2026-10-15T12:00:00Z", updatedAt: "2026-10-15T12:00:00Z" });
  await page.route("**/api/v1/environments", (route) => route.fulfill({ json: { items: [environment, { ...environment, id: id(40), name: "Homologação" }] } }));
  await page.route(`**/api/v1/environments/${envId}`, (route) => route.fulfill({ json: environment }));
  await page.route("**/api/v1/environments/*/services*", (route) => route.fulfill({ json: { items: services, nextCursor: null } }));
  await page.route("**/api/v1/environments/*/publish-preview", (route) => route.fulfill({ json: { currentVersion: 3, draftHash: `sha256:${"a".repeat(64)}`, hasChanges: true, changes } }));
  await page.route("**/api/v1/environments/*/clusters", (route) => route.fulfill({ json: { items: clusters } }));
  await page.goto("/login");
  await page.getByLabel("E-mail").fill("ana@gromesh.dev");
  await page.getByLabel("Senha").fill("s3nha-de-teste");
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("heading", { name: "Services" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Services" }).getByRole("row")).toHaveCount(services.length + 1);
  await page.evaluate(() => document.fonts.ready);
}

for (const viewport of [{ name: "desktop-1440", width: 1440, height: 900 }, { name: "mobile-390", width: 390, height: 844 }]) {
  test(`Services and the publish strip, ${viewport.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openServices(page);
    const strip = page.getByRole("region", { name: "Publicação" });
    await expect(strip).toContainText("3 alterações");
    await expect(strip.getByRole("button", { name: "Publicar v4" })).toBeEnabled();
    await expect(strip).toContainText("v3");
    await expect(strip).toContainText("2/3");
    await expect(strip).toContainText("convergindo");
    const rows = page.getByRole("table", { name: "Services" }).getByRole("row");
    await expect(rows.filter({ hasText: "payments" })).toContainText("Novo");
    await expect(rows.filter({ hasText: "orders" })).toContainText("Alterado");
    await expect(page.getByRole("button", { name: "Com alterações 2" })).toBeVisible();
    await expect(rows.filter({ hasText: "legacy-reports" })).toContainText("Desativado");
    // The accent is only for publishing: the screen's main action is the ink outline.
    await expect(page.getByRole("button", { name: "Novo service" })).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await expect(strip.getByRole("button", { name: "Publicar v4" })).toHaveCSS("background-color", "rgb(201, 58, 30)");

    // No horizontal page scroll: only wide tables scroll, inside their own container.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    const dir = testInfo.config.rootDir.replace(/\/e2e$/, "") + "/test-results/screenshots";
    await page.screenshot({ path: `${dir}/services-${viewport.name}.png`, fullPage: true });
    await strip.screenshot({ path: `${dir}/publish-strip-${viewport.name}.png` });

    await page.getByRole("button", { name: "Com alterações 2" }).click();
    await expect(rows).toHaveCount(3);
    await expect(page.getByRole("button", { name: "Com alterações 2" })).toHaveAttribute("aria-pressed", "true");
  });
}

test("a degraded rollout is written in the strip, not only coloured", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const failed = { ...node(3, 2), state: "failed", error: "invalid configuration" };
  await openServices(page, [{ ...converging[0]!, status: "degraded", nodes: [node(1, 3), node(2, 3), failed] }]);
  const strip = page.getByRole("region", { name: "Publicação" });
  await expect(strip).toContainText("2/3 nós");
  await expect(strip.getByText("degradado", { exact: true })).toBeVisible();
  const dir = testInfo.config.rootDir.replace(/\/e2e$/, "") + "/test-results/screenshots";
  await strip.screenshot({ path: `${dir}/publish-strip-degraded-desktop-1440.png` });
});

test("a service row opens its detail; Editar is quiet and Excluir lives in the keyboard-operable ⋯ menu", async ({ page }) => {
  await page.route(`**/api/v1/environments/*/services/${id(3)}`, (route) => route.fulfill({ json: services[2] }));
  await openServices(page);
  const row = page.getByRole("table", { name: "Services" }).getByRole("row").filter({ hasText: "orders" });
  await expect(row.getByRole("button", { name: "Editar" })).toBeVisible();
  await expect(row.getByRole("button", { name: "Excluir" })).toHaveCount(0);
  const more = row.getByRole("button", { name: "Mais ações para orders" });
  await expect(more).toHaveAttribute("aria-haspopup", "menu");
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(more).toHaveAttribute("aria-expanded", "true");
  const remove = page.getByRole("menuitem", { name: "Excluir" });
  await expect(remove).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(more).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Excluir service" })).toContainText("orders");
  await page.getByRole("dialog", { name: "Excluir service" }).getByRole("button", { name: "Cancelar" }).click();

  // Clicking anywhere on the row (not only the name) opens the service.
  const target = (await row.locator(".target").boundingBox())!;
  await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("orders");
  await expect(page.getByText("https://orders.internal:8443/v2")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Plugins do service" })).toBeVisible();
});
