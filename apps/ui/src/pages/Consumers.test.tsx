import { act } from "react";
import type { Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installTestDom, type TestNode } from "../test/dom";
import type { components } from "../api/schema-v2";

const A = "7c1d2e3f-4a5b-4c6d-8e7f-00000000000a";
const B = "7c1d2e3f-4a5b-4c6d-8e7f-00000000000b";
const C = "7c1d2e3f-4a5b-4c6d-8e7f-00000000000c";
const stamp = "2026-11-03T12:00:00Z";
const consumer = { id: C, username: "checkout", customId: "billing", tags: [], createdAt: stamp, updatedAt: stamp };
const pageOf = (items: unknown[], nextCursor: string | null = null) => ({ items, nextCursor });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
let root: Root | undefined;
let client: QueryClient;
afterEach(async () => { if (root) await act(() => root!.unmount()); root = undefined; client?.clear(); vi.unstubAllGlobals(); });

async function mount(section = `consumers/${C}`, options: { archived?: boolean; legacy?: boolean; role?: string; respond?: (r: Request) => Response | Promise<Response> | undefined } = {}) {
  vi.resetModules();
  const container = installTestDom();
  Object.assign(window.location, { origin: "https://ui.example" });
  const NativeRequest = Request;
  vi.stubGlobal("Request", class extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) { super(typeof input === "string" ? new URL(input, "https://ui.example") : input, init); }
  });
  const requests: Request[] = [];
  vi.stubGlobal("fetch", async (request: Request) => {
    requests.push(request);
    const custom = options.respond?.(request);
    if (custom) return custom;
    const url = new URL(request.url);
    const path = url.pathname;
    if (path.endsWith("/auth/csrf")) return Response.json({ csrfToken: "csrf" });
    if (path === "/api/v1/me") return Response.json({ id: A, name: "Ana", email: "ana@example.test", role: options.role ?? "viewer", environmentRoles: [] });
    if (path === "/api/v2/workspace-creation-policy") return Response.json({}, { status: 403 });
    if (/^\/api\/v2\/workspaces\/[^/]+$/.test(path)) return Response.json({ id: path.split("/").at(-1), key: A, name: "Workspace", slug: "billing", status: options.archived ? "archived" : "active", activeRelease: null });
    if (path.endsWith(`/consumers/${C}`)) return request.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json(consumer);
    if (path.endsWith("/key-auth") && request.method === "POST") return Response.json({ id: C, consumerId: C, keyHint: "…last", key: "ephemeral-key-only", createdAt: stamp }, { status: 201 });
    if (path.endsWith("/jwt") && request.method === "POST") return Response.json({ id: C, consumerId: C, key: "issuer", algorithm: "HS256", secret: "ephemeral-jwt-only", createdAt: stamp }, { status: 201 });
    if (path.endsWith("/acl-groups")) return Response.json({ groups: ["staff"] });
    if (path.endsWith("/consumers")) return Response.json(pageOf(path.includes(B) ? [] : [consumer]));
    if (path === `/api/v1/environments/${A}`) return Response.json({ id: A, name: "Legado", publishMode: "manual", currentVersion: null, hasUnpublishedChanges: false, createdAt: stamp, updatedAt: stamp });
    return Response.json(pageOf([]));
  });
  const [{ createMemoryRouter, RouterProvider }, { createRoot }, { appRoutes }, { AuthProvider }] = await Promise.all([
    import("react-router"), import("react-dom/client"), import("../router"), import("../auth"),
  ]);
  const base = options.legacy ? "/e" : "/workspaces";
  const router = createMemoryRouter(appRoutes, { initialEntries: [`${base}/${A}/${section}`] });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => { root!.render(<QueryClientProvider client={client}><AuthProvider><RouterProvider router={router} /></AuthProvider></QueryClientProvider>); await tick(); });
  const settle = async () => { await act(async () => { await tick(); }); };
  const waitText = async (text: string) => vi.waitFor(async () => { await settle(); expect(container.textContent).toContain(text); });
  const find = (text: string) => container.findAll(n => n.tagName === "BUTTON" && (n.textContent === text || n.getAttribute("aria-label") === text))[0]!;
  const click = async (text: string) => { const node = find(text); expect(node, text).toBeDefined(); await act(async () => { node.dispatchEvent(new Event("click", { bubbles: true })); await tick(); }); };
  const submit = async () => { const form = container.findAll(n => n.tagName === "FORM")[0]!; expect(form).toBeDefined(); await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await tick(); }); };
  const navigate = async (path: string) => { await act(async () => { await router.navigate(path); await tick(); }); };
  return { container, requests, router, settle, waitText, find, click, submit, navigate };
}

