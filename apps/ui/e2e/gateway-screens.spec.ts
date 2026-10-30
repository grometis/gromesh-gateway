import type { Page } from "@playwright/test";
import { expect, mockSession, test } from "./fixtures";

const id = (n: number) => `7c1d2e3f-4a5b-4c6d-8e7f-${String(n).padStart(12, "0")}`;
const timestamps = { createdAt: "2026-10-15T12:00:00Z", updatedAt: "2026-10-15T12:00:00Z" };
const admin = { id: id(1), name: "Ana Souza", email: "ana@gromesh.dev", role: "admin" as const, active: true, ...timestamps };
const service = { id: id(2), name: "orders", protocol: "https", host: "orders.internal", port: 8443, path: "/v2", enabled: false, tags: ["checkout"], ...timestamps };
const v2Service = { ...service, workspaceId: id(9), upstreamId: null };
const route = { id: id(3), name: "orders-api", serviceId: service.id, paths: ["/orders"], hosts: ["api.example.test"], methods: ["GET", "POST"], protocols: ["http", "https"], stripPath: true, preserveHost: false, ...timestamps };
const plugin = { id: id(4), name: "rate-limiting", enabled: false, scope: { serviceId: service.id }, config: { minute: 5 }, ...timestamps };

async function login(page: Page) {
  await mockSession(page, admin);
  await page.route("**/api/v1/environments/*/services*", (r) => r.fulfill({ json: { items: [service], nextCursor: null } }));
  await page.route("**/api/v2/workspaces/*/services*", (r) => r.fulfill({ json: { items: [v2Service], nextCursor: null } }));
  // A single glob star does not cross the slash before the detail id.
  await page.route(`**/api/v2/workspaces/*/services/${service.id}`, (r) => r.fulfill({ json: v2Service }));
  await page.route("**/api/v2/workspaces/*/routes*", (r) => r.fulfill({ json: { items: [{ ...route, pathCompatibility: "workspace-default" }], nextCursor: null } }));
  await page.route("**/api/v1/environments/*/plugins*", (r) => r.fulfill({ json: { items: [plugin], nextCursor: null } }));
  await page.route("**/api/v1/environments/*/publish-preview", (r) => r.fulfill({ json: {
    currentVersion: 1, draftHash: `sha256:${"a".repeat(64)}`, hasChanges: true,
    changes: [
      { kind: "services", id: service.id, label: service.name, change: "modified", before: {}, after: {} },
      { kind: "routes", id: route.id, label: route.name, change: "added", after: {} },
      { kind: "plugins", id: plugin.id, label: plugin.name, change: "modified", before: {}, after: {} },
    ],
  } }));
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(admin.email);
  await page.getByLabel("Senha").fill("s3nha-de-teste");
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("heading", { name: "Services", exact: true })).toBeVisible();
  return /\/e\/([^/]+)\//.exec(new URL(page.url()).pathname)![1]!;
}

