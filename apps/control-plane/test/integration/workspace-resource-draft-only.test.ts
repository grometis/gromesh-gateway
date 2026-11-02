import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrationDatabaseName, createIntegrationDatabase, dropIntegrationDatabase } from "./databases.js";
import { basicAuthPasswordHash, type ConfigDocument, type GatewayState } from "@gromesh/compiler";
import { basicAuthHashContext, credentialContext, ENCRYPTOR, Encryptor, jwtSecretContext, snapshotContext } from "../../src/crypto/crypto.js";
import { runMigrations } from "../../src/db/migrate.js";
import { SnapshotsService } from "../../src/snapshots/snapshots.js";
import { selfSigned } from "./certs.js";
import { startHarness, uniq, type ApiClient, type ApiResponse, type Harness } from "./harness.js";

type Operation = { id: string; method: string; resource: string; action: "create" | "replace" | "delete" | "rotate" };
const operations: Operation[] = [
  ...["Consumer", "Upstream", "Target", "Certificate"].flatMap((resource) => [
    { id: `create${resource}`, method: "POST", resource, action: "create" as const },
    { id: `replace${resource}`, method: "PUT", resource, action: "replace" as const },
    { id: `delete${resource}`, method: "DELETE", resource, action: "delete" as const },
  ]),
  ...["KeyAuth", "Jwt", "BasicAuth"].flatMap((resource) => [
    { id: `create${resource}Credential`, method: "POST", resource, action: "create" as const },
    { id: `delete${resource}Credential`, method: "DELETE", resource, action: "delete" as const },
    ...(resource === "BasicAuth" ? [] : [{ id: `rotate${resource}Credential`, method: "POST", resource, action: "rotate" as const }]),
  ]),
  { id: "replaceConsumerAclGroups", method: "PUT", resource: "AclGroups", action: "replace" },
  { id: "deletePlugin", method: "DELETE", resource: "Plugin", action: "delete" },
];

// Include guarded credential creation and consumer deletion (three credential tables + cascades),
// alongside replacement/rotation paths. Certificate replacement also checks its SNIs.
const uniquePaths = operations.filter((op) => [
  "createKeyAuthCredential", "createJwtCredential", "createBasicAuthCredential", "deleteConsumer",
].includes(op.id));
const representatives = operations.filter((op) => [
  "replaceConsumer", "rotateKeyAuthCredential", "rotateJwtCredential", "deleteBasicAuthCredential",
  "replaceConsumerAclGroups", "replaceUpstream", "replaceTarget", "replaceCertificate", "deletePlugin",
].includes(op.id) || uniquePaths.includes(op));

interface DraftState {
  environment: { name: string; publish_mode: string; current_version: number | null; has_unpublished_changes: boolean };
  workspace: Record<string, unknown>;
  audits: { id: string; action: string }[];
  snapshots: { version: number; hash: string; rollback_of: number | null }[];
  releases: unknown[];
  deployments: unknown[];
  entities: Record<string, unknown>;
}

