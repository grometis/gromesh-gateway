import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { kongUpstreamPath, routePathDiff } from "./path-compatibility.js";

// Measured on Kong 3.9.4 DB-less (the gromesh-kong image, path_handling v0) through an echo backend: for each case,
// the path the upstream received.
const OBSERVED = JSON.parse(readFileSync(new URL("./kong-3.9-path-handling-v0.json", import.meta.url), "utf8")) as {
  servicePath: string | null;
  routePath: string;
  strip: boolean;
  request: string;
  upstream: string;
}[];

describe("kongUpstreamPath", () => {
  it.each(OBSERVED.map((c) => [c.servicePath, c.routePath, c.strip, c.request, c.upstream] as const))(
    "service %j, route %s, strip %s: %s reaches the upstream as %s",
    (servicePath, routePath, strip, request, upstream) => {
      expect(kongUpstreamPath(servicePath, request, strip ? routePath : "")).toBe(upstream);
    },
  );
});

describe("routePathDiff", () => {
  const route = { id: "00000000-0000-4000-8000-000000000001", paths: ["/orders"], stripPath: true, pathCompatibility: "legacy-preserved" };
  const service = { id: "00000000-0000-4000-8000-000000000002", path: "/v1" };

  it("shows a literal path at itself and going on past it, before and in the workspace default", () => {
    expect(routePathDiff(route, service, "tvro").paths).toEqual([
      { publicPath: "/tvro/orders", upstreamBefore: "/orders -> /v1; /orders/{rest} -> /v1/{rest}", upstreamAfter: "/tvro/orders -> /v1/tvro/orders; /tvro/orders/{rest} -> /v1/tvro/orders/{rest}" },
    ]);
  });

  it("keeps the trailing slash and composes the root literally", () => {
    const diff = routePathDiff({ ...route, paths: ["/orders/", "/"] }, service, "tvro");
    expect(diff.paths).toEqual([
      { publicPath: "/tvro/orders/", upstreamBefore: "/orders/ -> /v1/; /orders/{rest} -> /v1/{rest}", upstreamAfter: "/tvro/orders/ -> /v1/tvro/orders/; /tvro/orders/{rest} -> /v1/tvro/orders/{rest}" },
      { publicPath: "/tvro/", upstreamBefore: "/ -> /v1; /{rest} -> /v1/{rest}", upstreamAfter: "/tvro/ -> /v1/tvro/; /tvro/{rest} -> /v1/tvro/{rest}" },
    ]);
  });

  it("shows what a regex strips: the whole matched sequence, never the rest", () => {
    const [stripped] = routePathDiff({ ...route, paths: ["~/orders/[0-9]+"] }, service, "tvro").paths;
    expect(stripped).toEqual({
      publicPath: "~/tvro(?:/orders/[0-9]+)",
      upstreamBefore: "~/orders/[0-9]+: {match}{rest} -> /v1/{rest}",
      upstreamAfter: "~/tvro(?:/orders/[0-9]+): /tvro{match}{rest} -> /v1/tvro{match}{rest}",
    });
    const [kept] = routePathDiff({ ...route, stripPath: false, paths: ["~/orders/[0-9]+"] }, service, "tvro").paths;
    expect(kept!.upstreamBefore).toBe("~/orders/[0-9]+: {match}{rest} -> /v1{match}{rest}");
  });

  it("changes the digest with anything the paths depend on", () => {
    const base = routePathDiff(route, service, "tvro").diffDigest;
    for (const diff of [
      routePathDiff(route, { ...service, path: "/v2" }, "tvro"),
      routePathDiff(route, { ...service, id: "00000000-0000-4000-8000-000000000003" }, "tvro"),
      routePathDiff({ ...route, stripPath: false }, service, "tvro"),
      routePathDiff({ ...route, paths: ["/orders", "/more"] }, service, "tvro"),
      routePathDiff(route, service, "tvro-2"),
      routePathDiff({ ...route, paths: ["~/orders/[0-9]+"] }, { ...service, path: "/v2" }, "tvro"),
    ]) {
      expect(diff.diffDigest).not.toBe(base);
    }
    expect(routePathDiff({ ...route, paths: ["~/a"] }, service, "tvro").diffDigest).not.toBe(routePathDiff({ ...route, paths: ["~/a"] }, { ...service, path: "/v2" }, "tvro").diffDigest);
  });
});
