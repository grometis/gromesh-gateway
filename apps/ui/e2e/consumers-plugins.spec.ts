import { readFileSync } from "node:fs";
import { expect, test, type Page, type Route } from "@playwright/test";

// W4-C1 acceptance, against the contract mock. The contract has no examples for the plugin catalog, so the real
// catalog files the control plane serves are pinned here; Prism still answers everything else.
const CATALOG = new URL("../../control-plane/src/plugin-catalog/kong-3.9/", import.meta.url);
const catalogFile = (name: string) => readFileSync(new URL(`${name}.json`, CATALOG), "utf8");

async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("E-mail").fill("editor@gromesh.dev");
  await page.getByLabel("Senha").fill("s3nha-de-teste");
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("heading", { name: "Services" })).toBeVisible();
}

const menu = (page: Page) => page.getByRole("navigation", { name: "Menu principal" });

test("a new consumer's key is shown once and is gone after closing", async ({ page }) => {
  const key = "c2VjcmV0LWtleS1zaG93bi1vbmNlLW9ubHktMTIzNDU2";
  // Prism would answer with a placeholder string; a realistic key makes "shown once" observable.
  await page.route("**/api/v1/environments/*/consumers/*/key-auth", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ id: "5f0c5c1e-8f2a-4f7e-9c41-0d3c1b2a9e10", consumerId: "0b7c3c1e-1f2a-4f7e-9c41-0d3c1b2a9e11", keyHint: "…3456", createdAt: "2026-10-15T12:00:00Z", key }),
        })
      : route.fallback(),
  );
  await login(page);

  await menu(page).getByRole("link", { name: "Consumers" }).click();
  await page.getByRole("button", { name: "Novo consumer" }).click();
  const form = page.getByRole("dialog", { name: "Novo consumer" });
  await form.getByLabel("Username").fill("mobile-app");
  const created = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/consumers"));
  await form.getByRole("button", { name: "Salvar" }).click();
  expect((await created).status()).toBe(201);
  await expect(page.getByRole("heading", { name: /^Consumer / })).toBeVisible();

  await page.getByRole("button", { name: "Gerar chave" }).click();
  await page.getByRole("dialog", { name: "Gerar chave" }).getByRole("button", { name: "Gerar" }).click();
  const shown = page.getByRole("dialog", { name: "Chave criada" });
  await expect(shown.getByLabel("Chave")).toHaveText(key);
  await expect(shown.getByRole("note")).toContainText("não será mostrada de novo");
  await shown.getByRole("button", { name: "Concluído" }).click();

  await expect(shown).toBeHidden();
  await expect(page.getByText(key)).toHaveCount(0);
  const stored = await page.evaluate(() => JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage }));
  expect(stored).not.toContain(key);
});

test("rate-limiting on a route through the generated form, with a 422 on config.minute shown on the field", async ({ page }) => {
  await page.route("**/api/v1/plugin-schemas", (route) => route.fulfill({ contentType: "application/json", body: catalogFile("_catalog") }));
  await page.route("**/api/v1/plugin-schemas/*", (route) => {
    const name = new URL(route.request().url()).pathname.split("/").pop()!;
    return route.fulfill({ contentType: "application/json", body: catalogFile(name) });
  });
  await login(page);

  await menu(page).getByRole("link", { name: "Routes" }).click();
  await page.getByRole("button", { name: "Plugins" }).first().click();
  const scoped = page.getByRole("dialog", { name: /^Plugins de / });
  await scoped.getByRole("button", { name: "Adicionar plugin" }).click();

  const picker = page.getByRole("dialog", { name: "Escolha um plugin" });
  await expect(picker.getByRole("button", { name: /^oauth2/ })).toBeDisabled();
  await picker.getByRole("button", { name: /^rate-limiting/ }).click();

  const editor = page.getByRole("dialog", { name: "Novo plugin rate-limiting" });
  await expect(editor.getByRole("radio", { name: "Route" })).toBeChecked();
  await expect(editor.getByRole("combobox", { name: "Route" })).toHaveValue(/[0-9a-f-]{36}/);
  await expect(editor.getByLabel("limit_by")).toHaveValue("consumer");
  await editor.getByLabel("minute", { exact: true }).fill("5");

  // First save: the validator refuses config.minute.
  const refuse = (route: Route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status: 422,
          contentType: "application/problem+json",
          body: JSON.stringify({
            type: "https://gromesh.dev/problems/422",
            title: "Unprocessable Content",
            status: 422,
            errors: [{ path: "config.minute", message: "value should be lower than the hour limit" }],
          }),
        })
      : route.fallback();
  await page.route("**/api/v1/environments/*/plugins", refuse);
  await editor.getByRole("button", { name: "Salvar" }).click();
  await expect(editor.getByLabel("minute", { exact: true })).toHaveAttribute("aria-invalid", "true");
  await expect(editor.getByRole("alert").filter({ hasText: "value should be lower than the hour limit" })).toBeVisible();

  // Second save goes to the mock and carries the form's values and the schema defaults.
  await page.unroute("**/api/v1/environments/*/plugins", refuse);
  const created = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/plugins"));
  await editor.getByRole("button", { name: "Salvar" }).click();
  const body = (await created).postDataJSON() as { name: string; scope: { routeId?: string }; config: Record<string, unknown> };
  expect(body.name).toBe("rate-limiting");
  expect(body.scope.routeId).toMatch(/[0-9a-f-]{36}/);
  expect(body.config).toMatchObject({ minute: 5, limit_by: "consumer", policy: "local", fault_tolerant: true });
  await expect(editor).toBeHidden();
});
