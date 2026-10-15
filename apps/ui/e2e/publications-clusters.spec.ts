import { expect, test, type Page } from "@playwright/test";

const envId = "11111111-1111-4111-8111-111111111111";
const clusterId = "22222222-2222-4222-8222-222222222222";
const actor = { id: "33333333-3333-4333-8333-333333333333", name: "Ana" };
const summary = (version: number) => ({ version, hash: `sha256:${String(version).repeat(64)}`, createdAt: "2026-10-15T12:00:00Z", createdBy: actor, isCurrent: version === 2, message: `Publicação ${version}`, changeCount: 3 });
const changes = [
  { kind: "services", id: actor.id, label: "orders", change: "modified", before: { host: "old.internal" }, after: { host: "new.internal" } },
  { kind: "keyauth_credentials", id: clusterId, label: "Chave", change: "added", after: { key: "REDACTED" } },
  { kind: "routes", id: envId, label: "legacy", change: "removed", before: { paths: ["/legacy"] } },
];
const cluster = { id: clusterId, environmentId: envId, name: "edge-prod", status: "degraded", createdAt: "2026-10-15T12:00:00Z", nodes: [{ nodeId: "node-1", hostname: "edge-1", state: "failed", appliedVersion: 1, kongHealthy: false, lastSeenAt: "2026-10-15T12:00:00Z", online: true, error: "Invalid configuration: key=REDACTED" }] };

async function login(page: Page, role: "admin" | "editor" | "viewer" = "admin") {
  await page.route("**/api/v1/auth/login", (route) => route.fulfill({ json: { accessToken: "test-session", user: { ...actor, email: "ana@gromesh.dev", role } } }));
  const environment = { id: envId, name: "Produção", publishMode: "manual", currentVersion: 2, hasUnpublishedChanges: false };
  await page.route("**/api/v1/environments", (route) => route.fulfill({ json: { items: [environment] } }));
  await page.route(`**/api/v1/environments/${envId}`, (route) => route.fulfill({ json: environment }));
  await page.goto("/login");
  await page.getByLabel("E-mail").fill("ana@gromesh.dev");
  await page.getByLabel("Senha").fill("test-password");
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("heading", { name: "Services" })).toBeVisible();
}

async function snapshots(page: Page) {
  await page.route("**/api/v1/environments/*/snapshots?*", (route) => route.fulfill({ json: { items: [summary(1)], nextCursor: null } }));
  await page.route("**/api/v1/environments/*/snapshots", (route) => route.fulfill({ json: { items: [summary(2)], nextCursor: "older" } }));
  await page.route("**/api/v1/environments/*/snapshots/*/diff?*", (route) => {
    const url = new URL(route.request().url());
    const restoring = url.pathname.endsWith("/1/diff");
    return route.fulfill({ json: { items: restoring ? [{ ...changes[0], before: changes[0]!.after, after: changes[0]!.before }] : changes } });
  });
  await page.route("**/api/v1/environments/*/snapshots/1", (route) => route.fulfill({ json: { version: 1, hash: summary(1).hash, environmentId: envId, createdAt: summary(1).createdAt, config: { _format_version: "3.0", _transform: true, services: [], routes: [], plugins: [], consumers: [], keyauth_credentials: [{ id: actor.id, consumer: clusterId, key: "never-render-this-secret", tags: [] }] } } }));
}

