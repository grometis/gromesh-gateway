import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceRoute } from "../api/client-v2";
import { publicPath, upstreamEffect } from "./workspace-gateway";

const W = "6d3e8b20-4c5e-4d6f-9a70-00000000000a";
const NOW = "2026-10-30T12:00:00Z";
const route = (extra: Partial<WorkspaceRoute> = {}): WorkspaceRoute => ({
  id: "6d3e8b20-4c5e-4d6f-9a70-0000000000d1", name: "recarga", serviceId: "6d3e8b20-4c5e-4d6f-9a70-0000000000c1", paths: ["/recarga"],
  protocols: ["http", "https"], stripPath: true, preserveHost: false, headers: { "x-canal": ["app"] }, analyticsRetentionDays: 3, pathCompatibility: "workspace-default",
  createdAt: NOW, updatedAt: NOW, ...extra,
});
const values = { name: "recarga", serviceId: "6d3e8b20-4c5e-4d6f-9a70-0000000000c1", paths: ["/recarga"], hosts: [], methods: ["GET"], protocols: ["https" as const], stripPath: false, preserveHost: false, tags: [] };

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
  return import("./Routes");
}

describe("public paths", () => {
  it("prefixes every path with the workspace slug; a regex stays a regex", () => {
    expect(publicPath("tvro", "/recarga")).toBe("/tvro/recarga");
    expect(publicPath("tvro", "/")).toBe("/tvro/");
    expect(publicPath("tvro", "~/v[0-9]+/pix")).toBe("~/tvro(?:/v[0-9]+/pix)");
  });

  it("says what the upstream receives with and without stripPath", () => {
    expect(upstreamEffect("tvro", "/recarga", false)).toBe("Uma requisição a /tvro/recarga/x chega ao upstream como /tvro/recarga/x.");
    expect(upstreamEffect("tvro", "/recarga", true)).toBe("Uma requisição a /tvro/recarga/x chega ao upstream como /x.");
    expect(upstreamEffect("tvro", "/", false)).toBe("Uma requisição a /tvro/x chega ao upstream como /tvro/x.");
  });
});

