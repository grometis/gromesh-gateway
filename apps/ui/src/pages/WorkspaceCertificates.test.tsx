import { act } from "react";
import type { Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installTestDom, type TestNode } from "../test/dom";
import { TEST_CERTIFICATE, TEST_PRIVATE_KEY } from "../test/pem";
import type { WorkspaceCertificate } from "./workspace-certificates";

const W = "6d3e8b20-4c5e-4d6f-9a70-00000000000a";
const B = "6d3e8b20-4c5e-4d6f-9a70-00000000000b";
const C = "6d3e8b20-4c5e-4d6f-9a70-0000000000c1";
const cert = TEST_CERTIFICATE;
const saved: WorkspaceCertificate = { id: C, cert, snis: ["api.example.test"], subject: "CN=api.example.test", issuer: "CN=Test CA", notBefore: "2026-01-01T00:00:00Z", notAfter: "2099-01-01T00:00:00Z", fingerprintSha256: "AA:BB", tags: ["tls"], createdAt: "2026-11-03T12:00:00Z", updatedAt: "2026-11-03T12:00:00Z" };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
let root: Root | undefined;
let client: QueryClient;
afterEach(async () => { if (root) await act(() => root!.unmount()); root = undefined; client?.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function screen(options: {
  items?: WorkspaceCertificate[]; archived?: boolean;
  read?: (request: Request) => Response | Promise<Response> | undefined;
  write?: (request: Request) => Response | Promise<Response>;
} = {}) {
  vi.resetModules();
  const container = installTestDom();
  const NativeRequest = Request;
  vi.stubGlobal("Request", class extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) { super(typeof input === "string" ? new URL(input, "https://ui.example") : input, init); }
  });
  const requests: Request[] = [];
  let items = options.items ?? [saved];
  vi.stubGlobal("fetch", async (request: Request) => {
    const path = new URL(request.url).pathname;
    requests.push(request.clone());
    if (path.endsWith("/auth/csrf")) return Response.json({ csrfToken: "csrf" });
    if (request.method === "GET") {
      const response = options.read?.(request);
      if (response) return response;
      const id = path.includes(B) ? B : W;
      if (path === `/api/v2/workspaces/${id}`) return Response.json({ id, key: id, name: "Workspace", slug: "teste", status: options.archived ? "archived" : "active", activeRelease: null });
      if (path.endsWith("/certificates")) return Response.json({ items: id === W ? items : [], nextCursor: null });
    } else {
      if (options.write) return options.write(request);
      if (request.method === "DELETE") { items = []; return new Response(null, { status: 204 }); }
      const body = await request.json() as { cert: string; snis: string[]; tags: string[] };
      items = [{ ...saved, cert: body.cert, snis: body.snis, tags: body.tags }];
      return Response.json({ ...items[0], key: "REDACTED" }, { status: request.method === "POST" ? 201 : 200 });
    }
    throw new Error(`Unexpected request ${request.method} ${path}`);
  });
  const [{ WorkspaceCertificatesPage }, { createMemoryRouter, RouterProvider }, { NavigationContextProvider, NavigationContextBoundary }, { createRoot }] = await Promise.all([
    import("./WorkspaceCertificates"), import("react-router"), import("../navigation/context"), import("react-dom/client"),
  ]);
  const router = createMemoryRouter([{ element: <NavigationContextProvider />, children: [{ path: "/workspaces/:workspaceId/certificates", element: <NavigationContextBoundary><WorkspaceCertificatesPage /></NavigationContextBoundary> }] }], { initialEntries: [`/workspaces/${W}/certificates`] });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => { root!.render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>); await tick(); });
  await act(async () => { await tick(); });
  const buttons = (name: string) => container.findAll(n => n.tagName === "BUTTON" && n.textContent === name);
  const dialog = () => container.findAll(n => n.getAttribute("role") === "dialog")[0];
  const click = async (name: string) => {
    await vi.waitFor(async () => { await act(tick); expect(buttons(name)[0], name).toBeDefined(); });
    await act(async () => { buttons(name)[0]!.dispatchEvent(new Event("click", { bubbles: true })); await tick(); });
    await act(tick);
  };
  const field = (label: string): TestNode => {
    const node = dialog()!.findAll(n => n.tagName === "LABEL" && n.textContent === label)[0]!;
    return dialog()!.findAll(n => n.getAttribute("id") === node.getAttribute("for"))[0]!;
  };
  const input = async (label: string, value: string) => { await act(async () => { field(label).value = value; field(label).dispatchEvent(new Event("input", { bubbles: true })); await tick(); }); };
  const submit = async () => { await act(async () => { dialog()!.findAll(n => n.tagName === "FORM")[0]!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await tick(); }); await act(tick); };
  return { container, router, requests, buttons, dialog, click, field, input, submit, writes: () => requests.filter(r => r.method !== "GET") };
}

