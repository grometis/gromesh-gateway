import { act } from "react";
import type { Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installTestDom } from "../test/dom";

const A = "7c1d2e3f-4a5b-4c6d-8e7f-00000000000a";
const B = "7c1d2e3f-4a5b-4c6d-8e7f-00000000000b";
const stamp = "2026-11-03T12:00:00Z";
const workspace = (id: string, status = "active") => ({ id, key: id, name: `Workspace ${id === A ? "A" : "B"}`, slug: id === A ? "alpha" : "beta", status, activeRelease: null });
const environment = (id: string) => ({ id, name: `Legado ${id === A ? "A" : "B"}`, publishMode: "manual", hasUnpublishedChanges: false, currentVersion: null, createdAt: stamp, updatedAt: stamp });
const service = (id: string) => ({ id: `service-${id}`, workspaceId: id, name: `Service ${id === A ? "A" : "B"}`, host: "echo.internal", protocol: "http", port: 80, enabled: true, createdAt: stamp, updatedAt: stamp });
const tick = () => new Promise((r) => setTimeout(r, 0));
type Answer = (request: Request) => Response | Promise<Response>;
let root: Root | undefined;
let client: QueryClient;
afterEach(async () => { if (root) await act(() => root!.unmount()); root = undefined; client?.clear(); vi.unstubAllGlobals(); });

async function mount(path: string, options: { full?: boolean; archived?: boolean; deniedList?: boolean; answers?: Record<string, Answer>; role?: string } = {}) {
  vi.resetModules();
  const container = installTestDom();
  Object.assign(window.location, { origin: "https://ui.example" });
  const NativeRequest = Request;
  vi.stubGlobal("Request", class extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) { super(typeof input === "string" ? new URL(input, "https://ui.example") : input, init); }
  });
  const sent: string[] = [];
  const writes: Request[] = [];
  const answers = options.answers ?? {};
  vi.stubGlobal("fetch", async (request: Request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    sent.push(path);
    if (!["GET", "HEAD"].includes(request.method)) writes.push(request);
    if (answers[path]) return answers[path](request);
    if (path.endsWith("/auth/csrf")) return Response.json({ csrfToken: "csrf" });
    if (path === "/api/v1/me") return Response.json({ id: A, name: "Ana", email: "ana@example.test", role: options.role ?? "viewer", environmentRoles: [] });
    if (path === "/api/v2/workspace-creation-policy") return Response.json({ stage: "dev", caller: {} });
    if (path === "/api/v1/environments") return Response.json({ items: [environment(A), environment(B)] });
    if (path === "/api/v2/workspaces") return options.deniedList ? Response.json({}, { status: 403 }) : Response.json({ items: [], nextCursor: null });
    for (const id of [A, B]) {
      if (path === `/api/v2/workspaces/${id}`) return Response.json(workspace(id, options.archived ? "archived" : "active"));
      if (path === `/api/v1/environments/${id}`) return Response.json(environment(id));
      if (path === `/api/v2/workspaces/${id}/variables` || path === `/api/v2/workspaces/${id}/releases`) return Response.json([]);
      if (path === `/api/v2/workspaces/${id}/services/service-${id}`) return Response.json(service(id));
      if (path === `/api/v2/workspaces/${id}/services`) return Response.json({ items: [service(id)], nextCursor: null });
    }
    return Response.json({ items: [], nextCursor: null });
  });
  const [{ createMemoryRouter, RouterProvider }, { createRoot }, context, { appRoutes }, { AuthProvider }] = await Promise.all([
    import("react-router"), import("react-dom/client"), import("./context"), import("../router"), import("../auth"),
  ]);
  function Probe() {
    const ctx = context.useNavigationContext();
    return <><output>{ctx.route.kind}:{ctx.state}:{ctx.workspace?.name ?? ctx.environment?.name ?? ""}</output>
      <context.NavigationContextBoundary><h1>Conteúdo {ctx.workspace?.name ?? ctx.environment?.name}</h1></context.NavigationContextBoundary></>;
  }
  const router = createMemoryRouter(options.full ? appRoutes : [{ element: <context.NavigationContextProvider />, children: [
    { path: "/workspaces/:workspaceId/*", element: <Probe /> },
    { path: "/e/:envId/*", element: <Probe /> },
    { path: "*", element: <Probe /> },
  ] }], { initialEntries: [path] });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => { root!.render(<QueryClientProvider client={client}>{options.full ? <AuthProvider><RouterProvider router={router} /></AuthProvider> : <RouterProvider router={router} />}</QueryClientProvider>); await tick(); });
  const settle = async () => { await act(async () => { await tick(); }); };
  const waitText = async (text: string) => { await vi.waitFor(async () => { await settle(); expect(container.textContent).toContain(text); }); };
  const navigate = async (to: string | number) => { await act(async () => { if (typeof to === "number") await router.navigate(to); else await router.navigate(to); await tick(); }); };
  return { container, router, sent, writes, answers, settle, waitText, navigate };
}

