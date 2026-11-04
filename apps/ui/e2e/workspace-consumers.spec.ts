import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import type { components } from "../src/api/schema-v2";
import { expect, mockSession, test } from "./fixtures";

const A = "7c1d2e3f-4a5b-4c6d-8e7f-00000000000a";
const B = "7c1d2e3f-4a5b-4c6d-8e7f-00000000000b";
const C = "7c1d2e3f-4a5b-4c6d-8e7f-00000000000c";
const D = "7c1d2e3f-4a5b-4c6d-8e7f-00000000000d";
const stamp = "2026-11-03T12:00:00Z";
const timestamps = { createdAt: stamp, updatedAt: stamp };
const user = { id: A, name: "Ana", email: "ana@example.test", role: "viewer" as const, active: true, ...timestamps };
const consumer = (id: string, username = "checkout-A") => ({ id, username, customId: "billing", tags: [], ...timestamps });
const workspace = (id: string, archived = false) => ({ id, key: id, name: id === A ? "Workspace A" : "Workspace B", slug: id === A ? "alpha" : "beta", status: archived ? "archived" : "active", activeRelease: null });
const list = (items: unknown[], nextCursor: string | null = null) => ({ items, nextCursor });
const url = (id = A, detail = false) => `/workspaces/${id}/consumers${detail ? `/${C}` : ""}`;

