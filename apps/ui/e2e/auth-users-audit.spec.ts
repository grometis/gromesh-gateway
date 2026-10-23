import type { Page } from "@playwright/test";
import { expect, mockSession, test } from "./fixtures";
import type { User } from "../src/api/client";

const envId = "11111111-1111-4111-8111-111111111111";
const admin: User = {
  id: "33333333-3333-4333-8333-333333333333", name: "Ana Administradora", email: "admin@gromesh.dev", role: "admin", active: true,
  createdAt: "2026-10-15T12:00:00Z", updatedAt: "2026-10-15T12:00:00Z",
};
const viewer: User = { ...admin, id: "44444444-4444-4444-8444-444444444444", name: "Vera Leitora", email: "viewer@gromesh.dev", role: "viewer" };
const environment = { id: envId, name: "Desenvolvimento", publishMode: "manual", currentVersion: 1, hasUnpublishedChanges: true };
const publication = {
  id: "55555555-5555-4555-8555-555555555555", at: "2026-10-15T12:00:00Z", actor: { type: "user", id: admin.id, name: admin.name },
  action: "snapshot.publish", entityType: "snapshot", entityId: "2", environmentId: envId, before: null, after: { version: 2, message: "Publicação da UI", key: "REDACTED" }, ip: "127.0.0.1",
};

async function login(page: Page, user = admin) {
  await mockSession(page, user);
  await page.route("**/api/v1/environments", (route) => route.fulfill({ json: { items: [environment] } }));
  await page.route(`**/api/v1/environments/${envId}`, (route) => route.fulfill({ json: environment }));
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(user.email);
  await page.getByLabel("Senha").fill("gromesh-dev-admin");
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("heading", { name: "Services", exact: true })).toBeVisible();
}

test("cookie restaura a sessão; CSRF fica em memória e protege também o logout", async ({ page, context }) => {
  const csrfRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/v1/") && !["GET", "HEAD"].includes(request.method()) && !request.url().endsWith("/auth/login")) {
      csrfRequests.push(request.headers()["x-csrf-token"] ?? "missing");
      expect(request.headers().authorization).toBeUndefined();
    }
  });
  await login(page);
  expect((await context.cookies()).find((cookie) => cookie.name === "gromesh_session")?.httpOnly).toBe(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Services", exact: true })).toBeVisible();
  expect(await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }))).toEqual({ local: {}, session: {} });
  await page.route("**/api/v1/auth/logout", (route) => route.fulfill({
    status: 204, headers: { "Set-Cookie": "gromesh_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0" },
  }));
  await page.getByRole("button", { name: "Sair", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect(csrfRequests).toEqual(["example-csrf-token"]);
  expect((await context.cookies()).some((cookie) => cookie.name === "gromesh_session")).toBe(false);
});

