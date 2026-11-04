import { act } from "react";
import type { Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installTestDom } from "../test/dom";

const A = "7c1d2e3f-4a5b-4c6d-8e7f-00000000000a";
const B = "7c1d2e3f-4a5b-4c6d-8e7f-00000000000b";
const C = "7c1d2e3f-4a5b-4c6d-8e7f-00000000000c";
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
let root: Root | undefined;
let client: QueryClient;
afterEach(async () => { if (root) await act(() => root!.unmount()); root = undefined; client?.clear(); vi.unstubAllGlobals(); });

async function screen(options: { stage?: unknown; policyStatus?: number; envStatus?: number; workspaceStatus?: number; workspaceListStatus?: number; workspaces?: string[]; paginated?: boolean; pending?: "environments" | "workspace" | "workspaces"; archived?: boolean; envs?: string[]; path?: string; authenticated?: boolean } = {}) {
  vi.resetModules();
  const container = installTestDom();
  Object.assign(window.location, { origin: "https://prd.example.test" });
  const NativeRequest = Request;
  vi.stubGlobal("Request", class extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) { super(typeof input === "string" ? new URL(input, "https://prd.example.test") : input, init); }
  });
  const sent: string[] = [];
  const methods: string[] = [];
  let policyResponse: (() => Promise<Response>) | undefined;
  const response = (status: number | undefined, data: unknown) => Response.json(status && status !== 200 ? { status } : data, { status: status ?? 200 });
  vi.stubGlobal("fetch", async (request: Request) => {
    const path = new URL(request.url).pathname;
    sent.push(path);
    methods.push(request.method);
    if (path.endsWith("/auth/csrf")) return Response.json({ csrfToken: "csrf" });
    if (path === "/api/v1/me") return response(options.authenticated === false ? 401 : 200, { id: A, name: "Ana", role: "viewer", environmentRoles: [{ environmentId: B, role: "none" }] });
    if (path === "/api/v2/workspace-creation-policy") return policyResponse ? policyResponse() : response(options.policyStatus, { stage: options.stage === undefined ? "dev" : options.stage });
    if (path === "/api/v1/environments" && options.pending === "environments") return new Promise<Response>(() => {});
    if (path === `/api/v2/workspaces/${A}` && options.pending === "workspace") return new Promise<Response>(() => {});
    if (/^\/api\/v1\/environments\/[^/]+$/.test(path)) return response(200, { id: path.split("/")[4], name: "producao" });
    if (path.endsWith("/clusters")) return response(200, { items: [] });
    if (path === "/api/v1/environments") return response(options.envStatus, { items: (options.envs ?? [A]).map((id) => ({ id, name: id === A ? "producao" : "Oculto" })) });
    if (path === "/api/v2/workspaces") {
      if (options.pending === "workspaces") return new Promise<Response>(() => {});
      const next = options.paginated && !new URL(request.url).searchParams.has("cursor");
      const ids = options.paginated ? next ? [A] : [C] : options.workspaces ?? [A, C];
      return response(options.workspaceListStatus, { items: ids.map((id) => ({ id, key: id, name: id === A ? "Pedidos v2" : "Catálogo v2", slug: id === A ? "pedidos" : "catalogo", status: "active", activeRelease: null })), nextCursor: next ? "next" : null });
    }
    if (path === `/api/v2/workspaces/${C}`) return response(200, { id: C, name: "Catálogo v2", slug: "catalogo", status: "active" });
    if (path === `/api/v2/workspaces/${A}`) return response(options.workspaceStatus, { id: A, name: "Pedidos v2", slug: "pedidos", status: options.archived ? "archived" : "active" });
    return response(404, {});
  });
  const [{ AuthProvider }, { Shell, RequireAuth }, { LoginPage }, { createMemoryRouter, RouterProvider }, { createRoot }, { NavigationContextProvider }] = await Promise.all([
    import("../auth"), import("./Shell"), import("../pages/Login"), import("react-router"), import("react-dom/client"), import("../navigation/context"),
  ]);
  const router = createMemoryRouter([
    { path: "/login", element: <LoginPage /> },
    { element: <RequireAuth />, children: [{ element: <NavigationContextProvider><Shell /></NavigationContextProvider>, children: [
      { path: "/workspaces/:workspaceId/*", element: <h1>Workspace v2</h1> },
      { path: "/e/:envId/*", element: <h1>Conteúdo autorizado pelo servidor</h1> },
      { path: "/tokens", element: <h1>Tokens de API</h1> },
      { path: "/workspaces", element: <h1>Workspaces</h1> },
    ] }] },
  ], { initialEntries: [options.path ?? `/e/${A}/releases`] });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => { root!.render(<QueryClientProvider client={client}><AuthProvider><RouterProvider router={router} /></AuthProvider></QueryClientProvider>); await tick(); });
  await act(async () => { await tick(); });
  const settle = async () => { await act(async () => { await tick(); }); };
  await vi.waitFor(async () => { await settle(); expect(container.textContent).not.toBe("Carregando…"); });
  const select = () => container.findAll((n) => n.tagName === "SELECT" && n.getAttribute("id") === "env-select")[0];
  return { container, router, sent, methods, settle, select, setPolicyResponse: (read: () => Promise<Response>) => { policyResponse = read; } };
}

