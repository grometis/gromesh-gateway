import { expect, test } from "./fixtures";

// W3-C1 acceptance, against the contract mock: login → create service → create route → publish shows 2 "added".
test("login, create a service and a route, then preview the publication", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("E-mail").fill("editor@gromesh.dev");
  await page.getByLabel("Senha").fill("s3nha-de-teste");
  await page.getByRole("button", { name: "Entrar" }).click();

  await expect(page.getByRole("heading", { name: "Services" })).toBeVisible();
  await expect(page.getByLabel("Environment")).toHaveValue(/[0-9a-f-]{36}/);

  await page.getByRole("button", { name: "Novo service" }).click();
  const svc = page.getByRole("dialog", { name: "Novo service" });
  await svc.getByLabel("Nome").fill("orders");
  await svc.getByLabel("Host").fill("orders.internal");
  await svc.getByLabel("Porta").fill("8080");
  const created = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/services"));
  await svc.getByRole("button", { name: "Salvar" }).click();
  expect((await created).status()).toBe(201);
  await expect(svc).toBeHidden();

  await page.getByRole("navigation", { name: "Menu principal" }).getByRole("link", { name: "Routes" }).click();
  await page.getByRole("button", { name: "Nova route" }).click();
  const route = page.getByRole("dialog", { name: "Nova route" });
  await route.getByLabel("Nome").fill("orders-api");
  await expect(route.getByLabel("Service")).toHaveValue(/[0-9a-f-]{36}/);
  await route.getByLabel("Paths").fill("/orders");
  const createdRoute = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/routes"));
  await route.getByRole("button", { name: "Salvar" }).click();
  expect((await createdRoute).status()).toBe(201);
  await expect(route).toBeHidden();

  await expect(page.getByRole("region", { name: "Publicação" })).toContainText("2 alterações");
  await page.getByRole("region", { name: "Publicação" }).getByRole("button", { name: /^Publicar v\d+$/ }).click();
  const publish = page.getByRole("region", { name: "Revisar e publicar" });
  const changes = publish.getByRole("list", { name: "Alterações" }).getByRole("listitem");
  await expect(changes).toHaveCount(2);
  await expect(publish.locator('[data-change="added"]')).toHaveCount(2);
  await expect(changes.nth(0)).toContainText("Service orders");
  await expect(changes.nth(1)).toContainText("Route orders-api");
});

test("422 errors from the API are shown on the fields they belong to", async ({ page }) => {
  // Prism has no example for this 422, so the problem body is pinned here (the mapping itself is what is tested).
  await page.route("**/api/v1/environments/*/services", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status: 422,
          contentType: "application/problem+json",
          body: JSON.stringify({
            type: "https://gromesh.dev/problems/422",
            title: "Unprocessable Content",
            status: 422,
            detail: "Request body does not match the contract",
            errors: [
              { path: "port", message: "must be integer" },
              { path: "(body)", message: "name is already used" },
            ],
          }),
        })
      : route.fallback(),
  );
  await page.goto("/login");
  await page.getByLabel("E-mail").fill("editor@gromesh.dev");
  await page.getByLabel("Senha").fill("s3nha-de-teste");
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.getByRole("button", { name: "Novo service" }).click();
  const svc = page.getByRole("dialog", { name: "Novo service" });
  await svc.getByLabel("Nome").fill("orders");
  await svc.getByLabel("Porta").fill("abc");
  await svc.getByRole("button", { name: "Salvar" }).click();
  await expect(svc.getByLabel("Porta")).toHaveAttribute("aria-invalid", "true");
  await expect(svc.getByText("must be integer")).toBeVisible();
  await expect(svc.getByText("name is already used")).toBeVisible();
  await expect(svc.getByLabel("Nome")).toHaveAttribute("aria-invalid", "false");
});
