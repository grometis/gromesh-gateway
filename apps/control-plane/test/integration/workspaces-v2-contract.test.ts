import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { hashConfig } from "@gromesh/compiler";
import { startHarness, type Harness } from "./harness.js";

// N0: the Workspaces contracts (v2) are planned; nothing here is implemented yet. These tests keep them coherent until
// the implementation phases (N1 to N7) remove x-gromesh-planned operation by operation.
type Doc = any;
const BASE = "https://gromesh.dev/contracts/";
const read = (file: string) => readFileSync(new URL(`../../../../contracts/${file}`, import.meta.url), "utf8");
const docs: Record<string, Doc> = {
  "control-plane.openapi.yaml": parse(read("control-plane.openapi.yaml")),
  "control-plane-v2.openapi.yaml": parse(read("control-plane-v2.openapi.yaml")),
  "agent-protocol.openapi.yaml": parse(read("agent-protocol.openapi.yaml")),
  "agent-protocol-v2.openapi.yaml": parse(read("agent-protocol-v2.openapi.yaml")),
  "snapshot.schema.json": JSON.parse(read("snapshot.schema.json")),
  "snapshot-v2.schema.json": JSON.parse(read("snapshot-v2.schema.json")),
};
const v2 = docs["control-plane-v2.openapi.yaml"];
const agentV2 = docs["agent-protocol-v2.openapi.yaml"];

const newAjv = () => {
  const ajv = new Ajv2020.default({ allErrors: true, strict: false });
  addFormats.default(ajv);
  for (const [file, doc] of Object.entries(docs)) ajv.addSchema({ ...doc, $id: BASE + file });
  return ajv;
};
const ajv = newAjv();
const validator = (file: string, name: string) => {
  const fn = ajv.getSchema(`${BASE}${file}#/components/schemas/${name}`);
  if (!fn) throw new Error(`${file} has no schema ${name}`);
  return fn;
};
const valid = (name: string, value: unknown) => validator("control-plane-v2.openapi.yaml", name)(value);
const validAgent = (name: string, value: unknown) => validator("agent-protocol-v2.openapi.yaml", name)(value);
const bodyOf = (path: string, method = "post") => ajv.compile({ $ref: `${BASE}control-plane-v2.openapi.yaml#/paths/${path.replaceAll("~", "~0").replaceAll("/", "~1")}/${method}/requestBody/content/application~1json/schema` });

interface Op { file: string; path: string; method: string; op: Doc }
const operationsOf = (file: string): Op[] =>
  Object.entries(docs[file].paths as Record<string, Doc>).flatMap(([path, item]) =>
    Object.entries(item).filter(([method]) => method !== "parameters").map(([method, op]) => ({ file, path, method, op })));
const v2Ops = operationsOf("control-plane-v2.openapi.yaml");
const agentOps = operationsOf("agent-protocol-v2.openapi.yaml");

const u = "00000000-0000-4000-8000-000000000000";
const d = "sha256:" + "a".repeat(64);

describe("planned operations", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h?.close();
  });

  it("marks every v2 operation x-gromesh-planned, and none has a handler", () => {
    expect(v2Ops.length).toBeGreaterThan(80);
    expect(agentOps.length).toBe(7);
    for (const { op } of [...v2Ops, ...agentOps]) expect(op["x-gromesh-planned"], op.operationId).toBe(true);
    const express = h.app.getHttpAdapter().getInstance() as { router: { stack: { route?: { path: string } }[] } };
    const routes = express.router.stack.flatMap((layer) => (layer.route ? [layer.route.path] : []));
    expect(routes.length).toBeGreaterThan(40);
    expect(routes.filter((r) => r.startsWith("/api/v2") || r.startsWith("/agent/v2"))).toEqual([]);
  });
});

