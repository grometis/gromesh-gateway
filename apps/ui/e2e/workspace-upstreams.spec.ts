import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import type { Me } from "../src/api/client";
import type { Upstream, Target } from "../src/pages/workspace-upstreams";
import { expect, mockSession, test } from "./fixtures";

const A = "7c1d2e3f-4a5b-4c6d-8e7f-00000000000a";
const B = "7c1d2e3f-4a5b-4c6d-8e7f-00000000000b";
const U = "7c1d2e3f-4a5b-4c6d-8e7f-000000000001";
const T = "7c1d2e3f-4a5b-4c6d-8e7f-000000000002";
const S = "7c1d2e3f-4a5b-4c6d-8e7f-000000000003";
const timestamps = { createdAt: "2026-11-03T12:00:00Z", updatedAt: "2026-11-03T12:00:00Z" };
const user: Me = { id: S, name: "Ana", email: "ana@example.test", role: "viewer", active: true, ...timestamps };
const upstream: Upstream = { id: U, name: "orders-pool", algorithm: "round-robin", hashOn: "none", hashFallback: "none", hashOnCookiePath: "/", healthchecks: { active: null, passive: null }, tags: [], ...timestamps };
const target: Target = { id: T, upstreamId: U, target: "backend.internal:8080", weight: 100, tags: ["preservar"], ...timestamps };
const url = (id = A) => `/workspaces/${id}/upstreams`;
const workspace = (id: string, archived = false) => ({ id, key: id, name: `Workspace ${id === A ? "A" : "B"}`, slug: id === A ? "alpha" : "beta", status: archived ? "archived" : "active", activeRelease: null });
const pageOf = (items: unknown[], nextCursor: string | null = null) => ({ items, nextCursor });
const problem = (status: number, code?: string) => ({ status, json: { type: "about:blank", title: "Rejected", status, code } });
const record = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
function closedBody(body: unknown, kind: "upstream" | "target") {
  const fields = record(body);
  const allowed = kind === "upstream" ? ["name", "algorithm", "hashOn", "hashFallback", "hashOnHeader", "hashFallbackHeader", "hashOnCookie", "hashOnCookiePath", "healthchecks", "tags"] : ["target", "weight", "tags"];
  const errors: { path: string; message: string }[] = [];
  if (!Object.keys(fields).length || Object.keys(fields).some((k) => !allowed.includes(k))) errors.push({ path: "(body)", message: "must NOT have additional properties" });
  if (kind === "target" && (typeof fields.weight !== "number" || !Number.isInteger(fields.weight) || fields.weight < 0 || fields.weight > 65535)) errors.push({ path: "weight", message: "must be integer from 0 to 65535" });
  const health = record(fields.healthchecks);
  for (const key of Object.keys(health)) if (!["active", "passive"].includes(key)) errors.push({ path: "healthchecks", message: "must NOT have additional properties" });
  for (const [key, value] of Object.entries(health)) {
    const keys = key === "active" ? ["type", "httpPath", "intervalSeconds", "healthyThreshold", "unhealthyThreshold", "timeoutSeconds"] : ["unhealthyHttpFailures", "unhealthyTimeouts"];
    if (Object.keys(record(value)).some((k) => !keys.includes(k))) errors.push({ path: `healthchecks.${key}`, message: "must NOT have additional properties" });
  }
  return errors;
}

