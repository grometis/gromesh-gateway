import { act } from "react";
import { createPrivateKey } from "node:crypto";
import type { Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TEST_PRIVATE_KEY } from "../test/pem";
import type { components } from "../api/schema-v2";

type Variable = components["schemas"]["WorkspaceVariable"];
const W = "6d3e8b20-4c5e-4d6f-9a70-00000000000a";
const B = "6d3e8b20-4c5e-4d6f-9a70-00000000000b";
const variable: Variable = { name: "API_KEY", type: "credential", secret: true, required: true, hasValue: false };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
let root: Root | undefined;
let client: QueryClient | undefined;
afterEach(async () => {
  if (root) await act(() => root!.unmount());
  client?.clear();
  root = undefined;
  vi.unstubAllGlobals();
});

async function screen(options: {
  items?: Variable[]; stage?: "dev" | "hml" | "prd" | null;
  role?: "admin" | "editor" | "viewer"; status?: "active" | "archived"; publishMode?: "manual" | "auto";
  pending?: "workspace" | "environment" | "policy";
  readResponse?: (request: Request) => Response | Promise<Response> | undefined;
  writeResponse?: (request: Request) => Response | Promise<Response>;
} = {}) {
  vi.resetModules();
  const container = installTestDom();
  const NativeRequest = Request;
  vi.stubGlobal("Request", class extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(typeof input === "string" ? new URL(input, "https://ui.example") : input, init);
    }
  });
  const sent: Request[] = [];
  let items = options.items ?? [variable];
  vi.stubGlobal("fetch", async (request: Request) => {
    const path = new URL(request.url).pathname;
    sent.push(request.clone());
    if (request.method === "GET") {
      const response = options.readResponse?.(request);
      if (response) return response;
    }
    if (path.endsWith("/auth/csrf")) return Response.json({ csrfToken: "csrf" });
    if (path === "/api/v1/me") return Response.json({ id: W, name: "Ana", email: "ana@example.com", role: options.role ?? "admin", active: true, createdAt: "2026-10-30T12:00:00Z", updatedAt: "2026-10-30T12:00:00Z" });
    if (path === "/api/v2/workspace-creation-policy") return options.pending === "policy" ? new Promise<Response>(() => {}) : Response.json({ stage: options.stage === undefined ? "dev" : options.stage });
    const id = path.includes(B) ? B : W;
    if (path === `/api/v2/workspaces/${id}`) return options.pending === "workspace" ? new Promise<Response>(() => {}) : Response.json({ id, key: id, name: "Workspace", slug: "billing", status: options.status ?? "active", activeRelease: null });
    if (path === `/api/v1/environments/${id}`) return options.pending === "environment" ? new Promise<Response>(() => {}) : Response.json({ id, name: "Workspace", publishMode: options.publishMode ?? "manual", currentVersion: 0, hasUnpublishedChanges: false });
    if (request.method === "GET" && path.endsWith("/variables")) return Response.json(id === W ? items : []);
    if (request.method !== "GET") {
      if (options.writeResponse) return options.writeResponse(request);
      if (request.method === "DELETE") { items = []; return new Response(null, { status: 204 }); }
      if (path.endsWith("/value")) { items = items.map((v) => ({ ...v, hasValue: true, value: "REDACTED" })); return new Response(null, { status: 204 }); }
      const body = await request.json() as components["schemas"]["WorkspaceVariableDeclaration"];
      const saved = { ...variable, ...body, name: path.split("/").at(-1)!, hasValue: false };
      items = [saved];
      return Response.json(saved);
    }
    throw new Error(`Unexpected request: ${request.method} ${path}`);
  });
  const [{ VariablesPage }, { AuthProvider }, { createMemoryRouter, RouterProvider }, { createRoot }] = await Promise.all([
    import("./Variables"), import("../auth"), import("react-router"), import("react-dom/client"),
  ]);
  const router = createMemoryRouter([{ path: "/e/:envId/variables", element: <VariablesPage /> }], { initialEntries: [`/e/${W}/variables`] });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => { root!.render(<QueryClientProvider client={client!}><AuthProvider><RouterProvider router={router} /></AuthProvider></QueryClientProvider>); await tick(); });
  await act(async () => { await tick(); });
  const buttons = (name: string) => container.findAll((n) => n.tagName === "BUTTON" && n.textContent === name);
  const click = async (name: string) => {
    await vi.waitFor(async () => {
      await act(async () => { await tick(); });
      expect(buttons(name)[0], name).toBeDefined();
    });
    await act(async () => { buttons(name)[0]!.dispatchEvent(new Event("click", { bubbles: true })); await tick(); });
  };
  const dialog = () => container.findAll((n) => n.getAttribute("role") === "dialog")[0];
  const field = (label: string): TestNode => {
    const node = dialog()!.findAll((n) => n.tagName === "LABEL" && n.textContent.trim() === label)[0]!;
    return dialog()!.findAll((n) => n.getAttribute("id") === node.getAttribute("for"))[0]!;
  };
  const input = async (label: string, value: string) => {
    await act(async () => { const node = field(label); node.value = value; node.dispatchEvent(new Event(node.tagName === "SELECT" ? "change" : "input", { bubbles: true })); await tick(); });
  };
  const submit = async () => {
    await act(async () => { dialog()!.findAll((n) => n.tagName === "FORM")[0]!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await tick(); });
    await act(async () => { await tick(); });
  };
  return { container, router, sent, buttons, click, dialog, field, input, submit, writes: () => sent.filter((r) => r.method !== "GET") };
}

