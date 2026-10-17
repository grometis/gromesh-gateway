import { createHash } from "node:crypto";
import { CompileError, type CompileIssue } from "./errors.js";
import { keyNameIssues, resolvePlatformKeyNames } from "./platform-plugins.js";
import type {
  CompileOptions,
  GatewayState,
  KongConsumer,
  KongDeclarativeConfig,
  KongKeyAuthCredential,
  KongPlugin,
  KongRoute,
  KongService,
  KongSni,
  KongTarget,
  KongUpstream,
  KongCertificate,
  Plugin,
  Upstream,
  UpstreamHealthchecks,
} from "./model.js";

export const DEFAULT_MANAGED_TAG = "managed-by:gromesh";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_RE = /^[A-Za-z0-9._~-]+$/;
const SERVICE_PROTOCOLS = new Set(["http", "https", "grpc", "grpcs", "tcp", "tls"]);
const ROUTE_PROTOCOLS = new Set(["http", "https", "grpc", "grpcs"]);
const HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "CONNECT"]);
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const SNI_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const TARGET_RE = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+):([0-9]{1,5})$/;
const ALGORITHMS = new Set(["round-robin", "least-connections", "consistent-hashing", "latency"]);
const HASH_ON = new Set(["none", "consumer", "ip", "header", "cookie"]);
const HEADER_RE = /^[A-Za-z0-9-]+$/;
const COOKIE_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Compiles a Gromesh GatewayState into a Kong declarative config (format 3.0, flat).
 * Output is deterministic: same input → byte-identical JSON → same hash.
 * Throws CompileError with every issue found (never only the first one).
 */
export function compile(state: GatewayState, options: CompileOptions = {}): KongDeclarativeConfig {
  const managedTag = options.managedTag ?? DEFAULT_MANAGED_TAG;
  const issues = validate({ ...state, plugins: [...state.plugins, ...(options.platformPlugins ?? [])] });
  if (issues.length > 0) throw new CompileError(issues);
  const plugins = [...state.plugins, ...resolvePlatformKeyNames(options.platformPlugins ?? [], state.plugins)];

  const tags = (own: string[] | undefined) => sortedUnique([...(own ?? []), managedTag]);

  const services: KongService[] = byId(state.services).map((s) =>
    clean({
      id: s.id,
      name: s.name,
      protocol: s.protocol,
      host: s.host,
      port: s.port,
      path: s.path ?? undefined,
      retries: s.retries,
      connect_timeout: s.connectTimeoutMs,
      read_timeout: s.readTimeoutMs,
      write_timeout: s.writeTimeoutMs,
      enabled: s.enabled,
      tags: tags(s.tags),
    }),
  );

  const routes: KongRoute[] = byId(state.routes).map((r) =>
    clean({
      id: r.id,
      name: r.name,
      service: r.serviceId,
      protocols: r.protocols,
      methods: r.methods?.map((m) => m.toUpperCase()),
      hosts: r.hosts,
      paths: r.paths,
      headers: r.headers,
      strip_path: r.stripPath,
      preserve_host: r.preserveHost,
      tags: tags(r.tags),
    }),
  );

  const consumers: KongConsumer[] = byId(state.consumers).map((c) =>
    clean({
      id: c.id,
      username: c.username ?? undefined,
      custom_id: c.customId ?? undefined,
      tags: tags(c.tags),
    }),
  );

  const keyauth_credentials: KongKeyAuthCredential[] = byId(state.keyAuthCredentials).map((k) => ({
    id: k.id,
    consumer: k.consumerId,
    key: k.key,
    tags: tags(k.tags),
  }));

  const kongPlugins: KongPlugin[] = byId(plugins).map((p) =>
    clean({
      id: p.id,
      name: p.name,
      enabled: p.enabled ?? true,
      service: p.scope?.serviceId ?? undefined,
      route: p.scope?.routeId ?? undefined,
      consumer: p.scope?.consumerId ?? undefined,
      config: p.config ?? {},
      protocols: p.protocols,
      tags: tags(p.tags),
    }),
  );

  const upstreams: KongUpstream[] = byId(state.upstreams ?? []).map((u) => kongUpstream(u, tags(u.tags)));
  const targets: KongTarget[] = byId(state.targets ?? []).map((t) => ({
    id: t.id,
    upstream: t.upstreamId,
    target: t.target,
    weight: t.weight ?? 100,
    tags: tags(t.tags),
  }));
  const certificates: KongCertificate[] = byId(state.certificates ?? []).map((c) => ({ id: c.id, cert: c.cert, key: c.key, tags: tags(c.tags) }));
  // SNIs are their own Kong entity; their ids derive from (certificate, name) so the output stays deterministic.
  const snis: KongSni[] = byId(
    (state.certificates ?? []).flatMap((c) => c.snis.map((name) => ({ id: derivedId(`sni:${c.id}:${name}`), name, certificate: c.id, tags: tags(c.tags) }))),
  );

  return {
    _format_version: "3.0",
    _transform: true,
    services,
    routes,
    consumers,
    keyauth_credentials,
    plugins: kongPlugins,
    ...(upstreams.length > 0 ? { upstreams } : {}),
    ...(targets.length > 0 ? { targets } : {}),
    ...(certificates.length > 0 ? { certificates } : {}),
    ...(snis.length > 0 ? { snis } : {}),
  };
}

