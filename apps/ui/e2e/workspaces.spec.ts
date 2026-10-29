import AxeBuilder from "@axe-core/playwright";
import type { Page, Route } from "@playwright/test";
import { expect, mockSession, test } from "./fixtures";
import { checkLayout } from "./layout";
import type { Me } from "../src/api/client";
import type { Workspace, WorkspaceCreationPolicy } from "../src/api/client-v2";

// WS-M3: the Workspaces page (API v2, which the contract mock does not serve: a fake of the v2 contract answers it
// here) and the shell selector, which still lists the v1 environments: the same ids, kept in step with the fake.
const id = (n: number) => `6d3e8b20-4c5e-4d6f-9a70-${String(n).padStart(12, "0")}`;
const NOW = "2026-10-29T12:00:00Z";
const person = (role: Me["role"], environmentRoles: Me["environmentRoles"] = []): Me => ({
  id: id(90), name: "Rui Prado", email: "rui@gromesh.dev", role, active: true, environmentRoles, createdAt: NOW, updatedAt: NOW,
});
const admin: Me = { ...person("admin"), id: id(91), name: "Ana Souza", email: "ana@gromesh.dev" };
const ws = (n: number, name: string, slug: string, extra: Partial<Workspace> = {}): Workspace => ({
  id: id(n), key: id(n + 50), name, slug, status: "active", activeRelease: null, description: `Times de ${name}`, ...extra,
});
const policyOf = (over: Partial<WorkspaceCreationPolicy> = {}): WorkspaceCreationPolicy => ({
  mode: "restricted-request", creatorBecomesAdmin: false, updatedAt: null, updatedBy: null, workspacesMode: "lab", stage: "dev",
  caller: { canCreate: true, canRequest: false, canDecide: true }, ...over,
});
const problem = (status: number, extra: object = {}) => ({ status, contentType: "application/problem+json", json: { type: "about:blank", title: "Problem", status, ...extra } });

interface Fake {
  workspaces: Workspace[];
  policy: WorkspaceCreationPolicy;
  requests: { method: string; path: string; body: unknown }[];
  /** Answers the next call of an operation instead of the fake (e.g. a 403 or a 409), once. */
  next: Partial<Record<"create" | "update" | "archive", Parameters<Route["fulfill"]>[0]>>;
  /** Holds an operation's answer until released, to see the screen while the request is in flight. */
  hold: Partial<Record<"create" | "update" | "archive", Promise<void>>>;
}

