import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
const nginx = readFileSync(new URL("../nginx.conf", import.meta.url), "utf8");

describe("UI runtime configuration", () => {
  it("uses the nginx namespace and patched 1.30 stable line pinned by digest", () => {
    const runtime = dockerfile.split(/^FROM /m).at(-1)?.split("\n")[0];
    expect(runtime).toMatch(/^nginx\/nginx-unprivileged:1\.30\.(?:[6-9]|[1-9]\d+)-alpine@sha256:[a-f0-9]{64}$/);
  });

  it("upgrades Alpine packages before returning to the unprivileged runtime user", () => {
    expect(dockerfile).toMatch(/USER root\s+RUN apk upgrade --no-cache\b[\s\S]*USER 101:101\s+EXPOSE 8080\b/);
  });

  it.each(["v1", "v2"])("preserves upstream HTTP/1.0 and connection closure for /api/%s/", (version) => {
    const location = new RegExp(`location /api/${version}/ \\{([^}]+)\\}`).exec(nginx)?.[1];
    expect(location).toBeDefined();
    expect(location).toMatch(/\bproxy_pass\s+http:\/\/control-plane:3000\s*;/);
    expect(location).toMatch(/\bproxy_http_version\s+1\.0\s*;/);
    expect(location).toMatch(/\bproxy_set_header\s+Connection\s+"?close"?\s*;/);
  });
});
