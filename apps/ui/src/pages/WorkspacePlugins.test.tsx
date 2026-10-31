import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Plugin } from "../api/client";
import { parsePluginSchema } from "../schema-form/schema";
const W = "6d3e8b20-4c5e-4d6f-9a70-00000000000a";
const schema = parsePluginSchema({ fields: [{ config: { type: "record", fields: [
  { minute: { type: "integer", default: 10 } },
  { redis: { type: "record", fields: [{ password: { type: "string", encrypted: true, default: "unsafe-default" } }] } },
] } }] });
const body = { enabled: true, name: "rate-limiting", scope: { serviceId: W }, config: { minute: 10, redis: { password: "typed-secret" } } };
const saved: Plugin = { ...body, id: W, config: { minute: 10, redis: { password: "REDACTED" } } as unknown as Plugin["config"], createdAt: "2026-10-31T12:00:00Z", updatedAt: "2026-10-31T12:00:00Z" };

async function load(respond: (request: Request) => Promise<Response>) {
  vi.resetModules();
  const NativeRequest = Request;
  vi.stubGlobal("Request", class extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) { super(typeof input === "string" ? new URL(input, "https://ui.example") : input, init); }
  });
  vi.stubGlobal("fetch", (request: Request) => request.url.endsWith("/auth/csrf") ? Promise.resolve(Response.json({ csrfToken: "csrf" })) : respond(request));
  return import("./WorkspacePlugins");
}

describe("workspace plugin form and transport", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("never initializes a secret with a schema default or a saved secret", async () => {
    const { workspacePluginConfig } = await load(async () => Response.json(saved));
    expect(workspacePluginConfig(schema, undefined)).toEqual({ minute: 10, redis: {} });
    expect(workspacePluginConfig(schema, body.config)).toEqual({ minute: 10, redis: { password: "REDACTED" } });
  });
  it.each([null, saved])("sends only v2, waits for success, (%s)", async (current) => {
    const sent: Request[] = [];
    let resolve!: (r: Response) => void;
    const { saveWorkspacePlugin } = await load(request => { sent.push(request); return new Promise(r => { resolve = r; }); });
    let done = false;
    const pending = saveWorkspacePlugin(W, current, body).then(result => { done = true; return result; });
    await new Promise(r => setTimeout(r, 0));
    expect(done).toBe(false);
    expect(sent.map(r => [r.method, new URL(r.url).pathname])).toEqual([[current ? "PUT" : "POST", `/api/v2/workspaces/${W}/plugins${current ? `/${W}` : ""}`]]);
    expect(await sent[0]!.json()).toEqual(body);
    resolve(Response.json(saved, { status: current ? 200 : 201 }));
    expect(await pending).toEqual(saved);
  });
  it.each([403, 409, 422])("propagates server %s and places schema errors without accepting a failed save", async status => {
    const problem = { title: "Rejected", status, ...(status === 409 ? { code: "auto-publish" } : {}), errors: [{ path: "config.redis.password", message: "is required" }] };
    const { saveWorkspacePlugin, workspacePluginErrors } = await load(async () => Response.json(problem, { status }));
    let error: unknown;
    try { await saveWorkspacePlugin(W, null, body); } catch (e) { error = e; }
    expect(error).toMatchObject({ status });
    const errors = workspacePluginErrors(error, schema);
    if (status === 403) expect(errors.form.join()).toContain("permissão");
    if (status === 409) expect(errors.form.join()).toContain("publicação manual");
    if (status === 422) expect(errors.fields["config.redis.password"]).toBeDefined();
  });
});


