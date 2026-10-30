import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as retry from "../../src/common/retry.js";
import { type ApiResponse, startHarness, uniq, type Harness } from "./harness.js";

describe("v2 delete lock order (WS-R3 r1)", () => {
  let h: Harness;
  const aborts: string[] = [];
  const transaction = retry.retryingTransaction;
  const observed = vi.spyOn(retry, "retryingTransaction").mockImplementation(async <T>(work: () => Promise<T>, attempts?: number) =>
    transaction(async () => {
      try { return await work(); }
      catch (error) {
        const code = retry.pgCode(error);
        if (code && retry.CONCURRENCY_ABORTS.has(code)) aborts.push(code);
        throw error;
      }
    }, attempts));

  beforeAll(async () => {
    h = await startHarness({ autoPublishPollMs: 0 });
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
    observed.mockRestore();
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
    }
    // Observe the real retry loop: a recovered 40P01 must fail this test as well.
    expect(aborts).toEqual([]);
  };

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

  it.each(["create", "replace"] as const)("serializes plugin %s behind a Route DELETE that already owns the route and plugins", async (operation) => {
    const { ws, serviceId } = await fixture();
    const route = await h.api("POST", `/environments/${ws}/routes`, { name: "route", serviceId, paths: ["/route"] });
    expect(route.status).toBe(201);
    const routeId = route.body.id as string;
    const body = { name: "key-auth", scope: { routeId }, config: {} };
    const plugin = operation === "replace" ? await h.api("POST", `/environments/${ws}/plugins`, body) : undefined;
    if (plugin) expect(plugin.status).toBe(201);
    await withBarrier("select 1 from environments where id = $1 for no key update", ws, async (pid, start, release) => {
      const deleting = start(h.api("DELETE", `/../v2/workspaces/${ws}/routes/${routeId}`));
      const deletion = await waitFor([pid], 'from "environments".*for no key update');
      const writing = start(h.api(plugin ? "PUT" : "POST", `/environments/${ws}/plugins${plugin ? `/${plugin.body.id}` : ""}`, body));
      await waitFor([deletion.pid], 'from "routes".*for key share');
      await release();
      expect((await deleting).status).toBe(204);
      const written = await writing;
      expect([written.status, written.body?.errors?.[0]?.path], JSON.stringify(written.body)).toEqual([422, "scope.routeId"]);
    });
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
