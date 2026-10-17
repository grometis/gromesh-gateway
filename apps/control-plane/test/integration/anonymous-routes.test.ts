import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, uniq, type Harness } from "./harness.js";

let h: Harness;
beforeAll(async () => { h = await startHarness(); });
afterAll(async () => { await h?.close(); });

describe("authentication before routing", () => {
  it("returns the existing authentication problem for unknown and protected routes without credentials", async () => {
    const protectedRoute = await h.anonymous("GET", "/me");
    expect(protectedRoute.status).toBe(401);
    expect(protectedRoute.body).toEqual({ type: "https://gromesh.dev/problems/401", title: "Unauthorized", status: 401, detail: "Authentication required" });
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const res = await h.anonymous(method, "/does-not-exist?probe=1");
      expect(res.status, method).toBe(401);
      expect(res.contentType).toContain("application/problem+json");
      expect(res.body).toEqual(protectedRoute.body);
    }
    expect((await h.anonymous("HEAD", "/does-not-exist")).status).toBe(401);
  });

  it("only exempts the public operation's method and exact path", async () => {
    for (const path of ["/auth/login", "/AUTH/LOGIN/", "/auth/login/?probe=1"]) {
      expect((await h.anonymous("POST", path, {})).status).toBe(422);
    }
    for (const path of ["/auth/login/unknown", "/auth/login-extra", "/auth/csrf", "/auth/logout"]) {
      expect((await h.anonymous("POST", path, {})).status).toBe(401);
    }
    expect((await h.anonymous("GET", "/auth/login")).status).toBe(401);
  });

  it("keeps unknown routes at 404 when a session cookie or bearer is presented", async () => {
    expect((await h.api("GET", "/does-not-exist")).status).toBe(404);
    const token = await h.api("POST", "/users/me/tokens", { name: uniq("unknown-route"), role: "viewer", expiresInDays: 1 });
    expect(token.status).toBe(201);
    expect((await h.anonymous("GET", "/does-not-exist", undefined, { authorization: `Bearer ${token.body.token}` })).status).toBe(404);
    // Presence only: credential validation and RBAC remain the guards' job.
    expect((await h.anonymous("GET", "/does-not-exist", undefined, { cookie: "gromesh_session=expired" })).status).toBe(404);
    expect((await h.anonymous("GET", "/does-not-exist", undefined, { authorization: "bEaReR invalid" })).status).toBe(404);
    expect((await h.anonymous("GET", "/me", undefined, { cookie: "gromesh_session=expired" })).status).toBe(401);
    expect((await h.anonymous("GET", "/me", undefined, { authorization: "Bearer invalid" })).status).toBe(401);
  });

  it("does not mistake unrelated cookies or other authorization schemes for credentials", async () => {
    const cases: Record<string, string>[] = [
      { cookie: "other=present; gromesh_session=" },
      { authorization: "Basic invalid" },
      { authorization: "Bearer" },
    ];
    for (const headers of cases) {
      expect((await h.anonymous("GET", "/does-not-exist", undefined, headers)).status).toBe(401);
    }
  });

  it("preserves the health probe and paths outside the API prefix", async () => {
    const base = await h.app.getUrl();
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    for (const path of ["/does-not-exist", "/api/v10/does-not-exist"]) {
      expect((await fetch(base + path)).status).toBe(404);
    }
    for (const path of ["/api/v1", "/api/v1/", "/API/V1/unknown"]) {
      expect((await fetch(base + path)).status).toBe(401);
    }
  });
});