async function setup(page: Page, options: { empty?: boolean; archived?: boolean; contextStatus?: number; listStatus?: number; servicesStatus?: number; partial?: boolean; paginate?: boolean } = {}) {
  const reads: string[] = [];
  const writes: { method: string; path: string; body: unknown }[] = [];
  let items = options.empty ? [] : [upstream];
  let targets: Target[] = [target];
  const state = { writeStatus: 0, code: "", varRef: false };
  await page.route(/^https?:\/\/[^/]+\/api\/v[12]\//, async (route) => {
    const request = route.request();
    const u = new URL(request.url());
    const path = u.pathname;
    if (path === "/api/v1/auth/csrf") return route.fulfill({ json: { csrfToken: "csrf" } });
    if (request.method() !== "GET") {
      const body: unknown = request.postData() ? request.postDataJSON() : null;
      writes.push({ method: request.method(), path, body });
      if (!path.startsWith(`/api/v2/workspaces/${A}/upstreams`)) return route.fulfill(problem(500));
      if (state.writeStatus) return route.fulfill(problem(state.writeStatus, state.code));
      const isTarget = path.includes("/targets");
      if (state.varRef && isTarget) return route.fulfill({ status: 422, json: { type: "about:blank", title: "Invalid", status: 422, errors: [{ path: "target", message: "variable TARGET is not declared in this workspace" }] } });
      if (request.method() === "DELETE") {
        if (isTarget) targets = []; else items = [];
        return route.fulfill({ status: 204 });
      }
      const errors = closedBody(body, isTarget ? "target" : "upstream");
      if (errors.length) return route.fulfill({ status: 422, json: { type: "about:blank", title: "Invalid", status: 422, errors } });
      if (isTarget) {
        const saved = { ...target, ...(request.method() === "POST" ? { tags: [] } : {}), ...record(body) } as Target;
        targets = [saved];
        return route.fulfill({ status: request.method() === "POST" ? 201 : 200, json: saved });
      }
      const saved = { ...upstream, ...record(body) } as Upstream;
      items = [saved];
      return route.fulfill({ status: request.method() === "POST" ? 201 : 200, json: saved });
    }
    reads.push(path + u.search);
    if (path === "/api/v2/workspace-creation-policy") return route.fulfill(problem(403));
    if (path === "/api/v2/workspaces") return route.fulfill({ json: pageOf([workspace(A, options.archived), workspace(B)]) });
    for (const id of [A, B]) {
      const base = `/api/v2/workspaces/${id}`;
      if (path === base) return route.fulfill(options.contextStatus && id === A ? problem(options.contextStatus) : { json: workspace(id, id === A && options.archived) });
      if (path === `${base}/services`) return route.fulfill(options.servicesStatus ? problem(options.servicesStatus) : { json: pageOf(id === A ? [
        { id: S, workspaceId: A, upstreamId: U, name: "Serviço vinculado", protocol: "http", host: "generated.invalid", port: 80, enabled: true, ...timestamps },
        { id: T, workspaceId: A, upstreamId: null, name: "Somente DNS", protocol: "http", host: upstream.name, port: 80, enabled: true, ...timestamps },
      ] : [], options.partial ? "more-services" : null) });
      if (path === `${base}/upstreams`) {
        if (options.listStatus && id === A) return route.fulfill(problem(options.listStatus));
        return route.fulfill({ json: pageOf(id === B ? [] : u.searchParams.has("cursor") ? [{ ...upstream, id: S, name: "second-pool" }] : items, options.paginate && id === A && !u.searchParams.has("cursor") ? "more-upstreams" : null) });
      }
      if (path === `${base}/upstreams/${U}/targets`) return route.fulfill({ json: pageOf(u.searchParams.has("cursor") ? [{ ...target, id: S, target: "second.internal:80" }] : targets, options.paginate && !u.searchParams.has("cursor") ? "more-targets" : null) });
    }
    return route.fulfill(problem(404));
  });
  await mockSession(page, user);
  await page.context().addCookies([{ name: "gromesh_session", value: "upstreams-test", url: test.info().project.use.baseURL! }]);
  return { reads, writes, state };
}
async function audit(page: Page) {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(result.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const dialog = page.getByRole("dialog").last();
  if (await dialog.count()) expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
}

for (const width of [390, 768, 1440]) {
  test(`deep link + refresh, real associations, pagination and axe at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fake = await setup(page, { partial: true, paginate: true });
    await page.goto(`${url()}?keep=1#targets`);
    await expect(page.getByRole("table", { name: "Upstreams", exact: true })).toContainText("orders-pool");
    await expect(page.getByText(/Lista parcial de Serviços/)).toBeVisible();
    await expect(page.getByRole("link", { name: "Serviço vinculado", exact: true })).toHaveAttribute("href", `/workspaces/${A}/services/${S}`);
    await expect(page.getByRole("link", { name: "Somente DNS" })).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Menu principal" }).getByRole("link", { name: "Upstreams", exact: true })).toHaveAttribute("href", url());
    await page.reload();
    await expect(page).toHaveURL(`${url()}?keep=1#targets`);
    await page.getByRole("button", { name: "Carregar mais Upstreams" }).click();
    await expect(page.getByRole("table", { name: "Upstreams", exact: true })).toContainText("second-pool");
    await audit(page);
    await page.getByRole("button", { name: "Novo upstream", exact: true }).click();
    await audit(page);
    await page.getByRole("button", { name: "Cancelar", exact: true }).click();
    await page.getByRole("button", { name: "Targets de orders-pool", exact: true }).click();
    await page.getByRole("button", { name: "Carregar mais targets" }).click();
    await expect(page.getByRole("table", { name: "Targets", exact: true })).toContainText("second.internal:80");
    await audit(page);
    expect(fake.reads.filter((p) => p.startsWith(`/api/v2/workspaces/${A}/services`))).toHaveLength(2); // before and after refresh, never per row
    expect(fake.reads.some((p) => p.startsWith("/api/v1/environments"))).toBe(false);
  });

  test(`CRUD Upstream hash/healthchecks and targets at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fake = await setup(page, { empty: true });
    await page.goto(url());
    await expect(page.getByText("Nenhum upstream ainda.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Novo upstream", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "Novo upstream", exact: true });
    await dialog.getByLabel("Nome", { exact: true }).fill("orders-pool");
    await dialog.getByLabel("Algoritmo", { exact: true }).selectOption("consistent-hashing");
    await dialog.getByLabel("Hash por", { exact: true }).selectOption("header");
    await dialog.getByLabel("Header do hash", { exact: true }).fill("X-Client");
    await dialog.getByLabel("Alternativa", { exact: true }).selectOption("ip");
    await dialog.getByLabel("Verificação ativa", { exact: true }).check();
    await dialog.getByLabel("Verificação passiva (pelo tráfego)", { exact: true }).check();
    await dialog.getByRole("button", { name: "Salvar", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(fake.writes[0]).toMatchObject({ method: "POST", path: `/api/v2/workspaces/${A}/upstreams`, body: {
      name: "orders-pool", algorithm: "consistent-hashing", hashOn: "header", hashOnHeader: "X-Client", hashFallback: "ip",
      healthchecks: { active: { type: "http", intervalSeconds: 10, healthyThreshold: 2, unhealthyThreshold: 3, timeoutSeconds: 1, httpPath: "/" }, passive: { unhealthyHttpFailures: 5, unhealthyTimeouts: 3 } },
    } });
    await page.getByRole("button", { name: "Editar orders-pool", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Editar orders-pool", exact: true });
    await expect(dialog.getByLabel("Header do hash", { exact: true })).toHaveValue("X-Client");
    await dialog.getByLabel("Hash por", { exact: true }).selectOption("cookie");
    await dialog.getByLabel("Cookie", { exact: true }).fill("SESSION");
    await expect(dialog.getByLabel("Alternativa", { exact: true })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Salvar", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(fake.writes[1]).toMatchObject({ method: "PUT", body: { hashOn: "cookie", hashOnCookie: "SESSION", hashFallback: "none" } });
    await page.getByRole("button", { name: "Targets de orders-pool", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Targets de orders-pool", exact: true });
    await dialog.getByLabel("Novo target", { exact: true }).fill("new.internal:9090");
    await dialog.getByLabel("Peso", { exact: true }).fill("42");
    await dialog.getByRole("button", { name: "Adicionar target", exact: true }).click();
    await expect(dialog.getByRole("table", { name: "Targets", exact: true })).toContainText("new.internal:9090");
    await dialog.getByRole("button", { name: "Editar peso de new.internal:9090", exact: true }).click();
    await dialog.getByLabel("Peso", { exact: true }).fill("0");
    await dialog.getByRole("button", { name: "Salvar peso", exact: true }).click();
    await expect(dialog.getByText("fora do balanceamento", { exact: true })).toBeVisible();
    expect(fake.writes.at(-1)).toMatchObject({ method: "PUT", body: { target: "new.internal:9090", weight: 0, tags: [] } });
    await audit(page);
    await dialog.getByRole("button", { name: "Remover new.internal:9090", exact: true }).click();
    await page.getByRole("dialog", { name: "Remover target", exact: true }).getByRole("button", { name: "Remover", exact: true }).click();
    await expect(dialog.getByText(/Nenhum target:/)).toBeVisible();
    await dialog.getByRole("button", { name: "Fechar", exact: true }).click();
    const before = fake.writes.length;
    await page.getByRole("button", { name: "Excluir orders-pool", exact: true }).click();
    await audit(page);
    await page.getByRole("dialog", { name: "Excluir upstream", exact: true }).getByRole("button", { name: "Cancelar", exact: true }).click();
    expect(fake.writes).toHaveLength(before);
    await page.getByRole("button", { name: "Excluir orders-pool", exact: true }).click();
    await page.getByRole("dialog", { name: "Excluir upstream", exact: true }).getByRole("button", { name: "Excluir", exact: true }).click();
    await expect(page.getByText("Nenhum upstream ainda.", { exact: true })).toBeVisible();
    expect(fake.writes.map((w) => w.method)).toEqual(["POST", "PUT", "POST", "PUT", "DELETE", "DELETE"]);
  });

  test(`archived is read-only, including targets, at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fake = await setup(page, { archived: true });
    await page.goto(url());
    await expect(page.getByText("Somente leitura: este Workspace está arquivado.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Novo upstream|Editar orders-pool|Excluir orders-pool/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Targets de orders-pool", exact: true }).click();
    await expect(page.getByRole("table", { name: "Targets", exact: true })).toContainText("backend.internal:8080");
    await expect(page.getByRole("button", { name: /Adicionar target|Editar peso|Remover backend/ })).toHaveCount(0);
    await audit(page);
    expect(fake.writes).toEqual([]);
  });
}

