import { test as base, expect, type Page, type Route } from "@playwright/test";
import { normalizeSlug } from "../src/pages/workspace-slug";
import type { Me } from "../src/api/client";

const unauthorized = { title: "Unauthorized", status: 401 };
const hasSession = (cookie: string) => /(?:^|;\s*)gromesh_session=/.test(cookie);

// Prism is stateless: /me otherwise returns its example even before a browser logs in. The example is an editor
// who is only a viewer in its environment; the suites act as a plain editor (environment-roles.spec.ts covers roles).
/**
 * The contract mock serves only v1. The workspace screens read the gateway through v2 (the workspace is the
 * environment with the same id): by default these v2 reads and writes are answered by the v1 mock's same entity,
 * in the v2 shape. A suite that registers its own `/api/v2/**` routes takes precedence (registered later).
 */
async function bridgeV2(route: Route) {
  const request = route.request();
  const url = new URL(request.url());
  const [, workspaceId, rest = ""] = /^\/api\/v2\/workspaces\/([^/]+)(\/.*)?$/.exec(url.pathname) ?? [];
  const kind = /^\/(services|routes|upstreams)\b/.exec(rest)?.[1];
  if (!workspaceId || (rest && !kind)) return route.fulfill({ status: 404, json: { title: "Not Found", status: 404 } });
  const v1 = new URL(`/api/v1/environments/${workspaceId}${rest}${url.search}`, url);
  const body: unknown = request.postData() ? request.postDataJSON() : undefined;
  const { upstreamId: _upstreamId, ...v1Body } = (body ?? {}) as Record<string, unknown>;
  const response = await route.fetch({ url: v1.toString(), ...(body === undefined ? {} : { postData: JSON.stringify(v1Body) }) });
  if (!response.ok() || response.status() === 204) return route.fulfill({ response });
  const json = await response.json() as Record<string, unknown>;
  if (!kind) {
    const name = String(json.name);
    return route.fulfill({ response, json: { id: workspaceId, key: workspaceId, name, slug: normalizeSlug(name) || "workspace", status: "active", activeRelease: json.currentVersion ?? null } });
  }
  const decorate = (item: Record<string, unknown>) => kind === "services" ? { ...item, workspaceId, upstreamId: null }
    : kind === "routes" ? { ...item, pathCompatibility: "workspace-default" } : item;
  return route.fulfill({ response, json: Array.isArray(json.items) ? { ...json, items: (json.items as Record<string, unknown>[]).map(decorate) } : decorate(json) });
}

export const test = base.extend<{ cookieSession: void; gatewayV2: void }>({
  gatewayV2: [async ({ page }, use) => {
    // A request still in flight when the test ends has no page left to answer.
    await page.route("**/api/v2/workspaces/**", (route) => bridgeV2(route).catch(() => {}));
    await use();
  }, { auto: true }],
  cookieSession: [async ({ page }, use) => {
    await page.route("**/api/v1/me", async (route) => {
      if (!hasSession((await route.request().allHeaders()).cookie ?? "")) return route.fulfill({ status: 401, json: unauthorized });
      const response = await route.fetch();
      return route.fulfill({ response, json: { ...(await response.json()), environmentRoles: [] } });
    });
    await use();
  }, { auto: true }],
});
export { expect };

export async function mockSession(page: Page, user: Me) {
  await page.route("**/api/v1/me", async (route) => route.fulfill(hasSession((await route.request().allHeaders()).cookie ?? "")
    ? { json: user }
    : { status: 401, json: unauthorized }));
  await page.route("**/api/v1/auth/login", (route) => route.fulfill({
    headers: { "Set-Cookie": "gromesh_session=example-session-id; Path=/; HttpOnly; SameSite=Strict" },
    json: { user },
  }));
}
