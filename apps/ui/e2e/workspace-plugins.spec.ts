import type { Page } from "@playwright/test";
import type { Me, Plugin } from "../src/api/client";
import { expect, mockSession, test } from "./fixtures";

const A = "6d3e8b20-4c5e-4d6f-9a70-00000000000a";
const B = "6d3e8b20-4c5e-4d6f-9a70-00000000000b";
const S = "6d3e8b20-4c5e-4d6f-9a70-0000000000c1";
const P = "6d3e8b20-4c5e-4d6f-9a70-0000000000d1";
const timestamps = { createdAt: "2026-10-31T12:00:00Z", updatedAt: "2026-10-31T12:00:00Z" };
const user: Me = { id: S, name: "Ana", email: "ana@gromesh.dev", role: "viewer", active: true, ...timestamps };
const plugin: Plugin = { id: P, name: "rate-limiting", enabled: true, scope: { serviceId: S }, config: { minute: 10, policy: "local", redis: { password: "REDACTED" } } as unknown as Plugin["config"], tags: [], ...timestamps };
const pageOf = (items: unknown[], nextCursor: string | null = null) => ({ items, nextCursor });
// Same catalog schema wire format as production; no mocked application modules.
const schema = { fields: [
  { service: { type: "foreign" } }, { route: { type: "foreign" } }, { consumer: { type: "foreign" } },
  { config: { type: "record", fields: [
    { minute: { type: "integer", required: true, gt: 0 } },
    { policy: { type: "string", default: "local", one_of: ["local", "redis"] } },
    { redis: { type: "record", fields: [{ password: { type: "string", encrypted: true } }] } },
  ] } },
] };

async function setup(page: Page, options: { archived?: boolean; auto?: boolean; empty?: boolean; hold?: boolean; paginated?: boolean; mandatory?: boolean } = {}) {
  const writes: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
  let items = options.empty ? [] : [{ ...plugin, name: options.mandatory ? "prometheus" : plugin.name }];
  let rejection: { status: number; code?: string; errors?: { path: string; message: string }[] } | null = null;
  let release!: () => void;
  const held = new Promise<void>(r => { release = r; });
  await page.route(/^https?:\/\/[^/]+\/api\/v[12]\//, async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === "/api/v1/auth/csrf") return route.fulfill({ json: { csrfToken: "csrf" } });
    if (request.method() !== "GET") {
      const body = request.postData() ? request.postDataJSON() as Record<string, unknown> : null;
      writes.push({ method: request.method(), path, body });
      if (!new RegExp(`^/api/v2/workspaces/${A}/plugins(?:/${P})?$`).test(path)) return route.fulfill({ status: 500, json: { title: "Unexpected mutation" } });
      if (rejection) return route.fulfill({ status: rejection.status, json: { title: "Rejected", ...rejection } });
      if (request.method() === "DELETE") { items = []; return route.fulfill({ status: 204 }); }
      // Responses contain only the redacted secret, like the real API.
      items = [{ ...plugin, ...body, config: { ...(body?.config as object), redis: { password: "REDACTED" } } as unknown as Plugin["config"] }];
      return route.fulfill({ status: request.method() === "POST" ? 201 : 200, json: items[0] });
    }
    const environment = (id: string) => ({ id, name: id === A ? "Cobrança" : "Recargas", publishMode: options.auto && id === A ? "auto" : "manual", currentVersion: null, hasUnpublishedChanges: false, ...timestamps });
    if (path === "/api/v1/environments") return route.fulfill({ json: pageOf([environment(A), environment(B)]) });
    if (path === "/api/v1/plugin-schemas") return route.fulfill({ json: { kongVersion: "3.9.4", items: [{ name: "rate-limiting", category: "traffic-control", supportedInDbless: true, source: "bundled" }] } });
    if (path === "/api/v1/plugin-schemas/rate-limiting") return route.fulfill({ json: schema });
    for (const id of [A, B]) {
      if (path === `/api/v1/environments/${id}`) return route.fulfill({ json: environment(id) });
      if (path === `/api/v2/workspaces/${id}`) {
        if (options.hold && id === A) await held;
        return route.fulfill({ json: { id, key: id, name: environment(id).name, slug: id === A ? "billing" : "recargas", status: options.archived && id === A ? "archived" : "active", activeRelease: null } });
      }
      if (path === `/api/v2/workspaces/${id}/plugins`) return route.fulfill({ json: pageOf(id === A ? items : []) });
      if (path === `/api/v2/workspaces/${id}/services`) return route.fulfill({ json: pageOf(id === B ? [] : options.paginated && !url.searchParams.has("cursor") ? [] : [{ id: S, name: "cobranca", workspaceId: id }], id === A && options.paginated && !url.searchParams.has("cursor") ? "next" : null) });
    }
    if (/\/(routes|consumers|clusters)$/.test(path)) return route.fulfill({ json: pageOf([]) });
    return route.fulfill({ status: 404, json: { title: "Unexpected API request", status: 404 } });
  });
  await mockSession(page, user);
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(user.email);
  await page.getByLabel("Senha").fill("test-password");
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.goto(`/e/${A}/plugins`);
  await expect(page.getByRole("heading", { name: "Plugins", exact: true })).toBeVisible();
  return { writes, release, reject: (value: typeof rejection) => { rejection = value; } };
}

