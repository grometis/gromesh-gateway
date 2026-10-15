import { CompileError, type CompileIssue } from "./errors.js";
import type {
  CompileOptions,
  GatewayState,
  KongConsumer,
  KongDeclarativeConfig,
  KongKeyAuthCredential,
  KongPlugin,
  KongRoute,
  KongService,
  Plugin,
} from "./model.js";

export const DEFAULT_MANAGED_TAG = "managed-by:gromesh";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_RE = /^[A-Za-z0-9._~-]+$/;
const SERVICE_PROTOCOLS = new Set(["http", "https", "grpc", "grpcs", "tcp", "tls"]);
const ROUTE_PROTOCOLS = new Set(["http", "https", "grpc", "grpcs"]);
const HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "CONNECT"]);

/**
 * Compiles a Gromesh GatewayState into a Kong declarative config (format 3.0, flat).
 * Output is deterministic: same input → byte-identical JSON → same hash.
 * Throws CompileError with every issue found (never only the first one).
 */
export function compile(state: GatewayState, options: CompileOptions = {}): KongDeclarativeConfig {
  const managedTag = options.managedTag ?? DEFAULT_MANAGED_TAG;
  const plugins = [...state.plugins, ...(options.platformPlugins ?? [])];
  const issues = validate({ ...state, plugins });
  if (issues.length > 0) throw new CompileError(issues);

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

  return {
    _format_version: "3.0",
    _transform: true,
    services,
    routes,
    consumers,
    keyauth_credentials,
    plugins: kongPlugins,
  };
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
