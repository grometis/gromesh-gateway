import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { DEV_USER } from "../../src/auth/auth.js";
import { startHarness } from "./harness.js";

describe("temporary dev authentication (until week 5)", () => {
  it("is disabled by default and for every mode except dev", async () => {
    for (const mode of [undefined, "production", "DEV"]) {
      const config = loadConfig({ DATABASE_URL: "unused", AUTH_MODE: mode });
      const h = await startHarness({ authMode: config.authMode });
      try {
        expect((await h.api("POST", "/auth/login", { email: "someone@example.com", password: "secret" })).status).toBe(404);
        expect((await h.api("POST", "/auth/login", {})).status).toBe(404);
        expect((await h.api("GET", "/me")).status).toBe(401);
      } finally {
        await h.close();
      }
    }
  });

  it("accepts arbitrary contract-valid credentials publicly and returns the built-in admin", async () => {
    const h = await startHarness({ authMode: "dev" });
    try {
      const first = await h.api("POST", "/auth/login", { email: "anyone@example.com", password: "any-password" });
      const second = await h.api("POST", "/auth/login", { email: "other@example.com", password: "" });
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(first.body).toMatchObject({ expiresIn: 3600, user: DEV_USER });
      expect(first.body.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(second.body.accessToken).not.toBe(first.body.accessToken);
      expect(first.body.user).toMatchObject({ email: "admin@gromesh.dev", active: true });
      expect(Number.isNaN(Date.parse(first.body.user.createdAt))).toBe(false);
      expect(Number.isNaN(Date.parse(first.body.user.updatedAt))).toBe(false);
      const me = await h.api("GET", "/me");
      expect(me.status).toBe(200);
      expect(me.body).toEqual(first.body.user);
      const audit = JSON.stringify((await h.sql.query("select * from audit_events")).rows);
      for (const secret of ["anyone@example.com", "any-password", "other@example.com", first.body.accessToken, second.body.accessToken]) {
        expect(audit.includes(secret)).toBe(false);
      }
    } finally {
      await h.close();
    }
  });

  it("validates credentials with the contract", async () => {
    const h = await startHarness({ authMode: "dev" });
    try {
      const missing = await h.api("POST", "/auth/login", {});
      expect(missing.status).toBe(422);
      expect(missing.body.errors).toContainEqual(expect.objectContaining({ path: "password" }));
      expect((await h.api("POST", "/auth/login", { email: "invalid", password: "test" })).status).toBe(422);
    } finally {
      await h.close();
    }
  });
});
