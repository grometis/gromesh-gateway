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
  await expect(table).toHaveClass("cards");
  await expect(table.locator(".service-route .service-name")).toHaveText("orders.upstream");
  await expect(table.locator(".badge.off")).toHaveText("desligada");
  await expect(table.locator(".target.mono")).toHaveText("Round-robin");

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
  await expect(targets.getByRole("table", { name: "Targets" })).toHaveClass("cards");
  await expect(targets.getByLabel("Peso de 10.0.0.11:8080")).toHaveClass(/mono/);
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

test("the service form offers the workspace's upstreams or a direct DNS destination", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "Novo service" }).click();
  const dialog = page.getByRole("dialog", { name: "Novo service" });
  await expect(dialog.getByLabel("Destino", { exact: true })).toHaveValue("dns");
  await expect(dialog.getByLabel("Host")).toBeVisible();
  await dialog.getByLabel("Destino", { exact: true }).selectOption("Upstream do Workspace");
  await expect(dialog.getByLabel("Host")).toHaveCount(0);
  await dialog.getByLabel("Upstream", { exact: true }).selectOption({ label: "orders.upstream" });
  await expect(dialog).toContainText("O host do service passa a ser orders.upstream");
  const created = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/services"));
  await dialog.getByLabel("Nome").fill("orders");
  await dialog.getByRole("button", { name: "Salvar" }).click();
  expect((await created).postDataJSON()).toMatchObject({ name: "orders", host: "orders.upstream", upstreamId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
});

test("certificates: upload PEM files and the key is never shown again", async ({ page }) => {
  await login(page);
  await menu(page).getByRole("link", { name: "Certificados" }).click();
  const table = page.getByRole("table", { name: "Certificados" });
  await expect(table).toContainText("api.example.com, *.example.com");
  await expect(table).toContainText("CN=api.example.com");
  await expect(table).toHaveClass("cards");
  await expect(table.locator(".service-name.mono")).toHaveText("CN=api.example.com");
  await expect(table.locator(".target.mono")).toHaveText("api.example.com, *.example.com");
  await expect(table).toContainText("CN=Example CA");
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
  await expect(table.getByRole("row", { name: /soon\.example\.com/ }).locator(".badge.warning")).toBeVisible();
  await expect(table.getByRole("row", { name: /old\.example\.com/ }).locator(".badge.danger")).toBeVisible();
});

test("upstream and certificate row menus keep deletion behind an outlined confirmation", async ({ page }) => {
  await login(page);
  for (const screen of [
    { link: "Upstreams", name: "orders.upstream", dialog: "Excluir upstream" },
    { link: "Certificados", name: "CN=api.example.com", dialog: "Excluir certificado" },
  ]) {
    await menu(page).getByRole("link", { name: screen.link, exact: true }).click();
    const table = page.getByRole("table", { name: screen.link, exact: true });
    await table.getByRole("button", { name: `Mais ações para ${screen.name}`, exact: true }).focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitem", { name: "Excluir", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: screen.dialog, exact: true });
    await expect(dialog).toContainText(screen.link === "Upstreams" ? screen.name : "api.example.com");
    await expect(dialog.getByRole("button", { name: "Excluir", exact: true })).toHaveClass("danger");
    await expect(dialog.getByRole("button", { name: "Excluir", exact: true })).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await dialog.getByRole("button", { name: "Cancelar", exact: true }).click();
    await expect(dialog).toBeHidden();
  }
});

test("removing a target requires confirmation, preserves cancellation and sends the same DELETE", async ({ page }) => {
  await login(page);
  await menu(page).getByRole("link", { name: "Upstreams", exact: true }).click();
  await page.getByRole("table", { name: "Upstreams" }).getByRole("button", { name: "Targets", exact: true }).first().click();
  const targets = page.getByRole("dialog", { name: "Targets de orders.upstream", exact: true });
  const deletes: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "DELETE" && request.url().includes("/targets/")) deletes.push(request.url());
  });
  await targets.getByRole("button", { name: "Remover", exact: true }).first().click();
  const confirm = page.getByRole("dialog", { name: "Remover target", exact: true });
  await expect(confirm).toContainText("10.0.0.11:8080");
  await expect(confirm.getByRole("button", { name: "Remover", exact: true })).toHaveClass("danger");
  await confirm.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(confirm).toBeHidden();
  expect(deletes).toEqual([]);
  await targets.getByRole("button", { name: "Remover", exact: true }).first().click();
  const removed = page.waitForRequest((request) => request.method() === "DELETE" && request.url().includes("/targets/"));
  await confirm.getByRole("button", { name: "Remover", exact: true }).click();
  expect(new URL((await removed).url()).pathname).toMatch(/\/upstreams\/[^/]+\/targets\/[^/]+$/);
  await expect(confirm).toBeHidden();
});

