import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkspaceRoute, WorkspaceService } from "../api/client-v2";
import { afterEach, describe, expect, it, vi } from "vitest";

// Exercise readOnly with full editing permission, so RBAC cannot hide a regression.
vi.mock("../auth", () => ({ useCanEdit: () => true }));

const W = "6d3e8b20-4c5e-4d6f-9a70-00000000000a";
const NOW = "2026-10-30T12:00:00Z";
const service: WorkspaceService = { id: "service-1", workspaceId: W, name: "cobranca", protocol: "http", host: "billing.internal", port: 80, enabled: true, tags: [], upstreamId: null, path: null, createdAt: NOW, updatedAt: NOW };
const route: WorkspaceRoute = { id: "route-1", name: "billing-api", serviceId: service.id, paths: ["/billing"], methods: ["GET"], protocols: ["http", "https"], stripPath: true, preserveHost: false, pathCompatibility: "workspace-default", createdAt: NOW, updatedAt: NOW };
const plugin = { id: "plugin-1", name: "rate-limiting", enabled: false, scope: { serviceId: service.id }, config: { minute: 5 }, createdAt: NOW, updatedAt: NOW };
const page = (items: unknown[]) => ({ items, nextCursor: null });

async function load(status = "active", publishMode = "manual", storedRoutes: WorkspaceRoute[] = [route]) {
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
    if (path.endsWith("/routes")) return Response.json(page(storedRoutes));
    if (path.endsWith("/plugins")) return Response.json(page([plugin]));
    if (path === `/api/v1/environments/${W}`) return Response.json({ id: W, publishMode, hasUnpublishedChanges: false });
    if (path === `/api/v2/workspaces/${W}`) return Response.json({ id: W, slug: "billing", status, activeRelease: null });
    if (path.endsWith("/upstreams") || path.endsWith("/consumers")) return Response.json(page([]));
    throw new Error(`Unexpected query: ${path}`);
  });
  const [services, routes, plugins, gateway, { MemoryRouter, Route, Routes }] = await Promise.all([
    import("./Services"), import("./Routes"), import("./Plugins"), import("./workspace-gateway"), import("react-router"),
  ]);
  // Static renders do not mount observers: keep settled reads fresh unless the test explicitly revalidates them.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
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
  return { ...services, ...routes, ...plugins, ...gateway, loaded, render, sent, client };
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
    expect(sent.every((r) => r.method === "GET")).toBe(true);
    expect(client.getMutationCache().getAll()).toEqual([]);
  });

  it.each([
    route,
    { ...route, pathCompatibility: "legacy-preserved" as const },
    { ...route, pathCompatibility: "legacy-preserved" as const, paths: [], hosts: ["billing.example"] },
  ])("shows a scoped route without any actions when readOnly (compatibility $pathCompatibility, paths $paths)", async (stored) => {
    const { ScopedRoutes, loaded, sent, client } = await load("active", "manual", [stored]);
    const html = await loaded(<ScopedRoutes envId={W} service={service} readOnly />);
    expect(html).toContain(route.name);
    expect(html).toContain(service.name);
    expect(html).not.toMatch(/<button|aria-label="Ações"|class="actions"|<form|role="dialog"/);
    const queries = sent.filter((r) => new URL(r.url).pathname.endsWith("/routes"));
    expect(queries.length).toBeGreaterThan(0);
    for (const request of queries) {
      const url = new URL(request.url);
      expect(url.pathname).toBe(`/api/v2/workspaces/${W}/routes`);
      expect(url.searchParams.get("serviceId")).toBe(service.id);
    }
    expect(sent.every((r) => r.method === "GET")).toBe(true);
    expect(client.getMutationCache().getAll()).toEqual([]);
  });

  it("also makes route-scoped plugins read-only when consulting a route's plugins", async () => {
    const { ScopedPlugins, loaded } = await load();
    const html = await loaded(<ScopedPlugins envId={W} scope={{ kind: "route", id: route.id }} title="Plugins aplicados" readOnly />);
    expect(html).toContain(plugin.name);
    expect(html).not.toMatch(/Adicionar plugin|Editar|Mais ações|type="checkbox"|role="switch"/);
  });

  it("keeps default editing actions for workspace routes and legacy plugins", async () => {
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


describe("workspace service write access", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["Services", "workspace"], ["Services", "environment"],
    ["hook", "workspace"], ["hook", "environment"],
  ] as const)("blocks %s writes while cached %s access is revalidating, then enables confirmed active/manual access", async (view, key) => {
    const { ServicesPage, ServiceDetailPage, ServiceForm, useWorkspaceGatewayAccess, loaded, render, client } = await load();
    function AccessProbe() {
      const access = useWorkspaceGatewayAccess(W);
      return <output>{access.canWrite ? "writable" : "blocked"}</output>;
    }
    const elements = view === "hook" ? [<AccessProbe />] : [
      <ServicesPage />, <ServiceDetailPage />,
      <ServiceForm workspaceId={W} service={null} onClose={() => {}} />,
      <ServiceForm workspaceId={W} service={service} onClose={() => {}} />,
    ];
    for (const element of elements) await loaded(element);
    const queryKey = [key, W];
    const confirmed = client.getQueryData(queryKey);
    let confirm!: (data: unknown) => void;
    const pending = client.fetchQuery({ queryKey, staleTime: 0, queryFn: () => new Promise((resolve) => { confirm = resolve; }) });
    try {
      expect(client.getQueryState(queryKey)).toMatchObject({ status: "success", fetchStatus: "fetching", data: confirmed });
      for (const [index, element] of elements.entries()) {
        const html = render(element);
        if (view === "hook") expect(html).toContain(">blocked</output>");
        else {
          expect(html).not.toMatch(/>Novo service<\/button>|>Editar<|Mais ações para cobranca/);
          expect(html).toContain("Somente leitura enquanto");
          if (index >= 2) {
            expect(html).toMatch(/<input[^>]*value="(?:cobranca)?"/);
            expect(html).toContain('<option value="dns" selected="">');
            expect(html).toMatch(/type="submit"[^>]*disabled=""/);
            expect(html).not.toMatch(/<(input|select)[^>]*disabled/);
          } else expect(html).not.toContain('type="submit"');
        }
      }
    } finally {
      confirm(confirmed);
      await pending;
    }
    expect(client.getQueryState(queryKey)).toMatchObject({ status: "success", fetchStatus: "idle" });
    if (view === "hook") expect(render(<AccessProbe />)).toContain(">writable</output>");
    else {
      const html = render(<ServicesPage />);
      expect(html).toContain("Novo service");
      expect(html).toContain(">Editar</button>");
      expect(html).toContain("Mais ações para cobranca");
      for (const element of elements.slice(2)) {
        const form = render(element);
        expect(form).toContain('type="submit"');
        expect(form).not.toMatch(/type="submit"[^>]*disabled/);
      }
    }
    client.clear();
  });

  it.each([["archived", "manual", "arquivado"], ["active", "auto", "publicação automática"], ["archived", "auto", "arquivado"]])(
    "offers only reading for %s / %s in both list and detail", async (status, publishMode, reason) => {
      const { ServicesPage, ServiceDetailPage, ServiceForm, loaded, sent } = await load(status, publishMode);
      for (const element of [<ServicesPage />, <ServiceDetailPage />]) {
        const html = await loaded(element);
        expect(html).toContain(service.name);
        expect(html).toContain("Somente leitura");
        expect(html).toContain(reason);
        expect(html).not.toMatch(/Novo service|>Editar<|Mais ações para cobranca/);
      }
      const form = await loaded(<ServiceForm workspaceId={W} service={service} onClose={() => {}} />);
      expect(form).toContain("Somente leitura");
      expect(form).not.toMatch(/<form|>Salvar<|type="submit"/);
      expect(sent.every((r) => r.method === "GET")).toBe(true);
    },
  );

  it("does not offer writes while workspace or environment access is unknown or failed", async () => {
    const { ServicesPage, render, client } = await load();
    client.setQueryData(["ws-services", W, ""], { pages: [page([service])], pageParams: [""] });
    for (const key of ["workspace", "environment"]) {
      const html = render(<ServicesPage />);
      expect(html).not.toMatch(/Novo service|>Editar<|Mais ações para cobranca/);
      expect(html).toContain("Somente leitura enquanto");
      // Even if the other read succeeds, a failed read must not enable writes.
      client.setQueryData([key, W], key === "workspace" ? { id: W, status: "active" } : { id: W, publishMode: "manual" });
    }
    for (const key of ["workspace", "environment"]) {
      const data = client.getQueryData([key, W]);
      client.getQueryCache().find({ queryKey: [key, W] })!.setState({ status: "error", error: new Error("offline") });
      const html = render(<ServicesPage />);
      expect(html).not.toMatch(/Novo service|>Editar<|Mais ações para cobranca/);
      expect(html).toContain("Somente leitura: não foi possível verificar");
      client.setQueryData([key, W], data);
    }
  });

  it("offers service writes in an active workspace with manual publication", async () => {
    const { ServicesPage, loaded } = await load();
    const html = await loaded(<ServicesPage />);
    expect(html).toContain("Novo service");
    expect(html).toContain(">Editar</button>");
    expect(html).toContain("Mais ações para cobranca");
  });
});
