import { describe, expect, it } from "vitest";
import { matchRoutes } from "react-router";
import { appRoutes } from "../router";
import { classifyRoute } from "./context";
import { destinationHref, destinations, resolveDestination } from "./destinations";

const v2 = "/workspaces/w";
describe("route classification and declarative destinations", () => {
  it.each([
    ["/", "global"], ["/workspaces?cursor=x#list", "global"], ["/users", "admin"],
    ["/audit/", "admin"], ["/tokens?x#y", "account"], ["/Tokens/", "account"],
    ["/no-such-route", "unknown"], ["/login", "unknown"], ["/workspaces/w/overview", "unknown"],
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

  it.each(["overview", "metrics", "requests", "publish", "publications", "clusters", "upstreams", "certificates", "analytics"])("excludes v1 page %s from v2", (page) => {
    expect(classifyRoute(`${v2}/${page}`)).toEqual({ kind: "unknown" });
    expect(classifyRoute(`/e/w/${page}`)).toEqual({ kind: "legacy-v1", id: "w" });
  });
  it.each(["consumers", "consumers/c"])("registers v2 %s", page => {
    expect(classifyRoute(`${v2}/${page}`)).toEqual({ kind: "workspace-v2", id: "w" });
    expect(matchRoutes(appRoutes, `${v2}/${page}`)?.at(-1)?.route.path).toBe(page === "consumers" ? page : "consumers/:consumerId");
  });
  it("keeps namespaces distinct even with the same id and encodes IDs", () => {
    expect(classifyRoute("/e/w/services")).toEqual({ kind: "legacy-v1", id: "w" });
    expect(classifyRoute(`${v2}/services`)).toEqual({ kind: "workspace-v2", id: "w" });
    const d = destinations.find((d) => d.id === "v2-N02")!;
    expect(destinationHref(d, "a/b?#")).toBe("/workspaces/a%2Fb%3F%23/services");
    expect(classifyRoute("/workspaces/%zz/services")).toEqual({ kind: "unknown" });
  });
});
