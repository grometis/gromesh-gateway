import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { basicAuthPasswordHash, buildSnapshot, compile, CompileError, diffConfigs, diffGatewayStates, exportConfig, hashConfig, type GatewayState } from "../src/index.js";

const read = (rel: string) => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));
const base = (): GatewayState => read("./fixtures/basic.state.json");
const schema = read("../../../contracts/snapshot.schema.json");
const ajv = new Ajv2020.default({ allErrors: true, strict: false });
addFormats.default(ajv);
const validateEnvelope = ajv.compile(schema);

const id = (n: number) => `5c1d2e3f-4a5b-4c6d-8e7f-${String(n).padStart(12, "0")}`;
const PUBLIC_KEY = "-----BEGIN PUBLIC KEY-----\nrsa-public-key\n-----END PUBLIC KEY-----\n";
const HASH = "6d7c5336ddb40d4ad26ba0fee03a8b2df86b50ad";

/**
 * Entity types verified to load as intended with `_transform: false`: none of them has a Kong transformation except
 * basic-auth, whose passwords are emitted already hashed (ca_certificates and oauth2 also have one and are not in
 * the model). A new entity type in the snapshot contract or in the compiler's output fails here until it is
 * checked in Kong's schema (`transformations` in its dao/entity) and added.
 */
const SAFE_WITHOUT_TRANSFORM = [
  "services",
  "routes",
  "consumers",
  "plugins",
  "keyauth_credentials",
  "jwt_secrets",
  "basicauth_credentials",
  "acls",
  "upstreams",
  "targets",
  "certificates",
  "snis",
];
const META = ["_format_version", "_transform"];

function withCredentials(): GatewayState {
  const state = base();
  const consumerId = state.consumers[0]!.id;
  return {
    ...state,
    consumers: state.consumers.map((c, i) => (i === 0 ? { ...c, aclGroups: ["partners", "admins", "partners-eu"] } : c)),
    jwtCredentials: [
      { id: id(2), consumerId, key: "rs-issuer", algorithm: "RS256", rsaPublicKey: PUBLIC_KEY },
      { id: id(1), consumerId, key: "hs-issuer", algorithm: "HS256", secret: "a-shared-secret-of-at-least-32-chars!" },
    ],
    basicAuthCredentials: [{ id: id(3), consumerId, username: "alice", passwordHash: HASH }],
  };
}

describe("basic-auth hash", () => {
  it("is Kong's sha1(password + consumer id) in hex", () => {
    // The pair was checked against Kong 3.9.4 DB-less: this hash with _transform false accepts "s3cret-pass".
    expect(basicAuthPasswordHash("11111111-1111-4111-8111-111111111111", "s3cret-pass")).toBe(HASH);
  });
});

describe("JWT, basic-auth and ACL", () => {
  it("emits jwt_secrets, basicauth_credentials and acls in Kong's format, and _transform false", () => {
    const state = withCredentials();
    const consumerId = state.consumers[0]!.id;
    const config = compile(state);
    expect(config._transform).toBe(false);
    expect(config.jwt_secrets).toEqual([
      { id: id(1), consumer: consumerId, key: "hs-issuer", algorithm: "HS256", secret: "a-shared-secret-of-at-least-32-chars!", tags: ["managed-by:gromesh"] },
      { id: id(2), consumer: consumerId, key: "rs-issuer", algorithm: "RS256", rsa_public_key: PUBLIC_KEY, tags: ["managed-by:gromesh"] },
    ]);
    expect(config.basicauth_credentials).toEqual([{ id: id(3), consumer: consumerId, username: "alice", password: HASH, tags: ["managed-by:gromesh"] }]);
    expect(config.acls!.map((a) => a.group).sort()).toEqual(["admins", "partners", "partners-eu"]);
    expect(config.acls!.every((a) => a.consumer === consumerId)).toBe(true);
    expect(validateEnvelope(buildSnapshot(state, { version: 1, environmentId: id(99) }))).toBe(true);
  });

  it("is deterministic: input order does not change the hash, acl ids are stable", () => {
    const a = withCredentials();
    const b = withCredentials();
    b.jwtCredentials!.reverse();
    b.consumers[0]!.aclGroups!.reverse();
    expect(hashConfig(compile(a))).toBe(hashConfig(compile(b)));
    expect(compile(a).acls).toEqual(compile(b).acls);
  });

  it("keeps _transform true and the old hash when there is no basic-auth credential", () => {
    const before = compile(base());
    expect(before._transform).toBe(true);
    const state = withCredentials();
    delete state.basicAuthCredentials;
    expect(compile(state)._transform).toBe(true);
    expect(hashConfig(compile({ ...base(), jwtCredentials: [], basicAuthCredentials: [] }))).toBe(hashConfig(before));
  });

  it("reports every invalid credential and group", () => {
    const state = withCredentials();
    const consumerId = state.consumers[0]!.id;
    state.consumers[0]!.aclGroups = ["Bad Group", "ok", "ok"];
    state.jwtCredentials = [
      { id: id(1), consumerId, key: "dup", algorithm: "HS256" },
      { id: id(2), consumerId, key: "dup", algorithm: "RS256", secret: "x".repeat(32) },
      { id: id(4), consumerId: id(98), key: "k", algorithm: "PS256" as "RS256" },
    ];
    state.basicAuthCredentials = [
      { id: id(3), consumerId, username: "alice", passwordHash: "plain-password" },
      { id: id(5), consumerId, username: "alice", passwordHash: HASH },
    ];
    let issues: { path: string }[] = [];
    try {
      compile(state);
    } catch (e) {
      issues = (e as CompileError).issues;
    }
    expect(issues.map((i) => i.path).sort()).toEqual(
      [
        "consumers[0].aclGroups[0]",
        "consumers[0].aclGroups[2]",
        "jwtCredentials[0].secret",
        "jwtCredentials[1].key",
        "jwtCredentials[1].rsaPublicKey",
        "jwtCredentials[1].secret",
        "jwtCredentials[2].algorithm",
        "jwtCredentials[2].consumerId",
        "basicAuthCredentials[0].passwordHash",
        "basicAuthCredentials[1].username",
      ].sort(),
    );
    expect(JSON.stringify(issues)).not.toContain("plain-password");
  });

  it("redacts the JWT secret and the basic-auth hash in the diff", () => {
    const changes = diffConfigs(compile(base()), compile(withCredentials()));
    const text = JSON.stringify(changes);
    expect(text).not.toContain("a-shared-secret");
    expect(text).not.toContain(HASH);
    expect(changes.filter((c) => c.kind === "acls")).toHaveLength(3);
    expect(changes.find((c) => c.kind === "basicauth_credentials")).toMatchObject({ label: "basic-auth credential alice", after: { password: "REDACTED" } });
    expect(changes.find((c) => c.kind === "jwt_secrets" && c.label === "JWT credential hs-issuer")).toMatchObject({ after: { secret: "REDACTED" } });
  });
});

