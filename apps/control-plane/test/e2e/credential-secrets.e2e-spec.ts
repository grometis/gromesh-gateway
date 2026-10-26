import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { api, compose, PROXY, publishAndConverge, type Cluster } from "./stack.js";

// N1-X6 acceptance against the live compose stack (decision H-14): what an import brings without its key or secret
// authenticates nothing on the real gateway until it is rotated; a rotation's value works once published and the
// previous one stops working.

const b64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");
const hs256 = (iss: string, secret: string) => {
  const input = `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iss, exp: Math.floor(Date.now() / 1000) + 300 }))}`;
  return `${input}.${b64url(createHmac("sha256", secret).update(input).digest())}`;
};

async function status(path: string, headers: Record<string, string> = {}): Promise<number> {
  const res = await fetch(`${PROXY}${path}`, { headers, signal: AbortSignal.timeout(3000) });
  await res.arrayBuffer();
  return res.status;
}

describe("server-generated credential secrets on the real gateway", () => {
  it("keeps an imported key or secret out of Kong until rotated, and retires a rotated one", async () => {
    const env = await api("POST", "/environments", { name: `h14-${Date.now().toString(36)}` });
    expect(env.status).toBe(201);
    const envId = env.body.id;
    let clusterId: string | undefined;
    let agentStarted = false;
    try {
      const cluster = await api<Cluster>("POST", `/environments/${envId}/clusters`, { name: "compose-h14" });
      clusterId = cluster.body.id;
      agentStarted = true;
      await compose(["up", "-d", "--no-deps", "--force-recreate", "agent"], cluster.body.registrationToken);

      const svc = await api("POST", `/environments/${envId}/services`, { name: "echo", protocol: "http", host: "echo", port: 80 });
      for (const [name, plugin] of [["keyed", "key-auth"], ["signed", "jwt"]] as const) {
        const r = await api("POST", `/environments/${envId}/routes`, { name, serviceId: svc.body.id, paths: [`/${name}`] });
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        expect((await api("POST", `/environments/${envId}/plugins`, { name: plugin, scope: { routeId: r.body.id }, config: {} })).status).toBe(201);
      }
      const owner = await api("POST", `/environments/${envId}/consumers`, { username: "owner" });
      const base = `/environments/${envId}/consumers/${owner.body.id}`;
      const created = await api<{ id: string; key: string }>("POST", `${base}/key-auth`, {});
      expect(created.status, JSON.stringify(created.body)).toBe(201);

      // A Kong document carrying its own key and HS256 secret: both are ignored, the credentials come in pending.
      const chosenKey = `chosen-${Date.now().toString(36)}-0123456789abcdef`;
      const chosenSecret = `chosen-secret-${"x".repeat(32)}`;
      const imported = await api<{ pendingCredentials: { credentialType: string; credentialId: string }[] }>("POST", `/environments/${envId}/import`, {
        sourceFormat: "kong-declarative-3.0",
        mode: "merge",
        dryRun: false,
        document: { _format_version: "3.0", consumers: [{ username: "migrated", keyauth_credentials: [{ key: chosenKey }], jwt_secrets: [{ key: "migrated-iss", algorithm: "HS256", secret: chosenSecret }] }] },
      });
      expect(imported.status, JSON.stringify(imported.body)).toBe(200);
      expect(imported.body.pendingCredentials.map((p) => p.credentialType).sort()).toEqual(["jwt", "key-auth"]);
      await publishAndConverge(envId, clusterId);

      expect(await status("/keyed", { apikey: created.body.key })).toBe(200);
      // The document's key and secret never reached the gateway.
      expect(await status("/keyed", { apikey: chosenKey })).toBe(401);
      expect(await status("/signed", { authorization: `Bearer ${hs256("migrated-iss", chosenSecret)}` })).toBe(401);

      // Reprovisioned by an editor: the generated values work once published.
      const migrated = (await api<{ items: { id: string; username: string }[] }>("GET", `/environments/${envId}/consumers`)).body.items.find((c) => c.username === "migrated")!;
      const rotate = async <T>(type: string, id: string) => {
        const res = await api<T>("POST", `/environments/${envId}/consumers/${migrated.id}/${type}/${id}/rotate`);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        return res.body;
      };
      const pendingKey = imported.body.pendingCredentials.find((p) => p.credentialType === "key-auth")!.credentialId;
      const pendingJwt = imported.body.pendingCredentials.find((p) => p.credentialType === "jwt")!.credentialId;
      const key = (await rotate<{ key: string }>("key-auth", pendingKey)).key;
      const secret = (await rotate<{ secret: string }>("jwt", pendingJwt)).secret;
      // The owner's key rotates too: the previous one must stop working.
      const replaced = await api<{ key: string }>("POST", `${base}/key-auth/${created.body.id}/rotate`);
      expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
      await publishAndConverge(envId, clusterId);

      expect(await status("/keyed", { apikey: key })).toBe(200);
      expect(await status("/signed", { authorization: `Bearer ${hs256("migrated-iss", secret)}` })).toBe(200);
      expect(await status("/keyed", { apikey: replaced.body.key })).toBe(200);
      expect(await status("/keyed", { apikey: created.body.key })).toBe(401);
      expect(await status("/keyed", { apikey: chosenKey })).toBe(401);
    } finally {
      if (agentStarted) await compose(["stop", "agent"]);
      if (clusterId) await api("DELETE", `/clusters/${clusterId}`);
      await api("DELETE", `/environments/${envId}`);
    }
  }, 180_000);
});
