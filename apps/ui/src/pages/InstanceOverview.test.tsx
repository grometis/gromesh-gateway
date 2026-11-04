import { act } from "react";
import type { Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../api/client-v2";
import { installTestDom, type TestNode } from "../test/dom";

const A: Workspace = { id: "7c1d2e3f-4a5b-4c6d-8e7f-00000000000a", key: "key-a", name: "Zeta", slug: "zeta", description: "Integrações do time", status: "active", activeRelease: 3 };
const B: Workspace = { id: "7c1d2e3f-4a5b-4c6d-8e7f-00000000000b", key: "key-b", name: "Árvore", slug: "arvore", status: "archived" };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
let root: Root | undefined;
let client: QueryClient;
afterEach(async () => { if (root) await act(() => root!.unmount()); root = undefined; client?.clear(); vi.unstubAllGlobals(); });

async function mount(read: (url: URL) => Response | Promise<Response>, policyStatus = 200) {
  vi.resetModules();
  const container = installTestDom();
  Object.assign(window.location, { origin: "https://ui.example.test" });
  const NativeRequest = Request;
  vi.stubGlobal("Request", class extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) { super(typeof input === "string" ? new URL(input, "https://ui.example.test") : input, init); }
  });
  const sent: Request[] = [];
  vi.stubGlobal("fetch", async (request: Request) => {
    sent.push(request);
    const url = new URL(request.url);
    if (url.pathname === "/api/v1/me") return Response.json({ id: A.id, name: "Ana", role: "viewer", environmentRoles: [] });
    if (url.pathname.endsWith("/auth/csrf")) return Response.json({ csrfToken: "csrf" });
    if (url.pathname === "/api/v1/environments") return Response.json({ items: [], nextCursor: null });
    if (url.pathname === "/api/v2/workspace-creation-policy") return Response.json({ stage: "dev", workspacesMode: "disabled", caller: { canCreate: false } }, { status: policyStatus });
    if (url.pathname === "/api/v2/workspaces") return read(url);
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  const [{ appRoutes }, { AuthProvider }, { createMemoryRouter, RouterProvider }, { createRoot }] = await Promise.all([
    import("../router"), import("../auth"), import("react-router"), import("react-dom/client"),
  ]);
  const router = createMemoryRouter(appRoutes, { initialEntries: ["/"] });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => { root!.render(<QueryClientProvider client={client}><AuthProvider><RouterProvider router={router} /></AuthProvider></QueryClientProvider>); await tick(); });
  const settle = async () => { await act(async () => { await tick(); }); };
  const waitText = async (text: string) => { await vi.waitFor(async () => { await settle(); expect(container.textContent).toContain(text); }); };
  const button = (text: string) => container.findAll((n) => n.tagName === "BUTTON" && n.textContent === text)[0]!;
  const click = async (node: TestNode) => { await act(async () => { node.dispatchEvent(Object.assign(new Event("click", { bubbles: true, cancelable: true }), { button: 0 })); await tick(); }); };
  const rows = () => container.findAll((n) => n.tagName === "TBODY")[0]?.childNodes ?? [];
  const counts = () => container.findAll((n) => n.tagName === "DD").map((n) => n.textContent);
  return { container, router, sent, settle, waitText, button, click, rows, counts };
}
const page = (items: Workspace[], nextCursor: string | null = null) => Response.json({ items, nextCursor });
const failure = (status: number) => Response.json({ title: "Unavailable", status }, { status });