const values = (node: TestNode) => node.textContent + node.findAll(n => n.tagName === "INPUT").map(n => n.value).join();

describe("workspace consumers with controlled transport", () => {
  it("reads v2 detail and children, with no legacy environment or credential calls", async () => {
    const view = await mount();
    await view.waitText("Nenhuma credencial basic-auth.");
    expect(view.container.textContent).toContain("Consumidor checkout");
    expect(view.requests.some(r => r.url.includes("/api/v1/environments"))).toBe(false);
    expect(client.getQueryCache().getAll().filter(q => String(q.queryKey[0]).startsWith("ws-")).every(q => q.queryKey.includes(A))).toBe(true);
    await view.click("Grupos ACL"); await view.waitText("staff");
    await view.click("Editar grupos");
    const field = view.container.findAll(n => n.tagName === "FORM")[0]!.findAll(n => n.tagName === "INPUT")[0]!;
    await act(async () => { field.value = "partners, partners, billing"; field.dispatchEvent(new Event("input", { bubbles: true })); await tick(); });
    await view.submit();
    await vi.waitFor(() => expect(view.requests.filter(r => r.method === "PUT")).toHaveLength(1));
    expect(await view.requests.find(r => r.method === "PUT")!.json()).toEqual({ groups: ["partners", "billing"] });
    await view.click("Plugins"); await view.waitText("Plugins por consumidor ainda não estão disponíveis no Workspace v2.");
    expect(view.requests.some(r => r.url.includes("/plugins"))).toBe(false);
  });
  it("sends PUT and confirmed DELETE through v2 only", async () => {
    const view = await mount(); await view.waitText("Consumidor checkout");
    await view.click("Editar"); await view.submit();
    await vi.waitFor(() => expect(view.requests.some(r => r.method === "PUT")).toBe(true));
    await view.waitText("Nenhuma credencial basic-auth.");
    await view.click("Mais ações para checkout"); await view.click("Excluir");
    expect(view.requests.filter(r => r.method === "DELETE")).toHaveLength(0);
    await view.click("Excluir");
    await vi.waitFor(async () => { await view.settle(); expect(view.router.state.location.pathname).toBe(`/workspaces/${A}/consumers`); });
    expect(view.requests.filter(r => ["PUT", "DELETE"].includes(r.method)).map(r => [r.method, new URL(r.url).pathname])).toEqual([["PUT", `/api/v2/workspaces/${A}/consumers/${C}`], ["DELETE", `/api/v2/workspaces/${A}/consumers/${C}`]]);
  });
  it.each([
    [403, "Você não tem permissão para esta ação."],
    [409, "Este Workspace publica automaticamente pelo fluxo legado. Mude para publicação manual antes de editar por aqui."],
    [422, "Valor inválido. Confira este campo."],
  ] as const)("announces HTTP %s, sanitizes feedback and preserves the edited form", async (status, message) => {
    const problem: components["schemas"]["Problem"] & { code?: string } = {
      type: "about:blank", title: "must-not-echo-secret", status,
      code: status === 409 ? "auto-publish" : undefined,
      detail: "must-not-echo-secret", errors: [{ path: "username", message: "must-not-echo-secret" }],
    };
    const view = await mount(undefined, { respond: r => r.method === "PUT"
      ? Response.json(problem, { status, headers: { "Content-Type": "application/problem+json" } }) : undefined });
    await view.waitText("Nenhuma credencial basic-auth.");
    await view.click("Editar");
    const form = view.container.findAll(n => n.tagName === "FORM")[0]!;
    const inputs = form.findAll(n => n.tagName === "INPUT");
    await act(async () => { inputs[0]!.value = "edited-checkout"; inputs[0]!.dispatchEvent(new Event("input", { bubbles: true })); await tick(); });
    await view.submit();
    await view.waitText(message);
    const dialog = view.container.findAll(n => n.getAttribute("role") === "dialog")[0]!;
    const alert = dialog.findAll(n => n.getAttribute("role") === "alert" && n.textContent === message)[0]!;
    expect(alert).toBeDefined();
    if (status === 422) {
      expect(inputs[0]!.getAttribute("aria-invalid")).toBe("true");
      expect(alert.parentNode).toBe(inputs[0]!.parentNode);
    } else {
      const items = alert.findAll(n => n.tagName === "LI");
      expect(items.map(n => n.textContent)).toEqual([message]);
      for (const item of items) {
        expect(["UL", "OL"]).toContain(item.parentNode?.tagName);
        expect([null, "list"]).toContain(item.parentNode?.getAttribute("role"));
      }
    }
    expect(dialog.findAll(n => n.tagName === "FORM")).toEqual([form]);
    expect(inputs.map(n => n.value)).toEqual(["edited-checkout", "billing", ""]);
    expect(view.find("Salvar").disabled).toBe(false);
    expect(view.router.state.location.pathname).toBe(`/workspaces/${A}/consumers/${C}`);
    expect(values(view.container)).not.toContain("must-not-echo-secret");
    expect(JSON.stringify(client.getMutationCache().getAll().map(m => m.state))).not.toContain("must-not-echo-secret");
    expect(view.requests.filter(r => r.method === "PUT")).toHaveLength(1);
    expect(await view.requests.find(r => r.method === "PUT")!.json()).toEqual({ username: "edited-checkout", customId: "billing", tags: [] });
  });
  it.each(["key", "jwt"])("evicts the one-time %s on close and workspace switch", async kind => {
    const view = await mount(); await view.waitText("Nenhuma credencial basic-auth.");
    const open = kind === "key" ? "Gerar chave" : "Nova credencial JWT";
    await view.click(open); await view.submit();
    const secret = kind === "key" ? "ephemeral-key-only" : "ephemeral-jwt-only";
    await view.waitText(secret);
    expect(JSON.stringify(client.getQueryCache().getAll().map(q => q.state.data))).not.toContain(secret);
    await view.click("Já copiei");
    await vi.waitFor(() => expect(JSON.stringify(client.getMutationCache().getAll().map(m => m.state))).not.toContain(secret));
    expect(values(view.container)).not.toContain(secret);
    await view.click(open); await view.submit(); await view.waitText(secret);
    await view.navigate(`/workspaces/${B}/consumers`); await view.waitText("Nenhum consumidor ainda.");
    await vi.waitFor(() => expect(JSON.stringify(client.getMutationCache().getAll().map(m => m.state))).not.toContain(secret));
    expect(values(view.container)).not.toContain(secret);
    expect(view.container.findAll(n => n.getAttribute("role") === "dialog")).toHaveLength(0);
  });
  it.each(["key", "jwt"])("evicts a rotated %s secret when its dialog closes", async kind => {
    const suffix = kind === "key" ? "key-auth" : "jwt";
    const view = await mount(undefined, { respond: request => {
      const credential = { id: C, consumerId: C, keyHint: "…last", key: "issuer", algorithm: "HS256", status: "active", createdAt: stamp };
      if (request.method === "GET" && request.url.endsWith(`/${suffix}`)) return Response.json(pageOf([credential]));
      if (request.method === "POST" && request.url.endsWith(`/${suffix}/${C}/rotate`)) return Response.json(kind === "key" ? { ...credential, key: "rotated-only" } : { ...credential, secret: "rotated-only" });
      return undefined;
    } });
    await view.waitText("Nenhuma credencial basic-auth.");
    await view.click(kind === "key" ? "Mais ações para a chave …last" : "Mais ações para a credencial JWT issuer");
    await view.click(kind === "key" ? "Gerar nova chave" : "Gerar novo segredo"); await view.click("Gerar"); await view.waitText("rotated-only");
    expect(JSON.stringify(client.getQueryCache().getAll().map(q => q.state))).not.toContain("rotated-only");
    await view.click("Já copiei");
    await vi.waitFor(() => expect(JSON.stringify(client.getMutationCache().getAll().map(m => m.state))).not.toContain("rotated-only"));
    expect(values(view.container)).not.toContain("rotated-only");
  });
  it("keeps an open form blocked while workspace access is revalidated", async () => {
    let revalidating = false;
    let release!: (r: Response) => void;
    const pending = new Promise<Response>(resolve => { release = resolve; });
    const view = await mount(undefined, { respond: r => revalidating && r.url.endsWith(`/workspaces/${A}`) ? pending : undefined });
    await view.waitText("Consumidor checkout"); await view.click("Editar");
    revalidating = true;
    await act(async () => { void client.invalidateQueries({ queryKey: ["workspace", A] }); await tick(); });
    try {
      await view.waitText("Somente leitura enquanto verificamos o estado do Workspace.");
      await view.submit();
      expect(view.requests.filter(r => r.method === "PUT")).toHaveLength(0);
    } finally { await act(async () => { release(Response.json({ id: A, status: "active" })); await tick(); }); }
  });
  it("returns to login when the consumer list answers 401", async () => {
    const view = await mount("consumers", { respond: r => r.url.endsWith("/consumers") ? Response.json({ status: 401 }, { status: 401 }) : undefined });
    await view.waitText("Entrar");
    expect(view.router.state.location.pathname).toBe("/login");
    expect(view.container.textContent).not.toContain("checkout");
  });
  it("discards a late secret after switching workspace", async () => {
    let release!: (r: Response) => void;
    const pending = new Promise<Response>(resolve => { release = resolve; });
    const view = await mount(undefined, { respond: r => r.method === "POST" && r.url.endsWith("/key-auth") ? pending : undefined });
    await view.waitText("Nenhuma credencial basic-auth."); await view.click("Gerar chave"); await view.submit();
    await view.navigate(`/workspaces/${B}/consumers`); await view.waitText("Nenhum consumidor ainda.");
    await act(async () => { release(Response.json({ id: C, key: "late-secret" }, { status: 201 })); await tick(); });
    await vi.waitFor(() => expect(client.getMutationCache().getAll()).toHaveLength(0));
    expect(values(view.container)).not.toContain("late-secret");
  });
  it("does not open A's newly created consumer after switching to B", async () => {
    let release!: (r: Response) => void;
    const pending = new Promise<Response>(resolve => { release = resolve; });
    const view = await mount("consumers", { respond: r => r.method === "POST" && r.url.endsWith("/consumers") ? pending : undefined });
    await view.waitText("checkout"); await view.click("Novo consumidor");
    const field = view.container.findAll(n => n.tagName === "FORM")[0]!.findAll(n => n.tagName === "INPUT")[0]!;
    await act(async () => { field.value = "created-A"; field.dispatchEvent(new Event("input", { bubbles: true })); await tick(); });
    await view.submit();
    await vi.waitFor(() => expect(view.requests.some(r => r.method === "POST" && r.url.endsWith("/consumers"))).toBe(true));
    await view.navigate(`/workspaces/${B}/consumers`); await view.waitText("Nenhum consumidor ainda.");
    await act(async () => { release(Response.json({ ...consumer, username: "created-A" }, { status: 201 })); await tick(); });
    await view.settle();
    expect(view.router.state.location.pathname).toBe(`/workspaces/${B}/consumers`);
    expect(view.container.textContent).not.toContain("created-A");
  });
  it("does not navigate away from B when A's deletion completes late", async () => {
    let release!: (r: Response) => void;
    const pending = new Promise<Response>(resolve => { release = resolve; });
    const view = await mount(undefined, { respond: r => r.method === "DELETE" ? pending : undefined });
    await view.waitText("Consumidor checkout");
    await view.click("Mais ações para checkout"); await view.click("Excluir"); await view.click("Excluir");
    await view.navigate(`/workspaces/${B}/consumers`); await view.waitText("Nenhum consumidor ainda.");
    await act(async () => { release(new Response(null, { status: 204 })); await tick(); });
    await view.settle();
    expect(view.router.state.location.pathname).toBe(`/workspaces/${B}/consumers`);
    expect(view.container.textContent).not.toContain("checkout");
  });
  it("blocks writes after archival even from a submitted open form", async () => {
    const view = await mount(); await view.waitText("Consumidor checkout"); await view.click("Editar");
    await act(async () => { client.setQueryData(["workspace", A], { id: A, status: "archived" }); await tick(); });
    await view.waitText("Somente leitura: este Workspace está arquivado.");
    await view.submit(); await view.settle();
    expect(view.requests.filter(r => r.method === "PUT")).toHaveLength(0);
  });
  it("renders archived detail with credentials but no write controls", async () => {
    const view = await mount(undefined, { archived: true }); await view.waitText("Nenhuma credencial basic-auth.");
    expect(view.container.textContent).toContain("arquivado");
    for (const action of ["Editar", "Gerar chave", "Nova credencial JWT", "Nova credencial basic-auth"]) expect(view.find(action)).toBeUndefined();
    await view.click("Grupos ACL"); await view.waitText("staff"); expect(view.find("Editar grupos")).toBeUndefined();
  });
  it.each([403, 404, 503])("keeps list HTTP %s separate from empty", async status => {
    const view = await mount("consumers", { respond: r => r.url.endsWith("/consumers") ? Response.json({ status }, { status }) : undefined });
    await view.waitText(status === 403 ? "permissão" : status === 404 ? "não encontrado" : "HTTP 503");
    expect(view.container.textContent).not.toContain("Nenhum consumidor");
  });
  it("keeps v1 labels and environment endpoints with legacy viewer permissions", async () => {
    const view = await mount("consumers", { legacy: true }); await view.waitText("checkout");
    expect(view.container.textContent).toContain("Consumers");
    expect(view.find("Novo consumer")).toBeUndefined();
    expect(view.requests.some(r => r.url.includes(`/api/v1/environments/${A}/consumers`))).toBe(true);
    expect(view.requests.some(r => r.url.includes(`/api/v2/workspaces/${A}/consumers`))).toBe(false);
  });
});
