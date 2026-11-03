import AxeBuilder from "@axe-core/playwright";
import { X509Certificate, createPrivateKey } from "node:crypto";
import type { Page } from "@playwright/test";
import { TEST_CERTIFICATE, TEST_PRIVATE_KEY } from "../src/test/pem";
import { expect, mockSession, test } from "./fixtures";

const A = "6d3e8b20-4c5e-4d6f-9a70-00000000000a";
const B = "6d3e8b20-4c5e-4d6f-9a70-00000000000b";
const C = "6d3e8b20-4c5e-4d6f-9a70-0000000000c1";
const stamp = "2026-11-03T12:00:00Z";
const user = { id: C, name: "Ana", email: "ana@example.test", role: "viewer" as const, active: true, createdAt: stamp, updatedAt: stamp };
const workspace = (id: string, archived = false) => ({ id, key: id, name: `Workspace ${id === A ? "A" : "B"}`, slug: id === A ? "alpha" : "beta", status: archived ? "archived" : "active", activeRelease: null });
const certificate = { id: C, cert: TEST_CERTIFICATE, key: "REDACTED", snis: ["api.example.test", "*.example.test"], subject: "CN=api.example.test", issuer: "CN=Test CA", notBefore: "2026-01-01T00:00:00Z", notAfter: "2099-01-01T00:00:00Z", fingerprintSha256: "AA:".repeat(31) + "AA", tags: ["tls"], createdAt: stamp, updatedAt: stamp };
const url = (id = A) => `/workspaces/${id}/certificates`;
const pageOf = (items: unknown[], nextCursor: string | null = null) => ({ items, nextCursor });
interface State { contextStatus?: number; listStatus?: number; archived?: boolean; empty?: boolean; items?: (typeof certificate)[]; writeStatus?: number; code?: string; varRef?: boolean; paginated?: boolean; holdList?: boolean }

async function setup(page: Page, state: State = {}) {
  const reads: string[] = [];
  const writes: { method: string; path: string; body: unknown }[] = [];
  let items = state.items ?? (state.empty ? [] : [certificate]);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(/^https?:\/\/[^/]+\/api\/v[12]\//, async route => {
    const request = route.request();
    const requestUrl = new URL(request.url());
    const path = requestUrl.pathname;
    const json = (data: unknown, status = 200) => route.fulfill({ status, json: data });
    if (path === "/api/v1/auth/csrf") return json({ csrfToken: "csrf" });
    if (request.method() !== "GET") {
      const body: unknown = request.postData() ? request.postDataJSON() : null;
      writes.push({ method: request.method(), path, body });
      if (!path.startsWith(`/api/v2/workspaces/${A}/certificates`)) return json({ title: "Unexpected mutation", status: 500 }, 500);
      if (state.writeStatus) return json({ title: "Rejected", status: state.writeStatus, code: state.code, detail: TEST_PRIVATE_KEY, errors: state.writeStatus === 422 ? [{ path: state.varRef ? "cert" : "key", message: state.varRef ? "variable CERT is not declared in this workspace" : "does not match the leaf certificate" }] : [] }, state.writeStatus);
      if (request.method() === "DELETE") { items = items.filter(item => item.id !== path.split("/").at(-1)); return route.fulfill({ status: 204 }); }
      const fields = body as Record<string, unknown>;
      // Enforce the closed write body, PEM/key matching and POST/PUT placeholder distinction.
      const allowed = ["cert", "key", "snis", "tags"];
      const errors: { path: string; message: string }[] = [];
      if (Object.keys(fields).some(key => !allowed.includes(key))) errors.push({ path: "(body)", message: "must NOT have additional properties" });
      if (!Array.isArray(fields.snis)) errors.push({ path: "snis", message: "must be array" });
      try {
        const leaf = new X509Certificate(String(fields.cert));
        const key = fields.key === "REDACTED" && request.method() === "PUT" ? TEST_PRIVATE_KEY : String(fields.key);
        if (!leaf.checkPrivateKey(createPrivateKey(key))) errors.push({ path: "key", message: "does not match the leaf certificate" });
      } catch { errors.push({ path: "key", message: "invalid PEM" }); }
      if (errors.length) return json({ title: "Invalid certificate", status: 422, errors }, 422);
      const saved = { ...certificate, ...fields, key: "REDACTED" };
      items = [saved];
      return json(saved, request.method() === "POST" ? 201 : 200);
    }
    reads.push(`${path}${requestUrl.search}`);
    if (path === "/api/v2/workspaces") return json(pageOf([workspace(A), workspace(B)]));
    if (path === "/api/v2/workspace-creation-policy") return json({ title: "Forbidden", status: 403 }, 403);
    for (const id of [A, B]) {
      if (path === `/api/v2/workspaces/${id}`) return json(state.contextStatus ? { title: "Unavailable", status: state.contextStatus } : workspace(id, state.archived), state.contextStatus);
      if (path === `/api/v2/workspaces/${id}/certificates`) {
        if (id === A && state.holdList) await held;
        if (state.listStatus) return json({ title: "Unavailable", status: state.listStatus }, state.listStatus);
        if (id === B) return json(pageOf([]));
        if (state.varRef) return json(pageOf([{ ...certificate, cert: { $var: "CERT" }, key: { $var: "KEY" }, subject: null, issuer: null, notBefore: null, notAfter: null, fingerprintSha256: null }]));
        if (state.paginated && requestUrl.searchParams.has("cursor")) return json(pageOf([{ ...certificate, id: B, subject: "CN=page-two.example.test", snis: ["page-two.example.test"] }]));
        return json(pageOf(items, state.paginated ? "next-page" : null));
      }
      if (path === `/api/v2/workspaces/${id}/services`) return json(pageOf([]));
    }
    return json({ title: "Unexpected API request", status: 500 }, 500);
  });
  await mockSession(page, user);
  await page.context().addCookies([{ name: "gromesh_session", value: "certificates-test", url: test.info().project.use.baseURL! }]);
  return { reads, writes, release };
}