describe("authorization in the v2 contract", () => {
  const catalog = new Set<string>(v2.info["x-gromesh-permissions"]);
  const m2m = new Set<string>(v2.info["x-gromesh-m2m-permissions"]);
  const roles = v2.info["x-gromesh-builtin-roles"] as Record<string, string[]>;
  const SCOPES = new Set(["instance", "workspace", "promotion", "binding", "request", "m2m", "public"]);

  it("declares a known permission and scope on every operation", () => {
    for (const { op } of v2Ops) {
      const id = op.operationId;
      const permission = op["x-required-permission"];
      expect(permission === "public" || catalog.has(permission), `${id}: ${permission}`).toBe(true);
      for (const alt of op["x-required-permission-alternatives"] ?? []) expect(catalog.has(alt.permission) && alt.when.length > 0, `${id}: ${alt.permission}`).toBe(true);
      expect(SCOPES.has(op["x-scope"]), `${id}: x-scope ${op["x-scope"]}`).toBe(true);
      // M2M identities only reach m2m-scoped operations, and those accept nothing else.
      const schemes = (op.security ?? v2.security).flatMap((s: Doc) => Object.keys(s));
      if (m2m.has(permission)) {
        expect(op["x-scope"], id).toBe("m2m");
        expect(schemes.every((s: string) => s === "m2mAssertion"), `${id}: ${schemes}`).toBe(true);
      } else {
        expect(schemes.includes("m2mAssertion"), `${id} accepts an M2M assertion`).toBe(false);
      }
      if (permission === "public") expect(op.operationId).toBe("m2mToken");
    }
  });

  it("requires the CSRF token on every session mutation, and a session alone to confirm, approve, execute and reconcile", () => {
    for (const { method, op } of v2Ops) {
      if (method === "get") continue;
      const security = op.security as Doc[] | undefined;
      expect(security, `${op.operationId} declares its security`).toBeDefined();
      for (const alt of security!) if ("cookieAuth" in alt) expect("csrfToken" in alt, `${op.operationId}`).toBe(true);
    }
    for (const id of ["confirmPromotionRequester", "approvePromotion", "executePromotion", "reconcile", "releaseIsolationContainment"]) {
      const { op } = v2Ops.find((o) => o.op.operationId === id)!;
      expect(op.security, id).toEqual([{ cookieAuth: [], csrfToken: [] }]);
    }
  });

  it("builds the built-in roles from the catalog, without emergency rollback or M2M permissions", () => {
    const has = (role: string) => new Set(roles[role]);
    for (const [role, permissions] of Object.entries(roles)) {
      for (const p of permissions) expect(catalog.has(p), `${role}: ${p}`).toBe(true);
      expect(permissions.includes("rollback.emergency"), role).toBe(false);
      expect(permissions.some((p) => m2m.has(p)), role).toBe(false);
    }
    const chain = ["viewer", "editor", "publisher", "workspace-admin", "platform-admin"];
    for (let i = 1; i < chain.length; i++) for (const p of has(chain[i - 1]!)) expect(has(chain[i]!).has(p), `${chain[i]} lacks ${p}`).toBe(true);
    // Approving never comes with writing or executing; requesting a promotion never writes the target.
    expect([...has("approver")].filter((p) => ["gateway.write", "promotion.execute", "promotion.request"].includes(p))).toEqual([]);
    // Every permission an operation needs (except the direct-only emergency grant and M2M) is held by the platform admin.
    for (const { op } of v2Ops) {
      const p = op["x-required-permission"];
      if (p !== "public" && !m2m.has(p) && p !== "rollback.emergency") expect(has("platform-admin").has(p), `${op.operationId}: ${p}`).toBe(true);
    }
  });

  it("selects the emergency permission by condition, with no other permission keys", () => {
    for (const { op } of v2Ops) {
      const keys = Object.keys(op).filter((k) => k.startsWith("x-required-permission"));
      expect(keys.every((k) => ["x-required-permission", "x-required-permission-alternatives", "x-required-permission-when"].includes(k)), `${op.operationId}: ${keys}`).toBe(true);
      for (const w of op["x-required-permission-when"] ?? []) expect(catalog.has(w.permission) && w.when.length > 0, op.operationId).toBe(true);
    }
    const rollback = v2Ops.find((o) => o.op.operationId === "rollbackRelease")!.op;
    expect(rollback["x-required-permission"]).toBe("release.rollback");
    expect(rollback["x-required-permission-when"]).toEqual([{ when: "body.emergency == true", permission: "rollback.emergency" }]);
  });

  it("limits grantable permissions and role names to the catalog", () => {
    const s = v2.components.schemas;
    expect(s.Permission.enum).toEqual([...catalog]);
    expect(new Set(s.GrantablePermission.enum)).toEqual(new Set([...catalog].filter((p) => !m2m.has(p))));
    expect(new Set(s.RolePermission.enum)).toEqual(new Set([...catalog].filter((p) => !m2m.has(p) && p !== "rollback.emergency")));
    expect(s.RoleName.oneOf[0].enum).toEqual(Object.keys(roles));
  });

  it("declares the error responses of every operation", () => {
    for (const { path, op } of v2Ops) {
      const codes = Object.keys(op.responses);
      if (op["x-required-permission"] === "public") {
        expect(codes, op.operationId).toContain("400");
        continue;
      }
      for (const c of ["401", "403"]) expect(codes, op.operationId).toContain(c);
      if (path.includes("{")) expect(codes, op.operationId).toContain("404");
      if (op.requestBody) expect(codes.includes("422") || codes.includes("400"), op.operationId).toBe(true);
    }
  });

  it("closes every JSON request body", () => {
    const resolve = (s: Doc): Doc => {
      if (!s?.$ref) return s;
      const [file, pointer] = s.$ref.split("#");
      const doc = file ? docs[file.replace("./", "")] : v2;
      return pointer.split("/").slice(1).reduce((node: Doc, key: string) => node[key], doc);
    };
    const isClosed = (s: Doc): boolean => {
      const r = resolve(s);
      if (r.additionalProperties === false || r.unevaluatedProperties === false) return true;
      if (r.oneOf) return r.oneOf.every(isClosed);
      if (r.allOf) return r.allOf.some(isClosed);
      return r.type === "array";
    };
    for (const { op } of v2Ops) {
      const body = op.requestBody?.content?.["application/json"]?.schema;
      if (body) expect(isClosed(body), op.operationId).toBe(true);
    }
  });
});

describe("traceability to the W0 requirements", () => {
  // Every requirement of the approved traceability matrix (W0, R) is referenced by a planned operation or lives
  // somewhere else that the implementation phase must prove (schema, compiler, data plane, v1 contract).
  const CATALOG = [
    ...Array.from({ length: 16 }, (_, i) => `GW-WS-${String(i + 1).padStart(2, "0")}`), "GW-WS-06a", "GW-WS-16a", "GW-WS-16b",
    ...Array.from({ length: 7 }, (_, i) => `GW-ENV-0${i + 1}`),
    ...Array.from({ length: 12 }, (_, i) => `GW-RBAC-${String(i + 1).padStart(2, "0")}`),
    ...Array.from({ length: 7 }, (_, i) => `GW-ADMIN-0${i + 1}`),
    ...Array.from({ length: 6 }, (_, i) => `GW-PLG-0${i + 1}`),
    ...Array.from({ length: 6 }, (_, i) => `GW-PUB-0${i + 1}`),
    ...Array.from({ length: 7 }, (_, i) => `GW-PRM-0${i + 1}`),
    ...Array.from({ length: 7 }, (_, i) => `GW-APR-0${i + 1}`),
    ...Array.from({ length: 4 }, (_, i) => `GW-RSK-0${i + 1}`),
    ...Array.from({ length: 4 }, (_, i) => `GW-PRV-0${i + 1}`),
    ...Array.from({ length: 5 }, (_, i) => `GW-AUTH-0${i + 1}`),
    ...Array.from({ length: 5 }, (_, i) => `GW-M2M-0${i + 1}`),
    ...Array.from({ length: 9 }, (_, i) => `GW-DEP-0${i + 1}`),
  ];
  /**
   * Requirements without an operation of their own, and where their contract lives: a JSON pointer into the v2
   * contract (with the phase marker it must carry), a sentence of the v2 info, a v1 operation, or a later phase
   * whose proof is not a contract (compiler and data plane in N2, OIDC in L5).
   */
  type Where = { schema: string; phase?: string } | { info: string } | { v1: string } | { deferred: string };
  const ELSEWHERE: Record<string, Where> = {
    "GW-WS-06": { deferred: "N2" }, // compiler + data plane: one workspace's credential never authenticates on another's route
    "GW-WS-06a": { schema: "AuthenticationProfile/oneOf/1", phase: "L10" },
    "GW-RBAC-08": { schema: "RoleBindingWrite/properties/effect/oneOf/1", phase: "L3" },
    "GW-RBAC-10": { info: "deny by default" },
    "GW-RBAC-12": { info: "they never approve nor execute" },
    "GW-ADMIN-05": { schema: "RoleBindingWrite/properties/subjectType/oneOf/1", phase: "L2" },
    "GW-PLG-01": { info: "A mandatory platform plugin's name is reserved in every workspace scope" },
    "GW-PLG-03": { info: "created and changed only by platform-admin and audited" },
    "GW-PLG-06": { deferred: "N2" }, // behavior proven with the real Kong
    "GW-PUB-04": { schema: "PromotionRequest/oneOf/1", phase: "L7" },
    "GW-RSK-01": { schema: "Change/properties/risk" },
    "GW-RSK-02": { schema: "ApprovalPolicy/properties/riskRules", phase: "L6" },
    "GW-RSK-03": { info: "workspace policy can only tighten" },
    "GW-RSK-04": { schema: "Change/properties/risk" },
    "GW-AUTH-01": { v1: "login" },
    "GW-AUTH-03": { schema: "Identity/oneOf/0", phase: "L5" },
    "GW-AUTH-04": { deferred: "L5" }, // break-glass
  };
  const pointer = (path: string): Doc => path.split("/").reduce((node: Doc, key) => node?.[key], v2.components.schemas);
  const v1Ids = new Set(operationsOf("control-plane.openapi.yaml").map(({ op }) => op.operationId));
  const referenced = new Set<string>();
  for (const { op } of [...v2Ops, ...agentOps]) for (const r of op["x-gromesh-requirements"] ?? []) referenced.add(r);

  it("tags every operation with known requirements", () => {
    for (const { op } of [...v2Ops, ...agentOps]) {
      const reqs: string[] = op["x-gromesh-requirements"] ?? [];
      expect(reqs.length, op.operationId).toBeGreaterThan(0);
      for (const r of reqs) expect(CATALOG.includes(r), `${op.operationId}: ${r}`).toBe(true);
    }
  });

  it("covers every requirement by an operation or names where it lives", () => {
    // The W0 matrix (R) has 98 rows: 95 requirements of the directive plus the derived GW-WS-06a, 16a and 16b.
    expect(new Set(CATALOG).size).toBe(98);
    for (const r of CATALOG) expect(referenced.has(r) || r in ELSEWHERE, `${r} is not traced`).toBe(true);
    for (const [r, where] of Object.entries(ELSEWHERE)) {
      expect(referenced.has(r), `${r} has an operation: drop it from ELSEWHERE`).toBe(false);
      if ("schema" in where) {
        const node = pointer(where.schema);
        expect(node, `${r}: ${where.schema}`).toBeDefined();
        if (where.phase) expect(node["x-gromesh-phase"], `${r}: ${where.schema}`).toBe(where.phase);
      } else if ("info" in where) expect(v2.info.description, r).toContain(where.info);
      else if ("v1" in where) expect(v1Ids.has(where.v1), `${r}: v1 ${where.v1}`).toBe(true);
      else expect(["N2", "L5"], r).toContain(where.deferred);
    }
  });
});

