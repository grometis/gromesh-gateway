import { describe, expect, it } from "vitest";
import { CompileError, compile, composeWorkspaces, type GatewayState } from "../src/index.js";

// WS-U0: a service written through v2 balances across an upstream only by upstreamId; its host is otherwise plain DNS,
// never captured by an upstream of the same name. A v1 service keeps the binding by name.
const SVC = "6a1f3c2e-0b7d-4c1a-9f10-a00000000001";
const UP = "6a1f3c2e-0b7d-4c1a-9f10-a00000000007";
const base = (service: GatewayState["services"][number]): GatewayState => ({
  services: [service],
  routes: [{ id: "6a1f3c2e-0b7d-4c1a-9f10-a00000000002", name: "r", serviceId: SVC, paths: ["/r"] }],
  consumers: [],
  keyAuthCredentials: [],
  plugins: [],
  upstreams: [{ id: UP, name: "orders" }],
  targets: [{ id: "6a1f3c2e-0b7d-4c1a-9f10-a00000000008", upstreamId: UP, target: "orders.internal.example:8080" }],
});
const host = (state: GatewayState) => composeWorkspaces([{ id: "00000000-0000-4000-8000-0000000000a1", slug: "tvro", state }]).services!.find((s) => s.name === "tvro~svc")!.host;

describe("explicit upstream binding (WS-U0)", () => {
  it("composes a v2 service by its upstreamId and a v2 direct host as DNS; a direct host named like an upstream is refused", () => {
    expect(host(base({ id: SVC, name: "svc", protocol: "http", host: "orders", port: 80, binding: "explicit", upstreamId: UP }))).toBe("orders.tvro.gromesh.internal");
    expect(host({ ...base({ id: SVC, name: "svc", protocol: "http", host: "api.example.com", port: 80, binding: "explicit", upstreamId: null }) })).toBe("api.example.com");
    // Never reachable through the API (the write refuses it); refused here too, whatever the delivery.
    expect(() => host(base({ id: SVC, name: "svc", protocol: "http", host: "orders", port: 80, binding: "explicit", upstreamId: null }))).toThrow(/upstream-captures-service/);
    // v1: the binding by name, unchanged.
    expect(host(base({ id: SVC, name: "svc", protocol: "http", host: "orders", port: 80 }))).toBe("orders.tvro.gromesh.internal");
  });

  it("refuses, in a v1 configuration, an upstream that would capture a v2 service's DNS host", () => {
    const captured = base({ id: SVC, name: "svc", protocol: "http", host: "orders", port: 80, binding: "explicit", upstreamId: null });
    expect(() => compile(captured)).toThrow(CompileError);
    try {
      compile(captured);
    } catch (err) {
      expect((err as CompileError).issues.map((i) => i.path)).toContain("services[0].host");
    }
    expect(() => compile(base({ id: SVC, name: "svc", protocol: "http", host: "orders", port: 80, binding: "explicit", upstreamId: UP }))).not.toThrow();
    expect(() => compile(base({ id: SVC, name: "svc", protocol: "http", host: "orders", port: 80 }))).not.toThrow();
  });

  it("never emits the binding fields to Kong", () => {
    const config = compile(base({ id: SVC, name: "svc", protocol: "http", host: "orders", port: 80, binding: "explicit", upstreamId: UP }));
    expect(JSON.stringify(config.services)).not.toMatch(/binding|upstreamId|upstream_id/);
  });
});