async function audit(page: Page) {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(result.violations.filter(v => v.impact === "serious" || v.impact === "critical").map(v => v.id)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

for (const width of [390, 768, 1440]) {
  test(`certificate CRUD, metadata, deep link and refresh at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fake = await setup(page, { empty: true });
    const target = `${url()}?source=direct#certs`;
    await page.goto(target);
    await expect(page.getByText("Nenhum certificado neste Workspace.", { exact: true })).toBeVisible();
    await page.reload(); await expect(page).toHaveURL(target);
    await expect(page.getByRole("button", { name: "Novo certificado" })).toBeVisible();
    await audit(page);
    await page.getByRole("button", { name: "Novo certificado" }).click();
    let dialog = page.getByRole("dialog", { name: "Novo certificado" });
    await dialog.getByLabel("Certificado (PEM)").fill(TEST_CERTIFICATE);
    await dialog.getByLabel("Chave privada (PEM)").fill(TEST_PRIVATE_KEY);
    await dialog.getByLabel("SNIs").fill("API.example.test, *.example.test");
    await audit(page);
    await dialog.getByRole("button", { name: "Salvar no rascunho" }).click();
    await expect(dialog).toHaveCount(0);
    const table = page.getByRole("table", { name: "Certificados" });
    await expect(table).toContainText("CN=api.example.test");
    expect(fake.writes[0]).toMatchObject({ method: "POST", path: `/api/v2/workspaces/${A}/certificates`, body: { cert: TEST_CERTIFICATE, key: TEST_PRIVATE_KEY, snis: ["api.example.test", "*.example.test"], tags: [] } });
    await expect(page.locator("body")).not.toContainText("MIGHAgEA");
    await table.getByRole("button", { name: "Ver metadados" }).click();
    dialog = page.getByRole("dialog", { name: "Metadados do certificado" });
    await expect(dialog).toContainText(certificate.fingerprintSha256);
    await expect(dialog).toContainText("CN=Test CA");
    await audit(page); await dialog.getByRole("button", { name: "Fechar", exact: true }).click();
    await table.getByRole("button", { name: "Editar", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Editar certificado" });
    await expect(dialog.getByLabel("Chave privada (PEM)")).toHaveValue("");
    await dialog.getByLabel("SNIs").fill("updated.example.test");
    await dialog.getByRole("button", { name: "Salvar no rascunho" }).click();
    await expect(dialog).toHaveCount(0); await expect(table).toContainText("updated.example.test");
    expect(fake.writes[1]).toMatchObject({ method: "PUT", body: { cert: TEST_CERTIFICATE, key: "REDACTED", snis: ["updated.example.test"] } });
    await table.getByRole("button", { name: /Mais ações para/ }).click(); await page.getByRole("menuitem", { name: "Excluir" }).click();
    dialog = page.getByRole("dialog", { name: "Excluir certificado" });
    await audit(page); await dialog.getByRole("button", { name: "Cancelar" }).click(); expect(fake.writes).toHaveLength(2);
    await table.getByRole("button", { name: /Mais ações para/ }).click(); await page.getByRole("menuitem", { name: "Excluir" }).click();
    await dialog.getByRole("button", { name: "Excluir", exact: true }).click();
    await expect(dialog).toHaveCount(0); await expect(page.getByText("Nenhum certificado neste Workspace.", { exact: true })).toBeVisible();
    expect(fake.writes.map(write => write.method)).toEqual(["POST", "PUT", "DELETE"]);
    expect(fake.reads.some(path => path.startsWith("/api/v1/environments"))).toBe(false);
  });
}

for (const status of [204, 409, 403]) {
  test(`late DELETE ${status} for X preserves Y's confirmation and reflects X's result in the list`, async ({ page }) => {
    const other = { ...certificate, id: B, subject: "CN=other.example.test", snis: ["other.example.test"] };
    const fake = await setup(page, { items: [certificate, other], writeStatus: status === 204 ? undefined : status });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let requested!: () => void;
    const started = new Promise<void>(resolve => { requested = resolve; });
    const deletePath = `/api/v2/workspaces/${A}/certificates/${C}`;
    await page.route(`**${deletePath}`, async route => { requested(); await held; await route.fallback(); });
    await page.goto(url());
    const table = page.getByRole("table", { name: "Certificados" });
    const openDelete = async (subject: string) => {
      await table.getByRole("button", { name: `Mais ações para ${subject}`, exact: true }).click();
      await page.getByRole("menuitem", { name: "Excluir", exact: true }).click();
    };
    await openDelete(certificate.subject);
    const dialog = page.getByRole("dialog", { name: "Excluir certificado" });
    await expect(dialog.getByRole("button", { name: "Excluir", exact: true })).toBeEnabled();
    await dialog.getByRole("button", { name: "Excluir", exact: true }).click(); await started;
    await dialog.getByRole("button", { name: "Cancelar" }).click(); await openDelete(other.subject);
    await expect(dialog).toContainText("other.example.test");
    const response = page.waitForResponse(response => new URL(response.url()).pathname === deletePath && response.request().method() === "DELETE");
    release();
    const result = await response;
    expect(result.status()).toBe(status); await result.finished();
    if (status === 204) await expect(table).not.toContainText(certificate.subject);
    else await expect(table).toContainText(certificate.subject);
    await expect(table).toContainText(other.subject);
    await expect(dialog).toBeVisible(); await expect(dialog).toContainText("other.example.test");
    await expect(dialog.getByRole("button", { name: "Excluir", exact: true })).toBeEnabled();
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    expect(fake.writes.map(write => [write.method, write.path])).toEqual([["DELETE", deletePath]]);
  });
}

for (const status of [403, 404, 401]) {
  test(`context ${status} blocks certificate reads and follows the session flow`, async ({ page }) => {
    const fake = await setup(page, { contextStatus: status });
    await page.goto(url());
    if (status === 401) { await expect(page).toHaveURL("/login"); await expect(page.getByRole("heading", { name: "Entrar" })).toBeVisible(); }
    else await expect(page.getByRole("alert")).toContainText(status === 403 ? "permissão" : "Não encontrado");
    expect(fake.reads.some(path => path.endsWith("/certificates"))).toBe(false); expect(fake.writes).toEqual([]); await audit(page);
  });
  test(`list ${status} is not an empty certificate list`, async ({ page }) => {
    await setup(page, { listStatus: status }); await page.goto(url());
    if (status === 401) await expect(page).toHaveURL("/login");
    else await expect(page.getByRole("alert")).toContainText(status === 403 ? "permissão" : "não encontrado");
    await expect(page.getByText("Nenhum certificado neste Workspace.", { exact: true })).toHaveCount(0); await audit(page);
  });
}

test("loading, pagination and transient failure retain distinct states", async ({ page }) => {
  const state: State = { holdList: true, paginated: true };
  const fake = await setup(page, state); await page.goto(url());
  await expect(page.getByRole("status").filter({ hasText: "Carregando certificados" })).toBeVisible();
  await expect(page.getByText("Nenhum certificado neste Workspace.", { exact: true })).toHaveCount(0);
  fake.release();
  await expect(page.getByRole("table", { name: "Certificados" })).toContainText("CN=api.example.test");
  await page.getByRole("button", { name: "Carregar mais" }).click();
  await expect(page.getByRole("table", { name: "Certificados" })).toContainText("page-two.example.test");
  expect(fake.reads).toContain(`/api/v2/workspaces/${A}/certificates?cursor=next-page`);
  state.listStatus = 502; await page.reload(); await expect(page.getByRole("alert")).toContainText("Não foi possível");
  state.listStatus = undefined; await page.getByRole("button", { name: "Tentar novamente" }).click();
  await expect(page.getByRole("table", { name: "Certificados" })).toBeVisible();
});

test("archived Workspace and unavailable VarRef metadata remain readable", async ({ page }) => {
  const fake = await setup(page, { archived: true, varRef: true }); await page.goto(url());
  await expect(page.getByRole("table", { name: "Certificados" })).toContainText("Validade indisponível");
  await expect(page.getByRole("button", { name: /Novo certificado|^Editar$|Mais ações/ })).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText("Expirado");
  await page.getByRole("button", { name: "Ver metadados" }).click();
  await expect(page.getByRole("dialog")).toContainText("Indisponível"); await audit(page); expect(fake.writes).toEqual([]);
});

for (const failure of [
  { writeStatus: 403, text: "permissão" }, { writeStatus: 404, text: "não encontrado" },
  { writeStatus: 409, text: "instância" }, { writeStatus: 409, code: "auto-publish", text: "publicação manual" },
  { writeStatus: 422, text: "não corresponde" }, { writeStatus: 422, varRef: true, text: "variáveis ainda não são suportadas" },
]) {
  test(`failed certificate write stays visible: ${failure.writeStatus} ${"code" in failure ? failure.code : failure.text}`, async ({ page }) => {
    const fake = await setup(page, failure); await page.goto(url());
    await page.getByRole("button", { name: "Editar", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Editar certificado" });
    await dialog.getByLabel("Chave privada (PEM)").fill(TEST_PRIVATE_KEY);
    await dialog.getByRole("button", { name: "Salvar no rascunho" }).click();
    await expect(dialog.getByRole("alert")).toContainText(failure.text);
    await expect(dialog.getByLabel("Chave privada (PEM)")).toHaveValue("");
    await expect(dialog).not.toContainText("MIGHAgEA"); expect(fake.writes).toHaveLength(1); await audit(page);
  });
}

test("closing and switching A→B discard the PEM form and late A data", async ({ page }) => {
  const fake = await setup(page); await page.goto(url());
  await page.getByRole("button", { name: "Novo certificado" }).click();
  let dialog = page.getByRole("dialog", { name: "Novo certificado" });
  await dialog.getByLabel("Chave privada (PEM)").fill(TEST_PRIVATE_KEY); await dialog.getByRole("button", { name: "Cancelar" }).click();
  await page.getByRole("button", { name: "Novo certificado" }).click();
  await expect(dialog.getByLabel("Chave privada (PEM)")).toHaveValue("");
  await dialog.getByLabel("Chave privada (PEM)").fill(TEST_PRIVATE_KEY);
  await page.getByLabel("Workspace v2", { exact: true }).selectOption(B, { force: true });
  await expect(page).toHaveURL(url(B)); await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText("CN=api.example.test");
  await page.getByRole("button", { name: "Novo certificado" }).click();
  dialog = page.getByRole("dialog", { name: "Novo certificado" }); await expect(dialog.getByLabel("Chave privada (PEM)")).toHaveValue("");
  await dialog.getByRole("button", { name: "Cancelar" }).click();
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  let requested!: () => void; const started = new Promise<void>(resolve => { requested = resolve; });
  let delivered!: () => void; const delivery = new Promise<void>(resolve => { delivered = resolve; });
  await page.route(`**/api/v2/workspaces/${A}/certificates`, async route => { requested(); await held; await route.fulfill({ json: pageOf([{ ...certificate, subject: "late-A.example.test" }]) }).catch(() => {}); delivered(); });
  await page.getByLabel("Workspace v2", { exact: true }).selectOption(A); await started;
  await page.getByLabel("Workspace v2", { exact: true }).selectOption(B);
  await expect(page.getByText("Nenhum certificado neste Workspace.", { exact: true })).toBeVisible(); release();
  await delivery;
  await expect(page.locator("main")).not.toContainText("late-A.example.test"); expect(fake.writes).toEqual([]);
});
