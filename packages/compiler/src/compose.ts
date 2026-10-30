import { declarativeConfig, derivedId, validate } from "./compile.js";
import { CompileError, type CompileIssue } from "./errors.js";
import type { CompileOptions, GatewayState, KongDeclarativeConfig, Plugin, Route } from "./model.js";
import { canonicalJson } from "./hash.js";
import { privilegedUses } from "./privileged.js";

/** One Workspace of an instance: its id, its immutable slug and the state of its active release. */
export interface WorkspaceMember {
  id: string;
  slug: string;
  state: GatewayState;
  /**
   * The composedPrivilegedFingerprint a platform admin approved for this release (F-1), recorded by the control
   * plane. The composed config runs every Workspace in the same workers, so a privileged capability it carries is
   * composed only if it is exactly the approved one, on exactly the routes approved.
   */
  approvedPrivileged?: string;
}

export const WORKSPACE_TAG_PREFIX = "gromesh-ws:";
export const PLATFORM_TAG = "gromesh-platform";
export const WORKSPACE_PLUGIN = "gromesh-workspace";
export const ROUTE_GUARD_PLUGIN = "gromesh-route-guard";
export const CANARY_PATH = "/.gromesh/guard/current";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const RESERVED_PREFIX = "gromesh-";
const INTERNAL_SUFFIX = ".gromesh.internal";
const MAX_REGEX = 1024;

/** The authentication class (contract: one effective mechanism per route; only these three in a Workspace). */
const AUTHENTICATORS = new Set(["key-auth", "basic-auth", "jwt", "hmac-auth", "ldap-auth", "session", "oauth2"]);
const WORKSPACE_AUTHENTICATORS = new Set(["key-auth", "basic-auth", "jwt"]);
/** ldap-auth and session are L10; hmac-auth has no modelled credential; acme is platform-only; oauth2 needs a database. */
const UNAVAILABLE = new Set(["ldap-auth", "session", "hmac-auth", "acme", "oauth2"]);
/** A workspace-wide counter or cache would become one per route (decision H-8, before L9). */
const NOT_WORKSPACE_WIDE = new Set(["rate-limiting", "response-ratelimiting", "proxy-cache"]);

/** What gromesh-workspace answers on a route whose final consumer belongs to another Workspace. */
export interface RouteAuthPolicy {
  plugin: "key-auth" | "basic-auth" | "jwt";
  anonymous: string | null;
  /** basic-auth only: an unknown credential has both Authorization headers removed on its way to anonymous. */
  hide_credentials: boolean;
  message: string;
  www_authenticate: string;
}

/**
 * Composes the active release of every Workspace of an instance into one Kong declarative config, so a full
 * `POST /config` replaces each Workspace's entities only with that Workspace's own. Throws CompileError with every
 * issue found; paths are `workspaces[i].<path in that member's state>`.
 */