for (const status of [401, 403, 404, 500]) test(`context HTTP ${status} never loads gateway data`, async ({ page }) => {
  const fake = await setup(page, { contextStatus: status });
  await page.goto(url());
  if (status === 401) await expect(page).toHaveURL("/login");
  else await expect(page.getByRole("alert")).toContainText(status === 403 ? "Você não tem permissão" : status === 404 ? "Não encontrado" : "Não foi possível verificar");
  expect(fake.reads.some((p) => p.startsWith(`${url().replace("/workspaces", "/api/v2/workspaces")}`))).toBe(false);
  await expect(page.getByRole("button", { name: "Novo upstream", exact: true })).toHaveCount(0);
});
for (const status of [401, 403, 404, 500]) test(`Upstream list HTTP ${status} is distinct from empty`, async ({ page }) => {
  await setup(page, { listStatus: status });
  await page.goto(url());
  if (status === 401) await expect(page).toHaveURL("/login");
  else await expect(page.getByRole("alert")).toContainText(status === 403 ? "Você não tem permissão" : status === 404 ? "Item não encontrado" : "Não foi possível concluir");
  await expect(page.getByText("Nenhum upstream ainda.", { exact: true })).toHaveCount(0);
});
for (const status of [403, 409]) test(`write HTTP ${status} preserves form and shows Portuguese error`, async ({ page }) => {
  const fake = await setup(page);
  fake.state.writeStatus = status; fake.state.code = "auto-publish";
  await page.goto(url());
  await page.getByRole("button", { name: "Editar orders-pool", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Editar orders-pool", exact: true });
  await dialog.getByRole("button", { name: "Salvar", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText(status === 403 ? "Você não tem permissão" : "publicação manual");
  await expect(dialog.getByLabel("Nome", { exact: true })).toHaveValue("orders-pool");
  expect(fake.writes).toHaveLength(1);
});
test("422 target VarRef is refused, weight is validated, and Services errors never mean no links", async ({ page }) => {
  const fake = await setup(page, { servicesStatus: 403 });
  await page.goto(url());
  await expect(page.getByRole("alert")).toContainText("Não foi possível consultar os Serviços vinculados");
  await expect(page.getByText("Serviços vinculados: nenhum.", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Targets de orders-pool", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Targets de orders-pool", exact: true });
  await dialog.getByLabel("Novo target", { exact: true }).fill("backend.internal:80");
  await dialog.getByLabel("Peso", { exact: true }).fill("-1");
  await dialog.getByRole("button", { name: "Adicionar target", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("inteiro de 0 a 65535");
  expect(fake.writes).toEqual([]);
  fake.state.varRef = true;
  await dialog.getByLabel("Peso", { exact: true }).fill("100");
  await dialog.getByRole("button", { name: "Adicionar target", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("variáveis ainda não são aceitas");
  await expect(dialog.getByLabel("Novo target", { exact: true })).toHaveValue("backend.internal:80");
});
test("switch A to B drops forms and targets, retaining the v2 section", async ({ page }) => {
  const fake = await setup(page);
  await page.goto(url());
  await page.getByRole("button", { name: "Novo upstream", exact: true }).click();
  await page.getByRole("dialog").getByLabel("Nome", { exact: true }).fill("unsaved-A");
  await page.getByLabel("Workspace v2", { exact: true }).selectOption(B);
  await expect(page).toHaveURL(url(B));
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("Nenhum upstream ainda.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Novo upstream", exact: true }).click();
  await expect(page.getByRole("dialog").getByLabel("Nome", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "Cancelar", exact: true }).click();
  await page.getByLabel("Workspace v2", { exact: true }).selectOption(A);
  await page.getByRole("button", { name: "Targets de orders-pool", exact: true }).click();
  await page.getByLabel("Workspace v2", { exact: true }).selectOption(B);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(fake.writes).toEqual([]);
});
test("pending list and delayed A response cannot populate B", async ({ page }) => {
  await setup(page);
  let release!: () => void;
  let responseCompleted = false;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/api/v2/workspaces/${A}/upstreams`, async (route) => {
    await held;
    await route.fulfill({ json: pageOf([upstream]) }).catch(() => {});
    responseCompleted = true;
  });
  await page.goto(url());
  await expect(page.getByRole("status").filter({ hasText: "Carregando Upstreams…" })).toBeVisible();
  try {
    await page.getByLabel("Workspace v2", { exact: true }).selectOption(B);
    await expect(page.getByText("Nenhum upstream ainda.", { exact: true })).toBeVisible();
  } finally { release(); }
  await expect.poll(() => responseCompleted).toBe(true);
  await expect(page.getByRole("table", { name: "Upstreams", exact: true })).toHaveCount(0);
  await expect(page.getByText("orders-pool", { exact: true })).toHaveCount(0);
});

for (const status of [401, 403, 404, 500]) test(`target list HTTP ${status} is distinct from empty`, async ({ page }) => {
  await setup(page);
  await page.route(`**/api/v2/workspaces/${A}/upstreams/${U}/targets`, (route) => route.fulfill(problem(status)));
  await page.goto(url());
  await page.getByRole("button", { name: "Targets de orders-pool", exact: true }).click();
  if (status === 401) await expect(page).toHaveURL("/login");
  else {
    const dialog = page.getByRole("dialog", { name: "Targets de orders-pool", exact: true });
    await expect(dialog.getByRole("alert")).toContainText(status === 403 ? "Você não tem permissão" : status === 404 ? "Item não encontrado" : "Não foi possível concluir");
    await expect(dialog.getByText(/Nenhum target:/)).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Adicionar target", exact: true })).toHaveCount(0);
  }
});
test("mutation 401 returns to login and clears the open form", async ({ page }) => {
  const fake = await setup(page);
  fake.state.writeStatus = 401;
  await page.goto(url());
  await page.getByRole("button", { name: "Editar orders-pool", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Salvar", exact: true }).click();
  await expect(page).toHaveURL("/login");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
for (const width of [390, 768, 1440]) {
  for (const status of [403, 404]) test(`denied context ${status} axe and width at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await setup(page, { contextStatus: status });
    await page.goto(url());
    await expect(page.getByRole("alert")).toBeVisible();
    await audit(page);
  });
  test(`loading, error, empty, and login axe and width at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await setup(page, { empty: true });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route(`**/api/v2/workspaces/${A}/upstreams`, async (route) => { await held; await route.fulfill(problem(500)); });
    await page.goto(url());
    await expect(page.getByText("Carregando Upstreams…", { exact: true })).toBeVisible();
    try { await audit(page); } finally { release(); }
    await expect(page.getByRole("alert")).toContainText("Não foi possível concluir");
    await audit(page);
    await page.unroute(`**/api/v2/workspaces/${A}/upstreams`);
    await page.reload();
    await expect(page.getByText("Nenhum upstream ainda.", { exact: true })).toBeVisible();
    await audit(page);
    await page.route(`**/api/v2/workspaces/${A}`, (route) => route.fulfill(problem(401)));
    await page.reload();
    await expect(page).toHaveURL("/login");
    await audit(page);
  });
}
