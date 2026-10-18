import type { Page } from "@playwright/test";
import { expect, mockSession, test } from "./fixtures";

// P4-C2: clusters as cards, a bar segment per node, the node table; a failed node says it keeps serving the last good
// version and shows the gateway's error. Screenshots at 1440 and 390 for the job's artifact.
const envId = "3f6b8c1e-2a4d-4e5f-8a9b-0c1d2e3f4a5b";
const id = (n: number) => `9a1b2c3d-4e5f-4a6b-8c7d-${String(n).padStart(12, "0")}`;
const environment = { id: envId, name: "Produção", publishMode: "manual", currentVersion: 8, hasUnpublishedChanges: false };
const node = (n: number, appliedVersion: number | null, extra: object = {}) => ({
  nodeId: `edge-sp-${n}-7f3c2a`, hostname: `edge-sp-${n}`, kongVersion: "3.9.4", agentVersion: "0.4.0", state: "applied", appliedVersion,
  kongHealthy: true, lastSeenAt: "2026-10-17T12:00:00Z", online: true, error: null as string | null, ...extra,
});
const clusters = [
  {
    id: id(1), environmentId: envId, name: "edge-sp", status: "degraded", createdAt: "2026-10-15T12:00:00Z",
    nodes: [node(1, 8), node(2, 8), node(3, 7, { state: "failed", error: "declarative config is invalid: {routes={{paths={\"invalid path\"}}}}" }), node(4, 8, { online: false, lastSeenAt: "2026-10-17T09:12:00Z" })],
  },
  { id: id(2), environmentId: envId, name: "edge-rj", status: "converged", createdAt: "2026-10-16T12:00:00Z", nodes: [node(5, 8), node(6, 8)] },
  { id: id(3), environmentId: envId, name: "edge-poa", status: "no-nodes", createdAt: "2026-10-17T10:00:00Z", nodes: [] },
];

async function openClusters(page: Page) {
  await mockSession(page, { id: id(30), name: "Ana Souza", email: "ana@gromesh.dev", role: "admin", active: true, createdAt: "2026-10-15T12:00:00Z", updatedAt: "2026-10-15T12:00:00Z" });
  await page.route("**/api/v1/environments", (route) => route.fulfill({ json: { items: [environment] } }));
  await page.route(`**/api/v1/environments/${envId}`, (route) => route.fulfill({ json: environment }));
  await page.route("**/api/v1/environments/*/clusters", (route) => route.fulfill({ json: { items: clusters } }));
  await page.goto("/login");
  await page.getByLabel("E-mail").fill("ana@gromesh.dev");
  await page.getByLabel("Senha").fill("s3nha-de-teste");
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("heading", { name: "Services" })).toBeVisible();
  await page.getByRole("navigation", { name: "Menu principal" }).getByRole("link", { name: "Clusters" }).click();
  await expect(page.getByRole("region", { name: "Cluster edge-sp" })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

for (const viewport of [{ name: "desktop-1440", width: 1440, height: 900 }, { name: "mobile-390", width: 390, height: 844 }]) {
  test(`clusters, ${viewport.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openClusters(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    const dir = testInfo.config.rootDir.replace(/\/e2e$/, "") + "/test-results/screenshots";
    await page.screenshot({ path: `${dir}/clusters-${viewport.name}.png`, fullPage: true });
  });
}

test("each cluster shows its nodes against the live version, and a failed node keeps serving the last good one", async ({ page }) => {
  await openClusters(page);
  const sp = page.getByRole("region", { name: "Cluster edge-sp" });
  await expect(sp).toContainText("2/3 nós online na versão no ar v8");
  await expect(sp).toContainText("1 offline");
  const bar = sp.getByRole("list", { name: "Nós de edge-sp" }).getByRole("listitem");
  await expect(bar).toHaveCount(4);
  await expect(bar.nth(2)).toContainText("edge-sp-3: Falhou ao aplicar");
  await expect(bar.nth(3)).toContainText("edge-sp-4: Offline");

  const failed = sp.getByRole("table", { name: "Nós do cluster edge-sp" }).getByRole("row").filter({ hasText: "edge-sp-3" });
  await expect(failed).toContainText("Segue servindo v7, a última versão boa.");
  await expect(failed).toContainText('Erro do gateway: declarative config is invalid: {routes={{paths={"invalid path"}}}}');

  await expect(page.getByRole("region", { name: "Cluster edge-rj" })).toContainText("2/2 nós online na versão no ar v8");
  await expect(page.getByRole("region", { name: "Cluster edge-poa" })).toContainText("Nenhum nó registrado");
});