for (const options of [{ archived: true }, { auto: true }]) {
  test(`read-only workspace plugins: ${JSON.stringify(options)}`, async ({ page }) => {
    const fake = await setup(page, options);
    await expect(page.getByRole("note")).toContainText("Somente leitura");
    await expect(page.getByRole("table", { name: "Plugins" })).toContainText("rate-limiting");
    await expect(page.getByRole("button", { name: /Novo plugin|Editar rate|Mais ações para|Publicar|Deployment/ })).toHaveCount(0);
    expect(fake.writes).toEqual([]);
  });
}

test("unknown access blocks writing until the workspace answers", async ({ page }) => {
  const fake = await setup(page, { hold: true });
  try { await expect(page.getByRole("button", { name: "Novo plugin" })).toHaveCount(0); }
  finally { fake.release(); }
  await expect(page.getByRole("button", { name: "Novo plugin" })).toBeVisible();
});

test("creates scoped plugins, edits a write-only secret, reopens empty and deletes using v2 only", async ({ page }) => {
  const fake = await setup(page, { empty: true, paginated: true });
  // The session is a legacy viewer: server permission grants, not the legacy role, decide whether saving succeeds.
  await page.getByRole("button", { name: "Novo plugin" }).click();
  await page.getByRole("dialog", { name: "Escolha um plugin" }).getByRole("button", { name: "rate-limiting", exact: true }).click();
  await page.getByLabel("Service", { exact: true }).selectOption(S);
  await page.getByLabel("minute", { exact: false }).fill("10");
  await page.getByLabel("password", { exact: true }).fill("typed-secret");
  await page.getByRole("button", { name: "Salvar no rascunho" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("table", { name: "Plugins" })).toContainText("rate-limiting");
  await page.getByRole("button", { name: "Editar rate-limiting" }).click();
  await expect(page.getByLabel("password", { exact: true })).toHaveValue("");
  await page.getByLabel("Ativo", { exact: true }).uncheck();
  await page.getByRole("button", { name: "Salvar no rascunho" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Editar rate-limiting" }).click();
  await expect(page.getByLabel("password", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "Fechar", exact: true }).click();
  await page.getByRole("button", { name: /^Mais ações para rate-limiting/ }).click();
  await page.getByRole("menuitem", { name: "Excluir", exact: true }).click();
  await page.getByRole("button", { name: "Excluir", exact: true }).click();
  await expect(page.getByText("Nenhum plugin neste Workspace.")).toBeVisible();
  expect(fake.writes.map(w => [w.method, w.path])).toEqual([["POST", `/api/v2/workspaces/${A}/plugins`], ["PUT", `/api/v2/workspaces/${A}/plugins/${P}`], ["DELETE", `/api/v2/workspaces/${A}/plugins/${P}`]]);
  expect(fake.writes[0]!.body).toMatchObject({ scope: { serviceId: S }, config: { redis: { password: "typed-secret" } } });
  expect(fake.writes[1]!.body).toMatchObject({ enabled: false, config: { redis: { password: "REDACTED" } } });
  await expect(page.getByRole("button", { name: /Publicar|Deployment/ })).toHaveCount(0);
});

for (const status of [403, 409, 422]) {
  test(`server ${status} remains visible and does not close or report success`, async ({ page }) => {
    const fake = await setup(page);
    fake.reject({ status, ...(status === 409 ? { code: "auto-publish" } : {}), errors: [{ path: "config.minute", message: "must be a number" }] });
    await page.getByRole("button", { name: "Editar rate-limiting" }).click();
    await page.getByRole("button", { name: "Salvar no rascunho" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    if (status === 422) {
      await expect(page.getByLabel("minute", { exact: false })).toHaveAttribute("aria-invalid", "true");
      await expect(page.getByRole("dialog").getByRole("alert").first()).toContainText("valor inválido");
    } else await expect(page.getByRole("dialog").getByRole("alert").first()).toContainText(status === 403 ? "permissão" : "publicação manual");
    expect(fake.writes).toHaveLength(1);
  });
}

test("requires an explicit workspace scope and isolates an open form when switching workspace", async ({ page }) => {
  const fake = await setup(page, { empty: true });
  await page.getByRole("button", { name: "Novo plugin" }).click();
  await page.getByRole("dialog", { name: "Escolha um plugin" }).getByRole("button", { name: "rate-limiting", exact: true }).click();
  await page.getByLabel("minute", { exact: false }).fill("10");
  await page.getByRole("button", { name: "Salvar no rascunho" }).click();
  await expect(page.getByRole("alert")).toContainText("Escolha ao menos um escopo");
  expect(fake.writes).toEqual([]);
  await page.getByLabel("password", { exact: true }).fill("secret-of-A");
  await page.getByLabel("Workspace", { exact: true }).selectOption(B, { force: true });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("Nenhum plugin neste Workspace.")).toBeVisible();
  await page.getByRole("button", { name: "Novo plugin" }).click();
  await page.getByRole("dialog", { name: "Escolha um plugin" }).getByRole("button", { name: "rate-limiting", exact: true }).click();
  await expect(page.getByLabel("password", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Service", { exact: true }).getByRole("option", { name: "cobranca" })).toHaveCount(0);
  expect(fake.writes).toEqual([]);
});


test("shows the server's reservation when deletion of a mandatory legacy plugin is refused", async ({ page }) => {
  const fake = await setup(page, { mandatory: true });
  fake.reject({ status: 422, errors: [{ path: "name", message: "reserved mandatory platform plugin" }] });
  await page.getByRole("button", { name: /^Mais ações para prometheus/ }).click();
  await page.getByRole("menuitem", { name: "Excluir", exact: true }).click();
  await page.getByRole("button", { name: "Excluir", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toBeVisible();
  await expect(page.getByRole("table", { name: "Plugins" })).toContainText("prometheus");
  expect(fake.writes.map(w => w.method)).toEqual(["DELETE"]);
});


test("a legacy viewer gets the server's 403 for each v2 plugin mutation without changing the list", async ({ page }) => {
  const fake = await setup(page);
  fake.reject({ status: 403 });
  const table = page.getByRole("table", { name: "Plugins", exact: true });
  await expect(table).toContainText("Service cobranca");
  const before = await table.getByRole("row").allTextContents();
  await page.getByRole("button", { name: "Novo plugin", exact: true }).click();
  await page.getByRole("dialog", { name: "Escolha um plugin" }).getByRole("button", { name: "rate-limiting", exact: true }).click();
  await page.getByLabel("Service", { exact: true }).selectOption(S);
  await page.getByLabel("minute", { exact: false }).fill("20");
  await page.getByRole("button", { name: "Salvar no rascunho" }).click();
  const create = page.getByRole("dialog", { name: "Novo plugin", exact: true });
  await expect(create.getByRole("alert")).toContainText("permissão");
  await create.getByRole("button", { name: "Fechar", exact: true }).click();
  await page.getByRole("button", { name: "Editar rate-limiting" }).click();
  await page.getByLabel("Ativo", { exact: true }).uncheck();
  await page.getByRole("button", { name: "Salvar no rascunho" }).click();
  const edit = page.getByRole("dialog", { name: "Editar plugin rate-limiting" });
  await expect(edit.getByRole("alert")).toContainText("permissão");
  await edit.getByRole("button", { name: "Fechar", exact: true }).click();
  await page.getByRole("button", { name: /^Mais ações para rate-limiting/ }).click();
  await page.getByRole("menuitem", { name: "Excluir", exact: true }).click();
  const remove = page.getByRole("dialog", { name: "Excluir plugin", exact: true });
  await remove.getByRole("button", { name: "Excluir", exact: true }).click();
  await expect(remove.getByRole("alert")).toContainText("permissão");
  await expect(table.getByRole("row")).toHaveText(before);
  await expect(page.getByRole("button", { name: "Sair", exact: true })).toBeVisible();
  expect(fake.writes.map(w => [w.method, w.path])).toEqual([
    ["POST", `/api/v2/workspaces/${A}/plugins`],
    ["PUT", `/api/v2/workspaces/${A}/plugins/${P}`],
    ["DELETE", `/api/v2/workspaces/${A}/plugins/${P}`],
  ]);
});
