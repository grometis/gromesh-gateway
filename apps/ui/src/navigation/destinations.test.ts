import { describe, expect, it } from "vitest";
import { matchRoutes, type RouteObject } from "react-router";
import { appRoutes } from "../router";
import { classifyRoute } from "./context";
import { destinationHref, destinations, resolveDestination } from "./destinations";

const v2 = "/workspaces/w";
describe("route classification and declarative destinations", () => {
  it("registers each destination id and scoped path only once", () => {
    expect(new Set(destinations.map(destination => destination.id)).size).toBe(destinations.length);
    expect(new Set(destinations.map(destination => `${destination.scope}:${destination.path}`)).size).toBe(destinations.length);
  });
  it("registers each router path only once through pathless wrappers", () => {
    const paths: string[] = [];
    const visit = (routes: readonly RouteObject[], parent = "") => {
      for (const route of routes) {
        const path = route.path?.startsWith("/") ? route.path : `${parent}/${route.path ?? ""}`.replace(/\/+/g, "/");
        if (route.path !== undefined || route.index) paths.push(route.index ? `${path}/(index)` : path);
        if (route.children) visit(route.children, path);
      }
    };
    visit(appRoutes);
    expect(paths.filter((path, index) => paths.indexOf(path) !== index)).toEqual([]);
  });
  it.each(["overview", "services", "routes", "consumers", "plugins", "upstreams", "certificates", "variables", "releases"])(
    "preserves the integrated %s route in both namespaces", section => {
      for (const [prefix, scope] of [["/workspaces/w", "workspace-v2"], ["/e/w", "legacy-v1"]] as const) {
        expect(classifyRoute(`${prefix}/${section}`)).toEqual({ kind: scope, id: "w" });
        expect(matchRoutes(appRoutes, `${prefix}/${section}`)?.at(-1)?.route.path).toBe(section);
        expect(destinations.filter(destination => destination.scope === scope && destination.path.endsWith(`/${section}`))).toHaveLength(1);
      }
    },
  );
  it.each([
    ["/", "global"], ["/workspaces?cursor=x#list", "global"], ["/users", "admin"],
    ["/audit/", "admin"], ["/tokens?x#y", "account"], ["/Tokens/", "account"],
    ["/no-such-route", "unknown"], ["/login", "unknown"],
    ["/e/w/no-such-page", "unknown"], ["/workspaces/w/services/s/extra", "unknown"],
  ])("classifies %s as %s", (path, kind) => expect(classifyRoute(path)).toEqual({ kind }));

  it.each(destinations.filter((d) => d.scope === "legacy-v1" || d.scope === "workspace-v2"))(
    "registers and classifies $path in its own scope", (destination) => {
      const path = destinationHref(destination, "w").replace(/:(serviceId|consumerId|version)/, "one");
      expect(classifyRoute(`${path}?x=1#y`)).toEqual({ kind: destination.scope, id: "w" });
      expect(resolveDestination(path)?.activeId).toBe(destination.parentId ?? destination.id);
      const matched = matchRoutes(appRoutes, path);
      expect(matched?.at(-1)?.route.path).not.toBe("*");
      expect(matched?.at(-1)?.route.element).toBeTruthy();
    },
  );

  it("resolves Workspace certificates independently from the legacy route", () => {
    expect(classifyRoute(`${v2}/certificates`)).toEqual({ kind: "workspace-v2", id: "w" });
    expect(resolveDestination(`${v2}/certificates`)?.activeId).toBe("v2-N09");
    expect(matchRoutes(appRoutes, `${v2}/certificates`)?.at(-1)?.route.path).toBe("certificates");
  });
  it.each(["metrics", "requests", "publish", "publications", "clusters", "analytics"])("excludes v1 page %s from v2", (page) => {
    expect(classifyRoute(`${v2}/${page}`)).toEqual({ kind: "unknown" });
    expect(classifyRoute(`/e/w/${page}`)).toEqual({ kind: "legacy-v1", id: "w" });
  });
  it.each(["consumers", "consumers/c"])("registers v2 %s", page => {
    expect(classifyRoute(`${v2}/${page}`)).toEqual({ kind: "workspace-v2", id: "w" });
    expect(matchRoutes(appRoutes, `${v2}/${page}`)?.at(-1)?.route.path).toBe(page === "consumers" ? page : "consumers/:consumerId");
    expect(resolveDestination(`${v2}/${page}?x=1#y`)).toMatchObject({
      activeId: "v2-N05", destination: { label: page === "consumers" ? "Consumidores" : "Consumidor" },
    });
  });
  it("resolves the Workspace entry and overview to their shared v2 destination", () => {
    expect(classifyRoute(`${v2}/overview`)).toEqual({ kind: "workspace-v2", id: "w" });
    expect(resolveDestination(v2)?.activeId).toBe("v2-N01");
    expect(resolveDestination(`${v2}/overview`)?.activeId).toBe("v2-N01");
  });
  it("keeps namespaces distinct even with the same id and encodes IDs", () => {
    expect(classifyRoute("/e/w/services")).toEqual({ kind: "legacy-v1", id: "w" });
    expect(classifyRoute(`${v2}/services`)).toEqual({ kind: "workspace-v2", id: "w" });
    const d = destinations.find((d) => d.id === "v2-N02")!;
    expect(destinationHref(d, "a/b?#")).toBe("/workspaces/a%2Fb%3F%23/services");
    expect(classifyRoute("/workspaces/%zz/services")).toEqual({ kind: "unknown" });
  });
});
