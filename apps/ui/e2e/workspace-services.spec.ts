import type { Page } from "@playwright/test";
import type { Environment, Me } from "../src/api/client";
import type { Workspace, WorkspaceService } from "../src/api/client-v2";
import { expect, mockSession, test } from "./fixtures";
import { invalidBody, v2BodyErrors } from "./v2-bodies";

const W = "6d3e8b20-4c5e-4d6f-9a70-00000000000a";
const B = "6d3e8b20-4c5e-4d6f-9a70-00000000000b";
const S = "6d3e8b20-4c5e-4d6f-9a70-0000000000c1";
const timestamps = { createdAt: "2026-10-30T12:00:00Z", updatedAt: "2026-10-30T12:00:00Z" };
const user: Me = { id: S, name: "Ana Souza", email: "ana@gromesh.dev", role: "admin", active: true, ...timestamps };
const service: WorkspaceService = { id: S, workspaceId: W, upstreamId: null, name: "cobranca", protocol: "http", host: "billing.internal", port: 80, path: null, enabled: true, tags: [], ...timestamps };
const pageOf = (items: unknown[]) => ({ items, nextCursor: null });

async function setup(page: Page, options: {
  status?: Workspace["status"];
  publishMode?: Environment["publishMode"];
  paused?: Environment["autoPublishPausedReason"];
  hold?: "workspace" | "environment";
} = {}) {
  const workspace: Workspace = { id: W, key: W, name: "Cobrança", slug: "billing", status: options.status ?? "active", activeRelease: null };
  const environment: Environment = { id: W, name: workspace.name, publishMode: options.publishMode ?? "manual", currentVersion: 1, hasUnpublishedChanges: true, autoPublishPausedReason: options.paused ?? null, ...timestamps };
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const writes: { method: string; path: string; body: unknown }[] = [];
  let rejectEnabled = false;
  let items = [service];
  // Match root API URLs only: /src/api/client.ts is a Vite module, not an API request.
  // Unexpected API reads/writes cannot silently fall through to Prism.
  await page.route(/^https?:\/\/[^/]+\/api\/v[12]\//, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/v1/auth/csrf") return route.fulfill({ json: { csrfToken: "csrf" } });
    if (request.method() !== "GET") {
      const body: unknown = request.postData() ? request.postDataJSON() : null;
      writes.push({ method: request.method(), path, body });
      if (path === `/api/v2/workspaces/${W}/services` || path === `/api/v2/workspaces/${W}/services/${S}`) {
        if (request.method() === "DELETE") { items = []; return route.fulfill({ status: 204 }); }
        const errors = v2BodyErrors("services", body);
        if (errors.length) return route.fulfill(invalidBody(errors));
        if (rejectEnabled) return route.fulfill(invalidBody([{ path: "enabled", message: "must be boolean" }]));
        const saved = { ...service, ...(body as object) };
        items = [saved];
        return route.fulfill({ status: request.method() === "POST" ? 201 : 200, json: saved });
      }
      if (path === `/api/v1/environments/${W}/routes` && request.method() === "POST") return route.fulfill({ status: 201, json: { id: S, ...(body as object), ...timestamps } });
      return route.fulfill({ status: 500, json: { title: "Unexpected mutation", status: 500 } });
    }
    if (path === "/api/v1/environments") return route.fulfill({ json: pageOf([environment, { ...environment, id: B, name: "Recargas", publishMode: "manual" }]) });
    if (path === `/api/v1/environments/${W}`) {
      if (options.hold === "environment") await held;
      return route.fulfill({ json: environment });
    }
    if (path === `/api/v2/workspaces/${W}`) {
      if (options.hold === "workspace") await held;
      return route.fulfill({ json: workspace });
    }
    if (path === `/api/v1/environments/${B}`) return route.fulfill({ json: { ...environment, id: B, name: "Recargas", publishMode: "manual" } });
    if (path === `/api/v2/workspaces/${B}`) return route.fulfill({ json: { ...workspace, id: B, key: B, name: "Recargas", slug: "recargas", status: "active" } });
    if (path === `/api/v2/workspaces/${B}/services`) return route.fulfill({ json: pageOf([]) });
    if (path === `/api/v2/workspaces/${W}/services` || path === `/api/v1/environments/${W}/services`) return route.fulfill({ json: pageOf(items) });
    if (path === `/api/v2/workspaces/${W}/services/${S}`) return route.fulfill({ json: service });
    if (path.endsWith("/publish-preview")) return route.fulfill({ json: { currentVersion: 1, draftHash: `sha256:${"a".repeat(64)}`, hasChanges: true, changes: [] } });
    if (/\/(upstreams|routes|plugins|clusters|snapshots)$/.test(path)) return route.fulfill({ json: pageOf([]) });
    return route.fulfill({ status: 404, json: { title: "Unexpected query", status: 404 } });
  });
  await mockSession(page, user);
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(user.email);
  await page.getByLabel("Senha").fill("s3nha-de-teste");
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("heading", { name: "Services", exact: true })).toBeVisible();
  await expect(page.getByRole("table", { name: "Services", exact: true })).toContainText("cobranca");
  return { writes, release, rejectEnabled: () => { rejectEnabled = true; } };
}

