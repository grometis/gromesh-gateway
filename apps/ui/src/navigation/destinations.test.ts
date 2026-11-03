import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { auxiliaryRoutes, destinations, destinationHref, resolveDestination, visibleDestinations } from "./destinations";

const routes = [
  ["N01", "/e/w/overview", "N01"], ["N02", "/e/w/services", "N02"], ["N03", "/e/w/services/s", "N02"],
  ["N04", "/e/w/routes", "N04"], ["N05", "/e/w/consumers", "N05"], ["N06", "/e/w/consumers/c", "N05"],
  ["N07", "/e/w/plugins", "N07"], ["N08", "/e/w/upstreams", "N08"], ["N09", "/e/w/certificates", "N09"],
  ["N10", "/e/w/variables", "N10"], ["N11", "/e/w/releases", "N11"], ["N12", "/e/w/publish", "N12"],
  ["N13", "/e/w/publications", "N13"], ["N14", "/e/w/publications/2", "N13"], ["N15", "/e/w/clusters", "N15"],
  ["N16", "/e/w/metrics", "N16"], ["N17", "/e/w/requests", "N17"], ["N18", "/workspaces", "N18"],
  ["N19", "/tokens", "N19"], ["N20", "/users", "N20"], ["N21", "/audit", "N21"], ["N22", "/login", undefined],
] as const;

describe("navigation destinations on existing URLs", () => {
  it.each(routes)("resolves %s and its sidebar ancestor", (id, path, activeId) => {
    const match = resolveDestination(path);
    expect(match?.destination.id).toBe(id);
    expect(match?.activeId).toBe(activeId);
    expect(destinationHref(match!.destination, "w")).toBe(path.includes("/services/s") ? "/e/w/services/:serviceId"
      : path.includes("/consumers/c") ? "/e/w/consumers/:consumerId"
      : path.includes("/publications/2") ? "/e/w/publications/:version" : path);
  });

  it("covers every router path without adding fictitious destinations", () => {
    const source = readFileSync(new URL("../router.tsx", import.meta.url), "utf8");
    const actual = [...source.matchAll(/path: "([^"]+)"/g)].map((match) => match[1]!);
    // The sole contextual branch owns every relative path after e/:envId.
    const contextual = actual.indexOf("e/:envId");
    const routerPatterns = actual.map((path, index) => path === "*" ? path : index > contextual ? `/e/:envId/${path}` : path.startsWith("/") ? path : `/${path}`);
    const documented = [...destinations.map((item) => item.path), ...auxiliaryRoutes.map((item) => item.path)];
    expect(new Set(documented)).toEqual(new Set([...routerPatterns, "/"]));
    expect(destinations.map((item) => item.id).sort()).toEqual(routes.map(([id]) => id).sort());
  });

  it("maps existing auxiliary entries without introducing redirects", () => {
    expect(auxiliaryRoutes.map((route) => route.path)).toEqual(["/", "/e/:envId", "/e/:envId/analytics", "*"]);
    expect(resolveDestination("/e/w/analytics")?.activeId).toBe("N16");
    expect(resolveDestination("/e/w")?.activeId).toBe("N02");
    expect(resolveDestination("/")).toBeUndefined();
    expect(resolveDestination("/unknown")).toBeUndefined();
  });

  it.each(["/E/w/Services/s/", "/e/w/services/s?tab=routes#plugins", "/e/w/services/a%2Fb"]) ("keeps a single parent active for %s", (path) => {
    expect(resolveDestination(path)?.activeId).toBe("N02");
  });

  it.each(["/e/w/services-old", "/e/w/routes/fake", "/e/w/releases/fake", "/e/w/publications/2/fake"])("does not invent descendants for %s", (path) => {
    expect(resolveDestination(path)).toBeUndefined();
  });

  it.each(["admin", "editor", "viewer"] as const)("keeps current visibility for %s without inferring workspace grants", (role) => {
    const items = visibleDestinations(role, "workspace");
    expect(items.filter((item) => item.group === "administration").map((item) => item.id)).toEqual(role === "admin" ? ["N20", "N21"] : []);
    expect(items.filter((item) => item.scope === "workspace").map((item) => item.id).sort()).toEqual(["N01", "N02", "N04", "N05", "N07", "N08", "N09", "N10", "N11", "N12", "N13", "N15", "N16", "N17"]);
    expect(items.every((item) => !item.parentId && item.id !== "N22")).toBe(true);
    expect(visibleDestinations(role, "").some((item) => item.scope === "workspace")).toBe(false);
  });
});
