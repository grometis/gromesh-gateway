import { describe, expect, it } from "vitest";

/**
 * W1-C1 acceptance: API → Postgres → compiler → Kong → upstream.
 * Needs the compose stack: `pnpm dev:up` (postgres, kong, echo, control-plane).
 */
const CP = process.env.CP_URL ?? "http://127.0.0.1:3000/api/v1";
const PROXY = process.env.KONG_PROXY_URL ?? "http://127.0.0.1:8000";

async function api<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(CP + path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

describe("walking skeleton", () => {
  it("a route created through the API serves traffic after publish", async () => {
    const run = Date.now().toString(36);
    const env = await api("POST", "/environments", { name: `e2e-${run}` });
    expect(env.status).toBe(201);

    const svc = await api("POST", `/environments/${env.body.id}/services`, { name: "echo", protocol: "http", host: "echo", port: 80 });
    expect(svc.status).toBe(201);

    const path = `/e2e-${run}`;
    const route = await api("POST", `/environments/${env.body.id}/routes`, { name: "echo", serviceId: svc.body.id, paths: [path] });
    expect(route.status).toBe(201);

    const published = await api("POST", `/environments/${env.body.id}/snapshots`, { message: "walking skeleton" });
    expect(published.status, JSON.stringify(published.body)).toBe(201);

    // Kong rebuilds its router asynchronously; give it a moment.
    let res: Response | undefined;
    let text = "";
    for (let i = 0; i < 20; i++) {
      res = await fetch(PROXY + path);
      text = await res.text();
      if (res.status === 200) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(res?.status).toBe(200);
    expect(text).toContain("Hostname");
  });
});