describe("instance overview with real queries and authenticated routes", () => {
  it.each([{ items: [] }, { items: [A] }, { items: [A, B] }])("stays global for %j, without a contextual request or automatic selection", async ({ items }) => {
    const view = await mount(() => page(items));
    await view.waitText("Workspaces carregados");
    await view.waitText(items.length ? items[0]!.name : "Nenhum Workspace disponível para sua conta nesta instância");
    expect(view.router.state.location.pathname).toBe("/");
    expect(view.counts()).toEqual([String(items.length), String(items.filter((w) => w.status === "active").length), String(items.filter((w) => w.status === "archived").length)]);
    expect(view.sent.filter((r) => /\/(workspaces|environments)\//.test(new URL(r.url).pathname))).toEqual([]);
    const lists = view.sent.filter((r) => new URL(r.url).pathname === "/api/v2/workspaces");
    expect(lists).toHaveLength(1);
    expect(new URL(lists[0]!.url).searchParams.get("limit")).toBe("50");
    expect(view.sent.every((r) => r.method === "GET")).toBe(true);
  });
  it("shows metadata, partial labels and local search/order without requests", async () => {
    const view = await mount(() => page([A, B, { ...A, id: "other", name: "Beta", slug: "beta", activeRelease: null }], "next opaque"));
    await view.waitText("há mais Workspaces");
    expect(view.container.textContent).toContain("Ativos carregados");
    expect(view.container.textContent).toContain("Arquivados carregados");
    expect(view.container.textContent).toContain("Release selecionada 3");
    expect(view.container.textContent).toContain("Estado da Release não informado");
    expect(view.container.textContent).toContain("Nenhuma Release selecionada informada");
    expect(view.container.textContent).toContain("Arquivado · somente leitura");
    expect(view.container.textContent).toContain("Não disponível — requer contrato");
    expect(view.rows().map((r) => r.textContent)).toEqual([expect.stringContaining("Árvore"), expect.stringContaining("Beta"), expect.stringContaining("Zeta")]);
    const calls = view.sent.length;
    const select = view.container.findAll((n) => n.tagName === "SELECT")[0]!;
    await act(async () => { select.value = "name-desc"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(view.rows()[0]?.textContent).toContain("Zeta");
    await act(async () => { select.value = "status"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(view.rows().at(-1)?.textContent).toContain("Árvore");
    const input = view.container.findAll((n) => n.tagName === "INPUT")[0]!;
    await act(async () => { input.value = "ARVORE"; input.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(view.rows()).toHaveLength(1);
    expect(view.rows()[0]?.textContent).toContain("Árvore");
    await act(async () => { input.value = "inexistente"; input.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(view.container.textContent).toContain("Nenhum resultado nos Workspaces carregados");
    expect(view.container.textContent).not.toContain("Nenhum Workspace disponível para sua conta nesta instância");
    await view.click(view.button("Limpar busca"));
    expect(view.rows()).toHaveLength(3);
    expect(view.sent).toHaveLength(calls);
    expect(view.container.findAll((n) => n.tagName === "A" && n.textContent === "Abrir").map((n) => n.getAttribute("href"))).toContain(`/workspaces/${A.id}`);
  });
  it("keeps loading distinct from zero and empty", async () => {
    const view = await mount(() => new Promise<Response>(() => {}));
    await view.waitText("Carregando Workspaces…");
    expect(view.counts()).toEqual(["—", "—", "—"]);
    expect(view.container.textContent).not.toContain("Nenhum Workspace disponível");
  });
  it("loads only the requested next cursor, deduplicates IDs and keeps its latest metadata", async () => {
    const view = await mount((url) => url.searchParams.has("cursor") ? page([{ ...A, status: "archived" }, B]) : page([A], "next opaque"));
    await view.waitText("há mais Workspaces");
    await view.click(view.button("Carregar mais"));
    await view.waitText("2 carregados");
    expect(view.rows()).toHaveLength(2);
    expect(view.counts()).toEqual(["2", "0", "2"]);
    expect(view.container.textContent).toContain("Fim da lista consultada");
    expect(view.sent.filter((r) => new URL(r.url).pathname === "/api/v2/workspaces").map((r) => new URL(r.url).searchParams.get("cursor"))).toEqual([null, "next opaque"]);
  });
  it.each([502, 403])("distinguishes initial %s from empty and retries safely", async (status) => {
    let denied = true;
    const view = await mount(() => denied ? failure(status) : page([A]));
    await view.waitText(status === 403 ? "Sem permissão para listar Workspaces" : "Não foi possível carregar os Workspaces");
    expect(view.counts()).toEqual(["—", "—", "—"]);
    expect(view.container.textContent).not.toContain("Nenhum Workspace disponível");
    if (status === 403) expect(view.container.findAll((n) => n.tagName === "A" && n.getAttribute("href") === "/tokens").length).toBeGreaterThan(0);
    denied = false;
    await view.click(view.button("Tentar novamente"));
    await view.waitText(A.name);
    expect(view.counts()).toEqual(["1", "1", "0"]);
  });
  it("retains loaded data after next-page failure and retries only that cursor", async () => {
    let broken = true;
    const view = await mount((url) => !url.searchParams.has("cursor") ? page([A], "next") : broken ? failure(502) : page([B]));
    await view.waitText(A.name);
    await view.click(view.button("Carregar mais"));
    await view.waitText("Não foi possível carregar mais");
    expect(view.rows()).toHaveLength(1);
    expect(view.counts()).toEqual(["1", "1", "0"]);
    expect(view.container.textContent).toContain("Lista parcial");
    broken = false;
    await view.click(view.button("Tentar novamente"));
    await view.waitText("2 carregados");
    expect(view.rows()).toHaveLength(2);
    expect(view.sent.filter((r) => new URL(r.url).pathname === "/api/v2/workspaces").map((r) => new URL(r.url).searchParams.get("cursor"))).toEqual([null, "next", "next"]);
  });
  it("hides previously loaded data if the next page revokes list access", async () => {
    const view = await mount((url) => url.searchParams.has("cursor") ? failure(403) : page([A], "next"));
    await view.waitText(A.name);
    await view.click(view.button("Carregar mais"));
    await view.waitText("Sem permissão para listar Workspaces");
    expect(view.rows()).toHaveLength(0);
    expect(view.counts()).toEqual(["—", "—", "—"]);
    expect(view.container.textContent).not.toContain(A.name);
  });
  it("retains a focusable pagination action at the end without issuing another request", async () => {
    const view = await mount((url) => url.searchParams.has("cursor") ? page([B]) : page([A], "next"));
    await view.waitText(A.name);
    const more = view.button("Carregar mais");
    more.focus();
    await view.click(more);
    await view.waitText("2 carregados");
    expect(view.button("Carregar mais")).toBe(more);
    expect(more.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(more);
    const calls = view.sent.length;
    await view.click(more);
    expect(view.sent).toHaveLength(calls);
  });
  it("refresh starts a new cursor chain instead of mixing pages from different reads", async () => {
    let refreshed = false;
    const view = await mount((url) => refreshed ? page([B]) : url.searchParams.has("cursor") ? page([B]) : page([A], "next"));
    await view.waitText(A.name);
    await view.click(view.button("Carregar mais"));
    await view.waitText("2 carregados");
    refreshed = true;
    await view.click(view.button("Atualizar lista"));
    await view.waitText("1 carregados");
    expect(view.rows()).toHaveLength(1);
    expect(view.rows()[0]!.textContent).toContain(B.name);
    expect(view.container.textContent).not.toContain(A.name);
    expect(view.sent.filter((r) => new URL(r.url).pathname === "/api/v2/workspaces").map((r) => new URL(r.url).searchParams.get("cursor"))).toEqual([null, "next", null]);
  });
  it("removes stale counts and rows after a denied revalidation", async () => {
    let revoked = false;
    const view = await mount(() => revoked ? failure(403) : page([A]));
    await view.waitText(A.name);
    revoked = true;
    await act(async () => { await client.invalidateQueries({ queryKey: ["workspaces"] }); await tick(); });
    await view.waitText("Sem permissão para listar Workspaces");
    expect(view.counts()).toEqual(["—", "—", "—"]);
    expect(view.rows()).toHaveLength(0);
    expect(view.container.textContent).not.toContain(A.name);
  });
  it.each(["revalidation", "next page"])("discards denied caches after %s before navigating to management", async (source) => {
    let revoked = false;
    let management: Promise<Response> | undefined;
    const view = await mount(() => management ?? (revoked ? failure(403) : page([A], "next")));
    await view.waitText(A.name);
    client.setQueryData(["workspace", A.id], A);
    client.setQueryData(["workspaces", "other-list"], { pages: [{ items: [A], nextCursor: null }], pageParams: [""] });
    revoked = true;
    if (source === "next page") await view.click(view.button("Carregar mais"));
    else await act(async () => { await client.invalidateQueries({ queryKey: ["workspaces"], exact: true }); await tick(); });
    await view.waitText("Sem permissão para listar Workspaces nesta instância.");
    expect(client.getQueriesData({ queryKey: ["workspaces"] }).every(([, data]) => data === undefined)).toBe(true);
    expect(client.getQueriesData({ queryKey: ["workspace"] })).toEqual([]);
    let finish!: (response: Response) => void;
    management = new Promise<Response>((resolve) => { finish = resolve; });
    const manage = view.container.findAll((n) => n.tagName === "A" && n.textContent === "Gerenciar Workspaces")[0]!;
    await view.click(manage);
    await vi.waitFor(async () => { await view.settle(); expect(view.router.state.location.pathname).toBe("/workspaces"); });
    expect(view.container.textContent).not.toContain(A.name);
    expect(view.container.textContent).not.toContain(A.description);
    await act(async () => { finish(failure(403)); await tick(); });
    await vi.waitFor(async () => { await view.settle(); expect(view.container.findAll((n) => n.getAttribute("role") === "alert").length).toBeGreaterThan(0); });
    expect(view.container.textContent).not.toContain(A.name);
    expect(view.container.textContent).not.toContain(A.description);
    expect(client.getQueriesData({ queryKey: ["workspaces"] }).every(([, data]) => data === undefined)).toBe(true);
    expect(view.rows()).toHaveLength(0);
  });
  it.each([403, 502])("management hides old rows alongside a %s revalidation error", async (status) => {
    let revoked = false;
    const view = await mount(() => revoked ? failure(status) : page([A]));
    await view.waitText(A.name);
    await act(async () => { await view.router.navigate("/workspaces"); await tick(); });
    await view.waitText(A.description!);
    revoked = true;
    await act(async () => { await client.invalidateQueries({ queryKey: ["workspaces"] }); await tick(); });
    await vi.waitFor(async () => { await view.settle(); expect(view.container.findAll((n) => n.getAttribute("role") === "alert").length).toBeGreaterThan(0); });
    expect(view.rows()).toHaveLength(0);
    expect(view.container.textContent).not.toContain(A.description);
    if (status === 403) expect(client.getQueriesData({ queryKey: ["workspaces"] }).every(([, data]) => data === undefined)).toBe(true);
  });
  it("reloads only the first page on every return, then waits for explicit pagination", async () => {
    const view = await mount((url) => url.searchParams.has("cursor") ? page([B]) : page([A], "next"));
    await view.waitText(A.name);
    const cursors = () => view.sent.filter((r) => new URL(r.url).pathname === "/api/v2/workspaces").map((r) => new URL(r.url).searchParams.get("cursor"));
    for (let visit = 0; visit < 2; visit++) {
      await view.click(view.button("Carregar mais"));
      await view.waitText("2 carregados");
      await act(async () => { await view.router.navigate("/missing"); await tick(); });
      const beforeReturn = cursors().length;
      await act(async () => { await view.router.navigate(-1); await tick(); });
      await view.waitText("1 carregados");
      await vi.waitFor(async () => { await view.settle(); expect(client.isFetching({ queryKey: ["workspaces"] })).toBe(0); });
      expect(cursors().slice(beforeReturn)).toEqual([null]);
      expect(view.rows()).toHaveLength(1);
      expect(view.container.textContent).not.toContain(B.name);
    }
    expect(cursors()).toEqual([null, "next", null, "next", null]);
  });
  it("starts from the first page even when management has accumulated more pages", async () => {
    const view = await mount((url) => url.searchParams.has("cursor") ? page([B]) : page([A], "next"));
    await view.waitText(A.name);
    await view.click(view.container.findAll((n) => n.tagName === "A" && n.textContent === "Gerenciar Workspaces")[0]!);
    await view.waitText("Cada Workspace isola");
    await view.click(view.button("Carregar mais"));
    await view.waitText(B.name);
    await vi.waitFor(async () => { await view.settle(); expect(client.isFetching({ queryKey: ["workspaces"] })).toBe(0); });
    const beforeReturn = view.sent.length;
    await view.click(view.container.findAll((n) => n.tagName === "A" && n.textContent === "Abrir Visão geral da instância")[0]!);
    await view.waitText("1 carregados");
    await vi.waitFor(async () => { await view.settle(); expect(client.isFetching({ queryKey: ["workspaces"] })).toBe(0); });
    expect(view.sent.slice(beforeReturn).filter((r) => new URL(r.url).pathname === "/api/v2/workspaces").map((r) => new URL(r.url).searchParams.get("cursor"))).toEqual([null]);
    expect(view.rows()).toHaveLength(1);
    expect(view.container.textContent).not.toContain(B.name);
  });
  it("keeps an authorized list when instance identity is unavailable", async () => {
    const view = await mount(() => page([A]), 403);
    await view.waitText(A.name);
    await view.waitText("Instância não identificada");
    expect(view.counts()).toEqual(["1", "1", "0"]);
  });
  it("uses existing 401 session handling and clears cached workspaces", async () => {
    const view = await mount(() => failure(401));
    await view.waitText("Entrar");
    expect(view.router.state.location.pathname).toBe("/login");
    expect(client.getQueriesData({ queryKey: ["workspaces"] })).toEqual([]);
    expect(view.container.textContent).not.toContain("Workspaces carregados");
  });
  it("clears previously loaded workspaces on a 401 revalidation", async () => {
    let expired = false;
    const view = await mount(() => expired ? failure(401) : page([A]));
    await view.waitText(A.name);
    client.setQueryData(["workspace", A.id], A);
    expired = true;
    await act(async () => { await client.invalidateQueries({ queryKey: ["workspaces"] }); await tick(); });
    await view.waitText("Entrar");
    expect(view.router.state.location.pathname).toBe("/login");
    expect(client.getQueriesData({ queryKey: ["workspaces"] })).toEqual([]);
    expect(client.getQueriesData({ queryKey: ["workspace"] })).toEqual([]);
    expect(view.container.textContent).not.toContain(A.name);
  });
});