describe("remaining resource draft-only writes (WS-R4 B2)", () => {
  const database = integrationDatabaseName("wsr4d");
  const applicationName = `ws-r4d-${process.pid}`;
  let h: Harness;
  let viewer: ApiClient;
  beforeAll(async () => {
    // Table barriers and audit-trigger DDL affect every workspace in a database. Foreign harnesses also
    // publish every eligible draft, even when this harness's poller is off: isolate the whole file.
    const url = await createIntegrationDatabase(database, { applicationName });
    await runMigrations(url);
    h = await startHarness({ databaseUrl: url, autoPublishPollMs: 0 });
    viewer = (await h.as("viewer")).api;
  });
  afterAll(async () => {
    try { await h?.close(); }
    finally {
      await dropIntegrationDatabase(database);
    }
  });
  const state = async (ws: string) => (await h.sql.query<DraftState>(`select to_jsonb(e) as environment,
    (select to_jsonb(w) from workspaces w where w.id = e.id) as workspace,
    (select jsonb_agg(a order by a.id) from audit_events a where a.environment_id = e.id) as audits,
    coalesce((select jsonb_agg(s order by s.version) from snapshots s where s.environment_id = e.id), '[]'::jsonb) as snapshots,
    coalesce((select jsonb_agg(r order by r.version) from releases r where r.workspace_id = e.id), '[]'::jsonb) as releases,
    coalesce((select jsonb_agg(d order by d.epoch, d.revision) from deployments d
      where d.members @> jsonb_build_array(jsonb_build_object('workspaceId', e.id))), '[]'::jsonb) as deployments,
    jsonb_build_object(
      'consumers', (select jsonb_agg(t order by t.id) from consumers t where t.environment_id = e.id),
      'keyAuth', (select jsonb_agg(t order by t.id) from keyauth_credentials t where t.environment_id = e.id),
      'jwt', (select jsonb_agg(t order by t.id) from jwt_credentials t where t.environment_id = e.id),
      'basicAuth', (select jsonb_agg(t order by t.id) from basicauth_credentials t where t.environment_id = e.id),
      'upstreams', (select jsonb_agg(t order by t.id) from upstreams t where t.environment_id = e.id),
      'targets', (select jsonb_agg(t order by t.id) from targets t where t.environment_id = e.id),
      'certificates', (select jsonb_agg(t order by t.id) from certificates t where t.environment_id = e.id),
      'snis', (select jsonb_agg(t order by t.name) from certificate_snis t where t.environment_id = e.id),
      'plugins', (select jsonb_agg(t order by t.id) from plugins t where t.environment_id = e.id)
    ) as entities from environments e where e.id = $1`, [ws])).rows[0]!;

  const fixture = async (op: Operation, published = true) => {
    const env = await h.api("POST", "/environments", { name: uniq("draft-only") });
    expect(env.status).toBe(201);
    const ws = env.body.id as string;
    const root = `/environments/${ws}`;
    const seed = async (path: string, body: unknown) => {
      const res = await h.api("POST", root + path, body);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body.id as string;
    };
    await seed("/services", { name: "svc", protocol: "http", host: "draft.example.com", port: 80 });
    let path = "";
    let body: Record<string, unknown> | undefined;
    let expectedSnis: string[] | undefined;
    const { resource, action } = op;
    if (["Consumer", "KeyAuth", "Jwt", "BasicAuth", "AclGroups"].includes(resource)) {
      path = "/consumers";
      if (resource === "Consumer") {
        if (action !== "create") path += `/${await seed(path, { username: "before" })}`;
        if (action === "delete") {
          await seed(path + "/key-auth", {});
          await seed(path + "/jwt", { algorithm: "HS256" });
          await seed(path + "/basic-auth", { username: uniq("cascade"), password: "test-password" });
          await seed("/plugins", { name: "rate-limiting", scope: { consumerId: path.split("/").at(-1) }, config: { minute: 5, policy: "local" } });
        }
        body = { username: "after" };
      } else {
        const consumer = await seed(path, { username: "parent" });
        path += `/${consumer}`;
        if (resource === "AclGroups") {
          path += "/acl-groups";
          body = { groups: ["gold"] };
        } else {
          const suffix = { KeyAuth: "key-auth", Jwt: "jwt", BasicAuth: "basic-auth" }[resource as "KeyAuth" | "Jwt" | "BasicAuth"];
          path += `/${suffix}`;
          body = resource === "Jwt" ? { algorithm: "HS256" } : resource === "BasicAuth" ? { username: uniq("basic"), password: "test-password" } : {};
          if (action !== "create") path += `/${await seed(path, body)}`;
          if (action === "rotate") path += "/rotate";
        }
      }
    } else if (resource === "Upstream" || resource === "Target") {
      path = "/upstreams";
      if (resource === "Target") {
        path += `/${await seed(path, { name: "pool" })}/targets`;
        if (action !== "create") path += `/${await seed(path, { target: "before.example.com:8080" })}`;
        body = { target: "after.example.com:8081", weight: 5 };
      } else {
        if (action !== "create") path += `/${await seed(path, { name: "pool" })}`;
        body = { name: "changed", algorithm: "least-connections" };
      }
    } else if (resource === "Certificate") {
      const name = `${uniq("cert")}.example.com`;
      const pem = selfSigned(name);
      path = "/certificates";
      if (action !== "create") path += `/${await seed(path, { cert: pem.cert, key: pem.key, snis: [name] })}`;
      expectedSnis = [`changed.${name}`];
      body = { cert: pem.cert, key: pem.key, snis: expectedSnis, tags: ["changed"] };
    } else {
      path = `/plugins/${await seed("/plugins", { name: "cors", scope: {}, config: {} })}`;
    }
    if (published) expect((await h.api("POST", root + "/snapshots", {})).status).toBe(201);
    return { ws, path, body, expectedSnis, write: (v1 = false, api = h.api) => api(op.method, (v1 ? root : `/../v2/workspaces/${ws}`) + path, action === "delete" || action === "rotate" ? undefined : body), status: action === "delete" ? 204 : action === "replace" || action === "rotate" ? 200 : 201 };
  };

  const unchangedPublication = (before: DraftState, after: DraftState) => {
    expect(after.snapshots).toEqual(before.snapshots);
    expect(after.releases).toEqual(before.releases);
    expect(after.deployments).toEqual(before.deployments);
  };

  it.each(operations)("$id: auto v2 refuses before any write, audit or snapshot", async (op) => {
    const f = await fixture(op);
    await h.sql.query("update environments set publish_mode = 'auto' where id = $1", [f.ws]);
    const before = await state(f.ws);
    const res = await f.write();
    expect([res.status, res.body?.code], JSON.stringify(res.body)).toEqual([409, "auto-publish"]);
    expect(res.contentType).toContain("application/problem+json");
    expect(await state(f.ws)).toEqual(before);
    await h.app.get(SnapshotsService).autoPublish(f.ws, 0);
    expect(await state(f.ws)).toEqual(before);
  });

  it.each(operations)("$id: manual v2 changes only the draft and audits once", async (op) => {
    const f = await fixture(op);
    const before = await state(f.ws);
    const res = await f.write();
    expect(res.status, JSON.stringify(res.body)).toBe(f.status);
    const after = await state(f.ws);
    expect(after.entities).not.toEqual(before.entities);
    expect(after.environment).toMatchObject({ publish_mode: "manual", current_version: 1, has_unpublished_changes: true });
    expect(after.audits).toHaveLength(before.audits.length + 1);
    unchangedPublication(before, after);
    await h.app.get(SnapshotsService).autoPublish(f.ws, 0);
    expect(await state(f.ws)).toEqual(after);
  });

  it.each(operations)("$id: v1 in auto mode still publishes the same operation", async (op) => {
    const f = await fixture(op);
    await h.sql.query("update environments set publish_mode = 'auto' where id = $1", [f.ws]);
    const before = await state(f.ws);
    const res = await f.write(true);
    expect(res.status, JSON.stringify(res.body)).toBe(f.status);
    const draft = await state(f.ws);
    expect(draft.entities).not.toEqual(before.entities);
    unchangedPublication(before, draft);
    expect(draft.audits).toHaveLength(before.audits.length + 1);
    await h.app.get(SnapshotsService).autoPublish(f.ws, 0);
    const after = await state(f.ws);
    expect(after.environment).toMatchObject({ current_version: 2, has_unpublished_changes: false });
    expect(after.snapshots).toHaveLength(2);
    expect(after.releases).toEqual(before.releases);
    expect(after.deployments).toEqual(before.deployments);
  });

  it.each(operations)("$id: archived workspace refuses without any transactional effects", async (op) => {
    // Published v1 configurations cannot be archived; retain the seeded entities in an unpublished draft.
    const f = await fixture(op, false);
    const archived = await h.api("POST", `/../v2/workspaces/${f.ws}/archive`);
    expect(archived.status, JSON.stringify(archived.body)).toBe(204);
    const before = await state(f.ws);
    const res = await f.write();
    expect([res.status, res.body?.code], JSON.stringify(res.body)).toEqual([409, "workspace-archived"]);
    expect(res.contentType).toContain("application/problem+json");
    expect(await state(f.ws)).toEqual(before);
  });

  it.each(operations)("$id: viewer without write permission refuses without any transactional effects", async (op) => {
    const f = await fixture(op);
    const before = await state(f.ws);
    expect((await f.write(false, viewer)).status).toBe(403);
    expect(await state(f.ws)).toEqual(before);
  });

  // Only a database-observed wait edge establishes readiness; the polling interval merely yields.
  const waitFor = async (blocker: number, pattern: string) => {
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      const { rows } = await h.sql.query<{ pid: number }>(`select pid from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
          and application_name = $3
          and $1 = any(pg_blocking_pids(pid)) and query ~ $2`, [blocker, pattern, applicationName]);
      if (rows.length === 1) return rows[0]!.pid;
      if (rows.length > 1) throw new Error(`Ambiguous lock wait for ${pattern} behind ${blocker}: ${JSON.stringify(rows)}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const { rows } = await h.sql.query(`select pid, application_name, wait_event_type, wait_event,
      pg_blocking_pids(pid) as blockers, query from pg_stat_activity where datname = current_database()`);
    throw new Error(`No lock wait for ${pattern} behind ${blocker}: ${JSON.stringify(rows)}`);
  };
  const workspaceWait = "pg_advisory_xact_lock\\(hashtextextended";
  const barrier = async (ws: string, run: (pid: number, release: () => Promise<void>, start: <T>(p: Promise<T>) => Promise<T>) => Promise<void>) => {
    const holder = await h.sql.connect();
    const pending: Promise<unknown>[] = [];
    try {
      await holder.query("begin");
      await holder.query("select 1 from environments where id = $1 for update", [ws]);
      const { rows: [backend] } = await holder.query<{ pid: number }>("select pg_backend_pid() as pid");
      await run(backend!.pid, async () => { await holder.query("commit"); }, (p) => {
        pending.push(p);
        void p.catch(() => undefined);
        return p;
      });
    } finally {
      await holder.query("rollback");
      holder.release();
      await Promise.allSettled(pending);
    }
  };
  const noEntityLocks = async (pid: number) => {
    expect((await h.sql.query("select relation::regclass::text from pg_locks where pid = $1 and mode = 'RowExclusiveLock'", [pid])).rows).toEqual([]);
  };
  const auditActions = (before: DraftState, after: DraftState) => after.audits
    .filter((a) => !before.audits.some((b) => b.id === a.id)).map((a) => a.action).sort();
  const actionOf = (op: Operation) => {
    const resource = { Consumer: "consumer", KeyAuth: "keyauth", Jwt: "jwt", BasicAuth: "basicauth", Upstream: "upstream", Target: "target", Certificate: "certificate", Plugin: "plugin" }[op.resource];
    return op.resource === "AclGroups" ? "consumer.acl_groups.replace" : `${resource}.${op.action === "replace" ? "update" : op.action}`;
  };
  const storedMutation = async (op: Operation, f: Awaited<ReturnType<typeof fixture>>, written: ApiResponse<Record<string, unknown> | undefined>) => {
    const id = op.action === "create" ? written.body?.id as string
      : f.path.split("/").at(op.action === "rotate" || op.resource === "AclGroups" ? -2 : -1)!;
    if (op.action === "rotate" || (op.action === "create" && ["KeyAuth", "Jwt"].includes(op.resource))) {
      const keyAuth = op.resource === "KeyAuth";
      const { rows: [row] } = await h.sql.query<{ sealed: string; pending_reprovision: boolean }>(
        `select ${keyAuth ? "key" : "secret"} as sealed, pending_reprovision from ${keyAuth ? "keyauth_credentials" : "jwt_credentials"} where environment_id = $1 and id = $2`, [f.ws, id]);
      expect(row).toBeDefined();
      expect(row!.pending_reprovision).toBe(false);
      const plain = h.app.get<Encryptor>(ENCRYPTOR).open(row!.sealed, keyAuth ? credentialContext(id) : jwtSecretContext(id));
      expect(plain).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(plain).toBe(written.body?.[keyAuth ? "key" : "secret"]);
      if (op.action === "create") {
        const parent = await h.sql.query(`select consumer_id from ${keyAuth ? "keyauth_credentials" : "jwt_credentials"} where id = $1`, [id]);
        expect(parent.rows).toEqual([{ consumer_id: f.path.split("/")[2] }]);
      }
      return;
    }
    const table = { Consumer: "consumers", AclGroups: "consumers", BasicAuth: "basicauth_credentials", Upstream: "upstreams", Target: "targets", Certificate: "certificates", Plugin: "plugins" }[op.resource];
    if (!table) throw new Error(`Missing representative assertion for ${op.id}`);
    const { rows } = await h.sql.query<Record<string, unknown>>(`select * from ${table} where environment_id = $1 and id = $2`, [f.ws, id]);
    if (op.action === "delete") {
      expect(rows).toEqual([]);
      if (op.resource === "Consumer") {
        for (const child of ["keyauth_credentials", "jwt_credentials", "basicauth_credentials", "plugins"]) {
          expect((await h.sql.query(`select id from ${child} where environment_id = $1 and consumer_id = $2`, [f.ws, id])).rows).toEqual([]);
        }
      }
      return;
    }
    expect(rows).toHaveLength(1);
    if (op.resource === "BasicAuth") {
      expect(rows[0]).toMatchObject({ username: f.body?.username, consumer_id: f.path.split("/")[2] });
      const plain = h.app.get<Encryptor>(ENCRYPTOR).open(rows[0]!.password_hash as string, basicAuthHashContext(id));
      expect(plain).toBe(basicAuthPasswordHash(f.path.split("/")[2]!, f.body!.password as string));
      return;
    }
    const expected = {
      Consumer: { username: "after" }, AclGroups: { acl_groups: ["gold"] },
      Upstream: { name: "changed", algorithm: "least-connections" },
      Target: { target: "after.example.com:8081", weight: 5 }, Certificate: { tags: ["changed"] },
    }[op.resource];
    expect(rows[0]).toMatchObject(expected!);
    if (op.resource === "Certificate") {
      const snis = await h.sql.query<{ name: string }>("select name from certificate_snis where environment_id = $1 and certificate_id = $2 order by name", [f.ws, id]);
      expect(snis.rows.map((s) => s.name)).toEqual(f.expectedSnis);
      expect(written.body?.snis).toEqual(f.expectedSnis);
    }
  };

  it.each(representatives)("$id: waits behind publishMode change and refuses the committed auto mode", async (op) => {
    const f = await fixture(op);
    const before = await state(f.ws);
    await barrier(f.ws, async (pid, release, start) => {
      const switching = start(h.api("PATCH", `/environments/${f.ws}`, { name: before.environment.name, publishMode: "auto" }));
      const switcher = await waitFor(pid, 'from "environments".*for update');
      const writing = start(f.write());
      const writer = await waitFor(switcher, workspaceWait);
      await noEntityLocks(writer);
      expect(await state(f.ws)).toEqual(before);
      await release();
      expect((await switching).status).toBe(200);
      const res = await writing;
      expect([res.status, res.body?.code]).toEqual([409, "auto-publish"]);
    });
    const after = await state(f.ws);
    expect(after.entities).toEqual(before.entities);
    expect(after.environment).toMatchObject({ publish_mode: "auto", current_version: 1, has_unpublished_changes: false });
    expect(auditActions(before, after)).toEqual(["environment.update"]);
    unchangedPublication(before, after);
    await h.app.get(SnapshotsService).autoPublish(f.ws, 0);
    expect(await state(f.ws)).toEqual(after);
  });

  it.each(uniquePaths)("$id: eligible auto-publisher yields to the v2 writer, then publishes only the pending v1 edit", async (op) => {
    const f = await fixture(op);
    const enc = h.app.get<Encryptor>(ENCRYPTOR);
    const snapshotState = async (version: number) => {
      const { rows: [row] } = await h.sql.query<{ state: unknown }>("select state from snapshots where environment_id = $1 and version = $2", [f.ws, version]);
      return enc.openJson<GatewayState>(row!.state, snapshotContext(f.ws, version, "state"));
    };
    const initial = await snapshotState(1);
    const service = await h.api<{ items: { id: string }[] }>("GET", `/environments/${f.ws}/services`);
    expect(service.status).toBe(200);
    expect((await h.api("PATCH", `/environments/${f.ws}`, { name: (await state(f.ws)).environment.name, publishMode: "auto" })).status).toBe(200);
    expect((await h.api("PUT", `/environments/${f.ws}/services/${service.body.items[0]!.id}`, {
      name: "svc", protocol: "http", host: "pending-v1.example.com", port: 80,
    })).status).toBe(200);
    const before = await state(f.ws);
    expect(before.environment).toMatchObject({ publish_mode: "auto", current_version: 1, has_unpublished_changes: true, draft_requires_publish: false });
    const tables = op.resource === "Consumer" ? ["basicauth_credentials", "jwt_credentials", "keyauth_credentials"]
      : [{ KeyAuth: "keyauth_credentials", Jwt: "jwt_credentials", BasicAuth: "basicauth_credentials" }[op.resource]!];
    const holder = await h.sql.connect();
    let writing: ReturnType<typeof f.write> | undefined;
    try {
      await holder.query("begin");
      // SHARE blocks the writer's table lock, while allowing every SELECT needed to publish the committed v1 draft.
      await holder.query(`lock table ${tables.join(", ")} in share mode`);
      const { rows: [backend] } = await holder.query<{ pid: number }>("select pg_backend_pid() as pid");
      writing = f.write();
      void writing.catch(() => undefined);
      const writer = await waitFor(backend!.pid, "lock table");
      expect((await h.sql.query("select mode from pg_locks where pid = $1 and locktype = 'advisory' and objsubid = 1 and granted", [writer])).rows)
        .toEqual([{ mode: "ExclusiveLock" }]);
      // No environment row lock can make SKIP LOCKED hide this eligible draft: only the workspace lock excludes it.
      expect((await h.sql.query("select mode from pg_locks where pid = $1 and relation = 'environments'::regclass", [writer])).rows).toEqual([]);
      expect(await h.app.get(SnapshotsService).autoPublish(f.ws, 0)).toBe(true);
      expect(await state(f.ws)).toEqual(before);
      // The writer is still waiting at the same real lock after the publisher has yielded.
      expect(await waitFor(backend!.pid, "lock table")).toBe(writer);
      await holder.query("commit");
      const refused = await writing;
      expect([refused.status, refused.body?.code]).toEqual([409, "auto-publish"]);
      expect(await state(f.ws)).toEqual(before);
    } finally {
      await holder.query("rollback");
      holder.release();
      if (writing) await Promise.allSettled([writing]);
    }
    // Positive control: with the workspace free, the identical eligible draft really produces a new snapshot.
    expect(await h.app.get(SnapshotsService).autoPublish(f.ws, 0)).toBe(true);
    const after = await state(f.ws);
    expect(after.environment).toMatchObject({ current_version: 2, has_unpublished_changes: false });
    expect(after.snapshots).toHaveLength(2);
    expect(after.snapshots[0]).toEqual(before.snapshots[0]);
    expect(after.snapshots[1]!.hash).not.toBe(before.snapshots[0]!.hash);
    expect(after.entities).toEqual(before.entities);
    expect(after.releases).toEqual(before.releases);
    expect(after.deployments).toEqual(before.deployments);
    expect(auditActions(before, after)).toEqual(["snapshot.publish"]);
    expect(await snapshotState(2)).toEqual({
      ...initial, services: initial.services.map((s) => ({ ...s, host: "pending-v1.example.com" })),
    });
    expect(await h.app.get(SnapshotsService).autoPublish(f.ws, 0)).toBe(true);
    expect(await state(f.ws)).toEqual(after);
  });

  it.each(representatives)("$id: holds the workspace from manual check through commit before publishMode can change", async (op) => {
    const f = await fixture(op);
    const before = await state(f.ws);
    // Pause after the resource write and dirty mark, at its audit insert, to detect early lock release.
    await h.sql.query(`create function ws_r4_pause_resource() returns trigger language plpgsql as $$
      begin perform pg_advisory_xact_lock(228, hashtext(TG_ARGV[0])); return NEW; end $$`);
    await h.sql.query(`create trigger ws_r4_pause_resource before insert on audit_events for each row
      when (NEW.environment_id = '${f.ws}'::uuid and NEW.action = '${actionOf(op)}')
      execute function ws_r4_pause_resource('${f.ws}')`);
    const holder = await h.sql.connect();
    const pending: Promise<unknown>[] = [];
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(228, hashtext($1))", [f.ws]);
      const { rows: [backend] } = await holder.query<{ pid: number }>("select pg_backend_pid() as pid");
      const writing = f.write();
      pending.push(writing);
      const writer = await waitFor(backend!.pid, 'insert into "audit_events"');
      const switching = h.api("PATCH", `/environments/${f.ws}`, { name: before.environment.name, publishMode: "auto" });
      pending.push(switching);
      const switcher = await waitFor(writer, workspaceWait);
      await noEntityLocks(switcher);
      expect(await state(f.ws)).toEqual(before);
      await holder.query("commit");
      const written = await writing;
      expect(written.status).toBe(f.status);
      expect((await switching).status).toBe(200);
      await storedMutation(op, f, written);
    } finally {
      await holder.query("rollback");
      holder.release();
      await Promise.allSettled(pending);
      await h.sql.query("drop function ws_r4_pause_resource() cascade");
    }
    const after = await state(f.ws);
    expect(after.entities).not.toEqual(before.entities);
    expect(after.environment).toMatchObject({ publish_mode: "auto", current_version: 1, has_unpublished_changes: true });
    expect(auditActions(before, after)).toEqual([actionOf(op), "environment.update"].sort());
    unchangedPublication(before, after);
  });

  it.each(representatives)("$id: serializes behind import with exactly one resource audit and no publication", async (op) => {
    const f = await fixture(op);
    const exported = await h.api<ConfigDocument>("GET", `/environments/${f.ws}/export?format=json`);
    expect(exported.status).toBe(200);
    exported.body.services[0]!.host = "imported.example.com";
    const before = await state(f.ws);
    await barrier(f.ws, async (pid, release, start) => {
      const importing = start(h.api("POST", `/environments/${f.ws}/import`, { mode: "replace", dryRun: false, document: exported.body }));
      const importer = await waitFor(pid, 'from "environments".*for update');
      const writing = start(f.write());
      const writer = await waitFor(importer, workspaceWait);
      await noEntityLocks(writer);
      await release();
      const imported = await importing;
      expect(imported.status, JSON.stringify(imported.body)).toBe(200);
      const written = await writing;
      expect(written.status, JSON.stringify(written.body)).toBe(f.status);
      await storedMutation(op, f, written);
    });
    const after = await state(f.ws);
    expect(after.environment).toMatchObject({ publish_mode: "manual", current_version: 1, has_unpublished_changes: true });
    expect(auditActions(before, after)).toEqual([actionOf(op), "environment.import"].sort());
    expect((await h.sql.query("select host from services where environment_id = $1", [f.ws])).rows).toEqual([{ host: "imported.example.com" }]);
    unchangedPublication(before, after);
    await h.app.get(SnapshotsService).autoPublish(f.ws, 0);
    expect(await state(f.ws)).toEqual(after);
  });

  it.each(representatives)("$id: serializes behind rollback with only the requested rollback snapshot", async (op) => {
    const f = await fixture(op);
    const service = await h.api("GET", `/environments/${f.ws}/services`);
    expect(service.status).toBe(200);
    expect((await h.api("PUT", `/environments/${f.ws}/services/${service.body.items[0].id}`, { name: "svc", protocol: "http", host: "later.example.com", port: 80 })).status).toBe(200);
    expect((await h.api("POST", `/environments/${f.ws}/snapshots`, {})).status).toBe(201);
    const before = await state(f.ws);
    await barrier(f.ws, async (pid, release, start) => {
      const restoring = start(h.api("POST", `/environments/${f.ws}/snapshots/1/rollback`));
      const rollback = await waitFor(pid, 'from "environments".*for update');
      const writing = start(f.write());
      const writer = await waitFor(rollback, workspaceWait);
      await noEntityLocks(writer);
      await release();
      const restored = await restoring;
      expect(restored.status, JSON.stringify(restored.body)).toBe(201);
      const written = await writing;
      expect(written.status, JSON.stringify(written.body)).toBe(f.status);
      await storedMutation(op, f, written);
    });
    const after = await state(f.ws);
    expect(after.environment).toMatchObject({ publish_mode: "manual", current_version: 3, has_unpublished_changes: true });
    expect(auditActions(before, after)).toEqual([actionOf(op), "snapshot.rollback"].sort());
    expect(after.snapshots.slice(0, 2)).toEqual(before.snapshots);
    expect(after.snapshots).toHaveLength(3);
    expect(after.snapshots[2]).toMatchObject({ version: 3, rollback_of: 1, hash: before.snapshots[0]!.hash });
    expect(after.releases).toEqual(before.releases);
    expect(after.deployments).toEqual(before.deployments);
    expect((await h.sql.query("select host from services where environment_id = $1", [f.ws])).rows).toEqual([{ host: "draft.example.com" }]);
    await h.app.get(SnapshotsService).autoPublish(f.ws, 0);
    expect(await state(f.ws)).toEqual(after);
  });
});
