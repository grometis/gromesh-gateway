import { createHash, randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { api, compose, PROXY, publishAndConverge, type Cluster } from "./stack.js";

test("imports a salted basic-auth hash, publishes through the agent, and authenticates the original password on Kong", async () => {
  const suffix = randomUUID();
  const env = await api("POST", "/environments", { name: `hashed-${suffix}` });
  expect(env.status).toBe(201);
  const envId = env.body.id;
  const consumerId = randomUUID();
  const password = "original-migrated-password";
  const passwordHash = createHash("sha1").update(password + consumerId).digest("hex");
  const path = `/hashed-${suffix}`;
  let clusterId: string | undefined;
  let agentStarted = false;
  try {
    const imported = await api<{ errors: unknown[] }>("POST", `/environments/${envId}/import`, {
      sourceFormat: "kong-declarative-3.0", mode: "replace", dryRun: false,
      document: {
        _format_version: "3.0", _transform: false,
        services: [{ name: "echo", host: "echo", port: 80, routes: [{ name: "hashed", paths: [path], plugins: [{ name: "basic-auth", config: {} }] }] }],
        consumers: [{ id: consumerId, username: "migrated", basicauth_credentials: [{ username: "migrated-login", password: passwordHash }] }],
      },
    });
    expect(imported.status).toBe(200);
    expect(imported.body.errors).toEqual([]);
    expect(JSON.stringify(imported.body)).not.toContain(passwordHash);
    expect((await api("GET", `/environments/${envId}/consumers/${consumerId}`)).status).toBe(200);

    const cluster = await api<Cluster>("POST", `/environments/${envId}/clusters`, { name: "compose-hashed" });
    expect(cluster.status).toBe(201);
    clusterId = cluster.body.id;
    agentStarted = true;
    await compose(["up", "-d", "--no-deps", "--force-recreate", "agent"], cluster.body.registrationToken);
    await publishAndConverge(envId, clusterId);

    for (const [supplied, expected] of [[password, 200], ["wrong-password", 401]] as const) {
      const response = await fetch(PROXY + path, {
        headers: { authorization: `Basic ${Buffer.from(`migrated-login:${supplied}`).toString("base64")}` },
        signal: AbortSignal.timeout(3000),
      });
      await response.arrayBuffer();
      expect(response.status).toBe(expected);
    }
  } finally {
    if (agentStarted) await compose(["stop", "agent"]);
    if (clusterId) await api("DELETE", `/clusters/${clusterId}`);
    await api("DELETE", `/environments/${envId}`);
  }
}, 180_000);