export function composeWorkspaces(members: WorkspaceMember[], options: CompileOptions = {}): KongDeclarativeConfig {
  const platform = options.platformPlugins ?? [];
  const issues: CompileIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });

  const memberIds = new Set<string>();
  const slugs = new Set<string>();
  members.forEach((m, i) => {
    if (!UUID_RE.test(m.id)) add(`workspaces[${i}].id`, "must be a UUID");
    else if (memberIds.has(m.id.toLowerCase())) add(`workspaces[${i}].id`, "duplicate workspace");
    memberIds.add(m.id.toLowerCase());
    if (!SLUG_RE.test(m.slug) || m.slug.length < 2 || m.slug.length > 40 || m.slug.startsWith(RESERVED_PREFIX)) {
      add(`workspaces[${i}].slug`, "must be 2-40 lowercase letters, digits and single hyphens, start with a letter and not be reserved");
    } else if (slugs.has(m.slug)) add(`workspaces[${i}].slug`, "duplicate slug");
    slugs.add(m.slug);
  });
  platform.forEach((p, i) => {
    if (p.scope?.serviceId || p.scope?.routeId || p.scope?.consumerId) add(`platformPlugins[${i}].scope`, "a mandatory platform plugin is global");
    if (p.name.startsWith(RESERVED_PREFIX)) add(`platformPlugins[${i}].name`, "is reserved for the product's own plugins");
  });

  members.forEach((m, i) => issues.push(...memberIssues(m.state, platform).map((issue) => ({ ...issue, path: `workspaces[${i}].${issue.path}` }))));
  issues.push(...instanceUniquenessIssues(members));
  if (issues.length > 0) throw new CompileError(issues);

  const parts = members.map((m) => namespaced(m, platform));
  parts.forEach((part, i) => {
    const m = members[i]!;
    if (!part.plugins.some((p) => privilegedUses(p).length > 0) || m.approvedPrivileged === composedPrivilegedFingerprint(m.state)) return;
    m.state.plugins.forEach((p, j) => {
      for (const u of privilegedUses(p)) add(`workspaces[${i}].plugins[${j}].${u.path}`, `${u.message}: not the privileged configuration approved for this release`);
    });
  });
  if (issues.length > 0) throw new CompileError(issues);
  const merged: GatewayState = {
    services: parts.flatMap((s) => s.services),
    routes: parts.flatMap((s) => s.routes),
    consumers: parts.flatMap((s) => s.consumers),
    keyAuthCredentials: parts.flatMap((s) => s.keyAuthCredentials),
    jwtCredentials: parts.flatMap((s) => s.jwtCredentials ?? []),
    basicAuthCredentials: parts.flatMap((s) => s.basicAuthCredentials ?? []),
    plugins: parts.flatMap((s) => s.plugins),
    upstreams: parts.flatMap((s) => s.upstreams ?? []),
    targets: parts.flatMap((s) => s.targets ?? []),
    certificates: parts.flatMap((s) => s.certificates ?? []),
  };
  // The platform canary the isolation-probe calls after every start and config change (contract: snapshot-v2): the
  // guard answers it with the lease's nonce, so only a running guard with a valid lease can pass it.
  const canaryService = derivedId("gromesh-platform:guard-canary:service");
  const canaryRoute = derivedId("gromesh-platform:guard-canary:route");
  merged.services.push({ id: canaryService, name: `${PLATFORM_TAG}~guard-canary`, protocol: "http", host: `guard-canary${INTERNAL_SUFFIX}`, port: 80, tags: [PLATFORM_TAG] });
  merged.routes.push({ id: canaryRoute, name: `${PLATFORM_TAG}~guard-canary`, serviceId: canaryService, protocols: ["http"], paths: [CANARY_PATH], stripPath: false, tags: [PLATFORM_TAG] });
  merged.plugins.push({ id: derivedId(`${ROUTE_GUARD_PLUGIN}:${canaryRoute}`), name: ROUTE_GUARD_PLUGIN, scope: { routeId: canaryRoute }, config: { canary: true }, tags: [PLATFORM_TAG] });
  const platformTagged = [
    ...platform.map((p) => ({ ...p, tags: [...(p.tags ?? []), PLATFORM_TAG] })),
    { id: derivedId(WORKSPACE_PLUGIN), name: WORKSPACE_PLUGIN, config: {}, tags: [PLATFORM_TAG] },
  ];
  // A safety net over what the composition produced; members were already validated one by one.
  const composed = validate({ ...merged, plugins: [...merged.plugins, ...platformTagged] });
  if (composed.length > 0) throw new CompileError(composed.map((issue) => ({ ...issue, path: `composition.${issue.path}` })));
  return declarativeConfig(merged, { ...options, platformPlugins: platformTagged });
}

