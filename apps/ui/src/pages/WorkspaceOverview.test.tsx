import { act } from "react";
import type { Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installTestDom, type TestNode } from "../test/dom";

const A = "7c1d2e3f-4a5b-4c6d-8e7f-00000000000a";
const B = "7c1d2e3f-4a5b-4c6d-8e7f-00000000000b";
const resources = ["services", "routes", "consumers", "plugins", "upstreams", "certificates"];
const stamp = "2026-11-03T12:00:00Z";
const workspace = (id: string) => ({ id, key: id, name: `Workspace ${id === A ? "A" : "B"}`, slug: id === A ? "alpha" : "beta", description: "Gateway de pedidos", status: "active", activeRelease: null });
type Answer = (request: Request) => Response | Promise<Response>;
const problem = (status: number): Answer => () => Response.json({ title: "Failure", status }, { status });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
let root: Root | undefined;
let client: QueryClient;
afterEach(async () => { if (root) await act(() => root!.unmount()); root = undefined; client?.clear(); vi.unstubAllGlobals(); });

async function mount(options: { path?: string; role?: string; localRole?: string; answers?: Record<string, Answer> } = {}) {
  vi.resetModules();
  const container = installTestDom();
  Object.assign(window.location, { origin: "https://ui.example" });
  const NativeRequest = Request;
  vi.stubGlobal("Request", class extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) { super(typeof input === "string" ? new URL(input, "https://ui.example") : input, init); }
  });
  const sent: Request[] = [];
  const answers = options.answers ?? {};
  vi.stubGlobal("fetch", async (request: Request) => {
    sent.push(request);
    const path = new URL(request.url).pathname;
    if (answers[path]) return answers[path](request);
    if (path === "/api/v1/auth/csrf") return Response.json({ csrfToken: "csrf" });
    if (path === "/api/v1/me") return Response.json({ id: A, name: "Ana", email: "ana@example.test", role: options.role ?? "viewer", environmentRoles: options.localRole ? [{ environmentId: A, role: options.localRole }] : [], active: true, createdAt: stamp, updatedAt: stamp });
    if (path === "/api/v2/workspace-creation-policy") return Response.json({ stage: "dev", caller: {} });
    if (path === "/api/v2/workspaces") return Response.json({ items: [workspace(A), workspace(B)], nextCursor: null });
    if (path === "/api/v1/environments") return Response.json({ items: [], nextCursor: null });
    if (path === "/api/v1/tokens") return Response.json({ items: [], nextCursor: null });
    for (const id of [A, B]) {
      if (path === `/api/v2/workspaces/${id}`) return Response.json(workspace(id));
      if (path === `/api/v2/workspaces/${id}/variables` || path === `/api/v2/workspaces/${id}/releases`) return Response.json([]);
      if (resources.some(resource => path === `/api/v2/workspaces/${id}/${resource}`)) return Response.json({ items: Array.from({ length: id === A ? 1 : 2 }, () => ({ id: "resource" })), nextCursor: null });
    }
    throw new Error(`Unexpected request: ${request.method} ${path}`);
  });
  const [{ createMemoryRouter, RouterProvider }, { createRoot }, { appRoutes }, { AuthProvider }] = await Promise.all([
    import("react-router"), import("react-dom/client"), import("../router"), import("../auth"),
  ]);
  const router = createMemoryRouter(appRoutes, { initialEntries: [options.path ?? `/workspaces/${A}/overview`] });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => { root!.render(<QueryClientProvider client={client}><AuthProvider><RouterProvider router={router} /></AuthProvider></QueryClientProvider>); await tick(); });
  const settle = async () => { await act(async () => { await tick(); }); };
  const waitText = async (text: string) => { await vi.waitFor(async () => { await settle(); expect(container.textContent).toContain(text); }); };
  const navigate = async (path: string | number) => { await act(async () => { if (typeof path === "number") await router.navigate(path); else await router.navigate(path); await tick(); }); };
  const click = async (text: string) => {
    const button = container.findAll(node => node.tagName === "BUTTON" && node.textContent === text)[0];
    expect(button, text).toBeDefined();
    await act(async () => { button!.dispatchEvent(new Event("click", { bubbles: true })); await tick(); });
  };
  const card = (label: string): TestNode => container.findAll(node => node.getAttribute("aria-label") === `Indicador: ${label}`)[0]!;
  return { container, router, sent, answers, waitText, navigate, click, card, settle };
}

