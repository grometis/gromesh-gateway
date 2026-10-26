import { describe, expect, it } from "vitest";
import {
  CompileError,
  composeWorkspaces,
  diffConfigs,
  composedPrivilegedFingerprint,
  hashConfig,
  regexIssue,
  type GatewayState,
  type KongDeclarativeConfig,
  type Plugin,
  type WorkspaceMember,
} from "../src/index.js";

// N2: one config for every Workspace of an instance. The data plane enforcement of what is emitted here is proven
// with the real Kong in e2e/workspaces (gromesh-workspace and gromesh-route-guard).

const WS_A = "00000000-0000-4000-8000-0000000000a1";
const WS_B = "00000000-0000-4000-8000-0000000000b1";
const id = (ws: "a" | "b", n: number) => `6a1f3c2e-0b7d-4c1a-9f10-${ws === "a" ? "a" : "b"}${String(n).padStart(11, "0")}`;

/** A Workspace with the same logical names in A and B: only the credentials differ. */
function state(ws: "a" | "b", extra: Partial<GatewayState> = {}): GatewayState {
  return {
    services: [{ id: id(ws, 1), name: "pix", protocol: "http", host: "orders", port: 80 }],
    routes: [{ id: id(ws, 2), name: "pix", serviceId: id(ws, 1), paths: ["/pix"] }],
    consumers: [
      { id: id(ws, 3), username: "app-sky", customId: "sky-1" },
      { id: id(ws, 4), username: "guest" },
    ],
    keyAuthCredentials: [{ id: id(ws, 5), consumerId: id(ws, 3), key: `key-${ws}` }],
    plugins: [{ id: id(ws, 6), name: "key-auth", scope: { routeId: id(ws, 2) }, config: { key_names: ["apikey"] } }],
    upstreams: [{ id: id(ws, 7), name: "orders" }],
    targets: [{ id: id(ws, 8), upstreamId: id(ws, 7), target: `orders-${ws}.internal.example:8080` }],
    ...extra,
  };
}

const members = (a: Partial<GatewayState> = {}, b: Partial<GatewayState> = {}): WorkspaceMember[] => [
  { id: WS_A, slug: "tvro", state: state("a", a) },
  { id: WS_B, slug: "assine", state: state("b", b) },
];

function issues(fn: () => unknown): { path: string; message: string }[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof CompileError) return e.issues;
    throw e;
  }
  throw new Error("expected a CompileError");
}

const ofWorkspace = (cfg: KongDeclarativeConfig, ws: string) => {
  const tag = `gromesh-ws:${ws}`;
  const pick = <T extends { tags?: string[] }>(xs: T[] | undefined) => (xs ?? []).filter((x) => x.tags?.includes(tag));
  return { services: pick(cfg.services), routes: pick(cfg.routes), consumers: pick(cfg.consumers), keyauth_credentials: pick(cfg.keyauth_credentials), plugins: pick(cfg.plugins), upstreams: pick(cfg.upstreams), targets: pick(cfg.targets) };
};