describe("workspace plugin screen", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function screen(items: Plugin[], options: { archived?: boolean; auto?: boolean; names?: boolean; pending?: boolean } = {}) {
    const { WorkspacePlugins } = await load(async () => { throw new Error("Rendering must use the seeded cache"); });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    if (!options.pending) {
      client.setQueryData(["workspace", W], { id: W, slug: "orders", status: options.archived ? "archived" : "active", activeRelease: 1 });
      client.setQueryData(["environment", W], { publishMode: options.auto ? "auto" : "manual", hasUnpublishedChanges: true });
    }
    client.setQueryData(["ws-plugins", W, {}], { pages: [{ items, nextCursor: null }], pageParams: [""] });
    client.setQueryData(["preview", W], { changes: items.map(p => ({ kind: "plugins", id: p.id, change: "modified" })) });
    client.setQueryData(["ws-plugin-choices", W, "services"], options.names === false ? [] : [{ id: W, name: "orders" }]);
    client.setQueryData(["ws-plugin-choices", W, "routes"], [{ id: W, name: "orders-api" }]);
    client.setQueryData(["ws-plugin-choices", W, "consumers"], [{ id: W, name: "checkout" }]);
    const html = renderToStaticMarkup(<QueryClientProvider client={client}><WorkspacePlugins workspaceId={W} /></QueryClientProvider>);
    client.clear();
    return html;
  }

  it("preserves cards, readable combined scopes, draft and enabled state without exposing config", async () => {
    const html = await screen([{ ...saved, enabled: false, scope: { serviceId: W, routeId: W, consumerId: W } }]);
    expect(html).toContain('class="cards"');
    expect(html).toContain('aria-label="Plugins"');
    for (const value of ["rate-limiting", "Service orders · Route orders-api · Consumer checkout", "Alterado", "Não", 'aria-label="Filtrar por escopo"', 'value="global"', `value="serviceId:${W}"`, 'aria-label="Mais ações para rate-limiting']) expect(html).toContain(value);
    expect(html).not.toContain("minute");
    expect(html).not.toContain("password");
    expect(html).not.toContain("typed-secret");
    expect(html).toContain("Novo plugin");
  });

  it("uses an id when a scope name is unavailable", async () => {
    expect(await screen([saved], { names: false })).toContain(`Service ${W}`);
  });

  it.each(["pending", "failed"])("keeps service names and scope filters available while consumers are %s", async state => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const { WorkspacePlugins } = await load(async request => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/services")) return Response.json(url.searchParams.has("cursor")
        ? { items: [{ id: W, name: "orders" }], nextCursor: null }
        : { items: [], nextCursor: "next" });
      if (url.pathname.endsWith("/routes")) return Response.json({ items: [{ id: W, name: "orders-api" }], nextCursor: null });
      if (url.pathname.endsWith("/consumers")) {
        if (state === "pending") await held;
        return Response.json({ title: "Unavailable", status: 503 }, { status: 503 });
      }
      throw new Error(`Unexpected query: ${url.pathname}`);
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(["workspace", W], { id: W, slug: "orders", status: "active", activeRelease: 1 });
    client.setQueryData(["environment", W], { publishMode: "manual", hasUnpublishedChanges: true });
    client.setQueryData(["ws-plugins", W, {}], { pages: [{ items: [saved], nextCursor: null }], pageParams: [""] });
    client.setQueryData(["preview", W], { changes: [] });
    const render = () => renderToStaticMarkup(<QueryClientProvider client={client}><WorkspacePlugins workspaceId={W} /></QueryClientProvider>);
    render();
    const fetching = client.getQueryCache().getAll().filter(query => query.state.status === "pending").map(query => query.fetch().catch(() => {}));
    try {
      await vi.waitFor(() => {
        const html = render();
        expect(html).toContain("Service orders");
        expect(html).toContain(`<option value="serviceId:${W}">Service orders</option>`);
        expect(html).toContain("Route orders-api");
      });
    } finally {
      release();
      await Promise.all(fetching);
      client.clear();
    }
  });

  it("keeps legacy global plugins visible and read-only", async () => {
    const html = await screen([{ ...saved, scope: {} }]);
    expect(html).toContain("Global legado (somente leitura)");
    expect(html).not.toContain('aria-label="Editar');
    expect(html).not.toContain('aria-label="Mais ações');
  });

  it("keeps EmptyState and creation when the workspace is empty", async () => {
    const html = await screen([]);
    expect(html).toContain('class="empty-state muted"');
    expect(html).toContain("Nenhum plugin neste Workspace.");
    expect(html).toContain("Novo plugin");
    expect(html).not.toContain('class="cards"');
  });

  it.each([{ archived: true }, { auto: true }, { pending: true }])("keeps read-only workspace cards without mutations: %s", async options => {
    const html = await screen([saved], options);
    expect(html).toContain("rate-limiting");
    expect(html).toContain("Somente leitura");
    expect(html).not.toContain("Novo plugin");
    expect(html).not.toContain('aria-label="Editar');
    expect(html).not.toContain('aria-label="Mais ações');
  });
});
