import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, uniq, type Harness } from "./harness.js";

const ENDPOINT = "http://gromesh-collector:8080/kong";

let h: Harness;
let plain: Harness;
beforeAll(async () => {
  h = await startHarness({ platformHttpLogEndpoint: ENDPOINT });
  plain = await startHarness({ platformHttpLogEndpoint: null });
});
afterAll(async () => {
  await plain?.close();
  await h?.close();
});

/** Registers a node on a fresh cluster of `envId` and returns the agent's view of the current snapshot. */
async function agentSnapshot(server: Harness, envId: string) {
  const cluster = await server.api("POST", `/environments/${envId}/clusters`, { name: uniq("edge") });
  expect(cluster.status).toBe(201);
  const base = `${await server.app.getUrl()}/agent/v1`;
  const registered = await fetch(`${base}/register`, {
    method: "POST",
    headers: { authorization: `Bearer ${cluster.body.registrationToken}`, "content-type": "application/json" },
    body: JSON.stringify({ nodeId: uniq("node"), hostname: "host", kongVersion: "3.9.4", agentVersion: "0.1.0" }),
  });
  expect(registered.status).toBe(200);
  const { nodeToken } = (await registered.json()) as { nodeToken: string };
  const res = await fetch(`${base}/snapshots/current`, { headers: { authorization: `Bearer ${nodeToken}` } });
  expect(res.status).toBe(200);
  return (await res.json()) as { hash: string; config: { plugins: { name: string; config: Record<string, unknown> }[] } };
}

async function envWithRoute(server: Harness) {
  const env = await server.api("POST", "/environments", { name: uniq("platform") });
  const svc = await server.api("POST", `/environments/${env.body.id}/services`, { name: uniq("svc"), protocol: "http", host: "echo", port: 80 });
  await server.api("POST", `/environments/${env.body.id}/routes`, { name: uniq("route"), serviceId: svc.body.id, paths: ["/echo"] });
  return env.body.id as string;
}

describe("platform plugins at publish", () => {
  it("adds prometheus and http-log tagged with the environment when PLATFORM_HTTP_LOG_ENDPOINT is set", async () => {
    const envId = await envWithRoute(h);
    const preview = await h.api("GET", `/environments/${envId}/publish-preview`);
    expect(preview.body.changes.map((c: { kind: string; label: string }) => `${c.kind}:${c.label}`)).toEqual(
      expect.arrayContaining(["plugins:prometheus", "plugins:http-log"]),
    );
    const published = await h.api("POST", `/environments/${envId}/snapshots`, {});
    expect(published.status).toBe(201);
    const snapshot = (await h.api("GET", `/environments/${envId}/snapshots/${published.body.version}`)).body;
    const httpLog = snapshot.config.plugins.find((p: { name: string }) => p.name === "http-log");
    expect(httpLog.config).toMatchObject({ http_endpoint: ENDPOINT, custom_fields_by_lua: { environment_id: `return "${envId}"` } });
    expect(httpLog.config.custom_fields_by_lua).not.toHaveProperty("cluster_id");
    expect(snapshot.config.plugins.some((p: { name: string }) => p.name === "prometheus")).toBe(true);
    // Rollback republishes through the same path, so the plugins stay.
    await h.api("PUT", `/environments/${envId}/services/${snapshot.config.services[0].id}`, { name: snapshot.config.services[0].name, protocol: "http", host: "echo", port: 8080 });
    await h.api("POST", `/environments/${envId}/snapshots`, {});
    const rollback = await h.api("POST", `/environments/${envId}/snapshots/${published.body.version}/rollback`);
    expect(rollback.status).toBe(201);
    const restored = (await h.api("GET", `/environments/${envId}/snapshots/${rollback.body.version}`)).body;
    expect(restored.config.plugins.map((p: { name: string }) => p.name).sort()).toEqual(["http-log", "prometheus"]);
  });

  it("serves the same hash to every cluster of the environment", async () => {
    const envId = await envWithRoute(h);
    const published = await h.api("POST", `/environments/${envId}/snapshots`, {});
    expect(published.status).toBe(201);
    const [a, b] = await Promise.all([agentSnapshot(h, envId), agentSnapshot(h, envId)]);
    expect(a.hash).toBe(published.body.hash);
    expect(b.hash).toBe(a.hash);
    expect(a.config.plugins.find((p) => p.name === "http-log")?.config.http_endpoint).toBe(ENDPOINT);
  });

  it("adds nothing without the endpoint, so the hash differs only when observability is on", async () => {
    const envId = await envWithRoute(plain);
    const published = await plain.api("POST", `/environments/${envId}/snapshots`, {});
    expect(published.status).toBe(201);
    const snapshot = (await plain.api("GET", `/environments/${envId}/snapshots/${published.body.version}`)).body;
    expect(snapshot.config.plugins).toEqual([]);
  });
});