async function fakeApi(page: Page, init: { workspaces: Workspace[]; policy?: WorkspaceCreationPolicy; pageSize?: number }): Promise<Fake> {
  const fake: Fake = { workspaces: init.workspaces, policy: init.policy ?? policyOf(), requests: [], next: {}, hold: {} };
  const pageSize = init.pageSize ?? 50;
  const env = (w: Workspace) => ({ id: w.id, name: w.name, publishMode: "manual", currentVersion: null, hasUnpublishedChanges: false, createdAt: NOW, updatedAt: NOW });
  await page.route("**/api/v1/environments", (route) => route.fulfill({ json: { items: fake.workspaces.map(env), nextCursor: null } }));
  await page.route(/\/api\/v1\/environments\/[0-9a-f-]{36}$/, (route) => {
    const w = fake.workspaces.find((x) => route.request().url().endsWith(x.id));
    return w ? route.fulfill({ json: env(w) }) : route.fulfill(problem(404));
  });
  await page.route("**/api/v1/environments/*/services*", (route) => route.fulfill({ json: { items: [], nextCursor: null } }));
  await page.route("**/api/v1/environments/*/clusters", (route) => route.fulfill({ json: { items: [] } }));
  await page.route("**/api/v2/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api\/v2/, "");
    const method = request.method();
    const body: unknown = request.postData() ? request.postDataJSON() : null;
    fake.requests.push({ method, path, body });
    const once = (op: keyof Fake["next"]) => {
      const answer = fake.next[op];
      delete fake.next[op];
      return answer;
    };
    if (method === "GET" && path === "/workspace-creation-policy") return route.fulfill({ json: fake.policy });
    if (method === "GET" && path === "/workspaces") {
      const sorted = [...fake.workspaces].sort((a, b) => a.name.localeCompare(b.name));
      const from = Number(url.searchParams.get("cursor") ?? 0);
      const items = sorted.slice(from, from + pageSize);
      return route.fulfill({ json: { items, nextCursor: from + pageSize < sorted.length ? String(from + pageSize) : null } });
    }
    if (method === "POST" && path === "/workspaces") {
      if (request.headers()["x-csrf-token"] === undefined) return route.fulfill(problem(403));
      await fake.hold.create;
      const answer = once("create");
      if (answer) return route.fulfill(answer);
      const { name, slug, description } = body as { name: string; slug: string; description?: string };
      if (name.length > 100) return route.fulfill(problem(422, { errors: [{ path: "name", message: "must NOT have more than 100 characters" }] }));
      if (fake.workspaces.some((w) => w.slug === slug)) {
        return route.fulfill(problem(409, { code: "slug-taken", detail: "Another workspace of this instance has this slug", errors: [{ path: "slug", message: "taken" }], suggestedSlug: `${slug}-2` }));
      }
      const created = ws(fake.workspaces.length + 10, name, slug, { description });
      fake.workspaces.push(created);
      return route.fulfill({ status: 201, json: created });
    }
    const match = /^\/workspaces\/([0-9a-f-]{36})(\/archive)?$/.exec(path);
    const target = fake.workspaces.find((w) => w.id === match?.[1]);
    if (!match || !target) return route.fulfill(problem(404));
    if (method === "GET" && !match[2]) return route.fulfill({ json: target });
    if (method === "PATCH") {
      await fake.hold.update;
      const answer = once("update");
      if (answer) return route.fulfill(answer);
      Object.assign(target, body);
      return route.fulfill({ json: target });
    }
    if (method === "POST" && match[2]) {
      await fake.hold.archive;
      const answer = once("archive");
      if (answer) return route.fulfill(answer);
      target.status = "archived";
      return route.fulfill({ status: 204 });
    }
    return route.fulfill(problem(405));
  });
  return fake;
}

async function signIn(page: Page, user: Me) {
  await mockSession(page, user);
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(user.email);
  await page.getByLabel("Senha").fill("s3nha-de-teste");
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("heading", { name: "Services", exact: true })).toBeVisible();
}

