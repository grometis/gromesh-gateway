import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
const nginx = readFileSync(new URL("../nginx.conf", import.meta.url), "utf8");

function withoutCommentLines(source: string) {
  return source.split(/\r?\n/).filter((line) => !/^\s*#/.test(line)).join("\n");
}

function finalDockerStage(source: string) {
  const stages = withoutCommentLines(source).split(/^[ \t]*FROM[ \t]+/im);
  expect(stages.length).toBeGreaterThan(1);
  return stages.at(-1) ?? "";
}

function expectRuntimeUser(source: string) {
  const runtime = finalDockerStage(source);
  expect(runtime).toMatch(/^[ \t]*USER root\s+RUN apk upgrade --no-cache\b[\s\S]*^[ \t]*USER 101:101\s+EXPOSE 8080\b/m);
  const users = [...runtime.matchAll(/^[ \t]*USER[ \t]+([^\n]+)/gim)];
  expect(users.at(-1)?.[1]?.trim()).toBe("101:101");
}

function expectProxyDefaults(source: string, version: string) {
  const active = withoutCommentLines(source);
  const location = new RegExp(`^[ \\t]*location\\s+/api/${version}/\\s*\\{([^}]+)\\}`, "m").exec(active)?.[1];
  expect(location).toBeDefined();
  expect(location).toMatch(/^[ \t]*proxy_pass\s+http:\/\/control-plane:3000\s*;/m);
  expect(location).toMatch(/^[ \t]*proxy_http_version\s+1\.0\s*;/m);
  expect(location).toMatch(/^[ \t]*proxy_set_header\s+Connection\s+(?:close|"close")\s*;/m);
}

describe("UI runtime configuration", () => {
  it("uses the nginx namespace and patched 1.30 stable line pinned by digest", () => {
    const runtime = finalDockerStage(dockerfile).split("\n")[0]?.trim();
    expect(runtime).toMatch(/^nginx\/nginx-unprivileged:1\.30\.(?:[6-9]|[1-9]\d+)-alpine@sha256:[a-f0-9]{64}$/);
  });

  it("upgrades Alpine packages before returning to the unprivileged runtime user", () => {
    expectRuntimeUser(dockerfile);
  });

  it.each(["v1", "v2"])("preserves upstream HTTP/1.0 and connection closure for /api/%s/", (version) => {
    expectProxyDefaults(nginx, version);
  });
});

describe("runtime assertion counterexamples", () => {
  const runtime = `FROM build AS build
USER 101:101
FROM runtime
USER root
RUN apk upgrade --no-cache
USER 101:101
EXPOSE 8080
`;

  it.each([
    ["a final USER root", `${runtime}USER root\n`],
    ["a commented runtime user", runtime.replace("\nUSER 101:101\nEXPOSE", "\n  # USER 101:101\nEXPOSE")],
    ["a user only in a previous stage", `${runtime}FROM another-runtime\nEXPOSE 8080\n`],
  ])("rejects %s", (_name, source) => {
    expect(() => expectRuntimeUser(source)).toThrow();
  });

  it("ignores commented Dockerfile instructions", () => {
    expect(() => expectRuntimeUser(`${runtime}  # FROM ignored\n  # USER root\n`)).not.toThrow();
  });

  const proxy = ["v1", "v2"].map((version) => `
location /api/${version}/ {
    proxy_pass http://control-plane:3000;
    proxy_http_version 1.0;
    proxy_set_header Connection close;
}`).join("\n");

  describe.each(["v1", "v2"])("/api/%s/", (version) => {
    it.each(["proxy_http_version 1.0;", "proxy_set_header Connection close;"])(
      "rejects a commented %s even when the other location is correct",
      (directive) => {
        const source = proxy.replace(
          new RegExp(`(location /api/${version}/ \\{[^}]*?)${directive}`),
          `$1# ${directive}`,
        );
        expect(() => expectProxyDefaults(source, version)).toThrow();
      },
    );

    it("rejects a commented location", () => {
      const source = proxy.replace(
        new RegExp(`location /api/${version}/ \\{[^}]+\\}`),
        (location) => location.split("\n").map((line) => `  # ${line}`).join("\n"),
      );
      expect(() => expectProxyDefaults(source, version)).toThrow();
    });

    it("accepts active directives alongside commented alternatives", () => {
      const source = proxy.replaceAll(
        "    proxy_http_version 1.0;",
        "    # proxy_http_version 1.1;\n    # proxy_set_header Connection keep-alive;\n    proxy_http_version 1.0;",
      );
      expect(() => expectProxyDefaults(source, version)).not.toThrow();
    });
  });
});