function memberIssues(state: GatewayState, platform: Plugin[]): CompileIssue[] {
  const issues = validate(state);
  const add = (path: string, message: string) => issues.push({ path, message });
  const reservedTag = (path: string, tags: string[] | undefined) =>
    tags?.forEach((tag, j) => { if (tag.startsWith(RESERVED_PREFIX)) add(`${path}.tags[${j}]`, "tags gromesh-* are reserved"); });
  const mandatory = new Set(platform.map((p) => p.name));
  const upstreamNames = new Set((state.upstreams ?? []).map((u) => u.name));

  const upstreamIds = new Set((state.upstreams ?? []).map((u) => u.id));
  state.services.forEach((s, i) => {
    reservedTag(`services[${i}]`, s.tags);
    if (s.binding === "explicit" && s.upstreamId && !upstreamIds.has(s.upstreamId)) add(`services[${i}].upstreamId`, `unknown upstream ${s.upstreamId}`);
    if (!upstreamNames.has(s.host) && s.host.toLowerCase().replace(/\.$/, "").endsWith(INTERNAL_SUFFIX)) add(`services[${i}].host`, "the suffix .gromesh.internal is reserved");
  });
  (state.targets ?? []).forEach((t, i) => {
    reservedTag(`targets[${i}]`, t.tags);
    if (t.target.replace(/:[0-9]+$/, "").toLowerCase().replace(/\.$/, "").endsWith(INTERNAL_SUFFIX)) add(`targets[${i}].target`, "the suffix .gromesh.internal is reserved");
  });
  state.routes.forEach((r, i) => {
    reservedTag(`routes[${i}]`, r.tags);
    if ((r.paths?.length ?? 0) === 0) add(`routes[${i}].paths`, "a Workspace route must define at least one path");
    r.paths?.forEach((path, j) => {
      const reason = path.startsWith("~") ? regexIssue(path.slice(1)) : null;
      if (reason) add(`routes[${i}].paths[${j}]`, reason);
    });
  });
  state.consumers.forEach((c, i) => reservedTag(`consumers[${i}]`, c.tags));
  state.keyAuthCredentials.forEach((k, i) => reservedTag(`keyAuthCredentials[${i}]`, k.tags));
  (state.jwtCredentials ?? []).forEach((j, i) => reservedTag(`jwtCredentials[${i}]`, j.tags));
  (state.basicAuthCredentials ?? []).forEach((b, i) => reservedTag(`basicAuthCredentials[${i}]`, b.tags));
  (state.upstreams ?? []).forEach((u, i) => {
    reservedTag(`upstreams[${i}]`, u.tags);
    if (u.name.endsWith(INTERNAL_SUFFIX)) add(`upstreams[${i}].name`, "the suffix .gromesh.internal is reserved");
  });
  (state.certificates ?? []).forEach((c, i) => reservedTag(`certificates[${i}]`, c.tags));

  state.plugins.forEach((p, i) => {
    const path = `plugins[${i}]`;
    reservedTag(path, p.tags);
    const scope = p.scope ?? {};
    if (p.name.startsWith(RESERVED_PREFIX)) add(`${path}.name`, "plugins gromesh-* are reserved");
    else if (mandatory.has(p.name)) add(`${path}.name`, "is a mandatory platform plugin: reserved in every Workspace scope");
    else if (UNAVAILABLE.has(p.name)) add(`${path}.name`, "is not available to a Workspace");
    else if (NOT_WORKSPACE_WIDE.has(p.name) && !scope.serviceId && !scope.routeId && !scope.consumerId) {
      add(`${path}.scope`, "cannot be Workspace-wide: its counter or cache would become one per route");
    }
    if (AUTHENTICATORS.has(p.name) && scope.consumerId) add(`${path}.scope.consumerId`, "an authenticator cannot be scoped to a consumer");
    if (WORKSPACE_AUTHENTICATORS.has(p.name) && p.config?.anonymous != null && anonymousId(state, p.config.anonymous) === null) {
      add(`${path}.config.anonymous`, "must be a consumer of the same Workspace");
    }
  });

  // At most one effective authenticator per route, over the config the composition emits (route > service >
  // Workspace-wide > mandatory platform plugin for each name; a disabled instance does not shadow a broader one).
  state.routes.forEach((r, i) => {
    const effective = effectiveAuthenticators(state, platform, r);
    if (effective.length > 1) add(`routes[${i}]`, `has ${effective.length} effective authentication mechanisms (${effective.map((p) => p.name).join(", ")}); at most one is allowed`);
  });
  return issues;
}

