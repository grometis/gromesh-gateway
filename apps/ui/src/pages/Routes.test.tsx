import { act } from "react";
import type { Root } from "react-dom/client";
import { installTestDom, type TestNode } from "../test/dom";
import { MutationObserver, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceRoute } from "../api/client-v2";
import { publicPath, upstreamEffect } from "./workspace-gateway";

const W = "6d3e8b20-4c5e-4d6f-9a70-00000000000a";
const B = "6d3e8b20-4c5e-4d6f-9a70-00000000000b";
const NOW = "2026-10-30T12:00:00Z";
const route = (extra: Partial<WorkspaceRoute> = {}): WorkspaceRoute => ({
  id: "6d3e8b20-4c5e-4d6f-9a70-0000000000d1", name: "recarga", serviceId: "6d3e8b20-4c5e-4d6f-9a70-0000000000c1", paths: ["/recarga"],
  protocols: ["http", "https"], stripPath: true, preserveHost: false, headers: { "x-canal": ["app"] }, analyticsRetentionDays: 3, pathCompatibility: "workspace-default",
  createdAt: NOW, updatedAt: NOW, ...extra,
});
const values = { name: "recarga", serviceId: "6d3e8b20-4c5e-4d6f-9a70-0000000000c1", paths: ["/recarga"], hosts: [], methods: ["GET"], protocols: ["https" as const], stripPath: false, preserveHost: false, tags: [] };

let sent: Request[] = [];
let root: Root | undefined;
let client: QueryClient | undefined;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => { sent = []; });
afterEach(async () => {
  if (root) await act(() => root!.unmount());
  root = undefined;
  client?.clear();
  client = undefined;
  vi.unstubAllGlobals();
  expect(sent.filter((r) => r.method === "PUT" && new URL(r.url).pathname.startsWith("/api/v1/environments/"))).toEqual([]);
});

async function load(respond: (request: Request) => Promise<Response>) {
  vi.resetModules();
  const NativeRequest = Request;
  vi.stubGlobal("Request", class extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(typeof input === "string" ? new URL(input, "https://ui.example") : input, init);
    }
  });
  vi.stubGlobal("fetch", vi.fn((request: Request) => {
    sent.push(request);
    return request.url.endsWith("/api/v1/auth/csrf")
      ? Promise.resolve(Response.json({ csrfToken: "csrf" }))
      : respond(request);
  }));
  return import("./Routes");
}

describe("public paths", () => {
  it("prefixes every path with the workspace slug; a regex stays a regex", () => {
    expect(publicPath("tvro", "/recarga")).toBe("/tvro/recarga");
    expect(publicPath("tvro", "/")).toBe("/tvro/");
    expect(publicPath("tvro", "~/v[0-9]+/pix")).toBe("~/tvro(?:/v[0-9]+/pix)");
  });

  it("says what the upstream receives with and without stripPath", () => {
    expect(upstreamEffect("tvro", "/recarga", false)).toBe("Uma requisição a /tvro/recarga/x chega ao upstream como /tvro/recarga/x.");
    expect(upstreamEffect("tvro", "/recarga", true)).toBe("Uma requisição a /tvro/recarga/x chega ao upstream como /x.");
    expect(upstreamEffect("tvro", "/", false)).toBe("Uma requisição a /tvro/x chega ao upstream como /tvro/x.");
  });
});

