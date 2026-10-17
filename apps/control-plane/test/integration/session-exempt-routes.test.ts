import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const generator = fileURLToPath(new URL("../../../../scripts/generate-session-exempt-routes.mjs", import.meta.url));

describe("contract-generated session exemptions", () => {
  it("fails if the checked-in list diverges from either contract", () => {
    expect(() => execFileSync(process.execPath, [generator, "--check"], { stdio: "pipe" })).not.toThrow();
  });

  it.each([true, false])("honors effective security (global security: %s), methods, base paths and agent operations", (secured) => {
    const dir = mkdtempSync(join(tmpdir(), "gromesh-public-routes-"));
    const output = join(dir, "routes.ts");
    const controlPlane = {
      servers: [{ url: "http://localhost:3000/api/v1" }],
      ...(secured ? { security: [{ cookieAuth: [] }] } : {}),
      paths: {
        "/inherited": { get: { operationId: "inherited" } },
        "/explicit-private": { get: { security: [{ cookieAuth: [] }] } },
        "/public/{id}": {
          parameters: [{ name: "id", in: "path" }],
          post: { security: [] as Record<string, string[]>[] },
          get: { security: [{ cookieAuth: [] }] },
        },
      },
    };
    const agent = { servers: [{ url: "http://localhost:3000" }], security: [{ nodeToken: [] }], paths: { "/agent/v1/status": { post: {} } } };
    try {
      writeFileSync(join(dir, "control-plane.openapi.yaml"), JSON.stringify(controlPlane));
      writeFileSync(join(dir, "agent-protocol.openapi.yaml"), JSON.stringify(agent));
      const args = [generator, "--contracts-dir", dir, "--output", output];
      execFileSync(process.execPath, args);
      const source = readFileSync(output, "utf8");
      const routes: unknown = JSON.parse(source.match(/export const SESSION_EXEMPT_ROUTES = ([\s\S]+) as const;/)![1]!);
      expect(routes).toEqual([
        { method: "POST", path: "/agent/v1/status" },
        ...(!secured ? [{ method: "GET", path: "/api/v1/inherited" }] : []),
        { method: "POST", path: "/api/v1/public/{id}" },
      ]);
      expect(spawnSync(process.execPath, [...args, "--check"]).status).toBe(0);
      // A changed contract must fail check mode without silently rewriting the artifact.
      controlPlane.paths["/public/{id}"].post.security = [{ cookieAuth: [] }];
      writeFileSync(join(dir, "control-plane.openapi.yaml"), JSON.stringify(controlPlane));
      expect(spawnSync(process.execPath, [...args, "--check"]).status).toBe(1);
      expect(readFileSync(output, "utf8")).toBe(source);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
