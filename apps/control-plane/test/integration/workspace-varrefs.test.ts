import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { deploymentContext, ENCRYPTOR, type Encryptor } from "../../src/crypto/crypto.js";
import { runMigrations } from "../../src/db/migrate.js";
import { type ApiClient, type ApiResponse, startHarness, uniq, type Harness } from "./harness.js";

// WS-V2: a service field may name a workspace variable. The draft and the release keep the reference; a deployment
// resolves it from this instance's values, checks the value as the field it fills, and refuses before any node when a
// value is missing or refused. Values never show in responses, releases or the audit.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://gromesh:gromesh@127.0.0.1:5432/gromesh";
const LAB = { stage: "dev" as const, convergenceDeadlineMs: 600_000 };
const v2 = (client: ApiClient, method: string, path: string, body?: unknown): Promise<ApiResponse> => client(method, `/../v2${path}`, body);
const SECRET_PATH = "/s3cr3t-path-never-in-responses";

describe("VarRef resolution (WS-V2)", () => {
  const dbName = `gromesh_wsv2_${Date.now()}_${process.pid}`;
  let h: Harness;
  let a: string;
  let b: string;
  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();
    const url = new URL(ADMIN_URL);
    url.pathname = `/${dbName}`;
    await runMigrations(url.toString());
    h = await startHarness({ databaseUrl: url.toString(), workspacesDeployments: LAB });
    a = (await v2(h.api, "POST", "/workspaces", { name: uniq("Vars A") })).body.id;
    b = (await v2(h.api, "POST", "/workspaces", { name: uniq("Vars B") })).body.id;
    for (const [name, decl] of [["ORDERS_HOST", { type: "host", secret: false, required: true }], ["ORDERS_PORT", { type: "port", secret: false, required: true }], ["BASE_PATH", { type: "string", secret: true, required: true }], ["SCHEME", { type: "string", secret: false, required: true }]] as const) {
      expect((await v2(h.api, "PUT", `/workspaces/${a}/variables/${name}`, decl)).status).toBe(200);
    }
    expect((await v2(h.api, "PUT", `/workspaces/${b}/variables/ONLY_IN_B`, { type: "host", secret: false, required: true })).status).toBe(200);
  });
  afterAll(async () => {
    await h?.close();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.end();
  });

  const svc = (over: Record<string, unknown> = {}) => ({ name: uniq("svc"), protocol: { $var: "SCHEME" }, host: { $var: "ORDERS_HOST" }, port: { $var: "ORDERS_PORT" }, path: { $var: "BASE_PATH" }, ...over });
  const deploy = (expectedRevision: number | null) => v2(h.api, "POST", "/deployments", { expectedRevision, reason: "ws-v2" });
  const lastRevision = async () => (await h.sql.query("select max(revision)::int as r from deployments")).rows[0].r as number | null;
  const freeLease = () => h.sql.query("update deployment_lease set revision = null, operation = null, owner = null, started_at = null, deadline_at = null");
  const config = async (revision: number) => {
    const [row] = (await h.sql.query("select epoch, config, values_digest from deployments where revision = $1", [revision])).rows;
    return { config: h.app.get<Encryptor>(ENCRYPTOR).openJson<{ services: { name: string; host: string; port: number; path?: string; protocol: string }[] }>(row.config, deploymentContext(row.epoch, revision)), valuesDigest: row.values_digest as string };
  };

  it("keeps the references as written in the draft, refuses an undeclared, foreign or ill-typed one", async () => {
    const created = await v2(h.api, "POST", `/workspaces/${a}/services`, svc({ name: "orders" }));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ protocol: { $var: "SCHEME" }, host: { $var: "ORDERS_HOST" }, port: { $var: "ORDERS_PORT" }, path: { $var: "BASE_PATH" } });
    expect((await v2(h.api, "GET", `/workspaces/${a}/services/${created.body.id}`)).body.host).toEqual({ $var: "ORDERS_HOST" });
    for (const [body, path] of [[svc({ host: { $var: "NOT_DECLARED" } }), "host"], [svc({ host: { $var: "ONLY_IN_B" } }), "host"], [svc({ host: { $var: "ORDERS_PORT" } }), "host"], [svc({ port: { $var: "ORDERS_HOST" } }), "port"]] as const) {
      const res = await v2(h.api, "POST", `/workspaces/${a}/services`, body);
      expect([res.status, res.body.errors?.[0]?.path], JSON.stringify(body)).toEqual([422, path]);
    }
    // A referenced variable keeps its declaration: no delete, no type change.
    expect((await v2(h.api, "DELETE", `/workspaces/${a}/variables/ORDERS_HOST`)).status).toBe(409);
    expect((await v2(h.api, "PUT", `/workspaces/${a}/variables/ORDERS_HOST`, { type: "string", secret: false, required: true })).status).toBe(409);
    // v1 never resolves a variable: its publish refuses the draft; an export carries no instance value (422 there).
    expect((await h.api("POST", `/environments/${a}/snapshots`, {})).status).toBe(422);
    const exported = await v2(h.api, "GET", `/workspaces/${a}/export`);
    expect([exported.status, JSON.stringify(exported.body)]).toEqual([422, expect.stringContaining("names variable")]);
  });

  it("publishes a release that keeps the references, and refuses a deployment while a required value is missing", async () => {
    expect((await v2(h.api, "POST", `/workspaces/${a}/releases`, { message: "with variables" })).status).toBe(201);
    const refused = await deploy(null);
    expect(refused.status).toBe(422);
    expect(JSON.stringify(refused.body)).toMatch(/required variable without a value on this instance/);
    expect(await lastRevision()).toBeNull();
  });

  it("resolves this instance's values at the deployment, checks them as the fields they fill, and never shows a secret", async () => {
    for (const [name, value] of [["ORDERS_HOST", "orders.internal.example"], ["ORDERS_PORT", "8443"], ["BASE_PATH", SECRET_PATH], ["SCHEME", "https"]]) {
      expect((await v2(h.api, "PUT", `/workspaces/${a}/variables/${name}/value`, { value })).status).toBe(204);
    }
    const first = await deploy(null);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const r1 = (await lastRevision())!;
    const one = await config(r1);
    expect(one.config.services.find((s) => s.name.endsWith("~orders"))).toMatchObject({ host: "orders.internal.example", port: 8443, path: SECRET_PATH, protocol: "https" });
    // The contract's Digest form, the one the agent accepts.
    expect(one.valuesDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    // No secret anywhere a user or an auditor reads.
    expect(JSON.stringify((await v2(h.api, "GET", `/workspaces/${a}/services`)).body)).not.toContain(SECRET_PATH);
    expect(JSON.stringify(first.body)).not.toContain(SECRET_PATH);
    expect((await h.sql.query("select count(*)::int as n from audit_events where (before::text like $1 or after::text like $1)", [`%${SECRET_PATH}%`])).rows[0].n).toBe(0);

    // A new value changes the next revision (and its digest) only when deployed: the release stays the same.
    await freeLease();
    expect((await v2(h.api, "PUT", `/workspaces/${a}/variables/ORDERS_PORT/value`, { value: "9443" })).status).toBe(204);
    expect(await lastRevision()).toBe(r1);
    expect((await deploy(r1)).status).toBe(201);
    const two = await config(r1 + 1);
    expect(two.config.services.find((s) => s.name.endsWith("~orders"))!.port).toBe(9443);
    expect(two.valuesDigest).not.toBe(one.valuesDigest);

    // A value that is a forbidden destination, or not of the field's shape, is refused before any node.
    await freeLease();
    await v2(h.api, "PUT", `/workspaces/${a}/variables/ORDERS_HOST/value`, { value: "169.254.169.254" });
    expect((await deploy(r1 + 1)).status).toBe(422);
    await v2(h.api, "PUT", `/workspaces/${a}/variables/ORDERS_HOST/value`, { value: "orders.internal.example" });
    await v2(h.api, "PUT", `/workspaces/${a}/variables/SCHEME/value`, { value: "ftp" });
    expect((await deploy(r1 + 1)).status).toBe(422);
    expect(await lastRevision()).toBe(r1 + 1);
  });

  it("checks every value against the declarations the release froze, requires required ones, never answers a secret", async () => {
    await freeLease();
    const before = await lastRevision();
    // A secret host whose value is a forbidden destination: refused, and the answer never quotes it.
    await v2(h.api, "PUT", `/workspaces/${a}/variables/SCHEME/value`, { value: "https" });
    expect((await v2(h.api, "PUT", `/workspaces/${a}/variables/SECRET_HOST`, { type: "host", secret: true, required: false })).status).toBe(200);
    await v2(h.api, "PUT", `/workspaces/${a}/variables/SECRET_HOST/value`, { value: "169.254.169.254" });
    expect((await v2(h.api, "POST", `/workspaces/${a}/services`, svc({ name: "secret-host", host: { $var: "SECRET_HOST" } }))).status).toBe(201);
    expect((await v2(h.api, "POST", `/workspaces/${a}/releases`, { message: "secret host" })).status).toBe(201);
    const leak = await deploy(before);
    expect(leak.status).toBe(422);
    expect(JSON.stringify(leak.body)).not.toContain("169.254.169.254");
    // A required declaration without a value, referenced or not, refuses the deployment.
    await v2(h.api, "PUT", `/workspaces/${a}/variables/SECRET_HOST/value`, { value: "secret.internal.example" });
    expect((await v2(h.api, "PUT", `/workspaces/${a}/variables/UNUSED_REQUIRED`, { type: "string", secret: false, required: true })).status).toBe(200);
    expect((await v2(h.api, "POST", `/workspaces/${a}/releases`, { message: "unused required" })).status).toBe(201);
    const missing = await deploy(before);
    expect([missing.status, JSON.stringify(missing.body)]).toEqual([422, expect.stringContaining("variables.UNUSED_REQUIRED")]);
    await v2(h.api, "PUT", `/workspaces/${a}/variables/UNUSED_REQUIRED/value`, { value: "x" });
    // The frozen validation applies to a value set before it: minimum 9000 on a port that holds 8443.
    expect((await v2(h.api, "PUT", `/workspaces/${a}/variables/ORDERS_PORT`, { type: "port", secret: false, required: true, validation: { minimum: 9000 } })).status).toBe(200);
    await v2(h.api, "PUT", `/workspaces/${a}/variables/ORDERS_PORT/value`, { value: "9443" });
    await h.sql.query("insert into workspace_variable_values (workspace_id, name, version, value, sealed) select workspace_id, name, version + 1, '8443', false from workspace_variable_values where workspace_id = $1 and name = 'ORDERS_PORT' order by version desc limit 1", [a]);
    expect((await v2(h.api, "POST", `/workspaces/${a}/releases`, { message: "frozen minimum" })).status).toBe(201);
    const frozen = await deploy(before);
    expect([frozen.status, JSON.stringify(frozen.body)]).toEqual([422, expect.stringContaining("variables.ORDERS_PORT")]);
    expect(await lastRevision()).toBe(before);
  });
});
