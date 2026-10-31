import { MutationObserver, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Release } from "../api/client-v2";
import { installTestDom } from "../test/dom";

vi.mock("../auth", async (importOriginal) => ({
  ...await importOriginal<typeof import("../auth")>(),
  useAuth: () => ({ user: { role: "viewer", name: "Ana" }, logout: vi.fn() }),
  useCanEdit: () => false,
}));

const W = "6d3e8b20-4c5e-4d6f-9a70-00000000000a";
const B = "6d3e8b20-4c5e-4d6f-9a70-00000000000b";
const release: Release = {
  workspaceId: W, version: 2, contentDigest: `sha256:${"a".repeat(64)}`, origin: "local",
  contentOriginVersion: 2, contentFirstActivatedAt: null, originPromotionId: null, contentRevoked: false,
  createdAt: "2026-10-30T12:00:00Z", createdBy: { name: "Ana" }, message: "Cobrança",
};

async function load(answer: (request: Request) => Promise<Response>) {
  vi.resetModules();
  const NativeRequest = Request;
  vi.stubGlobal("Request", class extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(typeof input === "string" ? new URL(input, "https://ui.example") : input, init);
    }
  });
  vi.stubGlobal("fetch", answer);
  return import("./Releases");
}

describe("workspace releases", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the refreshed active version on the next publication through the screen", async () => {
    const container = installTestDom();
    let activeRelease: number | null = null;
    const published: Release[] = [];
    const expectedVersions: (number | null)[] = [];
    const { ReleasesPage } = await load(async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/v1/auth/csrf") return Response.json({ csrfToken: "csrf" });
      if (path === `/api/v2/workspaces/${W}/releases`) {
        if (request.method === "GET") return Response.json(published);
        const body = await request.json() as { expectedActiveVersion: number | null };
        expectedVersions.push(body.expectedActiveVersion);
        if (body.expectedActiveVersion !== activeRelease) return Response.json({ status: 409, detail: "Active release changed" }, { status: 409 });
        activeRelease = (activeRelease ?? 0) + 1;
        const next = { ...release, version: activeRelease, contentOriginVersion: activeRelease };
        published.unshift(next);
        return Response.json(next, { status: 201 });
      }
      if (path === `/api/v2/workspaces/${W}`) return Response.json({ id: W, name: "Pagamentos", status: "active", activeRelease });
      if (path === `/api/v1/environments/${W}`) return Response.json({ publishMode: "manual", hasUnpublishedChanges: true });
      throw new Error(`Unexpected request: ${request.method} ${path}`);
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as HTMLElement);
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    const settle = async () => { await act(async () => { await tick(); }); };
    const click = async (label: string) => {
      const button = container.findAll((node) => node.tagName === "BUTTON" && node.textContent === label)[0];
      expect(button, label).toBeDefined();
      expect(button!.getAttribute("disabled"), label).toBeNull();
      await act(async () => { button!.dispatchEvent(new Event("click", { bubbles: true })); await tick(); });
      await settle();
    };
    try {
      await act(async () => {
        root.render(<QueryClientProvider client={client}>
          <MemoryRouter initialEntries={[`/e/${W}/releases`]}>
            <Routes><Route path="/e/:envId/releases" element={<ReleasesPage />} /></Routes>
          </MemoryRouter>
        </QueryClientProvider>);
        await tick();
      });
      await settle();
      await settle();
      expect(container.textContent).toContain("Nenhuma release ativa informada.");
      for (const version of [1, 2]) {
        await click("Publicar release");
        await click("Confirmar publicação");
        await settle();
        expect(container.findAll((node) => node.getAttribute("role") === "dialog")).toHaveLength(0);
        expect(container.textContent).toContain(`Release ativa: v${version}.`);
        expect(client.getQueryData(["workspace", W])).toMatchObject({ activeRelease: version });
      }
      expect(expectedVersions).toEqual([null, 1]);
    } finally {
      await act(() => root.unmount());
      client.clear();
    }
  });

  it.each([403, 201])("offers publication to a legacy viewer and honors the server response (%s)", async (status) => {
    const requests: Request[] = [];
    const { ReleasesPage, releasesQuery, publishReleaseMutation, releaseErrors } = await load(async (request) => {
      requests.push(request);
      if (request.method === "GET") return Response.json({ csrfToken: "csrf" });
      return status === 201 ? Response.json(release, { status })
        : Response.json({ title: "Forbidden", status, detail: "Requires release.publish" }, { status });
    });
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    const workspace = { status: "active", activeRelease: 1 };
    const environment = { publishMode: "manual", hasUnpublishedChanges: true, currentVersion: 3 };
    const snapshots = [{ version: 3 }];
    client.setQueryData(["workspace", W], workspace);
    client.setQueryData(["environment", W], environment);
    client.setQueryData(["snapshots", W], snapshots);
    client.setQueryData(releasesQuery(W).queryKey, []);
    const html = renderToStaticMarkup(<QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/e/${W}/releases`]}>
        <Routes><Route path="/e/:envId/releases" element={<ReleasesPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>);
    expect(html).toContain(">Publicar release</button>");
    expect(html).not.toContain("Publicação requer a permissão");
    const saved = vi.fn();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const observer = new MutationObserver(client, publishReleaseMutation(client, W, 1, saved));
    if (status === 403) {
      await expect(observer.mutate("Cobrança")).rejects.toMatchObject({ status: 403 });
      expect(releaseErrors(observer.getCurrentResult().error)).toEqual([expect.stringContaining("Você não tem permissão para publicar")]);
      expect(saved).not.toHaveBeenCalled();
      expect(invalidate).not.toHaveBeenCalled();
      expect(client.getQueryData(releasesQuery(W).queryKey)).toEqual([]);
      expect(client.getQueryData(["workspace", W])).toEqual(workspace);
    } else {
      await expect(observer.mutate("Cobrança")).resolves.toEqual(release);
      expect(saved).toHaveBeenCalledExactlyOnceWith(release);
      expect(client.getQueryData(releasesQuery(W).queryKey)).toEqual([release]);
    }
    expect(client.getQueryData(["environment", W])).toEqual(environment);
    expect(client.getQueryData(["snapshots", W])).toEqual(snapshots);
    expect(requests.map((r) => [r.method, new URL(r.url).pathname])).toEqual([
      ["GET", "/api/v1/auth/csrf"], ["POST", `/api/v2/workspaces/${W}/releases`],
    ]);
    client.clear();
  });

  it.each(["releases", "releases/", "services", "services/service-id", "routes", "consumers", "consumers/consumer-id", "plugins", "upstreams", "certificates", "publish", "publications", "publications/3", "clusters", "overview", "metrics", "analytics", "requests"])("keeps the v1 strip exclusively outside Releases (%s)", async (section) => {
    await load(() => new Promise(() => {}));
    const { Shell } = await import("../components/Shell");
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    client.setQueryData(["environments"], { items: [] });
    client.setQueryData(["environment", W], { currentVersion: 3, hasUnpublishedChanges: true });
    const html = renderToStaticMarkup(<QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/e/${W}/${section}`]}>
        <Routes><Route path="/e/:envId/*" element={<Shell />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>);
    if (section.startsWith("releases")) {
      expect(html).not.toContain('aria-label="Publicação"');
      expect(html).not.toContain(`/e/${W}/publish"`);
    } else {
      expect(html).toContain('aria-label="Publicação"');
      expect(html).toContain(`/e/${W}/publish"`);
    }
    client.clear();
  });

  it("lists and publishes only through v2, with the real CSRF middleware and version guard", async () => {
    const requests: Request[] = [];
    let published = false;
    const { releasesQuery, publishReleaseMutation, ReleasesList } = await load(async (request) => {
      requests.push(request);
      if (request.url.endsWith("/api/v1/auth/csrf")) return Response.json({ csrfToken: "session-token" });
      if (request.method === "POST") { published = true; return Response.json(release, { status: 201 }); }
      return Response.json(published ? [release] : []);
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    expect(await client.fetchQuery(releasesQuery(W))).toEqual([]);
    client.setQueryData(releasesQuery(B).queryKey, []);
    const saved = vi.fn();
    await new MutationObserver(client, publishReleaseMutation(client, W, 1, saved)).mutate("Cobrança");
    expect(requests.map((r) => [r.method, new URL(r.url).pathname])).toEqual([
      ["GET", `/api/v2/workspaces/${W}/releases`], ["GET", "/api/v1/auth/csrf"],
      ["POST", `/api/v2/workspaces/${W}/releases`],
    ]);
    expect(requests[2]!.headers.get("X-CSRF-Token")).toBe("session-token");
    expect(requests[2]!.credentials).toBe("include");
    expect(await requests[2]!.json()).toEqual({ message: "Cobrança", expectedActiveVersion: 1 });
    expect(saved).toHaveBeenCalledExactlyOnceWith(release);
    expect(client.getQueryData(releasesQuery(W).queryKey)).toEqual([release]);
    expect(client.getQueryData(releasesQuery(B).queryKey)).toEqual([]);
    const html = renderToStaticMarkup(<QueryClientProvider client={client}><ReleasesList workspaceId={W} activeVersion={2} /></QueryClientProvider>);
    expect(html).toContain("v2");
    expect(html).toContain("Ana");
    expect(html).toContain(release.contentDigest);
    expect(html).toContain("Cobrança");
    expect(html).not.toMatch(/<button|Editar|Excluir|Restaurar/);
    client.clear();
  });

  it.each([403, 409, 422])("preserves the list and reports a refused publish (%s)", async (status) => {
    const { publishReleaseMutation, releasesQuery, releaseErrors } = await load(async (r) => r.method === "GET"
      ? Response.json({ csrfToken: "csrf" })
      : Response.json({ title: "Refused", status, errors: [{ path: "services.0.host", message: status === 409 ? "Nothing to publish: the draft equals the active release" : "variable has no value" }] }, { status }));
    const client = new QueryClient();
    client.setQueryData(releasesQuery(W).queryKey, [release]);
    const saved = vi.fn();
    const observer = new MutationObserver(client, publishReleaseMutation(client, W, null, saved));
    await expect(observer.mutate("")).rejects.toMatchObject({ status });
    expect(saved).not.toHaveBeenCalled();
    expect(client.getQueryData(releasesQuery(W).queryKey)).toEqual([release]);
    const errors = releaseErrors(observer.getCurrentResult().error).join(" ");
    expect(errors).toMatch(status === 403 ? /permissão.*release.publish/ : /services.0.host/);
    expect(errors).toMatch(status === 403 ? /Somente dev/ : status === 409 ? /Sem alterações/ : /variável.*valor/);
    client.clear();
  });

  it("does not reuse another workspace's release list", async () => {
    const { releasesQuery, ReleasesList } = await load(() => new Promise(() => {}));
    const client = new QueryClient();
    client.setQueryData(releasesQuery(W).queryKey, [release]);
    const html = renderToStaticMarkup(<QueryClientProvider client={client}><ReleasesList workspaceId={B} activeVersion={null} /></QueryClientProvider>);
    expect(html).toContain("Carregando releases");
    expect(html).not.toContain("Cobrança");
    expect(releasesQuery(W).queryKey).toContain(W);
    client.clear();
  });

  it("allows auto mode only for releases, and never authorizes unknown or archived access", async () => {
    await load(() => new Promise(() => {}));
    const { workspaceGatewayAccess } = await import("./workspace-gateway");
    expect(workspaceGatewayAccess({ status: "active" }, { publishMode: "auto" }).canWrite).toBe(false);
    expect(workspaceGatewayAccess({ status: "active" }, { publishMode: "auto" }, "release").canWrite).toBe(true);
    for (const mode of ["manual", "auto"] as const) expect(workspaceGatewayAccess({ status: "archived" }, { publishMode: mode }, "release").canWrite).toBe(false);
    expect(workspaceGatewayAccess(undefined, { publishMode: "manual" }, "release").canWrite).toBe(false);
    expect(workspaceGatewayAccess({ status: "active" }, undefined, "release").canWrite).toBe(false);
  });
});
