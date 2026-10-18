import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { convertKongConfig } from "../src/index.js";

const sample = () => JSON.parse(readFileSync(new URL("../../../contracts/examples/snapshot.example.json", import.meta.url), "utf8")).config;
describe("Kong declarative conversion", () => {
  it("resolves flat source ids into natural references without retaining requested entity ids", () => {
    const { document, errors } = convertKongConfig(sample());
    expect(errors).toEqual([]);
    expect(document.services[0]?.name).toBe("echo");
    expect(document.routes[0]?.service).toBe("echo");
    expect(document.consumers[0]?.keyAuthCredentials[0]?.key).toBe("demo-key-123");
    expect(document.plugins[0]?.scope?.route).toBe("echo-public");
  });
  it("reports unknown entities and nested fields at original paths", () => {
    const config = sample();
    config.vaults = [];
    config.services[0].client_certificate = null;
    const { errors } = convertKongConfig(config);
    expect(errors.map(e => e.path)).toEqual(expect.arrayContaining(["document.vaults", "document.services.0.client_certificate"]));
  });
  it("rejects prehashed basic-auth while accepting plaintext", () => {
    const config = { _format_version: "3.0", _transform: false, consumers: [{ username: "u", basicauth_credentials: [{ username: "b", password: "password" }] }] };
    expect(convertKongConfig(config).errors.map(e => e.path)).toContain("document._transform");
    config._transform = true;
    expect(convertKongConfig(config).document.consumers[0]?.basicAuthCredentials[0]?.password).toBe("password");
  });
});

it("uses Kong's service/JWT defaults and keeps consumer identity namespaces separate", () => {
  const converted = convertKongConfig({ _format_version: "3.0", services: [{ name: "s", host: "echo", protocol: "https" }], consumers: [{ username: "alice", custom_id: "partner" }, { username: "partner", custom_id: "bob", jwt_secrets: [{ key: "issuer", secret: "secret" }] }], plugins: [{ name: "key-auth", consumer: { username: "partner" }, config: {} }] });
  expect(converted.errors).toEqual([]);
  expect(converted.document.services[0]).toMatchObject({ protocol: "https", port: 80 });
  expect(converted.document.plugins[0]?.scope?.consumer).toEqual({ username: "partner", customId: "bob" });
  expect(converted.document.consumers[1]?.jwtCredentials[0]?.algorithm).toBe("HS256");
});

it("maps healthcheck fallback diagnostics to the supplied source fields", () => {
  const converted = convertKongConfig({ _format_version: "3.0", upstreams: [{ name: "pool.test", healthchecks: { active: { type: "tcp", unhealthy: { interval: -1, tcp_failures: 0 } } } }] });
  expect(converted.sourcePath("document.upstreams.0.healthchecks.active.intervalSeconds")).toBe("document.upstreams.0.healthchecks.active.unhealthy.interval");
  expect(converted.sourcePath("document.upstreams.0.healthchecks.active.unhealthyThreshold")).toBe("document.upstreams.0.healthchecks.active.unhealthy.tcp_failures");
});

it("converts nested entities and rejects unsupported fields without losing original paths", () => {
  const config = { _format_version: "3.0", services: [{ id: "source-s", name: "s", host: "echo", routes: [{ name: "r", paths: ["/"], plugins: [{ name: "key-auth", config: {} }] }] }], consumers: [{ username: "u", acls: [{ group: "group" }], keyauth_credentials: [{ key: "some-long-test-key" }], jwt_secrets: [{ key: "issuer", secret: "secret" }], basicauth_credentials: [{ username: "login", password: "password" }] }], upstreams: [{ name: "pool.test", targets: [{ target: "echo:80" }] }], certificates: [{ cert: "cert", key: "key", snis: [{ name: "test.example" }] }] };
  const { document, errors, sourcePath } = convertKongConfig(config);
  expect(errors).toEqual([]);
  expect(document.routes[0]?.service).toBe("s");
  expect(document.plugins[0]?.scope).toEqual({ route: "r" });
  expect(document.consumers[0]?.aclGroups).toEqual(["group"]);
  expect(document.upstreams[0]?.targets[0]?.target).toBe("echo:80");
  expect(document.certificates[0]?.snis).toEqual(["test.example"]);
  expect(sourcePath("document.plugins.0.config.unknown")).toBe("document.services.0.routes.0.plugins.0.config.unknown");
});

it("does not enable omitted healthcheck counters by substituting Gromesh defaults", () => {
  const converted = convertKongConfig({ _format_version: "3.0", upstreams: [{ name: "pool.test", healthchecks: { active: { healthy: { interval: 5, successes: 2 }, unhealthy: { interval: 5, http_failures: 3 } }, passive: { unhealthy: { http_failures: 4 } } } }] });
  expect(converted.errors).toContainEqual(expect.objectContaining({ path: "document.upstreams.0.healthchecks.active.unhealthy" }));
  expect(converted.document.upstreams[0]?.healthchecks?.passive?.unhealthyTimeouts).toBe(0);
});