function kongUpstream(u: Upstream, tags: string[]): KongUpstream {
  const algorithm = u.algorithm ?? "round-robin";
  const hashing = algorithm === "consistent-hashing";
  const hashOn = hashing ? (u.hashOn ?? "none") : undefined;
  const hashFallback = hashing ? (u.hashFallback ?? "none") : undefined;
  return clean({
    id: u.id,
    name: u.name,
    algorithm,
    hash_on: hashOn,
    hash_fallback: hashFallback,
    hash_on_header: hashOn === "header" ? (u.hashOnHeader ?? undefined) : undefined,
    hash_fallback_header: hashFallback === "header" ? (u.hashFallbackHeader ?? undefined) : undefined,
    hash_on_cookie: hashOn === "cookie" ? (u.hashOnCookie ?? undefined) : undefined,
    hash_on_cookie_path: hashOn === "cookie" ? (u.hashOnCookiePath ?? "/") : undefined,
    healthchecks: kongHealthchecks(u.healthchecks),
    tags,
  });
}

/** Absent checks keep Kong's defaults, which disable them (interval 0, failure thresholds 0). */
function kongHealthchecks(h: UpstreamHealthchecks | undefined): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  if (h?.active) {
    const a = h.active;
    const unhealthy = a.unhealthyThreshold ?? 3;
    const interval = a.intervalSeconds ?? 10;
    out.active = clean({
      type: a.type,
      http_path: a.type === "tcp" ? undefined : (a.httpPath ?? "/"),
      timeout: a.timeoutSeconds ?? 1,
      healthy: { interval, successes: a.healthyThreshold ?? 2 },
      unhealthy: a.type === "tcp" ? { interval, tcp_failures: unhealthy, timeouts: unhealthy } : { interval, http_failures: unhealthy, tcp_failures: unhealthy, timeouts: unhealthy },
    });
  }
  if (h?.passive) {
    out.passive = { unhealthy: { http_failures: h.passive.unhealthyHttpFailures ?? 5, timeouts: h.passive.unhealthyTimeouts ?? 3 } };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A UUID derived from a name (version 5 layout over SHA-1), stable across compilations. */
function derivedId(name: string): string {
  const h = createHash("sha1").update(`gromesh:${name}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

export function validate(state: GatewayState): CompileIssue[] {
  const issues: CompileIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });

  const serviceIds = new Set<string>();
  const routeIds = new Set<string>();
  const consumerIds = new Set<string>();
  const allIds = new Set<string>();

  const checkId = (path: string, id: string) => {
    if (!UUID_RE.test(id)) add(`${path}.id`, "must be a UUID");
    else if (allIds.has(id)) add(`${path}.id`, `duplicate id ${id}`);
    allIds.add(id);
  };
  const checkName = (path: string, name: string, seen: Set<string>) => {
    if (!NAME_RE.test(name)) add(`${path}.name`, "may only contain letters, digits, '.', '_', '~' and '-'");
    if (seen.has(name)) add(`${path}.name`, `duplicate name "${name}"`);
    seen.add(name);
  };

  const serviceNames = new Set<string>();
  state.services.forEach((s, i) => {
    const p = `services[${i}]`;
    checkId(p, s.id);
    checkName(p, s.name, serviceNames);
    if (!SERVICE_PROTOCOLS.has(s.protocol)) add(`${p}.protocol`, `unsupported protocol "${s.protocol}"`);
    if (!s.host) add(`${p}.host`, "is required");
    if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535) add(`${p}.port`, "must be an integer between 1 and 65535");
    if (s.path != null && !s.path.startsWith("/")) add(`${p}.path`, "must start with '/'");
    if (s.path != null && (s.protocol === "tcp" || s.protocol === "tls")) add(`${p}.path`, "is not allowed for tcp/tls services");
    serviceIds.add(s.id);
  });

  const routeNames = new Set<string>();
  state.routes.forEach((r, i) => {
    const p = `routes[${i}]`;
    checkId(p, r.id);
    checkName(p, r.name, routeNames);
    if (!serviceIds.has(r.serviceId)) add(`${p}.serviceId`, `unknown service ${r.serviceId}`);
    const hasMatcher =
      (r.paths?.length ?? 0) > 0 ||
      (r.hosts?.length ?? 0) > 0 ||
      (r.methods?.length ?? 0) > 0 ||
      Object.keys(r.headers ?? {}).length > 0;
    if (!hasMatcher) add(p, "must define at least one of paths, hosts, methods or headers");
    r.paths?.forEach((path, j) => {
      if (!path.startsWith("/") && !path.startsWith("~/")) add(`${p}.paths[${j}]`, "must start with '/' (or '~/' for a regex)");
    });
    r.methods?.forEach((m, j) => {
      if (!HTTP_METHODS.has(m.toUpperCase())) add(`${p}.methods[${j}]`, `unknown HTTP method "${m}"`);
    });
    r.protocols?.forEach((proto, j) => {
      if (!ROUTE_PROTOCOLS.has(proto)) add(`${p}.protocols[${j}]`, `unsupported protocol "${proto}"`);
    });
    routeIds.add(r.id);
  });

  const usernames = new Set<string>();
  const customIds = new Set<string>();
  state.consumers.forEach((c, i) => {
    const p = `consumers[${i}]`;
    checkId(p, c.id);
    if (!c.username && !c.customId) add(p, "must define username or customId");
    if (c.username) {
      if (usernames.has(c.username)) add(`${p}.username`, `duplicate username "${c.username}"`);
      usernames.add(c.username);
    }
    if (c.customId) {
      if (customIds.has(c.customId)) add(`${p}.customId`, `duplicate customId "${c.customId}"`);
      customIds.add(c.customId);
    }
    consumerIds.add(c.id);
  });

  const keys = new Set<string>();
  state.keyAuthCredentials.forEach((k, i) => {
    const p = `keyAuthCredentials[${i}]`;
    checkId(p, k.id);
    if (!consumerIds.has(k.consumerId)) add(`${p}.consumerId`, `unknown consumer ${k.consumerId}`);
    if (!k.key) add(`${p}.key`, "is required");
    else if (keys.has(k.key)) add(`${p}.key`, "duplicate key");
    keys.add(k.key);
  });

  const pluginScopes = new Set<string>();
  state.plugins.forEach((pl: Plugin, i) => {
    const p = `plugins[${i}]`;
    issues.push(...keyNameIssues(pl, p));
    checkId(p, pl.id);
    if (!pl.name) add(`${p}.name`, "is required");
    const s = pl.scope ?? {};
    if (s.serviceId && !serviceIds.has(s.serviceId)) add(`${p}.scope.serviceId`, `unknown service ${s.serviceId}`);
    if (s.routeId && !routeIds.has(s.routeId)) add(`${p}.scope.routeId`, `unknown route ${s.routeId}`);
    if (s.consumerId && !consumerIds.has(s.consumerId)) add(`${p}.scope.consumerId`, `unknown consumer ${s.consumerId}`);
    // Kong allows one instance of a plugin per (name, service, route, consumer).
    const scopeKey = [pl.name, s.serviceId ?? "", s.routeId ?? "", s.consumerId ?? ""].join("|");
    if (pluginScopes.has(scopeKey)) add(p, `plugin "${pl.name}" is already configured for this scope`);
    pluginScopes.add(scopeKey);
  });

  const upstreamIds = new Set<string>();
  const upstreamNames = new Set<string>();
  (state.upstreams ?? []).forEach((u, i) => {
    const p = `upstreams[${i}]`;
    checkId(p, u.id);
    if (!HOSTNAME_RE.test(u.name) || u.name.length > 253) add(`${p}.name`, "must be a lowercase hostname");
    if (upstreamNames.has(u.name)) add(`${p}.name`, `duplicate name "${u.name}"`);
    upstreamNames.add(u.name);
    const algorithm = u.algorithm ?? "round-robin";
    if (!ALGORITHMS.has(algorithm)) add(`${p}.algorithm`, `unsupported algorithm "${algorithm}"`);
    issues.push(...hashIssues(u, p));
    upstreamIds.add(u.id);
  });

  const targetKeys = new Set<string>();
  (state.targets ?? []).forEach((t, i) => {
    const p = `targets[${i}]`;
    checkId(p, t.id);
    if (!upstreamIds.has(t.upstreamId)) add(`${p}.upstreamId`, `unknown upstream ${t.upstreamId}`);
    const m = TARGET_RE.exec(t.target);
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 65535) add(`${p}.target`, "must be host:port with a port between 1 and 65535");
    const weight = t.weight ?? 100;
    if (!Number.isInteger(weight) || weight < 0 || weight > 65535) add(`${p}.weight`, "must be an integer between 0 and 65535");
    const key = `${t.upstreamId}|${t.target}`;
    if (targetKeys.has(key)) add(`${p}.target`, `duplicate target "${t.target}" in the upstream`);
    targetKeys.add(key);
  });

  const sniNames = new Set<string>();
  (state.certificates ?? []).forEach((c, i) => {
    const p = `certificates[${i}]`;
    checkId(p, c.id);
    if (!c.cert) add(`${p}.cert`, "is required");
    if (!c.key) add(`${p}.key`, "is required");
    c.snis.forEach((name, j) => {
      if (!SNI_RE.test(name) || name.length > 253) add(`${p}.snis[${j}]`, "must be a lowercase server name; a wildcard only as the '*.' prefix");
      if (sniNames.has(name)) add(`${p}.snis[${j}]`, `duplicate SNI "${name}"`);
      sniNames.add(name);
    });
  });

  return issues;
}

/** The hashing rules of an upstream; shared with the control plane, which reports them as 422. */
export function hashIssues(u: Pick<Upstream, "algorithm" | "hashOn" | "hashFallback" | "hashOnHeader" | "hashFallbackHeader" | "hashOnCookie">, p: string): CompileIssue[] {
  const issues: CompileIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path: p ? `${p}.${path}` : path, message });
  const hashOn = u.hashOn ?? "none";
  const hashFallback = u.hashFallback ?? "none";
  if (!HASH_ON.has(hashOn)) add("hashOn", `unsupported value "${hashOn}"`);
  if (!HASH_ON.has(hashFallback)) add("hashFallback", `unsupported value "${hashFallback}"`);
  if ((u.algorithm ?? "round-robin") !== "consistent-hashing") {
    if (hashOn !== "none") add("hashOn", "only applies with algorithm consistent-hashing");
    if (hashFallback !== "none") add("hashFallback", "only applies with algorithm consistent-hashing");
    return issues;
  }
  if (hashOn === "header" && !(u.hashOnHeader && HEADER_RE.test(u.hashOnHeader))) add("hashOnHeader", "is required when hashOn is header");
  if (hashOn === "cookie" && !(u.hashOnCookie && COOKIE_RE.test(u.hashOnCookie))) add("hashOnCookie", "is required when hashOn is cookie");
  if (hashFallback === "header" && !(u.hashFallbackHeader && HEADER_RE.test(u.hashFallbackHeader))) add("hashFallbackHeader", "is required when hashFallback is header");
  if (hashOn === "cookie" && hashFallback !== "none") add("hashFallback", "must be none when hashOn is cookie");
  if (hashFallback === "cookie") add("hashFallback", "cookie is only valid in hashOn");
  if (hashOn === "none" && hashFallback !== "none") add("hashFallback", "requires hashOn other than none");
  if (hashOn !== "none" && hashOn === hashFallback && hashOn !== "header") add("hashFallback", "must differ from hashOn");
  return issues;
}

function byId<T extends { id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

/** Drops undefined fields so Kong applies its own defaults and output stays minimal. */
function clean<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}
