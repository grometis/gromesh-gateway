import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// P2-C2 acceptance against the contract mock: Prism answers the upstream, target and certificate examples.
async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("E-mail").fill("editor@gromesh.dev");
  await page.getByLabel("Senha").fill("s3nha-de-teste");
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("heading", { name: "Services" })).toBeVisible();
}

const menu = (page: Page) => page.getByRole("navigation", { name: "Menu principal" });

test("upstreams: list, consistent hashing with a header, health checks and targets with weight", async ({ page }) => {
  await login(page);
  await menu(page).getByRole("link", { name: "Upstreams" }).click();
  const table = page.getByRole("table", { name: "Upstreams" });
  await expect(table).toContainText("orders.upstream");
  await expect(table).toContainText("Round-robin");
  await expect(table).toContainText("desligada");

  await page.getByRole("button", { name: "Novo upstream" }).click();
  const dialog = page.getByRole("dialog", { name: "Novo upstream" });
  await dialog.getByLabel("Nome").fill("payments.upstream");
  // The hash fields only appear with consistent hashing; a header hash asks for the header name.
  await expect(dialog.getByLabel("Hash por")).toHaveCount(0);
  await dialog.getByLabel("Algoritmo").selectOption("consistent-hashing");
  await dialog.getByLabel("Hash por").selectOption("header");
  await dialog.getByLabel("Header do hash").fill("x-user-id");
  await dialog.getByLabel("Verificação ativa").check();
  await dialog.getByLabel("Path verificado").fill("/healthz");
  await dialog.getByLabel("Verificação passiva (pelo tráfego)").check();
  const created = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/upstreams"));
  await dialog.getByRole("button", { name: "Salvar" }).click();
  expect((await created).postDataJSON()).toMatchObject({
    name: "payments.upstream",
    algorithm: "consistent-hashing",
    hashOn: "header",
    hashOnHeader: "x-user-id",
    healthchecks: {
      active: { type: "http", httpPath: "/healthz", intervalSeconds: 10, healthyThreshold: 2, unhealthyThreshold: 3, timeoutSeconds: 1 },
      passive: { unhealthyHttpFailures: 5, unhealthyTimeouts: 3 },
    },
  });

  // Targets of the upstream: listed with their weight, added with host:port and weight.
  await table.getByRole("button", { name: "Targets" }).first().click();
  const targets = page.getByRole("dialog", { name: "Targets de orders.upstream" });
  await expect(targets.getByRole("table", { name: "Targets" })).toContainText("10.0.0.11:8080");
  await expect(targets.getByLabel("Peso de 10.0.0.11:8080")).toHaveValue("100");
  await targets.getByLabel("Novo target").fill("10.0.0.12:8080");
  await targets.getByLabel("Peso", { exact: true }).fill("0");
  const added = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/targets"));
  await targets.getByRole("button", { name: "Adicionar target" }).click();
  expect((await added).postDataJSON()).toEqual({ target: "10.0.0.12:8080", weight: 0 });
  // Changing a weight replaces the target with the new weight.
  const reweighed = page.waitForRequest((r) => r.method() === "PUT" && r.url().includes("/targets/"));
  await targets.getByLabel("Peso de 10.0.0.11:8080").fill("25");
  await targets.getByLabel("Peso de 10.0.0.11:8080").blur();
  expect((await reweighed).postDataJSON()).toMatchObject({ target: "10.0.0.11:8080", weight: 25 });
});

test("the service form suggests the environment's upstreams for the host", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "Novo service" }).click();
  const dialog = page.getByRole("dialog", { name: "Novo service" });
  await expect(dialog.locator("datalist#upstream-names option")).toHaveAttribute("value", "orders.upstream");
  await dialog.getByLabel("Host").fill("orders.upstream");
  await expect(dialog).toContainText("Balanceado pelo upstream de mesmo nome");
});

test("certificates: upload PEM files and the key is never shown again", async ({ page }) => {
  await login(page);
  await menu(page).getByRole("link", { name: "Certificados" }).click();
  const table = page.getByRole("table", { name: "Certificados" });
  await expect(table).toContainText("api.example.com, *.example.com");
  await expect(table).toContainText("CN=api.example.com");
  await expect(page.getByText(/REDACTED/)).toHaveCount(0);

  await page.getByRole("button", { name: "Novo certificado" }).click();
  const dialog = page.getByRole("dialog", { name: "Novo certificado" });
  const cert = "-----BEGIN CERTIFICATE-----\nMIIBleaf\n-----END CERTIFICATE-----\n";
  const key = "-----BEGIN PRIVATE KEY-----\nMIGHsecret\n-----END PRIVATE KEY-----\n";
  await dialog.getByLabel("Arquivo do certificado").setInputFiles({ name: "tls.pem", mimeType: "application/x-pem-file", buffer: Buffer.from(cert) });
  await expect(dialog.getByLabel("Certificado (PEM)")).toHaveValue(cert);
  await dialog.getByLabel("Arquivo da chave").setInputFiles({ name: "tls.key", mimeType: "application/x-pem-file", buffer: Buffer.from(key) });
  await dialog.getByLabel("SNIs").fill("API.example.com, *.example.com");
  const created = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/certificates"));
  await dialog.getByRole("button", { name: "Salvar" }).click();
  expect((await created).postDataJSON()).toEqual({ cert, key, snis: ["api.example.com", "*.example.com"], tags: [] });

  // Editing never shows the stored key; leaving it blank keeps it ("REDACTED").
  await table.getByRole("button", { name: "Editar" }).first().click();
  const edit = page.getByRole("dialog", { name: "Editar certificado" });
  await expect(edit.getByLabel("Chave privada (PEM)")).toHaveValue("");
  const replaced = page.waitForRequest((r) => r.method() === "PUT" && r.url().includes("/certificates/"));
  await edit.getByRole("button", { name: "Salvar" }).click();
  expect((await replaced).postDataJSON()).toMatchObject({ key: "REDACTED", snis: ["api.example.com", "*.example.com"] });
});

test("a certificate expiring in less than 30 days, or already expired, is flagged in the list", async ({ page }) => {
  const soon = new Date(Date.now() + 10 * 86_400_000).toISOString();
  const past = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const base = { cert: "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n", key: "REDACTED", tags: [], issuer: "CN=Example CA", notBefore: "2026-01-01T00:00:00Z", fingerprintSha256: "AA:".repeat(31) + "AA", createdAt: "2026-10-15T12:00:00Z", updatedAt: "2026-10-15T12:00:00Z" };
  await page.route("**/api/v1/environments/*/certificates", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          json: {
            items: [
              { ...base, id: "1c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e61", snis: ["soon.example.com"], subject: "CN=soon.example.com", notAfter: soon },
              { ...base, id: "1c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e62", snis: ["old.example.com"], subject: "CN=old.example.com", notAfter: past },
            ],
            nextCursor: null,
          },
        })
      : route.fallback(),
  );
  await login(page);
  await menu(page).getByRole("link", { name: "Certificados" }).click();
  const table = page.getByRole("table", { name: "Certificados" });
  await expect(table.getByRole("row", { name: /soon\.example\.com/ })).toContainText(/Expira em (9|10) dia/);
  await expect(table.getByRole("row", { name: /old\.example\.com/ })).toContainText("Expirado em");
});
