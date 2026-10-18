import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, mockSession, test } from "./fixtures";
import type { Me } from "../src/api/client";

// P5-C2: buttons follow the role in the environment on screen; the selector leaves out environments set to none;
// only a global admin edits environment roles, as a table of environment × role with "uses the global role".
const id = (n: number) => `5e2c7a10-3b4d-4c5e-8f60-${String(n).padStart(12, "0")}`;
const env = (n: number, name: string) => ({ id: id(n), name, publishMode: "manual", currentVersion: 1, hasUnpublishedChanges: false });
const [prod, staging, sandbox] = [env(1, "Produção"), env(2, "Homologação"), env(3, "Sandbox")];
const person = (role: Me["role"], environmentRoles: Me["environmentRoles"] = []): Me => ({
  id: id(10), name: "Rui Prado", email: "rui@gromesh.dev", role, active: true, environmentRoles, createdAt: "2026-10-15T12:00:00Z", updatedAt: "2026-10-15T12:00:00Z",
});
const admin: Me = { ...person("admin"), id: id(11), name: "Ana Souza", email: "ana@gromesh.dev" };

async function signIn(page: Page, user: Me) {
  await mockSession(page, user);
  await page.route("**/api/v1/environments", (route) => route.fulfill({ json: { items: [prod, staging, sandbox] } }));
  for (const e of [prod, staging, sandbox]) await page.route(`**/api/v1/environments/${e.id}`, (route) => route.fulfill({ json: e }));
  await page.route("**/api/v1/environments/*/services*", (route) => route.fulfill({ json: { items: [], nextCursor: null } }));
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(user.email);
  await page.getByLabel("Senha").fill("s3nha-de-teste");
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("heading", { name: "Services", exact: true })).toBeVisible();
}

test("a global viewer who is editor in one environment edits only there, and does not see the hidden one", async ({ page }) => {
  await signIn(page, person("viewer", [{ environmentId: prod.id, role: "editor" }, { environmentId: sandbox.id, role: "none" }]));
  const select = page.getByLabel("Environment");
  await expect(select.locator("option")).toHaveText(["Produção", "Homologação"]);
  await expect(page).toHaveURL(new RegExp(`/e/${prod.id}/services$`));
  await expect(page.getByRole("button", { name: "Novo service" })).toBeVisible();
  await select.selectOption({ label: "Homologação" });
  await expect(page).toHaveURL(new RegExp(`/e/${staging.id}/services$`));
  await expect(page.getByRole("heading", { name: "Services", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Novo service" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Usuários" })).toHaveCount(0);
});

test("a global editor who is viewer in one environment only reads there", async ({ page }) => {
  await signIn(page, person("editor", [{ environmentId: prod.id, role: "viewer" }]));
  await expect(page.getByRole("button", { name: "Novo service" })).toHaveCount(0);
  await page.getByLabel("Environment").selectOption({ label: "Homologação" });
  await expect(page.getByRole("button", { name: "Novo service" })).toBeVisible();
});

test("a global admin sets roles per environment; leaving one on the global role sends nothing for it", async ({ page }) => {
  const viewer = person("viewer");
  const puts: unknown[] = [];
  await page.route("**/api/v1/users?*", (route) => route.fulfill({ json: { items: [admin, viewer], nextCursor: null } }));
  await page.route("**/api/v1/users", (route) => route.fulfill({ json: { items: [admin, viewer], nextCursor: null } }));
  await page.route(`**/api/v1/users/${viewer.id}/environment-roles`, async (route) => {
    if (route.request().method() === "PUT") {
      puts.push(route.request().postDataJSON());
      return route.fulfill({ json: route.request().postDataJSON() });
    }
    return route.fulfill({ json: { items: [{ environmentId: staging.id, role: "editor" }] } });
  });
  await signIn(page, admin);
  await page.getByRole("link", { name: "Usuários", exact: true }).click();
  await page.getByRole("button", { name: "Papéis de Rui Prado por environment" }).click();
  const dialog = page.getByRole("dialog", { name: "Environments de Rui Prado" });
  await expect(dialog).toContainText("Papel global: Leitor");
  await expect(dialog.getByLabel("Papel em Produção")).toHaveValue("global");
  await expect(dialog.getByLabel("Papel em Produção").locator("option").first()).toHaveText("Usa o global (Leitor)");
  await expect(dialog.getByLabel("Papel em Homologação")).toHaveValue("editor");
  await dialog.getByLabel("Papel em Produção").selectOption({ label: "Administrador" });
  await dialog.getByLabel("Papel em Sandbox").selectOption({ label: "Sem acesso" });
  await dialog.getByLabel("Papel em Homologação").selectOption({ label: "Usa o global (Leitor)" });
  const result = await new AxeBuilder({ page }).include('[role="dialog"]').withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(result.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);
  await dialog.getByRole("button", { name: "Salvar" }).click();
  await expect(dialog).toBeHidden();
  expect(puts).toEqual([{ items: [{ environmentId: prod.id, role: "admin" }, { environmentId: sandbox.id, role: "none" }] }]);
});

