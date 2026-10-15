import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthGuard, type Role } from "../../src/auth/auth.js";
import { ProblemException } from "../../src/common/problem.js";
import { loadConfig } from "../../src/config.js";
import { ClustersController } from "../../src/clusters/clusters.js";
import { startHarness, uniq, type Harness } from "./harness.js";

let h: Harness;
let replica: Harness;
beforeAll(async () => { h = await startHarness(); replica = await startHarness(); });
afterAll(async () => { await replica?.close(); await h?.close(); });

async function agent(path: string, token?: string, body?: unknown, headers: Record<string, string> = {}, server = h) {
  return fetch(`${await server.app.getUrl()}/agent/v1/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const registration = (nodeId = "node-1") => ({ nodeId, hostname: "host", kongVersion: "3.9.4", agentVersion: "0.1.0" });
async function fixture() {
  const env = await h.api("POST", "/environments", { name: uniq("agent") });
  const cluster = await h.api("POST", `/environments/${env.body.id}/clusters`, { name: "edge" });
  expect(cluster.status).toBe(201);
  const registered = await agent("register", cluster.body.registrationToken, registration());
  expect(registered.status).toBe(200);
  const node = await registered.json() as { nodeToken: string; clusterId: string; environmentId: string; heartbeatIntervalSeconds: number };
  return { envId: env.body.id as string, cluster: cluster.body, node };
}
const report = (extra: Record<string, unknown> = {}) => ({ nodeId: "node-1", state: "idle", kongHealthy: true, reportedAt: new Date().toISOString(), ...extra });

// These endpoints bypass user RBAC only: registration/node bearer authentication is mandatory.
describe("agent bearer authentication and cluster lifecycle", () => {
  it("enforces the cluster roles declared in the control-plane contract", () => {
    const required = { list: "viewer", get: "viewer", create: "admin", remove: "admin", rotate: "admin" } as const;
    const reflector = new Reflector();
    for (const [method, role] of Object.entries(required)) {
      const handler = ClustersController.prototype[method as keyof typeof required];
      expect(reflector.get("gromesh:required-role", handler)).toBe(role);
      const context = { getHandler: () => handler, getClass: () => ClustersController,
        switchToHttp: () => ({ getRequest: () => ({}) }) } as unknown as ExecutionContext;
      for (const caller of ["viewer", "editor", "admin"] satisfies Role[]) {
        const guard = new AuthGuard(reflector, loadConfig({ DATABASE_URL: "unused" }));
        Object.defineProperty(guard, "resolveUser", { value: () => ({ id: "test-user", name: "Test", role: caller }) });
        if (role === "admin" && caller !== "admin") {
          try { guard.canActivate(context); throw new Error("Expected role rejection"); }
          catch (error) {
            expect(error).toBeInstanceOf(ProblemException);
            expect((error as ProblemException).getStatus()).toBe(403);
            expect((error as ProblemException).getResponse()).toMatchObject({ detail: "Requires role admin" });
          }
        } else expect(guard.canActivate(context)).toBe(true);
      }
    }
  });
  it("requires agent tokens even with the built-in dev admin, and validates the protocol contract", async () => {
    for (const [path, body] of [["register", registration()], ["snapshots/current", undefined], ["events", undefined], ["status", report()]] as const) {
      for (const token of [undefined, "invalid"]) expect((await agent(path, token, body)).status).toBe(401);
    }
    const { cluster, node } = await fixture();
    expect((await agent("register", node.nodeToken, registration())).status).toBe(401);
    expect((await agent("snapshots/current", cluster.registrationToken)).status).toBe(401);
    expect((await agent("register", cluster.registrationToken, { nodeId: "a" })).status).toBe(422);
    expect((await agent("status", node.nodeToken, report({ reportedAt: "invalid" }))).status).toBe(422);
    expect((await agent("status", node.nodeToken, report({ nodeId: "another-node" }))).status).toBe(422);
  });

  it("hashes tokens, registers idempotently, rotates registration only and revokes on delete", async () => {
    const { envId, cluster, node } = await fixture();
    expect(cluster).toMatchObject({ status: "no-nodes", nodes: [] });
    const duplicate = await h.api("POST", `/environments/${envId}/clusters`, { name: "edge" });
    expect(duplicate.status).toBe(409);
    expect((await h.api("DELETE", `/environments/${envId}`)).status).toBe(409);
    const again = await agent("register", cluster.registrationToken, registration());
    const refreshed = await again.json() as { nodeToken: string };
    expect(again.status).toBe(200);
    expect((await h.api("GET", `/clusters/${cluster.id}`)).body.nodes).toHaveLength(1);
    const rotated = await h.api("POST", `/clusters/${cluster.id}/rotate-token`);
    expect(rotated.status).toBe(200);
    expect((await agent("register", cluster.registrationToken, registration())).status).toBe(401);
    expect((await agent("snapshots/current", refreshed.nodeToken)).status).toBe(204);
    const rows = await h.sql.query("select registration_token_hash from clusters where id = $1", [cluster.id]);
    expect(rows.rows[0].registration_token_hash).toBe(createHash("sha256").update(rotated.body.registrationToken).digest("hex"));
    const audit = await h.sql.query("select * from audit_events where environment_id = $1", [envId]);
    const persisted = JSON.stringify(audit.rows) + JSON.stringify((await h.api("GET", `/clusters/${cluster.id}`)).body);
    for (const token of [cluster.registrationToken, rotated.body.registrationToken, node.nodeToken, refreshed.nodeToken]) expect(persisted).not.toContain(token);
    expect((await h.api("DELETE", `/clusters/${cluster.id}`)).status).toBe(204);
    expect((await agent("snapshots/current", refreshed.nodeToken)).status).toBe(401);
    expect((await agent("register", rotated.body.registrationToken, registration())).status).toBe(401);
    expect((await h.api("DELETE", `/environments/${envId}`)).status).toBe(204);
  });
});

describe("snapshot distribution and status", () => {
  it("returns 204/200/304 with ETag, isolates environments, aggregates status and preserves non-secret diagnostics", async () => {
    const { envId, cluster, node } = await fixture();
    const other = await fixture();
    expect((await agent("snapshots/current", node.nodeToken)).status).toBe(204);
    const published = await h.api("POST", `/environments/${envId}/snapshots`, {});
    expect(published.status).toBe(201);
    const current = await agent("snapshots/current", node.nodeToken);
    expect(current.status).toBe(200);
    expect(current.headers.get("etag")).toBe(published.body.hash);
    expect(await current.json()).toMatchObject({ environmentId: envId, version: 1, hash: published.body.hash });
    expect((await agent("snapshots/current", node.nodeToken, undefined, { "if-none-match": published.body.hash })).status).toBe(304);
    expect((await agent("snapshots/current", other.node.nodeToken)).status).toBe(204);
    expect((await agent("status", node.nodeToken, report({ state: "applying" }))).status).toBe(204);
    expect((await h.api("GET", `/clusters/${cluster.id}`)).body.status).toBe("converging");
    const diagnostic = "Kong validation failed: unknown service";
    expect((await agent("status", node.nodeToken, report({ state: "failed", failedVersion: 1, error: diagnostic }))).status).toBe(204);
    const failed = (await h.api("GET", `/clusters/${cluster.id}`)).body;
    expect(failed.status).toBe("degraded");
    expect(failed.nodes[0].error).toBe(diagnostic);
    const persisted = await h.sql.query("select error from cluster_nodes where cluster_id = $1", [cluster.id]);
    expect(persisted.rows[0].error).toBe(diagnostic);
    expect((await agent("status", node.nodeToken, report({ state: "applied", appliedVersion: 1, appliedHash: published.body.hash }))).status).toBe(204);
    expect((await h.api("GET", `/clusters/${cluster.id}`)).body.status).toBe("converged");
    await agent("status", node.nodeToken, report({ state: "applied", appliedVersion: 1, appliedHash: published.body.hash, kongHealthy: false }));
    expect((await h.api("GET", `/clusters/${cluster.id}`)).body.status).toBe("degraded");
    await h.sql.query("update cluster_nodes set last_seen_at = now() - interval '46 seconds' where cluster_id = $1", [cluster.id]);
    const offline = (await h.api("GET", `/clusters/${cluster.id}`)).body;
    expect(offline.nodes[0].online).toBe(false);
    expect(offline.status).toBe("degraded");
  });

  it("redacts the failed snapshot secrets and agent tokens while preserving the diagnostic", async () => {
    const { envId, cluster, node } = await fixture();
    const consumer = await h.api("POST", `/environments/${envId}/consumers`, { username: "diagnostic-consumer" });
    expect(consumer.status).toBe(201);
    const credential = await h.api("POST", `/environments/${envId}/consumers/${consumer.body.id}/key-auth`, {});
    expect(credential.status).toBe(201);
    const password = 'redis-"private"-v1';
    const plugin = await h.api("POST", `/environments/${envId}/plugins`, {
      name: "rate-limiting",
      config: { minute: 10, policy: "redis", redis: { host: "redis", password } },
    });
    expect(plugin.status).toBe(201);
    expect((await h.api("POST", `/environments/${envId}/snapshots`, {})).status).toBe(201);
    const currentPassword = "redis-private-v2";
    expect((await h.api("PUT", `/environments/${envId}/plugins/${plugin.body.id}`, {
      name: "rate-limiting",
      config: { minute: 10, policy: "redis", redis: { host: "redis", password: currentPassword } },
    })).status).toBe(200);
    expect((await h.api("DELETE", `/environments/${envId}/consumers/${consumer.body.id}/key-auth/${credential.body.id}`)).status).toBe(204);
    expect((await h.api("POST", `/environments/${envId}/snapshots`, {})).status).toBe(201);

    const error = `Kong rejected key=${credential.body.key}, repeated=${credential.body.key}; redis.password=${password}; escaped=${JSON.stringify(password)}; registration=prefix${cluster.registrationToken}suffix; node=${node.nodeToken}. Check Redis authentication.`;
    const expected = 'Kong rejected key=REDACTED, repeated=REDACTED; redis.password=REDACTED; escaped="REDACTED"; registration=prefixREDACTEDsuffix; node=REDACTED. Check Redis authentication.';
    expect((await agent("status", node.nodeToken, report({ state: "failed", failedVersion: 1, error }))).status).toBe(204);
    const stored = await h.sql.query("select error from cluster_nodes where cluster_id = $1", [cluster.id]);
    expect(stored.rows[0].error).toBe(expected);
    const audit = await h.sql.query("select after from audit_events where environment_id = $1 and action = 'agent.status'", [envId]);
    expect(audit.rows[0].after.error).toBe(expected);
    expect((await h.api("GET", `/clusters/${cluster.id}`)).body.nodes[0].error).toBe(expected);

    for (const failedVersion of [undefined, 999]) {
      const response = await agent("status", node.nodeToken, report({ state: "failed", failedVersion, error: `Redis password=${currentPassword}: authentication failed` }));
      expect(response.status).toBe(204);
      const fallback = await h.sql.query("select error from cluster_nodes where cluster_id = $1", [cluster.id]);
      expect(fallback.rows[0].error).toBe("Redis password=REDACTED: authentication failed");
    }
    const prefix = `Redis password=${currentPassword}: `;
    expect((await agent("status", node.nodeToken, report({ state: "failed", error: prefix + "🔒é".repeat(2000) }))).status).toBe(204);
    const capped = await h.sql.query("select error from cluster_nodes where cluster_id = $1", [cluster.id]);
    expect(capped.rows[0].error).toMatch(/^Redis password=REDACTED: /);
    expect(Buffer.byteLength(capped.rows[0].error, "utf8")).toBeLessThanOrEqual(8192);
    expect(Buffer.byteLength(capped.rows[0].error, "utf8")).toBeGreaterThan(8188);
    expect(capped.rows[0].error).not.toContain("�");
  });

  it("updates heartbeats without auditing unless an operational status field changes", async () => {
    const { envId, cluster, node } = await fixture();
    const count = async () => {
      const result = await h.sql.query("select count(*)::int as count from audit_events where environment_id = $1 and action = 'agent.status'", [envId]);
      return result.rows[0].count as number;
    };
    expect(await count()).toBe(0);
    expect((await agent("status", node.nodeToken, report())).status).toBe(204);
    expect(await count()).toBe(1); // Initial Kong health changes from false to true.
    await h.sql.query("update cluster_nodes set last_seen_at = now() - interval '1 minute' where cluster_id = $1", [cluster.id]);
    expect((await agent("status", node.nodeToken, report())).status).toBe(204);
    expect(await count()).toBe(1);
    const heartbeat = await h.sql.query("select last_seen_at, reported_at from cluster_nodes where cluster_id = $1", [cluster.id]);
    expect(Date.now() - heartbeat.rows[0].last_seen_at.getTime()).toBeLessThan(5000);
    expect(heartbeat.rows[0].reported_at).toBeInstanceOf(Date);
    const changes = [
      { state: "applying" },
      { state: "applying", appliedVersion: 1 },
      { state: "applying", appliedVersion: 1, failedVersion: 2 },
      { state: "applying", appliedVersion: 1, failedVersion: 2, kongHealthy: false },
    ];
    for (const [index, change] of changes.entries()) {
      expect((await agent("status", node.nodeToken, report(change))).status).toBe(204);
      expect(await count()).toBe(index + 2);
      expect((await agent("status", node.nodeToken, report({ ...change, error: "additional diagnostic", appliedHash: "different-hash" }))).status).toBe(204);
      expect(await count()).toBe(index + 2);
    }
  });

  it("streams a publish across replicas, replays Last-Event-ID, and closes revoked streams", async () => {
    const { envId, cluster, node } = await fixture();
    const controller = new AbortController();
    const stream = await fetch(`${await replica.app.getUrl()}/agent/v1/events`, { headers: { authorization: `Bearer ${node.nodeToken}` }, signal: controller.signal });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    async function until(needle: string) {
      const deadline = setTimeout(() => controller.abort(), 4000);
      try {
        while (!received.includes(needle)) { const chunk = await reader.read(); if (chunk.done) break; received += decoder.decode(chunk.value); }
        expect(received).toContain(needle);
      } finally { clearTimeout(deadline); }
    }
    try {
      await until("event: ping");
      await h.api("POST", `/environments/${envId}/snapshots`, {});
      await until('"version":1');
      expect(received).toContain("event: snapshot.published");
      expect(received).toContain("id: 1");
      await h.api("POST", `/environments/${envId}/services`, { name: "echo", protocol: "http", host: "echo", port: 80 });
      await h.api("POST", `/environments/${envId}/snapshots`, {});
      await until('"version":2');
    } finally { controller.abort(); await reader.cancel().catch(() => {}); }
    const replay = await agent("events", node.nodeToken, undefined, { "last-event-id": "1" });
    const replayReader = replay.body!.getReader();
    let replayed = "";
    try {
      while (!replayed.includes('"version":2')) {
        const chunk = await replayReader.read();
        if (chunk.done) break;
        replayed += decoder.decode(chunk.value);
      }
      expect(replayed).toContain('"version":2');
      expect(replayed).not.toContain('"version":1');
      await h.api("DELETE", `/clusters/${cluster.id}`);
      const ended = await replayReader.read();
      expect(ended.done).toBe(true);
    } finally { await replayReader.cancel(); }
  });
});


describe("agent event keepalive", () => {
  it("sends ping after 15 seconds even with no publish", async () => {
    const { node } = await fixture();
    const controller = new AbortController();
    const stream = await fetch(`${await h.app.getUrl()}/agent/v1/events`, {
      headers: { authorization: `Bearer ${node.nodeToken}` }, signal: controller.signal,
    });
    const reader = stream.body!.getReader();
    const started = Date.now();
    const timeout = setTimeout(() => controller.abort(), 18_000);
    let received = "";
    try {
      while (received.split("event: ping").length < 3) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += new TextDecoder().decode(chunk.value);
      }
      expect(received.split("event: ping")).toHaveLength(3);
      expect(Date.now() - started).toBeGreaterThanOrEqual(14_500);
    } finally { clearTimeout(timeout); controller.abort(); await reader.cancel().catch(() => {}); }
  });
});