const problem = (status: number) => () => Response.json({ title: "Failure", status }, { status });
describe("authorized route context with real transport", () => {
  it.each([["/", "global"], ["/workspaces", "global"], ["/users", "admin"], ["/audit", "admin"], ["/tokens?x#y", "account"], ["/missing?x#y", "unknown"]])("resolves %s without a contextual request", async (path, kind) => {
    const view = await mount(path);
    await view.waitText(`${kind}:${kind === "unknown" ? "unknown" : "none"}:`);
    expect(view.sent.filter((p) => /\/(workspaces|environments)\//.test(p))).toEqual([]);
  });
  it.each([false, true])("gets v2 directly outside any list page, list denied=%s", async (deniedList) => {
    const view = await mount(`/workspaces/${A}/services?x=1#y`, { deniedList });
    await view.waitText("workspace-v2:authorized:Workspace A");
    expect(view.sent).toContain(`/api/v2/workspaces/${A}`);
    expect(view.sent).not.toContain("/api/v2/workspaces");
    expect(view.sent.some((p) => p.startsWith("/api/v1/environments"))).toBe(false);
    expect(view.router.state.location).toMatchObject({ search: "?x=1", hash: "#y" });
  });
  it.each([[404, "not-found"], [403, "forbidden"], [502, "error"], [401, "expired"]])("represents v2 HTTP %s without fallback or redirect", async (status, state) => {
    const view = await mount(`/workspaces/${A}/services`, { answers: { [`/api/v2/workspaces/${A}`]: problem(status as number) } });
    await view.waitText(`workspace-v2:${state}:`);
    expect(view.container.textContent).not.toContain("Conteúdo");
    expect(view.sent.some((p) => p.includes("/environments"))).toBe(false);
    expect(view.router.state.location.pathname).toBe(`/workspaces/${A}/services`);
  });
  it("keeps network failure an API error and retries explicitly", async () => {
    const view = await mount(`/workspaces/${A}/services`, { answers: { [`/api/v2/workspaces/${A}`]: () => Promise.reject(new TypeError("offline")) } });
    await view.waitText("workspace-v2:error:");
    view.answers[`/api/v2/workspaces/${A}`] = () => Response.json(workspace(A));
    const retry = view.container.findAll((n) => n.tagName === "BUTTON" && n.textContent === "Tentar novamente")[0]!;
    await act(async () => { retry.dispatchEvent(new Event("click", { bubbles: true })); await tick(); });
    await view.waitText("workspace-v2:authorized:Workspace A");
    expect(view.sent.filter((p) => p === `/api/v2/workspaces/${A}`)).toHaveLength(2);
  });
  it("authorizes archived Workspaces for reading", async () => {
    const view = await mount(`/workspaces/${A}/services`, { archived: true, full: true });
    await view.waitText("Service A");
    expect(view.container.textContent).toContain("arquivado · somente leitura");
    expect(view.container.textContent).not.toContain("Novo serviço");
  });
  it.each([[200, "legacy"], [404, "not-found"], [403, "forbidden"]])("validates only v1 for a legacy route (%s)", async (status, state) => {
    const view = await mount(`/e/${A}/metrics?x#y`, { answers: { [`/api/v1/environments/${A}`]: status === 200 ? () => Response.json(environment(A)) : problem(status as number) } });
    await view.waitText(`legacy-v1:${state}:`);
    expect(view.sent).not.toContain(`/api/v2/workspaces/${A}`);
    expect(view.router.state.location).toMatchObject({ pathname: `/e/${A}/metrics`, search: "?x", hash: "#y" });
  });
  it("ignores A's late authorization after B is selected and revalidates cached B on reentry", async () => {
    let release!: (r: Response) => void;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    const view = await mount(`/workspaces/${A}/services`, { answers: { [`/api/v2/workspaces/${A}`]: () => pending } });
    await view.waitText("workspace-v2:loading:");
    await view.navigate(`/workspaces/${B}/services`);
    await view.waitText("workspace-v2:authorized:Workspace B");
    await act(async () => { release(Response.json(workspace(A))); await tick(); });
    expect(view.container.textContent).not.toContain("Workspace A");
    await view.navigate("/tokens");
    expect(view.container.textContent).not.toContain("Workspace B");
    view.answers[`/api/v2/workspaces/${B}`] = problem(403);
    await view.navigate(`/workspaces/${B}/services`);
    expect(view.container.textContent).not.toContain("Workspace B");
    await view.waitText("workspace-v2:forbidden:");
  });
  it("unmounts A's resources while B loads and discards late resource responses", async () => {
    let release!: (r: Response) => void;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    const view = await mount(`/workspaces/${A}/services`, { full: true, answers: { [`/api/v2/workspaces/${A}/services`]: () => pending } });
    await view.waitText("Workspace v2: Workspace A");
    await view.navigate(`/workspaces/${B}/services?x=2#b`);
    await view.waitText("Service B");
    await act(async () => { release(Response.json({ items: [service(A)], nextCursor: null })); await tick(); });
    expect(view.container.textContent).not.toContain("Service A");
    expect(view.container.textContent).not.toContain("Workspace v2: Workspace A");
    await view.navigate("/tokens");
    expect(view.container.textContent).not.toContain("Service B");
    expect(view.container.findAll((n) => n.tagName === "A" && (n.getAttribute("href")?.includes(`/workspaces/${B}/`) ?? false))).toHaveLength(0);
  });
  it.each(["services", `services/service-${A}`, "routes", "releases", "variables", "plugins", "certificates"])("mounts real v2 page %s without environment reads, even with cached v1 draft data", async (section) => {
    const view = await mount(`/workspaces/${A}/${section}`, { full: true, deniedList: true });
    client.setQueryData(["environment", A], { ...environment(A), hasUnpublishedChanges: true, currentVersion: 99 });
    await view.waitText("Workspace v2: Workspace A");
    await view.settle();
    expect(view.container.textContent).not.toContain("Verificando contexto…");
    expect(view.sent.some((p) => p.startsWith("/api/v1/environments"))).toBe(false);
    expect(view.container.textContent).not.toContain("Publicação");
    expect(view.container.textContent).not.toContain("fluxo v1 (rascunho)");
  });
  it("keeps route details and plugin navigation in v2, including after opening a detail", async () => {
    const route = { id: "route-a", name: "Route A", serviceId: `service-${A}`, paths: ["/orders"], stripPath: true, protocols: ["http"], pathCompatibility: "workspace-default", createdAt: stamp, updatedAt: stamp };
    const view = await mount(`/workspaces/${A}/routes`, { full: true, answers: { [`/api/v2/workspaces/${A}/routes`]: () => Response.json({ items: [route], nextCursor: null }) } });
    await view.waitText("Route A");
    const detail = view.container.findAll((n) => n.tagName === "BUTTON" && n.textContent === "Ver detalhes")[0]!;
    await act(async () => { detail.dispatchEvent(new Event("click", { bubbles: true })); await tick(); });
    await view.waitText("Path previsto do Workspace");
    expect(view.container.textContent).not.toContain("Path no fluxo v1");
    expect(view.container.findAll((n) => n.tagName === "A" && n.textContent === "Plugins do Workspace")[0]?.getAttribute("href")).toBe(`/workspaces/${A}/plugins`);
    expect(view.sent.some((p) => p.startsWith("/api/v1/environments"))).toBe(false);
  });
  it("rejects mismatched metadata as an API error without leaking another Workspace", async () => {
    const view = await mount(`/workspaces/${A}/services`, { answers: { [`/api/v2/workspaces/${A}`]: () => Response.json(workspace(B)) } });
    await view.waitText("workspace-v2:error:");
    expect(view.container.textContent).not.toContain("Workspace B");
  });
  it("blocks legacy content when the environment detail has another ID", async () => {
    const view = await mount(`/e/${A}/services`, { answers: { [`/api/v1/environments/${A}`]: () => Response.json(environment(B)) } });
    await view.waitText("legacy-v1:error:");
    expect(view.container.textContent).not.toContain("Conteúdo");
    expect(view.container.textContent).not.toContain("Legado B");
  });
  it("preserves the legacy analytics alias, query and hash through the actual router", async () => {
    const view = await mount(`/e/${A}/analytics?x=1#y`, { full: true });
    await vi.waitFor(async () => { await view.settle(); expect(view.router.state.location.pathname).toBe(`/e/${A}/metrics`); });
    expect(view.router.state.location).toMatchObject({ search: "?x=1", hash: "#y" });
  });
  it.each(["workspaces", "e"])("preserves %s entry suffixes, back and forward", async (namespace) => {
    const view = await mount(`/${namespace}/${A}?x=1#y`, { full: true });
    await view.waitText(namespace === "workspaces" ? "Inventário no rascunho" : "Service A");
    expect(view.router.state.location).toMatchObject({ pathname: `/${namespace}/${A}/${namespace === "workspaces" ? "overview" : "services"}`, search: "?x=1", hash: "#y" });
    await view.navigate(`/${namespace}/${B}/services?x=2#z`);
    await view.waitText("Service B");
    await view.navigate(-1);
    await view.waitText(namespace === "workspaces" ? "Inventário no rascunho" : "Service A");
    expect(view.router.state.location).toMatchObject({ search: "?x=1", hash: "#y" });
    await view.navigate(1);
    await view.waitText("Service B");
    expect(view.router.state.location).toMatchObject({ search: "?x=2", hash: "#z" });
  });
  it("uses the existing 401 session reset/login flow and preserves the return URL", async () => {
    const view = await mount(`/workspaces/${A}/services?x=1#y`, { full: true, answers: { [`/api/v2/workspaces/${A}`]: problem(401) } });
    await view.waitText("Entrar");
    expect(view.router.state.location.pathname).toBe("/login");
    expect(view.router.state.location.state).toEqual({ from: `/workspaces/${A}/services?x=1#y` });
    expect(client.getQueryCache().getAll()).toHaveLength(0);
    expect(view.container.textContent).not.toContain("Workspace A");
  });
  it.each(["/users", "/audit"])("retains RequireAdmin for %s", async (path) => {
    const view = await mount(path, { full: true });
    await view.waitText("Você não tem permissão para acessar esta página.");
  });
  it("keeps an unknown route visible without selecting a default workspace", async () => {
    const view = await mount(`/workspaces/${A}/missing?x#y`, { full: true });
    await view.waitText("Rota não encontrada.");
    expect(view.sent).not.toContain(`/api/v2/workspaces/${A}`);
    expect(view.router.state.location).toMatchObject({ pathname: `/workspaces/${A}/missing`, search: "?x", hash: "#y" });
  });
  it.each(["pending", "failure"])("preserves legacy reading and blocks writing with an environment %s", async (state) => {
    const view = await mount(`/e/${A}/services`, { full: true, role: "admin", answers: {
      [`/api/v1/environments/${A}`]: state === "pending" ? () => new Promise<Response>(() => {}) : problem(500),
    } });
    await view.waitText("Service A");
    expect(view.container.textContent).not.toContain("Novo serviço");
    expect(view.container.textContent).toContain("Somente leitura");
    expect(view.sent.filter((p) => p === `/api/v1/environments/${A}`)).toHaveLength(1);
  });
  it.each([500, 502, "network"])("keeps an open legacy service form's error verdict after transient environment failure %s", async (status) => {
    const view = await mount(`/e/${A}/services`, { full: true, role: "admin" });
    await view.waitText("Novo serviço");
    let release!: (response: Response | PromiseLike<Response>) => void;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    view.answers[`/api/v1/environments/${A}`] = () => pending;
    const create = view.container.findAll((n) => n.tagName === "BUTTON" && n.textContent === "Novo serviço")[0]!;
    await act(async () => { create.dispatchEvent(new Event("click", { bubbles: true })); await tick(); });
    const dialog = view.container.findAll((n) => n.getAttribute("role") === "dialog")[0]!;
    const form = dialog.findAll((n) => n.tagName === "FORM")[0]!;
    expect(dialog.textContent).toContain("Somente leitura enquanto");
    expect(dialog.findAll((n) => n.tagName === "BUTTON" && n.textContent === "Salvar")[0]?.getAttribute("disabled")).not.toBeNull();
    await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await tick(); });
    expect(view.writes).toEqual([]);
    await act(async () => { release(status === "network" ? Promise.reject(new TypeError("offline")) : problem(Number(status))()); await tick(); });
    await view.waitText("não foi possível verificar");
    expect(view.container.findAll((n) => n.getAttribute("role") === "dialog")[0]).toBe(dialog);
    expect(dialog.textContent).toContain("não foi possível verificar");
    expect(dialog.findAll((n) => n.tagName === "BUTTON" && n.textContent === "Salvar")).toHaveLength(0);
    expect(view.writes).toEqual([]);
  });
  for (const namespace of ["e", "workspaces"]) {
    it.each([403, 404])(`unmounts authorized ${namespace} content and an open form on explicit %s revalidation`, async (status) => {
      const view = await mount(`/${namespace}/${A}/services?x=1#y`, { full: true, role: "admin" });
      await view.waitText("Service A");
      await view.waitText("Novo serviço");
      const create = view.container.findAll((n) => n.tagName === "BUTTON" && n.textContent === "Novo serviço")[0]!;
      await act(async () => { create.dispatchEvent(new Event("click", { bubbles: true })); await tick(); });
      expect(view.container.findAll((n) => n.getAttribute("role") === "dialog")).toHaveLength(1);
      const key = namespace === "e" ? "environment" : "workspace";
      const path = namespace === "e" ? `/api/v1/environments/${A}` : `/api/v2/workspaces/${A}`;
      view.answers[path] = problem(status);
      await act(async () => { await client.invalidateQueries({ queryKey: [key, A] }); await tick(); });
      await view.waitText(status === 403 ? "Você não tem permissão para acessar este contexto." : "Não encontrado ou indisponível para sua conta.");
      expect(view.container.textContent).not.toContain("Service A");
      expect(view.container.findAll((n) => n.getAttribute("role") === "dialog")).toHaveLength(0);
      expect(view.router.state.location).toMatchObject({ pathname: `/${namespace}/${A}/services`, search: "?x=1", hash: "#y" });
      expect(view.writes).toEqual([]);
      // A transient retry after an explicit refusal must not restore the old authorization.
      view.answers[path] = problem(502);
      await act(async () => { await client.invalidateQueries({ queryKey: [key, A] }); await tick(); });
      await view.waitText("Não foi possível verificar o contexto.");
      expect(view.container.textContent).not.toContain("Service A");
      // Returning to a cached ID must establish access again, in either namespace.
      await view.navigate("/tokens");
      view.answers[path] = problem(status);
      await view.navigate(`/${namespace}/${A}/services`);
      await view.waitText(status === 403 ? "Você não tem permissão para acessar este contexto." : "Não encontrado ou indisponível para sua conta.");
      expect(view.container.textContent).not.toContain("Service A");
      expect(view.container.findAll((n) => n.getAttribute("role") === "dialog")).toHaveLength(0);
    });
    it(`revokes an authorized ${namespace} context on 401`, async () => {
      const view = await mount(`/${namespace}/${A}/services`);
      await view.waitText("Conteúdo");
      const key = namespace === "e" ? "environment" : "workspace";
      view.answers[namespace === "e" ? `/api/v1/environments/${A}` : `/api/v2/workspaces/${A}`] = problem(401);
      await act(async () => { await client.invalidateQueries({ queryKey: [key, A] }); await tick(); });
      await view.waitText("Sua sessão expirou.");
      expect(view.container.textContent).not.toContain("Conteúdo");
    });
  }
  it.each([500, "network"])("keeps authorized v2 content during transient revalidation failure %s", async (status) => {
    const view = await mount(`/workspaces/${A}/services`, { full: true });
    await view.waitText("Service A");
    const content = view.container.findAll((n) => n.tagName === "TABLE")[0];
    view.answers[`/api/v2/workspaces/${A}`] = status === "network" ? () => Promise.reject(new TypeError("offline")) : problem(Number(status));
    await act(async () => { await client.invalidateQueries({ queryKey: ["workspace", A] }); await tick(); });
    expect(view.container.textContent).toContain("Service A");
    expect(view.container.findAll((n) => n.tagName === "TABLE")[0]).toBe(content);
    expect(view.container.textContent).not.toContain("Novo serviço");
  });
  it("preserves publication confirmation while and after the authorized Workspace refreshes", async () => {
    const view = await mount(`/workspaces/${A}/releases`, { full: true });
    await view.waitText("Publicar release");
    const click = async (label: string) => {
      const button = view.container.findAll((n) => n.tagName === "BUTTON" && n.textContent === label)[0]!;
      await act(async () => { button.dispatchEvent(new Event("click", { bubbles: true })); await tick(); });
    };
    await click("Publicar release");
    const acknowledgement = view.container.findAll((n) => n.tagName === "INPUT" && n.type === "checkbox")[0]!;
    await act(async () => { acknowledgement.checked = true; acknowledgement.dispatchEvent(new Event("click", { bubbles: true })); await tick(); });
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { finish = resolve; });
    view.answers[`/api/v2/workspaces/${A}`] = () => pending;
    const release = { workspaceId: A, version: 1, contentDigest: `sha256:${"a".repeat(64)}`, origin: "local", contentOriginVersion: 1,
      contentFirstActivatedAt: null, originPromotionId: null, contentRevoked: false, createdAt: stamp, createdBy: { name: "Ana" }, message: "" };
    let published = false;
    view.answers[`/api/v2/workspaces/${A}/releases`] = () => {
      if (published) return Response.json([release]);
      published = true;
      return Response.json(release, { status: 201 });
    };
    await click("Confirmar publicação");
    await view.waitText("Release v1 publicada. Nenhuma implantação foi criada.");
    expect(view.container.textContent).not.toContain("Verificando contexto…");
    view.answers[`/api/v2/workspaces/${A}/releases`] = () => Response.json([release]);
    await act(async () => { finish(Response.json({ ...workspace(A), activeRelease: 1 })); await tick(); });
    await view.waitText("Release ativa: v1");
    expect(view.container.textContent).toContain("Release v1 publicada. Nenhuma implantação foi criada.");
  });
  it.each([
    ["services", "Novo serviço"], ["routes", "Nova rota"], ["variables", "Declarar variável"],
    ["plugins", "Novo plugin"], ["releases", "Publicar release"], ["certificates", "Novo certificado"],
  ])("offers v2 writes on %s without consulting legacy publishMode", async (section, action) => {
    const view = await mount(`/workspaces/${A}/${section}`, { full: true });
    await view.waitText(action);
    expect(view.sent.some((p) => p.startsWith("/api/v1/environments"))).toBe(false);
    const links = view.container.findAll((n) => n.tagName === "A").map((n) => n.getAttribute("href"));
    expect(links.some((href) => href?.startsWith("/e/"))).toBe(false);
    expect(links).toContain(`/workspaces/${A}/certificates`);
    for (const legacy of ["metrics", "requests", "publish", "publications", "clusters"])
      expect(links).not.toContain(`/workspaces/${A}/${legacy}`);
  });
  it("keeps the service form and its data when v2 returns auto-publish", async () => {
    const view = await mount(`/workspaces/${A}/services`, { full: true });
    await view.waitText("Novo serviço");
    await view.waitText("Service A");
    const edit = view.container.findAll((n) => n.tagName === "BUTTON" && n.textContent === "Editar")[0]!;
    await act(async () => { edit.dispatchEvent(new Event("click", { bubbles: true })); await tick(); });
    await view.waitText("Editar Service A");
    view.answers[`/api/v2/workspaces/${A}/services/service-${A}`] = () => Response.json({ title: "Conflict", status: 409, code: "auto-publish" }, { status: 409 });
    const form = view.container.findAll((n) => n.tagName === "FORM")[0]!;
    await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await tick(); });
    await view.waitText("Mude para publicação manual");
    expect(view.container.findAll((n) => n.tagName === "FORM")[0]).toBe(form);
    expect(form.findAll((n) => n.tagName === "INPUT").map((n) => n.value)).toContain("Service A");
    expect(view.sent).toContain(`/api/v2/workspaces/${A}/services/service-${A}`);
  });
  it.each(["/login", "/missing?x#y"])("keeps unauthenticated %s outside the shell", async (path) => {
    const view = await mount(path, { full: true, answers: { "/api/v1/me": problem(401) } });
    await view.waitText("Entrar");
    expect(view.router.state.location.pathname).toBe("/login");
    expect(view.container.findAll((n) => n.tagName === "ASIDE")).toHaveLength(0);
    expect(view.sent.some((p) => p.startsWith("/api/v2/"))).toBe(false);
    if (path !== "/login") expect(view.router.state.location.state).toEqual({ from: path });
  });
});


