import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
    // A credential is always secret (422); a string turned secret off opens its stored value, on seals it again.
    expect((await v2(h.api, "PUT", `/workspaces/${a}/variables/API_TOKEN`, { type: "credential", secret: false, required: false })).status).toBe(422);
    await v2(h.api, "PUT", `/workspaces/${a}/variables/NOTE`, { type: "string", secret: true, required: false });
    await v2(h.api, "PUT", `/workspaces/${a}/variables/NOTE/value`, { value: SECRET });
    expect((await v2(h.api, "PUT", `/workspaces/${a}/variables/NOTE`, { type: "string", secret: false, required: false })).status).toBe(200);
    expect((await v2(h.api, "GET", `/workspaces/${a}/variables`)).body.find((v: { name: string }) => v.name === "NOTE").value).toBe(SECRET);
    expect((await v2(h.api, "PUT", `/workspaces/${a}/variables/NOTE`, { type: "string", secret: true, required: false })).status).toBe(200);
    expect((await h.sql.query("select value from workspace_variable_values where workspace_id = $1 and name = 'NOTE'", [a])).rows[0].value).not.toContain(SECRET);
    expect((await h.sql.query("select count(*)::int as n from audit_events where (before::text like $1 or after::text like $1)", [`%${SECRET}%`])).rows[0].n).toBe(0);
  });

  it("checks a value against its type and its declared validation", async () => {
    await v2(h.api, "PUT", `/workspaces/${a}/variables/BASE_URL`, { type: "url", secret: false, required: false });
    await v2(h.api, "PUT", `/workspaces/${a}/variables/REGION`, { type: "string", secret: false, required: false, validation: { pattern: "[a-z]{2}-[a-z]+" } });
    await v2(h.api, "PUT", `/workspaces/${a}/variables/POOL`, { type: "port", secret: false, required: false, validation: { minimum: 1024, maximum: 2048 } });
    await v2(h.api, "PUT", `/workspaces/${a}/variables/SHORT`, { type: "string", secret: false, required: false, validation: { maxLength: 3 } });
    for (const [name, value] of [["ORDERS_PORT", "abc"], ["ORDERS_PORT", "70000"], ["BASE_URL", "ftp://x"], ["REGION", "BR"], ["POOL", "80"], ["POOL", "4000"], ["SHORT", "abcd"]] as const) {
      const res = await v2(h.api, "PUT", `/workspaces/${a}/variables/${name}/value`, { value });
      expect([res.status, res.body.errors?.[0]?.path], `${name}=${value}`).toEqual([422, "value"]);
    }
    expect((await v2(h.api, "PUT", `/workspaces/${a}/variables/REGION/value`, { value: "sa-east" })).status).toBe(204);
    expect((await v2(h.api, "PUT", `/workspaces/${a}/variables/NOT_DECLARED/value`, { value: "x" })).status).toBe(404);
  });

  it("refuses a malformed declaration", async () => {
    expect((await v2(h.api, "PUT", `/workspaces/${a}/variables/X_ONE`, { name: "X_TWO", type: "string", secret: false, required: false })).body.errors[0].path).toBe("name");
    expect((await v2(h.api, "PUT", `/workspaces/${a}/variables/X_ONE`, { type: "string", secret: false, required: false, validation: { pattern: "(" } })).body.errors[0].path).toBe("validation.pattern");
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
});