test("401 em qualquer consulta encerra a sessão; 403 é exibido sem logout", async ({ page }) => {
  await page.route("**/api/v1/users*", (route) => route.fulfill({ status: 403, json: { title: "Forbidden", status: 403 } }));
  await login(page);
  await page.getByRole("link", { name: "Usuários", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Você não tem permissão");
  await expect(page.getByRole("button", { name: "Sair" })).toBeVisible();
  await page.route("**/api/v1/audit-events*", (route) => route.fulfill({ status: 401, json: { title: "Unauthorized", status: 401 } }));
  await page.getByRole("link", { name: "Auditoria", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test("login informa limite de tentativas e permite tentar depois", async ({ page }) => {
  await page.route("**/api/v1/auth/login", (route) => route.fulfill({ status: 429, headers: { "Retry-After": "60" }, json: { title: "Too Many Requests", status: 429 } }));
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(admin.email);
  await page.getByLabel("Senha").fill("wrong-password");
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("alert")).toContainText("Muitas tentativas");
  await expect(page.getByRole("button", { name: "Entrar" })).toBeEnabled();
});

test("403 no logout aparece sem abandonar a sessão", async ({ page }) => {
  await login(page);
  await page.route("**/api/v1/auth/logout", (route) => route.fulfill({ status: 403, json: { title: "Forbidden", status: 403 } }));
  await page.getByRole("button", { name: "Sair", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Você não tem permissão");
  await expect(page.getByRole("heading", { name: "Services", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sair", exact: true })).toBeEnabled();
});

test("viewer não vê edição nem menus administrativos; acesso direto é recusado", async ({ page }) => {
  await login(page, viewer);
  const menu = page.getByRole("navigation", { name: "Menu principal" });
  await expect(menu.getByRole("link", { name: /Usuários|Auditoria/ })).toHaveCount(0);
  for (const section of ["Services", "Routes", "Consumers", "Plugins", "Publicações", "Clusters"]) {
    await menu.getByRole("link", { name: section, exact: true }).click();
    await expect(page.getByRole("heading", { name: section, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /^(Novo |Nova |Editar|Excluir|Publicar$|Restaurar |Rotacionar |Gerar )/ })).toHaveCount(0);
  }
  // Prism cannot enforce RBAC; pin the contract's 403 for a forced mutation. Real enforcement is W5-C1's matrix.
  await page.route("**/api/v1/environments/*/services", (route) => route.request().method() === "POST"
    ? route.fulfill({ status: 403, json: { title: "Forbidden", status: 403 } })
    : route.fallback());
  const status = await page.evaluate(async (id) => {
    const { csrfToken } = await (await fetch("/api/v1/auth/csrf", { credentials: "include" })).json() as { csrfToken: string };
    return (await fetch(`/api/v1/environments/${id}/services`, {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ name: "forced", protocol: "http", host: "echo", port: 80 }),
    })).status;
  }, envId);
  expect(status).toBe(403);
  for (const path of ["/users", "/audit"]) {
    await page.goto(path);
    await expect(page.getByRole("alert")).toContainText("Você não tem permissão");
    await expect(page.getByRole("button", { name: "Sair" })).toBeVisible();
  }
});

test("admin pagina usuários, cria, altera papel e ativo e confirma exclusão", async ({ page }) => {
  let saved = false;
  let edited = false;
  let deleted = false;
  await page.route("**/api/v1/users*", (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "POST") {
      expect(route.request().headers()["x-csrf-token"]).toBe("example-csrf-token");
      expect(route.request().postDataJSON()).toEqual({ name: viewer.name, email: viewer.email, role: "viewer", password: "new-user-password" });
      saved = true;
      return route.fulfill({ status: 201, json: viewer });
    }
    return route.fulfill({ json: { items: url.searchParams.has("cursor") ? [viewer] : [admin, ...(saved && !deleted ? [{ ...viewer, role: edited ? "editor" : "viewer", active: !edited }] : [])], nextCursor: saved || url.searchParams.has("cursor") ? null : "next-users" } });
  });
  await page.route(`**/api/v1/users/${viewer.id}`, (route) => {
    if (route.request().method() === "PATCH") {
      expect(route.request().postDataJSON()).toEqual({ name: viewer.name, role: "editor", active: false });
      edited = true;
      return route.fulfill({ json: { ...viewer, role: "editor", active: false } });
    }
    deleted = true;
    return route.fulfill({ status: 204 });
  });
  await login(page);
  await page.getByRole("link", { name: "Usuários", exact: true }).click();
  await expect(page.getByRole("table", { name: "Usuários", exact: true })).toHaveClass("cards");
  await page.getByRole("button", { name: "Carregar mais" }).click();
  await expect(page.getByRole("row").filter({ hasText: viewer.email })).toBeVisible();
  await page.getByRole("button", { name: "Novo usuário" }).click();
  const form = page.getByRole("dialog", { name: "Novo usuário" });
  await form.getByLabel("Nome", { exact: true }).fill(viewer.name);
  await form.getByLabel("E-mail").fill(viewer.email);
  await form.getByLabel("Senha", { exact: true }).fill("new-user-password");
  await form.getByLabel("Papel").selectOption("viewer");
  await form.getByRole("button", { name: "Salvar" }).click();
  await expect(form).toBeHidden();
  const row = page.getByRole("row").filter({ hasText: viewer.email });
  await row.getByRole("button", { name: "Editar" }).click();
  const edit = page.getByRole("dialog", { name: `Editar ${viewer.name}` });
  await edit.getByLabel("Papel").selectOption("editor");
  await edit.getByLabel("Ativo", { exact: true }).uncheck();
  await edit.getByRole("button", { name: "Salvar" }).click();
  expect(edited).toBe(false);
  const deactivate = page.getByRole("dialog", { name: "Desativar usuário" });
  await expect(deactivate).toContainText(viewer.name);
  await deactivate.getByRole("button", { name: "Cancelar", exact: true }).click();
  expect(edited).toBe(false);
  await expect(edit).toBeVisible();
  await edit.getByRole("button", { name: "Salvar" }).click();
  await deactivate.getByRole("button", { name: "Desativar", exact: true }).click();
  await expect(edit).toBeHidden();
  await expect(row).toContainText("Editor");
  await expect(row).toContainText("Não");
  await row.getByRole("button", { name: "Excluir" }).click();
  expect(deleted).toBe(false);
  await page.getByRole("dialog", { name: "Excluir usuário" }).getByRole("button", { name: "Excluir", exact: true }).click();
  await expect(row).toHaveCount(0);
  expect(saved && edited && deleted).toBe(true);
});

test("usuários exibem validação e conflito do último admin sem fechar o diálogo", async ({ page }) => {
  await page.route("**/api/v1/users*", (route) => route.request().method() === "POST"
    ? route.fulfill({ status: 422, json: { title: "Unprocessable Content", status: 422, errors: [{ path: "password", message: "must have at least 12 characters" }] } })
    : route.fulfill({ json: { items: [admin], nextCursor: null } }));
  await page.route(`**/api/v1/users/${admin.id}`, (route) => route.fulfill({ status: 409, json: { title: "Conflict", status: 409, detail: "Last active admin cannot be removed" } }));
  await login(page);
  await page.getByRole("link", { name: "Usuários", exact: true }).click();
  await page.getByRole("button", { name: "Novo usuário" }).click();
  const form = page.getByRole("dialog", { name: "Novo usuário" });
  await form.getByLabel("Senha", { exact: true }).fill("short");
  await form.getByRole("button", { name: "Salvar" }).click();
  await expect(form.getByLabel("Senha", { exact: true })).toHaveAttribute("aria-invalid", "true");
  await form.getByRole("button", { name: "Cancelar" }).click();
  await page.getByRole("button", { name: "Excluir", exact: true }).click();
  const remove = page.getByRole("dialog", { name: "Excluir usuário" });
  await remove.getByRole("button", { name: "Excluir", exact: true }).click();
  await expect(remove.getByRole("alert")).toContainText("Last active admin");
  await expect(remove).toBeVisible();
});

test("audit mostra publicação com autor, antes/depois e filtra com cursor", async ({ page }) => {
  const queries: URLSearchParams[] = [];
  await page.route("**/api/v1/audit-events*", (route) => {
    const query = new URL(route.request().url()).searchParams;
    queries.push(query);
    return route.fulfill({ json: { items: query.has("cursor") ? [{ ...publication, id: envId, action: "service.update", entityType: "service", before: { host: "old.internal" }, after: { host: "new.internal" } }] : [publication], nextCursor: query.has("cursor") ? null : "next-audit" } });
  });
  await login(page);
  await page.getByRole("link", { name: "Auditoria", exact: true }).click();
  await expect(page.getByText("snapshot.publish", { exact: true })).toBeVisible();
  const event = page.getByRole("article", { name: `snapshot.publish por ${admin.name}` });
  await expect(page.locator(".final-page")).toBeVisible();
  await expect(event.getByRole("table").first()).toHaveClass("cards");
  await expect(event.getByRole("heading", { name: "snapshot.publish", exact: true })).toHaveClass("mono");
  await expect(page.getByRole("form", { name: "Filtros de auditoria" })).toHaveClass(/gateway-filters/);
  await expect(event).toContainText(admin.name);
  await expect(event).toContainText(admin.id);
  await expect(event).toContainText(`${publication.entityType} · ${publication.entityId}`);
  await expect(event.locator("dl.service-properties")).toContainText(envId);
  await expect(event.locator("dl.service-properties")).toContainText(publication.ip);
  await expect(event.locator("time")).toHaveAttribute("datetime", publication.at);
  await expect(event.getByRole("columnheader", { name: "Antes" })).toBeVisible();
  await expect(event.getByRole("columnheader", { name: "Depois" })).toBeVisible();
  await expect(event).toContainText("Publicação da UI");
  await expect(event).toContainText("REDACTED");
  await page.getByLabel("ID do environment").fill(envId);
  await page.getByLabel("ID do autor").fill(admin.id);
  await page.getByLabel("Tipo de entidade").fill("snapshot");
  await page.getByLabel("De", { exact: true }).fill("2026-10-15T00:00");
  await page.getByLabel("Até", { exact: true }).fill("2026-10-16T00:00");
  await page.getByLabel("Eventos por página").selectOption("25");
  await page.getByRole("button", { name: "Filtrar", exact: true }).click();
  await expect.poll(() => queries.at(-1)?.get("actorId")).toBe(admin.id);
  expect(queries.at(-1)?.get("environmentId")).toBe(envId);
  expect(queries.at(-1)?.get("entityType")).toBe("snapshot");
  expect(queries.at(-1)?.get("limit")).toBe("25");
  expect(queries.at(-1)?.get("from")).toMatch(/^2026-10-15T\d{2}:00:00.000Z$/);
  expect(queries.at(-1)?.get("to")).toMatch(/^2026-10-16T\d{2}:00:00.000Z$/);
  await page.getByRole("button", { name: "Carregar mais" }).click();
  await expect(page.getByText("old.internal", { exact: false })).toBeVisible();
  expect(queries.at(-1)?.get("cursor")).toBe("next-audit");
  expect(queries.at(-1)?.get("actorId")).toBe(admin.id);
  await page.getByRole("button", { name: "Limpar filtros" }).click();
  await expect(page.getByLabel("ID do autor")).toHaveValue("");
});

test("auditoria vazia usa EmptyState e conserva os filtros e a validação do período", async ({ page }) => {
  let requests = 0;
  await page.route("**/api/v1/audit-events*", (route) => {
    requests++;
    return route.fulfill({ json: { items: [], nextCursor: null } });
  });
  await login(page);
  await page.getByRole("link", { name: "Auditoria", exact: true }).click();
  await expect(page.locator(".empty-state").getByRole("heading", { name: "Nenhum evento encontrado." })).toBeVisible();
  await page.getByLabel("De", { exact: true }).fill("2026-10-16T00:00");
  await page.getByLabel("Até", { exact: true }).fill("2026-10-15T00:00");
  const beforeFilter = requests;
  await page.getByRole("button", { name: "Filtrar", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Informe um período válido");
  expect(requests).toBe(beforeFilter);
  await page.getByRole("button", { name: "Limpar filtros" }).click();
  await expect(page.getByLabel("De", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Até", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Eventos por página")).toHaveValue("50");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("login por cookie → service → route → publicação → audit com o mesmo autor", async ({ page }) => {
  let publishedVersion: number | null = null;
  await page.route("**/api/v1/audit-events*", (route) => route.fulfill({ json: {
    items: publishedVersion === null ? [] : [{ ...publication, entityId: String(publishedVersion), after: { version: publishedVersion, message: "Publicação da UI" } }],
    nextCursor: null,
  } }));
  await login(page);
  await page.getByRole("button", { name: "Novo service" }).click();
  const service = page.getByRole("dialog", { name: "Novo service" });
  await service.getByLabel("Nome").fill("orders");
  await service.getByLabel("Host").fill("orders.internal");
  await service.getByLabel("Porta").fill("8080");
  const serviceCreated = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/services"));
  await service.getByRole("button", { name: "Salvar" }).click();
  expect((await serviceCreated).status()).toBe(201);
  await expect(service).toBeHidden();
  await page.getByRole("link", { name: "Routes", exact: true }).click();
  await page.getByRole("button", { name: "Nova route" }).click();
  const route = page.getByRole("dialog", { name: "Nova route" });
  await route.getByLabel("Nome").fill("orders-api");
  await route.getByLabel("Paths").fill("/orders");
  const routeCreated = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/routes"));
  await route.getByRole("button", { name: "Salvar" }).click();
  expect((await routeCreated).status()).toBe(201);
  await expect(route).toBeHidden();
  await page.getByRole("region", { name: "Publicação" }).getByRole("button", { name: /^Publicar v\d+$/ }).click();
  const publish = page.getByRole("region", { name: "Revisar e publicar" });
  await expect(publish.locator('[data-change="added"]')).toHaveCount(2);
  await publish.getByLabel("Mensagem").fill("Publicação da UI");
  const published = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/snapshots"));
  await publish.getByRole("button", { name: /^Publicar v\d+$/ }).click();
  const response = await published;
  expect(response.status()).toBe(201);
  const snapshot = await response.json() as { version: number };
  publishedVersion = snapshot.version;
  await expect(publish).toBeHidden();
  await page.getByRole("link", { name: "Auditoria", exact: true }).click();
  const event = page.getByRole("article", { name: `snapshot.publish por ${admin.name}` });
  await expect(event).toContainText(admin.id);
  await expect(event).toContainText(`"version": ${snapshot.version}`);
  await expect(event).toContainText("Publicação da UI");
});


test("user row menu retains edit, environment roles and confirmed deletion", async ({ page }) => {
  await page.route("**/api/v1/users", (route) => route.fulfill({ json: { items: [viewer], nextCursor: null } }));
  await login(page);
  await page.goto("/users");
  const row = page.getByRole("row").filter({ hasText: viewer.email });
  const menu = row.getByRole("button", { name: `Mais ações para ${viewer.name}` });
  await expect(row.locator(".mono")).toHaveText(viewer.email);
  await expect(row.locator(".badge")).toHaveText(["Leitor", "Ativo"]);
  await menu.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Editar", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: `Editar ${viewer.name}` })).toBeVisible();
  await page.getByRole("button", { name: "Cancelar", exact: true }).click();
  await menu.click();
  await page.getByRole("menuitem", { name: "Environments", exact: true }).click();
  await expect(page.getByRole("table", { name: "Papéis por environment" })).toHaveClass("cards");
  await page.getByRole("button", { name: "Cancelar", exact: true }).click();
  await menu.click();
  await page.getByRole("menuitem", { name: "Excluir", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "Excluir usuário" });
  await expect(confirm).toContainText(viewer.email);
  await expect(confirm.getByRole("button", { name: "Excluir", exact: true })).toHaveClass("danger");
  await confirm.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(row).toBeVisible();
});

test("empty user list uses the shared empty state and retains creation", async ({ page }) => {
  await page.route("**/api/v1/users", (route) => route.fulfill({ json: { items: [], nextCursor: null } }));
  await login(page);
  await page.goto("/users");
  await expect(page.getByRole("heading", { name: "Nenhum usuário encontrado.", level: 2 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Novo usuário", exact: true })).toBeVisible();
});