describe("breadcrumbs through the authorized context and real queries", () => {
  const trail = (view: Awaited<ReturnType<typeof mount>>) => view.container.findAll((n) => n.tagName === "NAV" && n.getAttribute("aria-label") === "Trilha")[0]!;
  const labels = (view: Awaited<ReturnType<typeof mount>>) => trail(view).findAll((n) => n.tagName === "LI").map((n) => n.textContent);
  it.each([
    ["overview", "Visão geral"], ["services", "Serviços"], ["routes", "Rotas"],
    ["consumers", "Consumidores"], ["plugins", "Plugins"], ["upstreams", "Upstreams"],
    ["certificates", "Certificados"], ["variables", "Variáveis"], ["releases", "Releases"],
  ])("keeps the %s breadcrumb beside the integrated Gateway sidebar", async (section, label) => {
    const view = await mount(`/workspaces/${A}/${section}`, { full: true });
    await view.waitText("Workspace v2: Workspace A");
    expect(labels(view)).toEqual(section === "overview"
      ? ["Visão geral da instância", "Workspace A"] : ["Visão geral da instância", "Workspace A", label]);
    if (section === "overview") {
      expect(trail(view).findAll((n) => n.getAttribute("aria-current") === "page").map((n) => [n.tagName, n.textContent]))
        .toEqual([["SPAN", "Workspace A"]]);
      expect(trail(view).findAll((n) => n.tagName === "A").map((n) => n.getAttribute("href"))).toEqual(["/"]);
    }
    const menu = view.container.findAll((n) => n.tagName === "NAV" && n.getAttribute("aria-label") === "Menu principal")[0]!;
    expect(menu.findAll((n) => n.tagName === "A")).toHaveLength(8);
    expect(menu.findAll((n) => n.getAttribute("aria-current") === "page").map((n) => n.getAttribute("aria-label")))
      .toEqual(section === "releases" ? [] : [label]);
    expect(view.sent.some((p) => p.startsWith("/api/v1/environments"))).toBe(false);
  });
  it("names a v2 Consumer from its page query without reading the same-id legacy cache", async () => {
    let release!: (r: Response) => void;
    const endpoint = `/api/v2/workspaces/${A}/consumers/customer-a`;
    const view = await mount(`/workspaces/${A}/consumers/customer-a`, { full: true, answers: {
      [endpoint]: () => new Promise<Response>((resolve) => { release = resolve; }),
    } });
    await view.waitText("Workspace v2: Workspace A");
    await act(async () => {
      client.setQueryData(["consumers", A, "detail", "customer-a"], { id: "customer-a", username: "Nome legado" });
      await tick();
    });
    expect(labels(view)).toEqual(["Visão geral da instância", "Workspace A", "Consumidores", "Consumidor"]);
    await act(async () => {
      release(Response.json({ id: "customer-a", workspaceId: A, username: null, customId: "Cliente real", tags: [], createdAt: stamp, updatedAt: stamp }));
      await tick();
    });
    await vi.waitFor(async () => { await view.settle(); expect(labels(view)).toEqual(["Visão geral da instância", "Workspace A", "Consumidores", "Cliente real"]); });
    expect(trail(view).findAll((n) => n.tagName === "A").map((n) => n.getAttribute("href")))
      .toEqual(["/", `/workspaces/${A}`, `/workspaces/${A}/consumers`]);
    expect(view.sent.filter((p) => p === endpoint)).toHaveLength(1);
  });
  it("renders an ordered accessible v2 detail trail with real names and ID links, without extra requests", async () => {
    const view = await mount(`/workspaces/${A}/services/service-${A}?x#y`, { full: true });
    await view.waitText("Service A");
    await vi.waitFor(async () => { await view.settle(); expect(labels(view)).toEqual(["Visão geral da instância", "Workspace A", "Serviços", "Service A"]); });
    expect(trail(view).findAll((n) => n.tagName === "OL")).toHaveLength(1);
    expect(trail(view).findAll((n) => n.getAttribute("aria-current") === "page").map((n) => n.textContent)).toEqual(["Service A"]);
    expect(trail(view).findAll((n) => n.tagName === "A").map((n) => n.getAttribute("href"))).toEqual(["/", `/workspaces/${A}`, `/workspaces/${A}/services`]);
    expect(view.sent.filter((p) => p === `/api/v2/workspaces/${A}/services/service-${A}`)).toHaveLength(1);
    expect(view.router.state.location).toMatchObject({ pathname: `/workspaces/${A}/services/service-${A}`, search: "?x", hash: "#y" });
  });
  it.each([["/", "Visão geral da instância"], ["/workspaces", "Workspaces"], ["/tokens", "Tokens de API"], ["/users", "Usuários"], ["/audit", "Auditoria"]])("keeps global %s at one level", async (path, label) => {
    const view = await mount(path, { full: true });
    await view.settle();
    expect(labels(view)).toEqual([label]);
    expect(trail(view).findAll((n) => n.tagName === "A")).toHaveLength(0);
  });
  it("uses the confirmed legacy environment without a fabricated v2 ancestor", async () => {
    const view = await mount(`/e/${A}/services`, { full: true });
    await view.waitText("Service A");
    expect(labels(view)).toEqual(["Visão geral da instância", "Ambiente (legado) Legado A", "Serviços"]);
    expect(trail(view).findAll((n) => n.tagName === "A").map((n) => n.getAttribute("href"))).toEqual(["/", `/e/${A}`]);
  });
  it("uses a generic detail until its exact resource loads and discards a late A response after entering B", async () => {
    let release!: (r: Response) => void;
    const view = await mount(`/workspaces/${A}/services/service-${A}`, { full: true, answers: {
      [`/api/v2/workspaces/${A}/services/service-${A}`]: () => new Promise<Response>((resolve) => { release = resolve; }),
    } });
    await view.waitText("Workspace v2: Workspace A");
    expect(labels(view)).toEqual(["Visão geral da instância", "Workspace A", "Serviços", "Serviço"]);
    await view.navigate(`/workspaces/${B}/services/service-${B}`);
    await view.waitText("Service B");
    await act(async () => { release(Response.json(service(A))); await tick(); });
    expect(labels(view)).toEqual(["Visão geral da instância", "Workspace B", "Serviços", "Service B"]);
    expect(trail(view).textContent).not.toContain("Service A");
  });
  it.each([403, 404])("never displays a cached Workspace name or resource during loading or HTTP %s on reentry", async (status) => {
    const view = await mount(`/workspaces/${A}/services/service-${A}`, { full: true });
    await view.waitText("Service A");
    await view.navigate(`/workspaces/${B}/services`);
    await view.waitText("Service B");
    let release!: (r: Response) => void;
    view.answers[`/api/v2/workspaces/${A}`] = () => new Promise<Response>((resolve) => { release = resolve; });
    await view.navigate(`/workspaces/${A}/services/service-${A}`);
    expect(labels(view)).toEqual(["Visão geral da instância", "Serviços", "Serviço"]);
    await act(async () => { release(problem(status)()); await tick(); });
    await view.waitText(status === 403 ? "Você não tem permissão" : "Não encontrado ou indisponível");
    expect(labels(view)).toEqual(["Visão geral da instância", "Serviços", "Serviço"]);
    expect(trail(view).findAll((n) => n.tagName === "A").map((n) => n.getAttribute("href"))).toEqual(["/"]);
  });
  it("uses an already loaded legacy resource when context authorization completes later", async () => {
    let release!: (r: Response) => void;
    const view = await mount(`/e/${A}/services/service-${A}`, { full: true, answers: {
      [`/api/v1/environments/${A}`]: () => new Promise<Response>((resolve) => { release = resolve; }),
    } });
    await view.waitText("Service A");
    expect(labels(view)).toEqual(["Visão geral da instância", "Serviços", "Serviço"]);
    await act(async () => { release(Response.json(environment(A))); await tick(); });
    await view.waitText("Ambiente (legado) Legado A");
    expect(labels(view)).toEqual(["Visão geral da instância", "Ambiente (legado) Legado A", "Serviços", "Service A"]);
  });
  it.each([
    ["consumers/customer-a", "consumers/customer-a", { id: "customer-a", username: null, customId: "Cliente real", tags: [], createdAt: stamp, updatedAt: stamp }, ["Consumidores", "Cliente real"]],
    ["publications/7", "snapshots/7", { version: 7, hash: "sha256:abc", createdAt: stamp }, ["Publicações", "Snapshot v7"]],
  ] as const)("names legacy detail %s from its existing page query", async (path, endpoint, data, suffix) => {
    const view = await mount(`/e/${A}/${path}`, { full: true, answers: { [`/api/v1/environments/${A}/${endpoint}`]: () => Response.json(data) } });
    await view.waitText(suffix[1]);
    expect(labels(view)).toEqual(["Visão geral da instância", "Ambiente (legado) Legado A", ...suffix]);
    expect(view.sent.filter((p) => p === `/api/v1/environments/${A}/${endpoint}`)).toHaveLength(1);
  });
  it("keeps an archived Workspace readable and unknown routes free of invented ancestors", async () => {
    const view = await mount(`/workspaces/${A}/routes`, { full: true, archived: true });
    await view.waitText("arquivado · somente leitura");
    expect(labels(view)).toEqual(["Visão geral da instância", "Workspace A", "Rotas"]);
    await view.navigate(`/workspaces/${A}/no-such-page`);
    expect(labels(view)).toEqual(["Página não encontrada"]);
    expect(trail(view).findAll((n) => n.tagName === "A")).toHaveLength(0);
  });
});


