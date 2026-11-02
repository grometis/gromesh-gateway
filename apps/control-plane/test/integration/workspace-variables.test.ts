import { ADMIN_URL, integrationDatabaseName, createIntegrationDatabase, dropIntegrationDatabase } from "./databases.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/db/migrate.js";
import { releaseContent } from "../../src/releases/releases.js";
import { selfSigned } from "./certs.js";
import { type ApiClient, type ApiResponse, startHarness, uniq, type Harness } from "./harness.js";

// WS-V1 (GW-ENV-05): variables of a workspace. Declarations belong to the draft (gateway.write); values belong to this
// instance (values.write), versioned, checked against the declaration, and a secret one is sealed, never read back and
// never written in clear to the audit.
const v2 = (client: ApiClient, method: string, path: string, body?: unknown): Promise<ApiResponse> => client(method, `/../v2${path}`, body);
const SECRET = "s3cr3t-value-that-must-never-leak";

describe("workspace variables (WS-V1)", () => {
  let h: Harness;
  let a: string;
  let b: string;
  beforeAll(async () => {
    h = await startHarness();
    a = (await h.api("POST", "/environments", { name: uniq("vars-a") })).body.id;
    b = (await h.api("POST", "/environments", { name: uniq("vars-b") })).body.id;
  });
  afterAll(async () => h?.close());

  it("declares in the draft and sets this instance's value, versioned and audited", async () => {
    const declared = await v2(h.api, "PUT", `/workspaces/${a}/variables/ORDERS_PORT`, { type: "port", secret: false, required: true });
    expect(declared.status, JSON.stringify(declared.body)).toBe(200);
    expect(declared.body).toEqual({ name: "ORDERS_PORT", type: "port", secret: false, required: true, hasValue: false, value: null });
    expect((await h.sql.query("select has_unpublished_changes from environments where id = $1", [a])).rows[0].has_unpublished_changes).toBe(true);
    expect((await v2(h.api, "PUT", `/workspaces/${a}/variables/ORDERS_PORT/value`, { value: "8443" })).status).toBe(204);
    expect((await v2(h.api, "PUT", `/workspaces/${a}/variables/ORDERS_PORT/value`, { value: "9443" })).status).toBe(204);
    const [listed] = (await v2(h.api, "GET", `/workspaces/${a}/variables`)).body.filter((v: { name: string }) => v.name === "ORDERS_PORT");
    expect(listed).toMatchObject({ hasValue: true, value: "9443" });
    expect((await h.sql.query("select version from workspace_variable_values where workspace_id = $1 and name = 'ORDERS_PORT' order by version", [a])).rows.map((r) => r.version)).toEqual([1, 2]);
    expect((await h.sql.query("select count(*)::int as n from audit_events where action = 'workspace_variable.value.set' and environment_id = $1", [a])).rows[0].n).toBe(2);
  });

  it("seals a secret value, never reads it back and never audits it in clear", async () => {
    expect((await v2(h.api, "PUT", `/workspaces/${a}/variables/API_TOKEN`, { type: "credential", secret: true, required: false })).status).toBe(200);
    expect((await v2(h.api, "PUT", `/workspaces/${a}/variables/API_TOKEN/value`, { value: SECRET })).status).toBe(204);
    const [listed] = (await v2(h.api, "GET", `/workspaces/${a}/variables`)).body.filter((v: { name: string }) => v.name === "API_TOKEN");
    expect(listed).toMatchObject({ secret: true, hasValue: true, value: "REDACTED" });
    const [row] = (await h.sql.query("select value, sealed from workspace_variable_values where workspace_id = $1 and name = 'API_TOKEN'", [a])).rows;
    expect(row.sealed).toBe(true);
    expect(row.value).not.toContain(SECRET);
    expect((await h.sql.query("select count(*)::int as n from audit_events where (before::text like $1 or after::text like $1)", [`%${SECRET}%`])).rows[0].n).toBe(0);
    // A credential is always secret (422). Turning a secret string off never reveals what was set while secret (the
    // declaration needs only gateway.write, the value values.write): the sealed value stays sealed and REDACTED.
    expect((await v2(h.api, "PUT", `/workspaces/${a}/variables/API_TOKEN`, { type: "credential", secret: false, required: false })).status).toBe(422);
    await v2(h.api, "PUT", `/workspaces/${a}/variables/NOTE`, { type: "string", secret: true, required: false });
    await v2(h.api, "PUT", `/workspaces/${a}/variables/NOTE/value`, { value: SECRET });
    const off = await v2(h.api, "PUT", `/workspaces/${a}/variables/NOTE`, { type: "string", secret: false, required: false });
    expect([off.status, off.body.value]).toEqual([200, "REDACTED"]);
    expect((await v2(h.api, "GET", `/workspaces/${a}/variables`)).body.find((v: { name: string }) => v.name === "NOTE").value).toBe("REDACTED");
    expect((await h.sql.query("select value from workspace_variable_values where workspace_id = $1 and name = 'NOTE'", [a])).rows[0].value).not.toContain(SECRET);
    // A value set while not secret reads back; turning secret on seals it.
    await v2(h.api, "PUT", `/workspaces/${a}/variables/NOTE/value`, { value: "visible" });
    expect((await v2(h.api, "GET", `/workspaces/${a}/variables`)).body.find((v: { name: string }) => v.name === "NOTE").value).toBe("visible");
    await v2(h.api, "PUT", `/workspaces/${a}/variables/NOTE`, { type: "string", secret: true, required: false });
    expect((await h.sql.query("select bool_and(sealed) as all_sealed from workspace_variable_values where workspace_id = $1 and name = 'NOTE'", [a])).rows[0].all_sealed).toBe(true);
    // Deleted and declared again as secret: the values kept in clear are sealed too.
    await v2(h.api, "PUT", `/workspaces/${a}/variables/AGAIN`, { type: "string", secret: false, required: false });
    await v2(h.api, "PUT", `/workspaces/${a}/variables/AGAIN/value`, { value: "plain-before" });
    await v2(h.api, "DELETE", `/workspaces/${a}/variables/AGAIN`);
    await v2(h.api, "PUT", `/workspaces/${a}/variables/AGAIN`, { type: "string", secret: true, required: false });
    expect((await h.sql.query("select sealed, value from workspace_variable_values where workspace_id = $1 and name = 'AGAIN'", [a])).rows.map((r) => [r.sealed, r.value.includes("plain-before")])).toEqual([[true, false]]);
    expect((await v2(h.api, "PUT", `/workspaces/${a}/variables/NOTE/value`, { value: "" })).status).toBe(422);
    // An empty plain value kept when the variable turns secret stays unsealed (REDACTED) and never blocks a rotation.
    await v2(h.api, "PUT", `/workspaces/${a}/variables/EMPTY`, { type: "string", secret: false, required: false });
    expect((await v2(h.api, "PUT", `/workspaces/${a}/variables/EMPTY/value`, { value: "" })).status).toBe(204);
    expect((await v2(h.api, "PUT", `/workspaces/${a}/variables/EMPTY`, { type: "string", secret: true, required: false })).body.value).toBe("REDACTED");
    expect((await h.sql.query("select count(*)::int as n from audit_events where (before::text like $1 or after::text like $1)", [`%${SECRET}%`])).rows[0].n).toBe(0);
  });

  it("checks a value against its type and its declared validation", async () => {
    await v2(h.api, "PUT", `/workspaces/${a}/variables/BASE_URL`, { type: "url", secret: false, required: false });
    await v2(h.api, "PUT", `/workspaces/${a}/variables/REGION`, { type: "string", secret: false, required: false, validation: { pattern: "[a-z]{2}-[a-z]+" } });
    await v2(h.api, "PUT", `/workspaces/${a}/variables/POOL`, { type: "port", secret: false, required: false, validation: { minimum: 1024, maximum: 2048 } });
    await v2(h.api, "PUT", `/workspaces/${a}/variables/SHORT`, { type: "string", secret: false, required: false, validation: { maxLength: 3 } });
    await v2(h.api, "PUT", `/workspaces/${a}/variables/TLS_CERT`, { type: "certificate", secret: false, required: false });
    await v2(h.api, "PUT", `/workspaces/${a}/variables/EDGE`, { type: "host", secret: false, required: false });
    for (const [name, value] of [["ORDERS_PORT", "abc"], ["ORDERS_PORT", "70000"], ["BASE_URL", "ftp://x"], ["REGION", "BR"], ["POOL", "80"], ["POOL", "4000"], ["SHORT", "abcd"],
      ["TLS_CERT", "-----BEGIN CERTIFICATE-----garbage"], ["EDGE", "[::::]"], ["EDGE", "-bad-.example"], ["EDGE", "bad-.example"]] as const) {
      const res = await v2(h.api, "PUT", `/workspaces/${a}/variables/${name}/value`, { value });
      expect([res.status, res.body.errors?.[0]?.path], `${name}=${value}`).toEqual([422, "value"]);
    }
    expect((await v2(h.api, "PUT", `/workspaces/${a}/variables/REGION/value`, { value: "sa-east" })).status).toBe(204);
    // A pattern the heuristic lets through still cannot hold the server: the match is cut at its deadline.
    await v2(h.api, "PUT", `/workspaces/${a}/variables/SLOW`, { type: "string", secret: false, required: false, validation: { pattern: "a*a*a*a*a*a*a*a*c" } });
    const started = Date.now();
    const slow = await v2(h.api, "PUT", `/workspaces/${a}/variables/SLOW/value`, { value: `${"a".repeat(40)}b` });
    expect([slow.status, slow.body.errors?.[0]?.message]).toEqual([422, "the declared pattern took too long on this value"]);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect((await v2(h.api, "PUT", `/workspaces/${a}/variables/TLS_CERT/value`, { value: selfSigned("api.example.com").cert })).status).toBe(204);
    for (const host of ["[2001:db8::1]", "10.0.0.1", "api.example.com"]) expect((await v2(h.api, "PUT", `/workspaces/${a}/variables/EDGE/value`, { value: host })).status, host).toBe(204);
    expect((await v2(h.api, "PUT", `/workspaces/${a}/variables/NOT_DECLARED/value`, { value: "x" })).status).toBe(404);
  });

  it("refuses a malformed declaration", async () => {
    expect((await v2(h.api, "PUT", `/workspaces/${a}/variables/X_ONE`, { name: "X_TWO", type: "string", secret: false, required: false })).body.errors[0].path).toBe("name");
    for (const pattern of ["(", "(a+)+$", "(a|aa)+", "(x)\\1"]) {
      expect((await v2(h.api, "PUT", `/workspaces/${a}/variables/X_ONE`, { type: "string", secret: false, required: false, validation: { pattern } })).body.errors?.[0]?.path, pattern).toBe("validation.pattern");
    }
    expect((await v2(h.api, "PUT", `/workspaces/${a}/variables/X_ONE`, { type: "number", secret: false, required: false })).status).toBe(422);
    expect((await v2(h.api, "PUT", `/workspaces/${a}/variables/lower`, { type: "string", secret: false, required: false })).status).toBe(404);
  });

  it("keeps each workspace's variables and values apart", async () => {
    expect((await v2(h.api, "GET", `/workspaces/${b}/variables`)).body).toEqual([]);
    expect((await v2(h.api, "PUT", `/workspaces/${b}/variables/ORDERS_PORT/value`, { value: "1" })).status).toBe(404);
    expect((await v2(h.api, "PUT", `/workspaces/${b}/variables/ORDERS_PORT`, { type: "string", secret: false, required: false })).status).toBe(200);
    expect((await v2(h.api, "GET", `/workspaces/${a}/variables`)).body.find((v: { name: string }) => v.name === "ORDERS_PORT").type).toBe("port");
    expect((await v2(h.api, "GET", `/workspaces/${b}/variables`)).body).toEqual([{ name: "ORDERS_PORT", type: "string", secret: false, required: false, hasValue: false, value: null }]);
  });

  it("separates declaring (gateway.write) from setting values (values.write)", async () => {
    const viewer = await h.as("viewer");
    expect((await v2(viewer.api, "PUT", `/workspaces/${a}/variables/V_ONE`, { type: "string", secret: false, required: false })).status).toBe(403);
    // A v1 editor (publisher) declares but holds no values.write.
    const editor = await h.as("editor");
    expect((await v2(editor.api, "PUT", `/workspaces/${a}/variables/V_ONE`, { type: "string", secret: false, required: false })).status).toBe(200);
    expect((await v2(editor.api, "PUT", `/workspaces/${a}/variables/V_ONE/value`, { value: "x" })).status).toBe(403);
    expect((await v2(viewer.api, "GET", `/workspaces/${a}/variables`)).status).toBe(200);
  });

  it("deletes the declaration only: this instance's values stay", async () => {
    await v2(h.api, "PUT", `/workspaces/${a}/variables/GONE`, { type: "string", secret: false, required: false });
    await v2(h.api, "PUT", `/workspaces/${a}/variables/GONE/value`, { value: "kept" });
    expect((await v2(h.api, "DELETE", `/workspaces/${a}/variables/GONE`)).status).toBe(204);
    expect((await v2(h.api, "DELETE", `/workspaces/${a}/variables/GONE`)).status).toBe(404);
    expect((await v2(h.api, "GET", `/workspaces/${a}/variables`)).body.map((v: { name: string }) => v.name)).not.toContain("GONE");
    expect((await h.sql.query("select count(*)::int as n from workspace_variable_values where workspace_id = $1 and name = 'GONE'", [a])).rows[0].n).toBe(1);
  });

  it("carries the declarations (never a value) in the release content", () => {
    const state = { services: [], routes: [], consumers: [], plugins: [], upstreams: [], targets: [], certificates: [], keyAuthCredentials: [], jwtCredentials: [], basicAuthCredentials: [],
      variables: [{ name: "API_TOKEN", type: "credential", secret: true, required: true }, { name: "REGION", type: "string", secret: false, required: false, validation: { pattern: "[a-z]+" } }] };
    const enc = { fingerprint: (s: string) => s } as never;
    const content = releaseContent(state as never, enc, { mapSecrets: (_: string, c: unknown) => c } as never);
    expect(content.variables).toEqual(state.variables);
    expect(JSON.stringify(content)).not.toContain(SECRET);
  });
});

