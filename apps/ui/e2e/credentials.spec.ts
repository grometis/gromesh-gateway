import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// P3-C1 acceptance, against the contract mock: the consumer's JWT, basic-auth and ACL group tabs.
const consumerId = "0b7c3c1e-1f2a-4f7e-9c41-0d3c1b2a9e11";
const secret = "aHMyNTYtc2VjcmV0LXNob3duLW9uY2Utb25seS0xMjM0NTY";
const password = "basic-password-never-shown";

async function openConsumer(page: Page) {
  await page.goto("/");
  await page.getByLabel("E-mail").fill("editor@gromesh.dev");
  await page.getByLabel("Senha").fill("s3nha-de-teste");
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("heading", { name: "Services" })).toBeVisible();
  await page.getByRole("navigation", { name: "Menu principal" }).getByRole("link", { name: "Consumers" }).click();
  await page.getByRole("button", { name: "Novo consumer" }).click();
  const form = page.getByRole("dialog", { name: "Novo consumer" });
  await form.getByLabel("Username").fill("partner");
  await form.getByRole("button", { name: "Salvar" }).click();
  await expect(page.getByRole("heading", { name: /^Consumer / })).toBeVisible();
}

const tabs = (page: Page) => page.getByRole("tablist", { name: "Credenciais do consumer" });

test("an HS256 secret is shown once and is gone after closing; an RS256 key needs a PEM", async ({ page }) => {
  // Prism would answer with a placeholder; a realistic secret makes "shown once" observable.
  await page.route("**/api/v1/environments/*/consumers/*/jwt", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 201, json: { id: "5f0c5c1e-8f2a-4f7e-9c41-0d3c1b2a9e10", consumerId, key: "hs-issuer", algorithm: "HS256", tags: [], createdAt: "2026-10-17T12:00:00Z", secret } })
      : route.fallback(),
  );
  await openConsumer(page);
  await expect(tabs(page).getByRole("tab", { name: "Key-auth" })).toHaveAttribute("aria-selected", "true");
  await tabs(page).getByRole("tab", { name: "JWT" }).click();
  await expect(page.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "consumer-tab-jwt");

  await page.getByRole("button", { name: "Nova credencial JWT" }).click();
  const dialog = page.getByRole("dialog", { name: "Nova credencial JWT" });
  await dialog.getByLabel("Algoritmo").selectOption("RS256");
  await dialog.getByRole("button", { name: "Criar" }).click();
  await expect(dialog.getByLabel("Chave pública (PEM)")).toHaveAttribute("aria-invalid", "true");
  await dialog.getByLabel("Algoritmo").selectOption("HS256");
  const posted = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/jwt"));
  await dialog.getByRole("button", { name: "Criar" }).click();
  expect((await posted).postDataJSON()).toEqual({ algorithm: "HS256" });

  const shown = page.getByRole("dialog", { name: "Credencial JWT criada" });
  await expect(shown.getByLabel("Segredo")).toHaveText(secret);
  await expect(shown.getByRole("note")).toContainText("não será mostrado de novo");
  await shown.getByRole("button", { name: "Concluído" }).click();
  await expect(shown).toBeHidden();
  await expect(page.getByText(secret)).toHaveCount(0);
  const stored = await page.evaluate(() => JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage }));
  expect(stored).not.toContain(secret);
});

test("a basic-auth password goes to the API once and is never rendered", async ({ page }) => {
  await openConsumer(page);
  await tabs(page).getByRole("tab", { name: "Basic-auth" }).click();
  await page.getByRole("button", { name: "Nova credencial basic-auth" }).click();
  const dialog = page.getByRole("dialog", { name: "Nova credencial basic-auth" });
  await dialog.getByLabel("Usuário").fill("partner-api");
  await dialog.getByLabel("Senha").fill("short");
  await dialog.getByRole("button", { name: "Criar" }).click();
  await expect(dialog.getByText("Use pelo menos 8 caracteres.")).toBeVisible();
  await expect(dialog.getByLabel("Senha")).toHaveAttribute("type", "password");
  await dialog.getByLabel("Senha").fill(password);
  const posted = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/basic-auth"));
  await dialog.getByRole("button", { name: "Criar" }).click();
  expect((await posted).postDataJSON()).toEqual({ username: "partner-api", password });
  await expect(dialog).toBeHidden();
  expect(await page.content()).not.toContain(password);
});

test("ACL groups are validated and replaced as a whole set", async ({ page }) => {
  await page.route("**/api/v1/environments/*/consumers/*/acl-groups", (route) =>
    route.request().method() === "PUT" ? route.fulfill({ json: route.request().postDataJSON() }) : route.fulfill({ json: { groups: ["partners"] } }),
  );
  await openConsumer(page);
  await tabs(page).getByRole("tab", { name: "JWT" }).focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(tabs(page).getByRole("tab", { name: "Grupos" })).toBeFocused();
  await expect(page.getByRole("list", { name: "Grupos" })).toContainText("partners");

  await page.getByRole("button", { name: "Editar grupos" }).click();
  const input = page.getByRole("textbox", { name: "Grupos" });
  await input.fill("partners, Gold Tier");
  await page.getByRole("button", { name: "Salvar grupos" }).click();
  await expect(page.getByText(/Nomes inválidos: Gold Tier/)).toBeVisible();
  await input.fill("partners, gold, gold");
  const put = page.waitForRequest((r) => r.method() === "PUT" && r.url().endsWith("/acl-groups"));
  await page.getByRole("button", { name: "Salvar grupos" }).click();
  expect((await put).postDataJSON()).toEqual({ groups: ["partners", "gold"] });
});