describe("one accented publication action per screen", () => {
  const publishActions = (view: Awaited<ReturnType<typeof mount>>) => view.container.findAll((n) => n.tagName === "BUTTON" && n.getAttribute("class")?.split(" ").includes("publish") === true);
  it("moves the Release accent to its confirmation and restores it on close", async () => {
    const view = await mount(`/workspaces/${A}/releases`, { full: true });
    await view.waitText("Publicar release");
    expect(publishActions(view).map((n) => n.textContent)).toEqual(["Publicar release"]);
    const open = view.container.findAll((n) => n.tagName === "BUTTON" && n.textContent === "Publicar release")[0]!;
    await act(async () => { open.dispatchEvent(new Event("click", { bubbles: true })); await tick(); });
    expect(publishActions(view).map((n) => n.textContent)).toEqual(["Confirmar publicação"]);
    const close = view.container.findAll((n) => n.tagName === "BUTTON" && n.textContent === "Cancelar")[0]!;
    await act(async () => { close.dispatchEvent(new Event("click", { bubbles: true })); await tick(); });
    expect(publishActions(view).map((n) => n.textContent)).toEqual(["Publicar release"]);
  });
  it("keeps the legacy review strip neutral while its confirmation is accented", async () => {
    const view = await mount(`/e/${A}/publish`, { full: true, role: "admin", answers: {
      [`/api/v1/environments/${A}`]: () => Response.json({ ...environment(A), hasUnpublishedChanges: true }),
      [`/api/v1/environments/${A}/publish-preview`]: () => Response.json({ currentVersion: null, hasChanges: true, changes: [] }),
    } });
    await view.waitText("Revisar snapshot (legado)");
    await vi.waitFor(async () => { await view.settle(); expect(publishActions(view)).toHaveLength(1); });
    expect(publishActions(view)[0]!.parentNode?.getAttribute("class")).toBe("publish-box");
    const main = view.container.findAll((n) => n.tagName === "MAIN")[0]!;
    const strip = main.findAll((n) => n.getAttribute("class")?.split(" ").includes("publish-strip") === true)[0]!;
    const trail = main.findAll((n) => n.getAttribute("aria-label") === "Trilha")[0]!;
    expect(main.childNodes.indexOf(strip)).toBeLessThan(main.childNodes.indexOf(trail));
  });
});

