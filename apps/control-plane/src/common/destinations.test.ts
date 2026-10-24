import { expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { destinationIssues, destinationPolicy, forbiddenReason, targetHost } from "./destinations.js";

const policy = destinationPolicy(
  loadConfig({
    DATABASE_URL: "postgres://gromesh:secret@postgres:5432/gromesh",
    KONG_VALIDATOR_URL: "http://kong-validator:8001",
    CLICKHOUSE_URL: "http://clickhouse.analytics.svc.cluster.local:8123",
    PLATFORM_HTTP_LOG_ENDPOINT: "http://gromesh-collector:8080/kong",
    FORBIDDEN_DESTINATIONS: "vault, *.corp.internal, 10.9.0.0/16, 192.0.2.7, kubernetes",
  }),
);

it.each([
  "127.0.0.1", "127.255.255.254", "LOCALHOST", "localhost.", "api.localhost", "0.0.0.0", "::", "::1", "[::1]",
  "::ffff:127.0.0.1", "::ffff:7f00:1", "::127.0.0.1", "169.254.169.254", "169.254.0.1", "fe80::1", "fd00:ec2::254",
  "127.1", "2130706433", "0x7f000001", "0177.0.0.1", "127.0.0.01",
])("refuses the loopback, link-local or ambiguous numeric host %s", (host) => {
  expect(forbiddenReason(host, policy)).not.toBeNull();
});

it.each([
  "kong-validator", "kong-validator.gromesh", "kong-validator.gromesh.svc", "kong-validator.gromesh.svc.cluster.local",
  "postgres", "Postgres.gromesh.svc.cluster.local.", "clickhouse.analytics.svc.cluster.local", "gromesh-collector",
  "vault", "secrets.corp.internal", "10.9.4.2", "192.0.2.7", "kubernetes.default", "kubernetes.default.svc.cluster.local",
])("refuses the installation's internal host %s", (host) => {
  expect(forbiddenReason(host, policy)).toMatch(/internal/);
});

it.each([
  "orders.internal", "httpbin.gromesh-test.svc.cluster.local", "10.0.0.11", "192.168.15.3", "2001:db8::1",
  "postgres.example.com", "kong-validator-docs.example.com", "echo", "e2e-pool.upstream", "corp.internal.example",
])("accepts the ordinary destination %s", (host) => {
  expect(forbiddenReason(host, policy)).toBeNull();
});

it("takes the host out of a target, IPv6 in brackets", () => {
  expect(targetHost("[::1]:8001")).toBe("[::1]");
  expect(targetHost("echo:80")).toBe("echo");
});

it("reports every forbidden destination of a state with the compiler's path style", () => {
  const ids = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const issues = destinationIssues(
    {
      services: [
        { id: ids(1), name: "ok", protocol: "http", host: "orders.internal", port: 80 },
        { id: ids(2), name: "admin", protocol: "http", host: "127.0.0.1", port: 8001 },
      ],
      routes: [],
      consumers: [],
      keyAuthCredentials: [],
      plugins: [],
      upstreams: [{ id: ids(3), name: "localhost" }],
      targets: [{ id: ids(4), upstreamId: ids(3), target: "[::1]:8001" }],
    },
    policy,
  );
  expect(issues.map((i) => i.path)).toEqual(["services[1].host", "upstreams[0].name", "targets[0].target"]);
});
