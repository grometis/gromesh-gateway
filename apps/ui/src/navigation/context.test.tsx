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
type Answer = () => Response | Promise<Response>;
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
    if (answers[path]) return answers[path]();
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
    expect(view.container.textContent).not.toContain("Novo service");
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
  it.each(["services", `services/service-${A}`, "routes", "releases", "variables", "plugins"])("mounts real v2 page %s without environment reads, even with cached v1 draft data", async (section) => {
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
    await view.waitText("Path previsto na configuração v2");
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
    expect(view.container.textContent).not.toContain("Novo service");
    expect(view.container.textContent).toContain("Somente leitura");
    expect(view.sent.filter((p) => p === `/api/v1/environments/${A}`)).toHaveLength(1);
  });
  it.each([500, 502, "network"])("keeps an open legacy service form's error verdict after transient environment failure %s", async (status) => {
    const view = await mount(`/e/${A}/services`, { full: true, role: "admin" });
    await view.waitText("Novo service");
    let release!: (response: Response | PromiseLike<Response>) => void;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    view.answers[`/api/v1/environments/${A}`] = () => pending;
    const create = view.container.findAll((n) => n.tagName === "BUTTON" && n.textContent === "Novo service")[0]!;
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
      await view.waitText("Novo service");
      const create = view.container.findAll((n) => n.tagName === "BUTTON" && n.textContent === "Novo service")[0]!;
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
    expect(view.container.textContent).not.toContain("Novo service");
  });
  it("preserves publication confirmation while and after the authorized Workspace refreshes", async () => {
    const view = await mount(`/workspaces/${A}/releases`, { full: true });
    await view.waitText("Publicar release");
    const click = async (label: string) => {
      const button = view.container.findAll((n) => n.tagName === "BUTTON" && n.textContent === label)[0]!;
      await act(async () => { button.dispatchEvent(new Event("click", { bubbles: true })); await tick(); });
    };
    await click("Publicar release");
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
    await view.waitText("Release v1 publicada. Nenhum deployment foi criado.");
    expect(view.container.textContent).not.toContain("Verificando contexto…");
    view.answers[`/api/v2/workspaces/${A}/releases`] = () => Response.json([release]);
    await act(async () => { finish(Response.json({ ...workspace(A), activeRelease: 1 })); await tick(); });
    await view.waitText("Release ativa: v1");
    expect(view.container.textContent).toContain("Release v1 publicada. Nenhum deployment foi criado.");
  });
  it.each([
    ["services", "Novo service"], ["routes", "Nova route"], ["variables", "Declarar variável"],
    ["plugins", "Novo plugin"], ["releases", "Publicar release"],
  ])("offers v2 writes on %s without consulting legacy publishMode", async (section, action) => {
    const view = await mount(`/workspaces/${A}/${section}`, { full: true });
    await view.waitText(action);
    expect(view.sent.some((p) => p.startsWith("/api/v1/environments"))).toBe(false);
    const links = view.container.findAll((n) => n.tagName === "A").map((n) => n.getAttribute("href"));
    expect(links.some((href) => href?.startsWith("/e/"))).toBe(false);
    for (const legacy of ["metrics", "requests", "consumers", "upstreams", "certificates", "publish", "publications", "clusters"])
      expect(links).not.toContain(`/workspaces/${A}/${legacy}`);
  });
  it("keeps the service form and its data when v2 returns auto-publish", async () => {
    const view = await mount(`/workspaces/${A}/services`, { full: true });
    await view.waitText("Novo service");
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