describe("Workspace Upstreams with controlled transport", () => {
  const upstream = { id: "pool-A", name: "orders-pool", algorithm: "round-robin", hashOn: "none", hashFallback: "none", healthchecks: { active: null, passive: null }, tags: [], createdAt: stamp, updatedAt: stamp };
  const listPath = `/api/v2/workspaces/${A}/upstreams`;
  const populated = { [listPath]: () => Response.json({ items: [upstream], nextCursor: null }) };
  async function click(view: Awaited<ReturnType<typeof mount>>, text: string) {
    const button = view.container.findAll((n) => n.tagName === "BUTTON" && n.textContent === text)[0]!;
    expect(button).toBeDefined();
    await act(async () => { button.dispatchEvent(new Event("click", { bubbles: true })); await tick(); });
  }
  it("registers the deep link and reads only v2, associating Services solely by upstreamId", async () => {
    const view = await mount(`/workspaces/${A}/upstreams?keep=1#targets`, { full: true, answers: {
      ...populated,
      [`/api/v2/workspaces/${A}/services`]: () => Response.json({ items: [{ ...service(A), upstreamId: upstream.id }, { ...service(B), name: "DNS only", host: upstream.name, upstreamId: null }], nextCursor: "more" }),
    } });
    await view.waitText("orders-pool");
    await view.waitText("Lista parcial de Serviços");
    const links = view.container.findAll((n) => n.tagName === "A");
    expect(links.some((n) => n.textContent === "Service A")).toBe(true);
    expect(links.some((n) => n.textContent === "DNS only")).toBe(false);
    expect(view.sent.some((p) => p.startsWith("/api/v1/environments"))).toBe(false);
    expect(view.router.state.location).toMatchObject({ search: "?keep=1", hash: "#targets" });
  });
  it.each([403, 404, 500])("renders an upstream HTTP %s as error, without empty or write controls", async (status) => {
    const view = await mount(`/workspaces/${A}/upstreams`, { full: true, answers: { [listPath]: problem(status) } });
    await view.waitText(status === 403 ? "Você não tem permissão" : status === 404 ? "Item não encontrado" : "Não foi possível concluir");
    expect(view.container.textContent).not.toContain("Nenhum upstream ainda");
    expect(view.container.textContent).not.toContain("Novo upstream");
  });
  it("does not report absent Services when their lookup fails", async () => {
    const view = await mount(`/workspaces/${A}/upstreams`, { full: true, answers: {
      ...populated, [`/api/v2/workspaces/${A}/services`]: problem(403),
    } });
    await view.waitText("Não foi possível consultar os Serviços vinculados");
    expect(view.container.textContent).not.toContain("Serviços vinculados: nenhum");
  });
  it("shows archived configuration and targets with no mutation controls", async () => {
    const view = await mount(`/workspaces/${A}/upstreams`, { full: true, archived: true, answers: populated });
    await view.waitText("orders-pool");
    await click(view, "Destinos de orders-pool");
    await view.waitText("Nenhum destino");
    expect(view.container.textContent).not.toContain("Novo upstream");
    expect(view.container.findAll((n) => n.tagName === "FORM")).toHaveLength(0);
    expect(view.writes).toEqual([]);
  });
  it.each([403, 409, 422])("preserves the Upstream form after write HTTP %s", async (status) => {
    const view = await mount(`/workspaces/${A}/upstreams`, { full: true, answers: populated });
    await view.waitText("orders-pool");
    await click(view, "Editar orders-pool");
    view.answers[`${listPath}/${upstream.id}`] = () => Response.json({ title: "Rejected", status, code: "auto-publish", errors: status === 422 ? [{ path: "healthchecks.active.intervalSeconds", message: "must be >= 1" }] : undefined }, { status });
    const form = view.container.findAll((n) => n.tagName === "FORM")[0]!;
    await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await tick(); });
    await view.waitText(status === 403 ? "Você não tem permissão" : status === 409 ? "Mude para publicação manual" : "confira tipo, caminho");
    expect(view.container.findAll((n) => n.tagName === "INPUT" && n.value === upstream.name)).toHaveLength(1);
    expect(view.writes.filter((r) => r.method === "PUT")).toHaveLength(1);
  });
  it("drops an open form when switching A to B and never writes A data into B", async () => {
    const view = await mount(`/workspaces/${A}/upstreams`, { full: true, answers: populated });
    await view.waitText("orders-pool");
    await click(view, "Editar orders-pool");
    await view.navigate(`/workspaces/${B}/upstreams`);
    await view.waitText("Nenhum upstream ainda");
    expect(view.container.findAll((n) => n.getAttribute("role") === "dialog")).toHaveLength(0);
    expect(view.container.textContent).not.toContain(upstream.name);
    expect(view.writes).toEqual([]);
  });
  it("refuses a submit fired before an invalidated access query re-renders", async () => {
    const view = await mount(`/workspaces/${A}/upstreams`, { full: true, answers: populated });
    await view.waitText("orders-pool");
    await click(view, "Editar orders-pool");
    const form = view.container.findAll((n) => n.tagName === "FORM")[0]!;
    await act(async () => {
      void client.invalidateQueries({ queryKey: ["workspace", A], refetchType: "none" });
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await tick();
    });
    expect(view.writes.filter((r) => r.method === "PUT")).toHaveLength(0);
  });
  it("closes the page on context 401 using the shared session flow", async () => {
    const view = await mount(`/workspaces/${A}/upstreams`, { full: true, answers: { [`/api/v2/workspaces/${A}`]: problem(401) } });
    await view.waitText("Entrar");
    expect(view.router.state.location.pathname).toBe("/login");
    expect(view.sent).not.toContain(listPath);
  });
});

