import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SnapshotsService } from "../../src/snapshots/snapshots.js";
import { startHarness, uniq, type ApiClient, type Harness } from "./harness.js";

// Hotfix F-1: code run by the gateway (and plugins falling back to the pod's credentials) can read the platform's
// secrets, so only the platform admin configures them (contract: Privileged plugin capabilities).
let h: Harness;
beforeAll(async () => {
  h = await startHarness({ autoPublishPollMs: 0, platformHttpLogEndpoint: "http://gromesh-collector:8080/kong" });
});
afterAll(async () => {
  await h?.close();
});

async function env(publishMode = "manual"): Promise<string> {
  const res = await h.api("POST", "/environments", { name: uniq("privileged"), publishMode });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

const preFunction = { name: "pre-function", config: { access: ["kong.response.set_header('X-Probe', '1')"] } };
// tcp-log: the platform's own http-log already holds the global http-log slot.
const luaLog = { name: "tcp-log", config: { host: "logs.example.com", port: 9000, custom_fields_by_lua: { probe: "return 1" } } };
const plainLog = { name: "tcp-log", config: { host: "logs.example.com", port: 9000 } };
const ambientLambda = { name: "aws-lambda", config: { function_name: "f", aws_region: "us-east-1" } };
const paths = (body: { errors?: { path: string }[] }) => (body.errors ?? []).map((e) => e.path);

/** Users who are not the platform admin: a global editor, an environment admin, and a platform admin's editor token. */
async function others(envId: string): Promise<[string, ApiClient][]> {
  const editor = await h.as("editor");
  const envAdmin = await h.as("viewer");
  expect((await h.api("PUT", `/users/${envAdmin.id}/environment-roles`, { items: [{ environmentId: envId, role: "admin" }] })).status).toBe(200);
  const token = await h.api("POST", "/users/me/tokens", { name: uniq("editor-token"), role: "editor", expiresInDays: 1 });
  expect(token.status).toBe(201);
  const bearer: ApiClient = (method, path, body, headers = {}) => h.anonymous(method, path, body, { ...headers, authorization: `Bearer ${token.body.token}` });
  return [["editor", editor.api], ["environment admin", envAdmin.api], ["admin's editor token", bearer]];
}

describe("privileged plugin capabilities", () => {
  it("refuse anyone but the platform admin on create, replace and delete, and leave ordinary plugins alone", async () => {
    const envId = await env();
    for (const [who, api] of await others(envId)) {
      for (const [body, path] of [[preFunction, "name"], [luaLog, "config.custom_fields_by_lua"], [ambientLambda, "config.aws_key"]] as const) {
        const res = await api("POST", `/environments/${envId}/plugins`, body);
        expect(res.status, `${who} creating ${body.name}`).toBe(403);
        expect(paths(res.body)).toEqual([path]);
      }
      const plain = await api("POST", `/environments/${envId}/plugins`, plainLog);
      expect(plain.status, `${who} creating a plain tcp-log`).toBe(201);
      expect((await api("PUT", `/environments/${envId}/plugins/${plain.body.id}`, luaLog)).status).toBe(403);
      expect((await api("PUT", `/environments/${envId}/plugins/${plain.body.id}`, { ...plainLog, enabled: false })).status).toBe(200);
      expect((await api("DELETE", `/environments/${envId}/plugins/${plain.body.id}`)).status).toBe(204);
    }
    // The platform admin may: and then nobody else may change or remove what it configured.
    const created = await h.api("POST", `/environments/${envId}/plugins`, preFunction);
    expect(created.status).toBe(201);
    for (const [who, api] of await others(envId)) {
      expect((await api("PUT", `/environments/${envId}/plugins/${created.body.id}`, { ...preFunction, enabled: false })).status, who).toBe(403);
      expect((await api("PUT", `/environments/${envId}/plugins/${created.body.id}`, plainLog)).status, who).toBe(403);
      expect((await api("DELETE", `/environments/${envId}/plugins/${created.body.id}`)).status, who).toBe(403);
    }
    const audit = await h.sql.query("select count(*)::int as n from audit_events where environment_id = $1 and entity_id = $2", [envId, created.body.id]);
    expect(audit.rows[0].n).toBe(1);
    expect((await h.api("DELETE", `/environments/${envId}/plugins/${created.body.id}`)).status).toBe(204);
  });

  it("follow the N1 permissions: platform.admin from an instance grant may, a workspace-admin grant may not", async () => {
    const envId = await env();
    const v2 = (path: string) => `/../v2${path}`;
    const platform = await h.as("viewer");
    const workspaceAdmin = await h.as("viewer");
    expect((await h.api("POST", v2("/role-bindings"), { subjectType: "user", subjectId: platform.id, role: "platform-admin" })).status).toBe(201);
    expect((await h.api("POST", v2(`/workspaces/${envId}/role-bindings`), { subjectType: "user", subjectId: workspaceAdmin.id, role: "workspace-admin" })).status).toBe(201);
    const refused = await workspaceAdmin.api("POST", `/environments/${envId}/plugins`, preFunction);
    expect(refused.status).toBe(403);
    expect(paths(refused.body)).toEqual(["name"]);
    const created = await platform.api("POST", `/environments/${envId}/plugins`, preFunction);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await workspaceAdmin.api("DELETE", `/environments/${envId}/plugins/${created.body.id}`)).status).toBe(403);
    expect((await platform.api("POST", `/environments/${envId}/snapshots`, {})).status).toBe(201);
  });

  it("let only the platform admin publish or roll back a change to privileged plugins, rows written before the rule included", async () => {
    const envId = await env();
    const editor = (await others(envId))[0]![1];
    expect((await editor("POST", `/environments/${envId}/plugins`, plainLog)).status).toBe(201);
    const first = await editor("POST", `/environments/${envId}/snapshots`, {});
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    // A row written before the rule existed (or by an old version of the control plane).
    await h.sql.query("insert into plugins (environment_id, name, config) values ($1, 'pre-function', $2::jsonb)", [envId, JSON.stringify(preFunction.config)]);
    const refused = await editor("POST", `/environments/${envId}/snapshots`, {});
    expect(refused.status).toBe(403);
    expect(paths(refused.body)).toEqual(["plugins[1].name"]);
    expect((await h.api("POST", `/environments/${envId}/snapshots`, {})).status).toBe(201);
    // Unchanged privileged plugins do not hold back an editor's ordinary publish...
    expect((await editor("POST", `/environments/${envId}/plugins`, { name: "cors", config: {} })).status).toBe(201);
    expect((await editor("POST", `/environments/${envId}/snapshots`, {})).status).toBe(201);
    // ...but rolling back to a version without them (or with other ones) changes what runs: platform admin only.
    const rollback = await editor("POST", `/environments/${envId}/snapshots/1/rollback`);
    expect(rollback.status).toBe(403);
    const environment = await h.api("GET", `/environments/${envId}`);
    expect(environment.body.currentVersion).toBe(3);
    expect((await h.api("POST", `/environments/${envId}/snapshots/1/rollback`)).status).toBe(201);
  });

  it("pause auto-publish on a privileged change until the platform admin publishes", async () => {
    const envId = await env("auto");
    expect((await h.api("POST", `/environments/${envId}/plugins`, preFunction)).status).toBe(201);
    await h.app.get(SnapshotsService).autoPublish(envId, 0);
    const paused = await h.api("GET", `/environments/${envId}`);
    expect(paused.body).toMatchObject({ currentVersion: null, autoPublishPausedReason: "privileged" });
    const editor = (await others(envId))[0]![1];
    expect((await editor("POST", `/environments/${envId}/snapshots`, {})).status).toBe(403);
    expect((await h.api("POST", `/environments/${envId}/snapshots`, {})).status).toBe(201);
    expect((await h.api("GET", `/environments/${envId}`)).body).toMatchObject({ currentVersion: 1, autoPublishPausedReason: null });
  });

  it("refuse an import that changes privileged plugins unless the platform admin runs it", async () => {
    const envId = await env();
    const editor = (await others(envId))[0]![1];
    const document = {
      apiVersion: "gromesh/v1", services: [], routes: [], consumers: [], upstreams: [], certificates: [],
      plugins: [{ name: "cors", config: {} }, luaLog],
    };
    const res = await editor("POST", `/environments/${envId}/import`, { document, mode: "replace", dryRun: false });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(paths(res.body)).toEqual(["document.plugins.1.config.custom_fields_by_lua"]);
    expect((await h.api("GET", `/environments/${envId}/plugins`)).body.items).toEqual([]);
    expect((await editor("POST", `/environments/${envId}/import`, { document: { ...document, plugins: [plainLog] }, mode: "replace", dryRun: false })).status).toBe(200);
    expect((await h.api("POST", `/environments/${envId}/import`, { document, mode: "replace", dryRun: false })).status).toBe(200);
  });
});