/** Credentials and SNIs are looked up across the whole node; ids are global. The message never names a Workspace. */
function instanceUniquenessIssues(members: WorkspaceMember[]): CompileIssue[] {
  const issues: CompileIssue[] = [];
  const seen = new Map<string, Set<string>>();
  const claim = (kind: string, value: string, path: string, message: string) => {
    const values = seen.get(kind) ?? new Set<string>();
    seen.set(kind, values);
    if (values.has(value)) issues.push({ path, message });
    values.add(value);
  };
  members.forEach((m, i) => {
    const s = m.state;
    const p = `workspaces[${i}]`;
    const ids: [string, { id: string }[]][] = [
      ["services", s.services], ["routes", s.routes], ["consumers", s.consumers], ["keyAuthCredentials", s.keyAuthCredentials],
      ["jwtCredentials", s.jwtCredentials ?? []], ["basicAuthCredentials", s.basicAuthCredentials ?? []], ["plugins", s.plugins],
      ["upstreams", s.upstreams ?? []], ["targets", s.targets ?? []], ["certificates", s.certificates ?? []],
    ];
    // Within one member validate() already reports duplicates; only the first occurrence per member is claimed.
    for (const [kind, items] of ids) {
      const own = new Set<string>();
      items.forEach((e, j) => {
        const id = e.id.toLowerCase();
        if (own.has(id)) return;
        own.add(id);
        claim("id", id, `${p}.${kind}[${j}].id`, "id already used in this instance");
      });
    }
    const once = (kind: string, values: [string, string][], message: string) => {
      const own = new Set<string>();
      for (const [value, path] of values) {
        if (own.has(value)) continue;
        own.add(value);
        claim(kind, value, path, message);
      }
    };
    once("key", s.keyAuthCredentials.map((k, j) => [k.key, `${p}.keyAuthCredentials[${j}].key`]), "key already in use in this instance");
    once("jwt", (s.jwtCredentials ?? []).map((k, j) => [k.key, `${p}.jwtCredentials[${j}].key`]), "key already in use in this instance");
    once("basic", (s.basicAuthCredentials ?? []).map((b, j) => [b.username, `${p}.basicAuthCredentials[${j}].username`]), "username already in use in this instance");
    once("sni", (s.certificates ?? []).flatMap((c, j) => c.snis.map((name, k): [string, string] => [name, `${p}.certificates[${j}].snis[${k}]`])), "SNI already in use in this instance");
  });
  return issues;
}

function namespaced(m: WorkspaceMember, platform: Plugin[]): GatewayState {
  const { slug, state } = m;
  const tag = `${WORKSPACE_TAG_PREFIX}${m.id.toLowerCase()}`;
  const tags = (own: string[] | undefined) => [...(own ?? []), tag];
  const upstreamHost = (name: string) => `${name}.${slug}${INTERNAL_SUFFIX}`;
  const upstreamNames = new Set((state.upstreams ?? []).map((u) => u.name));
  const upstreamNameById = new Map((state.upstreams ?? []).map((u) => [u.id, u.name]));

  // Workspace-wide plugins are one instance per route, unless the route or its service has its own (more specific).
  const plugins: Plugin[] = [];
  for (const p of state.plugins) {
    // Kong never loads a disabled instance; omitting it also frees its scope for an emulated Workspace-wide one.
    if (p.enabled === false) continue;
    const scope = p.scope ?? {};
    const config = WORKSPACE_AUTHENTICATORS.has(p.name) && p.config?.anonymous != null
      ? { ...p.config, anonymous: anonymousId(state, p.config.anonymous) }
      : p.config;
    if (scope.serviceId || scope.routeId || scope.consumerId) {
      plugins.push({ ...p, config, tags: tags(p.tags) });
      continue;
    }
    for (const r of state.routes) {
      const shadowed = state.plugins.some((o) => o !== p && o.name === p.name && o.enabled !== false && scopeRank(o, r) >= 1);
      if (!shadowed) plugins.push({ ...p, id: derivedId(`workspace-plugin:${p.id}:${r.id}`), scope: { routeId: r.id }, config, tags: tags(p.tags) });
    }
  }
  for (const r of state.routes) {
    const [auth] = effectiveAuthenticators(state, platform, r);
    plugins.push({
      id: derivedId(`${ROUTE_GUARD_PLUGIN}:${r.id}`),
      name: ROUTE_GUARD_PLUGIN,
      scope: { routeId: r.id },
      config: { prefix: `/${slug}`, auth: auth ? authPolicy(state, auth) : null },
      tags: [tag],
    });
  }

  return {
    services: state.services.map(({ binding, upstreamId, ...s }) => ({
      ...s,
      name: `${slug}~${s.name}`,
      // WS-U0: a v2 service balances only by its upstreamId; a v1 one keeps the binding by name.
      host: binding === "explicit" ? (upstreamId ? upstreamHost(upstreamNameById.get(upstreamId)!) : s.host) : upstreamNames.has(s.host) ? upstreamHost(s.host) : s.host,
      tags: tags(s.tags),
    })),
    routes: state.routes.map((r) => ({
      ...r,
      name: `${slug}~${r.name}`,
      paths: (r.paths ?? []).map((path) => (path.startsWith("~") ? `~/${slug}(?:${path.slice(1)})` : `/${slug}${path}`)),
      // Kong's own default is true; a Workspace route keeps the full path unless it asked otherwise (decision D1).
      stripPath: r.stripPath ?? false,
      tags: tags(r.tags),
    })),
    consumers: state.consumers.map((c) => ({
      ...c,
      username: c.username ? `${slug}~${c.username}` : c.username,
      customId: c.customId ? `${slug}~${c.customId}` : c.customId,
      tags: tags(c.tags),
    })),
    keyAuthCredentials: state.keyAuthCredentials.map((k) => ({ ...k, tags: tags(k.tags) })),
    jwtCredentials: (state.jwtCredentials ?? []).map((j) => ({ ...j, tags: tags(j.tags) })),
    basicAuthCredentials: (state.basicAuthCredentials ?? []).map((b) => ({ ...b, tags: tags(b.tags) })),
    plugins,
    upstreams: (state.upstreams ?? []).map((u) => ({ ...u, name: upstreamHost(u.name), tags: tags(u.tags) })),
    targets: (state.targets ?? []).map((t) => ({ ...t, tags: tags(t.tags) })),
    certificates: (state.certificates ?? []).map((c) => ({ ...c, tags: tags(c.tags) })),
  };
}

