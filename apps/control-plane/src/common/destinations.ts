import { BlockList, isIP } from "node:net";
import type { GatewayState } from "@gromesh/compiler";
import type { AppConfig } from "../config.js";
import { unprocessable, type FieldError } from "./problem.js";

/**
 * Destinations proxied traffic must never reach (contract: "Forbidden destinations"). A route to 127.0.0.1:8001
 * would expose the data plane's own Admin API; link-local hosts the cloud metadata service. DNS is not resolved
 * here: a name that resolves to these addresses is the data plane's job (no privileged TCP listener there).
 */
const ALWAYS = new BlockList();
ALWAYS.addSubnet("127.0.0.0", 8, "ipv4");
ALWAYS.addAddress("0.0.0.0", "ipv4");
ALWAYS.addSubnet("169.254.0.0", 16, "ipv4");
// ::/96 covers ::, ::1 and the deprecated IPv4-compatible form (::127.0.0.1); IPv4-mapped (::ffff:a.b.c.d) is
// matched by BlockList against the IPv4 rules above.
ALWAYS.addSubnet("::", 96, "ipv6");
ALWAYS.addSubnet("fe80::", 10, "ipv6");
ALWAYS.addAddress("fd00:ec2::254", "ipv6");

export interface DestinationPolicy {
  names: Set<string>;
  suffixes: string[];
  addresses: BlockList;
}

function normalize(host: string): string {
  return host.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
}

function urlHost(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return normalize(new URL(url).hostname) || null;
  } catch {
    return null;
  }
}

/** The installation's internal hosts (validator, database, ClickHouse, collector) plus FORBIDDEN_DESTINATIONS. */
export function destinationPolicy(config: AppConfig): DestinationPolicy {
  const policy: DestinationPolicy = { names: new Set(), suffixes: [], addresses: new BlockList() };
  const own = [config.kongValidatorUrl, config.databaseUrl, config.clickhouse?.url, config.platformHttpLogEndpoint].map(urlHost);
  for (const entry of [...own, ...config.forbiddenDestinations.map(normalize)]) {
    if (!entry) continue;
    const [address, bits] = entry.split("/");
    const family = isIP(address!);
    if (family && bits !== undefined) policy.addresses.addSubnet(address!, Number(bits), family === 4 ? "ipv4" : "ipv6");
    else if (family) policy.addresses.addAddress(address!, family === 4 ? "ipv4" : "ipv6");
    else if (entry.startsWith("*.")) policy.suffixes.push(entry.slice(1));
    else policy.names.add(entry);
  }
  return policy;
}

/** Why `host` is a forbidden destination, or null when it is allowed. */
export function forbiddenReason(host: string, policy: DestinationPolicy): string | null {
  const h = normalize(host);
  const family = isIP(h);
  if (family) {
    const type = family === 4 ? "ipv4" : "ipv6";
    if (ALWAYS.check(h, type)) return "must not be a loopback, unspecified or link-local address";
    if (policy.addresses.check(h, type)) return "must not be an internal address of this installation";
    return null;
  }
  // Resolvers differ on 127.1, 2130706433, 0x7f000001 or 0177.0.0.1; only canonical dotted quads are addresses.
  if (/^(0x[0-9a-f]+|[0-9]+)(\.(0x[0-9a-f]+|[0-9]+))*$/.test(h)) return "must be a canonical IPv4 address or a host name";
  if (h === "localhost" || h.endsWith(".localhost")) return "must not be a loopback name";
  for (const name of policy.names) {
    // Kubernetes short names also resolve as <name>.<namespace>[.svc[.<cluster domain>]].
    if (h === name || (!name.includes(".") && h.startsWith(`${name}.`) && (h.split(".").length === 2 || /\.svc(\.|$)/.test(h)))) {
      return "must not be an internal host of this installation";
    }
  }
  if (policy.suffixes.some((s) => h.endsWith(s))) return "must not be an internal host of this installation";
  return null;
}

/** Host part of a target (`host:port`, IPv6 in brackets). */
export function targetHost(target: string): string {
  return target.replace(/:[0-9]{1,5}$/, "");
}

export function assertDestination(path: string, host: string, policy: DestinationPolicy, what: string): void {
  const reason = forbiddenReason(host, policy);
  if (reason) throw unprocessable(`Invalid ${what}`, [{ path, message: `${reason} (forbidden destination)` }]);
}

/** Forbidden destinations of a whole state, with the compiler's path style (`services[0].host`). */
export function destinationIssues(state: GatewayState, policy: DestinationPolicy): FieldError[] {
  const issues: FieldError[] = [];
  const check = (path: string, host: string) => {
    const reason = forbiddenReason(host, policy);
    if (reason) issues.push({ path, message: `${reason} (forbidden destination)` });
  };
  state.services.forEach((s, i) => check(`services[${i}].host`, s.host));
  (state.upstreams ?? []).forEach((u, i) => check(`upstreams[${i}].name`, u.name));
  (state.targets ?? []).forEach((t, i) => check(`targets[${i}].target`, targetHost(t.target)));
  return issues;
}
