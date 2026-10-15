import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AutoPublisher, maskConfigFor, SnapshotsService } from "../../src/snapshots/snapshots.js";
import { startHarness, uniq, type Harness } from "./harness.js";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h?.close();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function newEnv(api: Harness["api"] = h.api, body: Record<string, unknown> = {}) {
  const res = await api("POST", "/environments", { name: uniq("env"), ...body });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function newService(envId: string, overrides: Record<string, unknown> = {}, api: Harness["api"] = h.api) {
  const res = await api("POST", `/environments/${envId}/services`, { name: uniq("svc"), protocol: "http", host: "echo", port: 80, ...overrides });
  expect(res.status).toBe(201);
  return res.body;
}

async function newRoute(envId: string, serviceId: string, overrides: Record<string, unknown> = {}, api: Harness["api"] = h.api) {
  const res = await api("POST", `/environments/${envId}/routes`, { name: uniq("route"), serviceId, paths: ["/echo"], ...overrides });
  expect(res.status).toBe(201);
  return res.body;
}

async function publish(envId: string, body: Record<string, unknown> = {}) {
  const res = await h.api("POST", `/environments/${envId}/snapshots`, body);
  expect(res.status).toBe(201);
  return res.body;
}

/** v1: svc + route A; v2: route A replaced by route B. */
async function twoVersions() {
  const envId = await newEnv();
  const svc = await newService(envId);
  const routeA = await newRoute(envId, svc.id, { paths: ["/a"] });
  const v1 = await publish(envId, { message: "v1" });
  expect((await h.api("DELETE", `/environments/${envId}/routes/${routeA.id}`)).status).toBe(204);
  const routeB = await newRoute(envId, svc.id, { paths: ["/b"] });
  const v2 = await publish(envId, { message: "v2" });
  return { envId, svc, routeA, routeB, v1, v2 };
}

describe("publish-preview", () => {
  it("diffs the compiled draft against the current version", async () => {
    const envId = await newEnv();
    const empty = await h.api("GET", `/environments/${envId}/publish-preview`);
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ currentVersion: null, hasChanges: true, changes: [] });

    const svc = await newService(envId);
    const route = await newRoute(envId, svc.id);
    const draft = (await h.api("GET", `/environments/${envId}/publish-preview`)).body;
    expect(draft.hasChanges).toBe(true);
    expect(draft.draftHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(draft.changes.map((c: { kind: string; id: string; change: string }) => [c.kind, c.id, c.change])).toEqual([
      ["services", svc.id, "added"],
      ["routes", route.id, "added"],
    ]);

    const v1 = await publish(envId);
    expect(v1.hash).toBe(draft.draftHash);
    const clean = (await h.api("GET", `/environments/${envId}/publish-preview`)).body;
    expect(clean).toEqual({ currentVersion: 1, draftHash: v1.hash, hasChanges: false, changes: [] });

    await h.api("PUT", `/environments/${envId}/services/${svc.id}`, { name: svc.name, protocol: "http", host: "echo", port: 8080 });
    const modified = (await h.api("GET", `/environments/${envId}/publish-preview`)).body;
    expect(modified.changes).toEqual([expect.objectContaining({ kind: "services", id: svc.id, change: "modified", label: svc.name })]);
  });

  it("does not write anything", async () => {
    const envId = await newEnv();
    await newService(envId);
    await h.api("GET", `/environments/${envId}/publish-preview`);
    const { rows } = await h.sql.query("select 1 from snapshots where environment_id = $1", [envId]);
    expect(rows).toHaveLength(0);
    expect((await h.api("GET", `/environments/${envId}`)).body.currentVersion).toBeNull();
  });

  it("returns compile issues as 422 with paths", async () => {
    const envId = await newEnv();
    await newService(envId, { protocol: "tcp", path: "/not-for-tcp" });
    const res = await h.api("GET", `/environments/${envId}/publish-preview`);
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual([expect.objectContaining({ path: "services[0].path" })]);
  });

  it("answers 404 for an unknown environment", async () => {
    expect((await h.api("GET", `/environments/${crypto.randomUUID()}/publish-preview`)).status).toBe(404);
  });
});

