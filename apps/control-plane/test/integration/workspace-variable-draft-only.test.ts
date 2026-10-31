import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ARCHIVE_LOCK_CLASS } from "../../src/common/workspace-transaction.js";
import { SnapshotsService } from "../../src/snapshots/snapshots.js";
import { startHarness, uniq, type Harness } from "./harness.js";

const declaration = { type: "string", secret: false, required: false };
describe("variable draft-only writes (WS-R4 B1)", () => {
  let h: Harness;
  beforeAll(async () => { h = await startHarness({ autoPublishPollMs: 0 }); });
  afterAll(async () => h?.close());
  const state = async (ws: string) =>(await h.sql.query(`select to_jsonb(e) as environment,
    (select jsonb_agg(v order by v.name) from workspace_variables v where v.workspace_id = e.id) as declarations,
    (select jsonb_agg(v order by v.name, v.version) from workspace_variable_values v where v.workspace_id = e.id) as values,
    (select jsonb_agg(a order by a.id) from audit_events a where a.environment_id = e.id) as audits,
    (select jsonb_agg(s order by s.version) from snapshots s where s.environment_id = e.id) as snapshots
    from environments e where e.id = $1`, [ws])).rows[0]!;
  const fixture = async () => {
    const env = await h.api("POST", "/environments", { name: uniq("variable-draft") });
    expect(env.status).toBe(201);
    const ws = env.body.id as string;
    expect((await h.api("POST", `/environments/${ws}/services`, { name: "svc", protocol: "http", host: "vars.example.com", port: 80 })).status).toBe(201);
    expect((await h.api("PUT", `/../v2/workspaces/${ws}/variables/LOCAL`, declaration)).status).toBe(200);
    expect((await h.api("PUT", `/../v2/workspaces/${ws}/variables/LOCAL/value`, { value: "kept" })).status).toBe(204);
    expect((await h.api("POST", `/environments/${ws}/snapshots`, {})).status).toBe(201);
    return ws;
  };
  const write = (ws: string, op: string) => h.api<{ code?: string }>(op === "delete" ? "DELETE" : "PUT",
    `/../v2/workspaces/${ws}/variables/${op === "declare" ? "NEW" : "LOCAL"}`,
    op === "delete" ? undefined : { ...declaration, secret: true });

  it.each(["declare", "replace", "delete"])("refuses %s in auto mode without changing declarations, stored values, audit, dirty state or snapshots", async (op) => {
    const ws = await fixture();
    await h.sql.query("update environments set publish_mode = 'auto' where id = $1", [ws]);
    const before = await state(ws);
    const res = await write(ws, op);
    expect([res.status, res.body?.code], JSON.stringify(res.body)).toEqual([409, "auto-publish"]);
    expect(res.contentType).toContain("application/problem+json");
    expect(await state(ws)).toEqual(before);
    await h.app.get(SnapshotsService).autoPublish(ws, 0);
    expect(await state(ws)).toEqual(before);
  });

  it.each(["declare", "replace", "delete"])("allows %s in manual mode with one audit and a draft change only", async (op) => {
    const ws = await fixture();
    const before = await state(ws);
    expect((await write(ws, op)).status).toBe(op === "delete" ? 204 : 200);
    const after = await state(ws);
    expect(after.environment).toMatchObject({ publish_mode: "manual", current_version: 1, has_unpublished_changes: true });
    expect(after.snapshots).toEqual(before.snapshots);
    expect(after.audits).toHaveLength(before.audits.length + 1);
    expect(after.declarations).not.toEqual(before.declarations);
    if (op === "replace") expect(after.values[0]).toMatchObject({ sealed: true });
    else expect(after.values).toEqual(before.values);
    await h.app.get(SnapshotsService).autoPublish(ws, 0);
    expect(await state(ws)).toEqual(after);
  });

  it.each(["declare", "delete"])("serializes %s behind the workspace lock and observes a committed switch to auto", async (op) => {
    const ws = await fixture();
    const before = await state(ws);
    const holder = await h.sql.connect();
    let pending: ReturnType<typeof write> | undefined;
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtextextended($1::uuid::text, $2))", [ws, ARCHIVE_LOCK_CLASS]);
      await holder.query("update environments set publish_mode = 'auto' where id = $1", [ws]);
      const { rows: [backend] } = await holder.query<{ pid: number }>("select pg_backend_pid() as pid");
      pending = write(ws, op);
      let writer = 0;
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const { rows } = await h.sql.query<{ pid: number; query: string }>(`select pid, query from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock' and $1 = any(pg_blocking_pids(pid))`, [backend!.pid]);
        if (rows.length) {
          expect(rows[0]!.query).toContain("pg_advisory_xact_lock(hashtextextended");
          writer = rows[0]!.pid;
          break;
        }
      }
      expect(writer).toBeGreaterThan(0);
      expect((await h.sql.query(`select 1 from pg_locks where pid = $1 and mode = 'RowExclusiveLock'
        and relation in ('workspace_variables'::regclass, 'workspace_variable_values'::regclass, 'environments'::regclass, 'audit_events'::regclass)`, [writer])).rows).toEqual([]);
      expect(await state(ws)).toEqual(before);
      await holder.query("commit");
      const res = await pending;
      expect([res.status, res.body?.code]).toEqual([409, "auto-publish"]);
    } finally {
      await holder.query("rollback");
      holder.release();
      await pending;
    }
    expect(await state(ws)).toEqual({ ...before, environment: { ...before.environment, publish_mode: "auto" } });
  });

  it.each(["declare", "delete"])("keeps the workspace lock from the %s check until commit while a switch to auto waits", async (op) => {
    const ws = await fixture();
    const before = await state(ws);
    const holder = await h.sql.connect();
    const pending: ReturnType<Harness["api"]>[] = [];
    const waitFor = async (pid: number, pattern: string) => {
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const { rows } = await h.sql.query<{ pid: number; query: string }>(`select pid, query from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock' and $1 = any(pg_blocking_pids(pid))
          and query ~ $2`, [pid, pattern]);
        if (rows.length === 1) return rows[0]!;
      }
      throw new Error(`No lock wait for ${pattern} behind ${pid}`);
    };
    await h.sql.query(`create function ws_r4_pause_variable() returns trigger language plpgsql as $$
      begin
        if (case when TG_OP = 'DELETE' then OLD.workspace_id else NEW.workspace_id end)::text = TG_ARGV[0]
        then perform pg_advisory_xact_lock(224, hashtext(TG_ARGV[0])); end if;
        return null;
      end $$`);
    await h.sql.query(`create trigger ws_r4_pause_variable after insert or update or delete on workspace_variables
      for each row execute function ws_r4_pause_variable('${ws}')`);
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(224, hashtext($1))", [ws]);
      const { rows: [backend] } = await holder.query<{ pid: number }>("select pg_backend_pid() as pid");
      const writing = write(ws, op);
      pending.push(writing);
      const writer = await waitFor(backend!.pid, "workspace_variables");
      const switching = h.api("PATCH", `/environments/${ws}`, { name: before.environment.name, publishMode: "auto" });
      pending.push(switching);
      await waitFor(writer.pid, "pg_advisory_xact_lock\\(hashtextextended");
      expect(await state(ws)).toEqual(before);
      await holder.query("commit");
      expect((await writing).status).toBe(op === "delete" ? 204 : 200);
      expect((await switching).status).toBe(200);
    } finally {
      await holder.query("rollback");
      holder.release();
      await Promise.allSettled(pending);
      await h.sql.query("drop function ws_r4_pause_variable() cascade");
    }
    const after = await state(ws);
    expect(after.environment).toMatchObject({ publish_mode: "auto", current_version: 1, has_unpublished_changes: true });
    expect(after.snapshots).toEqual(before.snapshots);
    expect(after.audits).toHaveLength(before.audits.length + 2);
    expect(after.declarations).not.toEqual(before.declarations);
  });

  it("keeps setWorkspaceValue available in auto mode without dirtying or publishing the draft", async () => {
    const ws = await fixture();
    await h.sql.query("update environments set publish_mode = 'auto' where id = $1", [ws]);
    const before = await state(ws);
    expect((await h.api("PUT", `/../v2/workspaces/${ws}/variables/LOCAL/value`, { value: "local-only" })).status).toBe(204);
    const after = await state(ws);
    expect(after.environment).toEqual(before.environment);
    expect(after.declarations).toEqual(before.declarations);
    expect(after.values).toHaveLength(2);
    expect(after.audits).toHaveLength(before.audits.length + 1);
    expect(after.snapshots).toEqual(before.snapshots);
    await h.app.get(SnapshotsService).autoPublish(ws, 0);
    expect(await state(ws)).toEqual(after);
  });
});
