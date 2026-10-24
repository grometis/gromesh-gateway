import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, uniq, type Harness } from "./harness.js";

// Hotfix C-1: a service to 127.0.0.1:8001 plus a public route exposed the data plane's Admin API.
let h: Harness;
beforeAll(async () => {
  h = await startHarness({ forbiddenDestinations: ["*.corp.internal"], platformHttpLogEndpoint: "http://gromesh-collector:8080/kong" });
});
afterAll(async () => {
  await h?.close();
});

async function env(): Promise<string> {
  const res = await h.api("POST", "/environments", { name: uniq("dest") });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

const service = (host: string) => ({ name: uniq("svc"), protocol: "http", host, port: 8001 });
const paths = (body: { errors?: { path: string }[] }) => (body.errors ?? []).map((e) => e.path);

describe("forbidden destinations", () => {
  it("refuses a service on loopback, link-local, a numeric alias or an internal host, and accepts ordinary ones", async () => {
    const envId = await env();
    for (const host of ["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0", "169.254.169.254", "2130706433", "gromesh-collector.gromesh.svc.cluster.local", "vault.corp.internal"]) {
      const res = await h.api("POST", `/environments/${envId}/services`, service(host));
      expect(res.status, host).toBe(422);
      expect(paths(res.body), host).toEqual(["host"]);
    }
    const ok = await h.api("POST", `/environments/${envId}/services`, service("orders.internal"));
    expect(ok.status).toBe(201);
    const moved = await h.api("PUT", `/environments/${envId}/services/${ok.body.id}`, { ...service("127.0.0.1"), name: ok.body.name });
    expect(moved.status).toBe(422);
    expect((await h.api("GET", `/environments/${envId}/services/${ok.body.id}`)).body.host).toBe("orders.internal");
  });

  it("refuses an upstream named like a forbidden host and a target on one", async () => {
    const envId = await env();
    for (const name of ["localhost", "127.0.0.1"]) {
      const res = await h.api("POST", `/environments/${envId}/upstreams`, { name });
      expect(res.status, name).toBe(422);
      expect(paths(res.body)).toEqual(["name"]);
    }
    const up = (await h.api("POST", `/environments/${envId}/upstreams`, { name: "pool.upstream" })).body;
    for (const target of ["127.0.0.1:8001", "[::1]:8001", "169.254.169.254:80", "0x7f000001:8001", "localhost:8100"]) {
      const res = await h.api("POST", `/environments/${envId}/upstreams/${up.id}/targets`, { target });
      expect(res.status, target).toBe(422);
      expect(paths(res.body)).toEqual(["target"]);
    }
    const ok = await h.api("POST", `/environments/${envId}/upstreams/${up.id}/targets`, { target: "10.0.0.11:8080" });
    expect(ok.status).toBe(201);
    expect((await h.api("PUT", `/environments/${envId}/upstreams/${up.id}/targets/${ok.body.id}`, { target: "127.0.0.1:8080" })).status).toBe(422);
  });

  it("does not publish a row written before the rule existed, and publishes nothing", async () => {
    const envId = await env();
    await h.sql.query("insert into services (environment_id, name, protocol, host, port) values ($1, 'legacy-admin', 'http', '127.0.0.1', 8001)", [envId]);
    const res = await h.api("POST", `/environments/${envId}/snapshots`, {});
    expect(res.status).toBe(422);
    expect(paths(res.body)).toEqual(["services[0].host"]);
    expect((await h.api("GET", `/environments/${envId}/snapshots`)).body.items).toEqual([]);
  });

  it("reports a forbidden destination at its document path on import, writing nothing", async () => {
    const envId = await env();
    const document = {
      apiVersion: "gromesh/v1",
      services: [{ name: "admin", protocol: "http", host: "127.0.0.1", port: 8001 }],
      routes: [],
      consumers: [],
      plugins: [],
      upstreams: [{ name: "pool.upstream", targets: [{ target: "[::1]:8001" }] }],
      certificates: [],
    };
    const dry = await h.api("POST", `/environments/${envId}/import`, { document, mode: "replace", dryRun: true });
    expect(dry.status).toBe(200);
    expect(paths(dry.body).sort()).toEqual(["document.services.0.host", "document.upstreams.0.targets.0.target"]);
    const real = await h.api("POST", `/environments/${envId}/import`, { document, mode: "replace", dryRun: false });
    expect(real.status).toBe(422);
    expect((await h.api("GET", `/environments/${envId}/services`)).body.items).toEqual([]);
  });
});
