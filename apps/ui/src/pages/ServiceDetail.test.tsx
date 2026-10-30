import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

// Exercise readOnly with full editing permission, so RBAC cannot hide a regression.
vi.mock("../auth", () => ({ useCanEdit: () => true }));

const W = "6d3e8b20-4c5e-4d6f-9a70-00000000000a";
const NOW = "2026-10-30T12:00:00Z";
const service = { id: "service-1", workspaceId: W, name: "cobranca", protocol: "http", host: "billing.internal", port: 80, createdAt: NOW, updatedAt: NOW };
const route = { id: "route-1", name: "billing-api", serviceId: service.id, paths: ["/billing"], methods: ["GET"], createdAt: NOW, updatedAt: NOW };
const plugin = { id: "plugin-1", name: "rate-limiting", enabled: false, scope: { serviceId: service.id }, config: { minute: 5 }, createdAt: NOW, updatedAt: NOW };
const page = (items: unknown[]) => ({ items, nextCursor: null });

async function load() {
  vi.resetModules();
  const sent: Request[] = [];
  const NativeRequest = Request;
  vi.stubGlobal("Request", class extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(typeof input === "string" ? new URL(input, "https://ui.example") : input, init);
    }
  });
  vi.stubGlobal("fetch", async (request: Request) => {
    sent.push(request);
    const path = new URL(request.url).pathname;
    if (request.method !== "GET") throw new Error(`Unexpected mutation: ${request.method} ${path}`);
    if (path.endsWith(`/services/${service.id}`)) return Response.json(service);
    if (path.endsWith("/services")) return Response.json(page([service]));
    if (path.endsWith("/routes")) return Response.json(page([route]));
    if (path.endsWith("/plugins")) return Response.json(page([plugin]));
    if (path === `/api/v1/environments/${W}`) return Response.json({ id: W, hasUnpublishedChanges: false });
    if (path === `/api/v2/workspaces/${W}`) return Response.json({ id: W, slug: "billing", activeRelease: null });
    if (path.endsWith("/upstreams") || path.endsWith("/consumers")) return Response.json(page([]));
    throw new Error(`Unexpected query: ${path}`);
  });
  const [services, routes, plugins, { MemoryRouter, Route, Routes }] = await Promise.all([
    import("./Services"), import("./Routes"), import("./Plugins"), import("react-router"),
  ]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const render = (element: ReactElement) => renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/e/${W}/services/${service.id}`]}>
        <Routes><Route path="e/:envId/services/:serviceId" element={element} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const loaded = async (element: ReactElement) => {
    // As in workspace-switch.test: rendering registers real queries, fetching fills the cache.
    for (let pass = 0; pass < 5; pass++) {
      const html = render(element);
      const pending = client.getQueryCache().getAll().filter((q) =>
        q.state.status === "pending" && !("enabled" in q.options && q.options.enabled === false),
      );
      if (!pending.length) return html;
      await Promise.all(pending.map((q) => q.fetch()));
    }
    throw new Error("Queries did not settle");
  };
  return { ...services, ...routes, ...plugins, loaded, sent, client };
}

describe("service detail route and plugin access", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists routes and plugins in v2 detail without mutation controls or v1 writes", async () => {
    const { ServiceDetailPage, loaded, sent, client } = await load();
    const html = await loaded(<ServiceDetailPage />);
    expect(html).toContain(route.name);
    expect(html).toContain(plugin.name);
    expect(html).toContain('href="/e/' + W + '/routes?serviceId=' + service.id + '"');
    expect(html).toContain("Gerencie as routes na tela de");
    expect(html).toContain("Plugins por Workspace ainda não são editáveis aqui.");
    expect(html).not.toMatch(/Nova route|Adicionar plugin|Novo plugin|type="checkbox"|role="switch"/);
    // Only the Service's own v2 Edit/Delete actions remain.
    expect(html.match(/>Editar<\/button>/g)).toHaveLength(1);
    expect(html.match(/aria-haspopup="menu"/g)).toHaveLength(1);
    expect(html).not.toContain(`Mais ações para ${route.name}`);
    expect(html).not.toContain(`Mais ações para ${plugin.name}`);
    expect(sent.some((r) => new URL(r.url).searchParams.get("serviceId") === service.id && r.url.includes("/routes"))).toBe(true);
    expect(sent.some((r) => new URL(r.url).searchParams.get("serviceId") === service.id && r.url.includes("/plugins"))).toBe(true);
    expect(sent.filter((r) => r.url.includes("/api/v1/") && ["POST", "PUT", "DELETE", "PATCH"].includes(r.method))).toEqual([]);
    expect(client.getMutationCache().getAll()).toEqual([]);
  });

  it("also makes route-scoped plugins read-only when consulting a route's plugins", async () => {
    const { ScopedPlugins, loaded } = await load();
    const html = await loaded(<ScopedPlugins envId={W} scope={{ kind: "route", id: route.id }} title="Plugins aplicados" readOnly />);
    expect(html).toContain(plugin.name);
    expect(html).not.toMatch(/Adicionar plugin|Editar|Mais ações|type="checkbox"|role="switch"/);
  });

  it("keeps creation, editing and deletion actions by default for v1 pages and scoped components", async () => {
    const { RoutesPage, PluginsPage, ScopedRoutes, ScopedPlugins, loaded } = await load();
    for (const element of [<RoutesPage />, <ScopedRoutes envId={W} service={service} />]) {
      const html = await loaded(element);
      expect(html).toContain("Nova route");
      expect(html).toContain(">Editar</button>");
      expect(html).toContain(`Mais ações para ${route.name}`);
    }
    for (const [element, createLabel] of [
      [<PluginsPage />, "Novo plugin"],
      [<ScopedPlugins envId={W} scope={{ kind: "consumer", id: "consumer-1" }} title="Plugins do consumer" />, "Adicionar plugin"],
      [<ScopedPlugins envId={W} scope={{ kind: "route", id: route.id }} title="Plugins aplicados" />, "Adicionar plugin"],
    ] as const) {
      const html = await loaded(element);
      expect(html).toContain(createLabel);
      expect(html).toContain(">Editar</button>");
      expect(html).toContain(`Mais ações para ${plugin.name}`);
    }
  });
});
