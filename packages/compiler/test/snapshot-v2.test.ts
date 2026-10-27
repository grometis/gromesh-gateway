import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  buildSnapshotV2,
  canonicalJson,
  CompileError,
  composeWorkspaces,
  contentDigest,
  jcs,
  workspaceConfigIssues,
  type DeploymentMember,
  type DeploymentMeta,
  type GatewayState,
  type KongDeclarativeConfig,
  type WorkspaceContent,
} from "../src/index.js";

// N3-C1: the deployment envelope of an instance (contracts/snapshot-v2.schema.json) over composeWorkspaces.

const read = (rel: string) => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));
const ajv = new Ajv2020.default({ allErrors: true, strict: false });
addFormats.default(ajv);
ajv.addSchema(read("../../../contracts/snapshot.schema.json"));
const validateEnvelope = ajv.compile(read("../../../contracts/snapshot-v2.schema.json"));

const WS_A = "00000000-0000-4000-8000-0000000000a1";
const WS_B = "00000000-0000-4000-8000-0000000000b1";
const INSTANCE = "00000000-0000-4000-8000-0000000000c1";
const id = (ws: "a" | "b", n: number) => `6a1f3c2e-0b7d-4c1a-9f10-${ws}${String(n).padStart(11, "0")}`;

function state(ws: "a" | "b", paths = ["/pix"]): GatewayState {
  return {
    services: [{ id: id(ws, 1), name: "pix", protocol: "http", host: "orders.example", port: 80 }],
    routes: [{ id: id(ws, 2), name: "pix", serviceId: id(ws, 1), paths }],
    consumers: [{ id: id(ws, 3), username: "app" }],
    keyAuthCredentials: [{ id: id(ws, 4), consumerId: id(ws, 3), key: `key-${ws}` }],
    plugins: [{ id: id(ws, 5), name: "key-auth", scope: { routeId: id(ws, 2) } }],
  };
}

/** The release content that produced state(): Gromesh model, secrets as VarRef, no credentials. */
function content(ws: "a" | "b", paths = ["/pix"]): WorkspaceContent {
  return {
    services: [{ id: id(ws, 1), spec: { name: "pix", protocol: "http", host: { var: "ORDERS_HOST" }, port: 80 } }],
    routes: [{ id: id(ws, 2), spec: { name: "pix", serviceId: id(ws, 1), paths } }],
    consumers: [{ id: id(ws, 3), spec: { username: "app" }, aclGroups: [] }],
    credentials: [],
    plugins: [{ id: id(ws, 5), spec: { name: "key-auth", scope: { routeId: id(ws, 2) } } }],
    upstreams: [],
    targets: [],
    certificates: [],
    variables: [{ name: "ORDERS_HOST", type: "string", secret: false, required: true }],
  };
}

const member = (ws: "a" | "b", releaseVersion = 1, paths = ["/pix"]): DeploymentMember => ({
  id: ws === "a" ? WS_A : WS_B,
  slug: ws === "a" ? "tvro" : "assine",
  releaseVersion,
  state: state(ws, paths),
  content: content(ws, paths),
});

const meta = (extra: Partial<DeploymentMeta> = {}): DeploymentMeta => ({ instanceId: INSTANCE, epoch: 1, revision: 1, createdAt: "2026-10-27T00:00:00.000Z", ...extra });

const clone = (cfg: KongDeclarativeConfig): KongDeclarativeConfig => JSON.parse(JSON.stringify(cfg));