test("service detail keeps properties and actions, with scoped routes and plugins as cards", async ({ page }) => {
  const envId = await login(page);
  const routesRequest = page.waitForRequest((r) => new URL(r.url()).pathname.endsWith("/routes") && new URL(r.url()).searchParams.get("serviceId") === service.id);
  await page.goto(`/e/${envId}/services/${service.id}`);
  await routesRequest;
  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toContainText("orders");
  await expect(heading).toContainText("Alterado");
  await expect(heading).toContainText("Desativado");
  await expect(page.locator(".lede")).toHaveText("https://orders.internal:8443/v2");
  await expect(page.locator("dl.service-properties dt")).toHaveText(["Destino", "Protocolo", "Host", "Porta", "Path no destino", "Tags"]);
  await expect(page.locator("dl.service-properties dd")).toHaveText(["Destino direto (DNS)", "https", "orders.internal", "8443", "/v2", "checkout"]);
  const routes = page.getByRole("table", { name: "Routes do service", exact: true });
  await expect(routes).toHaveClass("cards");
  await expect(routes.getByRole("row").last()).toContainText("orders-api");
  await expect(page.getByRole("table", { name: "Plugins", exact: true })).toHaveClass("cards");
  await expect(page.getByRole("heading", { name: "Plugins do service" })).toBeVisible();
  await page.getByRole("button", { name: "Mais ações para orders", exact: true }).click();
  await page.getByRole("menuitem", { name: "Excluir" }).click();
  const confirm = page.getByRole("dialog", { name: "Excluir service" });
  await expect(confirm.getByRole("button", { name: "Excluir", exact: true })).toHaveClass("danger");
  await confirm.getByRole("button", { name: "Cancelar" }).click();
  await expect(confirm).toBeHidden();
  await page.getByRole("link", { name: "← Services" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Services", exact: true })).toBeVisible();
});

test("route cards retain matches, filters and actions, with draft badges and a confirmation menu", async ({ page }) => {
  const envId = await login(page);
  await page.goto(`/e/${envId}/routes`);
  const table = page.getByRole("table", { name: "Routes", exact: true });
  await expect(table).toHaveClass("cards");
  const row = table.getByRole("row").last();
  for (const value of ["orders-api", "/orders", "orders", "GET", "POST", "api.example.test", "Novo"]) await expect(row).toContainText(value);
  await expect(row.locator(".match-chip")).toHaveText(["GET", "POST", "api.example.test"]);
  const filtered = page.waitForRequest((r) => new URL(r.url()).pathname.endsWith("/routes") && new URL(r.url()).searchParams.get("serviceId") === service.id);
  await page.getByLabel("Filtrar por service").selectOption(service.id);
  await filtered;
  await expect(page).toHaveURL(new RegExp(`serviceId=${service.id}`));
  const searched = page.waitForRequest((r) => new URL(r.url()).pathname.endsWith("/routes") && new URL(r.url()).searchParams.get("q") === "/orders");
  await page.getByLabel("Buscar routes").fill("/orders");
  await searched;
  await row.getByRole("button", { name: "Plugins", exact: true }).click();
  const plugins = page.getByRole("dialog", { name: "Plugins de orders-api" });
  await expect(plugins.getByRole("table", { name: "Plugins" })).toHaveClass("cards");
  await expect(plugins).toContainText("Plugins por Workspace ainda não são editáveis aqui.");
  await expect(plugins.getByRole("button", { name: /Adicionar plugin|Novo plugin|Editar|Mais ações/ })).toHaveCount(0);
  await expect(plugins.getByRole("checkbox")).toHaveCount(0);
  await page.getByRole("dialog", { name: "Plugins de orders-api" }).getByRole("button", { name: "Fechar", exact: true }).click();
  await row.getByRole("button", { name: "Editar", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Editar orders-api" }).getByLabel("Paths", { exact: true })).toHaveValue("/orders");
  await page.getByRole("dialog", { name: "Editar orders-api" }).getByRole("button", { name: "Cancelar" }).click();
  const more = row.getByRole("button", { name: "Mais ações para orders-api" });
  await more.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Excluir" })).toBeFocused();
  await page.keyboard.press("Enter");
  const confirm = page.getByRole("dialog", { name: "Excluir route" });
  await expect(confirm).toContainText("orders-api");
  await expect(confirm.getByRole("button", { name: "Excluir", exact: true })).toHaveClass("danger");
  await confirm.getByRole("button", { name: "Cancelar" }).click();
  await expect(confirm).toBeHidden();
});

test("plugin cards keep name, scope and state; scope filtering and deletion still work", async ({ page }) => {
  const envId = await login(page);
  await page.goto(`/e/${envId}/plugins`);
  const table = page.getByRole("table", { name: "Plugins", exact: true });
  await expect(table).toHaveClass("cards");
  const row = table.getByRole("row").last();
  for (const value of ["rate-limiting", "Service orders", "Não", "Alterado"]) await expect(row).toContainText(value);
  await expect(row).not.toContainText("minute");
  const filtered = page.waitForRequest((r) => new URL(r.url()).pathname.endsWith("/plugins") && new URL(r.url()).searchParams.get("global") === "true");
  await page.getByLabel("Filtrar por escopo").selectOption("global");
  await filtered;
  await row.getByRole("button", { name: /^Mais ações para rate-limiting/ }).click();
  await page.getByRole("menuitem", { name: "Excluir" }).click();
  const confirm = page.getByRole("dialog", { name: "Excluir plugin" });
  await expect(confirm).toContainText("Service orders");
  await expect(confirm.getByRole("button", { name: "Excluir", exact: true })).toHaveClass("danger");
  await confirm.getByRole("button", { name: "Cancelar" }).click();
  await expect(confirm).toBeHidden();
});

test("empty route and plugin lists use EmptyState without hiding their creation actions", async ({ page }) => {
  const envId = await login(page);
  await page.route("**/api/v2/workspaces/*/routes*", (r) => r.fulfill({ json: { items: [], nextCursor: null } }));
  await page.route("**/api/v1/environments/*/plugins*", (r) => r.fulfill({ json: { items: [], nextCursor: null } }));
  await page.goto(`/e/${envId}/routes`);
  await expect(page.locator(".empty-state").getByRole("heading", { name: "Nenhuma route encontrada." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Nova route" })).toBeEnabled();
  await page.goto(`/e/${envId}/plugins`);
  await expect(page.locator(".empty-state").getByRole("heading", { name: "Nenhum plugin." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Novo plugin" })).toBeEnabled();
});
