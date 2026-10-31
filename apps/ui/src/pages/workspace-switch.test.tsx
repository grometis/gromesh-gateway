import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider, type QueryKey } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const A = "7c1d2e3f-4a5b-4c6d-8e7f-00000000000a";
const B = "7c1d2e3f-4a5b-4c6d-8e7f-00000000000b";
const NOW = "2026-10-29T12:00:00Z";
const env = (id: string, name: string) => ({
  id, name, publishMode: "manual", currentVersion: 3, hasUnpublishedChanges: false, createdAt: NOW, updatedAt: NOW,
});
const service = (id: string, name: string) => ({
  id, workspaceId: A, upstreamId: null, name, protocol: "http", host: `${name}.internal`, port: 80, path: null, enabled: true, tags: [], createdAt: NOW, updatedAt: NOW,
});
const page = (items: unknown[]) => ({ items, nextCursor: null });

/** Answers for workspace A only (the gateway through v2, the rest v1); anything of B stays pending, as a slow network would. */
function answer(url: URL): Promise<Response> {
  const path = url.pathname.replace(/^\/api\/v1/, "");
  if (path === "/environments") return Promise.resolve(Response.json(page([env(A, "Pagamentos"), env(B, "Recargas")])));
  if (path.includes(B)) return new Promise(() => {});
  if (path === `/environments/${A}`) return Promise.resolve(Response.json(env(A, "Pagamentos")));
  if (url.pathname === `/api/v2/workspaces/${A}/services`) return Promise.resolve(Response.json(page([service("7c1d2e3f-4a5b-4c6d-8e7f-0000000000a1", "servico-de-pagamentos")])));
  return Promise.resolve(Response.json({ title: "Not Found", status: 404 }, { status: 404 }));
}

async function load() {
  vi.resetModules();
  // Node's Request needs an absolute URL; the browser resolves /api/v1 itself.
  const NativeRequest = Request;
  vi.stubGlobal("Request", class extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(typeof input === "string" ? new URL(input, "https://ui.example") : input, init);
    }
  });
  vi.stubGlobal("fetch", (request: Request) => answer(new URL(request.url)));
  // The metrics screens read the tab's visibility while rendering.
  vi.stubGlobal("document", { visibilityState: "visible" });
  const [{ MemoryRouter, Route, Routes }, { AuthProvider }, { Shell }, pages] = await Promise.all([
    import("react-router"),
    import("../auth"),
    import("../components/Shell"),
    Promise.all([
      import("./Services"), import("./Routes"), import("./Consumers"), import("./Plugins"), import("./Upstreams"),
      import("./Certificates"), import("./Overview"), import("./Snapshots"), import("./Clusters"), import("./Analytics"),
      import("./Requests"), import("./ReviewPublish"), import("./Variables"),
    ]),
  ]);
  const [services, routes, consumers, plugins, upstreams, certificates, overview, snapshots, clusters, analytics, requests, publish, variables] = pages;
  const SECTIONS: Record<string, () => ReactElement> = {
    services: () => <services.ServicesPage />,
    routes: () => <routes.RoutesPage />,
    variables: () => <variables.VariablesPage />,
    consumers: () => <consumers.ConsumersPage />,
    plugins: () => <plugins.PluginsPage />,
    upstreams: () => <upstreams.UpstreamsPage />,
    certificates: () => <certificates.CertificatesPage />,
    overview: () => <overview.OverviewPage />,
    publications: () => <snapshots.SnapshotsPage />,
    clusters: () => <clusters.ClustersPage />,
    metrics: () => <analytics.AnalyticsPage />,
    requests: () => <requests.RequestsPage />,
    publish: () => <publish.ReviewPublishPage />,
  };
  const render = (client: QueryClient, path: string) => renderToString(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route element={<Shell />}>
              <Route path="e/:envId/services/:serviceId" element={<services.ServiceDetailPage />} />
              {Object.entries(SECTIONS).map(([section, element]) => <Route key={section} path={`e/:envId/${section}`} element={element()} />)}
            </Route>
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
  return { render, sections: Object.keys(SECTIONS) };
}

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
// Rendering registers each query the screen reads (with its options); fetching them fills the cache as the browser would.
const fetchAll = (client: QueryClient) => Promise.allSettled(client.getQueryCache().getAll().map((q) => q.fetch()));
// Read by the selector or shared by the whole instance, never by one workspace.
const INSTANCE_KEYS = new Set(["environments", "plugin-catalog", "plugin-schema", "workspace-creation-policy"]);

describe("switching workspaces", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keys every query of a workspace screen by the workspace id", async () => {
    const { render, sections } = await load();
    for (const section of sections) {
      const client = newClient();
      render(client, `/e/${A}/${section}`);
      const keys: QueryKey[] = client.getQueryCache().getAll().map((q) => q.queryKey);
      expect(keys.length, section).toBeGreaterThan(1);
      for (const key of keys) {
        if (INSTANCE_KEYS.has(String(key[0]))) continue;
        expect(key, `${section}: ${JSON.stringify(key)}`).toContain(A);
      }
    }
  });

  it("shows nothing of the previous workspace while the next one loads", async () => {
    const { render } = await load();
    const client = newClient();
    render(client, `/e/${A}/services`);
    await fetchAll(client);
    const before = render(client, `/e/${A}/services`);
    expect(before).toContain("servico-de-pagamentos");

    render(client, `/e/${B}/services`);
    void fetchAll(client);
    const after = render(client, `/e/${B}/services`);
    expect(after).not.toContain("servico-de-pagamentos");
    expect(after).not.toContain("Nenhum service");
    expect(after).toContain("Carregando");
    // The selector already shows B, and its list (instance-wide) is the only data reused.
    expect(after).toMatch(new RegExp(`<option value="${B}" selected="">Recargas</option>`));
  });
});


describe("v1 publication strip on workspace gateway screens", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(["services", "services/service-1", "routes", "variables"])("shows the strip on %s with pending changes", async (section) => {
    const { render } = await load();
    const client = newClient();
    client.setQueryData(["environment", A], { ...env(A, "Pagamentos"), hasUnpublishedChanges: true });
    const html = render(client, `/e/${A}/${section}`);
    expect(html).toContain('aria-label="Publicação"');
    expect(html).toContain(`/e/${A}/publish`);
    expect(client.getQueryCache().find({ queryKey: ["clusters", A] })).toBeDefined();
    expect(client.getQueryCache().find({ queryKey: ["preview", A] })).toBeDefined();
  });

  it("retains the strip on v1 screens", async () => {
    const { render } = await load();
    const client = newClient();
    client.setQueryData(["environment", A], { ...env(A, "Pagamentos"), hasUnpublishedChanges: true });
    expect(render(client, `/e/${A}/plugins`)).toContain('aria-label="Publicação"');
  });
});