describe("state machines in the contracts", () => {
  const machines: [string, Doc][] = [];
  for (const file of ["control-plane-v2.openapi.yaml", "agent-protocol-v2.openapi.yaml"]) {
    for (const [name, schema] of Object.entries(docs[file].components.schemas as Record<string, Doc>)) {
      if (schema["x-gromesh-transitions"]) machines.push([`${file}#${name}`, schema]);
    }
  }

  it("finds the machines of the approved design", () => {
    expect(machines.map(([n]) => n.split("#")[1]).sort()).toEqual(
      ["AdmissionOutcome", "AdmissionState", "ApprovalState", "DeploymentState", "EmergencyPostReviewStatus", "IsolationPendencyLifecycle", "PodIsolationState", "PromotionStatus", "WorkspaceRequestStatus"].sort(),
    );
  });

  it("is closed: states from the enum, every state reachable, terminal states without exits", () => {
    for (const [name, schema] of machines) {
      const states = new Set<string>(schema.enum);
      const t = schema["x-gromesh-transitions"] as { initial: string[]; terminal: string[]; transitions: [string, string, string][] };
      for (const s of [...t.initial, ...t.terminal]) expect(states.has(s), `${name}: ${s}`).toBe(true);
      const out = new Map<string, string[]>();
      for (const [from, to, why] of t.transitions) {
        expect(states.has(from) && states.has(to), `${name}: ${from} -> ${to}`).toBe(true);
        expect(why.length, `${name}: ${from} -> ${to} has no reason`).toBeGreaterThan(0);
        out.set(from, [...(out.get(from) ?? []), to]);
      }
      for (const s of t.terminal) expect(out.get(s) ?? [], `${name}: terminal ${s} has exits`).toEqual([]);
      for (const s of states) if (!t.terminal.includes(s)) expect((out.get(s) ?? []).length, `${name}: ${s} is a dead end`).toBeGreaterThan(0);
      const seen = new Set(t.initial);
      for (let queue = [...t.initial]; queue.length; ) for (const next of out.get(queue.shift()!) ?? []) if (!seen.has(next)) seen.add(next), queue.push(next);
      expect([...states].filter((s) => !seen.has(s)), `${name}: unreachable`).toEqual([]);
    }
  });

  it("keeps derived enums inside their machines", () => {
    const promotion = new Set(v2.components.schemas.PromotionStatus.enum);
    for (const r of v2.components.schemas.Execution.properties.result.enum) expect(promotion.has(r), `Execution.result ${r}`).toBe(true);
    const pod = v2.components.schemas.ClusterIsolation.properties.pods.items.properties;
    expect(pod.state.$ref).toBe("./agent-protocol-v2.openapi.yaml#/components/schemas/PodIsolationState");
    const admission = new Set([...agentV2.components.schemas.AdmissionState.enum, ...agentV2.components.schemas.AdmissionOutcome.enum.filter((s: string) => s !== "granted")]);
    expect(new Set(pod.admission.enum)).toEqual(new Set([...admission].map((s) => (s === "pending" ? "requested" : s))));
    const kinds = v2.components.schemas.ClusterIsolation.properties.pendencies.items.properties.kind.enum;
    for (const k of kinds) expect(v2.components.schemas.IsolationPendencyLifecycle.enum).toContain(k);
    expect(agentV2.components.schemas.IsolationReleaseClaims.properties.kind.enum.sort()).toEqual(["confirmed-violation", "unconfirmed-isolation"]);
  });
});

