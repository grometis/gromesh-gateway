import { afterEach, expect, it, vi } from "vitest";
import { parsePluginSchema } from "../schema-form/schema";
import type { Plugin, PluginCatalogEntry } from "../api/client";
const W = "7c1d2e3f-4a5b-4c6d-8e7f-00000000000a", C = "7c1d2e3f-4a5b-4c6d-8e7f-00000000000c";
const entry: PluginCatalogEntry = { name: "rate-limiting", category: "traffic-control", supportedInDbless: true, source: "bundled" };
const schema = parsePluginSchema({ fields: [{ consumer: { type: "foreign" } }, { config: { type: "record", fields: [] } }] });
const plugin: Plugin = { id: W, name: entry.name, enabled: true, scope: { consumerId: C, serviceId: W }, config: {}, createdAt: "2026-11-03T12:00:00Z", updatedAt: "2026-11-03T12:00:00Z" };
afterEach(() => vi.unstubAllGlobals());
async function load(respond: (r: Request) => Response | Promise<Response>) {
  vi.resetModules();
  const Native = Request;
  vi.stubGlobal("Request", class extends Native { constructor(input: RequestInfo | URL, init?: RequestInit) { super(typeof input === "string" ? new URL(input, "https://ui.example") : input, init); } });
  vi.stubGlobal("fetch", (r: Request) => r.url.endsWith("/auth/csrf") ? Promise.resolve(Response.json({ csrfToken: "csrf" })) : respond(r));
  return import("./consumer-plugins");
}
it("lists only the fixed consumer with server cursor and rejects foreign rows", async () => {
  const sent: Request[] = [];
  const api = await load(r => { sent.push(r); return Response.json({ items: [plugin, { ...plugin, id: C, scope: {} }, { ...plugin, id: "foreign", scope: { consumerId: W } }], nextCursor: "next" }); });
  expect(await api.listConsumerPlugins(W, C, "cursor")).toEqual({ items: [plugin], nextCursor: "next" });
  const u = new URL(sent[0]!.url);
  expect(u.pathname).toBe(`/api/v2/workspaces/${W}/plugins`);
  expect(Object.fromEntries(u.searchParams)).toEqual({ consumerId: C, cursor: "cursor" });
});
it.each(["key-auth", "basic-auth", "jwt", "hmac-auth", "session", "ldap-auth", "oauth2", "acme", "pre-function", "post-function", "file-log", "gromesh-workspace", "prometheus", "http-log"])("excludes reserved or authentication type %s", async name => {
  const api = await load(() => Response.json({}));
  expect(api.consumerPluginAllowed({ ...entry, name }, schema)).toBe(false);
});
it("requires a known supported catalog entry and a consumer-compatible schema", async () => {
  const api = await load(() => Response.json({}));
  expect(api.consumerPluginAllowed(entry, schema)).toBe(true);
  expect(api.consumerPluginAllowed(undefined, schema)).toBe(false);
  expect(api.consumerPluginAllowed({ ...entry, category: "authentication" }, schema)).toBe(false);
  expect(api.consumerPluginAllowed({ ...entry, supportedInDbless: false }, schema)).toBe(false);
  expect(api.consumerPluginAllowed(entry, { ...schema, scopes: { ...schema.scopes, consumer: false } })).toBe(false);
});
it("blocks Lua and ambient credentials at their fields", async () => {
  const api = await load(() => Response.json({}));
  expect(api.consumerPluginConfigErrors("tcp-log", { custom_fields_by_lua: { secret: "return secret" } })).toHaveProperty("config.custom_fields_by_lua");
  expect(api.consumerPluginConfigErrors("aws-lambda", {})).toHaveProperty("config.aws_key");
  expect(api.consumerPluginConfigErrors("aws-lambda", { aws_key: "own-key", aws_secret: "own-secret" })).toEqual({});
  expect(api.consumerPluginConfigErrors("ai-proxy", { auth: { gcp_use_service_account: true } })).toHaveProperty("config.auth.gcp_use_service_account");
});
it.each([null, plugin])("confirms the consumer, fixes scope and preserves combined scopes on save (%s)", async current => {
  const sent: Request[] = [];
  const api = await load(r => { sent.push(r); return Response.json(r.method === "GET" ? { id: C } : plugin); });
  await api.saveConsumerPlugin(W, C, current, { name: entry.name, enabled: true, scope: {}, config: { minute: 20 } });
  expect(sent.map(r => r.method)).toEqual(["GET", current ? "PUT" : "POST"]);
  expect(new URL(sent[0]!.url).pathname).toBe(`/api/v2/workspaces/${W}/consumers/${C}`);
  expect((await sent[1]!.json()).scope).toEqual(current ? plugin.scope : { consumerId: C });
});
it("never writes a foreign plugin or a consumer deleted before save", async () => {
  const sent: Request[] = [];
  const api = await load(r => { sent.push(r); return Response.json({ type: "about:blank", title: "Gone", status: 404 }, { status: 404 }); });
  await expect(api.saveConsumerPlugin(W, C, { ...plugin, scope: { consumerId: W } }, { name: entry.name, enabled: true, scope: {}, config: {} })).rejects.toMatchObject({ status: 404 });
  expect(sent).toHaveLength(0);
  await expect(api.saveConsumerPlugin(W, C, null, { name: entry.name, enabled: true, scope: {}, config: {} })).rejects.toMatchObject({ status: 404 });
  expect(sent.every(r => r.method === "GET")).toBe(true);
});
it("sanitizes catalog and list failures without echoing upstream details", async () => {
  const api = await load(() => Response.json({}));
  const { ApiError } = await import("../api/client");
  expect(api.consumerPluginMessage(new ApiError(503, { type: "about:blank", title: "secret", detail: "secret", status: 503 }))).toBe("Erro inesperado (HTTP 503).");
  expect(api.consumerPluginMessage(new TypeError("secret"))).toContain("Não foi possível falar");
});