describe("saving a workspace route", () => {
  it("sends the user's stripPath on a workspace-default route and keeps what the form does not edit", async () => {
    const { routeBody } = await load(() => new Promise(() => {}));
    expect(routeBody(null, values)).toEqual(values);
    expect(routeBody(route(), values)).toEqual({ ...values, headers: { "x-canal": ["app"] }, analyticsRetentionDays: 3 });
    expect(routeBody(route(), values).stripPath).toBe(false);
  });

  it.each([true, false])("sends the original stripPath %s for a legacy route with paths through v2", async (stripPath) => {
    const stored = route({ pathCompatibility: "legacy-preserved", stripPath });
    const view = await screen([stored]);
    await view.click("Editar");
    expect(view.dialog()!.findAll((node) => node.tagName === "LABEL" && node.textContent.includes("stripPath"))).toHaveLength(0);
    expect(view.dialog()!.textContent).toContain(`stripPath atual: ${stripPath ? "sim" : "não"}`);
    await view.input("Nome", "renamed-legacy");
    await view.submit();
    expect(view.dialog()).toBeUndefined();
    const put = sent.find((r) => r.method === "PUT")!;
    expect(new URL(put.url).pathname).toBe(`/api/v2/workspaces/${W}/routes/${stored.id}`);
    const body = await put.json();
    expect(body).toMatchObject({ name: "renamed-legacy", stripPath, paths: ["/recarga"] });
    expect(body).not.toHaveProperty("pathCompatibility");
  });

  it("sends only the fields the write schema declares, whatever the response carried", async () => {
    const { routeBody } = await load(() => new Promise(() => {}));
    const stored = { ...route(), workspaceId: W, extra: 1 } as WorkspaceRoute;
    expect(Object.keys(routeBody(stored, values)).sort()).toEqual(
      ["analyticsRetentionDays", "headers", "hosts", "methods", "name", "paths", "preserveHost", "protocols", "serviceId", "stripPath", "tags"],
    );
  });

  it.each(["manual", "auto"])("has no write path for a pathless legacy route in %s mode", async (publishMode) => {
    const { saveRouteMutation } = await load(() => Promise.resolve(Response.json({ id: W, publishMode })));
    const onSaved = vi.fn();
    const invalidate = vi.fn();
    const observer = new MutationObserver(new QueryClient(), saveRouteMutation(W, pathless(), invalidate, onSaved));
    await expect(observer.mutate(values)).rejects.toThrow("read-only");
    expect(sent).toEqual([]);
    expect(onSaved).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("reports success only after the 200, and a path-compatibility 409 lands on stripPath", async () => {
    let resolve!: (r: Response) => void;
    const { saveRouteMutation } = await load(() => new Promise((r) => (resolve = r)));
    const { gatewayFormErrors, GATEWAY_MESSAGES } = await import("./gateway-errors");
    const onSaved = vi.fn();
    const invalidate = vi.fn();
    const observer = new MutationObserver(new QueryClient(), saveRouteMutation(W, route(), invalidate, onSaved));
    const done = observer.mutate(values);
    await new Promise((r) => setTimeout(r, 0));
    expect(sent.filter((r) => r.method !== "GET").map((r) => [r.method, new URL(r.url).pathname])).toEqual([["PUT", `/api/v2/workspaces/${W}/routes/${route().id}`]]);
    expect(onSaved).not.toHaveBeenCalled();
    resolve(Response.json(
      { type: "https://gromesh.dev/problems/path-compatibility", title: "Conflict", status: 409, code: "path-compatibility", errors: [{ path: "stripPath", message: "differs" }] },
      { status: 409, headers: { "Content-Type": "application/problem+json" } },
    ));
    await expect(done).rejects.toMatchObject({ status: 409 });
    expect(onSaved).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
    expect(gatewayFormErrors(observer.getCurrentResult().error, "route").fields).toEqual({ stripPath: [GATEWAY_MESSAGES.pathCompatibility] });
  });
});

// Mount the real page and router: workspace changes must discard React form state.
async function screen(stored: WorkspaceRoute[] = []) {
  const container = installTestDom();
  const { RoutesPage } = await load(async (request) => {
    const path = new URL(request.url).pathname;
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    if (["POST", "PUT"].includes(request.method)) {
      const current = stored.find((r) => path.endsWith(`/${r.id}`)) ?? route();
      return Response.json({ ...current, ...await request.clone().json() });
    }
    const workspaceId = path.includes(B) ? B : W;
    const name = workspaceId === W ? "service-a" : "service-b";
    if (path.endsWith("/services")) return Response.json({ items: [{
      id: workspaceId === W ? values.serviceId : "service-b-id", workspaceId, name, path: null,
      protocol: "http", host: `${name}.internal`, port: 80, enabled: true, createdAt: NOW, updatedAt: NOW,
    }], nextCursor: null });
    if (path.endsWith("/routes")) return Response.json({ items: workspaceId === W ? stored : [], nextCursor: null });
    if (path.startsWith("/api/v2/workspaces/")) return Response.json({ id: workspaceId, name, slug: workspaceId === W ? "a" : "b", activeRelease: null });
    if (path.startsWith("/api/v1/environments/")) return Response.json({ id: workspaceId, name, publishMode: "manual", hasUnpublishedChanges: false });
    throw new Error(`Unexpected request: ${request.method} ${path}`);
  });
  const { createMemoryRouter, RouterProvider } = await import("react-router");
  const router = createMemoryRouter([{ path: "/e/:envId/routes", element: <RoutesPage /> }], { initialEntries: [`/e/${W}/routes`] });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const { createRoot } = await import("react-dom/client");
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => {
    root!.render(<QueryClientProvider client={client!}><RouterProvider router={router} /></QueryClientProvider>);
    await tick();
  });
  await act(async () => { await tick(); });
  const buttons = (name: string, scope = container) => scope.findAll((node) => node.tagName === "BUTTON" && node.textContent === name);
  const click = async (name: string) => {
    const button = buttons(name)[0];
    expect(button, `button ${name}`).toBeDefined();
    await act(async () => { button!.dispatchEvent(new Event("click", { bubbles: true })); await tick(); });
  };
  const dialog = () => container.findAll((node) => node.getAttribute("role") === "dialog")[0];
  const field = (label: string): TestNode => {
    const node = dialog()!.findAll((n) => n.tagName === "LABEL" && n.textContent === label)[0]!;
    return dialog()!.findAll((n) => n.getAttribute("id") === node.getAttribute("for"))[0]!;
  };
  const input = async (label: string, value: string) => {
    await act(async () => {
      const node = field(label);
      node.value = value;
      node.dispatchEvent(new Event("input", { bubbles: true }));
      await tick();
    });
  };
  const submit = async () => {
    const form = dialog()!.findAll((node) => node.tagName === "FORM")[0]!;
    await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await tick(); });
    await act(async () => { await tick(); });
  };
  return { container, router, buttons, click, dialog, field, input, submit };
}