describe("workspace variables", () => {
  it.each(["Declarar variável", "Editar declaração", "Definir valor", "Excluir"])("keeps %s open during access revalidation, but blocks submission", async (action) => {
    let reads = 0;
    let release!: (response: Response) => void;
    const held = new Promise<Response>((resolve) => { release = resolve; });
    const view = await screen({ readResponse: (request) => {
      if (new URL(request.url).pathname === `/api/v1/environments/${W}` && ++reads > 1) return held;
    } });
    try {
      await view.click(action);
      expect(view.dialog()).toBeDefined();
      const confirm = action === "Excluir" ? "Excluir variável" : action === "Definir valor" ? "Salvar valor" : "Salvar";
      expect(view.buttons(confirm)[0]!.getAttribute("disabled")).not.toBeNull();
      if (action === "Excluir") await view.click(confirm);
      else await view.submit();
      expect(view.writes()).toHaveLength(0);
    } finally {
      await act(async () => {
        release(Response.json({ id: W, publishMode: "manual", hasUnpublishedChanges: false }));
        await tick();
      });
    }
    expect(view.dialog()).toBeDefined();
    const confirm = action === "Excluir" ? "Excluir variável" : action === "Definir valor" ? "Salvar valor" : "Salvar";
    await vi.waitFor(async () => {
      await act(async () => { await tick(); });
      expect(view.buttons(confirm)[0]!.getAttribute("disabled")).toBeNull();
    });
  });

  it.each(["archived", "auto", "hml", "error"])("clears an open secret when access revalidation returns %s", async (denial) => {
    let denied = false;
    const view = await screen({ readResponse: (request) => {
      if (!denied) return;
      const path = new URL(request.url).pathname;
      if (denial === "hml" && path === "/api/v2/workspace-creation-policy") return Response.json({ stage: "hml" });
      if (denial === "archived" && path === `/api/v2/workspaces/${W}`) return Response.json({ id: W, status: "archived" });
      if (path === `/api/v1/environments/${W}`) {
        if (denial === "auto") return Response.json({ id: W, publishMode: "auto" });
        if (denial === "error") return Response.json({ status: 403 }, { status: 403 });
      }
    } });
    await view.click("Definir valor");
    await view.input("Valor", "discard-on-denial");
    denied = true;
    await act(async () => { await client!.invalidateQueries(); await tick(); });
    expect(view.dialog()).toBeUndefined();
    expect(view.container.textContent).not.toContain("discard-on-denial");
    expect(view.writes()).toHaveLength(0);
    denied = false;
    await act(async () => { await client!.invalidateQueries(); await tick(); });
    await view.click("Definir valor");
    expect(view.field("Valor").value).toBe("");
  });

  it("keeps declaration validation beside the affected fields and checkboxes", async () => {
    const view = await screen({ writeResponse: () => Response.json({ title: "Validation failed", status: 422, errors: [
      { path: "secret", message: "must be equal to constant" },
      { path: "required", message: "must be boolean" },
      { path: "validation.pattern", message: "is not a valid regular expression" },
    ] }, { status: 422 }) });
    await view.click("Editar declaração");
    await vi.waitFor(async () => {
      await act(async () => { await tick(); });
      expect(view.buttons("Salvar")[0]!.getAttribute("disabled")).toBeNull();
    });
    await view.submit();
    await vi.waitFor(async () => {
      await act(async () => { await tick(); });
      for (const label of ["Segredo", "Obrigatória", "Padrão"]) expect(view.field(label).getAttribute("aria-invalid"), label).toBe("true");
    });
    const secretError = view.field("Segredo").getAttribute("aria-describedby");
    expect(view.dialog()!.findAll((n) => n.getAttribute("id") === secretError)[0]!.textContent).toContain("devem ser secretas");
    expect(view.dialog()!.textContent).not.toContain("must be");
  });

  it("lists declarations, flags missing required values and never renders returned values", async () => {
    const view = await screen({ items: [variable, { ...variable, name: "DEFINED", hasValue: true, value: "unexpected-secret" }] });
    expect(view.container.textContent).toContain("Obrigatória sem valor");
    expect(view.container.textContent).toContain("REDACTED");
    expect(view.container.textContent).not.toContain("unexpected-secret");
    expect(view.sent.some((r) => new URL(r.url).pathname === `/api/v2/workspaces/${W}/variables`)).toBe(true);
  });

  it("declares and replaces with the contract body, preserving validation and a fixed name on edit", async () => {
    const view = await screen({ items: [{ ...variable, validation: { pattern: "[a-z]+", maxLength: 32 } }] });
    await view.click("Editar declaração");
    expect(view.field("Nome").getAttribute("disabled")).not.toBeNull();
    await view.submit();
    expect(view.writes()[0]!.method).toBe("PUT");
    expect(new URL(view.writes()[0]!.url).pathname).toBe(`/api/v2/workspaces/${W}/variables/API_KEY`);
    expect(await view.writes()[0]!.json()).toEqual({ type: "credential", secret: true, required: true, validation: { pattern: "[a-z]+", maxLength: 32 } });
    await view.click("Declarar variável");
    await view.input("Nome", "HOST");
    await view.submit();
    expect(await view.writes()[1]!.json()).toEqual({ type: "string", secret: false, required: false });
    expect(new URL(view.writes()[1]!.url).pathname).toBe(`/api/v2/workspaces/${W}/variables/HOST`);
  });

  it("sets a secret only on this instance, clears the password and keeps it out of DOM and mutation cache", async () => {
    const view = await screen();
    await view.click("Definir valor");
    expect(view.field("Valor").type).toBe("password");
    expect(view.field("Valor").getAttribute("autoComplete")).toBe("off");
    expect(view.field("Valor").value).toBe("");
    await view.input("Valor", "sensitive-test-value");
    await view.submit();
    expect(view.dialog()).toBeUndefined();
    expect(view.writes()[0]!.method).toBe("PUT");
    expect(new URL(view.writes()[0]!.url).pathname).toBe(`/api/v2/workspaces/${W}/variables/API_KEY/value`);
    expect(await view.writes()[0]!.json()).toEqual({ value: "sensitive-test-value" });
    expect(view.container.textContent).not.toContain("sensitive-test-value");
    expect(JSON.stringify(client!.getMutationCache().getAll().map((m) => m.state))).not.toContain("sensitive-test-value");
    await view.click("Definir valor");
    expect(view.field("Valor").value).toBe("");
  });

  it("preserves every line when pasting a real PEM private key into the password field", async () => {
    const view = await screen({ items: [{ ...variable, type: "privateKey" }], writeResponse: async (request) => {
      const body = await request.json() as { value: string };
      try { createPrivateKey(body.value); return new Response(null, { status: 204 }); }
      catch { return Response.json({ title: "Invalid value", status: 422, errors: [{ path: "value", message: "must be a PEM private key" }] }, { status: 422 }); }
    } });
    await view.click("Definir valor");
    await act(async () => {
      const paste = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(paste, "clipboardData", { value: { getData: () => TEST_PRIVATE_KEY } });
      view.field("Valor").dispatchEvent(paste);
      await tick();
    });
    expect(view.field("Valor").type).toBe("password");
    await view.submit();
    expect(await view.writes()[0]!.json()).toEqual({ value: TEST_PRIVATE_KEY });
    expect(view.dialog()).toBeUndefined();
    expect(view.container.textContent).not.toContain("MIGHAgEA");
  });

  it.each(["hml", "prd", null] as const)("blocks value writes outside dev (%s)", async (stage) => {
    const view = await screen({ stage });
    expect(view.buttons("Definir valor")[0]!.getAttribute("disabled")).not.toBeNull();
    expect(view.container.textContent).toMatch(/DEV/);
    expect(view.writes()).toHaveLength(0);
  });
  it.each(["viewer", "editor"] as const)("hides value writes without known values.write (%s)", async (role) => {
    const view = await screen({ role });
    expect(view.buttons("Definir valor")).toHaveLength(0);
  });
  it.each([{ status: "archived" }, { publishMode: "auto" }, { pending: "workspace" }, { pending: "environment" }] as const)("fails closed on access: %j", async (options) => {
    const view = await screen(options);
    for (const name of ["Declarar variável", "Editar declaração", "Excluir", "Definir valor"]) expect(view.buttons(name)).toHaveLength(0);
    expect(view.container.textContent).toContain("Somente leitura");
    expect(view.writes()).toHaveLength(0);
  });
  it("blocks value writes until the instance stage is known", async () => {
    const view = await screen({ pending: "policy" });
    expect(view.buttons("Definir valor")[0]!.getAttribute("disabled")).not.toBeNull();
  });

  it.each(["Declarar variável", "Editar declaração", "Definir valor", "Excluir"])("discards the %s form on workspace change", async (action) => {
    const view = await screen();
    await view.click(action);
    if (action === "Definir valor") await view.input("Valor", "discard-this-secret");
    await act(async () => { await view.router.navigate(`/e/${B}/variables`); await tick(); });
    expect(view.dialog()).toBeUndefined();
    expect(view.container.textContent).not.toContain("API_KEY");
    expect(view.writes()).toHaveLength(0);
    expect(client!.getQueryCache().getAll().filter((q) => q.queryKey[0] === "ws-variables").map((q) => q.queryKey)).toEqual([["ws-variables", W], ["ws-variables", B]]);
    await act(async () => { await view.router.navigate(`/e/${W}/variables`); await tick(); });
    await view.click(action);
    if (action === "Definir valor") expect(view.field("Valor").value).toBe("");
    if (action === "Declarar variável") expect(view.field("Nome").value).toBe("");
  });

  it("deletes only after confirmation and displays a VarRef conflict in Portuguese", async () => {
    const view = await screen({ writeResponse: () => Response.json({ status: 409, detail: "Variable API_KEY is referenced by the draft: services.orders" }, { status: 409 }) });
    await view.click("Excluir");
    expect(view.writes()).toHaveLength(0);
    await view.click("Excluir variável");
    await act(async () => { await tick(); });
    expect(view.writes()[0]!.method).toBe("DELETE");
    expect(new URL(view.writes()[0]!.url).pathname).toBe(`/api/v2/workspaces/${W}/variables/API_KEY`);
    expect(await view.writes()[0]!.text()).toBe("");
    expect(view.dialog()!.textContent).toMatch(/VarRef/);
    expect(view.dialog()!.textContent).not.toContain("referenced by");
  });
  it.each([403, 404, 409, 422, 500])("sanitizes a value failure (%s), clears the input and maps the field path", async (status) => {
    const view = await screen({ writeResponse: () => Response.json({ title: "Problem", status, detail: "sensitive-test-value", errors: [{ path: "value", message: "sensitive-test-value" }] }, { status }) });
    await view.click("Definir valor");
    await view.input("Valor", "sensitive-test-value");
    await view.submit();
    expect(view.field("Valor").value).toBe("");
    expect(view.dialog()!.textContent).not.toContain("sensitive-test-value");
    expect(view.dialog()!.findAll((n) => n.getAttribute("role") === "alert").length).toBeGreaterThan(0);
    if (status === 422 || status === 409) expect(view.field("Valor").getAttribute("aria-invalid")).toBe("true");
    expect(JSON.stringify(client!.getMutationCache().getAll().map((m) => m.state))).not.toContain("sensitive-test-value");
  });
});

