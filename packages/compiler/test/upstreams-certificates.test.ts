import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { buildSnapshot, compile, CompileError, diffConfigs, hashConfig, hashIssues, type GatewayState } from "../src/index.js";

const read = (rel: string) => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));
const base = (): GatewayState => read("./fixtures/basic.state.json");
const ajv = new Ajv2020.default({ allErrors: true, strict: false });
addFormats.default(ajv);
const validateEnvelope = ajv.compile(read("../../../contracts/snapshot.schema.json"));

const id = (n: number) => `7b2e4d3f-1c8e-4d2b-8a21-${String(n).padStart(12, "0")}`;
const CERT = "-----BEGIN CERTIFICATE-----\nleaf\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nintermediate\n-----END CERTIFICATE-----\n";
const KEY = "-----BEGIN PRIVATE KEY-----\nsecret-key-material\n-----END PRIVATE KEY-----\n";

function withLbTls(): GatewayState {
  return {
    ...base(),
    upstreams: [
      { id: id(2), name: "orders.upstream", algorithm: "consistent-hashing", hashOn: "header", hashOnHeader: "x-user", hashFallback: "ip", healthchecks: { active: { type: "http", httpPath: "/health", intervalSeconds: 5 }, passive: { unhealthyHttpFailures: 3 } } },
      { id: id(1), name: "echo.upstream" },
    ],
    targets: [
      { id: id(12), upstreamId: id(1), target: "echo:80", weight: 0 },
      { id: id(11), upstreamId: id(1), target: "10.0.0.11:8080" },
      { id: id(13), upstreamId: id(2), target: "[::1]:9000", weight: 65535 },
    ],
    certificates: [{ id: id(21), cert: CERT, key: KEY, snis: ["api.example.com", "*.example.com"] }],
  };
}

