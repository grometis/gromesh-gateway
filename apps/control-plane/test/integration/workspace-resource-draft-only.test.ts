import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SnapshotsService } from "../../src/snapshots/snapshots.js";
import { selfSigned } from "./certs.js";
import { startHarness, uniq, type Harness } from "./harness.js";

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

describe("remaining resource draft-only writes (WS-R4 B2)", () => {
  let h: Harness;
  beforeAll(async () => { h = await startHarness({ autoPublishPollMs: 0 }); });
  afterAll(async () => h?.close());
  const state = async (ws: string) => (await h.sql.query(`select to_jsonb(e) as environment,
    (select jsonb_agg(a order by a.id) from audit_events a where a.environment_id = e.id) as audits,
    (select jsonb_agg(s order by s.version) from snapshots s where s.environment_id = e.id) as snapshots,
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

  const fixture = async (op: Operation) => {
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
    let body: unknown;
    const { resource, action } = op;
    if (["Consumer", "KeyAuth", "Jwt", "BasicAuth", "AclGroups"].includes(resource)) {
      path = "/consumers";
      if (resource === "Consumer") {
        if (action !== "create") path += `/${await seed(path, { username: "before" })}`;
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
      body = { cert: pem.cert, key: pem.key, snis: [`changed.${name}`], tags: ["changed"] };
    } else {
      path = `/plugins/${await seed("/plugins", { name: "cors", scope: {}, config: {} })}`;
    }
    expect((await h.api("POST", root + "/snapshots", {})).status).toBe(201);
    return { ws, write: (v1 = false) => h.api(op.method, (v1 ? root : `/../v2/workspaces/${ws}`) + path, action === "delete" || action === "rotate" ? undefined : body), status: action === "delete" ? 204 : action === "replace" || action === "rotate" ? 200 : 201 };
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
    expect(after.snapshots).toEqual(before.snapshots);
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
    expect(draft.snapshots).toEqual(before.snapshots);
    expect(draft.audits).toHaveLength(before.audits.length + 1);
    await h.app.get(SnapshotsService).autoPublish(f.ws, 0);
    const after = await state(f.ws);
    expect(after.environment).toMatchObject({ current_version: 2, has_unpublished_changes: false });
    expect(after.snapshots).toHaveLength(2);
  });
});