describe("publish", () => {
  it("keeps versions monotonic and records message and author", async () => {
    const { envId, v1, v2 } = await twoVersions();
    expect([v1.version, v2.version]).toEqual([1, 2]);
    expect(v2).toMatchObject({ message: "v2", createdBy: { name: "Dev Admin" }, rollbackOf: null, isCurrent: true });
    const nothing = await h.api("POST", `/environments/${envId}/snapshots`, {});
    expect(nothing.status).toBe(409);
    expect(nothing.body.detail).toMatch(/nothing to publish/i);
  });

  it("treats expectedCurrentVersion null as 'nothing published yet'", async () => {
    const envId = await newEnv();
    await newService(envId);
    expect((await h.api("POST", `/environments/${envId}/snapshots`, { expectedCurrentVersion: 1 })).status).toBe(409);
    expect((await h.api("POST", `/environments/${envId}/snapshots`, { expectedCurrentVersion: null })).status).toBe(201);
    expect((await h.api("POST", `/environments/${envId}/snapshots`, { expectedCurrentVersion: null })).status).toBe(409);
  });
});

describe("snapshots read API", () => {
  it("lists newest first with cursor pagination", async () => {
    const { envId } = await twoVersions();
    await newService(envId);
    await publish(envId);

    const first = await h.api("GET", `/environments/${envId}/snapshots?limit=2`);
    expect(first.status).toBe(200);
    expect(first.body.items.map((s: { version: number; isCurrent: boolean }) => [s.version, s.isCurrent])).toEqual([
      [3, true],
      [2, false],
    ]);
    expect(first.body.nextCursor).toEqual(expect.any(String));

    const second = await h.api("GET", `/environments/${envId}/snapshots?limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.items.map((s: { version: number }) => s.version)).toEqual([1]);
    expect(second.body.nextCursor).toBeNull();

    expect((await h.api("GET", `/environments/${envId}/snapshots?cursor=garbage`)).status).toBe(422);
  });

  it("returns the full envelope of one version", async () => {
    const { envId, v1, routeA } = await twoVersions();
    const res = await h.api("GET", `/environments/${envId}/snapshots/1`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["config", "createdAt", "environmentId", "hash", "version"]);
    expect(res.body).toMatchObject({ version: 1, hash: v1.hash, environmentId: envId });
    expect(res.body.config.routes.map((r: { id: string }) => r.id)).toEqual([routeA.id]);

    expect((await h.api("GET", `/environments/${envId}/snapshots/99`)).status).toBe(404);
    expect((await h.api("GET", `/environments/${envId}/snapshots/abc`)).status).toBe(404);
  });

  it("diffs a version against the previous one or a chosen one", async () => {
    const { envId, svc, routeA, routeB } = await twoVersions();

    const prev = await h.api("GET", `/environments/${envId}/snapshots/2/diff`);
    expect(prev.status).toBe(200);
    expect(prev.body.items.map((c: { id: string; change: string }) => [c.id, c.change])).toEqual([
      [routeB.id, "added"],
      [routeA.id, "removed"],
    ]);

    const reverse = await h.api("GET", `/environments/${envId}/snapshots/1/diff?against=2`);
    expect(reverse.body.items.map((c: { id: string; change: string }) => [c.id, c.change])).toEqual([
      [routeA.id, "added"],
      [routeB.id, "removed"],
    ]);

    const fromNothing = await h.api("GET", `/environments/${envId}/snapshots/1/diff`);
    expect(fromNothing.body.items.map((c: { id: string; change: string }) => [c.id, c.change])).toEqual([
      [svc.id, "added"],
      [routeA.id, "added"],
    ]);

    expect((await h.api("GET", `/environments/${envId}/snapshots/2/diff?against=7`)).status).toBe(404);
    expect((await h.api("GET", `/environments/${envId}/snapshots/2/diff?against=x`)).status).toBe(422);
  });
});

describe("credential masking", () => {
  // The dev user is admin, so the non-admin view is checked on the mapper itself.
  const config = {
    _format_version: "3.0" as const,
    _transform: true as const,
    services: [],
    routes: [],
    consumers: [],
    keyauth_credentials: [{ id: crypto.randomUUID(), consumer: crypto.randomUUID(), key: "s3cr3t", tags: [] }],
    plugins: [{ id: crypto.randomUUID(), name: "session", enabled: true, config: { secret: "p4ss", cookie_name: "s" }, tags: [] }],
  };
  const redact = (_name: string, c: Record<string, unknown>) => ({ ...c, secret: "REDACTED" });

  it("hides key-auth keys from non-admins only", () => {
    expect(maskConfigFor("admin", config).keyauth_credentials[0]!.key).toBe("s3cr3t");
    expect(maskConfigFor("editor", config).keyauth_credentials[0]!.key).toBe("REDACTED");
    expect(maskConfigFor("viewer", config).keyauth_credentials[0]!.key).toBe("REDACTED");
    expect(config.keyauth_credentials[0]!.key).toBe("s3cr3t");
  });

  it("hides plugin secrets from non-admins only", () => {
    expect(maskConfigFor("admin", config, redact).plugins[0]!.config).toEqual({ secret: "p4ss", cookie_name: "s" });
    expect(maskConfigFor("viewer", config, redact).plugins[0]!.config).toEqual({ secret: "REDACTED", cookie_name: "s" });
  });
});

describe("rollback", () => {
  it("restores the draft to the version and publishes it as a new version", async () => {
    const { envId, svc, routeA, routeB, v1 } = await twoVersions();
    // An unpublished edit is discarded by the rollback.
    await newService(envId);

    const res = await h.api("POST", `/environments/${envId}/snapshots/1/rollback`);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ version: 3, rollbackOf: 1, hash: v1.hash, isCurrent: true, changeCount: 2 });

    const routes = (await h.api("GET", `/environments/${envId}/routes`)).body.items;
    expect(routes.map((r: { id: string; paths: string[] }) => [r.id, r.paths])).toEqual([[routeA.id, ["/a"]]]);
    expect((await h.api("GET", `/environments/${envId}/routes/${routeB.id}`)).status).toBe(404);
    const services = (await h.api("GET", `/environments/${envId}/services`)).body.items;
    expect(services.map((s: { id: string }) => s.id)).toEqual([svc.id]);
    expect((await h.api("GET", `/environments/${envId}`)).body).toMatchObject({ currentVersion: 3, hasUnpublishedChanges: false });

    const { rows } = await h.sql.query<{ action: string; after: Record<string, unknown> }>(
      "select action, after from audit_events where environment_id = $1 and action like 'snapshot.%' order by at",
      [envId],
    );
    expect(rows.map((r) => r.action)).toEqual(["snapshot.publish", "snapshot.publish", "snapshot.rollback"]);
    expect(rows.at(-1)!.after).toMatchObject({ version: 3, rollbackOf: 1, hash: v1.hash });
  });

  it("refuses a rollback that would not change the published config", async () => {
    const { envId } = await twoVersions();
    const res = await h.api("POST", `/environments/${envId}/snapshots/2/rollback`);
    expect(res.status).toBe(409);
    expect((await h.api("GET", `/environments/${envId}`)).body.currentVersion).toBe(2);
  });

  it("answers 404 for an unknown version", async () => {
    const { envId } = await twoVersions();
    expect((await h.api("POST", `/environments/${envId}/snapshots/42/rollback`)).status).toBe(404);
  });
});

describe("auto publish", () => {
  // Two replicas on the same database, polling fast so the debounce delay dominates the timing.
  let a: Harness;
  let b: Harness;
  beforeAll(async () => {
    [a, b] = await Promise.all([startHarness({ autoPublishPollMs: 100 }), startHarness({ autoPublishPollMs: 100 })]);
  });
  afterAll(async () => {
    await Promise.all([a?.close(), b?.close()]);
  });

  async function versions(envId: string): Promise<number[]> {
    const { rows } = await h.sql.query<{ version: number }>("select version from snapshots where environment_id = $1 order by version", [envId]);
    return rows.map((r) => r.version);
  }

  async function waitForVersion(envId: string, version: number, timeoutMs: number): Promise<number> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if ((await versions(envId)).includes(version)) return Date.now();
      await sleep(50);
    }
    throw new Error(`version ${version} not published within ${timeoutMs} ms`);
  }

  it("publishes once, 3 s after the last edit, across replicas", { timeout: 20_000 }, async () => {
    const envId = await newEnv(a.api, { publishMode: "auto" });
    const svc = await newService(envId, {}, a.api);
    await sleep(1_500);
    // A second edit on the other replica restarts the debounce window.
    await newRoute(envId, svc.id, {}, b.api);
    const lastEdit = Date.now();

    await sleep(2_000);
    expect(await versions(envId)).toEqual([]);

    const publishedAt = await waitForVersion(envId, 1, 5_000);
    expect(publishedAt - lastEdit).toBeGreaterThanOrEqual(2_900);
    await sleep(500);
    expect(await versions(envId)).toEqual([1]);

    const snap = (await a.api("GET", `/environments/${envId}/snapshots`)).body.items[0];
    expect(snap).toMatchObject({ version: 1, createdBy: { name: "auto-publish" }, rollbackOf: null });
    expect((await a.api("GET", `/environments/${envId}`)).body).toMatchObject({ currentVersion: 1, hasUnpublishedChanges: false });
  });

  it("waits while another replica holds the environment lock", { timeout: 20_000 }, async () => {
    const envId = await newEnv(a.api, { publishMode: "auto" });
    await newService(envId, {}, a.api);

    const blocker = await h.sql.connect();
    try {
      await blocker.query("begin");
      await blocker.query("select 1 from environments where id = $1 for update", [envId]);
      await sleep(4_000);
      expect(await versions(envId)).toEqual([]);
      await blocker.query("commit");
    } finally {
      blocker.release();
    }
    await waitForVersion(envId, 1, 3_000);
  });

  it("only clears the flag when the edits cancel out", { timeout: 20_000 }, async () => {
    const envId = await newEnv(a.api, { publishMode: "auto" });
    const svc = await newService(envId, {}, a.api);
    await waitForVersion(envId, 1, 6_000);

    await a.api("PUT", `/environments/${envId}/services/${svc.id}`, { name: svc.name, protocol: "http", host: "echo", port: 81 });
    await a.api("PUT", `/environments/${envId}/services/${svc.id}`, { name: svc.name, protocol: "http", host: "echo", port: 80 });
    expect((await a.api("GET", `/environments/${envId}`)).body.hasUnpublishedChanges).toBe(true);
    await sleep(4_000);
    expect(await versions(envId)).toEqual([1]);
    expect((await a.api("GET", `/environments/${envId}`)).body.hasUnpublishedChanges).toBe(false);
  });

  it("leaves manual environments alone", { timeout: 20_000 }, async () => {
    const envId = await newEnv(a.api);
    await newService(envId, {}, a.api);
    await sleep(4_000);
    expect(await versions(envId)).toEqual([]);
  });
});

describe("auto publish failures", () => {
  // One replica with the poller off and no debounce, so the test drives each tick.
  let r: Harness;
  let service: SnapshotsService;
  let publisher: AutoPublisher;
  beforeAll(async () => {
    r = await startHarness({ autoPublishPollMs: 0, autoPublishDelayMs: 0 });
    service = r.app.get(SnapshotsService);
    publisher = r.app.get(AutoPublisher);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await r?.close();
  });

  const currentVersion = async (envId: string) => (await r.api("GET", `/environments/${envId}`)).body.currentVersion as number | null;

  it("parks a draft that does not compile until the next edit", async () => {
    const envId = await newEnv(r.api, { publishMode: "auto" });
    const svc = await newService(envId, { protocol: "tcp", path: "/not-for-tcp" }, r.api);
    const spy = vi.spyOn(service, "autoPublish");
    await expect(service.autoPublish(envId, 0)).resolves.toBe(false);

    spy.mockClear();
    await publisher.tick();
    await publisher.tick();
    expect(spy.mock.calls.filter(([id]) => id === envId)).toHaveLength(1);

    await r.api("PUT", `/environments/${envId}/services/${svc.id}`, { name: svc.name, protocol: "http", host: "echo", port: 80 });
    await publisher.tick();
    expect(await currentVersion(envId)).toBe(1);
    spy.mockRestore();
  });

  it("rethrows other failures and retries them on the next tick", async () => {
    const envId = await newEnv(r.api, { publishMode: "auto" });
    await newService(envId, {}, r.api);
    const transient = new Error("Connection terminated unexpectedly");
    // prepare is private; the spy stands in for a database hiccup while compiling the draft.
    const prepare = vi.spyOn(service as unknown as { prepare: () => Promise<unknown> }, "prepare");

    prepare.mockRejectedValueOnce(transient);
    await expect(service.autoPublish(envId, 0)).rejects.toBe(transient);

    prepare.mockRejectedValueOnce(transient);
    await publisher.tick();
    expect(await currentVersion(envId)).toBeNull();

    await publisher.tick();
    expect(await currentVersion(envId)).toBe(1);
    prepare.mockRestore();
  });
});
