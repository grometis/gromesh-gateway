import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { jcs } from "@gromesh/compiler";
import { contractsV2 } from "../../src/common/contract.js";
import { AtRestService } from "../../src/crypto/at-rest.js";
import { deploymentContext, Encryptor, releaseContext } from "../../src/crypto/crypto.js";
import { runMigrations } from "../../src/db/migrate.js";
import { ENCRYPTION_KEYS, startHarness, uniq, type ApiClient, type Harness } from "./harness.js";

// N3-C3: publishRelease freezes a workspace draft into an immutable release (it deploys nothing, decision D4), and
// createDeployment composes every active release into the instance's next revision through the compiler, with its
// configHash and the Kong hash of the bytes the agents will post (N3-K1). Off unless a laboratory turns Workspaces
// deployments on; dev only; one lease for the instance.
type Doc = Record<string, any>;
// Several harnesses and migrated databases per file: generous limits on a busy machine.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });
const v2 = parse(readFileSync(new URL("../../../../contracts/control-plane-v2.openapi.yaml", import.meta.url), "utf8")) as Doc;
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://gromesh:gromesh@127.0.0.1:5432/gromesh";
const created: string[] = [];
const LAB = { stage: "dev" as const, convergenceDeadlineMs: 600_000 };

/** The instance row and the deployments are instance-wide: each case group gets its own migrated database. */
async function freshDatabase(label: string): Promise<string> {
  const name = `gromesh_n3c3_${label}_${Date.now()}_${process.pid}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  created.push(name);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  await runMigrations(url.toString());
  return url.toString();
}

afterAll(async () => {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  for (const name of created) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.end();
});

const RELEASE = contractsV2.validator("#/components/schemas/Release");
const DEPLOYMENT = contractsV2.validator("#/components/schemas/Deployment");
const v2api = (client: ApiClient, method: string, path: string, body?: unknown) => client(method, `/../v2${path}`, body);
const deploy = (client: ApiClient, expectedRevision: number | null) => v2api(client, "POST", "/deployments", { expectedRevision, reason: "laboratory deployment" });

async function workspace(h: Harness, withConsumer = false) {
  const id = (await h.api("POST", "/environments", { name: uniq("ws") })).body.id as string;
  const svc = (await h.api("POST", `/environments/${id}/services`, { name: uniq("svc"), protocol: "http", host: "echo", port: 80 })).body.id as string;
  expect((await h.api("POST", `/environments/${id}/routes`, { name: uniq("route"), serviceId: svc, paths: ["/echo"] })).status).toBe(201);
  if (withConsumer) {
    const consumer = (await h.api("POST", `/environments/${id}/consumers`, { username: uniq("app") })).body.id as string;
    expect((await h.api("POST", `/environments/${id}/consumers/${consumer}/key-auth`, {})).status).toBe(201);
  }
  return id;
}

async function deploymentRows(h: Harness) {
  return (await h.sql.query(`select epoch, revision, members, expected_nodes, config, config_hash, kong_config_hash from deployments order by revision`)).rows;
}
const latestRevision = async (h: Harness) => ((await deploymentRows(h)).at(-1)?.revision as number | undefined) ?? null;

const MACHINE = v2.components.schemas.DeploymentState["x-gromesh-transitions"] as { initial: string[]; transitions: [string, string, string][] };
const EDGES = new Set(MACHINE.transitions.map(([from, to]) => `${from}>${to}`));
/** Every recorded history starts in an initial state and moves only along the contract's edges. */
async function expectContractHistories(h: Harness) {
  const rows = (await h.sql.query(`select revision, state from deployment_states where epoch = 1 order by revision, seq`)).rows as { revision: number; state: string }[];
  const byRevision = new Map<number, string[]>();
  for (const r of rows) byRevision.set(r.revision, [...(byRevision.get(r.revision) ?? []), r.state]);
  expect(byRevision.size).toBeGreaterThan(0);
  for (const [revision, history] of byRevision) {
    expect(MACHINE.initial, `revision ${revision}`).toContain(history[0]);
    for (let i = 1; i < history.length; i++) expect(EDGES.has(`${history[i - 1]}>${history[i]}`), `revision ${revision}: ${history.join(" > ")}`).toBe(true);
  }
}
async function states(h: Harness, revision: number) {
  return (await h.sql.query(`select state from deployment_states where epoch = 1 and revision = $1 order by seq`, [revision])).rows.map((r) => r.state as string);
}

/** Waits until some other session of `url` waits on a lock (the request under test reached its lock). */
async function untilLockWait(url: string) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    for (let i = 0; i < 300; i++) {
      const { rows } = await c.query(`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`);
      if (rows[0].n > 0) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("no session ever waited on a lock");
  } finally {
    await c.end();
  }
}

describe("Workspaces deployments are off by default (D4, N3-K1)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ databaseUrl: await freshDatabase("off") });
  });
  afterAll(async () => h?.close());

  it("answers 409 workspaces-mode-disabled to publishing and deploying, lists nothing and writes nothing", async () => {
    const ws = await workspace(h);
    for (const res of [await v2api(h.api, "POST", `/workspaces/${ws}/releases`, {}), await deploy(h.api, null)]) {
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ status: 409, code: "workspaces-mode-disabled", type: "https://gromesh.dev/problems/workspaces-mode-disabled" });
    }
    expect((await v2api(h.api, "GET", `/workspaces/${ws}/releases`)).body).toEqual([]);
    for (const table of ["instance", "releases", "deployments", "deployment_states", "workspace_active_release"]) {
      expect((await h.sql.query(`select count(*)::int as n from ${table}`)).rows[0].n, table).toBe(0);
    }
  });
});

describe("releases and deployments in a laboratory on dev", () => {
  let h: Harness;
  let url: string;
  let enc: Encryptor;
  beforeAll(async () => {
    url = await freshDatabase("lab");
    h = await startHarness({ databaseUrl: url, workspacesDeployments: LAB });
    enc = Encryptor.fromConfig({ writeKey: ENCRYPTION_KEYS.k1, readKeys: [ENCRYPTION_KEYS.k2], fingerprintKey: ENCRYPTION_KEYS.fingerprint });
  });
  afterAll(async () => h?.close());

  it("publishRelease freezes the draft into release 1 without credentials and deploys nothing", async () => {
    // Nothing published yet: nothing to deploy.
    expect((await deploy(h.api, null)).status).toBe(422);
    const ws = await workspace(h, true);
    const res = await v2api(h.api, "POST", `/workspaces/${ws}/releases`, { message: "first" });
    expect(res.status).toBe(201);
    expect(RELEASE(structuredClone(res.body)), JSON.stringify(RELEASE.errors)).toBe(true);
    expect(res.body).toMatchObject({ workspaceId: ws, version: 1, origin: "local", contentOriginVersion: 1, contentFirstActivatedAt: null, originPromotionId: null, contentRevoked: false, message: "first" });
    expect((await h.sql.query(`select id, stage from instance`)).rows).toEqual([{ id: expect.any(String), stage: "dev" }]);
    // D4: a release is not a deployment.
    expect(await deploymentRows(h)).toEqual([]);
    expect((await h.sql.query(`select version, deployment_revision from workspace_active_release where workspace_id = $1`, [ws])).rows).toEqual([{ version: 1, deployment_revision: null }]);
    expect((await h.sql.query(`select slug_locked_at from workspaces where id = $1`, [ws])).rows[0].slug_locked_at).not.toBeNull();
    expect((await h.sql.query(`select entity_id from audit_events where action = 'release.publish'`)).rows).toEqual([{ entity_id: `${ws}:1` }]);
    // D5: the v1 publication state of the environment is untouched.
    expect((await h.sql.query(`select current_version, has_unpublished_changes from environments where id = $1`, [ws])).rows[0]).toEqual({ current_version: null, has_unpublished_changes: true });

    // A credential is a value of the instance, not content: a new one leaves the draft equal to the release.
    const sealed = (await h.sql.query(`select content from releases where workspace_id = $1 and version = 1`, [ws])).rows[0].content;
    expect(enc.openJson<Doc>(sealed, releaseContext(ws, 1)).keyAuthCredentials).toEqual([]);
    const consumer = (await h.sql.query(`select id from consumers where environment_id = $1`, [ws])).rows[0].id;
    expect((await h.api("POST", `/environments/${ws}/consumers/${consumer}/key-auth`, {})).status).toBe(201);
    expect((await v2api(h.api, "POST", `/workspaces/${ws}/releases`, {})).status).toBe(409);
    expect((await v2api(h.api, "GET", `/workspaces/${ws}/releases`)).body.map((r: Doc) => r.version)).toEqual([1]);
  });

  it("createDeployment composes every active release through the compiler, with the Kong hash of its JCS bytes", async () => {
    const res = await deploy(h.api, null);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(DEPLOYMENT(structuredClone(res.body)), JSON.stringify(DEPLOYMENT.errors)).toBe(true);
    const [dep] = await deploymentRows(h);
    const ws = (await h.sql.query(`select workspace_id from workspace_active_release`)).rows[0].workspace_id;
    const config = enc.openJson<Doc>(dep.config, deploymentContext(1, dep.revision));
    expect(res.body).toMatchObject({ epoch: 1, revision: dep.revision, state: "active", configHash: dep.config_hash, convergence: "no-nodes", members: [{ workspaceId: ws, releaseVersion: 1 }] });
    expect(res.body.kongConfigHash).toBe(createHash("md5").update(jcs(config), "utf8").digest("hex"));
    expect(dep.kong_config_hash).toBe(res.body.kongConfigHash);
    expect(dep.expected_nodes).toEqual([]);
    // No expected node (no v2 cluster): it stays active, never converged by itself, and holds no lease (D-1).
    expect(await states(h, dep.revision)).toEqual(["composed", "active"]);
    expect((await h.sql.query(`select revision from deployment_lease`)).rows[0].revision).toBeNull();
    expect((await h.sql.query(`select deployment_revision from workspace_active_release`)).rows[0].deployment_revision).toBe(dep.revision);
    // No node applied it: never activated.
    expect((await h.sql.query(`select count(*)::int as n from content_activations`)).rows[0].n).toBe(0);
    // The compiler's composition: guard canary, workspace prefix, the consumer's current credentials (values).
    const slug = (await h.sql.query(`select slug from workspaces where id = $1`, [ws])).rows[0].slug;
    expect(config.routes.map((r: Doc) => r.paths).flat()).toEqual(expect.arrayContaining(["/.gromesh/guard/current", `/${slug}/echo`]));
    expect(config.keyauth_credentials).toHaveLength(2);
    const audit = (await h.sql.query(`select entity_id, after from audit_events where action = 'deployment.create'`)).rows;
    expect(audit).toEqual([expect.objectContaining({ entity_id: `1:${dep.revision}` })]);
    for (const k of config.keyauth_credentials) expect(JSON.stringify(audit)).not.toContain(k.key);
    // expectedRevision guards a concurrent deployment.
    expect((await deploy(h.api, null)).status).toBe(409);
  });

  it("refuses an unchanged draft, a stale expectedActiveVersion and a draft that does not compose on its own", async () => {
    const ws = await workspace(h);
    expect((await v2api(h.api, "POST", `/workspaces/${ws}/releases`, {})).status).toBe(201);
    expect((await v2api(h.api, "POST", `/workspaces/${ws}/releases`, {})).status).toBe(409);
    await h.api("POST", `/environments/${ws}/services`, { name: uniq("svc"), protocol: "http", host: "echo2", port: 80 });
    expect((await v2api(h.api, "POST", `/workspaces/${ws}/releases`, { expectedActiveVersion: null })).status).toBe(409);
    expect((await v2api(h.api, "POST", `/workspaces/${ws}/releases`, { expectedActiveVersion: 1 })).status).toBe(201);
    // A route without a path cannot be prefixed (N1-C2): refused at publish, nothing recorded.
    const svc = (await h.api("POST", `/environments/${ws}/services`, { name: uniq("svc"), protocol: "http", host: "echo", port: 80 })).body.id;
    expect((await h.api("POST", `/environments/${ws}/routes`, { name: uniq("route"), serviceId: svc, hosts: ["x.example"] })).status).toBe(201);
    const refused = await v2api(h.api, "POST", `/workspaces/${ws}/releases`, {});
    expect(refused.status).toBe(422);
    expect(refused.body.errors.some((e: Doc) => String(e.path).endsWith(".paths"))).toBe(true);
    expect((await h.sql.query(`select max(version)::int as v from releases where workspace_id = $1`, [ws])).rows[0].v).toBe(2);
  });

  it("keeps every other workspace's member when one publishes: changing A never changes B's digest", async () => {
    const a = await workspace(h);
    const b = await workspace(h);
    const ra = (await v2api(h.api, "POST", `/workspaces/${a}/releases`, {})).body;
    const rb = (await v2api(h.api, "POST", `/workspaces/${b}/releases`, {})).body;
    expect((await deploy(h.api, await latestRevision(h))).status).toBe(201);
    await h.api("POST", `/environments/${a}/services`, { name: uniq("svc"), protocol: "http", host: "echo3", port: 80 });
    const ra2 = (await v2api(h.api, "POST", `/workspaces/${a}/releases`, {})).body;
    expect(ra2.contentDigest).not.toBe(ra.contentDigest);
    expect((await deploy(h.api, await latestRevision(h))).status).toBe(201);
    const [prev, last] = (await deploymentRows(h)).slice(-2);
    const member = (rows: Doc[], ws: string) => rows.find((m) => m.workspaceId === ws);
    expect(member(prev.members, b)).toEqual({ workspaceId: b, releaseVersion: 1, contentDigest: rb.contentDigest });
    expect(member(last.members, b)).toEqual(member(prev.members, b));
    expect(member(last.members, a)).toEqual({ workspaceId: a, releaseVersion: 2, contentDigest: ra2.contentDigest });
    expect(last.revision).toBe(prev.revision + 1);
    // Never had an expected node: closed through the contract's edges (nothing applied), then superseded.
    expect(await states(h, prev.revision)).toEqual(["composed", "active", "converging", "degraded", "superseded"]);
  });

  it("returns 409 while another deployment holds the lease, and fails that deployment once its deadline passed", async () => {
    const ws = await workspace(h);
    // A deployment still converging (as one with expected nodes would be), holding the lease.
    const [last] = (await deploymentRows(h)).slice(-1);
    const held = last.revision + 1;
    const config = enc.sealJson(enc.openJson(last.config, deploymentContext(1, last.revision)), deploymentContext(1, held));
    await h.sql.query(
      `insert into deployments (epoch, revision, members, expected_nodes, config, config_hash, kong_config_hash, reason, created_by)
       select epoch, $1, members, '[{"clusterId":"00000000-0000-4000-8000-000000000001","nodeId":"n1"}]', $3, config_hash, kong_config_hash, 'publish', created_by from deployments where revision = $2`,
      [held, last.revision, JSON.stringify(config)],
    );
    await h.sql.query(`insert into deployment_states (epoch, revision, seq, state, reason) values (1, $1, 1, 'composed', 't'), (1, $1, 2, 'active', 't'), (1, $1, 3, 'converging', 't')`, [held]);
    await h.sql.query(`update deployment_lease set revision = $1, operation = 'deploy', started_at = now(), deadline_at = now() + interval '1 hour'`, [held]);
    expect((await v2api(h.api, "POST", `/workspaces/${ws}/releases`, {})).status).toBe(409);
    expect((await deploy(h.api, held)).status).toBe(409);
    expect((await h.sql.query(`select count(*)::int as n from releases where workspace_id = $1`, [ws])).rows[0].n).toBe(0);

    await h.sql.query(`update deployment_lease set deadline_at = now() - interval '1 second'`);
    expect((await deploy(h.api, held)).status).toBe(201);
    expect(await states(h, held)).toEqual(["composed", "active", "converging", "degraded", "failed", "superseded"]);
    expect((await h.sql.query(`select revision from deployment_lease`)).rows[0].revision).toBeNull();
    await expectContractHistories(h);
  });

  it("reads the draft as one committed state: a publish waits for an edit in flight and freezes all of it", async () => {
    const ws = await workspace(h);
    const edit = new pg.Client({ connectionString: url });
    await edit.connect();
    try {
      await edit.query("begin");
      // An edit in flight: one more service, and the draft mark every mutation writes in its transaction.
      await edit.query(
        `insert into services (id, environment_id, name, protocol, host, port, tags) select gen_random_uuid(), environment_id, name || '-2', protocol, 'echo-late', port, tags from services where environment_id = $1`,
        [ws],
      );
      await edit.query(`update environments set has_unpublished_changes = true, draft_changed_at = now() where id = $1`, [ws]);
      let settled = false;
      const publish = v2api(h.api, "POST", `/workspaces/${ws}/releases`, {}).finally(() => (settled = true));
      await untilLockWait(url);
      expect(settled).toBe(false);
      await edit.query("commit");
      expect((await publish).status).toBe(201);
    } finally {
      await edit.end();
    }
    const sealed = (await h.sql.query(`select content from releases where workspace_id = $1 and version = 1`, [ws])).rows[0].content;
    expect(enc.openJson<Doc>(sealed, releaseContext(ws, 1)).services.map((s: Doc) => s.host).sort()).toEqual(["echo", "echo-late"]);
  });

  it("takes the environment lock before the workspace's, as an environment's deletion does: no deadlock", async () => {
    const ws = await workspace(h);
    const other = new pg.Client({ connectionString: url });
    await other.connect();
    try {
      await other.query("begin");
      await other.query(`select id from environments where id = $1 for update`, [ws]);
      const publish = v2api(h.api, "POST", `/workspaces/${ws}/releases`, {});
      await untilLockWait(url);
      // The cascade of a deletion takes the workspace row next: with the inverse order this is a deadlock (40P01).
      await other.query(`select id from workspaces where id = $1 for update`, [ws]);
      await other.query("rollback");
      expect((await publish).status).toBe(201);
    } finally {
      await other.end();
    }
  });

  it("serializes two replicas: concurrent publishes both land, concurrent deployments of one revision only once", async () => {
    const replica = await startHarness({ databaseUrl: url, workspacesDeployments: LAB });
    try {
      const [a, b] = [await workspace(h), await workspace(h)];
      const published = await Promise.all([v2api(h.api, "POST", `/workspaces/${a}/releases`, {}), v2api(replica.api, "POST", `/workspaces/${b}/releases`, {})]);
      expect(published.map((r) => r.status)).toEqual([201, 201]);
      const before = (await deploymentRows(h)).at(-1)!;
      const deployed = await Promise.all([deploy(h.api, before.revision), deploy(replica.api, before.revision)]);
      expect(deployed.map((r) => r.status).sort()).toEqual([201, 409]);
      const last = (await deploymentRows(h)).at(-1)!;
      expect(last.revision).toBe(before.revision + 1);
      // Every member of the revision before is still there with the same version and digest, plus both new ones.
      for (const m of before.members as Doc[]) expect(last.members).toContainEqual(m);
      expect((last.members as Doc[]).map((m) => m.workspaceId)).toEqual(expect.arrayContaining([a, b]));
      // Exactly the active releases: the members composed before, the ones published since, a and b.
      expect(last.members).toHaveLength((await h.sql.query(`select count(*)::int as n from workspace_active_release`)).rows[0].n);
      await expectContractHistories(h);
    } finally {
      await replica.close();
    }
  });

  it("follows the contract's permissions: release.publish in the workspace to publish, in the instance to deploy", async () => {
    const ws = await workspace(h);
    const viewer = await h.as("viewer");
    expect((await v2api(viewer.api, "GET", `/workspaces/${ws}/releases`)).status).toBe(200);
    expect((await v2api(viewer.api, "POST", `/workspaces/${ws}/releases`, {})).status).toBe(403);
    expect((await deploy(viewer.api, await latestRevision(h))).status).toBe(403);
    const editor = await h.as("editor");
    expect((await v2api(editor.api, "POST", `/workspaces/${ws}/releases`, {})).status).toBe(201);
    expect((await deploy(editor.api, await latestRevision(h))).status).toBe(201);
    expect((await v2api(h.api, "GET", `/workspaces/00000000-0000-4000-8000-000000000999/releases`)).status).toBe(404);
    expect(v2.paths["/deployments"].post["x-scope"]).toBe("instance");
  });

  it("re-seals releases and deployments on key rotation, and nothing else of them changes", async () => {
    const before = (await h.sql.query(`select workspace_id, version, content_digest, content->>'$enc' as sealed from releases order by 1, 2`)).rows;
    const deployments = (await deploymentRows(h)).length;
    const rotating = await startHarness({ databaseUrl: url, workspacesDeployments: LAB, encryption: { writeKey: ENCRYPTION_KEYS.k2, readKeys: [ENCRYPTION_KEYS.k1], fingerprintKey: ENCRYPTION_KEYS.fingerprint } });
    try {
      let report = await rotating.app.get(AtRestService).rotate();
      for (let i = 0; report.skipped && i < 50; i++) {
        await new Promise((r) => setTimeout(r, 100));
        report = await rotating.app.get(AtRestService).rotate();
      }
      expect(report.releases).toBe(before.length);
      expect(report.deployments).toBe(deployments);
    } finally {
      await rotating.close();
    }
    const after = (await h.sql.query(`select workspace_id, version, content_digest, content->>'$enc' as sealed from releases order by 1, 2`)).rows;
    expect(after.map((r) => [r.workspace_id, r.version, r.content_digest])).toEqual(before.map((r) => [r.workspace_id, r.version, r.content_digest]));
    after.forEach((r, i) => expect(r.sealed).not.toBe(before[i].sealed));
    // Only k2 now: publishing and deploying still open every active release.
    const k2only = await startHarness({ databaseUrl: url, workspacesDeployments: LAB, encryption: { writeKey: ENCRYPTION_KEYS.k2, readKeys: [], fingerprintKey: ENCRYPTION_KEYS.fingerprint } });
    try {
      expect((await v2api(k2only.api, "POST", `/workspaces/${await workspace(k2only)}/releases`, {})).status).toBe(201);
      expect((await deploy(k2only.api, await latestRevision(h))).status).toBe(201);
    } finally {
      await k2only.close();
    }
  });

  it("keeps the instance identity, releases, deployments and their transitions immutable", async () => {
    for (const statement of [
      `update instance set stage = 'prd'`,
      `delete from instance`,
      `update deployment_states set state = 'failed'`,
      `delete from deployment_states`,
      `update releases set message = 'x'`,
      `delete from releases`,
      `update deployments set kong_config_hash = kong_config_hash`,
      // The re-seal flag lets only the sealed column change.
      `begin; set local gromesh.reseal = 'on'; update releases set message = 'x'; commit`,
      `begin; set local gromesh.reseal = 'on'; delete from deployments; commit`,
    ]) {
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      try {
        await expect(client.query(statement), statement).rejects.toMatchObject({ code: "55000" });
      } finally {
        await client.end();
      }
    }
  });
});

describe("publishing and deploying outside dev", () => {
  it("answers 403 on hml and refuses a configured stage different from the instance's", async () => {
    const url = await freshDatabase("stage");
    const hml = await startHarness({ databaseUrl: url, workspacesDeployments: { ...LAB, stage: "hml" } });
    try {
      const ws = await workspace(hml);
      expect((await v2api(hml.api, "POST", `/workspaces/${ws}/releases`, {})).status).toBe(403);
      expect((await deploy(hml.api, null)).status).toBe(403);
    } finally {
      await hml.close();
    }
    // The 403 rolled back: no instance yet. Created on dev, it stays dev.
    const dev = await startHarness({ databaseUrl: url, workspacesDeployments: LAB });
    try {
      expect((await v2api(dev.api, "POST", `/workspaces/${await workspace(dev)}/releases`, {})).status).toBe(201);
    } finally {
      await dev.close();
    }
    const prd = await startHarness({ databaseUrl: url, workspacesDeployments: { ...LAB, stage: "prd" } });
    try {
      expect((await v2api(prd.api, "POST", `/workspaces/${await workspace(prd)}/releases`, {})).status).toBe(409);
      expect((await prd.sql.query(`select stage from instance`)).rows).toEqual([{ stage: "dev" }]);
    } finally {
      await prd.close();
    }
  });
});
