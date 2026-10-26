import { createHash } from "node:crypto";
import { diffConfigs } from "./diff.js";
import { CompileError, type CompileIssue } from "./errors.js";
import { keyNameIssues, resolvePlatformKeyNames, resolvePlatformRetention, RETENTION_TAG_PREFIX } from "./platform-plugins.js";
import type {
  CompileOptions,
  GatewayState,
  KongAcl,
  KongBasicAuthCredential,
  KongConsumer,
  KongDeclarativeConfig,
  KongJwtSecret,
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
const ACL_GROUP_RE = /^[a-z0-9_-]{1,64}$/;
const JWT_ALGORITHMS = new Set(["HS256", "RS256", "ES256"]);
const PASSWORD_HASH_RE = /^[0-9a-f]{40}$/;

/**
 * Kong's basic-auth hash: sha1 of the password salted with the consumer id, in hex (kong/plugins/basic-auth/crypto.lua).
 * The config carries only this value and is applied with `_transform: false`, so Kong does not hash it again.
 */
export function basicAuthPasswordHash(consumerId: string, password: string): string {
  return createHash("sha1").update(password + consumerId).digest("hex");
}

/**
 * Compiles a Gromesh GatewayState into a Kong declarative config (format 3.0, flat).
 * Output is deterministic: same input → byte-identical JSON → same hash.
 * Throws CompileError with every issue found (never only the first one).
 */
export function compile(state: GatewayState, options: CompileOptions = {}): KongDeclarativeConfig {
  const issues = validate({ ...state, plugins: [...state.plugins, ...(options.platformPlugins ?? [])] });
  if (issues.length > 0) throw new CompileError(issues);
  return declarativeConfig(state, options);
}

/** An invalid existing draft must still be comparable when an import repairs it; only the proposal is compiled. */
export function diffGatewayStates(before: GatewayState, after: GatewayState) {
  // Retention is domain metadata transported by a platform plugin, absent from Kong's route schema.
  // Include it only in this comparison so a retention-only import is persisted and audited.
  // So are credentials pending reprovisioning (decision H-14), absent from the config: importing one is a change.
  const compared = (state: GatewayState, config: KongDeclarativeConfig) => ({
    ...config,
    routes: config.routes.map((route) => ({
      ...route, analyticsRetentionDays: state.routes.find((r) => r.id === route.id)?.analyticsRetentionDays ?? null,
    })),
    keyauth_credentials: [
      ...config.keyauth_credentials,
      ...state.keyAuthCredentials.filter((k) => k.pendingReprovision).map((k): KongKeyAuthCredential => ({ id: k.id, consumer: k.consumerId, key: "", tags: [...(k.tags ?? []), "pending-reprovision"] })),
    ],
    jwt_secrets: [
      ...(config.jwt_secrets ?? []),
      ...(state.jwtCredentials ?? []).filter((j) => j.pendingReprovision).map((j): KongJwtSecret => ({ id: j.id, consumer: j.consumerId, key: j.key, algorithm: j.algorithm, tags: [...(j.tags ?? []), "pending-reprovision"] })),
    ],
  });
  return diffConfigs(compared(before, declarativeConfig(before, {})), compared(after, compile(after)));
}

/** Not exported by the package: every config that can be published goes through compile or composeWorkspaces. */
export function declarativeConfig(state: GatewayState, options: CompileOptions): KongDeclarativeConfig {
  const managedTag = options.managedTag ?? DEFAULT_MANAGED_TAG;
  const plugins = [...state.plugins, ...resolvePlatformRetention(resolvePlatformKeyNames(options.platformPlugins ?? [], state.plugins), state.routes)];

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
      // Reserved tags are compiler-owned: a user's tag cannot override the persisted retention policy.
      tags: tags([
        ...(r.tags ?? []).filter((tag) => !tag.startsWith(RETENTION_TAG_PREFIX)),
        ...(r.analyticsRetentionDays == null ? [] : [`${RETENTION_TAG_PREFIX}${r.analyticsRetentionDays}`]),
      ]),
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

  // A credential pending reprovisioning authenticates nothing: it is not in the config at all (decision H-14).
  const keyauth_credentials: KongKeyAuthCredential[] = byId(state.keyAuthCredentials.filter((k) => !k.pendingReprovision)).map((k) => ({
    id: k.id,
    consumer: k.consumerId,
    key: k.key,
    tags: tags(k.tags),
  }));

  const jwt_secrets: KongJwtSecret[] = byId((state.jwtCredentials ?? []).filter((j) => !j.pendingReprovision)).map((j) =>
    clean({
      id: j.id,
      consumer: j.consumerId,
      key: j.key,
      algorithm: j.algorithm,
      secret: j.algorithm === "HS256" ? (j.secret ?? undefined) : undefined,
      rsa_public_key: j.algorithm === "HS256" ? undefined : (j.rsaPublicKey ?? undefined),
      tags: tags(j.tags),
    }),
  );
  const basicauth_credentials: KongBasicAuthCredential[] = byId(state.basicAuthCredentials ?? []).map((b) => ({
    id: b.id,
    consumer: b.consumerId,
    username: b.username,
    password: b.passwordHash,
    tags: tags(b.tags),
  }));
  // One Kong acl entity per (consumer, group); the id derives from both so the output stays deterministic.
  const acls: KongAcl[] = byId(
    state.consumers.flatMap((c) => sortedUnique(c.aclGroups ?? []).map((group) => ({ id: derivedId(`acl:${c.id}:${group}`), consumer: c.id, group, tags: tags(c.tags) }))),
  );

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
    // Only basic-auth has a Kong transformation in this model, and its passwords are already hashed. Kept true
    // without them so configs published before basic-auth keep their hash.
    _transform: basicauth_credentials.length === 0,
    services,
    routes,
    consumers,
    keyauth_credentials,
    ...(jwt_secrets.length > 0 ? { jwt_secrets } : {}),
    ...(basicauth_credentials.length > 0 ? { basicauth_credentials } : {}),
    ...(acls.length > 0 ? { acls } : {}),
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
export function derivedId(name: string): string {
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
    if (r.analyticsRetentionDays != null && (!Number.isInteger(r.analyticsRetentionDays) || r.analyticsRetentionDays < 1 || r.analyticsRetentionDays > 7)) {
      add(`${p}.analyticsRetentionDays`, "must be an integer between 1 and 7 or null");
    }
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
    const groups = new Set<string>();
    (c.aclGroups ?? []).forEach((group, j) => {
      if (!ACL_GROUP_RE.test(group)) add(`${p}.aclGroups[${j}]`, "must match ^[a-z0-9_-]{1,64}$");
      if (groups.has(group)) add(`${p}.aclGroups[${j}]`, `duplicate group "${group}"`);
      groups.add(group);
    });
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

  const jwtKeys = new Set<string>();
  (state.jwtCredentials ?? []).forEach((j, i) => {
    const p = `jwtCredentials[${i}]`;
    checkId(p, j.id);
    if (!consumerIds.has(j.consumerId)) add(`${p}.consumerId`, `unknown consumer ${j.consumerId}`);
    if (!j.key) add(`${p}.key`, "is required");
    else if (jwtKeys.has(j.key)) add(`${p}.key`, `duplicate key "${j.key}"`);
    jwtKeys.add(j.key);
    if (!JWT_ALGORITHMS.has(j.algorithm)) add(`${p}.algorithm`, `unsupported algorithm "${j.algorithm}"`);
    else if (j.pendingReprovision) {
      // Decision H-14: an HS256 credential imported without its secret, until it is rotated.
      if (j.algorithm !== "HS256") add(`${p}.algorithm`, "only an HS256 credential can be pending reprovisioning");
      if (j.secret) add(`${p}.secret`, "a credential pending reprovisioning has no secret");
    } else if (j.algorithm === "HS256") {
      if (!j.secret) add(`${p}.secret`, "is required for HS256");
      if (j.rsaPublicKey) add(`${p}.rsaPublicKey`, "only applies to RS256 and ES256");
    } else {
      if (!j.rsaPublicKey) add(`${p}.rsaPublicKey`, `is required for ${j.algorithm}`);
      if (j.secret) add(`${p}.secret`, "only applies to HS256");
    }
  });

  const basicUsernames = new Set<string>();
  (state.basicAuthCredentials ?? []).forEach((b, i) => {
    const p = `basicAuthCredentials[${i}]`;
    checkId(p, b.id);
    if (!consumerIds.has(b.consumerId)) add(`${p}.consumerId`, `unknown consumer ${b.consumerId}`);
    if (!b.username) add(`${p}.username`, "is required");
    else if (basicUsernames.has(b.username)) add(`${p}.username`, `duplicate username "${b.username}"`);
    basicUsernames.add(b.username);
    // Never echo the value: it is the stored hash.
    if (!PASSWORD_HASH_RE.test(b.passwordHash)) add(`${p}.passwordHash`, "must be Kong's 40-character hex hash");
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