test("empty upstream, target and certificate lists use EmptyState and retain creation actions", async ({ page }) => {
  await login(page);
  await page.route("**/api/v1/environments/*/upstreams/*/targets", (route) => route.fulfill({ json: { items: [], nextCursor: null } }));
  await menu(page).getByRole("link", { name: "Upstreams", exact: true }).click();
  await expect(page.getByRole("table", { name: "Upstreams" })).toContainText("orders.upstream");
  await page.getByRole("button", { name: "Targets", exact: true }).first().click();
  const targets = page.getByRole("dialog", { name: "Targets de orders.upstream", exact: true });
  await expect(targets.locator(".empty-state")).toContainText("Nenhum target: o tráfego deste upstream não tem destino.");
  await expect(targets.getByRole("button", { name: "Adicionar target", exact: true })).toBeEnabled();
  await targets.getByRole("button", { name: "Fechar", exact: true }).click();
  for (const screen of [
    { path: "upstreams", empty: "Nenhum upstream ainda.", create: "Novo upstream" },
    { path: "certificates", empty: "Nenhum certificado ainda.", create: "Novo certificado" },
  ]) {
    await page.route(`**/api/v1/environments/*/${screen.path}`, (route) => route.fulfill({ json: { items: [], nextCursor: null } }));
    const envId = /\/e\/([^/]+)\//.exec(new URL(page.url()).pathname)![1]!;
    await page.goto(`/e/${envId}/${screen.path}`);
    await expect(page.locator(".empty-state").getByRole("heading", { name: screen.empty, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: screen.create, exact: true })).toBeEnabled();
  }
});

test("upstream targets are fetched only for the opened panel", async ({ page }) => {
  const upstreams = [
    { id: "8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", name: "orders.upstream" },
    { id: "8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4e", name: "payments.upstream" },
  ].map((upstream) => ({
    ...upstream, algorithm: "round-robin", hashOn: "none", hashFallback: "none",
    healthchecks: { active: null, passive: null }, tags: [],
    createdAt: "2026-10-15T12:00:00Z", updatedAt: "2026-10-15T12:00:00Z",
  }));
  await page.route("**/api/v1/environments/*/upstreams", (route) => route.fulfill({ json: { items: upstreams, nextCursor: null } }));
  await login(page);
  // Finish the initial screen's requests before observing what opening the list adds.
  await page.waitForLoadState("networkidle");
  const requests: URL[] = [];
  page.on("request", (request) => {
    if (request.method() === "GET") requests.push(new URL(request.url()));
  });
  await menu(page).getByRole("link", { name: "Upstreams", exact: true }).click();
  const table = page.getByRole("table", { name: "Upstreams", exact: true });
  await expect(table.locator(".service-name")).toHaveText(["orders.upstream", "payments.upstream"]);
  await expect(table.getByRole("columnheader", { name: "Upstream → algoritmo", exact: true })).toBeAttached();
  // This negative network assertion needs the list's request cycle to settle, including React Query effects.
  await page.waitForLoadState("networkidle");
  // Leaving Services mounts the publication strip, which has its own legitimate v1 queries.
  // The upstream list must still fetch once, with no eager targets or per-row queries.
  const upstreamRequests = requests.filter((url) => /^\/api\/v1\/environments\/[^/]+\/upstreams(?:\/|$)/.test(url.pathname));
  expect(upstreamRequests).toHaveLength(1);
  expect(upstreamRequests[0]!.pathname).toMatch(/\/environments\/[^/]+\/upstreams$/);
  expect(requests.filter((url) => /\/upstreams\/[^/]+\/targets$/.test(url.pathname))).toEqual([]);

  const selected = upstreams[1]!;
  const fetched = page.waitForResponse((response) => response.request().method() === "GET"
    && new URL(response.url()).pathname.endsWith(`/upstreams/${selected.id}/targets`));
  await table.getByRole("row").filter({ hasText: selected.name }).getByRole("button", { name: "Targets", exact: true }).click();
  await fetched;
  await expect(page.getByRole("dialog", { name: `Targets de ${selected.name}`, exact: true }).getByRole("table", { name: "Targets", exact: true })).toBeVisible();
  await page.waitForLoadState("networkidle");
  const targetRequests = requests.filter((url) => /\/upstreams\/[^/]+\/targets$/.test(url.pathname));
  expect(targetRequests).toHaveLength(1);
  expect(targetRequests[0]!.pathname).toContain(`/upstreams/${selected.id}/targets`);
  expect(targetRequests[0]!.search).toBe("");
});
