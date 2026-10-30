import { MutationObserver, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Release } from "../api/client-v2";

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