describe("instance and context in the shell", () => {
  it.each([`/workspaces/${A}/services`, `/e/${A}/services`, "/tokens"])("skip link focuses main without changing URL or history: %s", async (path) => {
    const view = await screen({ path: `${path}?keep=1#existing` });
    const link = view.container.findAll(n => n.tagName === "A" && n.textContent === "Pular para o conteúdo")[0]!;
    const main = view.container.findAll(n => n.getAttribute("id") === "main-content")[0]!;
    const before = view.router.state.location;
    link.focus();
    const event = new Event("click", { bubbles: true, cancelable: true });
    await act(async () => { link.dispatchEvent(event); await tick(); });
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(main);
    expect(view.router.state.location).toEqual(before);
    expect(view.router.state.historyAction).toBe("POP");
  });

  it.each(["dev", "hml", "prd"])("uses only the server stage %s, regardless of host or environment name", async (stage) => {
    const view = await screen({ stage });
    await vi.waitFor(async () => { await view.settle(); expect(view.container.textContent).toContain(`Instância ${stage.toUpperCase()}`); });
    expect(view.container.textContent).toContain("https://prd.example.test");
    expect(view.container.textContent).toContain("Ambiente (legado)");
    expect(view.container.textContent).toContain("Papel legado: Leitor");
    expect(view.container.textContent).toContain("producao");
    expect(view.container.textContent).not.toContain("Workspace v2:");
    expect(view.sent).not.toContain(`/api/v2/workspaces/${A}`);
    expect(view.container.findAll((n) => n.getAttribute("aria-label") === "Identidade da instância")).toHaveLength(1);
    expect(view.router.state.location.pathname).toBe(`/e/${A}/releases`);
  });
  it.each([{ stage: null }, { stage: "invalid" }, { policyStatus: 403 }, { policyStatus: 502 }])("keeps an unknown instance neutral and reading available: %j", async (options) => {
    const view = await screen(options);
    await view.settle();
    expect(view.container.textContent).toContain("Instância não identificada");
    expect(view.container.textContent).not.toContain("Instância PRD");
    expect(view.container.textContent).toContain("Conteúdo autorizado pelo servidor");
  });
  it("hides a cached stage during revalidation and after a denied read", async () => {
    const view = await screen();
    await vi.waitFor(async () => { await view.settle(); expect(view.container.textContent).toContain("Instância DEV"); });
    let release!: (response: Response) => void;
    view.setPolicyResponse(() => new Promise<Response>((resolve) => { release = resolve; }));
    let pending!: Promise<void>;
    await act(async () => { pending = client.invalidateQueries({ queryKey: ["workspace-creation-policy"] }); await tick(); });
    await vi.waitFor(async () => { await view.settle(); expect(view.container.textContent).toContain("Instância não identificada"); });
    await act(async () => { release(Response.json({ status: 403 }, { status: 403 })); await pending; await tick(); });
    expect(view.container.textContent).not.toContain("Instância DEV");
  });
  it("does not infer a v2 workspace when its read is forbidden", async () => {
    const view = await screen({ workspaceStatus: 403, path: `/workspaces/${A}/services` });
    await vi.waitFor(async () => { await view.settle(); expect(view.container.textContent).toContain("Você não tem permissão para acessar este contexto."); });
    expect(view.container.textContent).not.toContain("Workspace v2: producao");
  });
  it.each([{ workspaceStatus: 404, text: "Não encontrado ou indisponível para sua conta." }, { workspaceStatus: 502, text: "Não foi possível verificar o contexto." }, { archived: true, text: "arquivado" }, { pending: "workspace" as const, text: "Verificando contexto…" }, { pending: "environments" as const, text: "Carregando ambientes legados…" }])("represents unconfirmed or archived context: %j", async ({ text, ...options }) => {
    const view = await screen({ ...options, path: options.pending === "environments" ? `/e/${A}/releases` : `/workspaces/${A}/releases` });
    await vi.waitFor(async () => { await view.settle(); expect(view.container.textContent).toContain(text); });
  });
  it("switches only the legacy section, discards detail ids and never changes the instance", async () => {
    const view = await screen({ envs: [A, C], path: `/e/${A}/services/entity` });
    await vi.waitFor(async () => { await view.settle(); expect(!!view.select()).toBe(true); });
    await act(async () => { view.select()!.value = C; view.select()!.dispatchEvent(new Event("change", { bubbles: true })); await tick(); });
    expect(view.router.state.location.pathname).toBe(`/e/${C}/services`);
    await vi.waitFor(async () => { await view.settle(); expect(view.container.textContent).toContain("Instância DEV"); });
    expect(view.container.textContent).not.toContain("Workspace v2: Pedidos v2");
  });
  it.each([
    { path: `/e/${A}/releases`, target: `/workspaces/${C}/releases` },
    { path: `/e/${A}/services/entity`, target: `/workspaces/${C}/services` },
    { path: `/e/${A}/consumers`, target: `/workspaces/${C}/consumers` },
    { path: `/e/${A}/consumers/entity`, target: `/workspaces/${C}/consumers` },
    { path: `/e/${A}/upstreams`, target: `/workspaces/${C}/upstreams` },
    { path: `/e/${A}/certificates`, target: `/workspaces/${C}/certificates` },
    { path: `/e/${A}/metrics`, target: `/workspaces/${C}/services` },
  ])("opens a real v2 Workspace from legacy $path without assuming a selection", async ({ path, target }) => {
    const view = await screen({ path, paginated: true });
    const select = () => view.container.findAll((n) => n.tagName === "SELECT" && n.getAttribute("id") === "workspace-select")[0];
    const more = () => view.container.findAll((n) => n.tagName === "BUTTON" && n.textContent === "Carregar mais Workspaces")[0];
    await vi.waitFor(async () => { await view.settle(); expect(select()).toBeDefined(); expect(more()).toBeDefined(); });
    expect(view.select()!.options.filter((n) => n.getAttribute("value")).map((n) => n.getAttribute("value"))).toEqual([A]);
    expect(select()!.value).toBe("");
    expect(select()!.options[0]!.textContent).toBe("Abrir um Workspace v2…");
    expect(view.sent).not.toContain(`/api/v2/workspaces/${A}`);
    expect(view.container.textContent).not.toContain("Ir para Workspaces");
    await act(async () => { more()!.dispatchEvent(new Event("click", { bubbles: true })); await tick(); });
    await vi.waitFor(async () => { await view.settle(); expect(select()!.options.filter((n) => n.getAttribute("value")).map((n) => n.textContent)).toEqual(["Pedidos v2", "Catálogo v2"]); });
    expect(select()!.value).toBe("");
    expect(view.router.state.location.pathname).toBe(path);
    await act(async () => { select()!.value = C; select()!.dispatchEvent(new Event("change", { bubbles: true })); await tick(); });
    expect(view.router.state.location.pathname).toBe(target);
    expect(view.methods.every((method) => method === "GET")).toBe(true);
  });
  it.each([
    ["/workspaces", "services"], [`/workspaces/${A}/releases`, "releases"],
    [`/workspaces/${A}/services/entity`, "services"], [`/workspaces/${A}/consumers`, "consumers"],
    [`/workspaces/${A}/consumers/entity`, "consumers"], [`/workspaces/${A}/overview`, "overview"],
    [`/workspaces/${A}/upstreams`, "upstreams"], [`/workspaces/${A}/certificates`, "certificates"],
  ])("offers real v2 Workspaces in the explicit v2 namespace on %s", async (path, section) => {
    const view = await screen({ path, envs: [A], workspaces: [A, C] });
    const select = () => view.container.findAll((n) => n.tagName === "SELECT" && n.getAttribute("id") === "workspace-select")[0];
    await vi.waitFor(async () => { await view.settle(); expect(select()).toBeDefined(); });
    expect(view.container.findAll((n) => n.tagName === "LABEL" && n.getAttribute("for") === "workspace-select")[0]?.textContent).toBe("Workspace v2");
    expect(select()!.options.filter((n) => n.getAttribute("value")).map((n) => n.textContent)).toEqual(["Pedidos v2", "Catálogo v2"]);
    if (path === "/workspaces") expect(select()!.value).toBe("");
    await act(async () => { select()!.value = C; select()!.dispatchEvent(new Event("change", { bubbles: true })); await tick(); });
    expect(view.router.state.location.pathname).toBe(`/workspaces/${C}/${section}`);
    expect(view.methods.every((method) => method === "GET")).toBe(true);
    await vi.waitFor(async () => { await view.settle(); expect(view.container.textContent).toContain("Instância DEV"); });
  });
  it.each([403, 502])("keeps a denied or failed v2 list (%s) in the Workspace directory", async (workspaceListStatus) => {
    const view = await screen({ workspaceListStatus, path: "/workspaces" });
    await vi.waitFor(async () => { await view.settle(); expect(view.container.textContent).toContain(workspaceListStatus === 403 ? "Sem permissão para listar Workspaces." : "Não foi possível carregar os Workspaces."); });
    expect(view.select()).toBeUndefined();
    expect(view.router.state.location.pathname).toBe("/workspaces");
  });
  it.each([403, 502])("preserves the legacy environment selector and URL when the v2 list fails (%s)", async (workspaceListStatus) => {
    const path = `/e/${A}/releases`;
    const view = await screen({ workspaceListStatus, path, envs: [C, A] });
    await vi.waitFor(async () => {
      await view.settle();
      expect(view.container.textContent).toContain(workspaceListStatus === 403 ? "Sem permissão para listar Workspaces." : "Não foi possível carregar os Workspaces.");
      expect(view.select()).toBeDefined();
      expect(view.select()!.options.map((n) => n.getAttribute("value"))).toEqual([C, A]);
    });
    expect(view.select()!.getAttribute("disabled")).toBeNull();
    expect(view.container.textContent).toContain("Ambiente (legado)");
    expect(view.container.textContent).toContain("Conteúdo autorizado pelo servidor");
    expect(view.router.state.location.pathname).toBe(path);
    expect(view.sent).not.toContain(`/api/v2/workspaces/${A}`);
    expect(view.methods.every((method) => method === "GET")).toBe(true);
  });
  it.each([{ workspaces: [] }, { workspaces: [C] }, { pending: "workspaces" as const }])("keeps an unconfirmed Workspace selection empty without redirecting: %j", async (options) => {
    const view = await screen({ ...options, path: "/workspaces" });
    await vi.waitFor(async () => { await view.settle(); expect(view.container.findAll((n) => n.getAttribute("id") === "workspace-select")).toHaveLength(1); });
    const select = view.container.findAll((n) => n.tagName === "SELECT" && n.getAttribute("id") === "workspace-select")[0]!;
    expect(select.value).toBe("");
    expect(view.router.state.location.pathname).toBe("/workspaces");
    expect(view.methods.every((method) => method === "GET")).toBe(true);
  });
  it.each([{ workspaces: [] }, { workspaces: [C] }, { pending: "workspaces" as const }])("keeps an unconfirmed v2 selection empty while preserving the legacy selector and URL: %j", async (options) => {
    const path = `/e/${A}/releases`;
    const view = await screen({ ...options, path, envs: [C, A] });
    await vi.waitFor(async () => {
      await view.settle();
      expect(view.container.findAll((n) => n.getAttribute("id") === "workspace-select")).toHaveLength(1);
      expect(view.select()).toBeDefined();
      expect(view.select()!.options.map((n) => n.getAttribute("value"))).toEqual([C, A]);
      if (options.pending) expect(view.container.textContent).toContain("Carregando Workspaces…");
      else if (!options.workspaces.length) expect(view.container.textContent).toContain("Nenhum Workspace disponível.");
      else expect(view.container.textContent).toContain("Catálogo v2");
    });
    const select = view.container.findAll((n) => n.tagName === "SELECT" && n.getAttribute("id") === "workspace-select")[0]!;
    expect(select.value).toBe("");
    expect(select.options[0]!.textContent).toBe("Abrir um Workspace v2…");
    expect(view.select()!.getAttribute("disabled")).toBeNull();
    expect(view.container.textContent).toContain("Ambiente (legado)");
    expect(view.container.textContent).toContain("Conteúdo autorizado pelo servidor");
    expect(view.router.state.location.pathname).toBe(path);
    expect(view.sent).not.toContain(`/api/v2/workspaces/${A}`);
    expect(view.methods.every((method) => method === "GET")).toBe(true);
  });
  it("loads another page of actual Workspaces without selecting or leaving the current context", async () => {
    const view = await screen({ paginated: true, path: "/workspaces" });
    const more = () => view.container.findAll((n) => n.tagName === "BUTTON" && n.textContent === "Carregar mais Workspaces")[0];
    await vi.waitFor(async () => { await view.settle(); expect(more()).toBeDefined(); });
    await act(async () => { more()!.dispatchEvent(new Event("click", { bubbles: true })); await tick(); });
    await vi.waitFor(async () => { await view.settle(); expect(more()).toBeUndefined(); });
    const select = view.container.findAll((n) => n.tagName === "SELECT" && n.getAttribute("id") === "workspace-select")[0]!;
    expect(select.options.filter((n) => n.getAttribute("value")).map((n) => n.textContent)).toEqual(["Pedidos v2", "Catálogo v2"]);
    expect(view.router.state.location.pathname).toBe("/workspaces");
    expect(view.methods.every((method) => method === "GET")).toBe(true);
  });
  it.each([{ envs: [] }, { envs: [A] }, { envs: [A, C] }, { envs: [A, B, C] }])("represents visible legacy environments explicitly: %j", async ({ envs }) => {
    const view = await screen({ envs });
    await vi.waitFor(async () => { await view.settle(); expect(view.select()).toBeDefined(); });
    const offered = view.select()!.options.filter((n) => n.getAttribute("value"));
    expect(offered.map((n) => n.getAttribute("value"))).toEqual(envs.filter((id) => id !== B));
    if (!envs.length) expect(view.container.textContent).toContain("Nenhum ambiente legado disponível");
  });
  it.each([403, 502])("distinguishes a failed legacy list (%s) without silently choosing another environment", async (envStatus) => {
    const view = await screen({ envStatus });
    await vi.waitFor(async () => { await view.settle(); expect(view.container.textContent).toContain(envStatus === 403 ? "Sem permissão para listar ambientes legados" : "Não foi possível carregar os ambientes legados"); });
    expect(view.select()!.getAttribute("disabled")).not.toBeNull();
  });
  it("keeps invalid deep links and gives them no misleading selection", async () => {
    const view = await screen({ path: `/e/${B}/services/entity` });
    await vi.waitFor(async () => { await view.settle(); expect(view.container.textContent).toContain("Ambiente legado indisponível"); });
    expect(view.select()!.options.filter((n) => n.selected).map((n) => n.getAttribute("value"))).not.toContain(A);
    expect(view.router.state.location.pathname).toBe(`/e/${B}/services/entity`);
  });
  it.each(["/tokens/", "/Tokens"])("labels the account scope on accepted URL variants: %s", async (path) => {
    const view = await screen({ path });
    expect(view.container.textContent).toContain("Escopo: minha conta nesta instância");
  });
  it("shows global scope without a selector or an assumed first environment, and validates return navigation", async () => {
    const view = await screen({ path: "/tokens" });
    expect(!!view.select()).toBe(false);
    expect(view.container.textContent).toContain("Escopo: minha conta nesta instância");
    expect(view.container.textContent).not.toContain("Voltar ao ambiente legado");
    await act(async () => { await view.router.navigate(`/e/${A}/releases`); await tick(); });
    await view.settle();
    await act(async () => { await view.router.navigate("/workspaces"); await tick(); });
    expect(view.container.textContent).toContain("Escopo: esta instância");
    expect(view.container.textContent).not.toContain("Voltar ao ambiente legado producao");
    await act(async () => { client.setQueryData(["environments"], { items: [] }); await tick(); });
    expect(view.container.textContent).not.toContain("Voltar ao ambiente legado");
  });
  it("shows the origin at login without reading the protected policy", async () => {
    const view = await screen({ authenticated: false, path: "/login" });
    expect(view.container.textContent).toContain("https://prd.example.test");
    expect(view.sent).not.toContain("/api/v2/workspace-creation-policy");
  });
});