describe("compile: upstreams, targets, certificates and SNIs", () => {
  it("emits the Kong entities, tagged, sorted by id, with defaults and hashing only where it applies", () => {
    const cfg = compile(withLbTls());
    expect(cfg.upstreams!.map((u) => u.name)).toEqual(["echo.upstream", "orders.upstream"]);
    expect(cfg.upstreams![0]).toEqual({ id: id(1), name: "echo.upstream", algorithm: "round-robin", tags: ["managed-by:gromesh"] });
    expect(cfg.upstreams![1]).toMatchObject({
      algorithm: "consistent-hashing",
      hash_on: "header",
      hash_on_header: "x-user",
      hash_fallback: "ip",
      healthchecks: {
        active: { type: "http", http_path: "/health", timeout: 1, healthy: { interval: 5, successes: 2 }, unhealthy: { interval: 5, http_failures: 3, tcp_failures: 3, timeouts: 3 } },
        passive: { unhealthy: { http_failures: 3, timeouts: 3 } },
      },
    });
    expect(cfg.upstreams![1]).not.toHaveProperty("hash_on_cookie");
    expect(cfg.targets).toEqual([
      { id: id(11), upstream: id(1), target: "10.0.0.11:8080", weight: 100, tags: ["managed-by:gromesh"] },
      { id: id(12), upstream: id(1), target: "echo:80", weight: 0, tags: ["managed-by:gromesh"] },
      { id: id(13), upstream: id(2), target: "[::1]:9000", weight: 65535, tags: ["managed-by:gromesh"] },
    ]);
    expect(cfg.certificates).toEqual([{ id: id(21), cert: CERT, key: KEY, tags: ["managed-by:gromesh"] }]);
    expect(cfg.snis!.map((s) => s.name).sort()).toEqual(["*.example.com", "api.example.com"]);
    expect(cfg.snis!.every((s) => s.certificate === id(21) && /^[0-9a-f-]{36}$/.test(s.id))).toBe(true);
  });

  it("is deterministic (SNI ids included) and leaves older configs untouched when there is nothing to emit", () => {
    const a = compile(withLbTls());
    const shuffled = withLbTls();
    shuffled.upstreams!.reverse();
    shuffled.targets!.reverse();
    shuffled.certificates![0]!.snis.reverse();
    expect(hashConfig(compile(shuffled))).toBe(hashConfig(a));
    const plain = compile(base());
    for (const key of ["upstreams", "targets", "certificates", "snis"]) expect(plain).not.toHaveProperty(key);
    expect(hashConfig(compile({ ...base(), upstreams: [], targets: [], certificates: [] }))).toBe(hashConfig(plain));
  });

  it("produces envelopes the snapshot schema accepts", () => {
    const snap = buildSnapshot(withLbTls(), { version: 1, environmentId: "00000000-0000-4000-8000-0000000000e1" });
    expect(validateEnvelope(snap), JSON.stringify(validateEnvelope.errors)).toBe(true);
  });

  it("reports every problem: names, targets, weights, duplicates, SNIs and hashing", () => {
    const bad = withLbTls();
    bad.upstreams!.push({ id: id(3), name: "Bad_Name" }, { id: id(4), name: "echo.upstream", algorithm: "round-robin", hashOn: "ip" });
    bad.targets!.push(
      { id: id(14), upstreamId: id(1), target: "echo:80" },
      { id: id(15), upstreamId: id(99), target: "nohost" },
      { id: id(16), upstreamId: id(1), target: "x:70000", weight: 70000 },
    );
    bad.certificates!.push({ id: id(22), cert: CERT, key: KEY, snis: ["api.example.com", "foo.*.example.com"] });
    try {
      compile(bad);
      expect.unreachable();
    } catch (e) {
      const paths = (e as CompileError).issues.map((i) => i.path);
      expect(paths).toEqual(expect.arrayContaining([
        "upstreams[2].name",
        "upstreams[3].name",
        "upstreams[3].hashOn",
        "targets[3].target",
        "targets[4].upstreamId",
        "targets[4].target",
        "targets[5].target",
        "targets[5].weight",
        "certificates[1].snis[0]",
        "certificates[1].snis[1]",
      ]));
    }
  });

  it("checks the hashing rules the contract states", () => {
    const paths = (u: Parameters<typeof hashIssues>[0]) => hashIssues(u, "").map((i) => i.path);
    expect(paths({ algorithm: "consistent-hashing", hashOn: "header" })).toEqual(["hashOnHeader"]);
    expect(paths({ algorithm: "consistent-hashing", hashOn: "cookie", hashOnCookie: "sid", hashFallback: "ip" })).toEqual(["hashFallback"]);
    expect(paths({ algorithm: "consistent-hashing", hashOn: "consumer", hashFallback: "header" })).toEqual(["hashFallbackHeader"]);
    expect(paths({ algorithm: "least-connections", hashFallback: "ip" })).toEqual(["hashFallback"]);
    expect(paths({ algorithm: "consistent-hashing", hashOn: "ip", hashFallback: "consumer" })).toEqual([]);
  });
});

describe("diffConfigs: upstreams, targets, certificates", () => {
  it("labels them, follows SNI changes and never shows the certificate key", () => {
    const before = compile(withLbTls());
    const next = withLbTls();
    next.targets![0]!.weight = 50;
    next.certificates![0]!.snis = ["api.example.com"];
    next.certificates![0]!.key = "-----BEGIN PRIVATE KEY-----\nrotated-key-material\n-----END PRIVATE KEY-----\n";
    next.upstreams = next.upstreams!.filter((u) => u.name !== "orders.upstream");
    next.targets = next.targets!.filter((t) => t.upstreamId !== id(2));
    const changes = diffConfigs(before, compile(next));
    expect(changes.map((c) => `${c.change}:${c.kind}:${c.label}`).sort()).toEqual([
      "modified:certificates:certificate api.example.com",
      "modified:targets:echo:80",
      "removed:targets:[::1]:9000",
      "removed:upstreams:orders.upstream",
    ]);
    const text = JSON.stringify(changes);
    expect(text).not.toContain("secret-key-material");
    expect(text).not.toContain("rotated-key-material");
    expect(diffConfigs(null, compile(withLbTls())).filter((c) => c.kind === "certificates")[0]!.after).toMatchObject({ key: "REDACTED", snis: ["*.example.com", "api.example.com"] });
  });
});
