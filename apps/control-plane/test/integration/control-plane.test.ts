import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, uniq, type Harness } from "./harness.js";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h?.close();
});

async function newEnv() {
  const res = await h.api("POST", "/environments", { name: uniq("env") });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function newService(envId: string, overrides: Record<string, unknown> = {}) {
  const res = await h.api("POST", `/environments/${envId}/services`, {
    name: uniq("svc"),
    protocol: "http",
    host: "echo",
    port: 80,
    ...overrides,
  });
  expect(res.status).toBe(201);
  return res.body;
}

async function newRoute(envId: string, serviceId: string, overrides: Record<string, unknown> = {}) {
  const res = await h.api("POST", `/environments/${envId}/routes`, {
    name: uniq("route"),
    serviceId,
    paths: ["/echo"],
    ...overrides,
  });
  expect(res.status).toBe(201);
  return res.body;
}

describe("environments", () => {
  it("creates with contract defaults and rejects duplicates", async () => {
    const name = uniq("env");
    const created = await h.api("POST", "/environments", { name });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name, publishMode: "manual", currentVersion: null, hasUnpublishedChanges: false });

    const dup = await h.api("POST", "/environments", { name });
    expect(dup.status).toBe(409);
    expect(dup.contentType).toContain("application/problem+json");
  });

  it("validates bodies against the contract and reports field paths", async () => {
    const res = await h.api("POST", "/environments", { name: "has spaces", publishMode: "sometimes" });
    expect(res.status).toBe(422);
    const paths = res.body.errors.map((e: { path: string }) => e.path);
    expect(paths).toEqual(expect.arrayContaining(["name", "publishMode"]));
  });

  it("answers 404 for unknown or malformed ids", async () => {
    expect((await h.api("GET", "/environments/00000000-0000-4000-8000-00000000dead")).status).toBe(404);
    expect((await h.api("GET", "/environments/not-a-uuid")).status).toBe(404);
  });
});

describe("services and routes", () => {
  it("rejects invalid services with field errors", async () => {
    const envId = await newEnv();
    const res = await h.api("POST", `/environments/${envId}/services`, { name: "bad", protocol: "ftp", host: "x", port: 70000 });
    expect(res.status).toBe(422);
    const paths = res.body.errors.map((e: { path: string }) => e.path);
    expect(paths).toEqual(expect.arrayContaining(["protocol", "port"]));
  });

  it("requires a matcher and a service from the same environment", async () => {
    const envA = await newEnv();
    const envB = await newEnv();
    const svcB = await newService(envB);
    const res = await h.api("POST", `/environments/${envA}/routes`, { name: "r", serviceId: svcB.id });
    expect(res.status).toBe(422);
    const paths = res.body.errors.map((e: { path: string }) => e.path);
    expect(paths).toEqual(expect.arrayContaining(["(body)", "serviceId"]));
  });

  it("refuses to delete a service that still has routes", async () => {
    const envId = await newEnv();
    const svc = await newService(envId);
    const route = await newRoute(envId, svc.id);
    expect((await h.api("DELETE", `/environments/${envId}/services/${svc.id}`)).status).toBe(409);
    expect((await h.api("DELETE", `/environments/${envId}/routes/${route.id}`)).status).toBe(204);
    expect((await h.api("DELETE", `/environments/${envId}/services/${svc.id}`)).status).toBe(204);
  });

  it("paginates by name with an opaque cursor and filters by q", async () => {
    const envId = await newEnv();
    for (const n of ["alpha", "bravo", "charlie"]) await newService(envId, { name: n });
    const p1 = await h.api("GET", `/environments/${envId}/services?limit=2`);
    expect(p1.body.items.map((s: { name: string }) => s.name)).toEqual(["alpha", "bravo"]);
    expect(p1.body.nextCursor).toBeTypeOf("string");
    const p2 = await h.api("GET", `/environments/${envId}/services?limit=2&cursor=${p1.body.nextCursor}`);
    expect(p2.body.items.map((s: { name: string }) => s.name)).toEqual(["charlie"]);
    expect(p2.body.nextCursor).toBeNull();
    const q = await h.api("GET", `/environments/${envId}/services?q=RAV`);
    expect(q.body.items.map((s: { name: string }) => s.name)).toEqual(["bravo"]);
  });

  it("applies contract defaults to routes", async () => {
    const envId = await newEnv();
    const svc = await newService(envId);
    const route = await newRoute(envId, svc.id, { methods: ["get"] });
    expect(route).toMatchObject({ protocols: ["http", "https"], stripPath: true, preserveHost: false, methods: ["GET"] });
  });
});