describe("buildSnapshotV2", () => {
  it("produces an envelope the contract accepts, members ordered by workspaceId", () => {
    const snap = buildSnapshotV2([member("b", 3), member("a", 2)], meta({ reason: "publish", mandatoryPluginsVersion: 1, valuesDigest: `sha256:${"c".repeat(64)}` }));
    expect(validateEnvelope(snap), JSON.stringify(validateEnvelope.errors)).toBe(true);
    expect(snap.members.map((m) => [m.workspaceId, m.slug, m.releaseVersion])).toEqual([[WS_A, "tvro", 2], [WS_B, "assine", 3]]);
    expect(snap.members.map((m) => m.contentDigest)).toEqual([contentDigest(content("a")), contentDigest(content("b"))]);
    // The optional fields are emitted only when given; the minimal envelope is valid too.
    const minimal = buildSnapshotV2([member("a")], meta());
    expect(Object.keys(minimal).sort()).toEqual(["config", "createdAt", "epoch", "hash", "instanceId", "members", "revision", "schemaVersion"]);
    expect(validateEnvelope(minimal), JSON.stringify(validateEnvelope.errors)).toBe(true);
    expect(validateEnvelope(buildSnapshotV2([], meta({ mandatoryPluginsVersion: null, valuesDigest: null })))).toBe(true);
  });

  it("emits the platform canary behind the guard and a guard on every Workspace route", () => {
    const { config } = buildSnapshotV2([member("a"), member("b")], meta());
    const canary = config.routes.filter((r) => r.paths?.includes("/.gromesh/guard/current"));
    expect(canary).toHaveLength(1);
    expect(canary[0]!.tags).toContain("gromesh-platform");
    const guarded = (routeId: string) => config.plugins.filter((p) => p.name === "gromesh-route-guard" && p.route === routeId);
    expect(guarded(canary[0]!.id)).toHaveLength(1);
    const wsRoutes = config.routes.filter((r) => r.tags?.some((t) => t.startsWith("gromesh-ws:")));
    expect(wsRoutes.map((r) => r.name).sort()).toEqual(["assine~pix", "tvro~pix"]);
    for (const r of wsRoutes) expect(guarded(r.id), r.name).toHaveLength(1);
  });

  it("changing Workspace A does not change B's contentDigest", () => {
    const before = buildSnapshotV2([member("a"), member("b")], meta());
    const after = buildSnapshotV2([member("a", 2, ["/pix", "/pix2"]), member("b")], meta({ revision: 2 }));
    expect(after.members[0]!.contentDigest).not.toBe(before.members[0]!.contentDigest);
    expect(after.members[1]).toEqual(before.members[1]);
    expect(after.hash).not.toBe(before.hash);
  });

  it("gives the same hash for the same members in any revision, epoch, reason or date", () => {
    const one = buildSnapshotV2([member("a"), member("b")], meta());
    const other = buildSnapshotV2([member("b"), member("a")], meta({ epoch: 3, revision: 42, reason: "reconcile", createdAt: "2027-01-01T00:00:00.000Z" }));
    expect(other.hash).toBe(one.hash);
    expect(other.config).toEqual(one.config);
    expect(other.members).toEqual(one.members);
    expect(one.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("is deterministic: the same input gives the same bytes", () => {
    const build = () => canonicalJson(buildSnapshotV2([member("a"), member("b")], meta({ reason: "publish" })));
    expect(build()).toBe(build());
  });

  it("refuses invalid metadata and members", () => {
    expect(() => buildSnapshotV2([member("a")], meta({ instanceId: "nope" }))).toThrow(RangeError);
    expect(() => buildSnapshotV2([member("a")], meta({ epoch: 0 }))).toThrow(RangeError);
    expect(() => buildSnapshotV2([member("a")], meta({ revision: 1.5 }))).toThrow(RangeError);
    expect(() => buildSnapshotV2([member("a")], meta({ mandatoryPluginsVersion: 0 }))).toThrow(RangeError);
    expect(() => buildSnapshotV2([member("a")], meta({ valuesDigest: "sha256:abc" }))).toThrow(RangeError);
    expect(() => buildSnapshotV2([member("a", 0)], meta())).toThrow(RangeError);
    for (const createdAt of ["2026-10-27T12:34:60Z", "2026-10-27T23:59:60-03:00", "invalid", "2026-13-01T00:00:00Z", "2026-02-30T00:00:00Z", "2026-10-27T00:00:00", "2026-10-27"]) {
      expect(() => buildSnapshotV2([], meta({ createdAt })), createdAt).toThrow(RangeError);
    }
    for (const createdAt of ["2026-10-27T00:00:00.5-03:00", "2016-12-31T23:59:60Z", "2016-12-31T20:59:60-03:00"]) {
      expect(validateEnvelope(buildSnapshotV2([], meta({ createdAt }))), createdAt).toBe(true);
    }
    expect(() => buildSnapshotV2([member("a"), { ...member("b"), slug: "tvro" }], meta())).toThrow(CompileError);
  });
});

describe("contentDigest", () => {
  it("is the SHA-256 of the JCS form with arrays ordered by id and variables by name", () => {
    const c = content("a");
    const sorted = { ...c, routes: [...c.routes, { id: id("a", 9), spec: { name: "z" } }] };
    const shuffled = { ...sorted, routes: [...sorted.routes].reverse(), variables: [{ name: "Z", type: "string" }, ...c.variables] };
    const ordered = { ...shuffled, routes: sorted.routes, variables: [...c.variables, { name: "Z", type: "string" }] };
    expect(contentDigest(shuffled)).toBe(contentDigest(ordered));
    expect(contentDigest(content("a", ["/other"]))).not.toBe(contentDigest(c));
  });

  it("matches a digest computed by hand from the JCS bytes, with integer-like keys in code unit order", () => {
    const c: WorkspaceContent = {
      services: [], consumers: [], credentials: [], plugins: [], upstreams: [], targets: [], certificates: [], variables: [],
      routes: [{ id: id("a", 2), spec: { name: "r", headers: { "2": ["b"], "10": ["a"] } } }],
    };
    const bytes = `{"certificates":[],"consumers":[],"credentials":[],"plugins":[],"routes":[{"id":"${id("a", 2)}","spec":{"headers":{"10":["a"],"2":["b"]},"name":"r"}}],"services":[],"targets":[],"upstreams":[],"variables":[]}`;
    expect(contentDigest(c)).toBe(`sha256:${createHash("sha256").update(bytes, "utf8").digest("hex")}`);
  });

  it("refuses credentials and repeated keys", () => {
    expect(() => contentDigest({ ...content("a"), credentials: [{ id: "x" }] as unknown as [] })).toThrow(RangeError);
    const c = content("a");
    expect(() => contentDigest({ ...c, routes: [...c.routes, ...c.routes] })).toThrow(RangeError);
    expect(() => contentDigest({ ...c, variables: [...c.variables, ...c.variables] })).toThrow(RangeError);
  });
});

describe("jcs (RFC 8785)", () => {
  it("serializes the RFC 8785 §3.2.2 sample", () => {
    const input = JSON.parse(String.raw`{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],"string":"\u20ac$\u000F\u000aA'\u0042\u0022\u005c\\\"\/","literals":[null,true,false]}`);
    expect(jcs(input)).toBe(String.raw`{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\u000f\nA'B\"\\\\\"/"}`);
  });

  it("sorts keys by UTF-16 code units (RFC 8785 §3.2.3 sample), integer-like keys included", () => {
    const input = JSON.parse(String.raw`{"\u20ac":"Euro Sign","\r":"Carriage Return","\ufb33":"Hebrew Letter Dalet With Dagesh","1":"One","\ud83d\ude00":"Emoji: Grinning Face","\u0080":"Control","\u00f6":"Latin Small Letter O With Diaeresis"}`);
    const expected = [
      ["\\r", "Carriage Return"], ["1", "One"], ["\u0080", "Control"], ["\u00f6", "Latin Small Letter O With Diaeresis"],
      ["\u20ac", "Euro Sign"], ["\ud83d\ude00", "Emoji: Grinning Face"], ["\ufb33", "Hebrew Letter Dalet With Dagesh"],
    ].map(([k, v]) => `"${k}":"${v}"`).join(",");
    expect(jcs(input)).toBe(`{${expected}}`);
    expect(jcs({ "2": 0, "10": 1, a: 2 })).toBe('{"10":1,"2":0,"a":2}');
  });

  it("refuses what is not I-JSON", () => {
    expect(() => jcs({ s: "\ud800" })).toThrow(RangeError);
    expect(() => jcs({ s: "x\udc00" })).toThrow(RangeError);
    expect(() => jcs([Number.NaN])).toThrow(RangeError);
    expect(() => jcs([Infinity])).toThrow(RangeError);
    expect(jcs({ s: "\ud83d\ude00" })).toBe('{"s":"😀"}');
  });
});

describe("workspaceConfigIssues", () => {
  const members = [member("a"), member("b")];
  const composed = () => composeWorkspaces(members);
  const routeOf = (cfg: KongDeclarativeConfig, name: string) => cfg.routes.findIndex((r) => r.name === name);

  it("accepts what composeWorkspaces emits", () => {
    expect(workspaceConfigIssues(composed(), members)).toEqual([]);
  });

  it("refuses a config without the canary or with the canary unguarded", () => {
    const without = clone(composed());
    const i = without.routes.findIndex((r) => r.paths?.includes("/.gromesh/guard/current"));
    without.routes.splice(i, 1);
    expect(workspaceConfigIssues(without, members).map((x) => x.path)).toContain("config.routes");
    const unguarded = clone(composed());
    const canary = unguarded.routes[i]!.id;
    unguarded.plugins = unguarded.plugins.filter((p) => p.route !== canary);
    expect(workspaceConfigIssues(unguarded, members).map((x) => x.path)).toContain("config.routes");
  });

  it("refuses a Workspace route without its guard, outside its prefix or misnamed", () => {
    const cfg = clone(composed());
    const r = routeOf(cfg, "tvro~pix");
    const routeId = cfg.routes[r]!.id;
    cfg.plugins = cfg.plugins.filter((p) => !(p.name === "gromesh-route-guard" && p.route === routeId));
    cfg.routes[r]!.paths = ["/assine/pix", "~/tvro(?:/x)", "~/tvrox"];
    cfg.routes[r]!.name = "assine~pix";
    expect(workspaceConfigIssues(cfg, members)).toEqual([
      { path: `config.routes[${r}].name`, message: "must be <slug>~<name>" },
      { path: `config.routes[${r}].paths[0]`, message: "must be under the Workspace prefix" },
      { path: `config.routes[${r}].paths[2]`, message: "must be under the Workspace prefix" },
      { path: `config.routes[${r}]`, message: "must run gromesh-route-guard exactly once" },
    ]);
  });

  it("refuses guards that do not run on every request: disabled, scoped to a consumer or a service", () => {
    const routeId = (cfg: KongDeclarativeConfig) => cfg.routes[routeOf(cfg, "tvro~pix")]!.id;
    const canaryId = (cfg: KongDeclarativeConfig) => cfg.routes.find((r) => r.paths?.includes("/.gromesh/guard/current"))!.id;
    for (const target of [routeId, canaryId]) {
      for (const mutate of [
        (p: KongDeclarativeConfig["plugins"][number]) => { p.enabled = false; },
        (p: KongDeclarativeConfig["plugins"][number]) => { p.consumer = id("a", 3); },
        (p: KongDeclarativeConfig["plugins"][number]) => { p.service = id("a", 1); },
        (p: KongDeclarativeConfig["plugins"][number]) => { p.protocols = []; },
        (p: KongDeclarativeConfig["plugins"][number]) => { p.protocols = ["grpc"]; },
      ]) {
        const cfg = clone(composed());
        const rid = target(cfg);
        mutate(cfg.plugins.find((p) => p.name === "gromesh-route-guard" && p.route === rid)!);
        expect(workspaceConfigIssues(cfg, members).length, `${mutate}`).toBeGreaterThan(0);
      }
    }
    for (const mutate of [
      (p: KongDeclarativeConfig["plugins"][number]) => { p.enabled = false; },
      (p: KongDeclarativeConfig["plugins"][number]) => { p.protocols = []; },
    ]) {
      const cfg = clone(composed());
      mutate(cfg.plugins.find((p) => p.name === "gromesh-workspace")!);
      expect(workspaceConfigIssues(cfg, members), `${mutate}`).toContainEqual({ path: "config.plugins", message: "gromesh-workspace must exist once, global, tagged gromesh-platform" });
    }
  });

  it("requires strip_path false unless the member's route set stripPath", () => {
    for (const value of [true, undefined]) {
      const cfg = clone(composed());
      const r = routeOf(cfg, "tvro~pix");
      cfg.routes[r]!.strip_path = value;
      expect(workspaceConfigIssues(cfg, members), String(value)).toEqual([{ path: `config.routes[${r}].strip_path`, message: "must be false" }]);
    }
    const explicit = [{ ...member("a"), state: { ...state("a"), routes: [{ ...state("a").routes[0]!, stripPath: true }] } }, member("b")];
    expect(workspaceConfigIssues(composeWorkspaces(explicit), explicit)).toEqual([]);
    const cfg = composeWorkspaces(explicit);
    const r = routeOf(cfg, "tvro~pix");
    cfg.routes[r]!.strip_path = false;
    expect(workspaceConfigIssues(cfg, explicit)).toEqual([{ path: `config.routes[${r}].strip_path`, message: "must be true" }]);
    expect(workspaceConfigIssues(composed(), [{ ...member("a"), state: { ...state("a"), routes: [] } }, member("b")])).toContainEqual({ path: `config.routes[${r}]`, message: "is not a route of its Workspace" });
  });

  it("refuses a regex path whose alternatives escape the prefix group", () => {
    for (const escape of ["~/tvro(?:/a)|(?:/assine)", "~/tvro(?:/a)|/assine(?:/b)", "~/tvro(?:/a|^/assine)"]) {
      const cfg = clone(composed());
      const r = routeOf(cfg, "tvro~pix");
      cfg.routes[r]!.paths = [escape];
      expect(workspaceConfigIssues(cfg, members), escape).toEqual([{ path: `config.routes[${r}].paths[0]`, message: "must be under the Workspace prefix" }]);
    }
  });

  it("refuses an entity without exactly one ownership tag, or tagged for a non-member", () => {
    const cfg = clone(composed());
    cfg.services[0]!.tags = cfg.services[0]!.tags!.filter((t) => !t.startsWith("gromesh-"));
    cfg.consumers[0]!.tags = [...cfg.consumers[0]!.tags!, "gromesh-platform"];
    const found = workspaceConfigIssues(cfg, members);
    expect(found).toContainEqual({ path: "config.services[0].tags", message: "must carry exactly one of gromesh-platform or a member's Workspace tag" });
    expect(found).toContainEqual({ path: "config.consumers[0].tags", message: "must carry exactly one of gromesh-platform or a member's Workspace tag" });
    expect(workspaceConfigIssues(composed(), [member("a")]).some((x) => x.message === "carries the tag of a Workspace that is not a member")).toBe(true);
  });

  it("refuses a missing or scoped gromesh-workspace", () => {
    const missing = clone(composed());
    missing.plugins = missing.plugins.filter((p) => p.name !== "gromesh-workspace");
    expect(workspaceConfigIssues(missing, members)).toContainEqual({ path: "config.plugins", message: "gromesh-workspace must exist once, global, tagged gromesh-platform" });
    const scoped = clone(composed());
    scoped.plugins.find((p) => p.name === "gromesh-workspace")!.route = scoped.routes[0]!.id;
    expect(workspaceConfigIssues(scoped, members)).toContainEqual({ path: "config.plugins", message: "gromesh-workspace must exist once, global, tagged gromesh-platform" });
  });
});
