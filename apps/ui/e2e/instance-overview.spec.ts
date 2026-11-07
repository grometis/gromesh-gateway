import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import type { Workspace } from "../src/api/client-v2";
import { expect, mockSession, test } from "./fixtures";

const id = (n: number) => `7c1d2e3f-4a5b-4c6d-8e7f-${String(n).padStart(12, "0")}`;
const workspace = (n: number, changes: Partial<Workspace> = {}): Workspace => ({ id: id(n), key: id(n + 100), name: `Time ${n}`, slug: `time-${n}`, description: `Integrações do time ${n}`, status: "active", activeRelease: null, ...changes });
const A = workspace(1, { activeRelease: 4 });
const B = workspace(2, { status: "archived", activeRelease: undefined });
const user = { id: id(99), name: "Ana", email: "ana@example.test", role: "viewer" as const, active: true, createdAt: "2026-11-03T12:00:00Z", updatedAt: "2026-11-03T12:00:00Z" };
interface State {
  items?: Workspace[];
  next?: Workspace[];
  listStatus?: number;
  nextStatus?: number;
  detailStatus?: number;
  policyStatus?: number;
  pending?: Promise<void>;
}

async function setup(page: Page, state: State = {}, authenticated = true) {
  const sent: URL[] = [];
  page.on("request", (request) => { if (/\/api\/v[12]\//.test(request.url())) sent.push(new URL(request.url())); });
  await mockSession(page, user);
  await page.route(/^https?:\/\/[^/]+\/api\/v[12]\//, async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const json = (data: unknown, status = 200) => route.fulfill({ status, json: status === 200 ? data : { title: "Unavailable", status } });
    if (path === "/api/v1/me" || path === "/api/v1/auth/login") return route.fallback();
    if (path === "/api/v1/auth/csrf") return json({ csrfToken: "csrf" });
    if (path === "/api/v1/environments") return json({ items: [], nextCursor: null });
    if (path === "/api/v1/tokens") return json({ items: [], nextCursor: null });
    if (path === "/api/v2/workspace-creation-policy") return json({ mode: "restricted-request", creatorBecomesAdmin: false, updatedAt: null, updatedBy: null, workspacesMode: "disabled", stage: "dev", caller: { canCreate: false, canRequest: false, canDecide: false } }, state.policyStatus);
    if (path === "/api/v2/workspaces") {
      if (state.pending) await state.pending;
      const next = url.searchParams.has("cursor");
      return json({ items: next ? state.next ?? [] : state.items ?? [A, B], nextCursor: next || !state.next ? null : "opaque+cursor/==" }, next ? state.nextStatus : state.listStatus);
    }
    const found = [...(state.items ?? [A, B]), ...(state.next ?? [])].find((w) => path === `/api/v2/workspaces/${w.id}`);
    if (found) return json(found, state.detailStatus);
    if (/^\/api\/v2\/workspaces\/[^/]+\/services$/.test(path)) return json({ items: [], nextCursor: null });
    return json({}, 404);
  });
  if (authenticated) await page.context().addCookies([{ name: "gromesh_session", value: "session", url: "http://127.0.0.1:5173", httpOnly: true, sameSite: "Strict" }]);
  return sent;
}
const lists = (sent: URL[]) => sent.filter((u) => u.pathname === "/api/v2/workspaces");
const contextual = (sent: URL[]) => sent.filter((u) => /\/(workspaces|environments)\//.test(u.pathname));
const overview = (page: Page) => page.getByRole("heading", { name: "Visão geral da instância", exact: true });
const row = (page: Page, name: string) => page.getByRole("table", { name: "Workspaces acessíveis" }).getByRole("row").filter({ has: page.getByText(name, { exact: true }) });
const loadedCounts = (page: Page) => page.getByRole("definition");
async function login(page: Page) {
  await page.getByLabel("E-mail").fill(user.email);
  await page.getByLabel("Senha").fill("test-password");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
}
async function audit(page: Page, width: number) {
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
}

for (const items of [[], [A], [A, B, workspace(3)]]) {
  test(`ordinary login and root keep ${items.length} Workspaces global without fan-out`, async ({ page }) => {
    const sent = await setup(page, { items }, false);
    await page.goto("/");
    await expect(page).toHaveURL("/login");
    await login(page);
    await expect(overview(page)).toBeVisible();
    await expect(page).toHaveURL("/");
    if (!items.length) await expect(page.getByRole("heading", { name: "Nenhum Workspace disponível para sua conta nesta instância" })).toBeVisible();
    else await expect(row(page, A.name)).toBeVisible();
    await expect(loadedCounts(page).first()).toHaveText(String(items.length));
    expect(lists(sent)).toHaveLength(1);
    expect(lists(sent)[0]!.searchParams.get("limit")).toBe("50");
    expect(contextual(sent)).toEqual([]);
    expect(sent.filter((u) => u.pathname.startsWith("/api/v2/instance/"))).toEqual([]);
    await page.reload();
    await expect(overview(page)).toBeVisible();
    await expect(page).toHaveURL("/");
    expect(contextual(sent)).toEqual([]);
  });
}

test("local search and sort, cursor pagination and metadata keep counts limited to loaded items", async ({ page }) => {
  const sent = await setup(page, { items: [A, B], next: [workspace(3, { name: "Outra equipe" })] });
  await page.goto("/");
  await expect(row(page, A.name)).toContainText("Release selecionada 4");
  await expect(row(page, B.name)).toContainText("Estado da Release não informado");
  await expect(page.getByText("há mais Workspaces.", { exact: false })).toBeVisible();
  await page.getByLabel("Buscar nos Workspaces carregados").fill("time-2");
  await expect(row(page, A.name)).toHaveCount(0);
  await expect(row(page, B.name)).toBeVisible();
  await expect(loadedCounts(page).first()).toHaveText("2");
  await page.getByLabel("Buscar nos Workspaces carregados").fill("fora-da-pagina");
  await expect(page.getByRole("heading", { name: "Nenhum resultado nos Workspaces carregados" })).toBeVisible();
  await page.getByRole("button", { name: "Limpar busca" }).click();
  await page.getByLabel("Ordenar carregados").selectOption("name-desc");
  await expect(page.locator("tbody tr").first()).toContainText(B.name);
  expect(lists(sent)).toHaveLength(1);
  await page.getByRole("button", { name: "Carregar mais", exact: true }).click();
  await expect(row(page, "Outra equipe")).toBeVisible();
  await expect(loadedCounts(page)).toHaveText(["3", "2", "1"]);
  expect(lists(sent).map((u) => u.searchParams.get("cursor"))).toEqual([null, "opaque+cursor/=="]);
  expect(contextual(sent)).toEqual([]);
  await expect(page.getByRole("button", { name: "Carregar mais", exact: true })).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByRole("button", { name: "Carregar mais", exact: true })).toBeFocused();
});

test("next-page failure keeps the existing page and retries only the failed cursor", async ({ page }) => {
  const state: State = { items: [A], next: [B], nextStatus: 502 };
  const sent = await setup(page, state);
  await page.goto("/");
  await page.getByRole("button", { name: "Carregar mais", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Não foi possível carregar mais");
  await expect(row(page, A.name)).toBeVisible();
  await expect(loadedCounts(page)).toHaveText(["1", "1", "0"]);
  await expect(page.getByRole("status")).toContainText("Lista parcial");
  state.nextStatus = 200;
  await page.getByRole("button", { name: "Tentar novamente", exact: true }).click();
  await expect(row(page, B.name)).toBeVisible();
  expect(lists(sent).map((u) => u.searchParams.get("cursor"))).toEqual([null, "opaque+cursor/==", "opaque+cursor/=="]);
  expect(contextual(sent)).toEqual([]);
});

test("initial failure is not empty and permits an explicit retry", async ({ page }) => {
  const state: State = { listStatus: 502 };
  await setup(page, state);
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("Não foi possível carregar os Workspaces");
  await expect(loadedCounts(page)).toHaveText(["—", "—", "—"]);
  await expect(page.getByRole("heading", { name: /Nenhum Workspace disponível/ })).toHaveCount(0);
  state.listStatus = 200;
  await page.getByRole("button", { name: "Tentar novamente", exact: true }).click();
  await expect(row(page, A.name)).toBeVisible();
});

for (const late of [false, true]) {
  test(`403 ${late ? "after a loaded page" : "on entry"} hides workspace data and offers a safe exit`, async ({ page }) => {
    const sent = await setup(page, late ? { items: [A], next: [B], nextStatus: 403 } : { listStatus: 403 });
    await page.goto("/");
    if (late) {
      await expect(row(page, A.name)).toBeVisible();
      await page.getByRole("button", { name: "Carregar mais", exact: true }).click();
    }
    await expect(page.getByRole("alert")).toContainText("Sem permissão para listar Workspaces");
    await expect(page.getByRole("table", { name: "Workspaces acessíveis" })).toHaveCount(0);
    await expect(loadedCounts(page)).toHaveText(["—", "—", "—"]);
    expect(contextual(sent)).toEqual([]);
    await page.getByRole("link", { name: "Ir para minha conta", exact: true }).click();
    await expect(page).toHaveURL("/tokens");
    await expect(page.getByRole("heading", { name: "Tokens de API", exact: true })).toBeVisible();
  });
}

test("401 on the next page clears previous data and existing login returns to root", async ({ page }) => {
  const state: State = { items: [A], next: [B], nextStatus: 401 };
  await setup(page, state);
  await page.goto("/");
  await expect(row(page, A.name)).toBeVisible();
  await page.getByRole("button", { name: "Carregar mais", exact: true }).click();
  await expect(page).toHaveURL("/login");
  await expect(page.locator("body")).not.toContainText(A.description!);
  state.items = [B];
  state.next = undefined;
  await login(page);
  await expect(overview(page)).toBeVisible();
  await expect(row(page, B.name)).toBeVisible();
  await expect(row(page, A.name)).toHaveCount(0);
  await expect(loadedCounts(page)).toHaveText(["1", "0", "1"]);
});

for (const width of [390, 768, 1440]) {
  for (const archived of [false, true]) {
    test(`explicit open establishes v2 context at ${width}px; archived=${archived}; available navigation returns to global`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const target = archived ? B : A;
      const sent = await setup(page, { items: [target] });
      await page.goto("/");
      const open = page.getByRole("link", { name: `Abrir Workspace ${target.name}`, exact: true });
      await expect(open).toHaveAttribute("href", `/workspaces/${target.id}`);
      expect(contextual(sent)).toEqual([]);
      await open.click();
      await expect(page).toHaveURL(`/workspaces/${target.id}/overview`);
      await expect(page.getByRole("heading", { name: "Visão geral do Workspace", exact: true })).toBeVisible();
      const mobile = width <= 900;
      const trigger = page.getByRole("button", { name: `Abrir menu Gateway · ${target.name} — Workspace`, exact: true });
      if (mobile) {
        await expect(trigger).toBeVisible();
        await expect(trigger).toHaveText(`Gateway · ${target.name}`);
        await expect(trigger).toHaveAttribute("aria-expanded", "false");
        await trigger.click();
      }
      const context = mobile
        ? page.getByRole("dialog", { name: `Navegação Gateway do Workspace ${target.name}`, exact: true })
        : page.getByRole("complementary", { name: `Gateway do Workspace ${target.name}`, exact: true });
      await expect(context).toBeVisible();
      await expect(context.locator(".gateway-context > strong")).toHaveText(target.name);
      await expect(context.locator(".gateway-context > strong")).toBeVisible();
      await expect(context.getByRole("status")).toHaveText(`Workspace v2 · /${target.slug} · ${archived ? "arquivado · somente leitura" : "ativo"}`);
      await expect(context.getByRole("status")).toBeVisible();
      if (mobile) {
        await context.getByRole("button", { name: "Fechar menu Gateway", exact: true }).click();
        await expect(trigger).toBeVisible();
        await expect(trigger).toHaveText(`Gateway · ${target.name}`);
      }
      if (archived) {
        await expect(page.getByRole("link", { name: "Novo serviço", exact: true })).toHaveCount(0);
      }
      await audit(page, width);
      expect(sent.some((u) => u.pathname === `/api/v2/workspaces/${target.id}`)).toBe(true);
      expect(sent.some((u) => u.pathname.startsWith("/api/v1/environments/"))).toBe(false);
      const beforeReturn = sent.length;
      if (width <= 600) {
        await trigger.click();
        await context.getByRole("link", { name: "Voltar à visão geral da instância", exact: true }).click();
      } else await page.getByRole("link", { name: "gromesh, início", exact: true }).click();
      await expect(overview(page)).toBeVisible();
      await expect(page).toHaveURL("/");
      await expect(page.getByRole("heading", { name: "Visão geral do Workspace", exact: true })).toHaveCount(0);
      await expect(page.locator(".workspace-context")).toHaveCount(0);
      await expect(row(page, target.name)).toBeVisible();
      expect(contextual(sent.slice(beforeReturn))).toEqual([]);
    });
  }
}

test("removed Workspace stays at the v2 404 with no selection or legacy fallback", async ({ page }) => {
  const state: State = { items: [A, B] };
  const sent = await setup(page, state);
  await page.goto("/");
  await expect(row(page, A.name)).toBeVisible();
  state.detailStatus = 404;
  await page.getByRole("link", { name: `Abrir Workspace ${A.name}`, exact: true }).click();
  await expect(page.getByText("Não encontrado ou indisponível para sua conta.", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(`/workspaces/${A.id}`);
  await expect(page.getByRole("heading", { name: "Visão geral do Workspace", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Serviços", exact: true })).toHaveCount(0);
  expect(sent.some((u) => u.pathname.startsWith("/api/v1/environments/"))).toBe(false);
  expect(sent.some((u) => u.pathname === `/api/v2/workspaces/${B.id}`)).toBe(false);
  expect(sent.some((u) => u.pathname.endsWith("/services"))).toBe(false);
});

test("management survives and returns to instance overview", async ({ page }) => {
  await setup(page);
  await page.goto("/");
  await page.getByRole("link", { name: "Gerenciar Workspaces", exact: true }).click();
  await expect(page).toHaveURL("/workspaces");
  await expect(page.getByRole("heading", { name: "Workspaces", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Abrir Visão geral da instância", exact: true }).click();
  await expect(page).toHaveURL("/");
  await expect(overview(page)).toBeVisible();
});

for (const width of [390, 768, 1440]) {
  for (const scenario of ["loading", "empty", "error", "forbidden", "long-list", "identity-unavailable"] as const) {
    test(`axe and no horizontal scroll: ${scenario} at ${width}px`, async ({ page }) => {
      test.setTimeout(90_000);
      await page.setViewportSize({ width, height: 900 });
      let release!: () => void;
      const pending = new Promise<void>((resolve) => { release = resolve; });
      const state: State = scenario === "loading" ? { pending }
        : scenario === "empty" ? { items: [] }
        : scenario === "error" ? { listStatus: 502 }
        : scenario === "forbidden" ? { listStatus: 403 }
        : scenario === "identity-unavailable" ? { policyStatus: 403 }
        : { items: Array.from({ length: 35 }, (_, n) => workspace(n + 1, { name: `${n + 1} ${"Equipe".repeat(18)}`, description: `https://example.test/${"descricao".repeat(40)}` })), next: [B] };
      await setup(page, state);
      await page.goto("/");
      await expect(overview(page)).toBeVisible();
      if (scenario === "loading") await expect(page.getByText("Carregando Workspaces…", { exact: true })).toBeVisible();
      else if (scenario === "empty") await expect(page.getByRole("heading", { name: /Nenhum Workspace disponível/ })).toBeVisible();
      else if (scenario === "error" || scenario === "forbidden") await expect(page.getByRole("alert")).toBeVisible();
      else await expect(page.getByRole("table", { name: "Workspaces acessíveis" })).toBeVisible();
      if (scenario === "identity-unavailable") await expect(page.getByText("Instância não identificada", { exact: true })).toBeVisible();
      await audit(page, width);
      release();
    });
  }
}