describe("publish", () => {
  it("compiles the draft, versions it and pushes it to Kong", async () => {
    const envId = await newEnv();
    const svc = await newService(envId);
    const route = await newRoute(envId, svc.id);
    expect((await h.api("GET", `/environments/${envId}`)).body.hasUnpublishedChanges).toBe(true);

    const pushedBefore = h.kong.configs.length;
    const v1 = await h.api("POST", `/environments/${envId}/snapshots`, { message: "first" });
    expect(v1.status).toBe(201);
    expect(v1.body).toMatchObject({ version: 1, isCurrent: true, changeCount: 2, message: "first", createdBy: { name: "Dev Admin" } });
    expect(v1.body.hash).toMatch(/^sha256:[0-9a-f]{64}$/);

    const pushed = h.kong.configs.at(-1) as any;
    expect(h.kong.configs.length).toBe(pushedBefore + 1);
    expect(pushed._format_version).toBe("3.0");
    expect(pushed.routes[0]).toMatchObject({ id: route.id, service: svc.id, paths: ["/echo"] });

    const env = (await h.api("GET", `/environments/${envId}`)).body;
    expect(env).toMatchObject({ currentVersion: 1, hasUnpublishedChanges: false });

    const again = await h.api("POST", `/environments/${envId}/snapshots`, {});
    expect(again.status).toBe(409);

    await h.api("PUT", `/environments/${envId}/routes/${route.id}`, { name: route.name, serviceId: svc.id, paths: ["/echo", "/v2/echo"] });
    const stale = await h.api("POST", `/environments/${envId}/snapshots`, { expectedCurrentVersion: 0 });
    expect(stale.status).toBe(409);
    const v2 = await h.api("POST", `/environments/${envId}/snapshots`, { expectedCurrentVersion: 1 });
    expect(v2.status).toBe(201);
    expect(v2.body).toMatchObject({ version: 2, changeCount: 1 });
  });

  it("keeps the version when Kong rejects it and reports 502", async () => {
    const envId = await newEnv();
    const svc = await newService(envId);
    await newRoute(envId, svc.id);
    h.kong.status = 400;
    try {
      const res = await h.api("POST", `/environments/${envId}/snapshots`, {});
      expect(res.status).toBe(502);
      expect(res.body.detail).toContain("Published version 1");
    } finally {
      h.kong.status = 201;
    }
    expect((await h.api("GET", `/environments/${envId}`)).body.currentVersion).toBe(1);
  });

  it("writes an audit event for every mutation and the publish", async () => {
    const envId = await newEnv();
    const svc = await newService(envId);
    await newRoute(envId, svc.id);
    await h.api("POST", `/environments/${envId}/snapshots`, {});
    const { rows } = await h.sql.query<{ action: string; actor: { name: string } }>(
      "select action, actor from audit_events where environment_id = $1 order by at",
      [envId],
    );
    expect(rows.map((r) => r.action)).toEqual(["environment.create", "service.create", "route.create", "snapshot.publish"]);
    expect(rows.every((r) => r.actor.name === "Dev Admin")).toBe(true);
  });

  it("publishes an empty draft as a valid, empty Kong config", async () => {
    const envId = await newEnv();
    const res = await h.api("POST", `/environments/${envId}/snapshots`, {});
    expect(res.status).toBe(201);
    expect(res.body.changeCount).toBe(0);
  });
});
