import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, mockSession, test } from "./fixtures";

// P4-C2: the consumer screen. Tabs Credenciais / Grupos ACL / Plugins; credential cards carry only hints; a new
// secret is shown once with Copiar and "Já copiei". Screenshots at 1440 and 390 for the job's artifact.
test.use({ permissions: ["clipboard-read", "clipboard-write"] });

const envId = "3f6b8c1e-2a4d-4e5f-8a9b-0c1d2e3f4a5b";
const id = (n: number) => `9a1b2c3d-4e5f-4a6b-8c7d-${String(n).padStart(12, "0")}`;
const consumerId = id(1);
const environment = { id: envId, name: "Produção", publishMode: "manual", currentVersion: 8, hasUnpublishedChanges: false };
const consumer = { id: consumerId, username: "partner-acme", customId: "acme-001", tags: ["partners"], createdAt: "2026-10-15T12:00:00Z", updatedAt: "2026-10-15T12:00:00Z" };
const created = "2026-10-16T14:30:00Z";
const secret = "aHMyNTYtc2VjcmV0LXNob3duLW9uY2Utb25seS0xMjM0NTY";

async function openConsumer(page: Page) {
  await mockSession(page, { id: id(30), name: "Ana Souza", email: "ana@gromesh.dev", role: "editor", active: true, createdAt: "2026-10-15T12:00:00Z", updatedAt: "2026-10-15T12:00:00Z" });
  await page.route("**/api/v1/environments", (route) => route.fulfill({ json: { items: [environment] } }));
  await page.route(`**/api/v1/environments/${envId}`, (route) => route.fulfill({ json: environment }));
  await page.route("**/api/v1/environments/*/clusters", (route) => route.fulfill({ json: { items: [] } }));
  await page.route(`**/api/v1/environments/*/consumers/${consumerId}`, (route) => route.fulfill({ json: consumer }));
  await page.route(`**/api/v1/environments/*/consumers/${consumerId}/key-auth`, (route) =>
    route.fulfill({ json: { items: [{ id: id(2), consumerId, keyHint: "…k9Qa", tags: [], createdAt: created }, { id: id(3), consumerId, keyHint: "…7Tz1", tags: [], createdAt: created }] } }),
  );
  await page.route(`**/api/v1/environments/*/consumers/${consumerId}/jwt`, (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 201, json: { id: id(6), consumerId, key: "acme-mobile", algorithm: "HS256", tags: [], createdAt: created, secret } })
      : route.fulfill({ json: { items: [{ id: id(4), consumerId, key: "acme-backend", algorithm: "RS256", rsaPublicKey: "-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----\n", tags: [], createdAt: created }] } }),
  );
  await page.route(`**/api/v1/environments/*/consumers/${consumerId}/basic-auth`, (route) => route.fulfill({ json: { items: [{ id: id(5), consumerId, username: "acme-legacy", tags: [], createdAt: created }] } }));
  await page.route(`**/api/v1/environments/*/consumers/${consumerId}/acl-groups`, (route) => route.fulfill({ json: { groups: ["gold", "partners"] } }));
  await page.goto("/login");
  await page.getByLabel("E-mail").fill("ana@gromesh.dev");
  await page.getByLabel("Senha").fill("s3nha-de-teste");
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("heading", { name: "Services" })).toBeVisible();
  await page.goto(`/e/${envId}/consumers/${consumerId}`);
  await expect(page.getByRole("heading", { name: "Consumer partner-acme" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Credenciais basic-auth" })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

for (const viewport of [{ name: "desktop-1440", width: 1440, height: 900 }, { name: "mobile-390", width: 390, height: 844 }]) {
  test(`consumer, ${viewport.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openConsumer(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    await expect(page.getByRole("region", { name: "Publicação" })).toContainText("nenhum nó online");
    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);
    const dir = testInfo.config.rootDir.replace(/\/e2e$/, "") + "/test-results/screenshots";
    await page.screenshot({ path: `${dir}/consumer-${viewport.name}.png`, fullPage: true });
  });
}

test("credential cards show only hints; a new secret is shown once with Copiar and Já copiei; tabs reach groups and plugins", async ({ page }) => {
  await openConsumer(page);
  const tabs = page.getByRole("tablist", { name: "Seções do consumer" });
  await expect(tabs.getByRole("tab")).toHaveText(["Credenciais", "Grupos ACL", "Plugins"]);
  const panel = page.getByRole("tabpanel", { name: "Credenciais" });
  await expect(panel.getByRole("list", { name: "Chaves" }).getByRole("listitem")).toHaveText([/…k9Qa/, /…7Tz1/]);
  await expect(panel.getByRole("list", { name: "Credenciais JWT" })).toContainText("acme-backend");
  await expect(panel.getByRole("list", { name: "Credenciais JWT" })).toContainText("RS256");
  await expect(panel.getByRole("list", { name: "Credenciais basic-auth" })).toContainText("acme-legacy");
  await expect(panel.getByRole("button", { name: "Mais ações para a chave …k9Qa" })).toHaveAttribute("aria-haspopup", "menu");

  await panel.getByRole("button", { name: "Nova credencial JWT" }).click();
  await page.getByRole("dialog", { name: "Nova credencial JWT" }).getByRole("button", { name: "Criar" }).click();
  const shown = page.getByRole("dialog", { name: "Credencial JWT criada" });
  await expect(shown.getByLabel("Segredo")).toHaveText(secret);
  await shown.getByRole("button", { name: "Copiar" }).click();
  await expect(shown.getByRole("button", { name: "Copiado" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(secret);
  await shown.getByRole("button", { name: "Já copiei" }).click();
  await expect(shown).toBeHidden();
  await expect(page.getByText(secret)).toHaveCount(0);

  await tabs.getByRole("tab", { name: "Grupos ACL" }).click();
  await expect(page.getByRole("list", { name: "Grupos" })).toContainText("gold");
  await tabs.getByRole("tab", { name: "Plugins" }).click();
  await expect(page.getByRole("heading", { name: "Plugins do consumer" })).toBeVisible();
});

test("decision H-14: no field takes a key or an HS256 secret; a pending credential is reprovisioned and shown once", async ({ page }) => {
  const rotatedKey = "cm90YXRlZC1rZXktc2hvd24tb25jZS1vbmx5LTEyMzQ1Ng";
  await openConsumer(page);
  // A credential an import brought without its key, and the rotation that gives it one.
  await page.route(`**/api/v1/environments/*/consumers/${consumerId}/key-auth`, (route) =>
    route.fulfill({ json: { items: [{ id: id(7), consumerId, keyHint: null, status: "pending-reprovision", tags: [], createdAt: created }] } }),
  );
  await page.route(`**/api/v1/environments/*/consumers/${consumerId}/key-auth/${id(7)}/rotate`, (route) =>
    route.fulfill({ json: { id: id(7), consumerId, keyHint: "…3456", status: "active", tags: [], createdAt: created, key: rotatedKey } }),
  );
  await page.reload();
  const panel = page.getByRole("tabpanel", { name: "Credenciais" });
  const keys = panel.getByRole("list", { name: "Chaves" });
  await expect(keys.getByRole("listitem")).toHaveText([/Pendente de reprovisionamento/]);

  // Creation forms: nothing to type a key or an HS256 secret into.
  await panel.getByRole("button", { name: "Gerar chave" }).click();
  const newKey = page.getByRole("dialog", { name: "Gerar chave" });
  await expect(newKey.getByRole("textbox")).toHaveCount(0);
  await expect(newKey).toContainText("O servidor gera uma chave");
  await newKey.getByRole("button", { name: "Cancelar" }).click();
  await panel.getByRole("button", { name: "Nova credencial JWT" }).click();
  const newJwt = page.getByRole("dialog", { name: "Nova credencial JWT" });
  await expect(newJwt.getByLabel("Segredo")).toHaveCount(0);
  await expect(newJwt).toContainText("O segredo é gerado pelo servidor");
  await newJwt.getByRole("button", { name: "Cancelar" }).click();

  // Reprovisioning: confirmed, shown once, gone after closing.
  await panel.getByRole("button", { name: "Mais ações para a chave pendente" }).click();
  await page.getByRole("menuitem", { name: "Gerar nova chave" }).click();
  const confirm = page.getByRole("dialog", { name: "Gerar nova chave" });
  await expect(confirm).toContainText("importada sem o valor");
  await confirm.getByRole("button", { name: "Gerar" }).click();
  const shown = page.getByRole("dialog", { name: "Gerar nova chave" });
  await expect(shown.getByLabel("Chave")).toHaveText(rotatedKey);
  await expect(shown.getByRole("note")).toContainText("não será mostrada de novo");
  await shown.getByRole("button", { name: "Já copiei" }).click();
  await expect(page.getByText(rotatedKey)).toHaveCount(0);
  const stored = await page.evaluate(() => JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage }));
  expect(stored).not.toContain(rotatedKey);
});

test("rotating an HS256 secret shows the new secret, not the credential's issuer", async ({ page }) => {
  const rotatedSecret = "bmV3LWhzMjU2LXNlY3JldC1zaG93bi1vbmNlLTEyMzQ1Ng";
  await openConsumer(page);
  await page.route(`**/api/v1/environments/*/consumers/${consumerId}/jwt`, (route) =>
    route.fulfill({ json: { items: [{ id: id(8), consumerId, key: "acme-hs-issuer", algorithm: "HS256", status: "pending-reprovision", tags: [], createdAt: created }] } }),
  );
  await page.route(`**/api/v1/environments/*/consumers/${consumerId}/jwt/${id(8)}/rotate`, (route) =>
    route.fulfill({ json: { id: id(8), consumerId, key: "acme-hs-issuer", algorithm: "HS256", status: "active", tags: [], createdAt: created, secret: rotatedSecret } }),
  );
  await page.reload();
  const panel = page.getByRole("tabpanel", { name: "Credenciais" });
  await expect(panel.getByRole("list", { name: "Credenciais JWT" })).toContainText("Pendente de reprovisionamento");
  await panel.getByRole("button", { name: "Mais ações para a credencial JWT acme-hs-issuer" }).click();
  await page.getByRole("menuitem", { name: "Gerar novo segredo" }).click();
  await page.getByRole("dialog", { name: "Gerar novo segredo" }).getByRole("button", { name: "Gerar" }).click();
  const shown = page.getByRole("dialog", { name: "Gerar novo segredo" });
  await expect(shown.getByLabel("Segredo")).toHaveText(rotatedSecret);
  await shown.getByRole("button", { name: "Já copiei" }).click();
  await expect(page.getByText(rotatedSecret)).toHaveCount(0);
});
