import AxeBuilder from "@axe-core/playwright";
import type { Page, Route } from "@playwright/test";
import type { Plugin, PluginCatalogEntry } from "../src/api/client";
import type { components } from "../src/api/schema-v2";
import { expect, mockSession, test } from "./fixtures";

const A = "7c1d2e3f-4a5b-4c6d-8e7f-00000000000a", B = "7c1d2e3f-4a5b-4c6d-8e7f-00000000000b";
const C = "7c1d2e3f-4a5b-4c6d-8e7f-00000000000c", D = "7c1d2e3f-4a5b-4c6d-8e7f-00000000000d";
const P = "7c1d2e3f-4a5b-4c6d-8e7f-00000000000e";
const timestamps = { createdAt: "2026-11-03T12:00:00Z", updatedAt: "2026-11-03T12:00:00Z" };
const user = { id: A, name: "Ana", email: "ana@example.test", role: "viewer" as const, active: true, ...timestamps };
const url = (w = A, c = C) => `/workspaces/${w}/consumers/${c}`;
const list = (items: unknown[], nextCursor: string | null = null) => ({ items, nextCursor });
const consumer = (id: string) => ({ id, username: id === C ? "checkout-A" : "checkout-B", customId: null, tags: [], ...timestamps });
const workspace = (id: string, archived = false) => ({ id, key: id, name: id === A ? "Workspace A" : "Workspace B", slug: id === A ? "alpha" : "beta", status: archived && id === A ? "archived" : "active", activeRelease: null });
const plugin: Plugin = { id: P, name: "rate-limiting", enabled: true, scope: { consumerId: C }, config: { minute: 10, password: "REDACTED" } as unknown as Plugin["config"], tags: [], ...timestamps };
const schema = { fields: [{ consumer: { type: "foreign" } }, { config: { type: "record", fields: [
  { minute: { type: "integer", required: true, default: 10, gt: 0 } },
  { password: { type: "string", encrypted: true } },
] } }] };
const names = ["rate-limiting", "cors", "key-auth", "basic-auth", "jwt", "file-log", "pre-function", "post-function", "http-log", "prometheus", "gromesh-workspace"];
const catalog: PluginCatalogEntry[] = names.map(name => ({ name, category: ["key-auth", "basic-auth", "jwt"].includes(name) ? "authentication" : "traffic-control", supportedInDbless: true, source: "bundled" }));
type Rejection = { status: number; path?: string; code?: string; message?: string };
async function setup(page: Page, options: { empty?: boolean; archived?: boolean; pagination?: boolean; listStatus?: number; consumerStatus?: number; contextStatus?: number; hold?: boolean; combined?: boolean; reserved?: boolean; foreign?: boolean } = {}) {
  const sent: { method: string; path: string; search: string }[] = [], writes: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
  let items: Plugin[] = options.empty ? [] : [{ ...plugin, ...(options.combined ? { scope: { consumerId: C, serviceId: A, routeId: P } } : {}), ...(options.reserved ? { name: "http-log", tags: ["gromesh-platform"] } : {}) }];
  let otherItems: Plugin[] = [];
  let rejection: Rejection | null = null, deleted = false, network = false;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const reject = (route: Route, failure: Rejection) => {
    const problem: components["schemas"]["Problem"] & { code?: string } = { type: "about:blank", title: "must-not-echo-secret", status: failure.status, detail: "must-not-echo-secret", code: failure.code, errors: [{ path: failure.path ?? "config.minute", message: failure.message ?? "must-not-echo-secret" }] };
    return route.fulfill({ status: failure.status, json: problem, contentType: "application/problem+json" });
  };
  await page.route(/^https?:\/\/[^/]+\/api\/v[12]\//, async route => {
    const r = route.request(), u = new URL(r.url()), path = u.pathname, method = r.method();
    sent.push({ method, path, search: u.search });
    const json = (value: unknown, status = 200) => route.fulfill({ status, json: value });
    if (path === "/api/v1/auth/csrf") return json({ csrfToken: "csrf" });
    if (path === "/api/v2/workspace-creation-policy") return json({ title: "Forbidden", status: 403 }, 403);
    if (path === "/api/v2/workspaces") return json(list([workspace(A, options.archived), workspace(B)]));
    for (const w of [A, B]) {
      if (path === `/api/v2/workspaces/${w}`) return options.contextStatus && w === A ? reject(route, { status: options.contextStatus }) : json(workspace(w, options.archived));
      const c = w === A ? C : D, base = `/api/v2/workspaces/${w}`;
      if (path === `${base}/consumers`) return json(list([consumer(c)]));
      if (path === `${base}/consumers/${c}`) return options.consumerStatus || deleted ? reject(route, { status: options.consumerStatus ?? 404 }) : json(consumer(c));
      if (path === `${base}/consumers/${c}/key-auth` || path === `${base}/consumers/${c}/jwt` || path === `${base}/consumers/${c}/basic-auth`) return json(list([]));
      if (path === `${base}/plugins` && method === "GET") {
        if (options.hold && w === A) await held;
        if (options.listStatus) return reject(route, { status: options.listStatus });
        // Filter is mandatory: fail the test if the product asks for a global list.
        if (u.searchParams.get("consumerId") !== c) return json({ title: "Missing consumer filter", status: 422 }, 422);
        if (w === B) return json(list(otherItems));
        if (options.pagination && !u.searchParams.has("cursor")) return json(list([], "page-2"));
        return json(list(options.foreign ? [...items, { ...plugin, id: D, name: "other-consumer-plugin", scope: { consumerId: D } }, { ...plugin, id: B, name: "platform-global-plugin", scope: {} }] : items));
      }
      if (path === `${base}/plugins/${P}` && method === "GET") return (w === A ? items : otherItems)[0] ? json((w === A ? items : otherItems)[0]) : reject(route, { status: 404 });
      if (path.startsWith(`${base}/plugins`) && method !== "GET") {
        const body = r.postData() ? r.postDataJSON() as Record<string, unknown> : null;
        writes.push({ method, path, body });
        if (network) return route.abort("failed");
        if (rejection) return reject(route, rejection);
        if (method === "DELETE") { if (w === A) items = []; else otherItems = []; return route.fulfill({ status: 204 }); }
        const scope = body?.scope as Plugin["scope"];
        if (scope?.consumerId !== c) return reject(route, { status: 422, path: "scope.consumerId" });
        const saved = { ...plugin, ...body, config: { minute: (body?.config as Record<string, unknown>)?.minute, password: "REDACTED" } as unknown as Plugin["config"] };
        if (w === A) items = [saved]; else otherItems = [saved];
        return json(saved, method === "POST" ? 201 : 200);
      }
    }
    if (path === "/api/v1/plugin-schemas") return json({ kongVersion: "3.9.4", items: catalog });
    if (path.startsWith("/api/v1/plugin-schemas/")) return json(path.endsWith("/cors") ? { fields: [{ consumer: { type: "foreign", eq: null } }] } : schema);
    return json({ type: "about:blank", title: "Unexpected API call", status: 404 }, 404);
  });
  await mockSession(page, user);
  await page.context().addCookies([{ name: "gromesh_session", value: "consumer-plugin-test", url: test.info().project.use.baseURL! }]);
  return { sent, writes, release, reject: (value: Rejection | null) => { rejection = value; }, deleteConsumer: () => { deleted = true; }, failNetwork: () => { network = true; } };
}
async function open(page: Page, w = A, c = C) {
  await page.goto(url(w, c));
  await page.getByRole("tab", { name: "Plugins", exact: true }).click();
}
async function create(page: Page) {
  await page.getByRole("button", { name: "Associar plugin", exact: true }).click();
  await page.getByRole("dialog", { name: "Escolha um plugin" }).getByRole("button", { name: "rate-limiting", exact: true }).click();
  await expect(page.getByRole("button", { name: "Salvar no rascunho" })).toBeEnabled();
}
async function audit(page: Page) {
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test("associates, edits enabled/config and removes only the fixed consumer plugin", async ({ page }) => {
  const fake = await setup(page, { empty: true }); await open(page);
  await expect(page.getByText("Nenhum plugin neste consumidor.", { exact: true })).toBeVisible();
  await create(page);
  await expect(page.getByLabel("Consumidor", { exact: true })).toHaveValue("checkout-A");
  await expect(page.getByLabel("Consumidor", { exact: true })).toHaveAttribute("readonly", "");
  await expect(page.getByRole("dialog").getByRole("combobox")).toHaveCount(1); // Only the fixed plugin name, no scope selectors.
  await page.getByLabel("password", { exact: true }).fill("typed-secret-only");
  await page.getByRole("button", { name: "Salvar no rascunho" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Editar rate-limiting" }).click();
  await expect(page.getByLabel("password", { exact: true })).toHaveValue("");
  await page.getByLabel("minute", { exact: true }).fill("25"); await page.getByLabel("Ativo", { exact: true }).uncheck();
  await page.getByRole("button", { name: "Salvar no rascunho" }).click(); await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("table", { name: "Plugins do consumidor", exact: true })).toContainText("Não");
  await page.getByRole("button", { name: "Mais ações para rate-limiting" }).click(); await page.getByRole("menuitem", { name: "Excluir", exact: true }).click();
  expect(fake.writes).toHaveLength(2);
  await page.getByRole("dialog").getByRole("button", { name: "Cancelar" }).click(); expect(fake.writes).toHaveLength(2);
  await page.getByRole("button", { name: "Mais ações para rate-limiting" }).click(); await page.getByRole("menuitem", { name: "Excluir", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Excluir", exact: true }).click();
  await expect(page.getByText("Nenhum plugin neste consumidor.", { exact: true })).toBeVisible();
  expect(fake.writes.map(r => r.method)).toEqual(["POST", "PUT", "DELETE"]);
  expect(fake.writes[0]?.body).toMatchObject({ scope: { consumerId: C }, config: { password: "typed-secret-only" } });
  expect(fake.writes[1]?.body).toMatchObject({ scope: { consumerId: C }, enabled: false, config: { minute: 25, password: "REDACTED" } });
  expect(fake.sent.some(r => /\/api\/v1\/environments|publish-preview/.test(r.path))).toBe(false);
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain("typed-secret-only");
});

test("reopening a saved consumer plugin waits for fresh detail and never PUTs the old value", async ({ page }) => {
  const fake = await setup(page); await open(page);
  await page.getByRole("button", { name: "Editar rate-limiting" }).click();
  await expect(page.getByLabel("minute", { exact: true })).toHaveValue("10");
  await page.getByLabel("minute", { exact: true }).fill("25");
  let release!: () => void, detailReads = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  // Reopening must work even while the list and the previous detail remain stale.
  await page.route(u => u.pathname === `/api/v2/workspaces/${A}/plugins` || u.pathname === `/api/v2/workspaces/${A}/plugins/${P}`, async route => {
    if (route.request().method() === "GET") {
      if (new URL(route.request().url()).pathname.endsWith(`/${P}`)) detailReads++;
      await held;
    }
    return route.fallback();
  });
  try {
    await page.getByRole("button", { name: "Salvar no rascunho" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(detailReads).toBe(0);
    await page.getByRole("button", { name: "Editar rate-limiting" }).click();
    await expect(page.getByRole("dialog").getByRole("status")).toHaveText("Carregando plugin…");
    await expect(page.getByLabel("minute", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Salvar no rascunho" })).toHaveCount(0);
    await expect.poll(() => detailReads).toBe(1);
    expect(fake.writes.map(w => w.method)).toEqual(["PUT"]);
    release();
    await expect(page.getByLabel("minute", { exact: true })).toHaveValue("25");
    await page.getByRole("button", { name: "Salvar no rascunho" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(detailReads).toBe(1);
    expect(fake.writes.map(w => [w.method, w.path, w.body?.scope, (w.body?.config as Record<string, unknown>)?.minute])).toEqual([
      ["PUT", `/api/v2/workspaces/${A}/plugins/${P}`, { consumerId: C }, 25],
      ["PUT", `/api/v2/workspaces/${A}/plugins/${P}`, { consumerId: C }, 25],
    ]);
  } finally { release(); }
});

test("filters authenticators, schema-forbidden types and platform capabilities from association", async ({ page }) => {
  const fake = await setup(page, { empty: true }); await open(page);
  await page.getByRole("button", { name: "Associar plugin", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Escolha um plugin" });
  await expect(picker.getByRole("button", { name: "rate-limiting", exact: true })).toBeVisible();
  for (const name of names.filter(n => n !== "rate-limiting")) await expect(picker.getByRole("button", { name, exact: true })).toHaveCount(0);
  expect(fake.writes).toHaveLength(0);
});
for (const failure of [
  { status: 422, path: "config.minute" },
  { status: 422, path: "scope.consumerId", message: "an authenticator cannot be scoped to a consumer" },
  { status: 422, path: "name", message: "plugin is not available to a Workspace" },
  { status: 403 }, { status: 404 }, { status: 409, code: "auto-publish" }, { status: 401 },
]) {
  test(`server rejection ${failure.status} ${failure.path ?? ""} preserves failure semantics`, async ({ page }) => {
    const fake = await setup(page); await open(page);
    fake.reject(failure); await page.getByRole("button", { name: "Editar rate-limiting" }).click();
    await page.getByLabel("minute", { exact: true }).fill("25");
    await page.getByRole("button", { name: "Salvar no rascunho" }).click();
    if (failure.status === 401) await expect(page).toHaveURL(/\/login/);
    else {
      const dialog = page.getByRole("dialog"); await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("alert").first()).toBeVisible();
      if (failure.status === 422) await expect(dialog.getByLabel(failure.path === "name" ? "Tipo do plugin" : failure.path === "scope.consumerId" ? "Consumidor" : "minute", { exact: true })).toHaveAttribute("aria-invalid", "true");
      if (failure.status === 409) await expect(dialog.getByRole("alert")).toContainText("Mude para publicação manual");
      if (failure.status === 403) await expect(dialog.getByRole("alert")).toContainText("permissão");
      if (failure.status === 404) await expect(dialog.getByRole("alert")).toContainText("Item não encontrado");
      await expect(dialog.getByLabel("minute", { exact: true })).toHaveValue("25");
      await expect(dialog.getByRole("button", { name: "Salvar no rascunho" })).toBeEnabled();
      await audit(page);
    }
    await expect(page.locator("body")).not.toContainText("must-not-echo-secret"); expect(fake.writes).toHaveLength(1);
  });
}

test("lists with cursor and does not render another consumer or a global plugin", async ({ page }) => {
  const fake = await setup(page, { pagination: true, foreign: true }); await open(page);
  await page.getByRole("button", { name: "Carregar mais" }).click();
  await expect(page.getByRole("table", { name: "Plugins do consumidor", exact: true })).toContainText("rate-limiting");
  await expect(page.getByText("other-consumer-plugin", { exact: true })).toHaveCount(0); await expect(page.getByText("platform-global-plugin", { exact: true })).toHaveCount(0);
  expect(fake.sent.some(r => r.search.includes("cursor=page-2") && r.search.includes(`consumerId=${C}`))).toBe(true);
});
test("preserves combined scopes on edit", async ({ page }) => {
  const fake = await setup(page, { combined: true }); await open(page);
  await page.getByRole("button", { name: "Editar rate-limiting" }).click(); await page.getByRole("button", { name: "Salvar no rascunho" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(fake.writes[0]?.body?.scope).toEqual({ consumerId: C, serviceId: A, routeId: P });
});
for (const options of [{ archived: true }, { reserved: true }]) test(`read-only plugin ${JSON.stringify(options)}`, async ({ page }) => {
  const fake = await setup(page, options); await open(page);
  await expect(page.getByRole("table", { name: "Plugins do consumidor", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Editar rate-limiting|Editar http-log|Mais ações para rate-limiting|Mais ações para http-log/ })).toHaveCount(0);
  if (options.archived) await expect(page.getByRole("button", { name: "Associar plugin" })).toHaveCount(0);
  expect(fake.writes).toHaveLength(0);
});
test("deleted consumer refuses association before any mutation", async ({ page }) => {
  const fake = await setup(page, { empty: true }); await open(page); await create(page); fake.deleteConsumer();
  await page.getByRole("button", { name: "Salvar no rascunho" }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Item não encontrado"); expect(fake.writes).toHaveLength(0);
});
test("deleted plugin is reported when editor fetches it", async ({ page }) => {
  await setup(page); await open(page);
  await page.route(`**/api/v2/workspaces/${A}/plugins/${P}`, route => route.fulfill({ status: 404, json: { type: "about:blank", title: "Gone", status: 404 } }));
  await page.getByRole("button", { name: "Editar rate-limiting" }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Item não encontrado");
  await expect(page.getByRole("button", { name: "Salvar no rascunho" })).toHaveCount(0);
});
for (const status of [403, 404, 401]) test(`list failure ${status} is never an empty list`, async ({ page }) => {
  const fake = await setup(page, { listStatus: status }); await open(page);
  if (status === 401) await expect(page).toHaveURL(/\/login/);
  else await expect(page.getByRole("tabpanel").getByRole("alert")).toContainText(status === 403 ? "permissão" : "Item não encontrado");
  await expect(page.getByRole("button", { name: "Associar plugin" })).toHaveCount(0);
  await expect(page.getByText("Nenhum plugin neste consumidor.", { exact: true })).toHaveCount(0); expect(fake.writes).toHaveLength(0);
});
test("network failure preserves the edited form", async ({ page }) => {
  const fake = await setup(page); await open(page); await page.getByRole("button", { name: "Editar rate-limiting" }).click(); fake.failNetwork();
  await page.getByRole("button", { name: "Salvar no rascunho" }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Não foi possível falar com o servidor");
  await expect(page.getByRole("button", { name: "Salvar no rascunho" })).toBeEnabled(); expect(fake.writes).toHaveLength(1);
});
test("switching A to B discards plugin form data and writes only in B's fixed scope", async ({ page }) => {
  const fake = await setup(page); await open(page); await page.getByRole("button", { name: "Editar rate-limiting" }).click();
  await page.getByLabel("password", { exact: true }).fill("secret-only-A");
  await page.getByLabel("Workspace v2", { exact: true }).selectOption(B, { force: true });
  await expect(page).toHaveURL(`/workspaces/${B}/consumers`); await page.getByRole("link", { name: "checkout-B", exact: true }).click();
  await page.getByRole("tab", { name: "Plugins", exact: true }).click(); await create(page);
  await expect(page.getByLabel("Consumidor", { exact: true })).toHaveValue("checkout-B"); await expect(page.getByLabel("password", { exact: true })).toHaveValue("");
  expect(fake.writes).toHaveLength(0); await expect(page.locator("body")).not.toContainText("secret-only-A");
  await page.getByRole("button", { name: "Salvar no rascunho" }).click(); await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(fake.writes).toHaveLength(1);
  expect(fake.writes[0]).toMatchObject({ method: "POST", path: `/api/v2/workspaces/${B}/plugins`, body: { scope: { consumerId: D }, config: { minute: 10 } } });
  expect(JSON.stringify(fake.writes[0])).not.toContain("secret-only-A");
});
test("loading and a late response for A never populate B", async ({ page }) => {
  const fake = await setup(page, { hold: true }); await open(page);
  await expect(page.getByText("Carregando plugins…", { exact: true })).toBeVisible(); await expect(page.getByText("Nenhum plugin neste consumidor.", { exact: true })).toHaveCount(0);
  await page.getByLabel("Workspace v2", { exact: true }).selectOption(B, { force: true });
  await page.getByRole("link", { name: "checkout-B", exact: true }).click(); await page.getByRole("tab", { name: "Plugins", exact: true }).click(); fake.release();
  await expect(page.getByText("Nenhum plugin neste consumidor.", { exact: true })).toBeVisible(); await expect(page.getByRole("button", { name: "Editar rate-limiting" })).toHaveCount(0);
});
for (const width of [390, 768, 1440]) test(`deep link, refresh, axe and horizontal bounds at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 }); await setup(page); await open(page); await audit(page);
  await page.reload(); await page.getByRole("tab", { name: "Plugins", exact: true }).click();
  await page.getByRole("button", { name: "Editar rate-limiting" }).click(); await expect(page.getByLabel("minute", { exact: true })).toBeVisible(); await audit(page);
  await page.getByRole("button", { name: "Fechar", exact: true }).click();
  await page.getByRole("button", { name: "Associar plugin" }).click(); await expect(page.getByRole("button", { name: "rate-limiting", exact: true })).toBeVisible(); await audit(page);
  await page.getByRole("button", { name: "rate-limiting", exact: true }).click(); await expect(page.getByLabel("Consumidor", { exact: true })).toBeVisible(); await audit(page);
});
for (const status of [403, 404, 401]) test(`workspace context ${status} prevents loading consumer plugins`, async ({ page }) => {
  const fake = await setup(page, { contextStatus: status }); await page.goto(url());
  if (status === 401) await expect(page).toHaveURL(/\/login/);
  else await expect(page.getByRole("alert")).toContainText(status === 403 ? "Você não tem permissão para acessar este contexto." : "Não encontrado ou indisponível para sua conta.");
  expect(fake.sent.some(r => r.path.endsWith("/plugins") || r.path.includes(`/consumers/${C}`))).toBe(false);
});
test("a consumer from A cannot be opened under workspace B", async ({ page }) => {
  const fake = await setup(page); await page.goto(url(B, C));
  await expect(page.getByText("Item não encontrado. Ele pode ter sido excluído.", { exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Plugins", exact: true })).toHaveCount(0);
  expect(fake.sent.some(r => r.path.endsWith("/plugins"))).toBe(false);
});
test("a deleted consumer deep link shows 404 before loading plugins", async ({ page }) => {
  const fake = await setup(page, { consumerStatus: 404 }); await page.goto(url());
  await expect(page.getByText("Item não encontrado. Ele pode ter sido excluído.", { exact: true })).toBeVisible();
  expect(fake.sent.some(r => r.path.endsWith("/plugins"))).toBe(false);
});
test("a late save does not close another association dialog", async ({ page }) => {
  await setup(page); await open(page);
  let release!: () => void, heldWrites = 0; const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/v2/workspaces/${A}/plugins/${P}`, async route => {
    if (route.request().method() !== "PUT") return route.fallback();
    heldWrites++; await held; return route.fulfill({ json: plugin });
  });
  await page.getByRole("button", { name: "Editar rate-limiting" }).click();
  const sent = page.waitForRequest(r => r.method() === "PUT" && r.url().endsWith(`/plugins/${P}`));
  await page.getByRole("button", { name: "Salvar no rascunho" }).click(); await sent;
  await page.getByRole("button", { name: "Fechar", exact: true }).click();
  await page.getByRole("button", { name: "Associar plugin" }).click();
  await expect(page.getByRole("dialog", { name: "Escolha um plugin" })).toBeVisible();
  const response = page.waitForResponse(r => r.request().method() === "PUT" && r.url().endsWith(`/plugins/${P}`)); release(); await response;
  await expect(page.getByRole("dialog", { name: "Escolha um plugin" })).toBeVisible();
  expect(heldWrites).toBe(1);
});
