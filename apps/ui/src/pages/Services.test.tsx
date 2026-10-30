import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceService, WorkspaceServiceWrite } from "../api/client-v2";

const W = "6d3e8b20-4c5e-4d6f-9a70-00000000000a";
const NOW = "2026-10-30T12:00:00Z";
const body: WorkspaceServiceWrite = { name: "cobranca", protocol: "http", host: "cobranca.upstream", port: 80, upstreamId: "6d3e8b20-4c5e-4d6f-9a70-0000000000b1", enabled: true, tags: [] };
const saved: WorkspaceService = { ...body, id: "6d3e8b20-4c5e-4d6f-9a70-0000000000c1", workspaceId: W, createdAt: NOW, updatedAt: NOW };

async function load(respond: (request: Request) => Promise<Response>) {
  vi.resetModules();
  const NativeRequest = Request;
  vi.stubGlobal("Request", class extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(typeof input === "string" ? new URL(input, "https://ui.example") : input, init);
    }
  });
  vi.stubGlobal("fetch", (request: Request) => request.url.endsWith("/api/v1/auth/csrf")
    ? Promise.resolve(Response.json({ csrfToken: "csrf" }))
    : respond(request));
  const [services, errors] = await Promise.all([import("./Services"), import("./gateway-errors")]);
  return { ...services, ...errors };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("saving a workspace service", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([["creates", null], ["replaces", saved]] as const)("%s it and reports success only after the server answers", async (_, current) => {
    let resolve!: (r: Response) => void;
    const sent: Request[] = [];
    const { saveServiceMutation } = await load((request) => {
      sent.push(request);
      return new Promise((r) => (resolve = r));
    });
    const invalidate = vi.fn();
    const onSaved = vi.fn();
    const client = new QueryClient();
    const done = new MutationObserver(client, saveServiceMutation(W, current, invalidate, onSaved)).mutate(body);
    await tick();
    expect(sent.map((r) => [r.method, new URL(r.url).pathname])).toEqual([
      current ? ["PUT", `/api/v2/workspaces/${W}/services/${saved.id}`] : ["POST", `/api/v2/workspaces/${W}/services`],
    ]);
    expect(await sent[0]!.json()).toEqual(body);
    expect(onSaved).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
    resolve(Response.json(saved, { status: current ? 200 : 201 }));
    await done;
    expect(invalidate).toHaveBeenCalledOnce();
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(saved);
  });

  it("never reports success on a 409 auto-publish, and says what to do", async () => {
    const { saveServiceMutation, gatewayFormErrors, GATEWAY_MESSAGES } = await load(() => Promise.resolve(Response.json(
      { type: "https://gromesh.dev/problems/auto-publish", title: "Conflict", status: 409, code: "auto-publish", detail: "auto" },
      { status: 409, headers: { "Content-Type": "application/problem+json" } },
    )));
    const onSaved = vi.fn();
    const invalidate = vi.fn();
    const observer = new MutationObserver(new QueryClient(), saveServiceMutation(W, null, invalidate, onSaved));
    await expect(observer.mutate(body)).rejects.toMatchObject({ status: 409 });
    expect(onSaved).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
    expect(gatewayFormErrors(observer.getCurrentResult().error, "service").form).toEqual([GATEWAY_MESSAGES.autoPublish]);
  });
});