for (const options of [
  { status: "archived", publishMode: "manual", reason: "arquivado" },
  { status: "active", publishMode: "auto", reason: "publicação automática" },
  { status: "active", publishMode: "auto", paused: "import", reason: "publicação automática" },
  { status: "archived", publishMode: "auto", reason: "arquivado" },
] as const) {
  test(`services are read-only: ${options.status}, ${options.publishMode}, ${"paused" in options ? options.paused : "unpaused"}`, async ({ page }) => {
    const fake = await setup(page, options);
    for (const detail of [false, true]) {
      if (detail) await page.getByRole("link", { name: "cobranca", exact: true }).click();
      await expect(page.getByRole("note", { name: "Estado do Workspace" })).toContainText(options.reason);
      await expect(page.getByText(/Somente leitura:/)).toBeVisible();
      await expect(page.getByRole("button", { name: /Novo service|^Editar$|Mais ações para/ })).toHaveCount(0);
      await expect(page.getByRole("region", { name: "Publicação", exact: true })).toBeVisible();
    }
    expect(fake.writes).toEqual([]);
  });
}

for (const hold of ["workspace", "environment"] as const) {
  test(`no write controls before ${hold} is known`, async ({ page }) => {
    const fake = await setup(page, { hold });
    try {
      await expect(page.getByText(/Somente leitura enquanto/)).toBeVisible();
      await expect(page.getByRole("button", { name: /Novo service|^Editar$|Mais ações para/ })).toHaveCount(0);
      expect(fake.writes).toEqual([]);
    } finally { fake.release(); }
    await expect(page.getByRole("button", { name: "Novo service" })).toBeVisible();
  });
}

