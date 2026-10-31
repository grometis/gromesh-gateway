import { afterEach, describe, expect, it, vi } from "vitest";
import type { Plugin } from "../api/client";
import { parsePluginSchema } from "../schema-form/schema";
const W = "6d3e8b20-4c5e-4d6f-9a70-00000000000a";
const schema = parsePluginSchema({ fields: [{ config: { type: "record", fields: [
  { minute: { type: "integer", default: 10 } },
  { redis: { type: "record", fields: [{ password: { type: "string", encrypted: true, default: "unsafe-default" } }] } },
] } }] });
const body = { enabled: true, name: "rate-limiting", scope: { serviceId: W }, config: { minute: 10, redis: { password: "typed-secret" } } };
const saved: Plugin = { ...body, id: W, config: { minute: 10, redis: { password: "REDACTED" } } as unknown as Plugin["config"], createdAt: "2026-10-31T12:00:00Z", updatedAt: "2026-10-31T12:00:00Z" };

async function load(respond: (request: Request) => Promise<Response>) {
  vi.resetModules();
  const NativeRequest = Request;
  vi.stubGlobal("Request", class extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) { super(typeof input === "string" ? new URL(input, "https://ui.example") : input, init); }
  });
  vi.stubGlobal("fetch", (request: Request) => request.url.endsWith("/auth/csrf") ? Promise.resolve(Response.json({ csrfToken: "csrf" })) : respond(request));
  return import("./WorkspacePlugins");
}

describe("workspace plugin form and transport", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("never initializes a secret with a schema default or a saved secret", async () => {
    const { workspacePluginConfig } = await load(async () => Response.json(saved));
    expect(workspacePluginConfig(schema, undefined)).toEqual({ minute: 10, redis: {} });
    expect(workspacePluginConfig(schema, body.config)).toEqual({ minute: 10, redis: { password: "REDACTED" } });
  });
  it.each([null, saved])("sends only v2, waits for success, (%s)", async (current) => {
    const sent: Request[] = [];
    let resolve!: (r: Response) => void;
    const { saveWorkspacePlugin } = await load(request => { sent.push(request); return new Promise(r => { resolve = r; }); });
    let done = false;
    const pending = saveWorkspacePlugin(W, current, body).then(result => { done = true; return result; });
    await new Promise(r => setTimeout(r, 0));
    expect(done).toBe(false);
    expect(sent.map(r => [r.method, new URL(r.url).pathname])).toEqual([[current ? "PUT" : "POST", `/api/v2/workspaces/${W}/plugins${current ? `/${W}` : ""}`]]);
    expect(await sent[0]!.json()).toEqual(body);
    resolve(Response.json(saved, { status: current ? 200 : 201 }));
    expect(await pending).toEqual(saved);
  });
  it.each([403, 409, 422])("propagates server %s and places schema errors without accepting a failed save", async status => {
    const problem = { title: "Rejected", status, ...(status === 409 ? { code: "auto-publish" } : {}), errors: [{ path: "config.redis.password", message: "is required" }] };
    const { saveWorkspacePlugin, workspacePluginErrors } = await load(async () => Response.json(problem, { status }));
    let error: unknown;
    try { await saveWorkspacePlugin(W, null, body); } catch (e) { error = e; }
    expect(error).toMatchObject({ status });
    const errors = workspacePluginErrors(error, schema);
    if (status === 403) expect(errors.form.join()).toContain("permissão");
    if (status === 409) expect(errors.form.join()).toContain("publicação manual");
    if (status === 422) expect(errors.fields["config.redis.password"]).toBeDefined();
  });
});
