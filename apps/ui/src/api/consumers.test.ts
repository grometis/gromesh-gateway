import { afterEach, describe, expect, it, vi } from "vitest";
import type { components } from "./schema-v2";

async function setup(status = 200) {
  vi.resetModules();
  const NativeRequest = Request;
  vi.stubGlobal("Request", class extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) { super(typeof input === "string" ? new URL(input, "https://ui.example") : input, init); }
  });
  const sent: Request[] = [];
  const problem: components["schemas"]["Problem"] & { code?: string } = {
    type: "about:blank", title: "never-render-secret", status,
    code: status === 409 ? "auto-publish" : undefined,
    detail: "never-render-secret", errors: [{ path: "password", message: "never-render-secret" }],
  };
  vi.stubGlobal("fetch", async (request: Request) => {
    if (request.url.endsWith("/auth/csrf")) return Response.json({ csrfToken: "csrf" });
    sent.push(request);
    return request.method === "DELETE" && status === 200 ? new Response(null, { status: 204 }) : Response.json(status === 200 ? { items: [], nextCursor: null } : problem, { status });
  });
  return { ...(await import("./consumers")), sent };
}

afterEach(() => vi.unstubAllGlobals());
describe("consumer namespace transport", () => {
  it.each([false, true])("uses the selected namespace for every consumer operation (v2=%s)", async v2 => {
    const { consumerApi, sent } = await setup();
    const api = consumerApi(v2, "A");
    await api.list("checkout", "next");
    await api.get("C");
    await api.save(null, { username: "checkout", customId: null, tags: [] });
    await api.save("C", { username: "renamed", tags: [] });
    await api.remove("C");
    await api.listKeys("C"); await api.createKey("C"); await api.rotateKey("C", "K"); await api.removeKey("C", "K");
    await api.listJwt("C"); await api.createJwt("C", { algorithm: "HS256" }); await api.rotateJwt("C", "J"); await api.removeJwt("C", "J");
    await api.listBasic("C"); await api.createBasic("C", { username: "app", password: "typed-password" }); await api.removeBasic("C", "B");
    await api.getGroups("C"); await api.replaceGroups("C", ["staff"]);
    const prefix = v2 ? "/api/v2/workspaces/A/consumers" : "/api/v1/environments/A/consumers";
    expect(sent.map(r => [r.method, new URL(r.url).pathname.slice(prefix.length)])).toEqual([
      ["GET", ""], ["GET", "/C"], ["POST", ""], ["PUT", "/C"], ["DELETE", "/C"],
      ["GET", "/C/key-auth"], ["POST", "/C/key-auth"], ["POST", "/C/key-auth/K/rotate"], ["DELETE", "/C/key-auth/K"],
      ["GET", "/C/jwt"], ["POST", "/C/jwt"], ["POST", "/C/jwt/J/rotate"], ["DELETE", "/C/jwt/J"],
      ["GET", "/C/basic-auth"], ["POST", "/C/basic-auth"], ["DELETE", "/C/basic-auth/B"], ["GET", "/C/acl-groups"], ["PUT", "/C/acl-groups"],
    ]);
    expect(sent.every(r => new URL(r.url).pathname.startsWith(prefix))).toBe(true);
    expect(new URL(sent[0]!.url).searchParams.get("q")).toBe("checkout");
    expect(new URL(sent[0]!.url).searchParams.get("cursor")).toBe("next");
    expect(await sent.at(-1)!.json()).toEqual({ groups: ["staff"] });
    expect(sent.every(r => !r.url.includes("typed-password"))).toBe(true);
  });
  it.each([401, 403, 404, 409, 422])("preserves status %s and sanitizes v2 problem text", async status => {
    const { consumerApi } = await setup(status);
    await expect(consumerApi(true, "A").createBasic("C", { username: "app", password: "typed-password" })).rejects.toMatchObject({ status });
    const error: unknown = await consumerApi(true, "A").createKey("C").catch((error: unknown) => error);
    expect(JSON.stringify(error)).not.toContain("never-render-secret");
    if (status === 409) expect(error).toMatchObject({ problem: { detail: "Este Workspace publica automaticamente pelo fluxo legado. Mude para publicação manual antes de editar por aqui.", errors: [] } });
    if (status === 422) expect(error).toMatchObject({ problem: { detail: "Confira os campos informados.", errors: [{ path: "password", message: "Valor inválido. Confira este campo." }] } });
  });
});