describe("core profile (L1 to L10 blocked in the core)", () => {
  // Derivation from the info conventions: a marked operation or oneOf alternative is removed; a marked property is
  // forbidden in its parent unless x-gromesh-core-profile states the exact core exception.
  const core = JSON.parse(JSON.stringify(v2));
  const derive = (v: Doc): void => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v.oneOf)) v.oneOf = v.oneOf.filter((alt: Doc) => !(alt && alt["x-gromesh-phase"]));
    if (v.properties) {
      for (const [name, prop] of Object.entries(v.properties as Record<string, Doc>)) {
        if (!prop || !prop["x-gromesh-phase"]) continue;
        v.allOf = [...(v.allOf ?? []), prop["x-gromesh-core-profile"] ?? { not: { required: [name] } }];
      }
    }
    Object.values(v).forEach(derive);
  };
  derive(core.components);
  const coreAjv = newAjv();
  coreAjv.addSchema({ ...core, $id: `${BASE}core.openapi.yaml` });
  const validCore = (name: string, value: unknown) => coreAjv.getSchema(`${BASE}core.openapi.yaml#/components/schemas/${name}`)!(value);
  const PHASES = new Set(["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9", "L10"]);
  const marked: string[] = [];
  JSON.stringify(v2, (k, val) => (k === "x-gromesh-phase" && marked.push(val), val));

  it("marks only known phases, and every phase is used", () => {
    for (const p of marked) expect(PHASES.has(p), p).toBe(true);
    expect(new Set(marked)).toEqual(PHASES);
  });

  const emptyContent = { services: [], routes: [], consumers: [], credentials: [], plugins: [], upstreams: [], targets: [], certificates: [], variables: [] };
  const base = { packageId: u, sourceInstanceId: u, sourceStage: "dev", targetStage: "hml", workspaceKey: u, slug: "a", kind: "full", sourceReleaseVersion: 1, createdAt: "2026-10-23T00:00:00Z", expiresAt: "2026-10-24T00:00:00Z", nonce: "n", contentDigest: d, requestedBy: { kind: "local", email: "a@b.co" }, authors: [{ kind: "oidc", issuer: "https://idp.example", subject: "123" }] };
  it.each([
    ["PackagePayload", { ...base, kind: "partial", content: emptyContent, selection: [{ kind: "routes", id: u, change: "upsert" }] }, false],
    ["PackagePayload", { ...base, authors: [{ kind: "local", email: "b@b.co" }], content: emptyContent }, true],
    ["PackagePayload", { ...base, content: emptyContent }, false], // OIDC author: L5
    ["RoleBindingWrite", { subjectType: "user", subjectId: u, role: "editor", expiresAt: "2026-11-01T00:00:00Z", justification: "x" }, false],
    ["RoleBindingWrite", { subjectType: "user", subjectId: u, permissions: ["rollback.emergency"], expiresAt: "2026-10-30T00:00:00Z", justification: "plantão de incidente" }, true],
    ["RoleBindingWrite", { subjectType: "group", subjectId: u, role: "editor" }, false],
    ["RoleBindingWrite", { subjectType: "user", subjectId: u, role: "editor", effect: "deny" }, false],
    ["RoleBindingWrite", { subjectType: "user", subjectId: u, role: "editor" }, true],
    ["RoleBindingWrite", { subjectType: "user", subjectId: u, role: "tech-lead" }, false],
    ["ApprovalPolicy", { minApprovals: 1, eligibleRoles: ["tech-lead"] }, false],
    ["ApprovalPolicy", { minApprovals: 1, eligibleRoles: ["approver"], riskRules: [{ minRisk: "high", extraApprovals: 1 }] }, false],
    ["ApprovalPolicy", { minApprovals: 1, eligibleRoles: ["approver"] }, true],
    ["PromotionRequest", { kind: "partial", releaseVersion: 1, selection: [{ kind: "routes", id: u, change: "upsert" }] }, false],
    ["AuthenticationProfile", { composition: "and", mechanisms: [{ plugin: "ldap-auth", scope: "route" }] }, false],
    ["AuthenticationProfile", { composition: "single", mechanisms: [{ plugin: "jwt", scope: "route" }] }, true],
  ])("core %s %j -> %s", (name, value, expected) => {
    expect(validCore(name, value)).toBe(expected);
  });
});

