import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { allWorkspaceServicesKey, publicPath, upstreamEffect, upstreamPath, workspaceServicesKey } from "./workspace-gateway";

// What Kong 3.9.4 sent upstream, recorded by the control plane (path_handling v0).
const OBSERVED = JSON.parse(readFileSync(new URL("../../../control-plane/src/workspaces/kong-3.9-path-handling-v0.json", import.meta.url), "utf8")) as {
  servicePath: string | null; routePath: string; strip: boolean; request: string; upstream: string;
}[];

describe("upstream path", () => {
  it.each(OBSERVED.map((o) => [o.servicePath, o.routePath, o.strip, o.request, o.upstream] as const))(
    "service %s, route %s, strip %s: %s → %s", (servicePath, routePath, strip, request, upstream) => {
      // The prefix match strips what the route path covers of the request (a route /orders also matches /ordersx).
      expect(upstreamPath(servicePath, request, strip ? request.slice(0, routePath.length) : "")).toBe(upstream);
    });

  it("includes the service's path in the preview, with and without stripPath", () => {
    expect(upstreamEffect("tvro", "/orders", false, "/v1")).toBe("Uma requisição a /tvro/orders/x chega ao upstream como /v1/tvro/orders/x.");
    expect(upstreamEffect("tvro", "/orders", true, "/v1")).toBe("Uma requisição a /tvro/orders/x chega ao upstream como /v1/x.");
    expect(upstreamEffect("tvro", "/orders", true, "/v1/")).toBe("Uma requisição a /tvro/orders/x chega ao upstream como /v1/x.");
    expect(upstreamEffect("tvro", "/orders", false, null)).toBe("Uma requisição a /tvro/orders/x chega ao upstream como /tvro/orders/x.");
    expect(upstreamEffect("tvro", "/orders/", true, null)).toBe("Uma requisição a /tvro/orders/x chega ao upstream como /x.");
    expect(upstreamEffect("tvro", "/", false, "/v1")).toBe("Uma requisição a /tvro/x chega ao upstream como /v1/tvro/x.");
    expect(upstreamEffect("tvro", "~/v[0-9]+", true, "/v1")).toBe("O upstream recebe /v1 seguido do que vier depois do trecho que a expressão casar.");
    expect(publicPath("tvro", "~/v[0-9]+")).toBe("~/tvro(?:/v[0-9]+)");
  });
});

describe("service list keys", () => {
  it("keeps the page cache and the whole list apart, whatever the search", () => {
    const w = "6d3e8b20-4c5e-4d6f-9a70-00000000000a";
    for (const q of ["", "all", "ws-services-all"]) expect(workspaceServicesKey(w, q)).not.toEqual(allWorkspaceServicesKey(w));
    expect(workspaceServicesKey(w, "all").slice(0, 2)).not.toEqual(allWorkspaceServicesKey(w).slice(0, 2));
    expect(allWorkspaceServicesKey(w)).toContain(w);
  });
});
