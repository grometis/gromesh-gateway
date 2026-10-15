import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildSnapshot,
  compile,
  CompileError,
  diffConfigs,
  hashConfig,
  type GatewayState,
} from "../src/index.js";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const load = (): GatewayState => JSON.parse(readFileSync(fixture("basic.state.json"), "utf8"));
const contractExample = fileURLToPath(new URL("../../../contracts/examples/snapshot.example.json", import.meta.url));

const uuid = (n: number) => `6a1f3c2e-0b7d-4c1a-9f10-${String(n).padStart(12, "0")}`;

describe("compile", () => {
  it("emits Kong 3.0 flat declarative config with string foreign keys", () => {
    const cfg = compile(load());
    expect(cfg._format_version).toBe("3.0");
    expect(cfg.routes[0]).toMatchObject({ name: "echo-public", service: uuid(1), strip_path: true, methods: ["GET", "POST"] });
    expect(cfg.keyauth_credentials[0]).toMatchObject({ consumer: uuid(3), key: "demo-key-123" });
    expect(cfg.plugins.find((p) => p.name === "key-auth")).toMatchObject({ route: uuid(2), enabled: true });
    expect(cfg.plugins.find((p) => p.name === "rate-limiting")).toMatchObject({ service: uuid(1) });
  });

  it("tags every entity as managed by Gromesh and keeps own tags sorted", () => {
    const cfg = compile(load());
    expect(cfg.services[0]!.tags).toEqual(["managed-by:gromesh", "team:platform"]);
    for (const kind of ["services", "routes", "consumers", "keyauth_credentials", "plugins"] as const) {
      for (const e of cfg[kind]) expect(e.tags).toContain("managed-by:gromesh");
    }
  });

  it("omits unset optional fields so Kong applies its defaults", () => {
    const cfg = compile(load());
    expect(cfg.services[0]).not.toHaveProperty("retries");
    expect(cfg.consumers[0]).not.toHaveProperty("custom_id");
  });

  it("is deterministic regardless of input order", () => {
    const a = load();
    const b = load();
    b.plugins.reverse();
    expect(hashConfig(compile(a))).toBe(hashConfig(compile(b)));
  });

  it("injects platform plugins as global plugins", () => {
    const cfg = compile(load(), {
      platformPlugins: [{ id: uuid(99), name: "prometheus", config: { per_consumer: false } }],
    });
    const prom = cfg.plugins.find((p) => p.name === "prometheus");
    expect(prom).toBeDefined();
    expect(prom).not.toHaveProperty("service");
    expect(prom).not.toHaveProperty("route");
  });

  it("reports every problem at once", () => {
    const s = load();
    s.routes.push({ id: "not-a-uuid", name: "echo-public", serviceId: uuid(42) });
    s.services[0]!.port = 70000;
    s.keyAuthCredentials.push({ id: uuid(7), consumerId: uuid(3), key: "demo-key-123" });
    s.plugins.push({ id: uuid(8), name: "key-auth", scope: { routeId: uuid(2) } });
    try {
      compile(s);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CompileError);
      const paths = (err as CompileError).issues.map((i) => i.path);
      expect(paths).toEqual(
        expect.arrayContaining([
          "services[0].port",
          "routes[1].id",
          "routes[1].name",
          "routes[1].serviceId",
          "routes[1]",
          "keyAuthCredentials[1].key",
          "plugins[2]",
        ]),
      );
    }
  });
});

describe("snapshot", () => {
  it("matches the contract example (keeps contracts/examples honest)", () => {
    const snap = buildSnapshot(load(), {
      version: 1,
      environmentId: "00000000-0000-4000-8000-0000000000e1",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const example = JSON.parse(readFileSync(contractExample, "utf8"));
    expect(snap).toEqual(example);
    expect(snap.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("diffConfigs", () => {
  it("lists added, modified and removed entities and never exposes keys", () => {
    const before = compile(load());
    const next = load();
    next.routes[0]!.paths = ["/echo", "/v2/echo"];
    next.keyAuthCredentials[0]!.key = "rotated-key";
    next.plugins = next.plugins.filter((p) => p.name !== "rate-limiting");
    next.consumers.push({ id: uuid(10), username: "partner" });
    const changes = diffConfigs(before, compile(next));

    const summary = changes.map((c) => `${c.change}:${c.kind}:${c.label}`).sort();
    expect(summary).toEqual([
      "added:consumers:partner",
      `modified:keyauth_credentials:key-auth credential of consumer ${uuid(3)}`,
      "modified:routes:echo-public",
      "removed:plugins:rate-limiting",
    ]);
    expect(JSON.stringify(changes)).not.toContain("rotated-key");
    expect(JSON.stringify(changes)).not.toContain("demo-key-123");
  });

  it("treats a first publish as all-added", () => {
    const changes = diffConfigs(null, compile(load()));
    expect(changes.every((c) => c.change === "added")).toBe(true);
    expect(changes).toHaveLength(6);
  });
});