async function openWorkspaces(page: Page, user: Me) {
  await signIn(page, user);
  await page.getByRole("navigation", { name: "Menu principal" }).getByRole("link", { name: "Workspaces", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Workspaces" })).toBeVisible();
}

const table = (page: Page) => page.getByRole("table", { name: "Workspaces", exact: true });
const row = (page: Page, name: string) => table(page).getByRole("row").filter({ hasText: name });
const selector = (page: Page) => page.getByLabel("Workspace", { exact: true });

const pagamentos = () => ws(1, "Pagamentos", "pagamentos", { activeRelease: 4 });
const recargas = () => ws(2, "Recargas", "recargas");
const legado = () => ws(3, "Legado", "legado", { status: "archived" });

test("lists workspaces page by page, marks the archived one and opens the detail", async ({ page }) => {
  await fakeApi(page, { workspaces: [pagamentos(), recargas(), legado()], pageSize: 2 });
  await openWorkspaces(page, admin);
  await expect(table(page).locator("tbody tr")).toHaveCount(2);
  await expect(row(page, "Legado")).toContainText("Arquivado");
  await expect(row(page, "Legado")).toHaveClass("row-off");
  await expect(row(page, "Legado").getByRole("button", { name: "Editar Legado" })).toHaveCount(0);
  await expect(row(page, "Legado").getByRole("button", { name: "Mais ações para Legado" })).toHaveCount(0);
  await expect(row(page, "Pagamentos")).toContainText("Ativo");
  await expect(row(page, "Pagamentos")).toContainText("pagamentos");
  await expect(row(page, "Pagamentos")).toContainText("Times de Pagamentos");
  await expect(row(page, "Recargas")).toHaveCount(0);

  await page.getByRole("button", { name: "Carregar mais" }).click();
  await expect(row(page, "Recargas")).toBeVisible();
  await expect(page.getByRole("button", { name: "Carregar mais" })).toHaveCount(0);

  await row(page, "Pagamentos").getByRole("button", { name: "Detalhes de Pagamentos" }).click();
  const dialog = page.getByRole("dialog", { name: "Pagamentos" });
  await expect(dialog).toContainText(id(1));
  await expect(dialog).toContainText(id(51));
  await expect(dialog).toContainText("v4");
  await expect(dialog).toContainText("Ativo");
});

test("an authorized caller creates a workspace: suggested slug, success only after the 201, selector refreshed", async ({ page }) => {
  const fake = await fakeApi(page, { workspaces: [pagamentos()] });
  let release!: () => void;
  fake.hold.create = new Promise((resolve) => (release = resolve));
  await openWorkspaces(page, admin);
  await page.getByRole("button", { name: "Criar Workspace" }).click();
  const dialog = page.getByRole("dialog", { name: "Criar Workspace" });
  await expect(dialog).toContainText("sem hífen no fim nem dois seguidos");
  await dialog.getByLabel("Nome").fill("Gestão de Cobrança");
  await expect(dialog.getByLabel("Slug")).toHaveValue("gestao-de-cobranca");
  await dialog.getByLabel("Descrição").fill("Boletos e PIX");
  await dialog.getByRole("button", { name: "Criar", exact: true }).click();

  await expect(dialog.getByRole("button", { name: "Criando…" })).toBeDisabled();
  await expect(page.getByRole("status")).toHaveCount(0);
  release();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveText("Workspace “Gestão de Cobrança” criado com o slug gestao-de-cobranca.");
  expect(fake.requests.filter((r) => r.method === "POST")).toEqual([
    { method: "POST", path: "/workspaces", body: { name: "Gestão de Cobrança", slug: "gestao-de-cobranca", description: "Boletos e PIX" } },
  ]);
  await expect(row(page, "Gestão de Cobrança")).toContainText("gestao-de-cobranca");
  await expect(selector(page).locator("option")).toHaveText(["Pagamentos", "Gestão de Cobrança"]);
});

test("validation errors land on their field; a taken slug offers the suggestion without applying it", async ({ page }) => {
  const fake = await fakeApi(page, { workspaces: [pagamentos()] });
  await openWorkspaces(page, admin);
  await page.getByRole("button", { name: "Criar Workspace" }).click();
  const dialog = page.getByRole("dialog", { name: "Criar Workspace" });
  const posts = () => fake.requests.filter((r) => r.method === "POST").length;

  // A reserved slug is explained before anything is sent.
  await dialog.getByLabel("Nome").fill("API");
  await dialog.getByRole("button", { name: "Criar", exact: true }).click();
  await expect(dialog.getByText("Slug reservado pela plataforma. Escolha outro.")).toBeVisible();
  expect(posts()).toBe(0);

  // The server's 422 at `name`.
  await dialog.getByLabel("Nome").fill("N".repeat(101));
  await dialog.getByLabel("Slug").fill("nome-longo");
  await dialog.getByRole("button", { name: "Criar", exact: true }).click();
  await expect(dialog.getByText("Nome: use no máximo 100 caracteres.")).toBeVisible();
  await expect(dialog).not.toContainText("must NOT");
  await expect(dialog.getByLabel("Nome")).toHaveAttribute("aria-invalid", "true");

  // The server's 409 slug-taken, with suggestedSlug.
  await dialog.getByLabel("Nome").fill("Pagamentos Novos");
  await dialog.getByLabel("Slug").fill("pagamentos");
  await dialog.getByRole("button", { name: "Criar", exact: true }).click();
  await expect(dialog.getByText("Este slug já está em uso nesta instância")).toBeVisible();
  await expect(dialog.getByLabel("Slug")).toHaveAttribute("aria-invalid", "true");
  await expect(dialog.getByLabel("Slug")).toHaveValue("pagamentos");
  expect(posts()).toBe(2);
  await dialog.getByRole("button", { name: "Usar pagamentos-2" }).click();
  await expect(dialog.getByLabel("Slug")).toHaveValue("pagamentos-2");
  expect(posts()).toBe(2);
  await expect(page.getByRole("status")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Criar", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row(page, "Pagamentos Novos")).toContainText("pagamentos-2");
});

test("without permission: no create button; edit and archive are tried and the server's 403 is shown, nothing changes", async ({ page }) => {
  const fake = await fakeApi(page, {
    workspaces: [pagamentos(), recargas()],
    policy: policyOf({ caller: { canCreate: false, canRequest: true, canDecide: false } }),
  });
  await openWorkspaces(page, person("viewer"));
  await expect(row(page, "Recargas")).toBeVisible();
  await expect(page.getByRole("button", { name: "Criar Workspace" })).toHaveCount(0);
  await expect(page.getByRole("note", { name: "Disponibilidade" })).toContainText("A solicitação de Workspaces ainda não está disponível nesta interface.");

  fake.next.update = problem(403, { title: "Forbidden", detail: "Requires permission workspace.admin" });
  await row(page, "Recargas").getByRole("button", { name: "Editar Recargas" }).click();
  const edit = page.getByRole("dialog", { name: "Editar Recargas" });
  await edit.getByLabel("Nome").fill("Recargas e Pacotes");
  await edit.getByRole("button", { name: "Salvar" }).click();
  await expect(edit.getByRole("alert")).toHaveText("Você não tem permissão para editar este Workspace.");
  await expect(edit).toBeVisible();
  await edit.getByRole("button", { name: "Cancelar" }).click();

  fake.next.archive = problem(403, { title: "Forbidden", detail: "Requires permission platform.admin" });
  await row(page, "Recargas").getByRole("button", { name: "Mais ações para Recargas" }).click();
  await page.getByRole("menuitem", { name: "Arquivar" }).click();
  const archive = page.getByRole("dialog", { name: "Arquivar Workspace" });
  await archive.getByRole("button", { name: "Arquivar" }).click();
  await expect(archive.getByRole("alert")).toHaveText("Só a administração da plataforma arquiva Workspaces.");
  await archive.getByRole("button", { name: "Cancelar" }).click();

  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(row(page, "Recargas")).toContainText("Ativo");
  await expect(row(page, "Recargas e Pacotes")).toHaveCount(0);
  await expect(selector(page).locator("option")).toHaveText(["Pagamentos", "Recargas"]);
  expect(fake.workspaces.map((w) => [w.name, w.status])).toEqual([["Pagamentos", "active"], ["Recargas", "active"]]);
});

test("edit and archive report success only after the server's 200 and 204", async ({ page }) => {
  const fake = await fakeApi(page, { workspaces: [pagamentos(), recargas()] });
  await openWorkspaces(page, admin);
  let releaseUpdate!: () => void;
  fake.hold.update = new Promise((resolve) => (releaseUpdate = resolve));
  await row(page, "Recargas").getByRole("button", { name: "Editar Recargas" }).click();
  const edit = page.getByRole("dialog", { name: "Editar Recargas" });
  await edit.getByLabel("Nome").fill("Recargas e Pacotes");
  await edit.getByRole("button", { name: "Salvar" }).click();
  await expect(edit.getByRole("button", { name: "Salvando…" })).toBeDisabled();
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(row(page, "Recargas e Pacotes")).toHaveCount(0);
  releaseUpdate();
  await expect(edit).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveText("Workspace “Recargas e Pacotes” atualizado.");

  let releaseArchive!: () => void;
  fake.hold.archive = new Promise((resolve) => (releaseArchive = resolve));
  await row(page, "Pagamentos").getByRole("button", { name: "Mais ações para Pagamentos" }).click();
  await page.getByRole("menuitem", { name: "Arquivar" }).click();
  const archive = page.getByRole("dialog", { name: "Arquivar Workspace" });
  await archive.getByRole("button", { name: "Arquivar" }).click();
  await expect(archive.getByRole("button", { name: "Arquivar" })).toBeDisabled();
  await expect(archive).toBeVisible();
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(row(page, "Pagamentos")).toContainText("Ativo");
  releaseArchive();
  await expect(archive).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveText("Workspace “Pagamentos” arquivado.");
  await expect(row(page, "Pagamentos")).toContainText("Arquivado");
});

test("disabled Workspaces mode and HML/PRD stages say why creation is unavailable, with no way around it", async ({ page }) => {
  const fake = await fakeApi(page, {
    workspaces: [pagamentos()],
    policy: policyOf({ workspacesMode: "disabled", caller: { canCreate: false, canRequest: false, canDecide: false } }),
  });
  await openWorkspaces(page, admin);
  const strip = page.getByRole("note", { name: "Disponibilidade" });
  await expect(strip).toContainText("a criação de Workspaces só existe no laboratório isolado autorizado");
  await expect(strip).toContainText("Deployment e ativação operacional de Workspaces estão indisponíveis.");
  await expect(strip.locator("a, button")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Criar Workspace" })).toHaveCount(0);

  fake.policy = policyOf({ stage: "prd", caller: { canCreate: false, canRequest: false, canDecide: false } });
  await page.reload();
  await expect(page.getByRole("note", { name: "Disponibilidade" })).toContainText("Esta instância é PRD. HML e PRD recebem Workspaces só por promoção");
  await expect(page.getByRole("button", { name: "Criar Workspace" })).toHaveCount(0);
});

test("a workspace admin edits the name and description; the slug stays read-only", async ({ page }) => {
  const fake = await fakeApi(page, { workspaces: [pagamentos(), recargas()] });
  await openWorkspaces(page, admin);
  await row(page, "Recargas").getByRole("button", { name: "Editar Recargas" }).click();
  const dialog = page.getByRole("dialog", { name: "Editar Recargas" });
  await expect(dialog.getByRole("textbox", { name: "Slug" })).toHaveCount(0);
  await expect(dialog).toContainText("recargas");
  await dialog.getByLabel("Nome").fill("Recargas e Pacotes");
  await dialog.getByLabel("Descrição").fill("Recargas pré-pagas");
  await dialog.getByRole("button", { name: "Salvar" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveText("Workspace “Recargas e Pacotes” atualizado.");
  expect(fake.requests.filter((r) => r.method === "PATCH")).toEqual([
    { method: "PATCH", path: `/workspaces/${id(2)}`, body: { name: "Recargas e Pacotes", description: "Recargas pré-pagas" } },
  ]);
  await expect(row(page, "Recargas e Pacotes")).toContainText("Recargas pré-pagas");
  await expect(selector(page).locator("option")).toHaveText(["Pagamentos", "Recargas e Pacotes"]);
});

test("a platform admin archives from the row menu with a confirmation; refusals explain why", async ({ page }) => {
  const fake = await fakeApi(page, { workspaces: [pagamentos(), recargas()] });
  await openWorkspaces(page, admin);
  fake.next.archive = problem(409, { code: "deployed", detail: "The workspace is a member of the latest deployment revision" });
  await row(page, "Pagamentos").getByRole("button", { name: "Mais ações para Pagamentos" }).click();
  await page.getByRole("menuitem", { name: "Arquivar" }).click();
  let dialog = page.getByRole("dialog", { name: "Arquivar Workspace" });
  await expect(dialog).toContainText("Nada é apagado");
  await dialog.getByRole("button", { name: "Arquivar" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(/faz parte do deployment mais recente desta instância/);
  await dialog.getByRole("button", { name: "Cancelar" }).click();
  await expect(row(page, "Pagamentos")).toContainText("Ativo");

  await row(page, "Recargas").getByRole("button", { name: "Mais ações para Recargas" }).click();
  await page.getByRole("menuitem", { name: "Arquivar" }).click();
  dialog = page.getByRole("dialog", { name: "Arquivar Workspace" });
  await dialog.getByRole("button", { name: "Arquivar" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveText("Workspace “Recargas” arquivado.");
  await expect(row(page, "Recargas")).toContainText("Arquivado");
  await expect(row(page, "Recargas").getByRole("button", { name: "Editar Recargas" })).toHaveCount(0);
  await expect(row(page, "Recargas").getByRole("button", { name: "Mais ações para Recargas" })).toHaveCount(0);
  expect(fake.requests.filter((r) => r.path.endsWith("/archive")).map((r) => r.path)).toEqual([`/workspaces/${id(1)}/archive`, `/workspaces/${id(2)}/archive`]);
});

test("the selector switches workspace and shows nothing of the previous one while the next loads", async ({ page }) => {
  await fakeApi(page, { workspaces: [pagamentos(), recargas()] });
  await page.route(`**/api/v1/environments/${id(1)}/services*`, (route) => route.fulfill({ json: { items: [{
    id: id(80), name: "cobranca-api", protocol: "http", host: "cobranca.internal", port: 80, path: null, enabled: true, tags: [], createdAt: NOW, updatedAt: NOW,
  }], nextCursor: null } }));
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(`**/api/v1/environments/${id(2)}/services*`, async (route) => {
    await held;
    return route.fulfill({ json: { items: [], nextCursor: null } });
  });
  await signIn(page, admin);
  await expect(page.getByText("cobranca-api")).toBeVisible();
  await expect(selector(page).locator("option")).toHaveText(["Pagamentos", "Recargas"]);
  await selector(page).selectOption({ label: "Recargas" });
  await expect(page).toHaveURL(new RegExp(`/e/${id(2)}/services$`));
  await expect(page.getByText("Carregando…")).toBeVisible();
  await expect(page.getByText("cobranca-api")).toHaveCount(0);
  release();
  await expect(page.getByText("Nenhum service ainda.")).toBeVisible();
  await expect(page.getByText("cobranca-api")).toHaveCount(0);
});

for (const width of [390, 1440]) {
  test(`workspaces: layout and axe at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await fakeApi(page, { workspaces: [pagamentos(), recargas(), legado()] });
    await openWorkspaces(page, admin);
    await checkLayout(page);
    const audit = async (name: string) => {
      const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      expect(result.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${name}: ${v.id}`)).toEqual([]);
    };
    await audit("list");
    await page.getByRole("button", { name: "Criar Workspace" }).click();
    const dialog = page.getByRole("dialog", { name: "Criar Workspace" });
    await dialog.getByLabel("Nome").fill("API");
    await dialog.getByRole("button", { name: "Criar", exact: true }).click();
    await expect(dialog.getByText("Slug reservado pela plataforma. Escolha outro.")).toBeVisible();
    await checkLayout(page, { focusWithin: ".modal" });
    await audit("create");
    await dialog.getByRole("button", { name: "Cancelar" }).click();
    await row(page, "Pagamentos").getByRole("button", { name: "Mais ações para Pagamentos" }).click();
    await expect(page.getByRole("menuitem", { name: "Arquivar" })).toBeVisible();
    await checkLayout(page);
    await audit("menu");
  });
}
