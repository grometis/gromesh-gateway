import { act } from "react";
import type { Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installTestDom, type TestNode } from "../test/dom";

const W = "7c1d2e3f-4a5b-4c6d-8e7f-00000000000a";
const E = "7c1d2e3f-4a5b-4c6d-8e7f-00000000000b";
const stamp = "2026-11-03T12:00:00Z";
let root: Root | undefined;
let client: QueryClient;
afterEach(async () => { if (root) await act(() => root!.unmount()); root = undefined; client?.clear(); vi.unstubAllGlobals(); });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const visible = (node: TestNode): boolean => node.getAttribute("hidden") === null && (!node.parentNode || visible(node.parentNode));

async function screen({ path = "/tokens", role = "viewer", status = 200, compact = false, pending, archived = false, logoutResponse }: { path?: string; role?: "viewer" | "admin"; status?: number; compact?: boolean; pending?: "workspace" | "environment"; archived?: boolean; logoutResponse?: Promise<Response> } = {}) {
  vi.resetModules();
  const container = installTestDom();
  Object.assign(window.location, { origin: "https://prd.example.test" });
  const media = Object.assign(new EventTarget(), { matches: compact });
  Object.assign(window, { matchMedia: () => media });
  const NativeRequest = Request;
  vi.stubGlobal("Request", class extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) { super(typeof input === "string" ? new URL(input, "https://prd.example.test") : input, init); }
  });
  const sent: string[] = [];
  let releaseContext!: () => void;
  const ready = new Promise<void>((resolve) => { releaseContext = resolve; });
  vi.stubGlobal("fetch", async (request: Request) => {
    const url = new URL(request.url).pathname;
    sent.push(url);
    if (url === "/api/v1/me") return Response.json({ id: W, name: "Ana", email: "ana@example.test", role, environmentRoles: [{ environmentId: E, role: "admin" }], active: true, createdAt: stamp, updatedAt: stamp });
    if (url.endsWith("/auth/csrf")) return Response.json({ csrfToken: "csrf" });
    if (url.endsWith("/auth/logout") && logoutResponse) return logoutResponse;
    if (url.endsWith("workspace-creation-policy")) return Response.json({ stage: "dev" });
    if (url === `/api/v2/workspaces/${W}` || url === `/api/v2/workspaces/${E}`) {
      if (pending === "workspace") await ready;
      const id = url.split("/").at(-1)!;
      return Response.json({ id, key: id, name: "Workspace autorizado", slug: "autorizado", status: archived ? "archived" : "active", activeRelease: null }, { status });
    }
    const env = { id: E, name: "Ambiente confirmado", publishMode: "manual", currentVersion: null, hasUnpublishedChanges: false, createdAt: stamp, updatedAt: stamp };
    if (url === `/api/v1/environments/${E}`) {
      if (pending === "environment") await ready;
      return Response.json(env, { status });
    }
    if (url === "/api/v1/environments") return Response.json({ items: [env] });
    if (url === "/api/v2/workspaces") return Response.json({ items: [], nextCursor: null });
    return Response.json({ status: 404 }, { status: 404 });
  });
  const [{ AuthProvider }, { Shell }, { NavigationContextProvider }, { createMemoryRouter, RouterProvider }, { createRoot }] = await Promise.all([
    import("../auth"), import("./Shell"), import("../navigation/context"), import("react-router"), import("react-dom/client"),
  ]);
  const router = createMemoryRouter([{ element: <NavigationContextProvider><Shell /></NavigationContextProvider>, children: [
    { path: "/workspaces/:workspaceId/*", element: <h1>Gateway</h1> },
    { path: "/e/:envId/*", element: <h1>Legado</h1> },
    { path: "/tokens", element: <h1>Tokens</h1> },
    { path: "/workspaces", element: <h1>Workspaces</h1> },
  ] }], { initialEntries: [path] });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(container as unknown as HTMLElement);
  const settle = async () => { await act(async () => { await tick(); }); };
  await act(async () => { root!.render(<QueryClientProvider client={client}><AuthProvider><RouterProvider router={router} /></AuthProvider></QueryClientProvider>); await tick(); });
  await vi.waitFor(async () => { await settle(); expect(container.textContent).toContain("Instância DEV"); });
  const all = (predicate: (node: TestNode) => boolean) => container.findAll(predicate);
  const button = (label: string) => all((n) => n.tagName === "BUTTON" && n.textContent === label)[0]!;
  const panel = (label: string) => all((n) => n.getAttribute("id") === button(label).getAttribute("aria-controls"))[0]!;
  const click = async (node: TestNode) => { await act(async () => {
    const event = new Event("click", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "button", { value: 0 });
    node.dispatchEvent(event);
    await tick();
  }); };
  const focus = async (node: TestNode) => { await act(async () => { node.focus(); node.dispatchEvent(new Event("focusin", { bubbles: true })); await tick(); }); };
  const resize = async (matches: boolean) => { await act(async () => { media.matches = matches; media.dispatchEvent(new Event("change")); await tick(); }); };
  return { container, all, button, panel, click, focus, resize, router, settle, sent, releaseContext };
}