describe("composeWorkspaces", () => {
  it("namespaces names, prefixes paths, keeps the full path and tags every entity with its Workspace", () => {
    const cfg = composeWorkspaces(members());
    expect(cfg.services.filter((s) => !s.tags?.includes("gromesh-platform")).map((s) => [s.name, s.host]).sort()).toEqual([
      ["assine~pix", "orders.assine.gromesh.internal"],
      ["tvro~pix", "orders.tvro.gromesh.internal"],
    ]);
    expect(cfg.routes.find((r) => r.id === id("a", 2))).toMatchObject({ name: "tvro~pix", paths: ["/tvro/pix"], strip_path: false });
    expect(cfg.consumers.find((c) => c.id === id("a", 3))).toMatchObject({ username: "tvro~app-sky", custom_id: "tvro~sky-1" });
    expect(cfg.consumers.find((c) => c.id === id("b", 3))).toMatchObject({ username: "assine~app-sky", custom_id: "assine~sky-1" });
    expect(cfg.upstreams?.map((u) => u.name).sort()).toEqual(["orders.assine.gromesh.internal", "orders.tvro.gromesh.internal"]);
    // Contract (snapshot-v2): every route, service, consumer and plugin carries exactly one of the Workspace tag of a
    // member or gromesh-platform.
    for (const kind of ["services", "routes", "consumers", "plugins"] as const) {
      for (const e of cfg[kind]) {
        const own = (e.tags ?? []).filter((t) => t.startsWith("gromesh-ws:") || t === "gromesh-platform");
        expect(own, `${kind} ${e.id}`).toHaveLength(1);
      }
    }
  });

  it("emits gromesh-workspace once, global, and a route guard with the prefix and the auth policy on every route", () => {
    const cfg = composeWorkspaces(members());
    const ws = cfg.plugins.filter((p) => p.name === "gromesh-workspace");
    expect(ws).toEqual([expect.objectContaining({ enabled: true, config: {}, tags: ["gromesh-platform", "managed-by:gromesh"] })]);
    expect(ws[0]).not.toHaveProperty("route");
    expect(ws[0]).not.toHaveProperty("service");
    for (const r of cfg.routes) {
      const guards = cfg.plugins.filter((p) => p.name === "gromesh-route-guard" && p.route === r.id);
      expect(guards, r.name).toHaveLength(1);
    }
    expect(cfg.plugins.find((p) => p.name === "gromesh-route-guard" && p.route === id("b", 2))?.config).toEqual({
      prefix: "/assine",
      auth: { plugin: "key-auth", anonymous: null, hide_credentials: false, message: "Unauthorized", www_authenticate: "Key" },
    });
  });

  it("answers for another Workspace's credential what each plugin answers for an unknown one", () => {
    const guard = (extra: Partial<GatewayState>) =>
      composeWorkspaces(members(extra)).plugins.find((p) => p.name === "gromesh-route-guard" && p.route === id("a", 2))?.config.auth;
    const on = (name: string, config: Record<string, unknown>) => ({ plugins: [{ id: id("a", 6), name, scope: { routeId: id("a", 2) }, config }] });
    expect(guard(on("basic-auth", {}))).toEqual({ plugin: "basic-auth", anonymous: null, hide_credentials: false, message: "Unauthorized", www_authenticate: 'Basic realm="service"' });
    expect(guard(on("basic-auth", { hide_credentials: true }))).toMatchObject({ hide_credentials: true });
    expect(guard(on("basic-auth", { realm: "pix" }))).toMatchObject({ www_authenticate: 'Basic realm="pix"' });
    expect(guard(on("key-auth", { realm: "pix" }))).toMatchObject({ www_authenticate: 'Key realm="pix"' });
    expect(guard(on("jwt", {}))).toEqual({ plugin: "jwt", anonymous: null, hide_credentials: false, message: "No credentials found for given 'iss'", www_authenticate: 'Bearer error="invalid_token"' });
    expect(guard(on("jwt", { key_claim_name: "kid", realm: "r" }))).toMatchObject({ message: "No credentials found for given 'kid'", www_authenticate: 'Bearer realm="r" error="invalid_token"' });
    // anonymous by logical username is emitted by id: the username on the node is namespaced.
    expect(guard(on("key-auth", { anonymous: "guest" }))).toMatchObject({ anonymous: id("a", 4) });
    expect(composeWorkspaces(members(on("key-auth", { anonymous: "guest" }))).plugins.find((p) => p.id === id("a", 6))?.config.anonymous).toBe(id("a", 4));
    expect(guard({ plugins: [] })).toBeNull();
  });

  it("emits regex paths inside the prefix group and refuses regexes that could leave it", () => {
    const cfg = composeWorkspaces(members({ routes: [{ id: id("a", 2), name: "pix", serviceId: id("a", 1), paths: ["~/pag/x|/rh/.*", "/"] }] }));
    expect(cfg.routes.find((r) => r.id === id("a", 2))?.paths).toEqual(["~/tvro(?:/pag/x|/rh/.*)", "/tvro/"]);
    for (const bad of ["/a|b", "/a)|(/b", "/?x", "/*", "x", "/(?i)x", "/(?i:x)", "/(\\w)\\1", "/\\Qa\\E", "/(*ACCEPT)", "/a\\K", "/[a", "/(a", "/a|", "/(?P=n)", "/(?#c)", "/a(?=b)", "/(?<=a)b",
      "/[[:alpha:](])|/assine/.*(?:[[:alpha:])]?", "/[a[)]]|/b", "/\\c)|(/x", "/[\\c]"]) {
      expect(regexIssue(bad), bad).not.toBeNull();
    }
    for (const good of ["/pag/x|/rh/.*", "/v[0-9]+/(?:a|b)", "/(?<id>[0-9]+)$", "/(?P<id>x)", "/[)|(]x", "/[]a]", "/[^]a]", "/a\\|b", "/\\d{2,4}"]) {
      expect(regexIssue(good), good).toBeNull();
    }
    const found = issues(() => composeWorkspaces(members({ routes: [{ id: id("a", 2), name: "pix", serviceId: id("a", 1), paths: ["~/a|b"] }] })));
    expect(found).toEqual([{ path: "workspaces[0].routes[0].paths[0]", message: "every alternative of a regex path must start with a literal '/'" }]);
  });

  it("keeps an explicit stripPath, and a route without paths blocks the composition", () => {
    const cfg = composeWorkspaces(members({ routes: [{ id: id("a", 2), name: "pix", serviceId: id("a", 1), paths: ["/pix"], stripPath: true }] }));
    expect(cfg.routes.find((r) => r.id === id("a", 2))?.strip_path).toBe(true);
    const found = issues(() => composeWorkspaces(members({ routes: [{ id: id("a", 2), name: "pix", serviceId: id("a", 1), hosts: ["pix.example"] }] })));
    expect(found).toContainEqual({ path: "workspaces[0].routes[0].paths", message: "a Workspace route must define at least one path" });
  });

  it("allows at most one effective authenticator per route, over route, service, Workspace-wide and platform plugins", () => {
    const route = { routeId: id("a", 2) };
    const service = { serviceId: id("a", 1) };
    const twoMechanisms = (plugins: Plugin[], platformPlugins: Plugin[] = []) =>
      issues(() => composeWorkspaces(members({ plugins }), { platformPlugins })).filter((i) => i.path === "workspaces[0].routes[0]");
    expect(twoMechanisms([{ id: id("a", 6), name: "key-auth", scope: route }, { id: id("a", 9), name: "basic-auth", scope: service }])).toHaveLength(1);
    expect(twoMechanisms([{ id: id("a", 6), name: "key-auth", scope: route }, { id: id("a", 9), name: "jwt" }])).toHaveLength(1);
    expect(twoMechanisms([{ id: id("a", 6), name: "key-auth", scope: route }], [{ id: id("a", 90), name: "jwt" }])).toHaveLength(1);
    // The same name only runs once (the most specific instance); a disabled one does not count.
    expect(() => composeWorkspaces(members({ plugins: [{ id: id("a", 6), name: "key-auth", scope: route }, { id: id("a", 9), name: "key-auth" }] }))).not.toThrow();
    expect(() => composeWorkspaces(members({ plugins: [{ id: id("a", 6), name: "key-auth", scope: route }, { id: id("a", 9), name: "jwt", scope: service, enabled: false }] }))).not.toThrow();
  });

  it("follows Kong's precedence for the effective authenticator, whatever the input order (route+service > route > service > global)", () => {
    const routeAnon = { id: id("a", 6), name: "key-auth", scope: { routeId: id("a", 2) }, config: { anonymous: "guest" } };
    const routeService = { id: id("a", 9), name: "key-auth", scope: { routeId: id("a", 2), serviceId: id("a", 1) }, config: {} };
    const policy = (plugins: Plugin[]) => composeWorkspaces(members({ plugins })).plugins.find((p) => p.name === "gromesh-route-guard" && p.route === id("a", 2))?.config.auth;
    expect(policy([routeAnon, routeService])).toMatchObject({ anonymous: null });
    expect(policy([routeService, routeAnon])).toMatchObject({ anonymous: null });
    // A route+service instance for another service never applies to the route.
    const other = { services: [state("a").services[0]!, { id: id("a", 99), name: "other", protocol: "http" as const, host: "other.example", port: 80 }] };
    const elsewhere = composeWorkspaces(members({ ...other, plugins: [routeAnon, { ...routeService, scope: { routeId: id("a", 2), serviceId: id("a", 99) } }] }));
    expect(elsewhere.plugins.find((p) => p.name === "gromesh-route-guard" && p.route === id("a", 2))?.config.auth).toMatchObject({ anonymous: id("a", 4) });
    expect(policy([{ id: id("a", 9), name: "key-auth", scope: { serviceId: id("a", 1) }, config: {} }, { id: id("a", 13), name: "key-auth", config: { anonymous: "guest" } }])).toMatchObject({ anonymous: null });
  });

  it("a disabled instance is omitted and never shadows an enabled broader one: the route keeps its authenticator", () => {
    const cfg = composeWorkspaces(members({ plugins: [
      { id: id("a", 13), name: "key-auth", config: {} },
      { id: id("a", 6), name: "key-auth", scope: { routeId: id("a", 2) }, enabled: false },
    ] }));
    const onRoute = cfg.plugins.filter((p) => p.name === "key-auth" && p.route === id("a", 2));
    expect(onRoute.map((p) => p.enabled)).toEqual([true]);
    expect(cfg.plugins.some((p) => p.id === id("a", 6))).toBe(false);
    expect(cfg.plugins.find((p) => p.name === "gromesh-route-guard" && p.route === id("a", 2))?.config.auth).toMatchObject({ plugin: "key-auth" });
  });

  it("refuses ldap-auth, session, hmac-auth, acme and oauth2 in any Workspace scope, and authenticators per consumer", () => {
    for (const name of ["ldap-auth", "session", "hmac-auth", "acme", "oauth2"]) {
      expect(issues(() => composeWorkspaces(members({ plugins: [{ id: id("a", 6), name, scope: { routeId: id("a", 2) } }] })))).toContainEqual({ path: "workspaces[0].plugins[0].name", message: "is not available to a Workspace" });
    }
    expect(issues(() => composeWorkspaces(members({ plugins: [{ id: id("a", 6), name: "key-auth", scope: { consumerId: id("a", 3) } }] })))).toContainEqual({ path: "workspaces[0].plugins[0].scope.consumerId", message: "an authenticator cannot be scoped to a consumer" });
  });

  it("reserves gromesh-* names and tags, the mandatory platform plugins' names and .gromesh.internal", () => {
    const found = issues(() =>
      composeWorkspaces(
        members({
          services: [{ id: id("a", 1), name: "pix", protocol: "http", host: "x.gromesh.internal", port: 80, tags: ["gromesh-ws:" + WS_B] }],
          plugins: [
            { id: id("a", 6), name: "gromesh-workspace", scope: { routeId: id("a", 2) } },
            { id: id("a", 9), name: "prometheus", scope: { routeId: id("a", 2) } },
          ],
          consumers: [{ id: id("a", 3), username: "app-sky", tags: ["gromesh-platform"] }, { id: id("a", 4), username: "guest" }],
        }),
        { platformPlugins: [{ id: id("a", 90), name: "prometheus" }] },
      ),
    );
    expect(found).toEqual(expect.arrayContaining([
      { path: "workspaces[0].services[0].tags[0]", message: "tags gromesh-* are reserved" },
      { path: "workspaces[0].services[0].host", message: "the suffix .gromesh.internal is reserved" },
      { path: "workspaces[0].plugins[0].name", message: "plugins gromesh-* are reserved" },
      { path: "workspaces[0].plugins[1].name", message: "is a mandatory platform plugin: reserved in every Workspace scope" },
      { path: "workspaces[0].consumers[0].tags[0]", message: "tags gromesh-* are reserved" },
    ]));
  });

  it("refuses anonymous and consumer references outside the Workspace", () => {
    const found = issues(() => composeWorkspaces(members({ plugins: [{ id: id("a", 6), name: "key-auth", scope: { routeId: id("a", 2) }, config: { anonymous: id("b", 4) } }] })));
    expect(found).toContainEqual({ path: "workspaces[0].plugins[0].config.anonymous", message: "must be a consumer of the same Workspace" });
    const scoped = issues(() => composeWorkspaces(members({ plugins: [{ id: id("a", 9), name: "rate-limiting", scope: { consumerId: id("b", 3) }, config: { minute: 5 } }] })));
    expect(scoped).toContainEqual({ path: "workspaces[0].plugins[0].scope.consumerId", message: `unknown consumer ${id("b", 3)}` });
  });

  it("emulates a Workspace-wide plugin per route, below the route's and the service's own, and refuses counters", () => {
    const routes = [
      { id: id("a", 2), name: "pix", serviceId: id("a", 1), paths: ["/pix"] },
      { id: id("a", 10), name: "boleto", serviceId: id("a", 1), paths: ["/boleto"] },
      { id: id("a", 11), name: "status", serviceId: id("a", 12), paths: ["/status"] },
    ];
    const services = [state("a").services[0]!, { id: id("a", 12), name: "status", protocol: "http" as const, host: "status.example", port: 80 }];
    const cfg = composeWorkspaces(members({
      services,
      routes,
      plugins: [
        { id: id("a", 13), name: "cors", config: { origins: ["*"] } },
        { id: id("a", 14), name: "cors", scope: { routeId: id("a", 10) }, config: { origins: ["https://a"] } },
        { id: id("a", 15), name: "cors", scope: { serviceId: id("a", 12) }, config: { origins: ["https://s"] } },
      ],
    }));
    const cors = cfg.plugins.filter((p) => p.name === "cors");
    expect(cors.filter((p) => !p.route && !p.service)).toEqual([]);
    expect(cors.find((p) => p.route === id("a", 2))?.config).toEqual({ origins: ["*"] });
    expect(cors.filter((p) => p.route === id("a", 10)).map((p) => p.config)).toEqual([{ origins: ["https://a"] }]);
    expect(cors.filter((p) => p.route === id("a", 11))).toEqual([]);
    expect(cors.find((p) => p.service === id("a", 12))?.config).toEqual({ origins: ["https://s"] });

    for (const name of ["rate-limiting", "response-ratelimiting", "proxy-cache"]) {
      expect(issues(() => composeWorkspaces(members({ plugins: [{ id: id("a", 13), name, config: {} }] })))).toContainEqual({ path: "workspaces[0].plugins[0].scope", message: "cannot be Workspace-wide: its counter or cache would become one per route" });
    }
  });

  it("composes a privileged capability only as the platform admin approved it for that release (F-1)", () => {
    const lua: Plugin = { id: id("a", 20), name: "pre-function", scope: { routeId: id("a", 2) }, config: { access: ["ngx.log(ngx.ERR, 'a')"] } };
    const logLua: Plugin = { id: id("a", 21), name: "http-log", scope: { routeId: id("a", 2) }, config: { http_endpoint: "http://logs.example:9000", custom_fields_by_lua: { x: "return 1" } } };
    const lambda: Plugin = { id: id("a", 22), name: "aws-lambda", scope: { routeId: id("a", 2) }, config: { function_name: "f", aws_region: "us-east-1" } };
    const withPlugins = (extra: Plugin[]) => state("a", { plugins: [...state("a").plugins, ...extra] });
    const refused = (m: WorkspaceMember[]) => {
      try {
        composeWorkspaces(m);
        return [];
      } catch {
        return issues(() => composeWorkspaces(m)).map((i) => i.path);
      }
    };

    // Never approved, approved for another configuration, or changed after the approval: refused at its path.
    const s = withPlugins([lua, logLua, lambda]);
    expect(refused([{ id: WS_A, slug: "tvro", state: s }])).toEqual(["workspaces[0].plugins[1].name", "workspaces[0].plugins[2].config.custom_fields_by_lua", "workspaces[0].plugins[3].config.aws_key"]);
    expect(refused([{ id: WS_A, slug: "tvro", state: s, approvedPrivileged: composedPrivilegedFingerprint(withPlugins([lua])) }])).toHaveLength(3);
    const changed = withPlugins([{ ...lua, config: { access: ["ngx.log(ngx.ERR, 'b')"] } }, logLua, lambda]);
    expect(refused([{ id: WS_A, slug: "tvro", state: changed, approvedPrivileged: composedPrivilegedFingerprint(s) }])).toHaveLength(3);
    // Exactly the approved configuration composes, and a Workspace without privileged uses needs no approval.
    const config = composeWorkspaces([{ id: WS_A, slug: "tvro", state: s, approvedPrivileged: composedPrivilegedFingerprint(s) }, { id: WS_B, slug: "assine", state: state("b") }]);
    expect(config.plugins?.some((p) => p.name === "pre-function")).toBe(true);
    // The approval covers where Kong runs it: a Workspace-wide aws-lambda without keys, approved while every route's
    // own aws-lambda (with keys) shadows it, needs a new approval once a shadow is removed or a route is added.
    const wide: Plugin = { id: id("a", 23), name: "aws-lambda", config: { function_name: "f", aws_region: "us-east-1" } };
    const shadow: Plugin = { ...lambda, id: id("a", 24), config: { ...lambda.config, aws_key: "k", aws_secret: "s" } };
    const shadowed = withPlugins([wide, shadow]);
    const approved = composedPrivilegedFingerprint(shadowed);
    expect(refused([{ id: WS_A, slug: "tvro", state: shadowed, approvedPrivileged: approved }])).toEqual([]);
    expect(refused([{ id: WS_A, slug: "tvro", state: withPlugins([wide]), approvedPrivileged: approved }])).toEqual(["workspaces[0].plugins[1].config.aws_key"]);
    const moreRoutes = { ...shadowed, routes: [...shadowed.routes, { id: id("a", 25), name: "boleto", serviceId: id("a", 1), paths: ["/boleto"] }] };
    expect(refused([{ id: WS_A, slug: "tvro", state: moreRoutes, approvedPrivileged: approved }])).toEqual(["workspaces[0].plugins[1].config.aws_key"]);
    expect(refused([{ id: WS_A, slug: "tvro", state: moreRoutes, approvedPrivileged: composedPrivilegedFingerprint(moreRoutes) }])).toEqual([]);
    // A route-scoped one approved on its route also needs a new approval when it moves to the service.
    const onService = withPlugins([{ ...lua, scope: { serviceId: id("a", 1) } }]);
    expect(refused([{ id: WS_A, slug: "tvro", state: onService, approvedPrivileged: composedPrivilegedFingerprint(withPlugins([lua])) }])).toEqual(["workspaces[0].plugins[1].name"]);
    // Its own aws keys make aws-lambda unprivileged.
    expect(refused([{ id: WS_A, slug: "tvro", state: withPlugins([{ ...lambda, config: { ...lambda.config, aws_key: "k", aws_secret: "s" } }]) }])).toEqual([]);
  });

  it("finds instance-wide conflicts before composing, without naming the other Workspace", () => {
    const found = issues(() => composeWorkspaces([
      { id: WS_A, slug: "tvro", state: state("a") },
      { id: WS_B, slug: "tvro", state: { ...state("b"), keyAuthCredentials: [{ id: id("b", 5), consumerId: id("b", 3), key: "key-a" }], routes: [{ id: id("a", 2), name: "pix", serviceId: id("b", 1), paths: ["/pix"] }], plugins: [] } },
    ]));
    expect(found).toEqual(expect.arrayContaining([
      { path: "workspaces[1].slug", message: "duplicate slug" },
      { path: "workspaces[1].keyAuthCredentials[0].key", message: "key already in use in this instance" },
      { path: "workspaces[1].routes[0].id", message: "id already used in this instance" },
    ]));
    for (const issue of found) expect(issue.message).not.toMatch(/tvro|assine|00000000-0000-4000-8000-0000000000a1/);
  });

  it("changing Workspace A leaves every entity of Workspace B byte for byte", () => {
    const before = composeWorkspaces(members());
    const after = composeWorkspaces(members({
      routes: [{ id: id("a", 2), name: "pix", serviceId: id("a", 1), paths: ["/pix", "/pix2"] }],
      plugins: [{ id: id("a", 6), name: "basic-auth", scope: { routeId: id("a", 2) } }],
      keyAuthCredentials: [],
    }));
    expect(ofWorkspace(after, WS_B)).toEqual(ofWorkspace(before, WS_B));
    const changes = diffConfigs(before, after);
    expect(changes.length).toBeGreaterThan(0);
    const bIds = new Set(Object.values(ofWorkspace(before, WS_B)).flat().map((e) => e.id));
    for (const change of changes) expect(bIds.has(change.id), JSON.stringify(change)).toBe(false);
  });

  it("is deterministic regardless of member and entity order", () => {
    const a = members();
    const b = members().reverse().map((m) => ({ ...m, state: { ...m.state, consumers: [...m.state.consumers].reverse() } }));
    expect(hashConfig(composeWorkspaces(a))).toBe(hashConfig(composeWorkspaces(b)));
  });

  it("emits the platform guard canary behind its own guard", () => {
    const cfg = composeWorkspaces(members());
    const route = cfg.routes.find((r) => r.paths?.includes("/.gromesh/guard/current"));
    expect(route).toMatchObject({ name: "gromesh-platform~guard-canary", protocols: ["http"], strip_path: false, tags: ["gromesh-platform", "managed-by:gromesh"] });
    expect(cfg.services.find((s) => s.id === route?.service)).toMatchObject({ host: "guard-canary.gromesh.internal", tags: ["gromesh-platform", "managed-by:gromesh"] });
    expect(cfg.plugins.filter((p) => p.route === route?.id)).toEqual([expect.objectContaining({ name: "gromesh-route-guard", config: { canary: true } })]);
  });

  it("tags the mandatory platform plugins gromesh-platform and keeps them global", () => {
    const cfg = composeWorkspaces(members(), { platformPlugins: [{ id: "14f9de7e-3701-4c69-b7f7-b8b5622c0101", name: "prometheus", config: {} }] });
    expect(cfg.plugins.find((p) => p.name === "prometheus")).toMatchObject({ tags: ["gromesh-platform", "managed-by:gromesh"] });
    expect(issues(() => composeWorkspaces(members(), { platformPlugins: [{ id: id("a", 90), name: "cors", scope: { routeId: id("a", 2) } }] }))).toContainEqual({ path: "platformPlugins[0].scope", message: "a mandatory platform plugin is global" });
  });
});
