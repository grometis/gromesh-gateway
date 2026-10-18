import { afterAll, beforeAll, expect, test } from "vitest";
import { parse } from "yaml";
import { startHarness, uniq, type Harness } from "./harness.js";

let h: Harness;
beforeAll(async () => { h = await startHarness({ autoPublishPollMs: 0, platformHttpLogEndpoint: "http://collector.test:9000" }); });
afterAll(async () => { await h?.close(); });

async function fixture() {
  const env = await h.api("POST", "/environments", { name: uniq("retention") });
  const base = `/environments/${env.body.id}`;
  const service = await h.api("POST", `${base}/services`, { name: "api", protocol: "http", host: "echo", port: 80 });
  const write = { name: "sensitive", serviceId: service.body.id as string, paths: ["/sensitive"] };
  return { base, envId: env.body.id as string, write };
}

test("CRUD persists retention, validates both writes, and audits changes and deletion", async () => {
  const { base, envId, write } = await fixture();
  const created = await h.api("POST", `${base}/routes`, { ...write, analyticsRetentionDays: 1 });
  expect(created.status).toBe(201);
  const path = `${base}/routes/${created.body.id}`;
  expect((await h.api("GET", path)).body.analyticsRetentionDays).toBe(1);
  expect((await h.api("GET", `${base}/routes`)).body.items[0].analyticsRetentionDays).toBe(1);
  expect((await h.sql.query("select analytics_retention_days from routes where id=$1", [created.body.id])).rows[0].analytics_retention_days).toBe(1);
  for (const value of [0, 8, 1.5, "1", true]) {
    for (const [method, url] of [["POST", `${base}/routes`], ["PUT", path]]) {
      const rejected = await h.api(method!, url!, { ...write, analyticsRetentionDays: value });
      expect(rejected.status).toBe(422);
      expect(rejected.body.errors).toContainEqual(expect.objectContaining({ path: "analyticsRetentionDays" }));
    }
  }
  for (const value of [7, null]) {
    const updated = await h.api("PUT", path, { ...write, analyticsRetentionDays: value });
    expect(updated.status).toBe(200);
    expect(updated.body.analyticsRetentionDays).toBe(value);
  }
  await h.api("PUT", path, { ...write, analyticsRetentionDays: 1 });
  expect((await h.api("PUT", path, write)).body.analyticsRetentionDays).toBe(null);
  expect((await h.api("DELETE", path)).status).toBe(204);
  const audit = await h.sql.query("select action, before, after from audit_events where environment_id=$1 and entity_id=$2 order by at", [envId, created.body.id]);
  expect(audit.rows[0]).toMatchObject({ action: "route.create", after: { analyticsRetentionDays: 1 } });
  expect(audit.rows).toContainEqual(expect.objectContaining({ action: "route.update", before: expect.objectContaining({ analyticsRetentionDays: 1 }), after: expect.objectContaining({ analyticsRetentionDays: 7 }) }));
  expect(audit.rows.at(-1)).toMatchObject({ action: "route.delete", before: { analyticsRetentionDays: null } });
});

test("publication and rollback restore retention; JSON/YAML export and retention-only imports preserve it", async () => {
  const { base, write } = await fixture();
  const created = await h.api("POST", `${base}/routes`, { ...write, analyticsRetentionDays: 1 });
  const path = `${base}/routes/${created.body.id}`;
  const first = await h.api("POST", `${base}/snapshots`, {});
  expect(first.status).toBe(201);
  await h.api("PUT", path, { ...write, analyticsRetentionDays: 7 });
  expect((await h.api("POST", `${base}/snapshots`, {})).status).toBe(201);
  const rollback = await h.api("POST", `${base}/snapshots/${first.body.version}/rollback`);
  expect(rollback.status).toBe(201);
  expect(rollback.body.hash).toBe(first.body.hash);
  expect((await h.api("GET", path)).body.analyticsRetentionDays).toBe(1);
  const exported = await h.api("GET", `${base}/export?format=json`);
  expect(exported.body.routes[0].analyticsRetentionDays).toBe(1);
  const yaml = await h.api<string>("GET", `${base}/export?format=yaml`);
  expect(parse(yaml.body)).toEqual(exported.body);
  const target = await h.api("POST", "/environments", { name: uniq("retention-import") });
  const targetBase = `/environments/${target.body.id}`;
  const imported = await h.api("POST", `${targetBase}/import`, { document: exported.body, mode: "replace", dryRun: false });
  expect(imported.status).toBe(200);
  expect((await h.api("GET", `${targetBase}/routes`)).body.items[0].analyticsRetentionDays).toBe(1);
  for (const value of [7, null]) {
    exported.body.routes[0].analyticsRetentionDays = value;
    const result = await h.api("POST", `${targetBase}/import`, { document: exported.body, mode: "merge", dryRun: false });
    expect(result.status).toBe(200);
    expect(result.body.modified).toContainEqual(expect.objectContaining({ kind: "routes" }));
    expect((await h.api("GET", `${targetBase}/routes`)).body.items[0].analyticsRetentionDays).toBe(value);
  }
});

test("a legacy publication rolls back to the default and Kong import invents no retention", async () => {
  const { base, write } = await fixture();
  const created = await h.api("POST", `${base}/routes`, write);
  expect(created.body.analyticsRetentionDays).toBe(null);
  const first = await h.api("POST", `${base}/snapshots`, {});
  await h.api("PUT", `${base}/routes/${created.body.id}`, { ...write, analyticsRetentionDays: 1 });
  await h.api("POST", `${base}/snapshots`, {});
  expect((await h.api("POST", `${base}/snapshots/${first.body.version}/rollback`)).status).toBe(201);
  expect((await h.api("GET", `${base}/routes/${created.body.id}`)).body.analyticsRetentionDays).toBe(null);
  const imported = await h.api("POST", `${base}/import`, { mode: "replace", dryRun: false, sourceFormat: "kong-declarative-3.0", document: {
    _format_version: "3.0", services: [{ name: "imported", protocol: "http", host: "echo", port: 80, routes: [{ name: "imported", paths: ["/imported"] }] }],
  } });
  expect(imported.status).toBe(200);
  expect((await h.api("GET", `${base}/routes`)).body.items[0].analyticsRetentionDays).toBe(null);
});
