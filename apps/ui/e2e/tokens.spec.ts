import type { Page } from "@playwright/test";
import { expect, mockSession, test } from "./fixtures";

// P1-C1 acceptance against the contract mock: Prism answers the token examples of the contract.
const actor = { id: "33333333-3333-4333-8333-333333333333", name: "Ana" };
const EXAMPLE_TOKEN = /^ggt_[A-Za-z0-9_-]{43}$/;

async function login(page: Page, role: "admin" | "viewer" = "viewer") {
  await mockSession(page, { ...actor, email: "ana@gromesh.dev", role, active: true, createdAt: "2026-10-15T12:00:00Z", updatedAt: "2026-10-15T12:00:00Z" });
  const environment = { id: "11111111-1111-4111-8111-111111111111", name: "Produção", publishMode: "manual", currentVersion: 2, hasUnpublishedChanges: false };
  await page.route("**/api/v1/environments", (route) => route.fulfill({ json: { items: [environment] } }));
  await page.goto("/login");
  await page.getByLabel("E-mail").fill("ana@gromesh.dev");
  await page.getByLabel("Senha").fill("test-password");
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("heading", { name: "Services" })).toBeVisible();
}

test("qualquer usuário cria um token, vê o valor uma única vez e revoga pela lista", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await login(page, "viewer");
  await page.getByRole("link", { name: "Tokens de API" }).click();
  await expect(page.getByRole("heading", { name: "Tokens de API" })).toBeVisible();
  // The list comes from the contract example: hint only, never a token value.
  const table = page.getByRole("table", { name: "Tokens de API" });
  await expect(table).toHaveClass("cards");
  await expect(table).toContainText("ci-deploy");
  await expect(table).toContainText("…");
  await expect(page.getByText(EXAMPLE_TOKEN)).toHaveCount(0);
  // A viewer may only create viewer tokens; the default validity is 90 days.
  await page.getByRole("button", { name: "Novo token" }).click();
  const dialog = page.getByRole("dialog", { name: "Novo token" });
  await expect(dialog.getByLabel("Papel").locator("option")).toHaveCount(1);
  await expect(dialog.getByLabel("Validade (dias)")).toHaveValue("90");
  await dialog.getByLabel("Nome").fill("ci-deploy");
  const created = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/users/me/tokens"));
  await dialog.getByRole("button", { name: "Criar token" }).click();
  expect((await created).postDataJSON()).toEqual({ name: "ci-deploy", role: "viewer", expiresInDays: 90 });
  // Shown once, with a copy button.
  const shown = page.getByRole("dialog", { name: "Token criado" });
  await expect(shown.locator(".secret").getByLabel("Token")).toHaveText(EXAMPLE_TOKEN);
  await expect(shown.getByLabel("Token")).toHaveText(EXAMPLE_TOKEN);
  await expect(shown).toContainText("não será exibido novamente");
  await shown.getByRole("button", { name: "Copiar" }).click();
  await expect(shown.getByRole("button", { name: "Copiado" })).toBeVisible();
  await shown.getByRole("button", { name: "Entendi, já copiei" }).click();
  await expect(shown).toBeHidden();
  await expect(page.getByText(EXAMPLE_TOKEN)).toHaveCount(0);
  // Revoke from the list.
  const revoked = page.waitForRequest((r) => r.method() === "DELETE" && r.url().includes("/users/me/tokens/"));
  await table.getByRole("button", { name: "Revogar" }).first().click();
  await page.getByRole("dialog", { name: "Revogar token" }).getByRole("button", { name: "Revogar" }).click();
  await revoked;
});

test("o administrador vê os tokens de todos os usuários e revoga pela rota administrativa", async ({ page }) => {
  await login(page, "admin");
  await page.getByRole("link", { name: "Tokens de API" }).click();
  const all = page.waitForRequest((r) => r.method() === "GET" && /\/api\/v1\/tokens(\?|$)/.test(r.url()));
  await page.getByLabel("Mostrar").selectOption("all");
  await all;
  const table = page.getByRole("table", { name: "Tokens de API" });
  await expect(table.getByRole("columnheader", { name: "Dono" })).toBeVisible();
  // The example token belongs to another user: an admin revokes it through /tokens/{id}.
  await page.route("**/api/v1/tokens", (route) => route.fulfill({ json: { items: [{ id: "5f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f", name: "ci-deploy", role: "editor", tokenHint: "…k7Qp", createdAt: "2026-10-16T12:00:00Z", expiresAt: "2027-01-14T12:00:00Z", lastUsedAt: null, revokedAt: null, owner: { id: "44444444-4444-4444-8444-444444444444", name: "Bruno" } }], nextCursor: null } }));
  await page.getByLabel("Mostrar").selectOption("mine");
  await page.getByLabel("Mostrar").selectOption("all");
  await expect(table).toContainText("Bruno");
  const revoked = page.waitForRequest((r) => r.method() === "DELETE" && r.url().endsWith("/tokens/5f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f"));
  await table.getByRole("button", { name: "Revogar" }).first().click();
  await page.getByRole("dialog", { name: "Revogar token" }).getByRole("button", { name: "Revogar" }).click();
  await revoked;
});


test("empty token list uses the shared empty state and retains creation", async ({ page }) => {
  await page.route("**/api/v1/users/me/tokens", (route) => route.fulfill({ json: { items: [], nextCursor: null } }));
  await login(page);
  await page.goto("/tokens");
  await expect(page.getByRole("heading", { name: "Nenhum token.", level: 2 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Novo token", exact: true })).toBeVisible();
});
