import { expect, test, type Page } from "@playwright/test";
import type { Me } from "../src/api/client";
import type { WorkspaceVariable, WorkspaceVariableDeclaration } from "../src/api/client-v2";
import { TEST_PRIVATE_KEY } from "../src/test/pem";

const W = "6d3e8b20-4c5e-4d6f-9a70-00000000000a";
const B = "6d3e8b20-4c5e-4d6f-9a70-00000000000b";
const timestamps = { createdAt: "2026-10-30T12:00:00Z", updatedAt: "2026-10-30T12:00:00Z" };
const secret: WorkspaceVariable = { name: "API_KEY", type: "credential", secret: true, required: true, hasValue: false, value: null };

async function setup(page: Page, options: {
  stage?: "dev" | "hml" | "prd" | null; role?: Me["role"];
  status?: "active" | "archived"; publishMode?: "manual" | "auto"; type?: WorkspaceVariable["type"];
  hold?: "workspace" | "environment" | "policy";
} = {}) {
  let items = [{ ...secret, type: options.type ?? secret.type }];
  let rejection: { status: number; errors?: { path: string; message: string }[]; detail?: string } | null = null;
  const writes: { method: string; path: string; body: unknown }[] = [];
  const unexpected: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  // Only APIs at the origin root are mocked. Vite's /src/** modules always reach Vite.
  await page.route(/^https?:\/\/[^/]+\/api\/v[12]\//, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET") {
      const body: unknown = request.postData() ? request.postDataJSON() : null;
      writes.push({ method: request.method(), path, body });
      if (rejection) return route.fulfill({ status: rejection.status, contentType: "application/problem+json", json: { title: "Problem", ...rejection } });
      if (path.startsWith(`/api/v2/workspaces/${W}/variables/`)) {
        if (path.endsWith("/value") && request.method() === "PUT") {
          const name = path.split("/").at(-2);
          items = items.map((v) => v.name === name ? { ...v, hasValue: true, value: "REDACTED" } : v);
          return route.fulfill({ status: 204 });
        }
        const name = path.split("/").at(-1)!;
        if (request.method() === "DELETE") { items = items.filter((v) => v.name !== name); return route.fulfill({ status: 204 }); }
        if (request.method() === "PUT") {
          const saved: WorkspaceVariable = { ...secret, ...(body as WorkspaceVariableDeclaration), name, hasValue: false };
          items = [...items.filter((v) => v.name !== name), saved];
          return route.fulfill({ json: saved });
        }
      }
    } else {
      if (path === "/api/v1/me") return route.fulfill({ json: { id: W, name: "Ana", email: "ana@gromesh.dev", role: options.role ?? "admin", active: true, ...timestamps } });
      if (path === "/api/v1/auth/csrf") return route.fulfill({ json: { csrfToken: "csrf" } });
      if (path === "/api/v2/workspace-creation-policy") {
        if (options.hold === "policy") await held;
        return route.fulfill({ json: { mode: "autonomous", creatorBecomesAdmin: true, updatedAt: null, updatedBy: null, workspacesMode: "lab", stage: options.stage === undefined ? "dev" : options.stage, caller: { canCreate: true, canRequest: false, canDecide: false } } });
      }
      const id = path.includes(B) ? B : W;
      const env = { id, name: id === W ? "Pagamentos" : "Recargas", publishMode: options.publishMode ?? "manual", currentVersion: 0, hasUnpublishedChanges: true, ...timestamps };
      if (path === "/api/v1/environments") return route.fulfill({ json: { items: [env, { ...env, id: B, name: "Recargas" }], nextCursor: null } });
      if (path === `/api/v1/environments/${id}`) {
        if (options.hold === "environment") await held;
        return route.fulfill({ json: env });
      }
      if (path === `/api/v1/environments/${id}/publish-preview`) return route.fulfill({ json: { currentVersion: 0, draftHash: `sha256:${"a".repeat(64)}`, hasChanges: true, changes: [] } });
      if (path === `/api/v1/environments/${id}/clusters`) return route.fulfill({ json: { items: [], nextCursor: null } });
      if (path === `/api/v2/workspaces/${id}`) {
        if (options.hold === "workspace") await held;
        return route.fulfill({ json: { id, key: id, name: env.name, slug: id === W ? "pagamentos" : "recargas", status: options.status ?? "active", activeRelease: null } });
      }
      if (path === `/api/v2/workspaces/${id}/variables`) return route.fulfill({ json: id === W ? items : [] });
    }
    unexpected.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 500, json: { title: "Unexpected API request", status: 500 } });
  });
  await page.goto(`/e/${W}/variables`);
  await expect(page.getByRole("heading", { name: "Variáveis", exact: true })).toBeVisible();
  await expect(page.getByRole("table", { name: "Variáveis", exact: true })).toContainText("API_KEY");
  if (!options.hold) {
    await expect(page.getByRole("note", { name: "Estado do Workspace" })).toContainText(options.status === "archived" ? "arquivado" : options.publishMode === "auto" ? "publicação automática" : "rascunho");
  }
  return { writes, unexpected, release, reject: (value: typeof rejection) => { rejection = value; } };
}