describe("saving a workspace route", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the user's stripPath on a workspace-default route and keeps what the form does not edit", async () => {
    const { routeBody } = await load(() => new Promise(() => {}));
    expect(routeBody(null, values)).toEqual(values);
    expect(routeBody(route(), values)).toEqual({ ...values, headers: { "x-canal": ["app"] }, analyticsRetentionDays: 3 });
    expect(routeBody(route(), values).stripPath).toBe(false);
  });

  it("never sends stripPath for a legacy-preserved route, so saving never converts it", async () => {
    const { routeBody } = await load(() => new Promise(() => {}));
    const body = routeBody(route({ pathCompatibility: "legacy-preserved", stripPath: true }), { ...values, stripPath: false });
    expect(body).not.toHaveProperty("stripPath");
    expect(body).not.toHaveProperty("pathCompatibility");
  });

  it("sends only the fields the write schema declares, whatever the response carried", async () => {
    const { routeBody } = await load(() => new Promise(() => {}));
    const stored = { ...route(), workspaceId: W, extra: 1 } as WorkspaceRoute;
    expect(Object.keys(routeBody(stored, values)).sort()).toEqual(
      ["analyticsRetentionDays", "headers", "hosts", "methods", "name", "paths", "preserveHost", "protocols", "serviceId", "stripPath", "tags"],
    );
  });

  it("edits a migrated route without paths through v1, keeping its stripPath (v2 requires paths)", async () => {
    let resolve!: (r: Response) => void;
    const sent: Request[] = [];
    const { saveRouteMutation, routeBody, editedOverV1 } = await load((request) => {
      sent.push(request);
      // The environment is read again at submit: manual here.
      if (request.method === "GET") return Promise.resolve(Response.json({ id: W, name: "Legado", publishMode: "manual", currentVersion: 1, hasUnpublishedChanges: false }));
      return new Promise((r) => (resolve = r));
    });
    const hostOnly = route({ pathCompatibility: "legacy-preserved", paths: [], hosts: ["boletos.example"], stripPath: true });
    expect(editedOverV1(hostOnly)).toBe(true);
    expect(editedOverV1(route({ pathCompatibility: "legacy-preserved" }))).toBe(false);
    expect(editedOverV1(route({ paths: [] }))).toBe(false);
    const body = routeBody(hostOnly, { ...values, name: "boletos-host", paths: [], hosts: ["boletos.example"], stripPath: false });
    expect(body).toMatchObject({ name: "boletos-host", paths: [], stripPath: true });
    const onSaved = vi.fn();
    const done = new MutationObserver(new QueryClient(), saveRouteMutation(W, hostOnly, vi.fn(), onSaved)).mutate(body);
    await new Promise((r) => setTimeout(r, 0));
    expect(sent.map((r) => [r.method, new URL(r.url).pathname, r.cache])).toEqual([
      ["GET", `/api/v1/environments/${W}`, "no-store"],
      ["PUT", `/api/v1/environments/${W}/routes/${hostOnly.id}`, "default"],
    ]);
    expect(onSaved).not.toHaveBeenCalled();
    resolve(Response.json({ ...hostOnly, name: "boletos-host" }));
    await done;
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it("writes nothing over v1 when the server says auto, whatever the screen's cache said", async () => {
    const sent: Request[] = [];
    const { saveRouteMutation, AutoPublishV1Error, V1_AUTO_PUBLISH } = await load((request) => {
      sent.push(request);
      return Promise.resolve(Response.json({ id: W, name: "Legado", publishMode: "auto", currentVersion: 1, hasUnpublishedChanges: false }));
    });
    const hostOnly = route({ pathCompatibility: "legacy-preserved", paths: [], hosts: ["boletos.example"] });
    const onSaved = vi.fn();
    const invalidate = vi.fn();
    const observer = new MutationObserver(new QueryClient(), saveRouteMutation(W, hostOnly, invalidate, onSaved));
    const err = await observer.mutate({ ...values, paths: [], hosts: ["boletos.example"] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AutoPublishV1Error);
    expect((err as Error).message).toBe(V1_AUTO_PUBLISH);
    expect(sent.map((r) => r.method)).toEqual(["GET"]);
    expect(onSaved).not.toHaveBeenCalled();
    // The stale environment is refreshed, so the form holds the save from then on.
    expect(invalidate).toHaveBeenCalledOnce();
  });

  it("never saves a pathless legacy route over v1 where v1 publishes automatically (nor before the mode is known)", async () => {
    const { v1SaveBlocked } = await load(() => new Promise(() => {}));
    const hostOnly = route({ pathCompatibility: "legacy-preserved", paths: [], hosts: ["boletos.example"] });
    expect(v1SaveBlocked(hostOnly, "auto")).toBe(true);
    expect(v1SaveBlocked(hostOnly, undefined)).toBe(true);
    expect(v1SaveBlocked(hostOnly, "manual")).toBe(false);
    // Everything else goes through v2, which refuses an auto-publishing workspace itself (409 auto-publish).
    expect(v1SaveBlocked(route({ pathCompatibility: "legacy-preserved" }), "auto")).toBe(false);
    expect(v1SaveBlocked(route(), "auto")).toBe(false);
    expect(v1SaveBlocked(null, "auto")).toBe(false);
  });

  it("reports success only after the 200, and a path-compatibility 409 lands on stripPath", async () => {
    let resolve!: (r: Response) => void;
    const sent: Request[] = [];
    const { saveRouteMutation } = await load((request) => {
      sent.push(request);
      return new Promise((r) => (resolve = r));
    });
    const { gatewayFormErrors, GATEWAY_MESSAGES } = await import("./gateway-errors");
    const onSaved = vi.fn();
    const invalidate = vi.fn();
    const observer = new MutationObserver(new QueryClient(), saveRouteMutation(W, route(), invalidate, onSaved));
    const done = observer.mutate(values);
    await new Promise((r) => setTimeout(r, 0));
    expect(sent.map((r) => [r.method, new URL(r.url).pathname])).toEqual([["PUT", `/api/v2/workspaces/${W}/routes/${route().id}`]]);
    expect(onSaved).not.toHaveBeenCalled();
    resolve(Response.json(
      { type: "https://gromesh.dev/problems/path-compatibility", title: "Conflict", status: 409, code: "path-compatibility", errors: [{ path: "stripPath", message: "differs" }] },
      { status: 409, headers: { "Content-Type": "application/problem+json" } },
    ));
    await expect(done).rejects.toMatchObject({ status: 409 });
    expect(onSaved).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
    expect(gatewayFormErrors(observer.getCurrentResult().error, "route").fields).toEqual({ stripPath: [GATEWAY_MESSAGES.pathCompatibility] });
  });
});
