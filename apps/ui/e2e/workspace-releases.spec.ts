import { expect, test, type Page } from "@playwright/test";
import type { Environment, Me } from "../src/api/client";
import type { Release, Workspace } from "../src/api/client-v2";

const W = "6d3e8b20-4c5e-4d6f-9a70-00000000000a";
const B = "6d3e8b20-4c5e-4d6f-9a70-00000000000b";
const timestamps = { createdAt: "2026-10-30T12:00:00Z", updatedAt: "2026-10-30T12:00:00Z" };
const release: Release = {
  workspaceId: W, version: 1, contentDigest: `sha256:${"a".repeat(64)}`, origin: "local", contentOriginVersion: 1,
  contentFirstActivatedAt: null, originPromotionId: null, contentRevoked: false, createdBy: { name: "Ana" }, createdAt: timestamps.createdAt,
};

async function setup(page: Page, options: {
  role?: Me["role"]; status?: Workspace["status"]; publishMode?: Environment["publishMode"];
  hold?: "workspace" | "environment"; error?: { status: number; detail?: string; errors?: readonly { path: string; message: string }[] };
} = {}) {
  const writes: { method: string; path: string; body: unknown; csrf: string | undefined }[] = [];
  const unexpected: string[] = [];
  let items: Release[] = [];
  let activeRelease: number | null = null;
  let archived = options.status === "archived";
  let hold = options.hold;
  let releaseRead!: () => void;
  const held = new Promise<void>((resolve) => { releaseRead = resolve; });
  const environment = (id: string): Environment => ({ id, name: id === W ? "Cobrança" : "Recargas", publishMode: options.publishMode ?? "manual", currentVersion: 3, hasUnpublishedChanges: true, autoPublishPausedReason: null, ...timestamps });
  // Only root API URLs: never intercept Vite's /src/api modules. Every unexpected mutation is recorded and refused.
  await page.route(/^https?:\/\/[^/]+\/api\/v[12]\//, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET") {
      const body: unknown = request.postData() ? request.postDataJSON() : null;
      writes.push({ method: request.method(), path, body, csrf: request.headers()["x-csrf-token"] });
      if (request.method() === "POST" && path === `/api/v2/workspaces/${W}/releases`) {
        if (options.error) return route.fulfill({ status: options.error.status, json: { title: "Refused", ...options.error } });
        const saved: Release = { ...release, version: items.length + 1, message: (body as { message?: string }).message };
        items = [saved, ...items]; activeRelease = saved.version;
        return route.fulfill({ status: 201, json: saved });
      }
      unexpected.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 500, json: { title: "Unexpected mutation", status: 500 } });
    }
    if (path === "/api/v1/me") return route.fulfill({ json: { id: W, name: "Ana", email: "ana@gromesh.dev", role: options.role ?? "editor", active: true, ...timestamps } satisfies Me });
    if (path === "/api/v1/auth/csrf") return route.fulfill({ json: { csrfToken: "session-csrf" } });
    if (path === "/api/v1/environments") return route.fulfill({ json: { items: [environment(W), environment(B)], nextCursor: null } });
    for (const id of [W, B]) {
      if (path === `/api/v1/environments/${id}`) {
        if (hold === "environment") await held;
        return route.fulfill({ json: environment(id) });
      }
      if (path === `/api/v2/workspaces/${id}`) {
        if (hold === "workspace") await held;
        return route.fulfill({ json: { id, key: id, name: environment(id).name, slug: id === W ? "billing" : "recargas", status: archived ? "archived" : "active", activeRelease: id === W ? activeRelease : null } satisfies Workspace });
      }
      if (path === `/api/v2/workspaces/${id}/releases`) return route.fulfill({ json: id === W ? items : [] });
      if (path === `/api/v2/workspaces/${id}/services`) return route.fulfill({ json: { items: [], nextCursor: null } });
      if (path === `/api/v1/environments/${id}/publish-preview`) return route.fulfill({ json: { currentVersion: 3, draftHash: `sha256:${"b".repeat(64)}`, hasChanges: true, changes: [] } });
      if (path === `/api/v1/environments/${id}/clusters`) return route.fulfill({ json: { items: [], nextCursor: null } });
    }
    unexpected.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 404, json: { title: "Unexpected query", status: 404 } });
  });
  await page.goto(`/e/${W}/releases`);
  await expect(page.getByRole("heading", { name: "Releases", exact: true })).toBeVisible();
  return { writes, unexpected, releaseRead, archive: () => { archived = true; }, holdReads: (kind: typeof hold) => { hold = kind; } };
}