test("a 422 names the environment's row; a global admin has no environment roles to edit", async ({ page }) => {
  const viewer = person("viewer");
  await page.route("**/api/v1/users?*", (route) => route.fulfill({ json: { items: [admin, viewer], nextCursor: null } }));
  await page.route("**/api/v1/users", (route) => route.fulfill({ json: { items: [admin, viewer], nextCursor: null } }));
  await page.route(`**/api/v1/users/${viewer.id}/environment-roles`, (route) => route.request().method() === "PUT"
    ? route.fulfill({ status: 422, contentType: "application/problem+json", json: { title: "Unprocessable", status: 422, detail: "Invalid environment roles", errors: [{ path: "items.0.environmentId", message: "is not an environment" }] } })
    : route.fulfill({ json: { items: [] } }));
  await signIn(page, admin);
  await page.getByRole("link", { name: "Usuários", exact: true }).click();
  await page.getByRole("button", { name: "Papéis de Rui Prado por environment" }).click();
  const dialog = page.getByRole("dialog", { name: "Environments de Rui Prado" });
  await dialog.getByLabel("Papel em Sandbox").selectOption({ label: "Editor" });
  await dialog.getByRole("button", { name: "Salvar" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Sandbox: não é mais um environment");
  await dialog.getByRole("button", { name: "Cancelar" }).click();

  await page.getByRole("button", { name: "Papéis de Ana Souza por environment" }).click();
  const adminDialog = page.getByRole("dialog", { name: "Environments de Ana Souza" });
  await expect(adminDialog).toContainText("administradores em todos os environments");
  await expect(adminDialog.getByRole("combobox")).toHaveCount(0);
  await expect(adminDialog.getByRole("button", { name: "Salvar" })).toHaveCount(0);
});

test("Salvar stays off when the roles cannot be read again: a stale set never replaces the current one", async ({ page }) => {
  const viewer = person("viewer");
  let fail = false;
  const puts: unknown[] = [];
  await page.route("**/api/v1/users?*", (route) => route.fulfill({ json: { items: [admin, viewer], nextCursor: null } }));
  await page.route("**/api/v1/users", (route) => route.fulfill({ json: { items: [admin, viewer], nextCursor: null } }));
  await page.route(`**/api/v1/users/${viewer.id}/environment-roles`, (route) => {
    if (route.request().method() === "PUT") puts.push(route.request().postDataJSON());
    return fail ? route.fulfill({ status: 500, json: { title: "Internal", status: 500 } }) : route.fulfill({ json: { items: [] } });
  });
  await signIn(page, admin);
  await page.getByRole("link", { name: "Usuários", exact: true }).click();
  await page.getByRole("button", { name: "Papéis de Rui Prado por environment" }).click();
  const dialog = page.getByRole("dialog", { name: "Environments de Rui Prado" });
  await expect(dialog.getByRole("button", { name: "Salvar" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Cancelar" }).click();
  fail = true;
  await page.getByRole("button", { name: "Papéis de Rui Prado por environment" }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Salvar" })).toBeDisabled();
  expect(puts).toEqual([]);
});

test("a global viewer who is editor in one environment may create an editor token, never an admin one", async ({ page }) => {
  await signIn(page, person("viewer", [{ environmentId: prod.id, role: "editor" }]));
  await page.getByRole("link", { name: "Tokens de API" }).click();
  await page.getByRole("button", { name: "Novo token" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Papel").locator("option")).toHaveText(["Leitor", "Editor"]);
});

for (const viewport of [{ name: "desktop-1440", width: 1440, height: 900 }, { name: "mobile-390", width: 390, height: 844 }]) {
  test(`environment roles of a user, ${viewport.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const viewer = person("viewer");
    await page.route("**/api/v1/users?*", (route) => route.fulfill({ json: { items: [admin, viewer], nextCursor: null } }));
    await page.route("**/api/v1/users", (route) => route.fulfill({ json: { items: [admin, viewer], nextCursor: null } }));
    await page.route(`**/api/v1/users/${viewer.id}/environment-roles`, (route) => route.fulfill({ json: { items: [{ environmentId: prod.id, role: "editor" }, { environmentId: sandbox.id, role: "none" }] } }));
    await signIn(page, admin);
    await page.getByRole("link", { name: "Usuários", exact: true }).click();
    await page.getByRole("button", { name: "Papéis de Rui Prado por environment" }).click();
    const dialog = page.getByRole("dialog", { name: "Environments de Rui Prado" });
    await expect(dialog.getByLabel("Papel em Sandbox")).toHaveValue("none");
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    const dir = testInfo.config.rootDir.replace(/\/e2e$/, "") + "/test-results/screenshots";
    await page.screenshot({ path: `${dir}/environment-roles-${viewport.name}.png`, fullPage: true });
  });
}