describe("global navigation", () => {
  it.each([
    { path: "/tokens", releases: undefined, requests: undefined },
    { path: `/workspaces/${W}/services`, releases: `/workspaces/${W}/releases`, requests: undefined },
    { path: `/e/${E}/services`, releases: `/e/${E}/releases`, requests: `/e/${E}/requests` },
  ])("uses confirmed namespaces on $path", async ({ path, releases, requests }) => {
    const view = await screen({ path });
    await vi.waitFor(async () => { await view.settle(); expect(view.container.textContent).not.toContain("Verificando contexto…"); });
    expect(view.all((n) => n.getAttribute("aria-label") === "Navegação global")).toHaveLength(1);
    await view.click(view.button("Operações"));
    const items = view.panel("Operações").findAll((n) => n.tagName === "A");
    expect(items.find((n) => n.textContent === "Releases")?.getAttribute("href")).toBe(releases);
    expect(items.find((n) => n.textContent === "Requisições")?.getAttribute("href")).toBe(requests);
    const disabled = view.panel("Operações").findAll((n) => n.getAttribute("aria-disabled") === "true");
    expect(disabled.length).toBe(path === "/tokens" ? 6 : requests ? 0 : 5);
    for (const item of disabled) {
      expect(item.getAttribute("href")).toBeNull();
      const reason = view.all((n) => n.getAttribute("id") === item.getAttribute("aria-describedby"))[0]!;
      expect(reason.textContent).toBe(item.textContent.startsWith("Releases") ? "Requer Workspace ou ambiente legado" : "Requer ambiente legado");
      expect(item.contains(reason)).toBe(false);
      expect(item.getAttribute("aria-label") ?? item.textContent).toBe(item.textContent);
    }
    const sidebar = view.all((n) => n.getAttribute("aria-label") === "Menu principal")[0]!;
    expect(sidebar.findAll((n) => n.tagName === "A").every((n) => !/releases|requests|metrics|publish|publications|clusters|tokens|users|audit/.test(n.getAttribute("href") ?? ""))).toBe(true);
    if (path.startsWith("/workspaces/")) expect(view.sent.some((p) => p.startsWith("/api/v1/environments"))).toBe(false);
  });
  it.each([
    { path: `/workspaces/${W}/services`, destination: `/workspaces/${W}/releases` },
    { path: `/e/${E}/services`, destination: `/e/${E}/releases` },
  ])("navigates to Releases by menu click from $path", async ({ path, destination }) => {
    const view = await screen({ path });
    await vi.waitFor(async () => { await view.settle(); expect(view.container.textContent).not.toContain("Verificando contexto…"); });
    await view.click(view.button("Operações"));
    const release = view.panel("Operações").findAll((n) => n.tagName === "A" && n.textContent === "Releases")[0]!;
    expect(release).toBeDefined();
    await view.click(release);
    expect(view.router.state.location.pathname).toBe(destination);
    expect(view.button("Operações").getAttribute("aria-expanded")).toBe("false");
  });
  it("lets keyboard users focus Operations to scroll even when every destination is unavailable", async () => {
    const view = await screen({ compact: true });
    await view.click(view.button("Menus globais"));
    await view.click(view.button("Operações"));
    const panel = view.panel("Operações");
    expect(panel.getAttribute("tabindex")).toBe("0");
    expect(panel.getAttribute("role")).toBe("region");
    const label = view.all((n) => n.getAttribute("id") === panel.getAttribute("aria-labelledby"))[0]!;
    expect(label.textContent).toBe("Operações");
    await view.focus(panel);
    expect(document.activeElement).toBe(panel);
    expect(visible(panel)).toBe(true);
  });
  it.each([false, true])("keeps a rejected logout visible after its disclosure closes (compact: %s), retaining the session", async (compact) => {
    let finishLogout!: (response: Response) => void;
    const logoutResponse = new Promise<Response>((resolve) => { finishLogout = resolve; });
    const view = await screen({ compact, logoutResponse });
    if (compact) await view.click(view.button("Menus globais"));
    await view.click(view.button("Minha conta"));
    const signOut = view.button("Sair");
    await view.focus(signOut);
    await view.click(signOut);
    await vi.waitFor(async () => { await view.settle(); expect(signOut.getAttribute("disabled")).not.toBeNull(); });
    // A disabled focused button can blur to body while the request is pending.
    document.body.focus();
    await act(() => {
      const blur = new Event("focusout", { bubbles: true });
      Object.defineProperty(blur, "relatedTarget", { value: null });
      signOut.dispatchEvent(blur);
    });
    expect(visible(view.panel("Minha conta"))).toBe(false);
    await act(async () => { finishLogout(Response.json({ title: "Forbidden", status: 403 }, { status: 403 })); await tick(); });
    await vi.waitFor(async () => {
      await view.settle();
      const alert = view.all((n) => n.getAttribute("role") === "alert")[0]!;
      expect(alert?.textContent).toContain("Você não tem permissão");
      expect(visible(alert)).toBe(true);
    });
    expect(view.router.state.location.pathname).toBe("/tokens");
    if (compact) await view.click(view.button("Menus globais"));
    await view.click(view.button("Minha conta"));
    expect(view.panel("Minha conta").textContent).toContain("ana@example.test");
    expect(view.button("Sair").getAttribute("disabled")).toBeNull();
    await view.focus(view.all((n) => n.tagName === "MAIN")[0]!);
    expect(visible(view.all((n) => n.getAttribute("role") === "alert")[0]!)).toBe(true);
  });
  it.each([403, 404, 502].flatMap((status) => [
    { path: `/workspaces/${W}/services`, status }, { path: `/e/${E}/services`, status },
  ]))("keeps operations disabled after denied/unavailable confirmation ($status on $path)", async ({ path, status }) => {
    const view = await screen({ path, status });
    await view.click(view.button("Operações"));
    expect(view.panel("Operações").findAll((n) => n.tagName === "A")).toHaveLength(0);
    const release = view.panel("Operações").findAll((n) => n.getAttribute("aria-disabled") === "true" && n.textContent === "Releases")[0]!;
    const requirement = view.all((n) => n.getAttribute("id") === release.getAttribute("aria-describedby"))[0]!;
    expect(requirement.textContent).toBe(path.startsWith("/e/") ? "Requer ambiente legado" : "Requer Workspace");
  });
  it.each([
    { path: `/workspaces/${W}/services`, pending: "workspace" as const, links: 1 },
    { path: `/e/${E}/services`, pending: "environment" as const, links: 6 },
  ])("enables only the confirmed namespace after loading on $path", async ({ path, pending, links }) => {
    const view = await screen({ path, pending });
    await view.click(view.button("Operações"));
    expect(view.panel("Operações").findAll((n) => n.getAttribute("aria-disabled") === "true")).toHaveLength(6);
    await act(async () => { view.releaseContext(); await tick(); });
    await vi.waitFor(async () => { await view.settle(); expect(view.panel("Operações").findAll((n) => n.tagName === "A")).toHaveLength(links); });
    expect(view.button("Operações").getAttribute("aria-expanded")).toBe("true");
  });
  it("keeps archived Workspace Releases readable without enabling legacy destinations", async () => {
    const view = await screen({ path: `/workspaces/${W}/releases`, archived: true });
    await view.click(view.button("Operações"));
    expect(view.panel("Operações").findAll((n) => n.tagName === "A").map((n) => n.getAttribute("href"))).toEqual([`/workspaces/${W}/releases`]);
  });
  it.each([`/e/${E}/publications/3`, `/e/${E}/releases`])("marks the operations section without duplicating page identity on %s", async (path) => {
    const view = await screen({ path });
    await view.click(view.button("Operações"));
    expect(view.button("Operações").getAttribute("data-active")).toBe("true");
    expect(view.button("Operações").getAttribute("aria-current")).toBeNull();
    const current = view.all((n) => n.getAttribute("aria-current") === "page");
    expect(current.map((n) => n.textContent)).toEqual(path.endsWith("/3") ? ["Publicações"] : ["Releases"]);
  });
  it.each(["viewer", "admin"] as const)("matches RequireAdmin for %s, even with a local admin override", async (role) => {
    const view = await screen({ role, path: `/e/${E}/services` });
    await view.click(view.button("Instância"));
    expect(view.panel("Instância").findAll((n) => n.tagName === "A").map((n) => n.textContent)).toEqual(role === "admin" ? ["Workspaces", "Usuários", "Auditoria"] : ["Workspaces"]);
    await view.click(view.button("Minha conta"));
    expect(view.panel("Minha conta").textContent).toContain("Ana");
    expect(view.panel("Minha conta").textContent).toContain("ana@example.test");
    expect(view.panel("Minha conta").textContent).toContain("Papel legado: Administrador");
  });
  it("toggles one disclosure, closes on Escape with focus, outside click and leaving focus", async () => {
    const view = await screen();
    const ops = view.button("Operações");
    await view.click(ops);
    expect(ops.getAttribute("aria-expanded")).toBe("true");
    await view.click(view.button("Instância"));
    expect(ops.getAttribute("aria-expanded")).toBe("false");
    const link = view.panel("Instância").findAll((n) => n.tagName === "A")[0]!;
    await view.focus(link);
    await act(async () => { const event = new Event("keydown", { bubbles: true, cancelable: true }); Object.defineProperty(event, "key", { value: "Escape" }); link.dispatchEvent(event); });
    expect(view.button("Instância").getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(view.button("Instância"));
    await view.click(ops);
    const main = view.all((n) => n.tagName === "MAIN")[0]!;
    await act(() => { main.dispatchEvent(new Event("pointerdown", { bubbles: true })); main.dispatchEvent(new Event("click", { bubbles: true })); });
    expect(ops.getAttribute("aria-expanded")).toBe("false");
    await view.click(ops);
    await view.focus(main);
    expect(ops.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(main);
  });
  it.each([false, true])("closes each group when clicking instance identity inside the header (compact: %s)", async (compact) => {
    const view = await screen({ compact });
    if (compact) await view.click(view.button("Menus globais"));
    const identity = view.all((n) => n.getAttribute("aria-label") === "Identidade da instância")[0]!;
    for (const section of ["Operações", "Instância", "Minha conta"]) {
      await view.click(view.button(section));
      await view.click(view.panel(section));
      expect(view.button(section).getAttribute("aria-expanded")).toBe("true");
      await act(() => { identity.dispatchEvent(new Event("pointerdown", { bubbles: true })); });
      expect(view.button(section).getAttribute("aria-expanded")).toBe("true");
      await view.click(identity);
      expect(view.button(section).getAttribute("aria-expanded")).toBe("false");
      if (compact) expect(view.button("Menus globais").getAttribute("aria-expanded")).toBe("true");
    }
  });
  it("closes on navigation, clears prior context and focuses main without polling stealing focus", async () => {
    const view = await screen({ path: `/workspaces/${W}/releases` });
    await view.click(view.button("Operações"));
    expect(view.button("Operações").getAttribute("data-active")).toBe("true");
    expect(view.button("Operações").getAttribute("aria-current")).toBeNull();
    await act(async () => { await view.router.navigate("/tokens"); });
    expect(view.button("Operações").getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement?.tagName).toBe("MAIN");
    await view.click(view.button("Minha conta"));
    const token = view.panel("Minha conta").findAll((n) => n.tagName === "A")[0]!;
    expect(token.getAttribute("aria-current")).toBe("page");
    await view.focus(token);
    await act(async () => { client.setQueryData(["workspace-creation-policy"], { stage: "hml" }); await tick(); });
    expect(document.activeElement).toBe(token);
    await view.click(view.button("Operações"));
    expect(view.panel("Operações").findAll((n) => n.tagName === "A")).toHaveLength(0);
  });
  it("restores focus across breakpoints using focusin history even after CSS has moved focus to body", async () => {
    const view = await screen();
    await view.click(view.button("Instância"));
    await view.focus(view.panel("Instância").findAll((n) => n.tagName === "A")[0]!);
    // Browsers may blur a newly hidden link before dispatching matchMedia.change.
    document.body.focus();
    await view.resize(true);
    expect(document.activeElement).toBe(view.button("Menus globais"));
    expect(visible(view.button("Instância"))).toBe(false);
    await view.click(view.button("Menus globais"));
    await view.click(view.button("Minha conta"));
    await view.focus(view.panel("Minha conta").findAll((n) => n.tagName === "A")[0]!);
    document.body.focus();
    await view.resize(false);
    expect(document.activeElement).toBe(view.button("Minha conta"));
    expect(view.button("Minha conta").getAttribute("aria-expanded")).toBe("false");
  });
  it("waits for hidden groups to render before restoring desktop focus from the compact toggle", async () => {
    const view = await screen();
    const operations = view.button("Operações");
    const nativeFocus = operations.focus.bind(operations);
    // Model the browser refusing focus while an ancestor still has hidden.
    operations.focus = () => { if (visible(operations)) nativeFocus(); };
    await view.focus(operations);
    await view.resize(true);
    await view.focus(view.button("Menus globais"));
    await view.resize(false);
    expect(document.activeElement).toBe(operations);
  });
  it("does not move an outside pointer target by collapsing compact menus before its click", async () => {
    const view = await screen({ compact: true });
    await view.click(view.button("Menus globais"));
    await view.click(view.button("Operações"));
    const main = view.all((n) => n.tagName === "MAIN")[0]!;
    await act(() => { main.dispatchEvent(new Event("pointerdown", { bubbles: true })); });
    await view.focus(main);
    expect(view.button("Menus globais").getAttribute("aria-expanded")).toBe("true");
    expect(view.button("Operações").getAttribute("aria-expanded")).toBe("true");
    await view.click(main);
    expect(view.button("Menus globais").getAttribute("aria-expanded")).toBe("false");
    expect(view.button("Operações").getAttribute("aria-expanded")).toBe("false");
  });
  it("closes when focus leaves the document without losing the breakpoint focus context", async () => {
    const view = await screen();
    await view.click(view.button("Instância"));
    const link = view.panel("Instância").findAll((n) => n.tagName === "A")[0]!;
    await view.focus(link);
    await act(() => {
      const event = new Event("focusout", { bubbles: true });
      Object.defineProperty(event, "relatedTarget", { value: null });
      link.dispatchEvent(event);
    });
    expect(view.button("Instância").getAttribute("aria-expanded")).toBe("false");
    await view.resize(true);
    expect(document.activeElement).toBe(view.button("Menus globais"));
  });
});
