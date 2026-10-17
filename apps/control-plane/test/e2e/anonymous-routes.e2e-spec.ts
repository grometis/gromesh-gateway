import { expect, it } from "vitest";

const CP = process.env.CP_URL ?? "http://127.0.0.1:3000/api/v1";

it("answers 401 before 404 anonymously while retaining the public login behavior", async () => {
  const unknown = await fetch(`${CP}/does-not-exist`, { signal: AbortSignal.timeout(5000) });
  expect(unknown.status).toBe(401);
  expect(unknown.headers.get("content-type")).toContain("application/problem+json");
  expect(await unknown.json()).toEqual({ type: "https://gromesh.dev/problems/401", title: "Unauthorized", status: 401, detail: "Authentication required" });
  const login = await fetch(`${CP}/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(5000),
  });
  expect(login.status).toBe(422);
});