describe("values of a deleted declaration end with the next release (WS-V1)", () => {
  const name = integrationDatabaseName("wsv1");
  let h: Harness;
  beforeAll(async () => {
    await createIntegrationDatabase(name);
    const url = new URL(ADMIN_URL);
    url.pathname = `/${name}`;
    await runMigrations(url.toString());
    // Publishing a release needs only the stage (decision D4); it deploys nothing.
    h = await startHarness({ databaseUrl: url.toString(), instanceStage: "dev" });
  });
  afterAll(async () => {
    await h?.close();
    await dropIntegrationDatabase(name);
  });

  it("keeps a deleted variable's values until a release without it is published, then purges them (names audited)", async () => {
    const ws = (await h.api("POST", "/environments", { name: uniq("purge") })).body.id as string;
    await v2(h.api, "PUT", `/workspaces/${ws}/variables/KEEP`, { type: "string", secret: false, required: false });
    await v2(h.api, "PUT", `/workspaces/${ws}/variables/KEEP/value`, { value: "k" });
    await v2(h.api, "PUT", `/workspaces/${ws}/variables/DROP_ME`, { type: "string", secret: true, required: false });
    await v2(h.api, "PUT", `/workspaces/${ws}/variables/DROP_ME/value`, { value: SECRET });
    const first = await v2(h.api, "POST", `/workspaces/${ws}/releases`, { message: "with both" });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect((await v2(h.api, "DELETE", `/workspaces/${ws}/variables/DROP_ME`)).status).toBe(204);
    const count = async (n: string) => (await h.sql.query("select count(*)::int as n from workspace_variable_values where workspace_id = $1 and name = $2", [ws, n])).rows[0].n;
    expect(await count("DROP_ME")).toBe(1);
    expect((await v2(h.api, "POST", `/workspaces/${ws}/releases`, { message: "without DROP_ME" })).status).toBe(201);
    expect([await count("DROP_ME"), await count("KEEP")]).toEqual([0, 1]);
    const [event] = (await h.sql.query("select after from audit_events where action = 'workspace_variable.value.purge' and environment_id = $1", [ws])).rows;
    expect(event.after.names).toEqual(["DROP_ME"]);
    expect(JSON.stringify(event.after)).not.toContain(SECRET);
  });
});