/**
 * Where an instance applies to a route without a consumer, in Kong 3.9.4's order (runloop/plugins_iterator.lua,
 * lookup_cfg): route+service 3, route 2, service 1, global 0; -1 when it does not apply. Consumer combinations are
 * never authenticators.
 */
/**
 * What a platform admin approves for a Workspace's release: every enabled privileged plugin with all that decides what
 * it does and the routes where Kong runs it (it is not shadowed there by a more specific instance of its name). A new
 * route, or a removed shadowing instance, that extends a privileged plugin changes it. A consumer-scoped instance may
 * run on any route, so it counts every route.
 */
export function composedPrivilegedFingerprint(state: GatewayState): string {
  const privileged = state.plugins
    .filter((p) => p.enabled !== false && privilegedUses(p).length > 0)
    .map((p) => ({
      id: p.id, name: p.name, scope: p.scope ?? {}, config: p.config ?? {}, protocols: p.protocols ?? [],
      runsOn: state.routes
        .filter((r) => p.scope?.consumerId || (scopeRank(p, r) >= 0 && !state.plugins.some((o) => o !== p && o.name === p.name && o.enabled !== false && scopeRank(o, r) > scopeRank(p, r))))
        .map((r) => r.id)
        .sort(),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return canonicalJson(privileged);
}

function scopeRank(p: Plugin, r: Route): number {
  const s = p.scope ?? {};
  if (s.consumerId) return -1;
  if (s.routeId && s.routeId !== r.id) return -1;
  if (s.serviceId && s.serviceId !== r.serviceId) return -1;
  return s.routeId && s.serviceId ? 3 : s.routeId ? 2 : s.serviceId ? 1 : 0;
}

/** For each authenticator name, the instance Kong runs on the route: the most specific enabled one, else the platform's. */
function effectiveAuthenticators(state: GatewayState, platform: Plugin[], route: Route): Plugin[] {
  const enabled = (p: Plugin) => p.enabled !== false && AUTHENTICATORS.has(p.name) && !p.scope?.consumerId;
  const own = state.plugins.filter(enabled);
  const names = new Set([...own, ...platform.filter(enabled)].map((p) => p.name));
  const found: Plugin[] = [];
  for (const name of [...names].sort()) {
    let best: Plugin | undefined;
    for (const p of own) {
      if (p.name === name && scopeRank(p, route) >= 0 && (!best || scopeRank(p, route) > scopeRank(best, route))) best = p;
    }
    const instance = best ?? platform.find((p) => p.name === name && enabled(p));
    if (instance) found.push(instance);
  }
  return found;
}

/** The body and WWW-Authenticate Kong 3.9.4 sends for a credential it does not know (kong/plugins/*). */
function authPolicy(state: GatewayState, p: Plugin): RouteAuthPolicy | null {
  const config = p.config ?? {};
  const realm = typeof config.realm === "string" ? config.realm : null;
  const anonymous = config.anonymous == null ? null : anonymousId(state, config.anonymous);
  switch (p.name) {
    case "key-auth":
      return { plugin: "key-auth", anonymous, hide_credentials: false, message: "Unauthorized", www_authenticate: realm === null ? "Key" : `Key realm="${realm}"` };
    case "basic-auth":
      return { plugin: "basic-auth", anonymous, hide_credentials: config.hide_credentials === true, message: "Unauthorized", www_authenticate: `Basic realm="${realm ?? "service"}"` };
    case "jwt": {
      const claim = typeof config.key_claim_name === "string" ? config.key_claim_name : "iss";
      return { plugin: "jwt", anonymous, hide_credentials: false, message: `No credentials found for given '${claim}'`, www_authenticate: `${realm === null ? "Bearer" : `Bearer realm="${realm}"`} error="invalid_token"` };
    }
    default:
      return null;
  }
}

/** Kong resolves `anonymous` by id or by username; after namespacing only the id is unambiguous. */
function anonymousId(state: GatewayState, value: unknown): string | null {
  if (typeof value !== "string") return null;
  const consumer = state.consumers.find((c) => c.id.toLowerCase() === value.toLowerCase()) ?? state.consumers.find((c) => c.username === value);
  return consumer ? consumer.id : null;
}

/**
 * A user regex is emitted as `~/<slug>(?:<regex>)` and matched by Kong 3.9.4's router (traditional_compatible: the
 * Rust regex engine, where a `[` inside a class opens a nested class). It must not leave the group or the prefix:
 * balanced groups; only `(?:…)` and named groups; no `[` inside a class (nested and POSIX classes), no `\c`, no
 * backreferences, `\Q…\E`, `\K` or `\G`; and every top-level alternative starts with a literal `/` that is not
 * quantified (so `/a|b` cannot match `/<slug>b…`).
 */
export function regexIssue(re: string): string | null {
  if (re.length === 0 || re.length > MAX_REGEX) return `a regex path must have 1 to ${MAX_REGEX} characters after '~'`;
  const forbiddenEscape = /[1-9QEKGgkc]/;
  const escapeMessage = "backreferences, \\Q…\\E, \\K, \\G and \\c are not allowed in a regex path";
  let depth = 0;
  let branchStart = true;
  for (let i = 0; i < re.length; i++) {
    const c = re[i]!;
    if (branchStart && depth === 0) {
      if (c !== "/" || /[?*+{]/.test(re[i + 1] ?? "")) return "every alternative of a regex path must start with a literal '/'";
      branchStart = false;
      continue;
    }
    if (c === "\\") {
      const next = re[i + 1];
      if (next === undefined) return "a regex path must not end with a lone backslash";
      if (forbiddenEscape.test(next)) return escapeMessage;
      i++;
    } else if (c === "[") {
      let j = i + 1;
      if (re[j] === "^") j++;
      if (re[j] === "]") j++;
      for (; j < re.length && re[j] !== "]"; j++) {
        if (re[j] === "[") return "nested and POSIX character classes are not allowed in a regex path";
        if (re[j] === "\\") {
          if (forbiddenEscape.test(re[j + 1] ?? "")) return escapeMessage;
          j++;
        }
      }
      if (j >= re.length) return "unterminated character class in a regex path";
      i = j;
    } else if (c === "(") {
      if (re[i + 1] === "*") return "verbs are not allowed in a regex path";
      if (re[i + 1] === "?" && !/^\?(:|<[A-Za-z_][A-Za-z0-9_]*>|P<[A-Za-z_][A-Za-z0-9_]*>)/.test(re.slice(i + 1))) {
        return "inline flags, lookarounds and other (?…) constructs are not allowed in a regex path";
      }
      depth++;
    } else if (c === ")") {
      if (--depth < 0) return "unbalanced parentheses in a regex path";
    } else if (c === "|" && depth === 0) {
      branchStart = true;
    }
  }
  if (branchStart) return "every alternative of a regex path must start with a literal '/'";
  return depth === 0 ? null : "unbalanced parentheses in a regex path";
}