describe("v2 schemas", () => {
  const emptyContent = { services: [], routes: [], consumers: [], credentials: [], plugins: [], upstreams: [], targets: [], certificates: [], variables: [] };
  const base = { packageId: u, sourceInstanceId: u, sourceStage: "dev", targetStage: "hml", workspaceKey: u, slug: "a", kind: "full", sourceReleaseVersion: 1, createdAt: "2026-10-23T00:00:00Z", expiresAt: "2026-10-24T00:00:00Z", nonce: "n", contentDigest: d, requestedBy: { kind: "local", email: "a@b.co" }, authors: [{ kind: "oidc", issuer: "https://idp.example", subject: "123" }] };
  const att = { issuerInstanceId: u, issuerStage: "hml", workspaceKey: u, contentDigest: d, deploymentRevision: 1, clusters: [{ clusterId: u, nodes: [{ nodeId: "n1", appliedRevision: 1 }] }], promotionId: u, authorsDigest: d, convergedAt: "2026-10-23T00:00:00Z", jws: { protected: "eyJ", payload: "eyJ", signature: "c2ln" } };
  const toPrd = { ...base, sourceStage: "hml", targetStage: "prd", content: emptyContent };
  const release = { workspaceId: u, version: 3, contentDigest: d, origin: "rollback", rollbackOf: 1, contentOriginVersion: 1, contentFirstActivatedAt: "2026-09-01T00:00:00Z", originPromotionId: u, contentRevoked: false, createdAt: "2026-10-23T00:00:00Z" };
  const promo = { id: u, packageId: u, status: "validating", kind: "rollback", proofUse: "historical", contentDigest: d, workspaceKey: u, slug: "a" };
  const pend = (kind: string, releasable: boolean, scope = "cluster") => ({ clusterId: u, pods: [], pendencies: [{ id: u, kind, scope, openedAt: "2026-10-24T00:00:00Z", releasable }] });
  const pod = { podUid: u, bootId: u, podName: "kong-0", nodeName: "n1", state: "verifying", admission: "open", reporting: "communication-failure", lastSeq: 7, leaseRemainingMs: 21000 };
  const exec = (result: string, failureReason: string | null = null) => ({ promotionId: u, result, failureReason, executedBy: { userId: u, personId: u }, startedAt: "2026-10-24T00:00:00Z" });
  const review = { id: u, promotionId: u, status: "pending", openedAt: "2026-10-24T00:00:00Z", reviewer: null, justification: null, correctiveAction: null, decidedAt: null };
  const reviewer = { userId: u, personId: u, startedAt: "2026-10-24T01:00:00Z" };
  const emergency = { ...promo, kind: "emergency-rollback", status: "converged", execution: exec("converged"), postReview: review };
  const service = { id: u, spec: { name: "recarga", protocol: "https", host: { $var: "TVRO_HOST" }, port: 443 } };
  const content = (extra: Record<string, unknown>) => ({ ...emptyContent, ...extra });

  it.each([
    ["PromotionRequest", { kind: "partial", releaseVersion: 1 }, false],
    ["PromotionRequest", { kind: "full" }, false],
    ["PromotionRequest", { kind: "full", releaseVersion: 2 }, true],
    ["RoleBindingWrite", { subjectType: "user", subjectId: u }, false],
    ["RoleBindingWrite", { subjectType: "user", subjectId: u, role: "editor" }, true],
    ["RoleBindingWrite", { subjectType: "user", subjectId: u, role: "editor", expiresAt: "2026-11-01T00:00:00Z" }, false],
    ["RoleBindingWrite", { subjectType: "user", subjectId: u, role: "editor", expiresAt: "2026-11-01T00:00:00Z", justification: null }, false],
    ["RoleBindingWrite", { subjectType: "user", subjectId: u, role: "editor", expiresAt: "2026-11-01T00:00:00Z", justification: "incidente 42" }, true],
    // Emergency rollback: only a direct, expiring and justified grant.
    ["RoleBindingWrite", { subjectType: "user", subjectId: u, permissions: ["rollback.emergency"] }, false],
    ["RoleBindingWrite", { subjectType: "group", subjectId: u, permissions: ["rollback.emergency"], expiresAt: "2026-10-30T00:00:00Z", justification: "plantão de incidente" }, false],
    ["RoleBindingWrite", { subjectType: "user", subjectId: u, permissions: ["rollback.emergency"], expiresAt: null, justification: null }, false],
    ["RoleBindingWrite", { subjectType: "user", subjectId: u, permissions: ["rollback.emergency"], expiresAt: "2026-10-30T00:00:00Z", justification: "plantão de incidente" }, true],
    ["RoleBindingWrite", { subjectType: "user", subjectId: u, role: "editor", effect: "deny" }, true],
    // Signed package content: every collection, no credentials, stages in sequence, exactly one attestation to prd.
    ["PackagePayload", { ...base, content: {} }, false],
    ["PackagePayload", { ...base, sourceStage: "dev", targetStage: "prd", content: emptyContent, attestations: [] }, false],
    ["PackagePayload", { ...base, content: emptyContent }, true],
    ["PackagePayload", { ...base, content: { ...emptyContent, services: [42] } }, false],
    ["PackagePayload", { ...base, content: { ...emptyContent, credentials: [{ id: u }] } }, false],
    ["PackagePayload", { ...base, requestedBy: { personKey: "local:a@b.co" }, content: emptyContent }, false],
    ["PackagePayload", { ...toPrd, attestations: [att] }, true],
    ["PackagePayload", { ...toPrd, attestations: [att, att] }, false],
    ["PackagePayload", { ...toPrd }, false],
    ["PackagePayload", { ...base, content: emptyContent, requestedBy: { kind: "local", email: "a@b.co", corporateId: "M123" } }, true],
    ["PackagePayload", { ...base, content: emptyContent, requestedBy: { kind: "local", email: "a@b.co", corporateId: "" } }, false],
    ["Approval", { id: u, state: "recorded", approver: { userId: u, personId: u }, at: "2026-10-23T00:00:00Z", decision: "approve", contentDigest: d, diffDigest: d, baseRevision: 3, policyVersion: 1, valuesDigest: d, candidateDigest: d }, true],
    ["Approval", { id: u, approver: { userId: u, personId: u }, at: "2026-10-23T00:00:00Z", decision: "approve", contentDigest: d, diffDigest: d, baseRevision: 3, policyVersion: 1, valuesDigest: d, candidateDigest: d }, false],
    ["Role", { id: u, name: "tech-lead", permissions: ["promotion.approve"], builtin: false }, true],
    ["ApprovalPolicy", { minApprovals: 1, eligibleRoles: ["approver"], executorMayApprove: false }, true],
    ["ApprovalPolicy", { minApprovals: 1, eligibleRoles: ["approver"], executorMayApprove: "yes" }, false],
    ["Person", { id: u, displayName: "A", verified: true, corporateId: "M123", verifiedAt: "2026-10-23T00:00:00Z" }, true],
    ["EffectivePolicy", { version: 1, minApprovals: 1 }, false],
    ["EffectivePolicy", { version: 1, minApprovals: 1, authorMayApprove: false, executorMayApprove: false, emergencySelfExecution: false }, true],
    // Provenance (G-2, R7-3): a rollback copy inherits; promoted content always names its promotion.
    ["Release", release, true],
    ["Release", { ...release, contentOriginVersion: undefined }, false],
    ["Release", { ...release, originPromotionId: null }, true],
    ["Release", { ...release, origin: "promotion", rollbackOf: null, originPromotionId: null }, false],
    ["Release", { ...release, origin: "promotion", rollbackOf: null, originPromotionId: undefined }, false],
    ["Release", { ...release, contentFirstActivatedAt: undefined }, false],
    ["Promotion", promo, true],
    ["Promotion", { ...promo, proofUse: undefined }, false],
    ["Promotion", { ...promo, kind: "emergency-rollback" }, true],
    // The operational state of a promotion and the post-review of an emergency rollback are separate (N0-4).
    ["Promotion", { ...promo, status: "emergency-reviewed" }, false],
    ["Promotion", { ...promo, status: "emergency-pending-review" }, false],
    ["Promotion", emergency, true],
    ["Promotion", { ...emergency, status: "failed", execution: exec("failed", "partial") }, true],
    ["Promotion", { ...emergency, status: "failed", execution: exec("failed") }, false],
    ["Promotion", { ...emergency, postReview: undefined }, false],
    ["Promotion", { ...emergency, status: "awaiting-approval", execution: undefined }, false],
    ["Promotion", { ...emergency, status: "awaiting-emergency-execution", execution: undefined, postReview: undefined }, true],
    ["Promotion", { ...promo, status: "awaiting-emergency-execution" }, false],
    ["Promotion", { ...promo, status: "converged", execution: exec("converged"), postReview: review }, false],
    ["Promotion", { ...promo, status: "converged" }, false],
    ["Promotion", { ...promo, status: "rolled-back", execution: exec("failed", "deadline") }, false],
    ["Promotion", { ...promo, status: "rolled-back", execution: exec("failed", "deadline"), recoveredBy: { kind: "emergency-rollback", promotionId: u, deploymentRevision: 9, at: "2026-10-24T00:00:00Z" } }, true],
    ["EmergencyPostReview", { ...review, status: "in-review", reviewer }, true],
    ["EmergencyPostReview", { ...review, status: "in-review" }, false],
    ["EmergencyPostReview", { ...review, status: "no-findings", reviewer, justification: "restaurou o pix", decidedAt: "2026-10-24T02:00:00Z" }, true],
    ["EmergencyPostReview", { ...review, status: "no-findings", reviewer, decidedAt: "2026-10-24T02:00:00Z" }, false],
    ["EmergencyPostReview", { ...review, status: "corrective-action", reviewer, justification: "plantão sem janela", decidedAt: "2026-10-24T02:00:00Z" }, false],
    ["EmergencyPostReview", { ...review, status: "corrective-action", reviewer, justification: "plantão sem janela", correctiveAction: "INC-42", decidedAt: "2026-10-24T02:00:00Z" }, true],
    ["EmergencyPostReview", { ...review, justification: "cedo demais" }, false],
    // Package content is typed per kind, with variables only where the schema allows them (N0-1, N0-2).
    ["PackagePayload", { ...base, content: content({ services: [service] }) }, true],
    ["PackagePayload", { ...base, content: content({ services: [{ id: u, spec: { name: "recarga" } }] }) }, false],
    ["PackagePayload", { ...base, content: content({ services: [{ ...service, spec: { ...service.spec, retries: { $var: "N" } } }] }) }, false],
    ["PackagePayload", { ...base, content: content({ services: [{ ...service, spec: { ...service.spec, extra: 1 } }] }) }, false],
    ["PackagePayload", { ...base, content: content({ consumers: [{ id: u, spec: { customId: "c-1" }, aclGroups: [] }] }) }, true],
    ["PackagePayload", { ...base, content: content({ targets: [{ id: u, upstreamId: u, spec: { target: { $var: "PIX_TARGET" } } }] }) }, true],
    ["PackagePayload", { ...base, content: content({ certificates: [{ id: u, spec: { cert: "-----BEGIN", key: "-----BEGIN", snis: [] } }] }) }, false],
    ["PackagePayload", { ...base, content: content({ certificates: [{ id: u, spec: { cert: "-----BEGIN", key: { $var: "TLS_KEY" }, snis: [] } }] }) }, true],
    ["PackagePayload", { ...base, content: content({ variables: [{ type: "host", secret: false, required: true }] }) }, false],
    ["PackagePayload", { ...base, sourceStage: "prd", targetStage: "dev", content: emptyContent }, false],
    ["PackagePayload", { ...base, sourceStage: "hml", targetStage: "hml", content: emptyContent }, false],
    ["WorkspaceServiceWrite", { name: "tvro", protocol: "http", host: { $var: "TVRO_HOST" }, port: { $var: "TVRO_PORT" } }, true],
    ["WorkspaceServiceWrite", { name: "tvro", protocol: "http", host: { $var: "lower" }, port: 80 }, false],
    ["WorkspaceServiceWrite", { name: "tvro", protocol: "http", host: "tvro.svc", port: 80, extra: true }, false],
    ["WorkspaceConsumerWrite", { username: "app", extra: true }, false],
    ["WorkspaceVariableDeclaration", { type: "privateKey", secret: true, required: true }, true],
    ["WorkspaceVariableDeclaration", { type: "host", secret: false, required: true, value: "x" }, false],
    // M2M reads only a summary (N0-3); errors, approvals, attestations and permissions are closed (N0-8, N0-10, N0-12).
    ["M2mPromotionSummary", { id: u, packageId: u, status: "validating", kind: "full", contentDigest: d, updatedAt: "2026-10-24T00:00:00Z" }, true],
    ["M2mPromotionSummary", { id: u, packageId: u, status: "validating", kind: "full", contentDigest: d, updatedAt: "2026-10-24T00:00:00Z", changes: [] }, false],
    ["M2mValidationSummary", { result: "blocked", checks: [{ name: "conflicts", result: "blocked", detail: "consumer app-x" }], at: "2026-10-24T00:00:00Z" }, false],
    ["Problem", {}, false],
    ["Problem", { type: "about:blank", title: "Conflict", status: 409 }, true],
    ["Approval", { id: u, state: "banana", approver: { userId: u, personId: u }, at: "2026-10-23T00:00:00Z", decision: "approve", contentDigest: d, diffDigest: d, baseRevision: 3, policyVersion: 1, valuesDigest: d, candidateDigest: d }, false],
    ["Attestation", att, true],
    ["Attestation", { ...att, jws: "eyJ.eyJ.c2ln" }, false],
    ["SignedPackage", { protected: "", payload: "", signature: "" }, false],
    ["RoleBindingWrite", { subjectType: "user", subjectId: u, permissions: ["promotion.typo"] }, false],
    ["RoleBindingWrite", { subjectType: "user", subjectId: u, permissions: ["m2m.submit"] }, false],
    ["RoleBindingWrite", { subjectType: "user", subjectId: u, role: "editor", extra: 1 }, false],
    ["RoleWrite", { name: "tech-lead", permissions: ["rollback.emergency"] }, false],
    ["RoleWrite", { name: "editor", permissions: ["promotion.approve"] }, false],
    ["RoleWrite", { name: "tech-lead", permissions: ["promotion.approve"] }, true],
    ["WorkspaceWrite", { name: "TVRO", extra: 1 }, false],
    // Revocation is by digest and only adds rows.
    ["ContentRevocation", { workspaceId: u, contentDigest: d, reason: "CVE na versão 4", revokedAt: "2026-10-24T00:00:00Z", revokedBy: {} }, true],
    ["ContentRevocation", { workspaceId: u, contentDigest: "sha256:x", reason: "x", revokedAt: "2026-10-24T00:00:00Z", revokedBy: {} }, false],
    ["AuthenticationProfile", { composition: "single", mechanisms: [{ plugin: "jwt", scope: "route" }] }, true],
    // Isolation pendencies and pods (R8-3, R9-1).
    ["ClusterIsolation", pend("confirmed-violation", true, "node"), true],
    ["ClusterIsolation", pend("unconfirmed-isolation", true), true],
    ["ClusterIsolation", pend("communication-failure", false), true],
    ["ClusterIsolation", pend("communication-failure", true), false],
    ["ClusterIsolation", pend("communication-failure", false, "node"), false],
    ["ClusterIsolation", pend("confirmed-violation", false), false],
    ["ClusterIsolation", { clusterId: u, pods: [pod], pendencies: [] }, true],
    ["ClusterIsolation", { clusterId: u, pods: [{ ...pod, bootId: undefined }], pendencies: [] }, false],
    ["ClusterIsolation", { clusterId: u, pods: [{ ...pod, leaseExpiresAt: "2026-10-24T00:00:00Z" }], pendencies: [] }, false],
    ["ClusterIsolation", { clusterId: u, pods: [{ ...pod, state: "serving" }], pendencies: [] }, false],
    // Workspace variants of the gateway entities (C-27, D1).
    ["WorkspaceRouteWrite", { name: "recarga", serviceId: u, paths: ["/recarga"] }, true],
    ["WorkspaceRouteWrite", { name: "recarga", serviceId: u, hosts: ["a.example"] }, false],
    ["WorkspaceRouteWrite", { name: "recarga", serviceId: u, paths: [] }, false],
    ["WorkspaceRouteWrite", { name: "recarga", serviceId: u, paths: ["recarga"] }, false],
    ["WorkspaceServiceWrite", { name: "tvro", protocol: "http", host: "tvro.svc", port: 80 }, true],
    ["WorkspaceServiceWrite", { name: "tvro", protocol: "http", host: "x.other.gromesh.internal", port: 80 }, false],
    ["WorkspacePluginWrite", { name: "rate-limiting", config: {}, scope: { routeId: u } }, true],
    ["WorkspacePluginWrite", { name: "rate-limiting", config: {}, scope: {} }, false],
    ["WorkspacePluginWrite", { name: "rate-limiting", config: {} }, false],
    ["WorkspacePluginWrite", { name: "gromesh-route-guard", config: {}, scope: { routeId: u } }, false],
  ])("%s %j -> %s", (name, value, expected) => {
    const ok = valid(name, value);
    expect(ok, JSON.stringify(validator("control-plane-v2.openapi.yaml", name).errors)).toBe(expected);
  });

  it("defaults stripPath to false: the full path with the prefix reaches the upstream (D1)", () => {
    expect(v2.components.schemas.WorkspaceRouteWrite.properties.stripPath.default).toBe(false);
  });

  it.each([
    ["/reconciliations", { action: "reapply", reason: "nó voltou" }, true],
    ["/reconciliations", { action: "rollback", reason: "x", workspaceId: u, releaseVersion: 1 }, false],
    ["/reconciliations", { action: "reapply", reason: "x", emergency: true }, false],
    ["/workspaces/{workspaceId}/routes/{routeId}/path-compatibility", { dryRun: true }, true],
    ["/workspaces/{workspaceId}/routes/{routeId}/path-compatibility", { dryRun: false }, false],
    ["/workspaces/{workspaceId}/routes/{routeId}/path-compatibility", { dryRun: false, expectedDiffDigest: d }, true],
    ["/clusters/{clusterId}/isolation-releases", { pendencyId: u, justification: "causa corrigida na CNI" }, true],
    ["/clusters/{clusterId}/isolation-releases", { violationId: u, justification: "causa corrigida na CNI" }, false],
    ["/clusters/{clusterId}/isolation-releases", { pendencyId: u, justification: "ok" }, false],
    ["/promotions/{promotionId}/post-review/decision", { outcome: "no-findings", justification: "restaurou o pix" }, true],
    ["/promotions/{promotionId}/post-review/decision", { outcome: "corrective-action", justification: "plantão sem janela" }, false],
    ["/promotions/{promotionId}/post-review/decision", { outcome: "corrective-action", justification: "plantão sem janela", correctiveAction: "INC-42" }, true],
    ["/promotions/{promotionId}/post-review/decision", { outcome: "findings", justification: "plantão sem janela", correctiveAction: "INC-42" }, false],
    ["/promotions/{promotionId}/post-review/decision", { outcome: "approve", justification: "plantão sem janela" }, false],
    ["/promotions/{promotionId}/post-review/decision", { outcome: "no-findings", justification: "ok" }, false],
  ])("body of %s %j -> %s", (path, value, expected) => {
    expect(bodyOf(path)(value)).toBe(expected);
  });
});

