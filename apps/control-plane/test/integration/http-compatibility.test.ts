import { afterAll, beforeAll, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { contracts } from "../../src/common/contract.js";
import { startHarness, uniq, type Harness } from "./harness.js";

let h: Harness;
beforeAll(async () => { h = await startHarness({ trustProxy: false }); });
afterAll(async () => { await h?.close(); });

it("validates absent bodies through the contract and preserves the import failure report", async () => {
  const headerCases: Record<string, string>[] = [{}, { "content-type": "application/json" }];
  for (const headers of headerCases) {
    const login = await h.anonymous("POST", "/auth/login", undefined, headers);
    expect(login.status).toBe(422);
    expect(login.contentType).toContain("application/problem+json");
    expect(login.body.errors).toContainEqual(expect.objectContaining({ path: "password" }));
  }
  const env = await h.api<{ id: string }>("POST", "/environments", { name: uniq("empty-body") });
  const response = await h.api("POST", `/environments/${env.body.id}/import`);
  expect(response.status).toBe(422);
  expect(response.contentType).toContain("application/problem+json");
  expect(contracts.validator("EnvironmentImportFailure")(response.body)).toBe(true);
});

it("keeps JSON parsing strict and reports ordinary parser errors as RFC 9457 problems", async () => {
  for (const body of ['"scalar"', "null", "42", '{"email":']) {
    const response = await fetch(`${await h.app.getUrl()}/api/v1/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" }, body,
    });
    expect(response.status, body).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(await response.json()).toMatchObject({ type: "https://gromesh.dev/problems/400", status: 400 });
  }
});

it.each([
  ["false", false],
  ["loopback", true],
  ["192.0.2.0/24", false],
] as const)("honors TRUST_PROXY=%s when recording the client's address", async (setting, forwarded) => {
  const trustProxy = loadConfig({ DATABASE_URL: "unused", TRUST_PROXY: setting }).trustProxy;
  const server = setting === "false" ? h : await startHarness({ trustProxy });
  const email = `${uniq("proxy")}@example.test`;
  try {
    const response = await server.anonymous("POST", "/auth/login", { email, password: "wrong-password-123" }, {
      "x-forwarded-for": "198.51.100.210",
    });
    expect(response.status).toBe(401);
    const { rows } = await h.sql.query<{ key: string }>("select key from login_attempts where key like $1", [`email_ip:${email}|%`]);
    expect(rows.map(row => row.key)).toEqual([`email_ip:${email}|${forwarded ? "198.51.100.210" : "127.0.0.1"}`]);
  } finally {
    await h.sql.query("delete from login_attempts where key like $1 or key = $2", [`%${email}%`, "ip:198.51.100.210"]);
    if (server !== h) await server.close();
  }
});

it("uses Express 5's simple query parser: repeated keys are arrays, bracket keys are refused, after authentication", async () => {
  // Anonymous first: the 401 comes before any query check.
  expect((await h.anonymous("GET", "/audit-events?limit[value]=1")).status).toBe(401);
  const nested = await h.api<{ errors: { path: string }[] }>("GET", "/audit-events?limit[value]=1&cursor[a][b]=x");
  expect(nested.status).toBe(422);
  expect(nested.body.errors).toEqual([
    { path: "limit", message: "must be a single value, not an object" },
    { path: "cursor", message: "must be a single value, not an object" },
  ]);
  // A repeated scalar still reaches the handler as an array and is refused there, as before.
  const repeated = await h.api<{ errors: { path: string }[] }>("GET", "/audit-events?limit=1&limit=2");
  expect(repeated.status).toBe(422);
  expect(repeated.body.errors).toContainEqual(expect.objectContaining({ path: "limit" }));
  expect((await h.api("GET", "/audit-events?limit=1")).status).toBe(200);
});