describe("Workspace overview with real components and controlled transport", () => {
  it("redirects only the v2 entry, preserves suffixes and uses replace", async () => {
    const view = await mount({ path: `/workspaces/${A}?x=1#y` });
    await view.waitText("Inventário no rascunho");
    expect(view.router.state.location).toMatchObject({ pathname: `/workspaces/${A}/overview`, search: "?x=1", hash: "#y" });
    expect(view.router.state.historyAction).toBe("REPLACE");
    await view.navigate("/tokens");
    await view.navigate(-1);
    await view.waitText("Inventário no rascunho");
    expect(view.router.state.location).toMatchObject({ pathname: `/workspaces/${A}/overview`, search: "?x=1", hash: "#y" });
  });

  it("loads only bounded v2 inventory, shares context and keeps links within the catalog", async () => {
    const view = await mount();
    await view.waitText("Inventário no rascunho");
    await vi.waitFor(async () => { await view.settle(); expect(view.card("Certificados").textContent).toContain("1"); });
    const contextual = view.sent.map(request => new URL(request.url)).filter(url => url.pathname.startsWith(`/api/v2/workspaces/${A}`));
    expect(contextual).toHaveLength(8);
    for (const resource of resources) {
      const reads = contextual.filter(url => url.pathname.endsWith(`/${resource}`));
      expect(reads.map(url => url.search)).toEqual(["?limit=200"]);
    }
    expect(view.sent.some(request => /\/api\/v1\/environments|analytics|audit|\/releases/.test(request.url))).toBe(false);
    for (const [label, section] of [["Serviços", "services"], ["Rotas", "routes"], ["Consumidores", "consumers"], ["Plugins", "plugins"], ["Upstreams", "upstreams"], ["Variáveis", "variables"]]) {
      expect(view.card(label!).findAll(node => node.tagName === "A")[0]?.getAttribute("href")).toBe(`/workspaces/${A}/${section}`);
      expect(view.card(label!).textContent).not.toContain("Página v2 em breve");
    }
    expect(view.card("Certificados").textContent).toContain("Página v2 em breve");
    expect(view.card("Certificados").findAll(node => node.tagName === "A")).toHaveLength(0);
    expect(view.container.textContent).toContain("Gateway de pedidos");
    expect(view.container.textContent).toContain("alpha");
  });

  it.each([[0, null, "0"], [1, null, "1"], [200, null, "200"], [200, "next", "200+"]] as const)("counts %s items with cursor %s without walking pages", async (count, cursor, value) => {
    const view = await mount({ answers: { [`/api/v2/workspaces/${A}/services`]: () => Response.json({ items: Array.from({ length: count }, () => ({ id: "x" })), nextCursor: cursor }) } });
    await vi.waitFor(async () => { await view.settle(); expect(view.card("Serviços")?.textContent).toContain(value); });
    expect(view.card("Serviços").textContent.includes("total não consultado")).toBe(cursor !== null);
    expect(view.sent.filter(request => new URL(request.url).pathname.endsWith("/services"))).toHaveLength(1);
  });

  it.each([[undefined, "Estado da Release não informado"], [null, "Nenhuma Release selecionada"], [7, "Release selecionada v7"]])("distinguishes selected release %s", async (activeRelease, text) => {
    const data = workspace(A);
    const view = await mount({ answers: { [`/api/v2/workspaces/${A}`]: () => Response.json({ ...data, activeRelease }) } });
    await view.waitText(text!);
    if (activeRelease === undefined) expect(view.container.textContent).not.toContain("Nenhuma Release selecionada");
  });

  it("keeps a pending block independent, reports failures without zero and retries only that block", async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { release = resolve; });
    const view = await mount({ answers: { [`/api/v2/workspaces/${A}/services`]: () => pending, [`/api/v2/workspaces/${A}/routes`]: problem(403) } });
    await view.waitText("Não foi possível consultar Rotas");
    expect(view.card("Serviços").getAttribute("aria-busy")).toBe("true");
    expect(view.card("Rotas").textContent).not.toContain("0");
    await act(async () => { release(Response.json({ items: [], nextCursor: null })); await tick(); });
    await vi.waitFor(async () => { await view.settle(); expect(view.card("Serviços").textContent).toContain("0"); });
    view.answers[`/api/v2/workspaces/${A}/routes`] = () => Response.json({ items: [], nextCursor: null });
    await view.click("Tentar novamente: Rotas");
    await vi.waitFor(async () => { await view.settle(); expect(view.card("Rotas").textContent).toContain("0"); });
    expect(view.sent.filter(request => new URL(request.url).pathname.endsWith("/routes"))).toHaveLength(2);
    expect(view.sent.filter(request => new URL(request.url).pathname.endsWith("/services"))).toHaveLength(1);
  });

  it("projects variable and certificate responses before caching and loads history only on demand", async () => {
    const releases = Array.from({ length: 7 }, (_, index) => ({ workspaceId: A, version: index + 1, createdAt: stamp, message: `Resumo ${index + 1}` }));
    const view = await mount({ answers: {
      [`/api/v2/workspaces/${A}/variables`]: () => Response.json([{ name: "TOKEN", value: "never-cache-this", secret: true }]),
      [`/api/v2/workspaces/${A}/certificates`]: () => Response.json({ items: [{ id: "cert", key: "never-cache-key" }], nextCursor: null }),
      [`/api/v2/workspaces/${A}/releases`]: () => Response.json(releases),
    } });
    await vi.waitFor(async () => { await view.settle(); expect(view.card("Variáveis")?.textContent).toContain("1"); });
    const cache = JSON.stringify(client.getQueryCache().getAll().map(query => query.state.data));
    expect(cache).not.toContain("never-cache");
    expect(cache).not.toContain("TOKEN");
    expect(view.sent.some(request => request.url.endsWith("/releases"))).toBe(false);
    await view.click("Consultar Releases recentes");
    await view.waitText("Resumo 7");
    expect(view.container.textContent).not.toContain("Resumo 1");
    expect(view.sent.filter(request => request.url.endsWith("/releases"))).toHaveLength(1);
  });

  it.each([{ role: "viewer", allowed: false }, { role: "editor", allowed: true }, { role: "admin", allowed: true }, { role: "viewer", localRole: "editor", allowed: true }, { role: "editor", localRole: "none", allowed: false }])("gates shortcuts by known workspace permissions: %s", async options => {
    const view = await mount(options);
    await view.waitText("Inventário no rascunho");
    const links = view.container.findAll(node => node.tagName === "A").map(node => node.textContent);
    for (const text of ["Novo serviço", "Nova rota", "Publicar release"]) expect(links.includes(text)).toBe(options.allowed);
  });

  it("shows archived data and attention without write shortcuts", async () => {
    const view = await mount({ role: "admin", answers: { [`/api/v2/workspaces/${A}`]: () => Response.json({ ...workspace(A), status: "archived" }) } });
    await view.waitText("Workspace arquivado");
    expect(view.container.textContent).not.toContain("Novo serviço");
    expect(view.container.textContent).toContain("Somente leitura");
    await vi.waitFor(async () => { await view.settle(); expect(view.card("Serviços")?.textContent).toContain("1"); });
  });

  it.each([401, 403, 404])("blocks content on Workspace HTTP %s before resource reads", async status => {
    const view = await mount({ answers: { [`/api/v2/workspaces/${A}`]: problem(status) } });
    await view.waitText(status === 401 ? "Entrar" : status === 403 ? "Você não tem permissão" : "Não encontrado ou indisponível");
    expect(view.container.textContent).not.toContain("Inventário no rascunho");
    expect(view.sent.some(request => resources.some(resource => new URL(request.url).pathname.endsWith(`/${resource}`)))).toBe(false);
    if (status === 401) expect(client.getQueryCache().getAll()).toHaveLength(0);
  });

  it("ignores late A responses after navigating to B and resets on-demand history", async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { release = resolve; });
    const view = await mount({ answers: { [`/api/v2/workspaces/${A}/services`]: () => pending } });
    await view.waitText("Inventário no rascunho");
    await view.click("Consultar Releases recentes");
    await view.navigate(`/workspaces/${B}/overview`);
    await view.waitText("Workspace B");
    await vi.waitFor(async () => { await view.settle(); expect(view.card("Serviços")?.textContent).toContain("2"); });
    await act(async () => { release(Response.json({ items: Array.from({ length: 99 }, () => ({})), nextCursor: null })); await tick(); });
    expect(view.card("Serviços").textContent).not.toContain("99");
    expect(view.container.findAll(node => node.tagName === "MAIN")[0]!.textContent).not.toContain("Workspace A");
    expect(view.sent.some(request => request.url.endsWith(`/${B}/releases`))).toBe(false);
    expect(view.container.findAll(node => node.tagName === "BUTTON" && node.textContent === "Consultar Releases recentes")).toHaveLength(1);
  });

  it("authorizes a deep link despite a denied Workspace list and rejects mismatched identity", async () => {
    const view = await mount({ answers: { "/api/v2/workspaces": problem(403) } });
    await view.waitText("Inventário no rascunho");
    await view.waitText("Sem permissão para listar Workspaces");
    await view.navigate("/tokens");
    view.answers[`/api/v2/workspaces/${B}`] = () => Response.json(workspace(A));
    await view.navigate(`/workspaces/${B}/overview`);
    await view.waitText("Não foi possível verificar o contexto");
    expect(view.container.textContent).not.toContain("Inventário no rascunho");
    expect(view.sent.some(request => request.url.includes(`/${B}/services`))).toBe(false);
  });

  it.each([403, 404])("removes an already mounted overview on context revalidation HTTP %s", async status => {
    const view = await mount({ role: "admin" });
    await view.waitText("Inventário no rascunho");
    await view.click("Consultar Releases recentes");
    view.answers[`/api/v2/workspaces/${A}`] = problem(status);
    await act(async () => { await client.invalidateQueries({ queryKey: ["workspace", A] }); await tick(); });
    await view.waitText(status === 403 ? "Você não tem permissão" : "Não encontrado ou indisponível");
    expect(view.container.textContent).not.toContain("Inventário no rascunho");
    expect(view.container.textContent).not.toContain("Novo serviço");
  });

  it("routes an inventory 401 through the existing login flow and clears all cached data", async () => {
    const view = await mount({ answers: { [`/api/v2/workspaces/${A}/variables`]: problem(401) } });
    await view.waitText("Entrar");
    expect(view.router.state.location.pathname).toBe("/login");
    expect(client.getQueryCache().getAll()).toHaveLength(0);
    expect(view.container.textContent).not.toContain("Workspace A");
  });

  it("keeps history errors local and retries on demand without refreshing inventory", async () => {
    const view = await mount({ answers: { [`/api/v2/workspaces/${A}/releases`]: problem(503) } });
    await view.waitText("Inventário no rascunho");
    await vi.waitFor(async () => { await view.settle(); expect(view.card("Variáveis")?.textContent).toContain("0"); });
    await view.click("Consultar Releases recentes");
    await view.waitText("Não foi possível consultar as Releases recentes");
    expect(view.container.textContent).not.toContain("Nenhuma Release publicada");
    view.answers[`/api/v2/workspaces/${A}/releases`] = () => Response.json([]);
    await view.click("Tentar novamente: Releases");
    await view.waitText("Nenhuma Release publicada");
    expect(view.sent.filter(request => request.url.endsWith("/releases"))).toHaveLength(2);
    expect(view.sent.filter(request => new URL(request.url).pathname.endsWith("/services"))).toHaveLength(1);
  });
});
