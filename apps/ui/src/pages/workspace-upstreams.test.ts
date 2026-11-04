import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";

describe("workspace upstream transport", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());
  async function setup(respond: (r: Request) => Response | Promise<Response> = () => Response.json({ items: [], nextCursor: null })) {
    const NativeRequest = Request;
    vi.stubGlobal("Request", class extends NativeRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(typeof input === "string" ? new URL(input, "https://ui.example") : input, init);
      }
    });
    const requests: Request[] = [];
    vi.stubGlobal("fetch", (r: Request) => {
      requests.push(r);
      return Promise.resolve(r.url.endsWith("/auth/csrf") ? Response.json({ csrfToken: "csrf" }) : respond(r));
    });
    return { requests, ...(await import("./workspace-upstreams")) };
  }
  it("scopes paginated reads and bounded service references to v2, apart from all-upstreams cache", async () => {
    const m = await setup();
    await m.upstreamPageQuery("A", "next").queryFn({ signal: new AbortController().signal });
    await m.targetPageQuery("B", "U", "target-page").queryFn({ signal: new AbortController().signal });
    await m.upstreamServicesQuery("A").queryFn({ signal: new AbortController().signal });
    expect(m.requests.map((r) => new URL(r.url).pathname)).toEqual([
      "/api/v2/workspaces/A/upstreams", "/api/v2/workspaces/B/upstreams/U/targets", "/api/v2/workspaces/A/services",
    ]);
    expect(new URL(m.requests[0]!.url).searchParams.get("cursor")).toBe("next");
    expect(new URL(m.requests[1]!.url).searchParams.get("cursor")).toBe("target-page");
    expect(new URL(m.requests[2]!.url).searchParams.get("limit")).toBe("200");
    expect(m.upstreamPageKey("A")).not.toEqual(["ws-upstreams", "A"]);
    expect(m.upstreamPageKey("A")).not.toEqual(m.upstreamPageKey("B"));
    expect(m.targetPageKey("A", "U")).not.toEqual(m.targetPageKey("B", "U"));
  });
  it("creates, replaces and deletes with CSRF and exact closed write bodies", async () => {
    const m = await setup((r) => r.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({}));
    const body = { name: "orders", algorithm: "consistent-hashing" as const, hashOn: "header" as const, hashOnHeader: "X-Key", hashFallback: "none" as const, hashOnCookiePath: "/", healthchecks: { active: { type: "tcp" as const, httpPath: "/", intervalSeconds: 10, healthyThreshold: 2, unhealthyThreshold: 3, timeoutSeconds: 1 }, passive: null } };
    await m.saveWorkspaceUpstream("A", null, body);
    await m.saveWorkspaceUpstream("A", "U", body);
    await m.deleteWorkspaceUpstream("A", "U");
    const target = { target: "backend.internal:8080", weight: 0, tags: ["keep"] };
    await m.saveWorkspaceTarget("A", "U", null, target);
    await m.saveWorkspaceTarget("A", "U", "T", target);
    await m.deleteWorkspaceTarget("A", "U", "T");
    const writes = m.requests.filter((r) => r.method !== "GET");
    expect(writes.map((r) => [r.method, new URL(r.url).pathname])).toEqual([
      ["POST", "/api/v2/workspaces/A/upstreams"], ["PUT", "/api/v2/workspaces/A/upstreams/U"], ["DELETE", "/api/v2/workspaces/A/upstreams/U"],
      ["POST", "/api/v2/workspaces/A/upstreams/U/targets"], ["PUT", "/api/v2/workspaces/A/upstreams/U/targets/T"], ["DELETE", "/api/v2/workspaces/A/upstreams/U/targets/T"],
    ]);
    expect(await writes[0]!.json()).toEqual(body);
    expect(await writes[4]!.json()).toEqual(target);
    for (const r of writes) expect(r.headers.get("X-CSRF-Token")).toBe("csrf");
  });
  it.each([401, 403, 404, 409, 422, 500])("keeps HTTP %s as an error instead of an empty page", async (status) => {
    const m = await setup(() => Response.json({ title: "Rejected", status }, { status }));
    await expect(m.upstreamPageQuery("A").queryFn({ signal: new AbortController().signal })).rejects.toMatchObject({ status });
    await expect(m.saveWorkspaceTarget("A", "U", null, { target: "host:80" })).rejects.toMatchObject({ status });
  });
  it("expires the shared session on v2 401", async () => {
    const m = await setup(() => Response.json({ title: "Unauthorized", status: 401 }, { status: 401 }));
    const { setUnauthorizedHandler } = await import("../api/client");
    const expired = vi.fn();
    setUnauthorizedHandler(expired);
    await expect(m.deleteWorkspaceUpstream("A", "U")).rejects.toMatchObject({ status: 401 });
    expect(expired).toHaveBeenCalledOnce();
  });
  it("invalidates both draft views and upstream selectors only for the affected Workspace", async () => {
    const m = await setup();
    const client = new QueryClient();
    const families = ["ws-upstream-pages", "ws-upstreams", "ws-target-pages", "ws-upstream-services", "upstreams", "targets", "ws-services", "ws-services-all", "ws-service", "environment", "preview"];
    for (const family of families) for (const w of ["A", "B"]) client.setQueryData([family, w], {});
    m.invalidateWorkspaceUpstreams(client, "A");
    for (const family of families) {
      expect(client.getQueryState([family, "A"])?.isInvalidated).toBe(true);
      expect(client.getQueryState([family, "B"])?.isInvalidated).toBe(false);
    }
  });
  it("translates auto-publish and VarRef errors without promising variable support", async () => {
    const m = await setup();
    const { ApiError } = await import("../api/client");
    expect(m.upstreamErrorMessage(new ApiError(409, { type: "about:blank", title: "Conflict", status: 409, ...{ code: "auto-publish" } }))).toContain("publicação manual");
    const errors = m.upstreamFormErrors(new ApiError(422, { type: "about:blank", title: "Invalid", status: 422, errors: [{ path: "target", message: "Variable is not declared" }] }));
    expect(errors.fields.target?.join()).toContain("variáveis");
    expect(errors.fields.target?.join()).not.toContain("not declared");
  });
});