const pathless = () => route({ pathCompatibility: "legacy-preserved", paths: [], hosts: ["boletos.example"], methods: ["GET"], tags: ["legado"] });

describe("routes screen", () => {
  it("offers only read-only details for a pathless legacy route", async () => {
    const view = await screen([pathless()]);
    expect(view.container.textContent).toContain("Legada");
    expect(view.buttons("Editar")).toHaveLength(0);
    expect(view.buttons("Plugins")).toHaveLength(0);
    expect(view.container.findAll((node) => node.getAttribute("aria-haspopup") === "menu")).toHaveLength(0);
    await view.click("Ver detalhes");
    const details = view.dialog()!;
    expect(details).toBeDefined();
    expect(details.textContent).toContain("fluxo legado apropriado ou uma conversão explícita e auditada");
    expect(details.textContent).toContain("a tela v2 não a edita");
    for (const text of ["recarga", "service-a", "boletos.example", "GET", "https", "legado", "x-canal", "app", "stripPath"]) expect(details.textContent).toContain(text);
    expect(view.buttons("Salvar", details)).toHaveLength(0);
    expect(details.findAll((node) => ["INPUT", "TEXTAREA", "SELECT", "FORM"].includes(node.tagName))).toHaveLength(0);
    await view.click("Fechar");
    expect(view.dialog()).toBeUndefined();
    expect(sent.every((r) => r.method === "GET")).toBe(true);
  });

  it("keeps pathless legacy details read-only when publication changes from manual to auto", async () => {
    const view = await screen([pathless()]);
    await view.click("Ver detalhes");
    await act(async () => {
      client!.setQueryData(["environment", W], { id: W, publishMode: "auto", hasUnpublishedChanges: false });
      await tick();
    });
    expect(view.dialog()).toBeDefined();
    expect(view.buttons("Salvar")).toHaveLength(0);
    expect(view.buttons("Editar")).toHaveLength(0);
    await view.click("Fechar");
    await view.click("Ver detalhes");
    await act(async () => { await view.router.navigate(`/e/${B}/routes`); await tick(); });
    expect(view.dialog()).toBeUndefined();
    expect(sent.every((r) => r.method === "GET")).toBe(true);
  });

  it("creates and deletes routes through v2 without a v1 PUT", async () => {
    const view = await screen([route()]);
    await view.click("Nova route");
    await view.input("Nome", "new-route-a");
    await view.input("Paths", "/new-route-a");
    await view.submit();
    expect(view.dialog()).toBeUndefined();
    const post = sent.find((r) => r.method === "POST")!;
    expect(new URL(post.url).pathname).toBe(`/api/v2/workspaces/${W}/routes`);
    expect(await post.json()).toMatchObject({ name: "new-route-a", serviceId: values.serviceId, paths: ["/new-route-a"], stripPath: false });
    const menu = view.container.findAll((node) => node.getAttribute("aria-haspopup") === "menu")[0]!;
    await act(async () => { menu.dispatchEvent(new Event("click", { bubbles: true })); await tick(); });
    await view.click("Excluir");
    await view.click("Excluir");
    await act(async () => { await tick(); });
    expect(view.dialog()).toBeUndefined();
    expect(sent.filter((r) => r.method === "DELETE").map((r) => new URL(r.url).pathname)).toEqual([`/api/v2/workspaces/${W}/routes/${route().id}`]);
  });

  it("offers only services of the current workspace and discards an open form on workspace change", async () => {
    const view = await screen();
    // Warm B's cache first, then return to A, so leaking cached service choices is observable.
    await act(async () => { await view.router.navigate(`/e/${B}/routes`); await tick(); });
    await act(async () => { await tick(); });
    await act(async () => { await view.router.navigate(`/e/${W}/routes`); await tick(); });
    await view.click("Nova route");
    expect(view.field("Service").options.map((node) => node.textContent)).toEqual(["service-a"]);
    await view.input("Nome", "unsaved-route-a");
    expect(view.field("Nome").value).toBe("unsaved-route-a");
    await act(async () => { await view.router.navigate(`/e/${B}/routes`); await tick(); });
    expect(view.dialog()).toBeUndefined();
    await view.click("Nova route");
    expect(view.field("Nome").value).toBe("");
    expect(view.field("Service").options.map((node) => node.textContent)).toEqual(["service-b"]);
    await act(async () => { await view.router.navigate(`/e/${W}/routes`); await tick(); });
    expect(view.dialog()).toBeUndefined();
    await view.click("Nova route");
    expect(view.field("Nome").value).toBe("");
  });
});
