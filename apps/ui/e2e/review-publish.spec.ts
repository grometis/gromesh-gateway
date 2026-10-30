import type { Page } from "@playwright/test";
import { expect, mockSession, test } from "./fixtures";

// P4-C2: review and publish. Changes on the left, the selected one field by field (live version × draft) on the
// right, the REDACTED note, message + publish, and the rollback sentence; screenshots for the job's artifact.
const envId = "3f6b8c1e-2a4d-4e5f-8a9b-0c1d2e3f4a5b";
const id = (n: number) => `9a1b2c3d-4e5f-4a6b-8c7d-${String(n).padStart(12, "0")}`;
const environment = { id: envId, name: "Produção", publishMode: "manual", currentVersion: 7, hasUnpublishedChanges: true };
const changes = [
  {
    kind: "services", id: id(1), label: "orders", change: "modified",
    before: { id: id(1), name: "orders", protocol: "http", host: "orders.internal", port: 8080, retries: 5, read_timeout: 60000, tags: ["managed-by:gromesh"] },
    after: { id: id(1), name: "orders", protocol: "https", host: "orders.internal", port: 8443, retries: 5, read_timeout: 60000, tags: ["managed-by:gromesh"] },
  },
  { kind: "routes", id: id(2), label: "payments-api", change: "added", after: { id: id(2), name: "payments-api", service: id(3), paths: ["/payments"], strip_path: true, tags: ["managed-by:gromesh"] } },
  {
    kind: "plugins", id: id(4), label: "rate-limiting", change: "modified",
    before: { id: id(4), name: "rate-limiting", config: { minute: 60, policy: "redis", redis: { host: "redis.internal", password: "REDACTED" } } },
    after: { id: id(4), name: "rate-limiting", config: { minute: 120, policy: "redis", redis: { host: "redis.internal", password: "REDACTED" } } },
  },
  { kind: "keyauth_credentials", id: id(5), label: "key-auth credential of consumer partner", change: "removed", before: { id: id(5), consumer: id(6), key: "REDACTED" } },
];

async function openReview(page: Page) {
  await mockSession(page, { id: id(30), name: "Ana Souza", email: "ana@gromesh.dev", role: "editor", active: true, createdAt: "2026-10-15T12:00:00Z", updatedAt: "2026-10-15T12:00:00Z" });
  await page.route("**/api/v1/environments", (route) => route.fulfill({ json: { items: [environment] } }));
  await page.route(`**/api/v1/environments/${envId}`, (route) => route.fulfill({ json: environment }));
  await page.route("**/api/v1/environments/*/clusters", (route) => route.fulfill({ json: { items: [] } }));
  await page.route("**/api/v1/environments/*/publish-preview", (route) => route.fulfill({ json: { currentVersion: 7, draftHash: `sha256:${"b".repeat(64)}`, hasChanges: true, changes } }));
  await page.goto("/login");
  await page.getByLabel("E-mail").fill("ana@gromesh.dev");
  await page.getByLabel("Senha").fill("s3nha-de-teste");
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("heading", { name: "Services" })).toBeVisible();
  await page.getByRole("navigation", { name: "Menu principal" }).getByRole("link", { name: "Publicações", exact: true }).click();
  await page.getByRole("region", { name: "Publicação" }).getByRole("link", { name: "Ver diff" }).click();
  await expect(page.getByRole("heading", { name: "Revisar e publicar" })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

for (const viewport of [{ name: "desktop-1440", width: 1440, height: 900 }, { name: "mobile-390", width: 390, height: 844 }]) {
  test(`review and publish, ${viewport.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openReview(page);
    const review = page.getByRole("region", { name: "Revisar e publicar" });
    await expect(review.getByRole("list", { name: "Alterações" }).getByRole("listitem")).toHaveCount(4);
    await expect(review.getByRole("button", { name: "Publicar v8" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Publicação" })).toContainText("nenhum nó online");
    if (viewport.width < 600) {
      // Phones list only the changed fields, as "campo: antes → depois".
      const changed = review.getByRole("list", { name: "Campos alterados" }).getByRole("listitem");
      await expect(changed).toHaveText(["port: 8080 → 8443", 'protocol: "http" → "https"']);
      await expect(review.locator("table.diff-fields")).toBeHidden();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    const dir = testInfo.config.rootDir.replace(/\/e2e$/, "") + "/test-results/screenshots";
    await page.screenshot({ path: `${dir}/review-publish-${viewport.name}.png`, fullPage: true });
  });
}

test("the selected change shows field by field what differs from the live version", async ({ page }) => {
  await openReview(page);
  const review = page.getByRole("region", { name: "Revisar e publicar" });
  const diff = review.getByRole("region", { name: "Diff de Service orders" });
  await expect(diff).toContainText("2 campos alterados");
  await expect(diff.locator("tr.changed")).toHaveCount(2);
  await expect(diff.locator("tr.changed").first()).toContainText("port");
  await expect(diff.locator("tr.changed").first().locator("td.before del")).toHaveText("8080");
  await expect(diff.locator("tr.changed").first().locator("td.after ins")).toHaveText("8443");
  await expect(diff.locator("tr.changed").first().locator("td.before")).toHaveCSS("background-color", "rgb(255, 241, 236)");
  await expect(diff.locator("tr.changed").first().locator("td.after")).toHaveCSS("background-color", "rgb(227, 242, 239)");
  await expect(diff.locator("tr.same").filter({ hasText: "host" })).toContainText('"orders.internal"');

  // Nested config fields are compared one by one; a secret stays REDACTED on both sides and is not a change.
  await review.getByRole("button", { name: /Plugin rate-limiting/ }).click();
  const plugin = review.getByRole("region", { name: "Diff de Plugin rate-limiting" });
  await expect(plugin.locator("tr.changed")).toHaveCount(1);
  await expect(plugin.locator("tr.changed")).toContainText("config.minute");
  await expect(plugin.locator("tr.same").filter({ hasText: "config.redis.password" })).toContainText("REDACTED");
  await expect(review).toContainText("Segredos aparecem como REDACTED");
  await expect(review).toContainText("o rollback publica uma nova versão com o conteúdo antigo");

  // Labels are pt-BR end to end, rebuilt from the compiler's English ones.
  await expect(review.getByRole("list", { name: "Alterações" })).toContainText("Credencial key-auth do consumer partner");
  await expect(review.getByRole("list", { name: "Alterações" })).not.toContainText("credential of");
  await review.getByRole("button", { name: /Credencial key-auth/ }).click();
  await expect(review.getByRole("region", { name: "Diff de Credencial key-auth do consumer partner" })).toContainText("Sai do gateway quando você publicar.");
});

test("publishing sends the message and the expected version, then opens Publicações", async ({ page }) => {
  await openReview(page);
  await page.route("**/api/v1/environments/*/snapshots", (route) =>
    route.request().method() === "POST" ? route.fulfill({ status: 201, json: { version: 8, hash: `sha256:${"b".repeat(64)}`, environmentId: envId, createdAt: "2026-10-17T12:00:00Z", message: "Porta 8443" } }) : route.fallback(),
  );
  const review = page.getByRole("region", { name: "Revisar e publicar" });
  await review.getByLabel("Mensagem (opcional)").fill("Porta 8443");
  const posted = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/snapshots"));
  await review.getByRole("button", { name: "Publicar v8" }).click();
  expect((await posted).postDataJSON()).toEqual({ message: "Porta 8443", expectedCurrentVersion: 7 });
  await expect(page).toHaveURL(new RegExp(`/e/${envId}/publications$`));
});
