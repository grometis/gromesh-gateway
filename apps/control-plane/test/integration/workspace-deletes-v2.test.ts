import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ARCHIVE_LOCK_CLASS } from "../../src/environments/environments.js";
import { SnapshotsService } from "../../src/snapshots/snapshots.js";
import { type ApiResponse, startHarness, uniq, type Harness } from "./harness.js";

interface DraftState {
  environment: Record<string, unknown>;
  services: unknown[] | null;
  routes: unknown[] | null;
  plugins: unknown[] | null;
  snapshots: unknown[];
  audits: unknown[];
}

describe("draft-only v2 deletes (WS-R3)", () => {
  let h: Harness;
  beforeAll(async () => { h = await startHarness({ autoPublishPollMs: 0 }); });
  afterAll(async () => h?.close());

  const state = async (ws: string) => (await h.sql.query<DraftState>(`
    select to_jsonb(e) as environment,
      (select jsonb_agg(s order by s.id) from services s where s.environment_id = e.id) as services,
      (select jsonb_agg(r order by r.id) from routes r where r.environment_id = e.id) as routes,
      (select jsonb_agg(p order by p.id) from plugins p where p.environment_id = e.id) as plugins,
      (select jsonb_agg(s order by s.version) from snapshots s where s.environment_id = e.id) as snapshots,
      (select jsonb_agg(a order by a.id) from audit_events a where a.environment_id = e.id) as audits
    from environments e where e.id = $1`, [ws])).rows[0]!;

  const fixture = async (entity: "service" | "route") => {
    const env = await h.api<{ id: string }>("POST", "/environments", { name: uniq("ws-delete") });
    expect(env.status).toBe(201);
    const ws = env.body.id;
    const svc = await h.api<{ id: string }>("POST", `/environments/${ws}/services`, { name: "svc", protocol: "http", host: "delete.example.com", port: 80 });
    expect(svc.status).toBe(201);
    const resource = entity === "service" ? svc : await h.api<{ id: string }>("POST", `/environments/${ws}/routes`, { name: "route", serviceId: svc.body.id, paths: ["/delete"] });
    expect(resource.status).toBe(201);
    expect((await h.api("POST", `/environments/${ws}/snapshots`, {})).status).toBe(201);
    const id = resource.body.id;
    const path = `${entity}s/${id}`;
    return {
      ws, id, before: resource.body,
      remove: (api: "v1" | "v2" = "v2") => h.api<{ code?: string }>("DELETE", api === "v1" ? `/environments/${ws}/${path}` : `/../v2/workspaces/${ws}/${path}`),
    };
  };

  const deletionAudit = async (ws: string, id: string, entity: string, before: unknown) => {
    expect((await h.sql.query(`select action, entity_type, entity_id, before, after from audit_events
      where environment_id = $1 and action like '%.delete'`, [ws])).rows).toEqual([{
      action: `${entity}.delete`, entity_type: entity, entity_id: id, before, after: null,
    }]);
  };

  it.each(["service", "route"] as const)("refuses v2 %s DELETE in auto mode without deleting, auditing or publishing", async (entity) => {
    const f = await fixture(entity);
    await h.sql.query("update environments set publish_mode = 'auto' where id = $1", [f.ws]);
    const before = await state(f.ws);
    const res = await f.remove();
    expect([res.status, res.body?.code], JSON.stringify(res.body)).toEqual([409, "auto-publish"]);
    expect(res.contentType).toContain("application/problem+json");
    expect(await state(f.ws)).toEqual(before);
    // Exercise the real v1 publisher too: the refused delete has queued no draft for it.
    await h.app.get(SnapshotsService).autoPublish(f.ws, 0);
    expect(await state(f.ws)).toEqual(before);
  });

  it.each(["service", "route"] as const)("deletes a v2 %s in manual mode with one audit and only a draft change", async (entity) => {
    const f = await fixture(entity);
    const before = await state(f.ws);
    expect((await f.remove()).status).toBe(204);
    const after = await state(f.ws);
    expect(after[entity === "service" ? "services" : "routes"]).toBeNull();
    expect(after.environment).toMatchObject({ publish_mode: "manual", current_version: 1, has_unpublished_changes: true });
    expect(after.snapshots).toEqual(before.snapshots);
    expect(after.audits).toHaveLength(before.audits.length + 1);
    await deletionAudit(f.ws, f.id, entity, f.before);
    await h.app.get(SnapshotsService).autoPublish(f.ws, 0);
    expect(await state(f.ws)).toEqual(after);
  });

  it.each(["service", "route"] as const)("keeps v1 %s DELETE in auto mode eligible for the v1 publisher", async (entity) => {
    const f = await fixture(entity);
    await h.sql.query("update environments set publish_mode = 'auto' where id = $1", [f.ws]);
    const before = await state(f.ws);
    expect((await f.remove("v1")).status).toBe(204);
    const draft = await state(f.ws);
    expect(draft[entity === "service" ? "services" : "routes"]).toBeNull();
    expect(draft.environment).toMatchObject({ current_version: 1, has_unpublished_changes: true });
    expect(draft.snapshots).toEqual(before.snapshots);
    expect(draft.audits).toHaveLength(before.audits.length + 1);
    await deletionAudit(f.ws, f.id, entity, f.before);
    await h.app.get(SnapshotsService).autoPublish(f.ws, 0);
    const published = await state(f.ws);
    expect(published.environment).toMatchObject({ current_version: 2, has_unpublished_changes: false });
    expect(published.snapshots).toHaveLength(2);
  });

  const waitForLock = async (blocker: number) => {
    const deadline = Date.now() + 5_000;
    do {
      const { rows } = await h.sql.query<{ pid: number; query: string }>(`select pid, query from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock' and $1 = any(pg_blocking_pids(pid))`, [blocker]);
      if (rows.length === 1) return rows[0]!;
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    throw new Error("DELETE did not wait on the environment lock");
  };

  it.each(["service", "route"] as const)("serializes v2 %s DELETE with a switch to auto before any write, archive lock first", async (entity) => {
    const f = await fixture(entity);
    const before = await state(f.ws);
    const holder = await h.sql.connect();
    let pending: Promise<ApiResponse<{ code?: string }>> | undefined;
    try {
      await holder.query("begin");
      await holder.query("update environments set publish_mode = 'auto' where id = $1", [f.ws]);
      const { rows: [backend] } = await holder.query<{ pid: number }>("select pg_backend_pid() as pid");
      pending = f.remove();
      const blocked = await waitForLock(backend!.pid);
      expect(blocked.query).toMatch(/from "environments".*for no key update/);
      expect((await h.sql.query(`select mode from pg_locks
        where pid = $1 and locktype = 'advisory' and classid = $2::oid and granted`, [blocked.pid, ARCHIVE_LOCK_CLASS])).rows).toEqual([{ mode: "ShareLock" }]);
      // Uncommitted DELETEs are invisible to another reader; inspect their locks to prove no write happened yet.
      expect((await h.sql.query(`select relation::regclass::text as name from pg_locks
        where pid = $1 and mode = 'RowExclusiveLock' and relation in
          ('services'::regclass, 'routes'::regclass, 'plugins'::regclass, 'environments'::regclass, 'audit_events'::regclass)`, [blocked.pid])).rows).toEqual([]);
      expect(await state(f.ws)).toEqual(before);
      await holder.query("commit");
      const res = await pending;
      expect([res.status, res.body?.code]).toEqual([409, "auto-publish"]);
    } finally {
      await holder.query("rollback");
      holder.release();
      await pending;
    }
    expect(await state(f.ws)).toEqual({ ...before, environment: { ...before.environment, publish_mode: "auto" } });
  });
});
