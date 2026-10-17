import { createHmac, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { api, compose, PROXY, publishAndConverge, type Cluster, type Entity } from "./stack.js";

// P3-C1 acceptance against the live compose stack: JWT (HS256, RS256, ES256), basic-auth and ACL groups enforced by
// the real gateway, from credentials created through the API.

const b64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");

/** A compact JWT whose `iss` names the credential; ES256 signatures are raw R||S as JOSE requires. */
function jwt(alg: "HS256" | "RS256" | "ES256", iss: string, key: string | KeyObject): string {
  const input = `${b64url(JSON.stringify({ alg, typ: "JWT" }))}.${b64url(JSON.stringify({ iss, exp: Math.floor(Date.now() / 1000) + 300 }))}`;
  const signature =
    alg === "HS256"
      ? createHmac("sha256", key as string).update(input).digest()
      : sign("sha256", Buffer.from(input), alg === "ES256" ? { key: key as KeyObject, dsaEncoding: "ieee-p1363" } : (key as KeyObject));
  return `${input}.${b64url(signature)}`;
}

async function status(path: string, headers: Record<string, string> = {}): Promise<number> {
  const res = await fetch(`${PROXY}${path}`, { headers, signal: AbortSignal.timeout(3000) });
  await res.arrayBuffer();
  return res.status;
}

const basic = (user: string, password: string) => ({ authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}` });

describe("JWT, basic-auth and ACL on the real gateway", () => {
  it("accepts signed tokens and right passwords, refuses wrong ones, and lets only the group through", async () => {
    const env = await api("POST", "/environments", { name: `creds-${Date.now().toString(36)}` });
    expect(env.status).toBe(201);
    const envId = env.body.id;
    let clusterId: string | undefined;
    let agentStarted = false;
    try {
      const cluster = await api<Cluster>("POST", `/environments/${envId}/clusters`, { name: "compose-creds" });
      clusterId = cluster.body.id;
      agentStarted = true;
      await compose(["up", "-d", "--no-deps", "--force-recreate", "agent"], cluster.body.registrationToken);

      const svc = await api("POST", `/environments/${envId}/services`, { name: "echo", protocol: "http", host: "echo", port: 80 });
      const route = async (name: string, plugins: { name: string; config?: unknown }[]) => {
        const r = await api("POST", `/environments/${envId}/routes`, { name, serviceId: svc.body.id, paths: [`/${name}`] });
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        for (const p of plugins) {
          const created = await api("POST", `/environments/${envId}/plugins`, { name: p.name, scope: { routeId: r.body.id }, config: p.config ?? {} });
          expect(created.status, JSON.stringify(created.body)).toBe(201);
        }
      };
      await route("jwt", [{ name: "jwt" }]);
      await route("basic", [{ name: "basic-auth" }]);
      await route("acl", [{ name: "basic-auth" }, { name: "acl", config: { allow: ["gold"] } }]);

      const member = await api("POST", `/environments/${envId}/consumers`, { username: "member" });
      const outsider = await api("POST", `/environments/${envId}/consumers`, { username: "outsider" });
      const credentials = (c: Entity) => `/environments/${envId}/consumers/${c.id}`;

      const hs = await api<{ key: string; secret: string }>("POST", `${credentials(member.body)}/jwt`, { key: "hs-issuer" });
      expect(hs.status, JSON.stringify(hs.body)).toBe(201);
      const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
      const spki = (k: KeyObject) => k.export({ type: "spki", format: "pem" }) as string;
      expect((await api("POST", `${credentials(member.body)}/jwt`, { key: "rs-issuer", algorithm: "RS256", rsaPublicKey: spki(rsa.publicKey) })).status).toBe(201);
      expect((await api("POST", `${credentials(member.body)}/jwt`, { key: "es-issuer", algorithm: "ES256", rsaPublicKey: spki(ec.publicKey) })).status).toBe(201);
      for (const [c, username, password] of [[member.body, "member-user", "member-password"], [outsider.body, "outsider-user", "outsider-password"]] as const) {
        expect((await api("POST", `${credentials(c)}/basic-auth`, { username, password })).status).toBe(201);
      }
      expect((await api("PUT", `${credentials(member.body)}/acl-groups`, { groups: ["gold"] })).status).toBe(200);
      expect((await api("PUT", `${credentials(outsider.body)}/acl-groups`, { groups: ["silver"] })).status).toBe(200);
      await publishAndConverge(envId, clusterId);

      // JWT: HS256 signed with the secret shown once, RS256 and ES256 with the private keys; a wrong signature is 401.
      const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
      expect(await status("/jwt", bearer(jwt("HS256", "hs-issuer", hs.body.secret)))).toBe(200);
      expect(await status("/jwt", bearer(jwt("HS256", "hs-issuer", "a-different-secret-of-32-characters")))).toBe(401);
      expect(await status("/jwt", bearer(jwt("RS256", "rs-issuer", rsa.privateKey)))).toBe(200);
      expect(await status("/jwt", bearer(jwt("RS256", "rs-issuer", generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey)))).toBe(401);
      expect(await status("/jwt", bearer(jwt("ES256", "es-issuer", ec.privateKey)))).toBe(200);
      expect(await status("/jwt")).toBe(401);

      // basic-auth: Kong checks the hash the compiler emitted (the password itself never reached the gateway config).
      expect(await status("/basic", basic("member-user", "member-password"))).toBe(200);
      expect(await status("/basic", basic("member-user", "wrong-password"))).toBe(401);
      expect(await status("/basic")).toBe(401);

      // ACL: allow [gold] lets the member through and refuses the authenticated outsider.
      expect(await status("/acl", basic("member-user", "member-password"))).toBe(200);
      expect(await status("/acl", basic("outsider-user", "outsider-password"))).toBe(403);
    } finally {
      if (agentStarted) await compose(["stop", "agent"]);
      if (clusterId) await api("DELETE", `/clusters/${clusterId}`);
      await api("DELETE", `/environments/${envId}`);
    }
  }, 180_000);
});