for (const key of ["workspace", "environment"] as const) {
  for (const verdict of ["allow", "deny", "error"] as const) {
    test(`an open service form survives ${key} revalidation and obeys its ${verdict} verdict`, async ({ page }) => {
      const fake = await setup(page);
      const create = page.getByRole("button", { name: "Novo service" });
      await expect(create).toBeVisible();
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let started!: () => void;
      const requested = new Promise<void>((resolve) => { started = resolve; });
      const path = key === "workspace" ? `/api/v2/workspaces/${W}` : `/api/v1/environments/${W}`;
      await page.route(`**${path}`, async (route) => {
        started();
        await held;
        if (verdict === "error") return route.fulfill({ status: 403, json: { title: "Forbidden", status: 403 } });
        if (verdict === "allow") return route.fallback();
        return route.fulfill({ json: key === "workspace"
          ? { id: W, key: W, name: "Cobrança", slug: "billing", status: "archived", activeRelease: null }
          : { id: W, name: "Cobrança", publishMode: "auto", currentVersion: 1, hasUnpublishedChanges: true, ...timestamps } });
      });
      await create.click();
      await requested;
      const dialog = page.getByRole("dialog", { name: "Novo service" });
      try {
        await dialog.getByLabel("Nome", { exact: true }).fill("preservado");
        await dialog.getByLabel("Host", { exact: true }).fill("preservado.internal");
        await expect(dialog.getByLabel("Destino", { exact: true })).toHaveValue("dns");
        await expect(dialog.getByText(/Somente leitura enquanto/)).toBeVisible();
        await expect(dialog.getByRole("button", { name: "Salvar", exact: true })).toBeDisabled();
        // Even a submit event that bypasses the disabled button must not send a mutation.
        await dialog.locator("form").evaluate((form) => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
        expect(fake.writes).toEqual([]);
      } finally { release(); }
      if (verdict === "allow") {
        await expect(dialog.getByRole("button", { name: "Salvar", exact: true })).toBeEnabled();
        await expect(dialog.getByLabel("Nome", { exact: true })).toHaveValue("preservado");
        await dialog.getByRole("button", { name: "Salvar", exact: true }).click();
        await expect(dialog).toHaveCount(0);
        expect(fake.writes).toHaveLength(1);
        expect(fake.writes[0]).toMatchObject({ method: "POST", body: { name: "preservado" } });
      } else {
        await expect(dialog.getByText(verdict === "error" ? /não foi possível verificar/ : key === "workspace" ? /arquivado/ : /publicação automática/)).toBeVisible();
        await expect(dialog.getByRole("button", { name: "Salvar", exact: true })).toHaveCount(0);
        expect(fake.writes).toEqual([]);
      }
    });
  }

  test(`service deletion stays open and blocked until ${key} access is confirmed`, async ({ page }) => {
    const fake = await setup(page);
    // Also exercise the detail page's independently rendered dialog.
    if (key === "environment") await page.getByRole("link", { name: "cobranca", exact: true }).click();
    await page.getByRole("button", { name: "Mais ações para cobranca" }).click();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const requested = new Promise<void>((resolve) => { started = resolve; });
    const path = key === "workspace" ? `/api/v2/workspaces/${W}` : `/api/v1/environments/${W}`;
    await page.route(`**${path}`, async (route) => { started(); await held; return route.fallback(); });
    await page.getByRole("menuitem", { name: "Excluir", exact: true }).click();
    await requested;
    const dialog = page.getByRole("dialog", { name: "Excluir service" });
    const confirm = dialog.getByRole("button", { name: "Excluir", exact: true });
    try {
      await expect(dialog).toBeVisible();
      await expect(confirm).toBeDisabled();
      await expect(dialog.getByText(/Somente leitura enquanto/)).toBeVisible();
      await confirm.dispatchEvent("click");
      expect(fake.writes).toEqual([]);
    } finally { release(); }
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(dialog).toHaveCount(0);
    expect(fake.writes).toHaveLength(1);
    expect(fake.writes[0]).toMatchObject({ method: "DELETE", path: `/api/v2/workspaces/${W}/services/${S}` });
  });
}

test("manual publication keeps v2 create, edit and delete, without publishing a snapshot", async ({ page }) => {
  const fake = await setup(page);
  await page.getByRole("button", { name: "Novo service" }).click();
  let dialog = page.getByRole("dialog", { name: "Novo service" });
  await dialog.getByLabel("Nome", { exact: true }).fill("novo");
  await dialog.getByLabel("Host", { exact: true }).fill("new.internal");
  await dialog.getByRole("button", { name: "Salvar" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("link", { name: "novo", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Editar", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Editar novo" });
  await dialog.getByLabel("Nome", { exact: true }).fill("renomeado");
  await dialog.getByRole("button", { name: "Salvar" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("link", { name: "renomeado", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Mais ações para renomeado" }).click();
  await page.getByRole("menuitem", { name: "Excluir" }).click();
  dialog = page.getByRole("dialog", { name: "Excluir service" });
  await dialog.getByRole("button", { name: "Excluir", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(fake.writes.map(({ method, path }) => [method, path])).toEqual([
    ["POST", `/api/v2/workspaces/${W}/services`],
    ["PUT", `/api/v2/workspaces/${W}/services/${S}`],
    ["DELETE", `/api/v2/workspaces/${W}/services/${S}`],
  ]);
});

test("enabled validation appears beside the service checkbox", async ({ page }) => {
  const fake = await setup(page);
  fake.rejectEnabled();
  await page.getByRole("button", { name: "Editar", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Editar cobranca" });
  await dialog.getByRole("button", { name: "Salvar" }).click();
  const checkbox = dialog.getByRole("checkbox", { name: "Ativo", exact: true });
  await expect(checkbox).toHaveAttribute("aria-invalid", "true");
  const field = dialog.locator(".field").filter({ has: page.getByRole("checkbox", { name: "Ativo", exact: true }) });
  await expect(field.getByRole("alert")).toContainText("Ativo:");
  await expect(checkbox).toHaveAccessibleDescription(/Ativo:/);
  await expect(dialog).toBeVisible();
});

test("the v1 publication strip is available on Services, its detail and Routes", async ({ page }) => {
  const fake = await setup(page);
  for (const path of ["services", `services/${S}`, "routes"]) {
    await page.goto(`/e/${W}/${path}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("region", { name: "Publicação", exact: true })).toBeVisible();
    const strip = page.getByRole("region", { name: "Publicação", exact: true });
    await expect(strip.getByRole("link", { name: "Ver diff" })).toHaveAttribute("href", `/e/${W}/publish`);
    await expect(strip.getByRole("button", { name: "Publicar v2" })).toBeEnabled();
  }
  await page.goto(`/e/${W}/plugins`);
  await expect(page.getByRole("region", { name: "Publicação", exact: true })).toBeVisible();
  expect(fake.writes).toEqual([]);
});

test("the existing Routes form sends commas within paths unchanged", async ({ page }) => {
  const fake = await setup(page);
  await page.getByRole("link", { name: "Routes", exact: true }).click();
  await page.getByRole("button", { name: "Nova route" }).click();
  const dialog = page.getByRole("dialog", { name: "Nova route" });
  await dialog.getByLabel("Nome", { exact: true }).fill("items");
  await dialog.getByLabel("Paths", { exact: true }).fill("~/items/[0-9]{1,3}\n/a,/b");
  await dialog.getByRole("button", { name: "Salvar" }).click();
  await expect(dialog).toHaveCount(0);
  expect(fake.writes).toHaveLength(1);
  expect(fake.writes[0]).toMatchObject({ method: "POST", body: { paths: ["~/items/[0-9]{1,3}", "/a,/b"] } });
});

test("switching workspace closes a service form and discards its input", async ({ page }) => {
  const fake = await setup(page);
  await page.getByRole("button", { name: "Editar", exact: true }).click();
  await page.getByRole("dialog").getByLabel("Nome", { exact: true }).fill("nao-reaproveitar");
  // The selector sits behind the modal; force only the selection so the SPA stays mounted.
  await page.getByLabel("Workspace", { exact: true }).selectOption(B, { force: true });
  await expect(page).toHaveURL(`/e/${B}/services`);
  await expect(page.getByRole("heading", { name: "Services", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Novo service" }).click();
  await expect(page.getByRole("dialog").getByLabel("Nome", { exact: true })).toHaveValue("");
  expect(fake.writes).toEqual([]);
});