describe("Upstream shared form keeps the legacy flow", () => {
  it("retains v1 reads, host guidance and v1 writes", async () => {
    const path = `/api/v1/environments/${A}/upstreams`;
    const pool = { id: "legacy-pool", name: "legacy.pool", algorithm: "round-robin", hashOn: "none", hashFallback: "none", hashOnCookiePath: "/", healthchecks: {}, createdAt: stamp, updatedAt: stamp };
    const view = await mount(`/e/${A}/upstreams`, { full: true, role: "admin", answers: { [path]: () => Response.json({ items: [pool], nextCursor: null }) } });
    await view.waitText("legacy.pool");
    expect(view.container.textContent).toContain("Um serviço cujo host é o nome de um Upstream");
    const edit = view.container.findAll((n) => n.tagName === "BUTTON" && n.textContent === "Editar")[0]!;
    await act(async () => { edit.dispatchEvent(new Event("click", { bubbles: true })); await tick(); });
    await view.waitText("use este nome como host dos serviços");
    view.answers[`${path}/${pool.id}`] = () => Response.json(pool);
    const form = view.container.findAll((n) => n.tagName === "FORM")[0]!;
    await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await tick(); });
    await vi.waitFor(() => expect(view.writes.filter((r) => r.method === "PUT")).toHaveLength(1));
    expect(view.writes.find((r) => r.method === "PUT")!.url).toContain(`/api/v1/environments/${A}/upstreams/legacy-pool`);
    expect(view.sent.some((p) => /\/api\/v2\/.*upstreams/.test(p))).toBe(false);
  });
});