describe("Workspace certificate forms", () => {
  it("creates PEM, edits with REDACTED and confirms deletion without saving the key in QueryClient", async () => {
    const view = await screen({ items: [] });
    await vi.waitFor(async () => { await act(tick); expect(view.container.textContent).toContain("Nenhum certificado neste Workspace."); });
    await view.click("Novo certificado");
    await view.input("Certificado (PEM)", cert);
    await view.input("Chave privada (PEM)", TEST_PRIVATE_KEY);
    await view.input("SNIs", "API.example.test");
    await view.submit();
    expect(view.dialog()).toBeUndefined();
    expect(await view.writes()[0]!.json()).toEqual({ cert, key: TEST_PRIVATE_KEY, snis: ["api.example.test"], tags: [] });
    await view.click("Editar");
    expect(view.field("Chave privada (PEM)").value).toBe("");
    await view.submit();
    expect(await view.writes()[1]!.json()).toMatchObject({ cert, key: "REDACTED" });
    await view.click("⋯");
    await view.click("Excluir");
    expect(view.writes()).toHaveLength(2);
    await view.click("Cancelar");
    expect(view.writes()).toHaveLength(2);
    await view.click("⋯"); await view.click("Excluir"); await view.click("Excluir");
    expect(view.writes().map(r => r.method)).toEqual(["POST", "PUT", "DELETE"]);
    await vi.waitFor(async () => { await act(tick); expect(view.container.textContent).toContain("Nenhum certificado neste Workspace."); });
    expect(JSON.stringify(client.getQueryCache().getAll().map(q => q.state))).not.toContain("MIGHAgEA");
    expect(client.getMutationCache().getAll()).toHaveLength(0);
    expect(view.requests.some(r => new URL(r.url).pathname.startsWith("/api/v1/environments"))).toBe(false);
  });
  it.each(["Cancelar", "Fechar"])("clears unsaved PEM when closing with %s", async action => {
    const view = await screen(); await view.click("Novo certificado");
    await view.input("Chave privada (PEM)", TEST_PRIVATE_KEY);
    if (action === "Fechar") {
      const close = view.dialog()!.findAll(n => n.getAttribute("aria-label") === "Fechar")[0]!;
      await act(() => { close.dispatchEvent(new Event("click", { bubbles: true })); });
    } else await view.click(action);
    await view.click("Novo certificado");
    expect(view.field("Chave privada (PEM)").value).toBe(""); expect(view.writes()).toHaveLength(0);
  });
  it.each([204, 409, 403])("keeps Y's confirmation isolated from X's late DELETE %s and reflects X's result in the list", async status => {
    const other = { ...saved, id: B, subject: "CN=other.example.test", snis: ["other.example.test"] };
    let release!: (response: Response) => void;
    const held = new Promise<Response>(resolve => { release = resolve; });
    let committed = false;
    const view = await screen({
      items: [saved, other],
      write: () => held,
      read: request => committed && new URL(request.url).pathname.endsWith("/certificates") ? Response.json({ items: [other], nextCursor: null }) : undefined,
    });
    const openDelete = async (subject: string) => {
      const menu = view.container.findAll(node => node.getAttribute("aria-label") === `Mais ações para ${subject}`)[0]!;
      await act(async () => { menu.dispatchEvent(new Event("click", { bubbles: true })); await tick(); });
      await view.click("Excluir");
    };
    await vi.waitFor(async () => { await act(tick); expect(view.container.textContent).toContain(other.subject); });
    await openDelete(saved.subject!); await view.click("Excluir");
    expect(view.writes().map(request => [request.method, new URL(request.url).pathname])).toEqual([["DELETE", `/api/v2/workspaces/${W}/certificates/${C}`]]);
    await view.click("Cancelar"); await openDelete(other.subject);
    const dialog = view.dialog()!;
    expect(dialog.textContent).toContain("other.example.test");
    await act(async () => {
      committed = status === 204;
      release(status === 204 ? new Response(null, { status }) : Response.json({ title: "Rejected", status }, { status }));
      await tick();
    });
    await vi.waitFor(async () => {
      await act(tick);
      expect(view.dialog() === dialog).toBe(true);
      expect(dialog.textContent).toContain("other.example.test");
      expect(dialog.findAll(node => node.getAttribute("role") === "alert")).toHaveLength(0);
      expect(view.buttons("Excluir")[0]!.getAttribute("disabled")).toBeNull();
      const table = view.container.findAll(node => node.tagName === "TABLE")[0]!;
      expect(table.textContent).toContain(other.subject);
      if (status === 204) expect(table.textContent).not.toContain(saved.subject);
      else expect(table.textContent).toContain(saved.subject);
    });
    expect(view.writes()).toHaveLength(1);
  });
  it("discards form and data on A→B, including a return to cached A", async () => {
    const view = await screen(); await view.click("Editar"); await view.input("Chave privada (PEM)", TEST_PRIVATE_KEY);
    await act(async () => { await view.router.navigate(`/workspaces/${B}/certificates`); await tick(); });
    expect(view.dialog()).toBeUndefined(); expect(view.container.textContent).not.toContain("CN=api.example.test");
    await view.click("Novo certificado"); expect(view.field("Chave privada (PEM)").value).toBe("");
    await act(async () => { await view.router.navigate(`/workspaces/${W}/certificates`); await tick(); });
    await view.click("Editar"); expect(view.field("Chave privada (PEM)").value).toBe(""); expect(view.writes()).toHaveLength(0);
  });
  it.each([403, 409, 422, 500])("keeps the failed save explicit and clears the submitted key on %s", async status => {
    const view = await screen({ write: () => Response.json({ title: "Rejected", status, detail: TEST_PRIVATE_KEY, errors: [{ path: "key", message: TEST_PRIVATE_KEY }] }, { status }) });
    await view.click("Editar"); await view.input("Chave privada (PEM)", TEST_PRIVATE_KEY); await view.submit();
    expect(view.field("Chave privada (PEM)").value).toBe("");
    expect(view.dialog()!.textContent).not.toContain("MIGHAgEA");
    expect(view.dialog()!.findAll(n => n.getAttribute("role") === "alert").length).toBeGreaterThan(0);
    expect(view.container.textContent).toContain("CN=api.example.test");
    if (status === 403) { await view.submit(); expect(view.writes()).toHaveLength(1); }
    expect(client.getMutationCache().getAll()).toHaveLength(0);
  });
  it.each([
    { status: 403, text: "permissão" },
    { status: 404, text: "não encontrado" },
    { status: 409, text: "instância" },
    { status: 409, code: "auto-publish", text: "publicação manual" },
    { status: 422, path: "key", message: "does not match the leaf certificate", text: "não corresponde" },
    { status: 422, path: "cert", message: "variable CERT is not declared in this workspace", text: "variáveis ainda não são suportadas" },
  ])("keeps a sanitized Portuguese error open without replaying the key: $status $text", async failure => {
    const view = await screen({ write: () => Response.json({
      title: "Rejected", status: failure.status, code: failure.code, detail: TEST_PRIVATE_KEY,
      errors: failure.path ? [{ path: failure.path, message: failure.message }] : [],
    }, { status: failure.status }) });
    await view.click("Editar"); await view.input("Chave privada (PEM)", TEST_PRIVATE_KEY); await view.submit();
    const dialog = view.dialog()!;
    expect(dialog).toBeDefined();
    expect(dialog.findAll(node => node.getAttribute("role") === "alert").map(node => node.textContent).join(" ")).toContain(failure.text);
    expect(view.field("Chave privada (PEM)").value).toBe("");
    expect(dialog.textContent).not.toContain("MIGHAgEA");
    expect(view.writes()).toHaveLength(1);
    expect(await view.writes()[0]!.json()).toMatchObject({ key: TEST_PRIVATE_KEY });
    await view.submit();
    if (failure.status === 403) expect(view.writes()).toHaveLength(1);
    else {
      expect(view.writes()).toHaveLength(2);
      expect(await view.writes()[1]!.json()).toMatchObject({ key: "REDACTED" });
    }
    expect(view.dialog()).toBe(dialog);
    expect(JSON.stringify(client.getQueryCache().getAll().map(query => query.state))).not.toContain("MIGHAgEA");
    expect(client.getMutationCache().getAll()).toHaveLength(0);
  });
  it("shows archived certificates without write actions", async () => {
    const view = await screen({ archived: true });
    await vi.waitFor(async () => { await act(tick); expect(view.container.textContent).toContain("CN=api.example.test"); }); expect(view.container.textContent).toContain("arquivado");
    expect(view.buttons("Novo certificado")).toHaveLength(0); expect(view.buttons("Editar")).toHaveLength(0);
    await view.click("Ver metadados"); expect(view.dialog()!.textContent).toContain("AA:BB"); expect(view.writes()).toHaveLength(0);
  });
  it("renders unknown metadata and VarRef as unavailable, never expired", async () => {
    const view = await screen({ items: [{ ...saved, cert: { $var: "CERT" }, subject: null, issuer: null, notBefore: null, notAfter: null, fingerprintSha256: null }] });
    await vi.waitFor(async () => { await act(tick); expect(view.container.textContent).toContain("Validade indisponível"); });
    expect(view.container.textContent).not.toMatch(/Expirado|Invalid Date|REDACTED/);
    await view.click("Ver metadados"); expect(view.dialog()!.textContent).toContain("Indisponível"); expect(view.dialog()!.textContent).not.toContain("MIGHAgEA");
  });
  it.each([403, 404, 500])("keeps list HTTP %s distinct from empty state", async status => {
    const view = await screen({ read: r => new URL(r.url).pathname.endsWith("/certificates") ? Response.json({ title: "Rejected", status }, { status }) : undefined });
    await vi.waitFor(async () => { await act(tick); expect(view.container.findAll(n => n.getAttribute("role") === "alert").length).toBeGreaterThan(0); });
    expect(view.container.textContent).not.toContain("Nenhum certificado");
  });
  it("does not render cached certificates while authorization is pending", async () => {
    const view = await screen({ read: r => new URL(r.url).pathname === `/api/v2/workspaces/${W}` ? new Promise<Response>(() => {}) : undefined });
    expect(view.container.textContent).toContain("Verificando contexto");
    expect(view.buttons("Novo certificado")).toHaveLength(0);
    expect(view.requests.filter(r => new URL(r.url).pathname.endsWith("/certificates"))).toHaveLength(0);
  });
  it("keeps PEM editable while context is revalidated but submits only after access is confirmed", async () => {
    let reads = 0;
    let release!: (response: Response) => void;
    const held = new Promise<Response>(resolve => { release = resolve; });
    const view = await screen({ read: request => new URL(request.url).pathname === `/api/v2/workspaces/${W}` && ++reads > 1 ? held : undefined });
    await view.click("Editar");
    try {
      await view.input("Chave privada (PEM)", TEST_PRIVATE_KEY);
      expect(view.buttons("Salvar no rascunho")[0]!.getAttribute("disabled")).not.toBeNull();
      await view.submit(); expect(view.writes()).toHaveLength(0);
    } finally { await act(async () => { release(Response.json({ id: W, key: W, name: "Workspace", slug: "teste", status: "active", activeRelease: null })); await tick(); }); }
    await vi.waitFor(async () => { await act(tick); expect(view.buttons("Salvar no rascunho")[0]!.getAttribute("disabled")).toBeNull(); });
    expect(view.field("Chave privada (PEM)").value).toBe(TEST_PRIVATE_KEY);
    await view.submit(); expect(view.writes()).toHaveLength(1);
  });
  it("clears an entered key when a refreshed Workspace becomes archived", async () => {
    const view = await screen(); await view.click("Editar"); await view.input("Chave privada (PEM)", TEST_PRIVATE_KEY);
    await act(async () => { client.setQueryData(["workspace", W], { id: W, status: "archived" }); await tick(); });
    expect(view.dialog()).toBeUndefined(); expect(view.container.textContent).not.toContain("MIGHAgEA"); expect(view.writes()).toHaveLength(0);
  });
  it("refreshes a committed save after closing the pending form without closing a new form", async () => {
    let release!: (response: Response) => void;
    const held = new Promise<Response>(resolve => { release = resolve; });
    let committed = false;
    const view = await screen({
      write: () => held,
      read: request => committed && new URL(request.url).pathname.endsWith("/certificates") ? Response.json({ items: [{ ...saved, snis: ["committed.example.test"] }], nextCursor: null }) : undefined,
    });
    await view.click("Editar"); await view.input("SNIs", "committed.example.test"); await view.submit();
    await view.click("Cancelar"); await view.click("Novo certificado"); await view.input("Chave privada (PEM)", TEST_PRIVATE_KEY);
    await act(async () => { committed = true; release(Response.json({ ...saved, key: "REDACTED", snis: ["committed.example.test"] })); await tick(); });
    await vi.waitFor(async () => { await act(tick); expect(view.container.textContent).toContain("committed.example.test"); });
    expect(view.dialog()).toBeDefined(); expect(view.field("Chave privada (PEM)").value).toBe(TEST_PRIVATE_KEY);
  });
  it.each([
    ["2026-11-02T12:00:00Z", "Expirado em"],
    ["2026-11-04T00:00:00Z", "Expira em 1 dia(s)"],
    ["not-a-date", "Validade indisponível"],
    [null, "Validade indisponível"],
  ])("uses the actual notAfter field without treating missing or invalid metadata as expired: %s", async (notAfter, expected) => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-03T12:00:00Z"));
    const view = await screen({ items: [{ ...saved, notAfter }] });
    await vi.waitFor(async () => { await act(tick); expect(view.container.textContent).toContain(expected); });
    if (!notAfter || notAfter === "not-a-date") expect(view.container.textContent).not.toContain("Expirado em");
  });
});