describe("agent protocol v2", () => {
  const report = { clusterId: u, podUid: u, bootId: u, admissionId: u, seq: 2, prevDigest: d, state: "ok", failedCapabilities: [], challenge: null, final: false };
  const jws = { protected: "eyJ", payload: "eyJ", signature: "c2ln" };
  it.each([
    ["ProbeReport", report, true],
    ["ProbeReport", { ...report, seq: 1, prevDigest: null }, true],
    ["ProbeReport", { ...report, seq: 1 }, false],
    ["ProbeReport", { ...report, prevDigest: null }, false],
    ["ProbeReport", { ...report, final: true }, false],
    ["ProbeReport", { ...report, final: true, finalReason: "pod-terminated", kongStopConfirmed: true }, true],
    ["ProbeReport", { ...report, finalReason: "pod-terminated" }, false],
    ["ProbeReport", { ...report, state: "violation" }, false],
    ["ProbeReport", { ...report, state: "violation", failedCapabilities: ["CAP-3"] }, true],
    ["AdmissionRequest", { podUid: u, podName: "kong-0", nodeName: "n1", bootId: u, probePublicKey: "A".repeat(43) }, true],
    ["AdmissionRequest", { podUid: u, podName: "kong-0", nodeName: "n1", probePublicKey: "A".repeat(43) }, false],
    ["AdmissionRequestStatus", { requestId: u, outcome: "pending", challenge: "c".repeat(22) }, true],
    ["AdmissionRequestStatus", { requestId: u, outcome: "granted", challenge: "c".repeat(22) }, false],
    ["AdmissionRequestStatus", { requestId: u, outcome: "granted", challenge: "c".repeat(22), admission: jws }, true],
    ["AdmissionRequestStatus", { requestId: u, outcome: "refused", challenge: "c".repeat(22), reason: "chain-not-answered" }, true],
    ["AdmissionRequestStatus", { requestId: u, outcome: "refused", challenge: "c".repeat(22), admission: jws, reason: "timeout" }, false],
    ["AdmissionRequestStatus", { requestId: u, outcome: "pending", challenge: "c".repeat(22), reason: "timeout" }, false],
    ["IsolationLease", { state: "ok", podUid: u, bootId: u, admissionId: u, issuedBoottimeNs: 1, expiresBoottimeNs: 33_000_000_001, nonce: "n".repeat(22), capabilities: ["CAP-1"], issuedAt: "2026-10-24T00:00:00Z" }, true],
    ["IsolationLease", { state: "ok", podUid: u, admissionId: u, issuedBoottimeNs: 1, expiresBoottimeNs: 2, nonce: "n".repeat(22), capabilities: [], issuedAt: "2026-10-24T00:00:00Z" }, false],
    ["IsolationLease", { state: "ok", podUid: u, bootId: u, admissionId: u, expiresAt: "2026-10-24T00:00:33Z", nonce: "n".repeat(22), capabilities: [], issuedAt: "2026-10-24T00:00:00Z" }, false],
    ["StatusReport", { nodeId: "n1", epoch: 2, appliedRevision: 7, appliedHash: d, kongHealthy: true, analytics: "analytics-degraded", isolationState: "ok" }, true],
    ["StatusReport", { nodeId: "n1", appliedRevision: 7, appliedHash: d, kongHealthy: true }, false],
    ["IsolationReleaseClaims", { clusterId: u, pendencyId: u, kind: "communication-failure", expiresAt: "2026-10-24T00:15:00Z" }, false],
  ])("%s %j -> %s", (name, value, expected) => {
    expect(validAgent(name, value)).toBe(expected);
  });

  it("serves deployments that match the snapshot v2 schema, and refuses the v1 envelope", () => {
    const snapshot = ajv.getSchema(`${BASE}snapshot-v2.schema.json`)!;
    expect(snapshot(JSON.parse(read("examples/snapshot-v2.example.json"))), JSON.stringify(snapshot.errors)).toBe(true);
    expect(snapshot(JSON.parse(read("examples/snapshot.example.json")))).toBe(false);
    const { epoch: _epoch, ...withoutEpoch } = JSON.parse(read("examples/snapshot-v2.example.json"));
    expect(snapshot(withoutEpoch)).toBe(false);
    const ref = agentV2.paths["/agent/v2/deployments/current"].get.responses[200].content["application/json"].schema.$ref;
    expect(ref).toBe("./snapshot-v2.schema.json");
  });

  it("keeps the v2 invariants in the snapshot example: prefix, tags, guard and canary", () => {
    const snap = JSON.parse(read("examples/snapshot-v2.example.json"));
    expect(snap.hash).toBe(hashConfig(snap.config));
    const slugOf = new Map<string, string>(snap.members.map((m: Doc) => [`gromesh-ws:${m.workspaceId}`, m.slug]));
    const owner = (e: Doc) => {
      const tags = (e.tags as string[]).filter((t) => t.startsWith("gromesh-ws:") || t === "gromesh-platform");
      expect(tags.length, e.id).toBe(1);
      return tags[0]!;
    };
    for (const kind of ["services", "routes", "consumers", "plugins"]) for (const e of snap.config[kind]) owner(e);
    const guarded = new Set(snap.config.plugins.filter((p: Doc) => p.name === "gromesh-route-guard").map((p: Doc) => p.route));
    for (const route of snap.config.routes) {
      expect(guarded.has(route.id), route.name).toBe(true);
      const tag = owner(route);
      if (tag === "gromesh-platform") {
        expect(route.paths).toEqual(["/.gromesh/guard/current"]);
        continue;
      }
      const slug = slugOf.get(tag)!;
      expect(route.name.startsWith(`${slug}~`), route.name).toBe(true);
      expect(route.strip_path, route.name).toBe(false);
      for (const p of route.paths) expect(p === `/${slug}` || p.startsWith(`/${slug}/`) || p.startsWith(`~/${slug}(?:`), p).toBe(true);
    }
    expect(snap.config.routes.some((r: Doc) => owner(r) === "gromesh-platform")).toBe(true);
  });
});

