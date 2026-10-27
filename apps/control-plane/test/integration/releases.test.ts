import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { contractsV2 } from "../../src/common/contract.js";
import { deploymentContext, Encryptor, releaseContext } from "../../src/crypto/crypto.js";
import { runMigrations } from "../../src/db/migrate.js";
import { ENCRYPTION_KEYS, startHarness, uniq, type ApiClient, type Harness } from "./harness.js";

// N3-C3: publishRelease freezes a workspace draft into an immutable release and composes the instance's next deployment
// revision through the compiler. Off unless a laboratory turns Workspaces deployments on (D4); dev only; one lease.
type Doc = Record<string, any>;
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
const v2api = (client: ApiClient, method: string, path: string, body?: unknown) => client(method, `/../v2${path}`, body);

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
  return (await h.sql.query(`select epoch, revision, members, expected_nodes, config, config_hash from deployments order by revision`)).rows;
}
async function states(h: Harness, revision: number) {
  return (await h.sql.query(`select state from deployment_states where epoch = 1 and revision = $1 order by seq`, [revision])).rows.map((r) => r.state as string);
}

describe("publishRelease is off by default (D4)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ databaseUrl: await freshDatabase("off") });
  });
  afterAll(async () => h?.close());

  it("answers 403 to publishing and listing and writes nothing", async () => {
    const ws = await workspace(h);
    expect((await v2api(h.api, "POST", `/workspaces/${ws}/releases`, {})).status).toBe(403);
    expect((await v2api(h.api, "GET", `/workspaces/${ws}/releases`)).status).toBe(403);
    for (const table of ["instance", "releases", "deployments", "deployment_states"]) {
      expect((await h.sql.query(`select count(*)::int as n from ${table}`)).rows[0].n, table).toBe(0);
    }
  });
});