test.afterEach(async ({ page }) => {
  await expect(page.getByRole("region", { name: "Publicação", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Publicar v\d/ })).toHaveCount(0);
  await expect(page.locator(`a[href="/e/${W}/publish"], a[href="/e/${B}/publish"]`)).toHaveCount(0);
});

test("publishes an immutable release through v2 without deploying or calling v1 snapshots", async ({ page }) => {
  const fake = await setup(page);
  await expect(page.getByRole("link", { name: "Releases", exact: true })).toHaveAttribute("href", `/e/${W}/releases`);
  await expect(page.getByRole("region", { name: "Deployment", exact: true })).toContainText("Deployment de Workspaces indisponível nesta fase");
  await expect(page.getByRole("region", { name: "Convergência", exact: true })).toContainText("indisponível");
  await expect(page.getByRole("region", { name: "Publicação", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Publicar release", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Publicar release" });
  await expect(dialog).toContainText("Publicar não implanta");
  await dialog.getByLabel("Resumo (opcional)").fill("Serviços de cobrança");
  await dialog.getByRole("button", { name: "Confirmar publicação" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Release v1 publicada. Nenhum deployment foi criado.", { exact: true })).toBeVisible();
  const list = page.getByRole("table", { name: "Releases publicadas" });
  await expect(list).toContainText("v1 · ativa");
  await expect(list).toContainText("Ana");
  await expect(list).toContainText("Serviços de cobrança");
  await expect(list).toContainText(release.contentDigest);
  await expect(list.getByRole("button")).toHaveCount(0);
  expect(fake.writes).toEqual([{ method: "POST", path: `/api/v2/workspaces/${W}/releases`, body: { message: "Serviços de cobrança", expectedActiveVersion: null }, csrf: "session-csrf" }]);
  expect(fake.unexpected).toEqual([]);
});

for (const error of [
  { status: 403, detail: "Requires release.publish", text: "release.publish" },
  { status: 409, detail: "Nothing to publish: the draft equals the active release", text: "Sem alterações para publicar" },
  { status: 409, detail: "Deployment revision 3 holds the deployment lease", text: "Um deployment está em andamento" },
  { status: 409, detail: "Active release is 2, expected 1", text: "A release ativa mudou" },
  { status: 422, errors: [{ path: "services.0.host", message: "variable has no value" }], text: "services.0.host: A variável está sem valor" },
] as const) {
  test(`publish refusal in Portuguese: ${error.status} ${error.text}`, async ({ page }) => {
    const fake = await setup(page, { error });
    await page.getByRole("button", { name: "Publicar release", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Confirmar publicação" }).click();
    await expect(dialog.getByRole("alert")).toContainText(error.text);
    await expect(page.getByRole("table", { name: "Releases publicadas" })).toHaveCount(0);
    expect(fake.writes).toHaveLength(1);
    expect(fake.unexpected).toEqual([]);
  });
}

test("auto mode permits the inert v2 release", async ({ page }) => {
  const fake = await setup(page, { publishMode: "auto" });
  await expect(page.getByText(/Publicar uma release v2 é permitido/)).toBeVisible();
  await page.getByRole("button", { name: "Publicar release", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirmar publicação" }).click();
  await expect(page.getByRole("table", { name: "Releases publicadas" })).toBeVisible();
  expect(fake.writes.map((r) => r.path)).toEqual([`/api/v2/workspaces/${W}/releases`]);
  expect(fake.unexpected).toEqual([]);
});

for (const status of [403, 201] as const) {
  test(`legacy viewer can submit a release and the server decides (${status})`, async ({ page }) => {
    const fake = await setup(page, { role: "viewer", ...(status === 403 ? { error: { status, detail: "Requires release.publish" } } : {}) });
    await page.getByRole("button", { name: "Publicar release", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Publicar release" });
    await dialog.getByLabel("Resumo (opcional)").fill("Publicação por binding v2");
    await dialog.getByRole("button", { name: "Confirmar publicação" }).click();
    if (status === 403) {
      await expect(dialog.getByRole("alert")).toContainText("Você não tem permissão para publicar (release.publish)");
      await expect(page.getByText("Nenhuma release publicada neste Workspace.", { exact: true })).toBeVisible();
      await expect(page.getByText("Nenhuma release ativa informada.", { exact: true })).toBeVisible();
      await expect(page.getByText(/Release v\d+ publicada/)).toHaveCount(0);
      await dialog.getByRole("button", { name: "Cancelar", exact: true }).click();
    } else {
      await expect(dialog).toHaveCount(0);
      await expect(page.getByRole("table", { name: "Releases publicadas" })).toContainText("Publicação por binding v2");
      await expect(page.getByText("Release v1 publicada. Nenhum deployment foi criado.", { exact: true })).toBeVisible();
    }
    await expect(page.getByText("Há alterações pendentes no rascunho (indicador v1).", { exact: true })).toBeVisible();
    expect(fake.writes).toEqual([{ method: "POST", path: `/api/v2/workspaces/${W}/releases`, body: { message: "Publicação por binding v2", expectedActiveVersion: null }, csrf: "session-csrf" }]);
    expect(fake.unexpected).toEqual([]);
  });
}

test("v1 publication stays available on Services and disappears again on Releases", async ({ page }) => {
  const fake = await setup(page);
  await page.getByRole("link", { name: "Services", exact: true }).click();
  await expect(page.getByRole("region", { name: "Publicação", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Publicar v4" })).toBeEnabled();
  await expect(page.getByRole("link", { name: "Ver diff", exact: true })).toHaveAttribute("href", `/e/${W}/publish`);
  await page.getByRole("link", { name: "Releases", exact: true }).click();
  await expect(page).toHaveURL(`/e/${W}/releases`);
  await expect(page.getByRole("button", { name: "Publicar release", exact: true })).toBeVisible();
  expect(fake.writes).toEqual([]);
  expect(fake.unexpected).toEqual([]);
});

for (const options of [{ status: "archived" }, { hold: "workspace" }, { hold: "environment" }] as const) {
  test(`read only when ${JSON.stringify(options)}`, async ({ page }) => {
    const fake = await setup(page, options);
    try {
      if ("status" in options) await expect(page.getByText("Somente leitura: este Workspace está arquivado. Não é possível publicar releases.", { exact: true })).toBeVisible();
      if ("hold" in options) await expect(page.getByText(/Somente leitura enquanto/)).toBeVisible();
      await expect(page.getByRole("button", { name: "Publicar release", exact: true })).toHaveCount(0);
      expect(fake.writes).toEqual([]);
    } finally { fake.releaseRead(); }
  });
}

test("confirmation revalidates access and blocks publication if archived meanwhile", async ({ page }) => {
  const fake = await setup(page);
  await expect(page.getByRole("button", { name: "Publicar release", exact: true })).toBeVisible();
  fake.holdReads("workspace");
  await page.getByRole("button", { name: "Publicar release", exact: true }).click();
  const dialog = page.getByRole("dialog");
  try {
    await expect(dialog.getByRole("button", { name: "Confirmar publicação" })).toBeDisabled();
    fake.archive();
  } finally { fake.releaseRead(); }
  await expect(dialog.getByRole("status")).toContainText("arquivado");
  await expect(dialog.getByRole("button", { name: "Confirmar publicação" })).toBeDisabled();
  expect(fake.writes).toEqual([]);
});

test("switching workspace discards confirmation, input and previous release data", async ({ page }) => {
  const fake = await setup(page);
  await page.getByRole("button", { name: "Publicar release", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirmar publicação" }).click();
  await expect(page.getByRole("table", { name: "Releases publicadas" })).toContainText(release.contentDigest);
  await page.getByRole("button", { name: "Publicar release", exact: true }).click();
  await page.getByRole("dialog").getByLabel("Resumo (opcional)").fill("Não reaproveitar");
  await page.getByLabel("Workspace", { exact: true }).selectOption(B, { force: true });
  await expect(page).toHaveURL(`/e/${B}/releases`);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("Nenhuma release publicada neste Workspace.")).toBeVisible();
  await expect(page.getByText("Release v1 publicada. Nenhum deployment foi criado.", { exact: true })).toHaveCount(0);
  await expect(page.getByText(release.contentDigest, { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Publicar release", exact: true }).click();
  await expect(page.getByRole("dialog").getByLabel("Resumo (opcional)")).toHaveValue("");
  expect(fake.writes.map((r) => r.path)).toEqual([`/api/v2/workspaces/${W}/releases`]);
  expect(fake.unexpected).toEqual([]);
});