test("histórico paginado, detalhe, diff v1 → v2 e rollback com o diff inverso", async ({ page }) => {
  await snapshots(page);
  let rollbacks = 0;
  await page.route("**/api/v1/environments/*/snapshots/1/rollback", (route) => { rollbacks++; return route.fulfill({ status: 201, json: { ...summary(3), rollbackOf: 1, isCurrent: true } }); });
  await login(page);
  await page.getByRole("link", { name: "Publicações", exact: true }).click();
  await expect(page.getByRole("link", { name: "v2", exact: true })).toBeVisible();
  const older = page.waitForRequest((r) => r.url().includes("cursor=older"));
  await page.getByRole("button", { name: "Carregar mais" }).click();
  await older;
  await page.getByRole("link", { name: "v1", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Publicação v1", exact: true })).toBeVisible();
  await expect(page.getByText(summary(1).hash, { exact: true })).toBeVisible();
  await expect(page.getByText("never-render-this-secret")).toHaveCount(0);
  await page.getByLabel("Versão de origem").fill("1");
  await page.getByLabel("Versão de destino").fill("2");
  const diffRequest = page.waitForRequest((r) => r.url().endsWith("/snapshots/2/diff?against=1"));
  await page.getByRole("button", { name: "Comparar" }).click();
  await diffRequest;
  const diff = page.getByRole("region", { name: "Diff v1 → v2" });
  await expect(diff.locator('[data-change="modified"]')).toHaveCount(1);
  await expect(diff.locator('[data-change="added"]')).toHaveCount(1);
  await expect(diff.locator('[data-change="removed"]')).toHaveCount(1);
  await expect(diff.getByRole("columnheader", { name: "Antes" })).toHaveCount(3);
  await expect(diff.getByRole("cell").nth(0)).toContainText("old.internal");
  await expect(diff.getByRole("cell").nth(1)).toContainText("new.internal");
  await expect(diff.getByText(/REDACTED/)).toBeVisible();
  await page.getByRole("button", { name: "Restaurar v1" }).click();
  const rollback = page.getByRole("dialog", { name: "Restaurar v1" });
  await expect(rollback.getByRole("region", { name: "Diff v2 → v1" })).toBeVisible();
  await expect(rollback.getByRole("cell").nth(0)).toContainText("new.internal");
  await expect(rollback.getByRole("cell").nth(1)).toContainText("old.internal");
  expect(rollbacks).toBe(0);
  await rollback.getByRole("button", { name: "Confirmar rollback" }).click();
  await expect(rollback).toBeHidden();
  expect(rollbacks).toBe(1);
  await expect(page.getByRole("status")).toContainText("v3");
});

test("rollback trata 409 de mesma configuração sem indicar sucesso", async ({ page }) => {
  await snapshots(page);
  await page.route("**/api/v1/environments/*/snapshots/1/rollback", (route) => route.fulfill({ status: 409, contentType: "application/problem+json", body: JSON.stringify({ title: "Conflict", status: 409, detail: "Target has the same configuration as current" }) }));
  await login(page);
  await page.getByRole("link", { name: "Publicações", exact: true }).click();
  await page.getByRole("button", { name: "Carregar mais" }).click();
  await page.getByRole("button", { name: "Restaurar v1" }).click();
  const modal = page.getByRole("dialog", { name: "Restaurar v1" });
  await expect(modal.getByRole("region", { name: "Diff v2 → v1" })).toBeVisible();
  await modal.getByRole("button", { name: "Confirmar rollback" }).click();
  await expect(modal.getByRole("alert")).toContainText("mesma configuração");
  await expect(modal).toBeVisible();
});

test("cluster: token único, copiar, comandos, nó com falha, rotação e exclusão confirmadas", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  let created = false;
  let rotated = 0;
  let deleted = 0;
  await page.route("**/api/v1/environments/*/clusters", async (route) => {
    if (route.request().method() === "POST") {
      expect(route.request().postDataJSON()).toEqual({ name: "edge-prod" });
      created = true;
      await route.fulfill({ status: 201, json: { ...cluster, registrationToken: "one-time-registration-token" } });
    } else await route.fulfill({ json: { items: created && deleted === 0 ? [cluster] : [] } });
  });
  await page.route(`**/api/v1/clusters/${clusterId}/rotate-token`, (route) => { rotated++; return route.fulfill({ json: { registrationToken: "rotated-once-token" } }); });
  await page.route(`**/api/v1/clusters/${clusterId}`, (route) => { deleted++; return route.fulfill({ status: 204 }); });
  await login(page);
  await page.getByRole("link", { name: "Clusters", exact: true }).click();
  await page.getByRole("button", { name: "Novo cluster" }).click();
  await page.getByRole("dialog").getByLabel("Nome").fill("edge-prod");
  await page.getByRole("dialog").getByRole("button", { name: "Criar" }).click();
  const token = page.getByRole("dialog", { name: "Token de registro" });
  await expect(token.getByLabel("Token de registro", { exact: true })).toHaveValue("one-time-registration-token");
  await expect(token.getByLabel("Comando Docker")).toHaveValue(/docker run.*GROMESH_REGISTRATION_TOKEN='one-time-registration-token'/s);
  await token.getByLabel("Contêiner do gateway").fill("edge-1");
  await token.getByLabel("URL do control plane").fill("https://cp.example");
  await expect(token.getByLabel("Comando Docker")).toHaveValue(/--network 'container:edge-1'.*--volumes-from 'edge-1':rw.*GROMESH_CP_URL='https:\/\/cp.example'/s);
  await expect(token.getByLabel("Opção Helm")).toHaveValue("--set agent.token='one-time-registration-token'");
  await token.getByRole("button", { name: "Copiar token" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("one-time-registration-token");
  await token.getByRole("button", { name: "Fechar", exact: true }).click();
  await expect(page.locator('input[value="one-time-registration-token"]')).toHaveCount(0);
  await expect(page.getByText("Invalid configuration: key=REDACTED", { exact: true })).toBeVisible();
  await expect(page.getByText("Degradado", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Rotacionar token" }).click();
  const rotate = page.getByRole("dialog", { name: "Rotacionar token" });
  expect(rotated).toBe(0);
  await rotate.getByRole("button", { name: "Rotacionar", exact: true }).click();
  await expect(token.getByLabel("Token de registro", { exact: true })).toHaveValue("rotated-once-token");
  await page.keyboard.press("Escape");
  await expect(token).toBeHidden();
  await page.getByRole("link", { name: "Publicações", exact: true }).click();
  await page.getByRole("link", { name: "Clusters", exact: true }).click();
  await expect(page.locator("input, textarea")).toHaveCount(0);
  await page.getByRole("button", { name: "Excluir", exact: true }).click();
  expect(deleted).toBe(0);
  await page.getByRole("dialog", { name: "Excluir cluster" }).getByRole("button", { name: "Excluir", exact: true }).click();
  await expect(page.getByText("Nenhum cluster ainda.")).toBeVisible();
  expect(rotated).toBe(1);
  expect(deleted).toBe(1);
});

test("editor pode restaurar publicações, mas não administrar clusters", async ({ page }) => {
  await snapshots(page);
  await page.route("**/api/v1/environments/*/clusters", (route) => route.fulfill({ json: { items: [cluster] } }));
  await login(page, "editor");
  await page.getByRole("link", { name: "Clusters", exact: true }).click();
  await expect(page.getByText("edge-prod", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Novo cluster|Rotacionar token|Excluir/ })).toHaveCount(0);
  await page.getByRole("link", { name: "Publicações", exact: true }).click();
  await page.getByRole("button", { name: "Carregar mais" }).click();
  await expect(page.getByRole("button", { name: "Restaurar v1" })).toBeVisible();
});

test("clusters atualizam a cada 10 s e pausam com a aba oculta", async ({ page }) => {
  await page.clock.install();
  let reads = 0;
  await page.route("**/api/v1/environments/*/clusters", (route) => { reads++; return route.fulfill({ json: { items: [cluster] } }); });
  await login(page);
  await page.getByRole("link", { name: "Clusters", exact: true }).click();
  await expect(page.getByText("edge-prod", { exact: true })).toBeVisible();
  await expect.poll(() => reads).toBe(1);
  await page.clock.runFor(10_100);
  await expect.poll(() => reads).toBe(2);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.runFor(30_000);
  expect(reads).toBe(2);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.runFor(10_100);
  await expect.poll(() => reads).toBe(3);
});

test("fechar durante criação descarta um token que chegar depois", async ({ page }) => {
  let release = () => {};
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/v1/environments/*/clusters", async (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ json: { items: [cluster] } });
    await pending;
    await route.fulfill({ status: 201, json: { ...cluster, registrationToken: "late-secret-token" } });
  });
  await login(page);
  await page.getByRole("link", { name: "Clusters", exact: true }).click();
  await page.getByRole("button", { name: "Novo cluster" }).click();
  await page.getByRole("dialog").getByLabel("Nome").fill("edge-prod");
  const request = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/clusters"));
  await page.getByRole("dialog").getByRole("button", { name: "Criar", exact: true }).click();
  await request;
  await page.keyboard.press("Escape");
  const response = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/clusters"));
  release();
  await response;
  await page.getByRole("button", { name: "Novo cluster" }).click();
  await expect(page.getByRole("dialog", { name: "Novo cluster" }).getByLabel("Nome")).toHaveValue("");
  await expect(page.getByLabel("Token de registro", { exact: true })).toHaveCount(0);
  await expect(page.locator('input[value="late-secret-token"]')).toHaveCount(0);
});

test("criação de cluster mapeia erro de nome e mantém o formulário aberto", async ({ page }) => {
  await page.route("**/api/v1/environments/*/clusters", (route) => route.request().method() === "POST"
    ? route.fulfill({ status: 422, contentType: "application/problem+json", body: JSON.stringify({ title: "Unprocessable Content", status: 422, errors: [{ path: "name", message: "must match pattern" }] }) })
    : route.fulfill({ json: { items: [] } }));
  await login(page);
  await page.getByRole("link", { name: "Clusters", exact: true }).click();
  await page.getByRole("button", { name: "Novo cluster" }).click();
  const modal = page.getByRole("dialog", { name: "Novo cluster" });
  await modal.getByLabel("Nome").fill("nome inválido");
  await modal.getByRole("button", { name: "Criar", exact: true }).click();
  await expect(modal.getByLabel("Nome")).toHaveAttribute("aria-invalid", "true");
  await expect(modal.getByRole("alert")).toHaveText("must match pattern");
});

test("viewer consulta histórico e diff sem ações de rollback", async ({ page }) => {
  await snapshots(page);
  await login(page, "viewer");
  await page.getByRole("link", { name: "Publicações", exact: true }).click();
  await expect(page.getByRole("link", { name: "v2", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Restaurar/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Comparar", exact: true }).click();
  await expect(page.getByRole("region", { name: "Diff v1 → v2" })).toBeVisible();
});

test("publicação pela barra superior atualiza o histórico já aberto", async ({ page }) => {
  await login(page);
  let published = false;
  await page.route(`**/api/v1/environments/${envId}`, (route) => route.fulfill({ json: { id: envId, name: "Produção", publishMode: "manual", currentVersion: published ? 3 : 2, hasUnpublishedChanges: !published } }));
  await page.route("**/api/v1/environments/*/publish-preview", (route) => route.fulfill({ json: { currentVersion: 2, draftHash: summary(3).hash, hasChanges: true, changes } }));
  await page.route("**/api/v1/environments/*/snapshots", (route) => {
    if (route.request().method() === "POST") {
      published = true;
      return route.fulfill({ status: 201, json: { ...summary(3), isCurrent: true } });
    }
    return route.fulfill({ json: { items: published ? [{ ...summary(3), isCurrent: true }, { ...summary(2), isCurrent: false }] : [summary(2)], nextCursor: null } });
  });
  await page.getByRole("link", { name: "Publicações", exact: true }).click();
  await expect(page.getByRole("link", { name: "v2", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Publicar", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "Publicar Produção" });
  await modal.getByRole("button", { name: "Publicar", exact: true }).click();
  await expect(modal).toBeHidden();
  await expect(page.getByRole("row").filter({ has: page.getByRole("link", { name: "v3", exact: true }) })).toContainText("Atual");
  await expect(page.getByRole("row").filter({ has: page.getByRole("link", { name: "v2", exact: true }) })).not.toContainText("Atual");
});