describe("signed package vector (C-21)", () => {
  const vector = JSON.parse(read("examples/signed-package.example.json"));
  const jcs = (v: unknown): string =>
    v === null || typeof v !== "object" ? JSON.stringify(v)
    : Array.isArray(v) ? `[${v.map(jcs).join(",")}]`
    : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${jcs((v as Record<string, unknown>)[k])}`).join(",")}}`;
  const key = createPublicKey({ key: vector.publicKeyJwk, format: "jwk" });
  const check = (jws: { protected: string; payload: string; signature: string }) =>
    verify(null, Buffer.from(`${jws.protected}.${jws.payload}`, "ascii"), key, Buffer.from(jws.signature, "base64url"));

  it("signs the JCS bytes of a valid package payload with EdDSA, verified over the received bytes", () => {
    expect(valid("SignedPackage", vector.signedPackage)).toBe(true);
    expect(jcs(vector.payload)).toBe(vector.canonicalPayload);
    expect(Buffer.from(vector.signedPackage.payload, "base64url").toString("utf8")).toBe(vector.canonicalPayload);
    expect(JSON.parse(Buffer.from(vector.signedPackage.protected, "base64url").toString("utf8"))).toEqual({ alg: "EdDSA", kid: "dev-2026-10", typ: "gromesh-package+json", pkgVersion: 1 });
    expect(valid("PackagePayload", JSON.parse(vector.canonicalPayload))).toBe(true);
    expect(check(vector.signedPackage)).toBe(true);
  });

  const digestOf = (content: unknown) => "sha256:" + createHash("sha256").update(jcs(content), "utf8").digest("hex");
  const accept = (jws: { protected: string; payload: string; signature: string }) => {
    if (!check(jws)) return false;
    const payload = JSON.parse(Buffer.from(jws.payload, "base64url").toString("utf8"));
    return valid("PackagePayload", payload) && payload.contentDigest === digestOf(payload.content);
  };

  it("declares the digest of the content it carries, with every array ordered by id", () => {
    const { content, contentDigest } = vector.payload;
    expect(contentDigest).toBe(digestOf(content));
    for (const [kind, items] of Object.entries(content as Record<string, { id?: string; name?: string }[]>)) {
      const keys = items.map((i) => i.id ?? i.name!);
      expect(keys, kind).toEqual([...keys].sort());
    }
    expect(content.services.length).toBeGreaterThan(0);
    expect(accept(vector.signedPackage)).toBe(true);
  });

  it("refuses a correctly signed package whose contentDigest does not match its content", () => {
    expect(check(vector.signedPackageWithWrongDigest)).toBe(true);
    expect(accept(vector.signedPackageWithWrongDigest)).toBe(false);
  });

  it("fails on any change to the bytes, including an equivalent non-canonical serialization", () => {
    const tampered = Buffer.from(vector.canonicalPayload.replace('"slug":"tvro"', '"slug":"tvrp"'), "utf8").toString("base64url");
    expect(check({ ...vector.signedPackage, payload: tampered })).toBe(false);
    const pretty = Buffer.from(JSON.stringify(vector.payload, null, 1), "utf8").toString("base64url");
    expect(check({ ...vector.signedPackage, payload: pretty })).toBe(false);
  });
});