test("declarations use v2 PUT and DELETE without publishing or deploying, alongside the v1 publication strip", async ({ page }) => {
  const fake = await setup(page);
  await expect(page.getByRole("link", { name: "Variáveis", exact: true })).toBeVisible();
  await expect(page.getByText("Obrigatória sem valor", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Publicação", exact: true })).toBeVisible();
  expect(fake.writes).toEqual([]);
  await page.getByRole("button", { name: "Declarar variável", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Nome", { exact: true }).fill("API_HOST");
  await dialog.getByLabel("Tipo", { exact: true }).selectOption("host");
  await dialog.getByLabel("Obrigatória", { exact: true }).check();
  await dialog.getByRole("button", { name: "Salvar", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const row = page.getByRole("row").filter({ hasText: "API_HOST" });
  await row.getByRole("button", { name: "Editar declaração" }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Nome", { exact: true })).toBeDisabled();
  await dialog.getByLabel("Obrigatória", { exact: true }).uncheck();
  await dialog.getByRole("button", { name: "Salvar", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await row.getByRole("button", { name: "Excluir", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Excluir variável", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(fake.writes).toEqual([
    { method: "PUT", path: `/api/v2/workspaces/${W}/variables/API_HOST`, body: { type: "host", secret: false, required: true } },
    { method: "PUT", path: `/api/v2/workspaces/${W}/variables/API_HOST`, body: { type: "host", secret: false, required: false } },
    { method: "DELETE", path: `/api/v2/workspaces/${W}/variables/API_HOST`, body: null },
  ]);
  expect(fake.unexpected).toEqual([]);
});

test("DEV saves only an instance value and never renders or pre-fills a secret", async ({ page }) => {
  const fake = await setup(page);
  await page.getByRole("button", { name: "Definir valor", exact: true }).click();
  let dialog = page.getByRole("dialog");
  const input = dialog.getByLabel("Valor", { exact: true });
  await expect(input).toHaveAttribute("type", "password");
  await expect(input).toHaveAttribute("autocomplete", "off");
  await input.fill("secret-for-test");
  await dialog.getByRole("button", { name: "Salvar valor" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("table")).toContainText("REDACTED · definido");
  await expect(page.locator("body")).not.toContainText("secret-for-test");
  await expect(page.locator('input[value="secret-for-test"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Definir valor", exact: true }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Valor", { exact: true })).toHaveValue("");
  expect(fake.writes).toEqual([{ method: "PUT", path: `/api/v2/workspaces/${W}/variables/API_KEY/value`, body: { value: "secret-for-test" } }]);
  expect(fake.unexpected).toEqual([]);
});

test("pasting a PEM key into the password field preserves newlines in the request", async ({ page }) => {
  const fake = await setup(page, { type: "privateKey" });
  await page.getByRole("button", { name: "Definir valor" }).click();
  const dialog = page.getByRole("dialog");
  const input = dialog.getByLabel("Valor", { exact: true });
  await expect(input).toHaveAttribute("type", "password");
  await input.evaluate((element, pem) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", pem);
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
  }, TEST_PRIVATE_KEY);
  await expect(dialog).not.toContainText("MIGHAgEA");
  await dialog.getByRole("button", { name: "Salvar valor" }).click();
  await expect(dialog).toHaveCount(0);
  expect(fake.writes).toEqual([{ method: "PUT", path: `/api/v2/workspaces/${W}/variables/API_KEY/value`, body: { value: TEST_PRIVATE_KEY } }]);
  await page.getByRole("button", { name: "Definir valor" }).click();
  await expect(page.getByRole("dialog").getByLabel("Valor", { exact: true })).toHaveValue("");
});

for (const stage of ["hml", "prd", null] as const) {
  test(`values unavailable outside DEV: ${stage}`, async ({ page }) => {
    const fake = await setup(page, { stage });
    await expect(page.getByRole("button", { name: "Definir valor" })).toBeDisabled();
    await expect(page.getByText(/Definir valores só está disponível em DEV/)).toBeVisible();
    expect(fake.writes).toEqual([]);
    expect(fake.unexpected).toEqual([]);
  });
}
for (const role of ["viewer", "editor"] as const) {
  test(`values hidden without known values.write: ${role}`, async ({ page }) => {
    const fake = await setup(page, { role });
    await expect(page.getByRole("button", { name: "Definir valor" })).toHaveCount(0);
    await expect(page.getByText(/Definir valores exige a permissão values.write/)).toBeVisible();
    expect(fake.writes).toEqual([]);
  });
}
for (const options of [{ status: "archived" }, { publishMode: "auto" }] as const) {
  test(`variables read-only: ${JSON.stringify(options)}`, async ({ page }) => {
    const fake = await setup(page, options);
    await expect(page.getByRole("button", { name: /Declarar variável|Editar declaração|Excluir|Definir valor/ })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Publicação", exact: true })).toBeVisible();
    expect(fake.writes).toEqual([]);
    expect(fake.unexpected).toEqual([]);
  });
}
for (const hold of ["workspace", "environment", "policy"] as const) {
  test(`write actions wait for ${hold}`, async ({ page }) => {
    const fake = await setup(page, { hold });
    try {
      if (hold === "policy") await expect(page.getByRole("button", { name: "Definir valor" })).toBeDisabled();
      else await expect(page.getByRole("button", { name: /Declarar variável|Editar declaração|Excluir|Definir valor/ })).toHaveCount(0);
      expect(fake.writes).toEqual([]);
    } finally { fake.release(); }
    await expect(page.getByRole("button", { name: "Definir valor" })).toBeEnabled();
  });
}

test("declaration validation stays beside each field and checkbox", async ({ page }) => {
  const fake = await setup(page);
  fake.reject({ status: 422, errors: [
    { path: "secret", message: "must be equal to constant" }, { path: "required", message: "must be boolean" },
    { path: "validation.pattern", message: "is not a valid regular expression" },
  ] });
  await page.getByRole("button", { name: "Editar declaração" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Salvar", exact: true }).click();
  for (const label of ["Segredo", "Obrigatória", "Padrão"]) await expect(dialog.getByLabel(label, { exact: true })).toHaveAttribute("aria-invalid", "true");
  await expect(dialog.getByLabel("Segredo", { exact: true })).toHaveAccessibleDescription(/devem ser secretas/);
  await expect(dialog).not.toContainText("must be");
});

test("VarRef prevents deletion with a Portuguese explanation", async ({ page }) => {
  const fake = await setup(page);
  fake.reject({ status: 409, detail: "Variable API_KEY is referenced by the draft: services.billing" });
  await page.getByRole("button", { name: "Excluir", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Excluir variável", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("referenciada por VarRef");
  await expect(dialog).not.toContainText("referenced by the draft");
});

for (const status of [403, 404, 422, 500]) {
  test(`value error ${status} is sanitized and the password is cleared`, async ({ page }) => {
    const fake = await setup(page);
    fake.reject({ status, detail: "secret-for-test", errors: [{ path: "value", message: "secret-for-test" }] });
    await page.getByRole("button", { name: "Definir valor" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Valor", { exact: true }).fill("secret-for-test");
    await dialog.getByRole("button", { name: "Salvar valor" }).click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(dialog.getByLabel("Valor", { exact: true })).toHaveValue("");
    await expect(dialog).not.toContainText("secret-for-test");
    if (status === 422) await expect(dialog.getByLabel("Valor", { exact: true })).toHaveAttribute("aria-invalid", "true");
  });
}
for (const action of ["Declarar variável", "Editar declaração", "Definir valor", "Excluir"]) {
  test(`switching Workspace discards the ${action} form`, async ({ page }) => {
    const fake = await setup(page);
    await page.getByRole("button", { name: action, exact: true }).click();
    if (action === "Definir valor") await page.getByRole("dialog").getByLabel("Valor", { exact: true }).fill("discard-test-secret");
    if (action === "Declarar variável") await page.getByRole("dialog").getByLabel("Nome", { exact: true }).fill("DISCARD_NAME");
    await page.getByLabel("Workspace", { exact: true }).selectOption(B, { force: true });
    await expect(page).toHaveURL(`/e/${B}/variables`);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText("Nenhuma variável declarada.", { exact: true })).toBeVisible();
    await expect(page.locator("body")).not.toContainText("API_KEY");
    await page.getByLabel("Workspace", { exact: true }).selectOption(W);
    await page.getByRole("button", { name: action, exact: true }).click();
    if (action === "Definir valor") await expect(page.getByRole("dialog").getByLabel("Valor", { exact: true })).toHaveValue("");
    if (action === "Declarar variável") await expect(page.getByRole("dialog").getByLabel("Nome", { exact: true })).toHaveValue("");
    expect(fake.writes).toEqual([]);
    expect(fake.unexpected).toEqual([]);
  });
}