async function setup(page: Page, options: { archived?: boolean; contextStatus?: number; listStatus?: number; empty?: boolean; pagination?: boolean; writeStatus?: number; longName?: boolean } = {}) {
  const sent: { method: string; path: string; search: string }[] = [];
  const writes: { method: string; path: string; body: unknown }[] = [];
  let items = options.empty ? [] : [consumer(C, options.longName ? "checkout-" + "x".repeat(120) : "checkout-A")];
  let keys: object[] = [], jwt: object[] = [], basic: object[] = [], groups: string[] = ["staff"];
  await page.route(/^https?:\/\/[^/]+\/api\/v[12]\//, async route => {
    const r = route.request(), u = new URL(r.url()), path = u.pathname, method = r.method();
    sent.push({ method, path, search: u.search });
    const json = (value: unknown, status = 200) => route.fulfill({ status, json: value });
    if (path === "/api/v1/auth/csrf") return json({ csrfToken: "csrf" });
    if (path === "/api/v2/workspace-creation-policy") return json({ status: 403 }, 403);
    if (path === "/api/v2/workspaces") return json(list([workspace(A, options.archived), workspace(B)]));
    if (path === `/api/v2/workspaces/${A}` || path === `/api/v2/workspaces/${B}`) return json(workspace(path.endsWith(A) ? A : B, options.archived), options.contextStatus);
    if (method !== "GET") {
      const body: unknown = r.postData() ? r.postDataJSON() : null;
      writes.push({ method, path, body });
      if (options.writeStatus) {
        const problem: components["schemas"]["Problem"] & { code?: string } = {
          type: "about:blank", title: "must-not-echo-secret", status: options.writeStatus,
          code: options.writeStatus === 409 ? "auto-publish" : undefined,
          detail: "must-not-echo-secret", errors: [{ path: "username", message: "must-not-echo-secret" }],
        };
        return route.fulfill({ status: options.writeStatus, json: problem, contentType: "application/problem+json" });
      }
      const base = `/api/v2/workspaces/${A}/consumers`;
      if (path === base && method === "POST") { items = [consumer(C), ...(items.filter(c => c.id !== C))]; items[0] = { ...items[0]!, ...(body as object) }; return json(items[0], 201); }
      if (path === `${base}/${C}`) {
        if (method === "DELETE") { items = []; return route.fulfill({ status: 204 }); }
        items = [{ ...items[0]!, ...(body as object) }]; return json(items[0]);
      }
      const credential = { id: D, consumerId: C, status: "active", ...timestamps };
      if (path === `${base}/${C}/key-auth` && method === "POST") { keys = [{ ...credential, keyHint: "…last" }]; return json({ ...keys[0], key: "key-created-once" }, 201); }
      if (path.endsWith("/key-auth/" + D + "/rotate")) return json({ ...keys[0], key: "key-rotated-once" });
      if (path.endsWith("/key-auth/" + D) && method === "DELETE") { keys = []; return route.fulfill({ status: 204 }); }
      if (path === `${base}/${C}/jwt` && method === "POST") { jwt = [{ ...credential, key: "issuer", algorithm: "HS256" }]; return json({ ...jwt[0], secret: "jwt-created-once" }, 201); }
      if (path.endsWith("/jwt/" + D + "/rotate")) return json({ ...jwt[0], secret: "jwt-rotated-once" });
      if (path.endsWith("/jwt/" + D) && method === "DELETE") { jwt = []; return route.fulfill({ status: 204 }); }
      if (path === `${base}/${C}/basic-auth` && method === "POST") { basic = [{ ...credential, username: "basic-app" }]; return json(basic[0], 201); }
      if (path.endsWith("/basic-auth/" + D) && method === "DELETE") { basic = []; return route.fulfill({ status: 204 }); }
      if (path === `${base}/${C}/acl-groups` && method === "PUT") { groups = (body as { groups: string[] }).groups; return json({ groups }); }
      return json({ title: "Unexpected mutation", status: 500 }, 500);
    }
    for (const id of [A, B]) {
      if (path === `/api/v2/workspaces/${id}/plugins`) return json(list([]));
      const base = `/api/v2/workspaces/${id}/consumers`;
      if (path === base) {
        if (options.listStatus) return json({ status: options.listStatus }, options.listStatus);
        if (id === B) return json(list([]));
        if (u.searchParams.get("cursor")) return json(list([consumer(D, "second-page")]));
        const q = u.searchParams.get("q") ?? "";
        return json(list(items.filter(c => c.username?.includes(q)), options.pagination && !q ? "next-page" : null));
      }
      if (path === `${base}/${C}`) return items[0] ? json(items[0]) : json({ status: 404 }, 404);
      if (path === `${base}/${C}/key-auth`) return json(list(keys));
      if (path === `${base}/${C}/jwt`) return json(list(jwt));
      if (path === `${base}/${C}/basic-auth`) return json(list(basic));
      if (path === `${base}/${C}/acl-groups`) return json({ groups });
    }
    return json({ title: "Unexpected query", status: 404 }, 404);
  });
  await mockSession(page, user);
  await page.context().addCookies([{ name: "gromesh_session", value: "consumer-test", url: test.info().project.use.baseURL! }]);
  return { sent, writes };
}
async function audit(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}
async function secretOnce(page: Page, secret: string) {
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(secret, { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Já copiei" }).click();
  await expect(page.getByText(secret, { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain(secret);
  expect(page.url()).not.toContain(secret);
}
async function deleteCredential(page: Page, menu: string, title: string) {
  await page.getByRole("button", { name: menu, exact: true }).click();
  await page.getByRole("menuitem", { name: "Excluir", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: title, exact: true });
  await dialog.getByRole("button", { name: "Excluir", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

test("consumer CRUD, server search and pagination use v2 for a viewer with a workspace grant", async ({ page }) => {
  const fake = await setup(page, { pagination: true });
  await page.goto(url());
  await expect(page.getByRole("link", { name: "checkout-A", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Carregar mais" }).click();
  await expect(page.getByRole("link", { name: "second-page", exact: true })).toBeVisible();
  expect(fake.sent.some(r => r.search.includes("cursor=next-page"))).toBe(true);
  await page.getByRole("searchbox", { name: "Buscar consumidores" }).fill("missing");
  await expect(page.getByText("Nenhum consumidor encontrado.")).toBeVisible();
  expect(fake.sent.some(r => r.search.includes("q=missing"))).toBe(true);
  await page.getByRole("button", { name: "Novo consumidor" }).click();
  let dialog = page.getByRole("dialog", { name: "Novo consumidor", exact: true });
  await dialog.getByRole("button", { name: "Salvar", exact: true }).click();
  await expect(dialog.getByText("Informe o nome de usuário ou o identificador personalizado.", { exact: true })).toBeVisible();
  expect(fake.writes).toHaveLength(0);
  await dialog.getByLabel("Nome de usuário", { exact: true }).fill("created-app");
  await dialog.getByRole("button", { name: "Salvar", exact: true }).click();
  await expect(page).toHaveURL(url(A, true));
  await expect(page.getByRole("heading", { name: "Consumidor created-app", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Consumidor created-app", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Editar", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Editar created-app", exact: true });
  await dialog.getByLabel("Nome de usuário", { exact: true }).fill("renamed-app");
  await dialog.getByRole("button", { name: "Salvar", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Consumidor renamed-app", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Mais ações para renamed-app" }).click();
  await page.getByRole("menuitem", { name: "Excluir", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Excluir consumidor", exact: true });
  expect(fake.writes.map(r => r.method)).toEqual(["POST", "PUT"]);
  await dialog.getByRole("button", { name: "Cancelar", exact: true }).click();
  await page.getByRole("link", { name: "← Consumidores", exact: true }).click();
  await expect(page).toHaveURL(url());
  await deleteCredential(page, "Mais ações para renamed-app", "Excluir consumidor");
  await expect(page.getByText("Nenhum consumidor ainda.")).toBeVisible();
  expect(fake.writes.map(r => r.method)).toEqual(["POST", "PUT", "DELETE"]);
  expect(fake.writes.every(r => r.path.startsWith(`/api/v2/workspaces/${A}/consumers`))).toBe(true);
  expect(fake.sent.some(r => r.path.startsWith("/api/v1/environments"))).toBe(false);
});

test("key-auth, JWT, basic-auth and ACL preserve one-time secrets and full-set replacement", async ({ page }) => {
  const fake = await setup(page); await page.goto(url(A, true));
  await page.getByRole("button", { name: "Gerar chave", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Gerar", exact: true }).click();
  await secretOnce(page, "key-created-once");
  await page.getByRole("button", { name: "Mais ações para a chave …last", exact: true }).click();
  await page.getByRole("menuitem", { name: "Gerar nova chave", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Gerar", exact: true }).click();
  await secretOnce(page, "key-rotated-once");
  await deleteCredential(page, "Mais ações para a chave …last", "Excluir chave");
  await page.getByRole("button", { name: "Nova credencial JWT", exact: true }).click();
  await expect(page.getByRole("dialog").getByLabel("Segredo", { exact: true })).toHaveCount(0);
  await page.getByRole("dialog").getByRole("button", { name: "Criar", exact: true }).click();
  await secretOnce(page, "jwt-created-once");
  await page.getByRole("button", { name: "Mais ações para a credencial JWT issuer", exact: true }).click();
  await page.getByRole("menuitem", { name: "Gerar novo segredo", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Gerar", exact: true }).click();
  await secretOnce(page, "jwt-rotated-once");
  await deleteCredential(page, "Mais ações para a credencial JWT issuer", "Excluir credencial JWT");
  await page.getByRole("button", { name: "Nova credencial basic-auth", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Nome de usuário", { exact: true }).fill("basic-app");
  await dialog.getByLabel("Senha", { exact: true }).fill("password-test-only");
  await dialog.getByRole("button", { name: "Criar", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Mais ações para o usuário basic-app", exact: true }).click();
  await expect(page.getByRole("menuitem")).toHaveCount(1); // No basic-auth rotation endpoint exists.
  await page.getByRole("menuitem", { name: "Excluir", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Excluir", exact: true }).click();
  await expect(page.getByText("password-test-only")).toHaveCount(0);
  await page.getByRole("tab", { name: "Grupos ACL", exact: true }).click();
  await page.getByRole("button", { name: "Editar grupos", exact: true }).click();
  await page.getByLabel("Grupos", { exact: true }).fill("partners, partners, billing");
  await page.getByRole("button", { name: "Salvar grupos", exact: true }).click();
  await expect(page.getByRole("list", { name: "Grupos", exact: true })).toContainText("partners");
  expect(fake.writes.at(-1)).toMatchObject({ method: "PUT", body: { groups: ["partners", "billing"] } });
  await page.getByRole("button", { name: "Editar grupos", exact: true }).click();
  await page.getByLabel("Grupos", { exact: true }).fill("");
  await page.getByRole("button", { name: "Salvar grupos", exact: true }).click();
  await expect(page.getByText("Nenhum grupo.", { exact: true })).toBeVisible();
  expect(fake.writes.at(-1)?.body).toEqual({ groups: [] });
  await page.getByRole("tab", { name: "Plugins", exact: true }).click();
  await expect(page.getByText("Nenhum plugin neste consumidor.")).toBeVisible();
  expect(fake.writes.filter(r => r.path.endsWith("/rotate"))).toHaveLength(2);
  expect(fake.sent.some(r => r.path.startsWith("/api/v1/environments"))).toBe(false);
});

for (const width of [390, 768, 1440]) {
  test(`deep link, refresh, axe and horizontal bounds at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await setup(page, { longName: true }); await page.goto(url());
    await expect(page.getByRole("heading", { name: "Consumidores", exact: true })).toBeVisible(); await audit(page);
    await page.getByRole("link", { name: /^checkout-/ }).click();
    await expect(page).toHaveURL(url(A, true)); await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: /^Consumidor checkout-/ })).toBeVisible(); await audit(page);
    await page.getByRole("button", { name: "Editar", exact: true }).click(); await audit(page);
    await page.getByRole("dialog").getByRole("button", { name: "Cancelar", exact: true }).click();
    await page.getByRole("button", { name: "Gerar chave", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Gerar", exact: true }).click();
    await expect(page.getByText("key-created-once", { exact: true })).toBeVisible(); await audit(page);
    await page.getByRole("dialog").getByRole("button", { name: "Já copiei" }).click();
    await page.getByRole("tab", { name: "Grupos ACL", exact: true }).click(); await audit(page);
  });
}

for (const status of [403, 404, 401]) {
  test(`context ${status} does not load consumer data`, async ({ page }) => {
    const fake = await setup(page, { contextStatus: status }); await page.goto(url(A, true));
    if (status === 401) await expect(page).toHaveURL(/\/login/);
    else await expect(page.getByText(status === 403 ? "Você não tem permissão para acessar este contexto." : "Não encontrado ou indisponível para sua conta.", { exact: true })).toBeVisible();
    expect(fake.sent.some(r => r.path.includes("/consumers"))).toBe(false); await audit(page);
  });
}
for (const status of [403, 404, 503]) {
  test(`list ${status} is an error, never an empty state`, async ({ page }) => {
    await setup(page, { listStatus: status }); await page.goto(url());
    await expect(page.getByText(status === 403 ? "Você não tem permissão para esta ação." : status === 404 ? "Item não encontrado. Ele pode ter sido excluído." : "Erro inesperado (HTTP 503).", { exact: true })).toBeVisible();
    await expect(page.getByText("Nenhum consumidor ainda.")).toHaveCount(0); await audit(page);
  });
}
for (const status of [403, 409, 422]) {
  test(`server rejects consumer write with ${status} without echoing detail`, async ({ page }) => {
    const fake = await setup(page, { writeStatus: status }); await page.goto(url(A, true));
    await page.getByRole("button", { name: "Editar", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Editar checkout-A", exact: true });
    await dialog.getByLabel("Nome de usuário", { exact: true }).fill("edited-checkout");
    await dialog.getByRole("button", { name: "Salvar", exact: true }).click();
    const message = status === 403 ? "Você não tem permissão para esta ação."
      : status === 409 ? "Este Workspace publica automaticamente pelo fluxo legado. Mude para publicação manual antes de editar por aqui."
      : "Valor inválido. Confira este campo.";
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(dialog.getByRole("alert")).toHaveText(message);
    if (status === 422) await expect(dialog.getByLabel("Nome de usuário", { exact: true })).toHaveAttribute("aria-invalid", "true");
    await expect(dialog.getByLabel("Nome de usuário", { exact: true })).toHaveValue("edited-checkout");
    await expect(dialog.getByLabel("Identificador personalizado", { exact: true })).toHaveValue("billing");
    await expect(dialog.getByRole("button", { name: "Salvar", exact: true })).toBeEnabled();
    await expect(page).toHaveURL(url(A, true));
    await expect(page.locator("body")).not.toContainText("must-not-echo-secret");
    expect(fake.writes[0]).toEqual({ method: "PUT", path: `/api/v2/workspaces/${A}/consumers/${C}`, body: { username: "edited-checkout", customId: "billing", tags: [] } });
    expect(fake.writes).toHaveLength(1); await audit(page);
  });
}

test("archived workspace is readable across all sections", async ({ page }) => {
  const fake = await setup(page, { archived: true }); await page.goto(url());
  await expect(page.getByText("Somente leitura: este Workspace está arquivado.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Novo consumidor" })).toHaveCount(0);
  await page.getByRole("link", { name: "checkout-A", exact: true }).click();
  for (const name of ["Credenciais", "Grupos ACL", "Plugins"]) {
    await page.getByRole("tab", { name, exact: true }).click();
    await expect(page.getByRole("button", { name: /^Editar$|Gerar chave|Nova credencial|Editar grupos|Mais ações/ })).toHaveCount(0);
  }
  expect(fake.writes).toHaveLength(0); await audit(page);
});

test("switching A to B discards open forms and revealed secrets", async ({ page }) => {
  const fake = await setup(page); await page.goto(url(A, true));
  await page.getByRole("button", { name: "Gerar chave", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Gerar", exact: true }).click();
  await expect(page.getByText("key-created-once", { exact: true })).toBeVisible();
  await page.getByLabel("Workspace v2", { exact: true }).selectOption(B, { force: true });
  await expect(page).toHaveURL(url(B));
  await expect(page.getByText("Nenhum consumidor ainda.")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0); await expect(page.getByText("key-created-once")).toHaveCount(0);
  await page.getByRole("button", { name: "Novo consumidor" }).click();
  await expect(page.getByRole("dialog").getByLabel("Nome de usuário", { exact: true })).toHaveValue("");
  await page.getByRole("dialog").getByLabel("Nome de usuário", { exact: true }).fill("unsaved-B");
  await page.getByLabel("Workspace v2", { exact: true }).selectOption(A, { force: true });
  await expect(page.getByRole("link", { name: "checkout-A", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Novo consumidor" }).click();
  await expect(page.getByRole("dialog").getByLabel("Nome de usuário", { exact: true })).toHaveValue("");
  expect(fake.writes).toHaveLength(1);
});

test("loading and late A list responses never populate B", async ({ page }) => {
  const fake = await setup(page);
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/v2/workspaces/${A}/consumers`, async route => { await held; return route.fulfill({ json: list([consumer(C)]) }); });
  await page.goto(url());
  await expect(page.getByText("Carregando…", { exact: true })).toBeVisible();
  await expect(page.getByText("Nenhum consumidor ainda.")).toHaveCount(0);
  await page.getByLabel("Workspace v2", { exact: true }).selectOption(B); release();
  await expect(page).toHaveURL(url(B)); await expect(page.getByText("Nenhum consumidor ainda.")).toBeVisible();
  await expect(page.getByRole("link", { name: "checkout-A", exact: true })).toHaveCount(0);
  expect(fake.writes).toHaveLength(0);
});
