import { afterAll, beforeAll, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { startHarness, uniq, type Harness } from "./harness.js";

let h: Harness;
beforeAll(async () => { h = await startHarness({ trustProxy: "loopback", clientIpHeader: "CF-Connecting-IP" }); });
afterAll(async () => { await h?.close(); });

it.each([
  { label: "trusted CIDR peer", trustProxy: "127.0.0.0/8", header: "203.0.113.211", expected: "203.0.113.211" },
  { label: "trusted peer alias, IPv6 client", trustProxy: "loopback", header: "2001:db8::211", expected: "2001:db8::211" },
  { label: "all proxies trusted", trustProxy: "true", header: "203.0.113.211", expected: "203.0.113.211" },
  { label: "untrusted TCP peer with a trusted forwarded hop", trustProxy: "192.0.2.0/24", header: "203.0.113.211", expected: "127.0.0.1" },
  { label: "proxy trust disabled", trustProxy: "false", header: "203.0.113.211", expected: "127.0.0.1" },
  { label: "absent header", trustProxy: "loopback", header: undefined, expected: "192.0.2.211" },
  { label: "empty header", trustProxy: "loopback", header: "", expected: "192.0.2.211" },
  { label: "invalid address", trustProxy: "loopback", header: "not-an-ip", expected: "192.0.2.211" },
  { label: "invalid IP octet", trustProxy: "loopback", header: "203.0.113.999", expected: "192.0.2.211" },
  { label: "comma list", trustProxy: "loopback", header: "203.0.113.211, 203.0.113.212", expected: "192.0.2.211" },
  { label: "unset CLIENT_IP_HEADER", trustProxy: "loopback", header: "203.0.113.211", setting: undefined, expected: "192.0.2.211" },
  { label: "empty CLIENT_IP_HEADER", trustProxy: "loopback", header: "203.0.113.211", setting: "", expected: "192.0.2.211" },
])("resolves the client address: $label", async (test) => {
  const config = loadConfig({ DATABASE_URL: "unused", TRUST_PROXY: test.trustProxy, CLIENT_IP_HEADER: "setting" in test ? test.setting : "CF-Connecting-IP" });
  const server = await startHarness({ trustProxy: config.trustProxy, clientIpHeader: config.clientIpHeader });
  const email = `${uniq("client-address")}@example.test`;
  try {
    const headers: Record<string, string> = { "x-forwarded-for": "192.0.2.211" };
    if (test.header !== undefined) headers["cf-connecting-ip"] = test.header;
    expect((await server.anonymous("POST", "/auth/login", { email, password: "wrong-password-123" }, headers)).status).toBe(401);
    const { rows } = await server.sql.query<{ key: string }>("select key from login_attempts where key like $1", [`email_ip:${email}|%`]);
    expect(rows).toEqual([{ key: `email_ip:${email}|${test.expected}` }]);
  } finally {
    await server.sql.query("delete from login_attempts where key like $1", [`%${email}%`]);
    await server.close();
  }
});

it("uses the resolved address for per-address login lockout and login audit events", async () => {
  const server = await startHarness({ trustProxy: "loopback", clientIpHeader: "CF-Connecting-IP", loginMaxFailuresPerIp: 3, loginLockoutMs: 60_000 });
  const ip = "203.0.113.221";
  const from = { "cf-connecting-ip": ip, "x-forwarded-for": "192.0.2.221" };
  const emails: string[] = [];
  try {
    for (let i = 0; i < 3; i++) {
      const email = `${uniq("client-lockout")}@example.test`;
      emails.push(email);
      expect((await server.anonymous("POST", "/auth/login", { email, password: "wrong-password-123" }, from)).status).toBe(401);
    }
    const locked = await server.anonymous("POST", "/auth/login", server.admin, from);
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
    const { rows } = await server.sql.query<{ failures: number; locked_until: Date }>("select failures, locked_until from login_attempts where key = $1", [`ip:${ip}`]);
    expect(rows[0]?.failures).toBe(3);
    expect(rows[0]?.locked_until).not.toBeNull();
    const audit = await server.sql.query<{ ip: string; after: { reason: string } }>("select ip, after from audit_events where action = 'auth.login' and ip = $1", [ip]);
    expect(audit.rows).toHaveLength(4);
    expect(audit.rows.every(event => event.ip === ip)).toBe(true);
    expect(audit.rows).toContainEqual({ ip, after: expect.objectContaining({ reason: "rate_limited" }) });
    expect((await server.anonymous("POST", "/auth/login", server.admin, { ...from, "cf-connecting-ip": "203.0.113.222" })).status).toBe(200);
  } finally {
    await server.sql.query("delete from login_attempts where key like $1 or key = any($2::text[])", [`%${ip}`, emails.map(email => `email:${email}`)]);
    await server.close();
  }
});

it("uses the resolved address for session mutations, API token use and agent audit events", async () => {
  const ip = "203.0.113.231";
  const from = { "cf-connecting-ip": ip, "x-forwarded-for": "192.0.2.231" };
  const owner = await h.as("admin");
  const created = await owner.api<{ id: string; token: string }>("POST", "/users/me/tokens", { name: uniq("client-address"), role: "admin", expiresInDays: 1 }, from);
  expect(created.status).toBe(201);
  const tokenHeaders = { ...from, authorization: `Bearer ${created.body.token}` };
  const env = await h.anonymous<{ id: string }>("POST", "/environments", { name: uniq("client-address") }, tokenHeaders);
  expect(env.status).toBe(201);
  expect((await h.anonymous("GET", "/me", undefined, { ...from, authorization: "Bearer ggt_invalid" })).status).toBe(401);
  const failures = await h.sql.query<{ key: string }>("select key from login_attempts where key = $1", [`bearer-ip:${ip}`]);
  expect(failures.rows).toEqual([{ key: `bearer-ip:${ip}` }]);
  const cluster = await h.api<{ id: string; registrationToken: string }>("POST", `/environments/${env.body.id}/clusters`, { name: "edge" });
  expect(cluster.status).toBe(201);
  const registered = await fetch(`${await h.app.getUrl()}/agent/v1/register`, {
    method: "POST",
    headers: { ...from, authorization: `Bearer ${cluster.body.registrationToken}`, "content-type": "application/json" },
    body: JSON.stringify({ nodeId: "client-address", hostname: "host", kongVersion: "3.9.4", agentVersion: "0.1.0" }),
  });
  expect(registered.status).toBe(200);
  await registered.json();
  expect((await owner.api("POST", "/auth/logout", undefined, from)).status).toBe(204);
  const events = await h.sql.query<{ action: string; ip: string }>(
    "select action, ip from audit_events where (entity_id = $1 and action = 'token.create') or (entity_id = $2 and action = 'environment.create') or (environment_id = $2::uuid and action = 'agent.register') or (entity_id = $3 and action = 'auth.logout')",
    [created.body.id, env.body.id, owner.id],
  );
  expect(events.rows).toEqual(expect.arrayContaining(["token.create", "environment.create", "agent.register", "auth.logout"].map(action => ({ action, ip }))));
  expect(events.rows.every(event => event.ip === ip)).toBe(true);
  const tokenUse = await h.sql.query<{ last_used_at: Date }>("select last_used_at from api_tokens where id = $1", [created.body.id]);
  expect(tokenUse.rows[0]?.last_used_at).toBeInstanceOf(Date);
  const actor = await h.sql.query<{ actor: { via: string; tokenId: string } }>("select actor from audit_events where entity_id = $1 and action = 'environment.create'", [env.body.id]);
  expect(actor.rows[0]?.actor).toMatchObject({ via: "token", tokenId: created.body.id });
});