describe("publishRelease in a laboratory on dev", () => {
  let h: Harness;
  let enc: Encryptor;
  beforeAll(async () => {
    h = await startHarness({ databaseUrl: await freshDatabase("lab"), workspacesDeployments: LAB });
    enc = Encryptor.fromConfig({ writeKey: ENCRYPTION_KEYS.k1, readKeys: [ENCRYPTION_KEYS.k2], fingerprintKey: ENCRYPTION_KEYS.fingerprint });
  });
  afterAll(async () => h?.close());

  it("freezes the draft into release 1 and composes a revision with no expected node, converged and lease free", async () => {
    const ws = await workspace(h, true);
    const res = await v2api(h.api, "POST", `/workspaces/${ws}/releases`, { message: "first" });
    expect(res.status).toBe(201);
    expect(RELEASE(structuredClone(res.body)), JSON.stringify(RELEASE.errors)).toBe(true);
    expect(res.body).toMatchObject({ workspaceId: ws, version: 1, origin: "local", contentOriginVersion: 1, contentFirstActivatedAt: null, originPromotionId: null, contentRevoked: false, message: "first" });

    const instance = (await h.sql.query(`select id, stage from instance`)).rows;
    expect(instance).toEqual([{ id: expect.any(String), stage: "dev" }]);
    const [dep] = (await deploymentRows(h)).slice(-1);
    expect(dep.expected_nodes).toEqual([]);
    expect(dep.members).toEqual([{ workspaceId: ws, releaseVersion: 1, contentDigest: res.body.contentDigest }]);
    expect(await states(h, dep.revision)).toEqual(["composed", "active", "converged"]);
    expect((await h.sql.query(`select revision from deployment_lease`)).rows[0].revision).toBeNull();
    expect((await h.sql.query(`select version, deployment_revision from workspace_active_release where workspace_id = $1`, [ws])).rows).toEqual([{ version: 1, deployment_revision: dep.revision }]);
    // Never activated: no node applied it.
    expect((await h.sql.query(`select count(*)::int as n from content_activations`)).rows[0].n).toBe(0);
    expect((await h.sql.query(`select slug_locked_at from workspaces where id = $1`, [ws])).rows[0].slug_locked_at).not.toBeNull();

    // The composed config comes from the compiler: the guard canary, the workspace prefix and the consumer's credential.
    const config = enc.openJson<Doc>(dep.config, deploymentContext(dep.epoch, dep.revision));
    const slug = (await h.sql.query(`select slug from workspaces where id = $1`, [ws])).rows[0].slug;
    expect(config.routes.map((r: Doc) => r.paths).flat()).toEqual(expect.arrayContaining(["/.gromesh/guard/current", `/${slug}/echo`]));
    expect(config.keyauth_credentials).toHaveLength(1);

    const audit = (await h.sql.query(`select action, entity_id, after from audit_events where action = 'release.publish'`)).rows;
    expect(audit).toEqual([expect.objectContaining({ entity_id: `${ws}:1` })]);
    // A credential is a value of the instance, never part of the release nor of its audit.
    expect(JSON.stringify(audit)).not.toContain(config.keyauth_credentials[0].key);

    // A new credential is a value, not content: the draft still equals the active release.
    const consumer = (await h.sql.query(`select id from consumers where environment_id = $1`, [ws])).rows[0].id;
    expect((await h.api("POST", `/environments/${ws}/consumers/${consumer}/key-auth`, {})).status).toBe(201);
    expect((await v2api(h.api, "POST", `/workspaces/${ws}/releases`, {})).status).toBe(409);
    const sealed = (await h.sql.query(`select content from releases where workspace_id = $1 and version = 1`, [ws])).rows[0].content;
    expect(enc.openJson<Doc>(sealed, releaseContext(ws, 1)).keyAuthCredentials).toEqual([]);

    const list = await v2api(h.api, "GET", `/workspaces/${ws}/releases`);
    expect(list.status).toBe(200);
    expect(list.body.map((r: Doc) => r.version)).toEqual([1]);
  });

  it("refuses an unchanged draft and a stale expectedActiveVersion with 409", async () => {
    const ws = await workspace(h);
    expect((await v2api(h.api, "POST", `/workspaces/${ws}/releases`, {})).status).toBe(201);
    expect((await v2api(h.api, "POST", `/workspaces/${ws}/releases`, {})).status).toBe(409);
    await h.api("POST", `/environments/${ws}/services`, { name: uniq("svc"), protocol: "http", host: "echo2", port: 80 });
    expect((await v2api(h.api, "POST", `/workspaces/${ws}/releases`, { expectedActiveVersion: null })).status).toBe(409);
    expect((await v2api(h.api, "POST", `/workspaces/${ws}/releases`, { expectedActiveVersion: 1 })).status).toBe(201);
  });

  it("keeps every other workspace's member when one publishes: changing A never changes B's digest", async () => {
    const a = await workspace(h);
    const b = await workspace(h);
    const ra = (await v2api(h.api, "POST", `/workspaces/${a}/releases`, {})).body;
    const rb = (await v2api(h.api, "POST", `/workspaces/${b}/releases`, {})).body;
    await h.api("POST", `/environments/${a}/services`, { name: uniq("svc"), protocol: "http", host: "echo3", port: 80 });
    const ra2 = (await v2api(h.api, "POST", `/workspaces/${a}/releases`, {})).body;
    expect(ra2.contentDigest).not.toBe(ra.contentDigest);
    const [prev, last] = (await deploymentRows(h)).slice(-2);
    const member = (rows: Doc[], ws: string) => rows.find((m) => m.workspaceId === ws);
    expect(member(prev.members, b)).toEqual({ workspaceId: b, releaseVersion: 1, contentDigest: rb.contentDigest });
    expect(member(last.members, b)).toEqual(member(prev.members, b));
    expect(member(last.members, a)).toEqual({ workspaceId: a, releaseVersion: 2, contentDigest: ra2.contentDigest });
    expect(last.revision).toBe(prev.revision + 1);
    // The previous revision is superseded by the new one; every revision stays in the immutable history.
    expect((await states(h, prev.revision)).at(-1)).toBe("superseded");
  });

  it("returns 409 while another deployment holds the lease, and fails that deployment once its deadline passed", async () => {
    const ws = await workspace(h);
    const [last] = (await deploymentRows(h)).slice(-1);
    await h.sql.query(`insert into deployment_states (epoch, revision, seq, state, reason) select 1, $1, max(seq) + 1, 'converging', 'test' from deployment_states where revision = $1`, [last.revision]);
    await h.sql.query(`update deployment_lease set revision = $1, operation = 'publish', deadline_at = now() + interval '1 hour'`, [last.revision]);
    expect((await v2api(h.api, "POST", `/workspaces/${ws}/releases`, {})).status).toBe(409);
    expect((await h.sql.query(`select count(*)::int as n from releases where workspace_id = $1`, [ws])).rows[0].n).toBe(0);

    await h.sql.query(`update deployment_lease set deadline_at = now() - interval '1 second'`);
    expect((await v2api(h.api, "POST", `/workspaces/${ws}/releases`, {})).status).toBe(201);
    expect((await states(h, last.revision)).slice(-3)).toEqual(["degraded", "failed", "superseded"]);
  });

  it("refuses what the composition refuses, recording nothing", async () => {
    const ws = await workspace(h);
    // A route without a path cannot be prefixed (N1-C2): the composition rejects it and nothing persists.
    const svc = (await h.api("POST", `/environments/${ws}/services`, { name: uniq("svc"), protocol: "http", host: "echo", port: 80 })).body.id;
    expect((await h.api("POST", `/environments/${ws}/routes`, { name: uniq("route"), serviceId: svc, hosts: ["x.example"] })).status).toBe(201);
    const before = (await deploymentRows(h)).length;
    const res = await v2api(h.api, "POST", `/workspaces/${ws}/releases`, {});
    expect(res.status).toBe(422);
    expect(res.body.errors.some((e: Doc) => String(e.path).endsWith(".paths"))).toBe(true);
    expect((await deploymentRows(h)).length).toBe(before);
    expect((await h.sql.query(`select count(*)::int as n from releases where workspace_id = $1`, [ws])).rows[0].n).toBe(0);
  });

  it("follows the contract's permission: release.publish to publish, workspace.read to list, 404 outside the scope", async () => {
    const ws = await workspace(h);
    const viewer = await h.as("viewer");
    expect((await v2api(viewer.api, "GET", `/workspaces/${ws}/releases`)).status).toBe(200);
    expect((await v2api(viewer.api, "POST", `/workspaces/${ws}/releases`, {})).status).toBe(403);
    const editor = await h.as("editor");
    expect((await v2api(editor.api, "POST", `/workspaces/${ws}/releases`, {})).status).toBe(201);
    expect((await v2api(h.api, "GET", `/workspaces/00000000-0000-4000-8000-000000000999/releases`)).status).toBe(404);
    expect(v2.paths["/workspaces/{workspaceId}/releases"].post["x-required-permission"]).toBe("release.publish");
  });

  it("keeps the instance identity, releases, deployments and their transitions immutable", async () => {
    for (const statement of [`update instance set stage = 'prd'`, `delete from instance`, `update deployment_states set state = 'failed'`, `delete from deployment_states`, `update releases set message = 'x'`]) {
      await expect(h.sql.query(statement), statement).rejects.toMatchObject({ code: "55000" });
    }
  });
});

describe("publishRelease outside dev", () => {
  it("answers 403 on hml and refuses a configured stage different from the instance's", async () => {
    const url = await freshDatabase("stage");
    const hml = await startHarness({ databaseUrl: url, workspacesDeployments: { ...LAB, stage: "hml" } });
    try {
      const ws = await workspace(hml);
      expect((await v2api(hml.api, "POST", `/workspaces/${ws}/releases`, {})).status).toBe(403);
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
