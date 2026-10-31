import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ARCHIVE_LOCK_CLASS } from "../../src/environments/environments.js";
import { workspaceTransaction } from "../../src/common/workspace-transaction.js";
import { DB, type Db } from "../../src/db/db.js";
import { pgCode, CONCURRENCY_ABORTS } from "../../src/common/retry.js";
import { SnapshotsService } from "../../src/snapshots/snapshots.js";
import { startHarness, uniq, type Harness } from "./harness.js";

describe("workspace writer serialization (WS-R3 r3)", () => {
  let h: Harness;
  const aborts: string[] = [];
  let expectedAborts: string[] = [];
  let observed: { mockRestore(): void };
  beforeAll(async () => {
    h = await startHarness({ autoPublishPollMs: 0 });
    const db = h.app.get<Db>(DB);
    const transaction = db.transaction.bind(db);
    observed = vi.spyOn(db, "transaction").mockImplementation(((work, config) => transaction(work, config).catch((err: unknown) => {
      const code = pgCode(err);
      if (code && CONCURRENCY_ABORTS.has(code)) aborts.push(code);
      throw err;
    })) as Db["transaction"]);
  });
  beforeEach(() => { aborts.length = 0; expectedAborts = []; });
  afterEach(() => { expect(aborts).toEqual(expectedAborts); });
  afterAll(async () => { observed?.mockRestore(); if (h) await h.close(); });

  it("takes the workspace advisory before any draft write", async () => {
    const env = await h.api("POST", "/environments", { name: uniq("first-lock") });
    expect(env.status).toBe(201);
    const ws = env.body.id as string;
    const holder = await h.sql.connect();
    let pending: ReturnType<Harness["api"]> | undefined;
    try {
      await holder.query("begin");
      // Hold both the old and proposed keys: the assertion distinguishes when the writer takes its lock.
      await holder.query("select pg_advisory_xact_lock($1, hashtext($2::uuid::text)), pg_advisory_xact_lock(hashtextextended($2::uuid::text, $1))", [ARCHIVE_LOCK_CLASS, ws]);
      const { rows: [backend] } = await holder.query<{ pid: number }>("select pg_backend_pid() as pid");
      pending = h.api("POST", `/environments/${ws}/services`, { name: "svc", protocol: "http", host: "first.example.com", port: 80 });
      let writer = 0;
      const deadline = Date.now() + 5_000;
      do {
        const { rows } = await h.sql.query<{ pid: number }>("select pid from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and $1 = any(pg_blocking_pids(pid))", [backend!.pid]);
        if (rows.length === 1) { writer = rows[0]!.pid; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      } while (Date.now() < deadline);
      expect(writer).toBeGreaterThan(0);
      expect((await h.sql.query("select relation::regclass::text as name from pg_locks where pid = $1 and mode = 'RowExclusiveLock' and relation in ('services'::regclass, 'environments'::regclass, 'audit_events'::regclass)", [writer])).rows).toEqual([]);
      await holder.query("commit");
      expect((await pending).status).toBe(201);
    } finally {
      await holder.query("rollback");
      holder.release();
      await pending;
    }
  });

  const fixture = async (withRoute = false) => {
    const env = await h.api("POST", "/environments", { name: uniq("writer") });
    expect(env.status).toBe(201);
    const ws = env.body.id as string;
    const svc = await h.api("POST", `/environments/${ws}/services`, { name: "svc", protocol: "http", host: "writer.example.com", port: 80 });
    expect(svc.status).toBe(201);
    const route = withRoute ? await h.api("POST", `/environments/${ws}/routes`, { name: "route", serviceId: svc.body.id, paths: ["/before"] }) : undefined;
    if (route) expect(route.status).toBe(201);
    return { ws, serviceId: svc.body.id as string, routeId: route?.body.id as string | undefined };
  };
  const waitFor = async (pid: number, pattern: string) => {
    const deadline = Date.now() + 4_000;
    do {
      const { rows } = await h.sql.query<{ pid: number; query: string }>(`select pid, query from pg_stat_activity where datname = current_database()
        and wait_event_type = 'Lock' and $1 = any(pg_blocking_pids(pid)) and query ~ $2`, [pid, pattern]);
      if (rows.length === 1) return rows[0]!;
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (Date.now() < deadline);
    throw new Error(`No lock wait for ${pattern} behind ${pid}`);
  };
  const barrier = async (query: string, ws: string, run: (pid: number, release: () => Promise<void>, start: <T>(p: Promise<T>) => Promise<T>) => Promise<void>) => {
    const holder = await h.sql.connect();
    const pending: Promise<unknown>[] = [];
    try {
      await holder.query("begin");
      await holder.query(query, [ws]);
      const { rows: [backend] } = await holder.query<{ pid: number }>("select pg_backend_pid() as pid");
      await run(backend!.pid, async () => { await holder.query("commit"); }, (p) => { pending.push(p); void p.catch(() => undefined); return p; });
    } finally {
      await holder.query("rollback");
      holder.release();
      await Promise.allSettled(pending);
    }
  };
  const snapshotsOf = async (ws: string) => (await h.sql.query("select * from snapshots where environment_id = $1 order by version", [ws])).rows;

  it("serializes createRoute v2 behind rollback v1 without taking a Service lock", async () => {
    const { ws, serviceId } = await fixture();
    expect((await h.api("POST", `/environments/${ws}/snapshots`, {})).status).toBe(201);
    expect((await h.api("POST", `/environments/${ws}/services`, { name: "extra", protocol: "http", host: "extra.example.com", port: 80 })).status).toBe(201);
    expect((await h.api("POST", `/environments/${ws}/snapshots`, {})).status).toBe(201);
    await barrier("select 1 from environments where id = $1 for update", ws, async (pid, release, start) => {
      const restoring = start(h.api("POST", `/environments/${ws}/snapshots/1/rollback`));
      const rollback = await waitFor(pid, 'from "environments".*for update');
      const writing = start(h.api("POST", `/../v2/workspaces/${ws}/routes`, { name: "after-rollback", serviceId, paths: ["/after"] }));
      const writer = await waitFor(rollback.pid, "pg_advisory_xact_lock\\(hashtextextended");
      expect((await h.sql.query("select 1 from pg_locks where pid = $1 and relation = 'services'::regclass", [writer.pid])).rows).toEqual([]);
      await release();
      expect((await restoring).status).toBe(201);
      expect((await writing).status).toBe(201);
    });
    expect((await snapshotsOf(ws)).map((s) => s.version)).toEqual([1, 2, 3]);
    expect((await h.sql.query("select action from audit_events where environment_id = $1 and action = 'snapshot.rollback'", [ws])).rows).toHaveLength(1);
  });

  it("serializes deleteService v2 behind import v1 with no extra publication", async () => {
    const { ws, serviceId } = await fixture();
    const exported = await h.api("GET", `/environments/${ws}/export?format=json`);
    expect(exported.status).toBe(200);
    exported.body.services[0].host = "imported.example.com";
    const before = await snapshotsOf(ws);
    await barrier("select 1 from environments where id = $1 for update", ws, async (pid, release, start) => {
      const importing = start(h.api("POST", `/environments/${ws}/import`, { mode: "replace", dryRun: false, document: exported.body }));
      const importer = await waitFor(pid, 'from "environments".*for update');
      const deleting = start(h.api("DELETE", `/../v2/workspaces/${ws}/services/${serviceId}`));
      await waitFor(importer.pid, "pg_advisory_xact_lock\\(hashtextextended");
      await release();
      expect((await importing).status).toBe(200);
      expect((await deleting).status).toBe(204);
    });
    expect(await snapshotsOf(ws)).toEqual(before);
    const { rows } = await h.sql.query("select before->>'host' as host from audit_events where environment_id = $1 and action = 'service.delete'", [ws]);
    expect(rows).toEqual([{ host: "imported.example.com" }]);
  });

  it("serializes deleteRoute v2 behind auto-publish v1 and preserves the published snapshot", async () => {
    const { ws, routeId } = await fixture(true);
    expect((await h.api("PATCH", `/environments/${ws}`, { name: uniq("auto"), publishMode: "auto" })).status).toBe(200);
    await h.sql.query(`create function ws_r3_pause_snapshot() returns trigger language plpgsql as $$
      begin perform pg_advisory_xact_lock(223, hashtext(TG_ARGV[0])); return NEW; end $$`);
    await h.sql.query(`create trigger ws_r3_pause_snapshot before insert on snapshots for each row when (NEW.environment_id = '${ws}'::uuid) execute function ws_r3_pause_snapshot('${ws}')`);
    try {
      await barrier("select pg_advisory_xact_lock(223, hashtext($1))", ws, async (pid, release, start) => {
        const publishing = start(h.app.get(SnapshotsService).autoPublish(ws, 0));
        const publisher = await waitFor(pid, 'insert into "snapshots"');
        const deleting = start(h.api("DELETE", `/../v2/workspaces/${ws}/routes/${routeId}`));
        const deletion = await waitFor(publisher.pid, "pg_advisory_xact_lock\\(hashtextextended");
        expect((await h.sql.query("select 1 from pg_locks where pid = $1 and mode = 'RowExclusiveLock'", [deletion.pid])).rows).toEqual([]);
        await release();
        expect(await publishing).toBe(true);
        const deleted = await deleting;
        expect([deleted.status, deleted.body.code]).toEqual([409, "auto-publish"]);
      });
      const before = await snapshotsOf(ws);
      expect(before).toHaveLength(1);
      expect((await h.api("GET", `/environments/${ws}/routes/${routeId}`)).status).toBe(200);
      expect(await h.app.get(SnapshotsService).autoPublish(ws, 0)).toBe(true);
      expect(await snapshotsOf(ws)).toEqual(before);
      expect((await h.sql.query("select 1 from audit_events where environment_id = $1 and action = 'route.delete'", [ws])).rows).toEqual([]);
    } finally { await h.sql.query("drop function ws_r3_pause_snapshot() cascade"); }
  });

  it("serializes two writes in one workspace while a different workspace proceeds", async () => {
    const one = await fixture();
    const two = await fixture();
    const before = await snapshotsOf(one.ws);
    await barrier("select 1 from environments where id = $1 for update", one.ws, async (pid, release, start) => {
      const first = start(h.api("PUT", `/environments/${one.ws}/services/${one.serviceId}`, { name: "first", protocol: "http", host: "first.example.com", port: 80 }));
      const writer = await waitFor(pid, 'update "environments"');
      const second = start(h.api("PUT", `/environments/${one.ws}/services/${one.serviceId}`, { name: "second", protocol: "http", host: "second.example.com", port: 80 }));
      const queued = await waitFor(writer.pid, "pg_advisory_xact_lock\\(hashtextextended");
      expect((await h.sql.query("select 1 from pg_locks where pid = $1 and mode = 'RowExclusiveLock'", [queued.pid])).rows).toEqual([]);
      const independent = await h.api("PUT", `/../v2/workspaces/${two.ws}/services/${two.serviceId}`, { name: "independent", protocol: "http", host: "independent.example.com", port: 80 });
      expect(independent.status).toBe(200);
      // A poller also yields to the workspace writer before touching any row.
      expect(await h.app.get(SnapshotsService).autoPublish(one.ws, 0)).toBe(true);
      await release();
      expect((await first).status).toBe(200);
      expect((await second).status).toBe(200);
    });
    const { rows } = await h.sql.query("select before->>'host' as before, after->>'host' as after from audit_events where entity_id = $1 and action = 'service.update'", [one.serviceId]);
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([{ before: "writer.example.com", after: "first.example.com" }, { before: "first.example.com", after: "second.example.com" }]));
    expect(await snapshotsOf(one.ws)).toEqual(before);
  });

  it.each(["40P01", "40001"])("retries real PostgreSQL %s aborts without duplicate writes or audits", async (code) => {
    const { ws } = await fixture();
    expectedAborts = [code, code];
    const before = await snapshotsOf(ws);
    await h.sql.query("create sequence ws_r3_attempt_seq");
    await h.sql.query(`create function ws_r3_abort_audit() returns trigger language plpgsql as $$
      begin if nextval('ws_r3_attempt_seq') <= 2 then raise exception using errcode = '${code}', message = 'WS-R3 controlled abort'; end if; return NEW; end $$`);
    await h.sql.query(`create trigger ws_r3_abort_audit after insert on audit_events for each row when (NEW.environment_id = '${ws}'::uuid and NEW.action = 'service.create') execute function ws_r3_abort_audit()`);
    try {
      const created = await h.api("POST", `/environments/${ws}/services`, { name: "retry", protocol: "http", host: "retry.example.com", port: 80 });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect((await h.sql.query("select last_value from ws_r3_attempt_seq")).rows).toEqual([{ last_value: "3" }]);
      expect((await h.sql.query("select id from services where environment_id = $1 and name = 'retry'", [ws])).rows).toEqual([{ id: created.body.id }]);
      expect((await h.sql.query("select entity_id from audit_events where environment_id = $1 and after->>'name' = 'retry'", [ws])).rows).toEqual([{ entity_id: created.body.id }]);
      expect(await snapshotsOf(ws)).toEqual(before);
    } finally { await h.sql.query("drop function ws_r3_abort_audit() cascade"); await h.sql.query("drop sequence ws_r3_attempt_seq"); }
  });

  it.each(["40P01", "40001"])("exhausts %s retries after three attempts and rolls every audit back", async (code) => {
    const { ws } = await fixture();
    expectedAborts = [code, code, code];
    const before = await snapshotsOf(ws);
    await h.sql.query("create sequence ws_r3_attempt_seq");
    await h.sql.query(`create function ws_r3_abort_audit() returns trigger language plpgsql as $$
      begin perform nextval('ws_r3_attempt_seq'); raise exception using errcode = '${code}', message = 'WS-R3 controlled abort'; end $$`);
    await h.sql.query(`create trigger ws_r3_abort_audit after insert on audit_events for each row when (NEW.environment_id = '${ws}'::uuid and NEW.action = 'service.create') execute function ws_r3_abort_audit()`);
    try {
      const res = await h.api("POST", `/environments/${ws}/services`, { name: "exhaust", protocol: "http", host: "exhaust.example.com", port: 80 });
      expect([res.status, res.body.code]).toEqual([409, "concurrent-update"]);
      expect((await h.sql.query("select last_value from ws_r3_attempt_seq")).rows).toEqual([{ last_value: "3" }]);
      expect((await h.sql.query("select id from services where environment_id = $1 and name = 'exhaust'", [ws])).rows).toEqual([]);
      expect((await h.sql.query("select id from audit_events where environment_id = $1 and after->>'name' = 'exhaust'", [ws])).rows).toEqual([]);
      expect(await snapshotsOf(ws)).toEqual(before);
    } finally { await h.sql.query("drop function ws_r3_abort_audit() cascade"); await h.sql.query("drop sequence ws_r3_attempt_seq"); }
  });

  it("times out a workspace lock without writes or publication", async () => {
    const { ws } = await fixture();
    const before = await snapshotsOf(ws);
    await barrier(`select pg_advisory_xact_lock(hashtextextended($1::uuid::text, ${ARCHIVE_LOCK_CLASS}))`, ws, async (pid, _release, start) => {
      const writing = start(h.api("POST", `/environments/${ws}/services`, { name: "timeout", protocol: "http", host: "timeout.example.com", port: 80 }));
      await waitFor(pid, "pg_advisory_xact_lock\\(hashtextextended");
      const res = await writing;
      expect([res.status, res.body.code]).toEqual([409, "concurrent-update"]);
    });
    expect((await h.sql.query("select id from services where environment_id = $1 and name = 'timeout'", [ws])).rows).toEqual([]);
    expect((await h.sql.query("select id from audit_events where environment_id = $1 and after->>'name' = 'timeout'", [ws])).rows).toEqual([]);
    expect(await snapshotsOf(ws)).toEqual(before);
  });


  it("locks multiple workspaces in canonical UUID order regardless of input order", async () => {
    const ids = [(await fixture()).ws, (await fixture()).ws].sort();
    await barrier(`select pg_advisory_xact_lock(hashtextextended($1::uuid::text, ${ARCHIVE_LOCK_CLASS}))`, ids[0]!, async (pid, release, start) => {
      const writing = start(workspaceTransaction(h.app.get<Db>(DB), [ids[1]!.toUpperCase(), ids[0]!, ids[1]!], async () => true));
      const writer = await waitFor(pid, "pg_advisory_xact_lock\\(hashtextextended");
      // If the high UUID was taken first, this backend would already own an advisory here.
      expect((await h.sql.query("select 1 from pg_locks where pid = $1 and locktype = 'advisory' and granted", [writer.pid])).rows).toEqual([]);
      await release();
      expect(await writing).toBe(true);
    });
  });

  it("commits a retried publish, audit and external NOTIFY exactly once", async () => {
    const { ws } = await fixture();
    expectedAborts = ["40001", "40001"];
    const listener = await h.sql.connect();
    const notifications: unknown[] = [];
    listener.on("notification", (n) => {
      if (n.channel === "gromesh_agent_events" && n.payload) {
        const body: unknown = JSON.parse(n.payload);
        if (typeof body === "object" && body !== null && "environmentId" in body && body.environmentId === ws) notifications.push(body);
      }
    });
    await listener.query("listen gromesh_agent_events");
    await listener.query("listen ws_r3_notify_fence");
    await h.sql.query("create sequence ws_r3_publish_seq");
    await h.sql.query(`create function ws_r3_abort_publish() returns trigger language plpgsql as $$
      begin if nextval('ws_r3_publish_seq') <= 2 then raise exception using errcode = '40001', message = 'WS-R3 commit abort'; end if; return NEW; end $$`);
    // Abort at commit, after the production NOTIFY was already enqueued, to prove transactional delivery.
    await h.sql.query(`create constraint trigger ws_r3_abort_publish after insert on audit_events deferrable initially deferred
      for each row when (NEW.environment_id = '${ws}'::uuid and NEW.action = 'snapshot.publish') execute function ws_r3_abort_publish()`);
    try {
      const published = await h.api("POST", `/environments/${ws}/snapshots`, {});
      expect(published.status, JSON.stringify(published.body)).toBe(201);
      const fence = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Notification fence not delivered")), 4_000);
        listener.on("notification", (n) => { if (n.channel === "ws_r3_notify_fence" && n.payload === ws) { clearTimeout(timeout); resolve(); } });
      });
      await listener.query("select pg_notify('ws_r3_notify_fence', $1)", [ws]);
      await fence;
      expect(notifications).toEqual([{ environmentId: ws, version: 1, hash: published.body.hash }]);
      expect((await snapshotsOf(ws)).map((s) => s.version)).toEqual([1]);
      expect((await h.sql.query("select last_value from ws_r3_publish_seq")).rows).toEqual([{ last_value: "3" }]);
      expect((await h.sql.query("select id from audit_events where environment_id = $1 and action = 'snapshot.publish'", [ws])).rows).toHaveLength(1);
    } finally {
      await listener.query("unlisten *");
      listener.removeAllListeners("notification");
      listener.release();
      await h.sql.query("drop function ws_r3_abort_publish() cascade");
      await h.sql.query("drop sequence ws_r3_publish_seq");
    }
  });


  it("does not cycle a value writer's User FK with a v1 role replacement waiting on the workspace", async () => {
    const { ws } = await fixture();
    const actor = await h.as("viewer");
    expect((await h.api("POST", `/../v2/workspaces/${ws}/role-bindings`, { subjectType: "user", subjectId: actor.id, role: "workspace-admin" })).status).toBe(201);
    expect((await h.api("PUT", `/../v2/workspaces/${ws}/variables/NAME`, { type: "string", required: true, secret: false })).status).toBe(200);
    const before = await snapshotsOf(ws);
    await h.sql.query(`create function ws_r3_pause_value() returns trigger language plpgsql as $$
      begin perform pg_advisory_xact_lock(224, hashtext(TG_ARGV[0])); return NEW; end $$`);
    await h.sql.query(`create trigger ws_r3_pause_value before insert on workspace_variable_values for each row when (NEW.workspace_id = '${ws}'::uuid) execute function ws_r3_pause_value('${ws}')`);
    try {
      await barrier("select pg_advisory_xact_lock(224, hashtext($1))", ws, async (pid, release, start) => {
        const setting = start(actor.api("PUT", `/../v2/workspaces/${ws}/variables/NAME/value`, { value: "one" }));
        const setter = await waitFor(pid, 'insert into "workspace_variable_values"');
        const roles = start(h.api("PUT", `/users/${actor.id}/environment-roles`, { items: [{ environmentId: ws, role: "viewer" }] }));
        await waitFor(setter.pid, "pg_advisory_xact_lock_shared\\(hashtextextended");
        await release();
        expect((await setting).status).toBe(204);
        expect((await roles).status).toBe(200);
      });
      expect((await h.sql.query("select value, version from workspace_variable_values where workspace_id = $1 and name = 'NAME'", [ws])).rows).toEqual([{ value: "one", version: 1 }]);
      expect((await h.sql.query("select id from audit_events where environment_id = $1 and action = 'workspace_variable.value.set'", [ws])).rows).toHaveLength(1);
      expect(await snapshotsOf(ws)).toEqual(before);
    } finally { await h.sql.query("drop function ws_r3_pause_value() cascade"); }
  });

});