describe("_transform: false", () => {
  it("only covers entity types verified as safe without Kong's transformations (snapshot contract)", () => {
    const kinds = Object.keys(schema.$defs.kongConfig.properties).filter((k) => !META.includes(k));
    expect(kinds.filter((k) => !SAFE_WITHOUT_TRANSFORM.includes(k))).toEqual([]);
  });

  it("only covers entity types verified as safe without Kong's transformations (compiler output)", () => {
    const state: GatewayState = {
      ...withCredentials(),
      upstreams: [{ id: id(10), name: "pool.upstream" }],
      targets: [{ id: id(11), upstreamId: id(10), target: "echo:80" }],
      certificates: [{ id: id(12), cert: "-----BEGIN CERTIFICATE-----\nc\n-----END CERTIFICATE-----\n", key: "k", snis: ["api.example.com"] }],
    };
    const config = compile(state);
    expect(config._transform).toBe(false);
    expect(Object.keys(config).filter((k) => !META.includes(k) && !SAFE_WITHOUT_TRANSFORM.includes(k))).toEqual([]);
  });
});

describe("credentials pending reprovisioning (decision H-14)", () => {
  const state = (): GatewayState => {
    const s = base();
    const consumerId = s.consumers[0]!.id;
    s.keyAuthCredentials = [
      { id: id(901), consumerId, key: "active-key-0123456789", tags: [] },
      { id: id(902), consumerId, key: "a-value-nobody-knows-0123", tags: [], pendingReprovision: true },
    ];
    s.jwtCredentials = [
      { id: id(903), consumerId, key: "hs-active", algorithm: "HS256", secret: "s".repeat(43), tags: [] },
      { id: id(904), consumerId, key: "hs-pending", algorithm: "HS256", secret: null, tags: [], pendingReprovision: true },
      { id: id(905), consumerId, key: "rs-active", algorithm: "RS256", rsaPublicKey: PUBLIC_KEY, tags: [] },
    ];
    return s;
  };

  it("leaves them out of the compiled config: they authenticate nothing", () => {
    const config = compile(state());
    expect(config.keyauth_credentials.map((k) => k.id)).toEqual([id(901)]);
    expect((config.jwt_secrets ?? []).map((j) => j.id).sort()).toEqual([id(903), id(905)]);
    expect(JSON.stringify(config)).not.toContain("a-value-nobody-knows-0123");
  });

  it("counts an import of one as a change, though the config is the same", () => {
    const before = state();
    before.keyAuthCredentials = before.keyAuthCredentials.filter((k) => !k.pendingReprovision);
    const changes = diffGatewayStates(before, state());
    expect(changes.map((c) => [c.kind, c.id, c.change])).toEqual([["keyauth_credentials", id(902), "added"]]);
    expect(JSON.stringify(changes)).not.toContain("a-value-nobody-knows-0123");
    expect(hashConfig(compile(before))).toBe(hashConfig(compile(state())));
  });

  it("exports them with their status and without a hint or a secret", () => {
    const doc = exportConfig(state(), (_n, c) => c);
    const consumer = doc.consumers[0]!;
    expect(consumer.keyAuthCredentials).toEqual([
      { id: id(901), keyHint: "…6789", tags: [] },
      { id: id(902), status: "pending-reprovision", tags: [] },
    ]);
    expect(consumer.jwtCredentials.find((j) => j.id === id(904))).toEqual({ id: id(904), key: "hs-pending", algorithm: "HS256", tags: [], status: "pending-reprovision" });
    expect(consumer.jwtCredentials.find((j) => j.id === id(903))).toMatchObject({ secret: "REDACTED" });
  });
});

describe("what a credential pending reprovisioning may be", () => {
  it("is HS256 without a secret only", () => {
    const s = base();
    const consumerId = s.consumers[0]!.id;
    s.jwtCredentials = [
      { id: id(911), consumerId, key: "rs-pending", algorithm: "RS256", rsaPublicKey: PUBLIC_KEY, tags: [], pendingReprovision: true },
      { id: id(912), consumerId, key: "hs-pending-with-secret", algorithm: "HS256", secret: "s".repeat(43), tags: [], pendingReprovision: true },
    ];
    expect(() => compile(s)).toThrow(/only an HS256 credential can be pending reprovisioning[\s\S]*has no secret|has no secret[\s\S]*only an HS256/);
  });
});
