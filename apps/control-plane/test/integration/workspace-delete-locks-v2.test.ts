import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as retry from "../../src/common/retry.js";
import { DB, type Db } from "../../src/db/db.js";
import { type ApiResponse, startHarness, uniq, type Harness } from "./harness.js";

describe("v2 delete lock order (WS-R3 r2)", () => {
  let h: Harness;
  const aborts: string[] = [];
  let observed: { mockRestore(): void };

  beforeAll(async () => {
    h = await startHarness({ autoPublishPollMs: 0 });
    const db = h.app.get<Db>(DB);
    const transaction = db.transaction.bind(db);
    // Observe every attempt, including v1 plugins (no retry) and import's own retry loop.
    observed = vi.spyOn(db, "transaction").mockImplementation(((work, config) =>
      transaction(work, config).catch((error: unknown) => {
        const code = retry.pgCode(error);
        if (code && retry.CONCURRENCY_ABORTS.has(code)) aborts.push(code);
        throw error;
      })) as Db["transaction"]);
    await h.sql.query(`create function ws_r3_pause_plugin() returns trigger language plpgsql as $$
      declare env uuid;
      begin
        if TG_OP = 'DELETE' then env := OLD.environment_id; else env := NEW.environment_id; end if;
        if env::text = TG_ARGV[0] then perform pg_advisory_xact_lock(221, hashtext(TG_ARGV[0])); end if;
        return null;
      end $$`);
  });
  beforeEach(() => { aborts.length = 0; });
  afterAll(async () => {
    observed?.mockRestore();
    if (h) {
      await h.sql.query("drop function ws_r3_pause_plugin() cascade");
      await h.close();
    }
  });

  const waitFor = async (blockers: number[], pattern: string, exclude: number[] = []) => {
    const deadline = Date.now() + 5_000;
    do {
      const { rows } = await h.sql.query<{ pid: number; query: string }>(`select pid, query from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
          and pg_blocking_pids(pid) && $1::int[] and query ~ $2 and pid <> all($3::int[])`, [blockers, pattern, exclude]);
      if (rows.length === 1) return rows[0]!;
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    throw new Error(`No lock wait for ${pattern} behind ${blockers}`);
  };
  const fixture = async () => {
    const env = await h.api("POST", "/environments", { name: uniq("delete-locks") });
    expect(env.status).toBe(201);
    const ws = env.body.id as string;
    const svc = await h.api("POST", `/environments/${ws}/services`, { name: "svc", protocol: "http", host: "locks.example.com", port: 80 });
    expect(svc.status).toBe(201);
    return { ws, serviceId: svc.body.id as string };
  };
  const withBarrier = async (query: string, value: string, run: (pid: number, start: (p: Promise<ApiResponse>) => Promise<ApiResponse>, release: () => Promise<void>) => Promise<void>) => {
    const holder = await h.sql.connect();
    const pending: Promise<ApiResponse>[] = [];
    try {
      await holder.query("begin");
      await holder.query(query, [value]);
      const { rows: [backend] } = await holder.query<{ pid: number }>("select pg_backend_pid() as pid");
      await run(backend!.pid, (p) => { pending.push(p); void p.catch(() => undefined); return p; }, async () => { await holder.query("commit"); });
    } finally {
      await holder.query("rollback");
      holder.release();
      await Promise.allSettled(pending);
      // A recovered 40P01 must fail this test as well, regardless of which request was the victim.
      expect(aborts).toEqual([]);
    }
  };

  it.each(["route", "service"] as const)("does not cycle a rollback holding a deleted plugin with PUT retaining its %s scope", async (entity) => {
    const { ws, serviceId } = await fixture();
    const route = await h.api("POST", `/environments/${ws}/routes`, { name: "route", serviceId, paths: ["/route"] });
    expect(route.status).toBe(201);
    const scope = entity === "route" ? { routeId: route.body.id as string } : { serviceId };
    const body = { name: "key-auth", scope, config: {} };
    const plugin = await h.api("POST", `/environments/${ws}/plugins`, body);
    expect(plugin.status).toBe(201);
    const snapshot = await h.api("POST", `/environments/${ws}/snapshots`, {});
    expect(snapshot.status, JSON.stringify(snapshot.body)).toBe(201);
    await h.sql.query(`create trigger ws_r3_pause_plugin after delete on plugins
      for each row execute function ws_r3_pause_plugin('${ws}')`);
    try {
      await withBarrier("select pg_advisory_xact_lock(221, hashtext($1))", ws, async (pid, start, release) => {
        const restoring = start(h.api("POST", `/environments/${ws}/snapshots/${snapshot.body.version}/rollback`));
        const rollback = await waitFor([pid], 'delete from "plugins"');
        const writing = start(h.api("PUT", `/environments/${ws}/plugins/${plugin.body.id}`, { ...body, enabled: false }));
        await waitFor([rollback.pid], 'update "plugins"');
        await release();
        // Restoring the current configuration still deletes/reinserts the parents, then rolls back on the
        // no-change conflict. The PUT can then update the original row, preserving v1's existing behavior.
        const restored = await restoring;
        expect([restored.status, restored.body.detail], JSON.stringify(restored.body)).toEqual([409, expect.stringMatching(/Nothing to roll back/)]);
        const written = await writing;
        expect(written.status, JSON.stringify(written.body)).toBe(200);
        expect(written.body).toMatchObject({ id: plugin.body.id, enabled: false, scope });
      });
      const stored = await h.api("GET", `/environments/${ws}/plugins/${plugin.body.id}`);
      expect(stored.body).toMatchObject({ enabled: false, scope });
      expect((await h.sql.query("select version from snapshots where environment_id = $1", [ws])).rows).toEqual([{ version: 1 }]);
    } finally {
      await h.sql.query("drop trigger ws_r3_pause_plugin on plugins");
    }
  });

  it.each([
    ["v1", "POST", false], ["v1", "PUT", false],
    ["v2", "POST", false], ["v2", "PUT", false], ["v2", "POST", true],
  ] as const)("serializes Service DELETE with %s %s queued on the environment (referenced=%s)", async (api, method, referenced) => {
    const { ws, serviceId } = await fixture();
    let routeId = "";
    if (method === "PUT" || referenced) {
      const source = method === "PUT" ? await h.api("POST", `/environments/${ws}/services`, { name: "source", protocol: "http", host: "source.example.com", port: 80 }) : undefined;
      if (source) expect(source.status).toBe(201);
      const initial = await h.api("POST", `/environments/${ws}/routes`, { name: "original", serviceId: source?.body.id ?? serviceId, paths: ["/before"] });
      expect(initial.status).toBe(201);
      routeId = initial.body.id as string;
    }
    await withBarrier("select 1 from environments where id = $1 for no key update", ws, async (pid, start, release) => {
      const writing = start(h.api(method, `${api === "v1" ? `/environments/${ws}` : `/../v2/workspaces/${ws}`}/routes${method === "PUT" ? `/${routeId}` : ""}`,
        { name: "written", serviceId, paths: ["/after"] }));
      const writer = await waitFor([pid], '"environments"');
      const deleting = start(h.api("DELETE", `/../v2/workspaces/${ws}/services/${serviceId}`));
      await waitFor([pid, writer.pid], '"(services|environments)"', [writer.pid]);
      await release();
      const [written, deleted] = await Promise.all([writing, deleting]);
      expect(written.status, JSON.stringify(written.body)).toBe(method === "POST" ? 201 : 200);
      expect([deleted.status, deleted.body?.detail], JSON.stringify(deleted.body)).toEqual([409, expect.stringMatching(/route/)]);
      expect(deleted.body?.code).not.toBe("concurrent-update");
    });
  });

  it.each(["delete-v1", "delete-v2", "create", "replace", "rebind", "unbind"] as const)("serializes Route DELETE with plugin %s holding its row before marking the draft", async (operation) => {
    const { ws, serviceId } = await fixture();
    const route = await h.api("POST", `/environments/${ws}/routes`, { name: "route", serviceId, paths: ["/route"] });
    expect(route.status).toBe(201);
    const routeId = route.body.id as string;
    const scoped = { name: "key-auth", scope: { routeId }, config: {} };
    const body = operation === "unbind" ? { ...scoped, scope: {} } : scoped;
    const plugin = operation === "create" ? undefined : await h.api("POST", `/environments/${ws}/plugins`, operation === "rebind" ? { ...scoped, scope: {} } : scoped);
    if (plugin) expect(plugin.status, JSON.stringify(plugin.body)).toBe(201);
    await h.sql.query(`create trigger ws_r3_pause_plugin after insert or update or delete on plugins
      for each row execute function ws_r3_pause_plugin('${ws}')`);
    try {
      await withBarrier("select pg_advisory_xact_lock(221, hashtext($1))", ws, async (pid, start, release) => {
        const writing = start(operation.startsWith("delete")
          ? h.api("DELETE", `${operation === "delete-v1" ? `/environments/${ws}` : `/../v2/workspaces/${ws}`}/plugins/${plugin!.body.id}`)
          : h.api(operation === "create" ? "POST" : "PUT", `/environments/${ws}/plugins${plugin ? `/${plugin.body.id}` : ""}`, body));
        const writer = await waitFor([pid], '"plugins"');
        const deleting = start(h.api("DELETE", `/../v2/workspaces/${ws}/routes/${routeId}`));
        await waitFor([writer.pid], '"(routes|plugins)"');
        await release();
        const [written, deleted] = await Promise.all([writing, deleting]);
        expect(written.status, JSON.stringify(written.body)).toBe(operation.startsWith("delete") ? 204 : operation === "create" ? 201 : 200);
        expect(deleted.status, JSON.stringify(deleted.body)).toBe(204);
      });
      expect((await h.sql.query("select id from routes where id = $1", [routeId])).rows).toEqual([]);
      expect((await h.sql.query("select id from plugins where environment_id = $1", [ws])).rows).toEqual(operation === "unbind" ? [{ id: plugin!.body.id }] : []);
    } finally {
      await h.sql.query("drop trigger ws_r3_pause_plugin on plugins");
    }
  });

  it.each(["create", "rebind"] as const)("serializes plugin %s at its FK behind a Route DELETE that already owns the route and plugins", async (operation) => {
    const { ws, serviceId } = await fixture();
    const route = await h.api("POST", `/environments/${ws}/routes`, { name: "route", serviceId, paths: ["/route"] });
    expect(route.status).toBe(201);
    const routeId = route.body.id as string;
    const body = { name: "key-auth", scope: { routeId }, config: {} };
    const guard = await h.api("POST", `/environments/${ws}/plugins`, { name: "cors", scope: { routeId }, config: {} });
    expect(guard.status).toBe(201);
    const plugin = operation === "rebind" ? await h.api("POST", `/environments/${ws}/plugins`, { ...body, scope: {} }) : undefined;
    if (plugin) expect(plugin.status).toBe(201);
    await withBarrier("select 1 from environments where id = $1 for no key update", ws, async (pid, start, release) => {
      const deleting = start(h.api("DELETE", `/../v2/workspaces/${ws}/routes/${routeId}`));
      const deletion = await waitFor([pid], 'from "environments".*for no key update');
      const writing = start(h.api(plugin ? "PUT" : "POST", `/environments/${ws}/plugins${plugin ? `/${plugin.body.id}` : ""}`, body));
      await waitFor([deletion.pid], plugin ? 'update "plugins"' : 'insert into "plugins"');
      await release();
      expect((await deleting).status).toBe(204);
      const written = await writing;
      expect([written.status, written.body?.detail], JSON.stringify(written.body)).toEqual([409, "The entity is still referenced by other entities"]);
      expect(written.body?.code).not.toBe("concurrent-update");
    });
    expect((await h.sql.query("select id from routes where id = $1", [routeId])).rows).toEqual([]);
    expect((await h.sql.query("select id, route_id from plugins where environment_id = $1", [ws])).rows).toEqual(plugin ? [{ id: plugin.body.id, route_id: null }] : []);
    if (plugin) expect((await h.sql.query("select id from audit_events where entity_id = $1 and action = 'plugin.update'", [plugin.body.id])).rows).toEqual([]);
  });

  it.each(["retain", "unbind"] as const)("queues plugin PUT (%s scope) on its row behind Route DELETE before the environment", async (operation) => {
    const { ws, serviceId } = await fixture();
    const route = await h.api("POST", `/environments/${ws}/routes`, { name: "route", serviceId, paths: ["/route"] });
    expect(route.status).toBe(201);
    const routeId = route.body.id as string;
    const body = { name: "key-auth", scope: { routeId }, config: {} };
    const plugin = await h.api("POST", `/environments/${ws}/plugins`, body);
    expect(plugin.status).toBe(201);
    // The DELETE takes the route/plugins before checking auto mode. Its refusal leaves the plugin available
    // for the queued PUT, so this barrier can check the existing v1 success response as well as no aborts.
    expect((await h.api("PATCH", `/environments/${ws}`, { name: uniq("auto-delete-locks"), publishMode: "auto" })).status).toBe(200);
    const scope = operation === "unbind" ? {} : body.scope;
    await withBarrier("select 1 from environments where id = $1 for no key update", ws, async (pid, start, release) => {
      const deleting = start(h.api("DELETE", `/../v2/workspaces/${ws}/routes/${routeId}`));
      const deletion = await waitFor([pid], 'from "environments".*for no key update');
      const writing = start(h.api("PUT", `/environments/${ws}/plugins/${plugin.body.id}`, { ...body, enabled: false, scope }));
      await waitFor([deletion.pid], 'update "plugins"');
      await release();
      const deleted = await deleting;
      expect([deleted.status, deleted.body?.code]).toEqual([409, "auto-publish"]);
      const written = await writing;
      expect(written.status, JSON.stringify(written.body)).toBe(200);
      expect(written.body).toMatchObject({ id: plugin.body.id, enabled: false, scope: { routeId: operation === "unbind" ? null : routeId } });
    });
    expect((await h.api("GET", `/environments/${ws}/routes/${routeId}`)).status).toBe(200);
  });

  it.each(["service", "route"] as const)("serializes %s DELETE with plugin creation holding its scope before the environment", async (entity) => {
    const { ws, serviceId } = await fixture();
    const route = entity === "route" ? await h.api("POST", `/environments/${ws}/routes`, { name: "route", serviceId, paths: ["/route"] }) : undefined;
    if (route) expect(route.status).toBe(201);
    const id = (route?.body.id ?? serviceId) as string;
    await withBarrier("select 1 from environments where id = $1 for no key update", ws, async (pid, start, release) => {
      const writing = start(h.api("POST", `/environments/${ws}/plugins`, { name: "key-auth", scope: { [`${entity}Id`]: id }, config: {} }));
      const writer = await waitFor([pid], 'update "environments"');
      const deleting = start(h.api("DELETE", `/../v2/workspaces/${ws}/${entity}s/${id}`));
      await waitFor([writer.pid], `from "${entity}s".*for update`);
      await release();
      expect((await writing).status).toBe(201);
      const deleted = await deleting;
      expect(deleted.status, JSON.stringify(deleted.body)).toBe(entity === "service" ? 409 : 204);
      if (entity === "service") expect(deleted.body.detail).toMatch(/plugin/);
    });
  });

  it.each(["service", "route"] as const)("refuses %s DELETE waiting behind archive without a cycle or a partial delete", async (entity) => {
    const { ws, serviceId } = await fixture();
    const route = entity === "route" ? await h.api("POST", `/environments/${ws}/routes`, { name: "route", serviceId, paths: ["/route"] }) : undefined;
    if (route) expect(route.status).toBe(201);
    const id = (route?.body.id ?? serviceId) as string;
    const before = (await h.sql.query(`select * from ${entity}s where id = $1`, [id])).rows;
    await withBarrier("select 1 from environments where id = $1 for no key update", ws, async (pid, start, release) => {
      const archiving = start(h.api("POST", `/../v2/workspaces/${ws}/archive`));
      const archive = await waitFor([pid], 'from "environments".*for no key update');
      const deleting = start(h.api("DELETE", `/../v2/workspaces/${ws}/${entity}s/${id}`));
      await waitFor([archive.pid], "pg_advisory_xact_lock_shared");
      await release();
      expect((await archiving).status).toBe(204);
      const deleted = await deleting;
      expect([deleted.status, deleted.body?.code]).toEqual([409, "workspace-archived"]);
    });
    expect((await h.sql.query(`select * from ${entity}s where id = $1`, [id])).rows).toEqual(before);
    expect((await h.sql.query("select id from audit_events where entity_id = $1 and action like '%.delete'", [id])).rows).toEqual([]);
  });
});
