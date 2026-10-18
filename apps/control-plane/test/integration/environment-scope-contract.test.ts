import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parse } from "yaml";

// The guard derives the effective role from {envId}, or from the environment of {clusterId}. A new path that
// addresses a resource by id anywhere else would silently fall back to the global role.
const contract = parse(readFileSync(new URL("../../../../contracts/control-plane.openapi.yaml", import.meta.url), "utf8")) as { paths: Record<string, unknown> };
const GLOBAL = new Set(["users", "tokens", "me", "auth", "environments", "plugin-schemas", "audit-events"]);
const MESSAGE = "rota nova fora do escopo de environment: decida o papel efetivo antes";

/** Paths with a path parameter that are neither environment-scoped nor in the explicit list of global routes. */
function outOfScope(paths: string[]): string[] {
  return paths.filter((path) => {
    if (!/\{[^}]+\}/.test(path)) return false;
    if (path === "/environments/{envId}" || path.startsWith("/environments/{envId}/")) return false;
    if (path === "/clusters/{clusterId}" || path.startsWith("/clusters/{clusterId}/")) return false;
    const first = path.split("/")[1] ?? "";
    // /environments/... is only global through {envId}, checked above.
    return first === "environments" || !GLOBAL.has(first);
  });
}

test("every path with a resource id is environment-scoped or an explicitly global route", () => {
  expect(outOfScope(Object.keys(contract.paths)), MESSAGE).toEqual([]);
});

test("the check flags what it should", () => {
  expect(outOfScope([
    "/services/{serviceId}",
    "/environments/{environmentId}/services",
    "/snapshots/{version}",
    "/users/{userId}",
    "/tokens/{tokenId}",
    "/environments/{envId}/routes/{routeId}",
    "/clusters/{clusterId}/rotate-token",
    "/plugin-schemas/{pluginName}",
    "/environments",
  ])).toEqual(["/services/{serviceId}", "/environments/{environmentId}/services", "/snapshots/{version}"]);
});