describe("Workspace target edits and deletion", () => {
  it("persists an explicit zero weight with tags intact and deletes only after confirmation", async () => {
    const listPath = `/api/v2/workspaces/${A}/upstreams`;
    const targetsPath = `${listPath}/pool/targets`;
    const original = { id: "target", upstreamId: "pool", target: "backend.internal:80", weight: 100, tags: ["keep"], createdAt: stamp, updatedAt: stamp };
    let items = [original];
    const view = await mount(`/workspaces/${A}/upstreams`, { full: true, answers: {
      [listPath]: () => Response.json({ items: [{ id: "pool", name: "pool", algorithm: "round-robin", hashOn: "none", hashFallback: "none", hashOnCookiePath: "/", healthchecks: {} }], nextCursor: null }),
      [targetsPath]: () => Response.json({ items, nextCursor: null }),
      [`${targetsPath}/target`]: async (request) => {
        if (request.method === "DELETE") { items = []; return new Response(null, { status: 204 }); }
        items = [{ ...original, ...await request.clone().json() as object }];
        return Response.json(items[0]);
      },
    } });
    const click = async (text: string) => {
      const button = view.container.findAll((n) => n.tagName === "BUTTON" && n.textContent === text)[0]!;
      expect(button).toBeDefined();
      await act(async () => { button.dispatchEvent(new Event("click", { bubbles: true })); await tick(); });
    };
    await view.waitText("Destinos de pool");
    await click("Destinos de pool");
    await view.waitText("backend.internal:80");
    await click("Editar peso de backend.internal:80");
    const label = view.container.findAll((n) => n.tagName === "LABEL" && n.textContent === "Peso")[0]!;
    const input = view.container.findAll((n) => n.getAttribute("id") === label.getAttribute("for"))[0]!;
    await act(async () => { input.value = "0"; input.dispatchEvent(new Event("input", { bubbles: true })); await tick(); });
    const form = view.container.findAll((n) => n.tagName === "FORM")[0]!;
    await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await tick(); });
    await view.waitText("fora do balanceamento");
    const write = view.writes.find((r) => r.method === "PUT")!;
    expect(await write.clone().json()).toEqual({ target: "backend.internal:80", weight: 0, tags: ["keep"] });
    await click("Remover backend.internal:80");
    expect(view.writes.filter((r) => r.method === "DELETE")).toHaveLength(0);
    await click("Cancelar");
    expect(view.writes.filter((r) => r.method === "DELETE")).toHaveLength(0);
    await click("Remover backend.internal:80");
    await click("Remover");
    await view.waitText("Nenhum destino");
    expect(view.writes.filter((r) => r.method === "DELETE")).toHaveLength(1);
    expect(view.writes.find((r) => r.method === "DELETE")!.url).toBe(`https://ui.example${targetsPath}/target`);
  });
});