/** Local DOM host for exercising variable forms without adding a browser DOM dependency. */
class TestNode {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly tagName: string;
  readonly namespaceURI = "http://www.w3.org/1999/xhtml";
  readonly childNodes: TestNode[] = [];
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, string> = {};
  readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  parentNode: TestNode | null = null;
  value = "";
  get type() { return this.getAttribute("type") ?? "text"; }
  set type(value: string) { this.setAttribute("type", value); }
  defaultValue = "";
  checked = false;
  disabled = false;
  selected = false;
  multiple = false;
  private content = "";

  constructor(readonly ownerDocument: TestDocument, name: string, nodeType = 1) {
    this.nodeType = nodeType;
    this.nodeName = nodeType === 1 ? name.toUpperCase() : name;
    this.tagName = this.nodeName;
  }
  get firstChild() { return this.childNodes[0] ?? null; }
  get lastChild() { return this.childNodes.at(-1) ?? null; }
  get options(): TestNode[] { return this.findAll((node) => node.tagName === "OPTION"); }
  get textContent(): string { return this.content + this.childNodes.map((node) => node.textContent).join(""); }
  set textContent(value: string) {
    for (const node of this.childNodes) node.parentNode = null;
    this.childNodes.length = 0;
    this.content = String(value);
  }
  get nodeValue() { return this.content; }
  set nodeValue(value: string) { this.content = value; }
  appendChild(node: TestNode) { return this.insertBefore(node, null); }
  insertBefore(node: TestNode, before: TestNode | null) {
    node.parentNode?.removeChild(node);
    this.childNodes.splice(before ? this.childNodes.indexOf(before) : this.childNodes.length, 0, node);
    node.parentNode = this;
    return node;
  }
  removeChild(node: TestNode) {
    this.childNodes.splice(this.childNodes.indexOf(node), 1);
    node.parentNode = null;
    return node;
  }
  setAttribute(name: string, value: string) { this.attributes.set(name, String(value)); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(name); }
  addEventListener(name: string, listener: EventListenerOrEventListenerObject) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(listener);
  }
  removeEventListener(name: string, listener: EventListenerOrEventListenerObject) { this.listeners.get(name)?.delete(listener); }
  dispatchEvent(event: Event) {
    Object.defineProperty(event, "target", { configurable: true, value: this });
    for (let node: TestNode | null = this; node; node = node.parentNode) {
      for (const listener of node.listeners.get(event.type) ?? []) {
        if (typeof listener === "function") listener.call(node as unknown as EventTarget, event);
        else listener.handleEvent(event);
      }
      if (!event.bubbles || event.cancelBubble) break;
    }
    return !event.defaultPrevented;
  }
  focus() { this.ownerDocument.activeElement = this; }
  contains(node: TestNode): boolean { return node === this || this.childNodes.some((child) => child.contains(node)); }
  findAll(predicate: (node: TestNode) => boolean): TestNode[] {
    return this.childNodes.flatMap((node) => [...(predicate(node) ? [node] : []), ...node.findAll(predicate)]);
  }
}

class TestDocument extends TestNode {
  oninput = null;
  activeElement: TestNode | null = null;
  readonly documentElement: TestNode;
  readonly body: TestNode;
  readonly defaultView = Object.assign(new EventTarget(), { HTMLIFrameElement: class {}, location: { protocol: "https:" } });
  constructor() {
    // React only reads ownerDocument on elements, never on the document itself.
    super(null as unknown as TestDocument, "#document", 9);
    this.documentElement = this.appendChild(this.createElement("html"));
    this.body = this.documentElement.appendChild(this.createElement("body"));
  }
  createElement(name: string) { return new TestNode(this, name); }
  createElementNS(_namespace: string, name: string) { return this.createElement(name); }
  createTextNode(text: string) {
    const node = new TestNode(this, "#text", 3);
    node.textContent = text;
    return node;
  }
}

function installTestDom() {
  const document = new TestDocument();
  Object.assign(document.defaultView, { document });
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", document.defaultView);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return document.body.appendChild(document.createElement("div"));
}
