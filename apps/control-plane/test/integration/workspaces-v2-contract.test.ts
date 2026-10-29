import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { hashConfig } from "@gromesh/compiler";
import { Reflector } from "@nestjs/core";
import { AccessController } from "../../src/access/access.js";
import { deriveCoreProfile } from "../../src/common/contract.js";
import { PathCompatibilityController } from "../../src/workspaces/path-compatibility.js";
import { WorkspacesController } from "../../src/workspaces/workspaces-api.js";
import { WorkspaceRoutesController, WorkspaceServicesController } from "../../src/gateway/gateway.js";
import { WorkspaceConsumersController } from "../../src/consumers/consumers.js";
import { WorkspaceCredentialsController } from "../../src/consumers/credentials.js";
import { WorkspaceUpstreamsController } from "../../src/upstreams/upstreams.js";
import { WorkspaceCertificatesController } from "../../src/certificates/certificates.js";
import { WorkspacePluginsController } from "../../src/plugins/plugins.js";
import { WorkspaceConfigTransferController } from "../../src/config-transfer/config-transfer.js";
import { InstanceController } from "../../src/instance/instance.js";
import { SigningKeysController } from "../../src/instance/signing-keys.js";
import { ClusterIsolationController } from "../../src/isolation/isolation.js";
import { DeploymentsController, ReleasesController } from "../../src/releases/releases.js";
import { DeliveryProtocolController } from "../../src/deployments/deployments.js";
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

  // The implementation phases remove x-gromesh-planned operation by operation: an implemented operation has its
  // handler under /api/v2 with the contract's permission, scope and session rule; a planned one has none.
  it("has a handler for every implemented v2 operation and none for a planned one", () => {
    expect(v2Ops.length).toBeGreaterThan(80);
    expect(agentOps.length).toBe(7);
    const express = h.app.getHttpAdapter().getInstance() as { router: { stack: { route?: { path: string; methods: Record<string, boolean> } }[] } };
    const routes = new Set(express.router.stack.flatMap((layer) => (layer.route ? Object.keys(layer.route.methods).map((m) => `${m.toUpperCase()} ${layer.route!.path}`) : [])));
    expect(routes.size).toBeGreaterThan(40);
    const nest = (path: string) => `/api/v2${path.replace(/\{([a-zA-Z]+)\}/g, ":$1")}`;
    for (const { path, method, op } of v2Ops) {
      const has = routes.has(`${method.toUpperCase()} ${nest(path)}`);
      expect(has, `${op.operationId} ${op["x-gromesh-planned"] ? "is planned but has a handler" : "has no handler"}`).toBe(!op["x-gromesh-planned"]);
    }
    // The agent protocol v2 is served under its own paths (node token), with no /api prefix.
    for (const { path, method, op } of agentOps) {
      const has = routes.has(`${method.toUpperCase()} ${path.replace(/\{([a-zA-Z]+)\}/g, ":$1")}`);
      expect(has, `${op.operationId} ${op["x-gromesh-planned"] ? "is planned but has a handler" : "has no handler"}`).toBe(!op["x-gromesh-planned"]);
    }
    expect([...routes].filter((r) => r.includes(" /agent/v2")).length).toBe(agentOps.filter(({ op }) => !op["x-gromesh-planned"]).length);
  });

  it("declares on every v2 handler the contract's permission, scope and session rule", () => {
    const reflector = new Reflector();
    const handlers = new Map<string, { permission: string; scope: string; sessionOnly: boolean }>();
    for (const controller of [
      AccessController,
      PathCompatibilityController,
      WorkspacesController,
      WorkspaceServicesController,
      WorkspaceRoutesController,
      WorkspaceConsumersController,
      WorkspaceCredentialsController,
      WorkspaceUpstreamsController,
      WorkspaceCertificatesController,
      WorkspacePluginsController,
      WorkspaceConfigTransferController,
      InstanceController,
      SigningKeysController,
      ClusterIsolationController,
      ReleasesController,
      DeploymentsController,
      DeliveryProtocolController,
    ]) {
      const base = (Reflect.getMetadata("path", controller) as string).replace(/^\/?/, "/");
      for (const name of Object.getOwnPropertyNames(controller.prototype)) {
        const fn = (controller.prototype as unknown as Record<string, () => unknown>)[name]!;
        const path = Reflect.getMetadata("path", fn) as string | undefined;
        const method = Reflect.getMetadata("method", fn) as number | undefined;
        if (path === undefined || method === undefined) continue;
        const meta = reflector.get("gromesh:required-permission", fn) as { permission: string; scope: string };
        handlers.set(`${["GET", "POST", "PUT", "DELETE", "PATCH"][method]} ${base}/${path}`.replace(/\/+/g, "/").replace(/\/$/, ""), { ...meta, sessionOnly: reflector.get("gromesh:session-only", fn) === true });
      }
    }
    const implemented = v2Ops.filter(({ op }) => !op["x-gromesh-planned"]);
    expect(implemented.length).toBe(handlers.size);
    for (const { path, method, op } of implemented) {
      const key = `${method.toUpperCase()} /api/v2${path.replace(/\{([a-zA-Z]+)\}/g, ":$1")}`;
      const schemes = (op.security ?? v2.security).flatMap((sec: Doc) => Object.keys(sec));
      expect(handlers.get(key), `${op.operationId} (${key})`).toEqual({ permission: op["x-required-permission"], scope: op["x-scope"], sessionOnly: !schemes.includes("bearerApiToken") });
    }
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

  it("reports a conflict as 409 on a single write and inside the 422 of an import (N0R-5)", () => {
    for (const { op } of v2Ops) {
      const text = `${op.summary ?? ""} ${op.description ?? ""}`.replace(/never a separate 409/g, "");
      if (/\b409\b/.test(text)) expect(Object.keys(op.responses), op.operationId).toContain("409");
    }
    const byId = (id: string) => v2Ops.find((o) => o.op.operationId === id)!.op;
    for (const id of ["createConsumer", "replaceConsumer", "createJwtCredential", "createBasicAuthCredential", "createCertificate", "replaceCertificate", "declareWorkspaceVariable"]) {
      expect(Object.keys(byId(id).responses), id).toContain("409");
    }
    expect(Object.keys(byId("importWorkspaceConfig").responses)).not.toContain("409");
    expect(byId("importWorkspaceConfig").description).toContain("never a separate 409");
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
  type Where = { schema: string; phase?: string } | { info: string } | { v1: string } | { deferred: string; info?: string };
  const ELSEWHERE: Record<string, Where> = {
    // compiler + data plane: one workspace's credential never authenticates on another's route
    "GW-WS-06": { deferred: "N2", info: "A credential of one workspace never authenticates on a route of another" },
    "GW-WS-06a": { schema: "AuthenticationProfile/oneOf/1", phase: "L10" },
    "GW-RBAC-08": { schema: "RoleBindingWrite/properties/effect/oneOf/1", phase: "L3" },
    "GW-RBAC-10": { info: "deny by default" },
    "GW-RBAC-12": { info: "API tokens act with the intersection of the token's scopes and the owner's current permissions" },
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
  const infoText: string = v2.info.description.replace(/\s+/g, " ");
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
      } else if ("deferred" in where) {
        // Proven only at runtime: the contract names the phase and the proof.
        const proof = v2.info["x-gromesh-deferred-proofs"]?.[r];
        expect(proof?.phase, r).toBe(where.deferred);
        expect(proof?.proof?.length, r).toBeGreaterThan(40);
        if (where.info) expect(infoText, r).toContain(where.info);
      } else if ("info" in where) expect(infoText, r).toContain(where.info);
      else expect(v1Ids.has(where.v1), `${r}: v1 ${where.v1}`).toBe(true);
    }
    const deferred = Object.entries(ELSEWHERE).filter(([, w]) => "deferred" in w).map(([r]) => r);
    expect(Object.keys(v2.info["x-gromesh-deferred-proofs"]).sort()).toEqual(deferred.sort());
  });

  it("accepts only a session on the deciding operations, never an API token nor M2M (GW-RBAC-12)", () => {
    const listed = /Deciding operations accept only a session[^:]*:([^.]*)\./.exec(infoText)![1]!;
    const deciding = listed.replace(" and ", ", ").split(",").map((s: string) => s.trim());
    expect(deciding.length).toBe(6);
    for (const id of deciding) {
      const found = v2Ops.find(({ op }) => op.operationId === id);
      expect(found, id).toBeDefined();
      expect(found!.op.security, id).toEqual([{ cookieAuth: [], csrfToken: [] }]);
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
      ["AdmissionOutcome", "AdmissionServedState", "AdmissionState", "ApprovalState", "DeliveryProtocolState", "DeploymentState", "EmergencyPostReviewStatus", "InstanceSigningKeyStatus", "IsolationPendencyLifecycle", "PodIsolationState", "PromotionStatus", "WorkspaceRequestStatus"].sort(),
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
  const core = deriveCoreProfile(v2);
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
  const pod = { podUid: u, bootId: u, podName: "kong-0", nodeName: "n1", state: "verifying", admission: "open", servedState: "served", reporting: "communication-failure", lastSeq: 7, leaseRemainingMs: 21000 };
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
    // Round 2 of the N0 review (N0R-1..N0R-4): nested shapes closed, secrets classified, results consistent.
    ["PackagePayload", { ...base, content: content({ consumers: [{ id: u, spec: {}, aclGroups: [] }] }) }, false],
    ["PackagePayload", { ...base, content: content({ consumers: [{ id: u, spec: { username: null, customId: null }, aclGroups: [] }] }) }, false],
    ["PackagePayload", { ...base, content: content({ consumers: [{ id: u, spec: { username: "" }, aclGroups: [] }] }) }, false],
    ["PackagePayload", { ...base, content: emptyContent, extra: 1 }, false],
    ["PackagePayload", { ...base, content: content({ upstreams: [{ id: u, spec: { name: "pix", healthchecks: { active: { type: "http", httpPath: "/h" }, passive: null } } }] }) }, true],
    ["PackagePayload", { ...base, content: content({ upstreams: [{ id: u, spec: { name: "pix", healthchecks: { active: { type: "http", script: "x" } } } }] }) }, false],
    ["PackagePayload", { ...base, content: content({ upstreams: [{ id: u, spec: { name: "pix", healthchecks: { passive: { unhealthyTimeouts: 3, extra: 1 } } } }] }) }, false],
    ["PackagePayload", { ...base, content: content({ upstreams: [{ id: u, spec: { name: "pix", healthchecks: { other: {} } } }] }) }, false],
    ["PackagePayload", { ...base, content: content({ variables: [{ name: "TLS_KEY", type: "privateKey", secret: false, required: true }] }) }, false],
    ["WorkspaceVariableDeclaration", { type: "privateKey", secret: false, required: true }, false],
    ["WorkspaceVariableDeclaration", { type: "credential", secret: false, required: true }, false],
    ["WorkspaceVariableDeclaration", { type: "credential", secret: true, required: true }, true],
    ["WorkspaceStateSummary", { workspaceKey: u, activeRelease: { version: 4, contentDigest: d }, deploymentRevision: 9, convergence: "converged" }, true],
    ["WorkspaceStateSummary", { workspaceKey: u, activeRelease: null, deploymentRevision: 0, convergence: "no-nodes" }, true],
    // N1-C0: the migration report and the v1 usage counter (decision H-9) are closed and never carry values.
    ["WorkspaceMigrationReport", { migratedAt: "2026-10-25T00:00:00Z", status: "complete", blockers: [], workspaces: [{ workspaceId: u, name: "TVRO", slug: "tvro", slugStatus: "derived", legacyRoutes: 3, routesWithoutPath: 0 }], accessChanges: [{ userId: u, globalRole: "editor", change: "implicit-access-dropped" }] }, true],
    ["WorkspaceMigrationReport", { migratedAt: "2026-10-25T00:00:00Z", status: "complete", blockers: [], workspaces: [], accessChanges: [{ userId: u, globalRole: "admin", change: "implicit-access-dropped" }] }, false],
    ["WorkspaceMigrationReport", { migratedAt: "2026-10-25T00:00:00Z", status: "complete", blockers: [], workspaces: [{ workspaceId: u, name: "Área 1", slug: "area-1-2", slugStatus: "adjusted", slugReason: "collision", legacyRoutes: 0, routesWithoutPath: 1 }], accessChanges: [] }, true],
    ["WorkspaceMigrationReport", { migratedAt: "2026-10-25T00:00:00Z", status: "blocked", blockers: [{ kind: "jwt-key", occurrences: [{ workspaceId: u, source: "draft", entityType: "jwt-credential", entityId: u, snapshotVersion: null }, { workspaceId: u, source: "active-snapshot", entityType: "jwt-credential", entityId: u, snapshotVersion: 4 }] }], workspaces: [], accessChanges: [] }, true],
    ["WorkspaceMigrationReport", null, false],
    ["WorkspaceMigrationReport", { migratedAt: "2026-10-25T00:00:00Z", workspaces: [], accessChanges: [] }, false],
    ["WorkspaceMigrationReport", { migratedAt: "2026-10-25T00:00:00Z", status: "complete", blockers: [], workspaces: [{ workspaceId: u, name: "x", slug: "x2", slugStatus: "adjusted", legacyRoutes: 0, routesWithoutPath: 0 }], accessChanges: [] }, false],
    ["WorkspaceMigrationReport", { migratedAt: "2026-10-25T00:00:00Z", status: "complete", blockers: [], workspaces: [{ ...{ workspaceId: u, name: "TVRO", slug: "tvro", slugStatus: "derived", legacyRoutes: 3, routesWithoutPath: 0 }, slugReason: "reserved" }], accessChanges: [] }, false],
    ["WorkspaceMigrationReport", { migratedAt: "2026-10-25T00:00:00Z", status: "complete", blockers: [], workspaces: [], accessChanges: [{ userId: u, change: "widened" }] }, false],
    ["WorkspaceMigrationReport", { migratedAt: "2026-10-25T00:00:00Z", status: "complete", blockers: [], workspaces: [], accessChanges: [], credentials: [] }, false],
    // The status agrees with the blockers: complete has none, blocked has at least one.
    ["WorkspaceMigrationReport", { migratedAt: "2026-10-25T00:00:00Z", status: "complete", blockers: [{ kind: "sni", occurrences: [{ workspaceId: u, source: "draft", entityType: "certificate", entityId: u, snapshotVersion: null }, { workspaceId: u, source: "draft", entityType: "certificate", entityId: u, snapshotVersion: null }] }], workspaces: [], accessChanges: [] }, false],
    ["WorkspaceMigrationReport", { migratedAt: "2026-10-25T00:00:00Z", status: "blocked", blockers: [], workspaces: [], accessChanges: [] }, false],
    ["WorkspaceMigrationReport", { migratedAt: "2026-10-25T00:00:00Z", status: "blocked", blockers: [{ kind: "sni", occurrences: [{ workspaceId: u, source: "draft", entityType: "certificate", entityId: u, snapshotVersion: null }, { workspaceId: u, source: "draft", entityType: "certificate", entityId: u, snapshotVersion: null }] }], workspaces: [], accessChanges: [] }, true],
    // A blocker names entities only: never a value, and at least the two occurrences that collide.
    ["WorkspaceMigrationReport", { migratedAt: "2026-10-25T00:00:00Z", status: "blocked", blockers: [{ kind: "jwt-key", occurrences: [{ workspaceId: u, source: "draft", entityType: "jwt-credential", entityId: u, snapshotVersion: null }] }], workspaces: [], accessChanges: [] }, false],
    ["WorkspaceMigrationReport", { migratedAt: "2026-10-25T00:00:00Z", status: "blocked", blockers: [{ kind: "jwt-key", value: "iss-1", occurrences: [{ workspaceId: u, source: "draft", entityType: "jwt-credential", entityId: u, snapshotVersion: null }, { workspaceId: u, source: "active-snapshot", entityType: "jwt-credential", entityId: u, snapshotVersion: 4 }] }], workspaces: [], accessChanges: [] }, false],
    ["WorkspaceMigrationReport", { migratedAt: "2026-10-25T00:00:00Z", status: "blocked", blockers: [{ kind: "jwt-key", occurrences: [{ workspaceId: u, source: "draft", entityType: "jwt-credential", entityId: u, snapshotVersion: null, key: "iss-1" }, { workspaceId: u, source: "active-snapshot", entityType: "jwt-credential", entityId: u, snapshotVersion: 4 }] }], workspaces: [], accessChanges: [] }, false],
    ["WorkspaceMigrationReport", { migratedAt: "2026-10-25T00:00:00Z", status: "blocked", blockers: [{ kind: "jwt-key", occurrences: [{ workspaceId: u, source: "draft", entityType: "jwt-credential", entityId: u, snapshotVersion: 3 }, { workspaceId: u, source: "active-snapshot", entityType: "jwt-credential", entityId: u, snapshotVersion: 4 }] }], workspaces: [], accessChanges: [] }, false],
    ["WorkspaceMigrationReport", { migratedAt: "2026-10-25T00:00:00Z", status: "blocked", blockers: [{ kind: "jwt-key", occurrences: [{ workspaceId: u, source: "draft", entityType: "jwt-credential", entityId: u, snapshotVersion: null }, { workspaceId: u, source: "active-snapshot", entityType: "jwt-credential", entityId: u, snapshotVersion: null }] }], workspaces: [], accessChanges: [] }, false],
    ["WorkspaceMigrationReport", { migratedAt: "2026-10-25T00:00:00Z", status: "blocked", blockers: [{ kind: "consumer-username", occurrences: [{ workspaceId: u, source: "draft", entityType: "jwt-credential", entityId: u, snapshotVersion: null }, { workspaceId: u, source: "active-snapshot", entityType: "jwt-credential", entityId: u, snapshotVersion: 4 }] }], workspaces: [], accessChanges: [] }, false],
    ["ApiV1Usage", { windowDays: 30, since: "2026-09-25", completeThrough: "2026-10-24T21:00:00.000Z", silentReplicas: [], sessionCalls: 120, tokens: [{ tokenId: u, tokenName: "ci", ownerId: u, calls: 4, lastCalledOn: "2026-10-24" }] }, true],
    ["ApiV1Usage", { windowDays: 30, since: "2026-09-25", completeThrough: "2026-10-24T21:00:00.000Z", silentReplicas: [], sessionCalls: 0, tokens: [] }, true],
    ["ApiV1Usage", { windowDays: 30, since: "2026-09-25", sessionCalls: 0, tokens: [] }, false],
    ["ApiV1Usage", { windowDays: 30, since: "2026-10-26", completeThrough: "2026-10-24T21:00:00.000Z", silentReplicas: [{ replicaId: u, startedAt: "2026-10-01T00:00:00.000Z", lastConfirmedAt: "2026-10-10T00:00:00.000Z" }], sessionCalls: 0, tokens: [] }, true],
    ["ApiV1Usage", { windowDays: 30, since: "2026-09-25", completeThrough: "2026-10-24T21:00:00.000Z", sessionCalls: 0, tokens: [] }, false],
    ["ApiV1Usage", { windowDays: 7, since: "2026-10-18", completeThrough: "2026-10-24T21:00:00.000Z", silentReplicas: [], sessionCalls: 0, tokens: [] }, false],
    ["ApiV1Usage", { windowDays: 30, since: "2026-09-25", completeThrough: "2026-10-24T21:00:00.000Z", silentReplicas: [], sessionCalls: 0, tokens: [{ tokenId: u, tokenName: "ci", ownerId: u, calls: 0, lastCalledOn: "2026-10-24" }] }, false],
    ["ApiV1Usage", { windowDays: 30, since: "2026-09-25", completeThrough: "2026-10-24T21:00:00.000Z", silentReplicas: [], sessionCalls: 0, tokens: [{ tokenId: u, tokenName: "ci", ownerId: u, calls: 1, lastCalledOn: "2026-10-24", token: "ggt_x" }] }, false],
    ["WorkspaceStateSummary", { workspaceKey: u, activeRelease: null, deploymentRevision: 0, convergence: "no-nodes", values: {} }, false],
    ["WorkspaceStateSummary", { workspaceKey: u, activeRelease: { version: 4, contentDigest: d, config: { secret: "x" } }, deploymentRevision: 9, convergence: "converged" }, false],
    ["Promotion", { ...emergency, status: "failed", execution: exec("converged") }, false],
    ["Promotion", { ...emergency, status: "converged", execution: exec("failed", "deadline") }, false],
    ["Promotion", { ...emergency, status: "converged", execution: exec("failed", "deadline"), recoveredBy: null }, false],
    ["Promotion", { ...emergency, status: "converged", execution: exec("failed", "deadline"), recoveredBy: { kind: "reapply", promotionId: null, deploymentRevision: 10, at: "2026-10-24T00:00:00Z" } }, true],
    ["Promotion", { ...emergency, status: "converged", execution: exec("failed", "deadline"), recoveredBy: { kind: "rollback", promotionId: u, deploymentRevision: 10, at: "2026-10-24T00:00:00Z" } }, false],
    ["Promotion", { ...promo, status: "deploying", execution: exec("converged") }, false],
    ["Promotion", { ...promo, status: "rolled-back", execution: exec("converged"), recoveredBy: { kind: "rollback", promotionId: u, deploymentRevision: 9, at: "2026-10-24T00:00:00Z" } }, false],
    ["PromotionRecovery", { kind: "rollback", deploymentRevision: 9, at: "2026-10-24T00:00:00Z" }, false],
    ["PromotionRecovery", { kind: "emergency-rollback", promotionId: null, deploymentRevision: 9, at: "2026-10-24T00:00:00Z" }, false],
    ["PromotionRecovery", { kind: "reapply", promotionId: u, deploymentRevision: 9, at: "2026-10-24T00:00:00Z" }, false],
    ["PromotionRecovery", { kind: "reapply", promotionId: null, deploymentRevision: 9, at: "2026-10-24T00:00:00Z" }, true],
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
    // N2-F3: the probe closes an admission it never adopted with a final seq 1 (never served).
    ["ProbeReport", { ...report, seq: 1, prevDigest: null, state: "awaiting-admission", final: true, finalReason: "pod-terminated", kongStopConfirmed: true }, true],
    ["ProbeReport", { ...report, seq: 1, prevDigest: d, state: "awaiting-admission", final: true, finalReason: "pod-terminated", kongStopConfirmed: true }, false],
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

  it("closes an admission before adoption only with a final seq 1, and never erases evidence by closing (N2-F3)", () => {
    const closing = agentV2.components.schemas.AdmissionState["x-gromesh-transitions"].transitions.find(([from, to]: string[]) => from === "open" && to === "closed");
    expect(closing[2]).toContain("seq 1 when the probe closes it before adopting it");
    const flat = (text: string) => text.replace(/\s+/g, " ");
    const info = flat(agentV2.info.description);
    expect(info).toContain("a chain whose seq 1 is final proves");
    expect(info).toContain("the absence of a report proves nothing");
    expect(info).toContain("a report numbered above the final one of its chain, or a report with other content for a seq already received (seq 1 included), is an integrity conflict (confirmed-violation), while an identical retransmission is idempotent");
    expect(info).toContain("a closing report that cannot be produced, persisted, delivered or confirmed");
    expect(info).toContain("a confirmed-violation pendency of an admission stays open after the admission closes");
    expect(flat(agentV2.components.schemas.IsolationHandoff.description)).toContain("removed at the pod's stop signal, after which the agent neither asks for nor polls an admission");
    expect(agentV2.components.schemas.ReportAcks.properties.rejected.items.properties.reason.enum).toContain("integrity-conflict");
  });

  it("exposes whether an admission ever served only from verified evidence (N2-F3, F3-D2)", () => {
    const pod = { podUid: u, bootId: u, podName: "kong-0", nodeName: "n1", state: "ok", admission: "closed", servedState: "never-served-verified", reporting: "closed", lastSeq: 1 };
    const isolation = (p: Record<string, unknown>) => ({ clusterId: u, pods: [p], pendencies: [] });
    expect(valid("ClusterIsolation", isolation(pod)), JSON.stringify(validator("control-plane-v2.openapi.yaml", "ClusterIsolation").errors)).toBe(true);
    for (const s of ["served", "unknown"]) expect(valid("ClusterIsolation", isolation({ ...pod, servedState: s })), s).toBe(true);
    // Implemented (N2-F3): required, no longer planned.
    const item = v2.components.schemas.ClusterIsolation.properties.pods.items;
    expect([item.properties.servedState["x-gromesh-planned"], item.required.includes("servedState")]).toEqual([undefined, true]);
    const { servedState: _omitted, ...withoutState } = pod;
    expect(valid("ClusterIsolation", isolation(withoutState))).toBe(false);
    for (const s of ["never-served", "NEVER_SERVED_VERIFIED", null]) expect(valid("ClusterIsolation", isolation({ ...pod, servedState: s })), String(s)).toBe(false);
    const machine = v2.components.schemas.AdmissionServedState["x-gromesh-transitions"];
    expect([machine.initial, machine.terminal]).toEqual([["unknown"], ["served"]]);
    // The whole machine is pinned: unknown reaches never-served-verified only by the verified seq 1 final with the
    // stop confirmed, nothing ever goes back to unknown, and served is final.
    expect(machine.transitions.map(([from, to]: string[]) => `${from}>${to}`).sort()).toEqual(["never-served-verified>served", "unknown>never-served-verified", "unknown>served"]);
    const why = (from: string, to: string) => machine.transitions.find(([f, t]: string[]) => f === from && t === to)[2];
    expect(why("unknown", "never-served-verified")).toBe("verified final report seq 1 in state awaiting-admission with kongStopConfirmed true");
    expect(why("unknown", "served")).toContain("other than a seq 1 final in state awaiting-admission with kongStopConfirmed true");
    expect(why("unknown", "served")).toContain("or an integrity conflict");
    expect(why("unknown", "served")).toContain("a closing without a confirmed stop");
    // A seq 1 final without a confirmed stop is a valid report, and it counts as served, never as never served.
    const unconfirmed = { clusterId: u, podUid: u, bootId: u, admissionId: u, seq: 1, prevDigest: null, state: "awaiting-admission", failedCapabilities: [], challenge: null, final: true, finalReason: "pod-terminated", kongStopConfirmed: false };
    expect(validAgent("ProbeReport", unconfirmed), JSON.stringify(validator("agent-protocol-v2.openapi.yaml", "ProbeReport").errors)).toBe(true);
    const info = agentV2.info.description.replace(/\s+/g, " ");
    expect(info).toContain("never from a declaration of the agent");
    expect(info).toContain("the control plane never closes an admission automatically on unknown");
    expect(info).toContain("accepted as fail-closed, decision F3-D1");
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
    // H-5: a consumer's node name carries its workspace's slug. H-1: gromesh-workspace is global and the platform's.
    for (const consumer of snap.config.consumers) expect(consumer.username.startsWith(`${slugOf.get(owner(consumer))}~`), consumer.username).toBe(true);
    const isolation = snap.config.plugins.filter((p: Doc) => p.name === "gromesh-workspace");
    expect(isolation.length).toBe(1);
    expect(owner(isolation[0]!)).toBe("gromesh-platform");
    for (const scope of ["route", "service", "consumer"]) expect(isolation[0]![scope], scope).toBeUndefined();
  });
});

describe("delivery protocol and convergence evidence (N3-K1)", () => {
  const vector = JSON.parse(read("examples/delivery-v2.example.json"));
  const jcs = (v: unknown): string =>
    v === null || typeof v !== "object" ? JSON.stringify(v)
    : Array.isArray(v) ? `[${v.map(jcs).join(",")}]`
    : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${jcs((v as Record<string, unknown>)[k])}`).join(",")}}`;
  type Expected = { clusterId: string; nodeId: string; podUid: string; admissionId: string; epoch: number; revision: number; configHash: string; kongConfigHash: string; lastVerifiedRevision: number; revisionRecordedAt: string; now: string };
  // The reference reading of "Applied revision and convergence evidence": only the agent's status and a fresh signed
  // report of the node's own admission agreeing with the deployment and with the Kong hash the control plane derived.
  const evidenceOf = (e: Expected, { status, probe, receivedAt }: Doc): string => {
    if (!status || status.nodeId !== e.nodeId) return "awaiting-status";
    if (status.epoch === e.epoch && status.appliedRevision !== null && status.appliedRevision < e.lastVerifiedRevision) return "revision-regression";
    if (status.epoch !== e.epoch || status.appliedRevision !== e.revision || status.appliedHash !== e.configHash || !status.kongConfigHash) return "awaiting-status";
    const at = Date.parse(receivedAt);
    const own = probe && probe.clusterId === e.clusterId && probe.podUid === e.podUid && probe.admissionId === e.admissionId;
    if (!own || at < Date.parse(e.revisionRecordedAt) || Date.parse(e.now) - at > 60_000) return "awaiting-probe-report";
    if (probe.state !== "ok" || probe.appliedEpoch == null) {
      return probe.servedKongConfigHash && probe.servedKongConfigHash !== status.kongConfigHash ? "served-config-divergence" : "awaiting-probe-report";
    }
    const same = probe.appliedEpoch === e.epoch && probe.appliedRevision === e.revision && probe.appliedHash === e.configHash &&
      probe.appliedKongConfigHash === status.kongConfigHash && probe.servedKongConfigHash === probe.appliedKongConfigHash;
    if (!same) return "revision-mismatch";
    if (status.kongConfigHash !== e.kongConfigHash) return "kong-hash-divergence";
    return "verified";
  };

  it("derives the expected Kong hash from the JCS bytes the agent posts as a string", () => {
    const { config, jcs: bytes, kongConfigHash, postBody } = vector.kongConfigHashOf;
    expect(jcs(config)).toBe(bytes);
    expect(createHash("md5").update(bytes, "utf8").digest("hex")).toBe(kongConfigHash);
    expect(JSON.parse(postBody)).toEqual({ config: bytes });
    expect(vector.expected.kongConfigHash).toBe(kongConfigHash);
    expect(valid("Deployment", { epoch: 1, revision: 4, state: "active", members: [], configHash: vector.expected.configHash, kongConfigHash, convergence: "converging" })).toBe(true);
    expect(valid("Deployment", { epoch: 1, revision: 4, state: "active", members: [], configHash: vector.expected.configHash, kongConfigHash: vector.expected.configHash, convergence: "converging" })).toBe(false);
  });

  it("accepts applied.json and refuses every invalid one", () => {
    expect(validAgent("AppliedRevision", vector.applied)).toBe(true);
    for (const { reason, value } of vector.invalidApplied) expect(validAgent("AppliedRevision", value), reason).toBe(false);
    expect(agentV2.components.schemas.IsolationHandoff.description).toContain("applied.json (agent)");
  });

  it("carries the applied revision in the signed report only as a whole, with the served hash", () => {
    for (const value of vector.probeReports.valid) expect(validAgent("ProbeReport", value), JSON.stringify(validator("agent-protocol-v2.openapi.yaml", "ProbeReport").errors)).toBe(true);
    for (const { reason, value } of vector.probeReports.invalid) expect(validAgent("ProbeReport", value), reason).toBe(false);
    for (const c of vector.cases) {
      if (c.status) expect(validAgent("StatusReport", c.status), c.name).toBe(true);
      if (c.probe) expect(validAgent("ProbeReport", c.probe), c.name).toBe(true);
    }
  });

  it("converges only with status and probe evidence agreeing with the deployment", () => {
    const evidence = new Set(v2.components.schemas.ConvergenceEvidence.enum);
    expect(new Set(vector.cases.map((c: Doc) => c.evidence))).toEqual(evidence);
    for (const c of vector.cases) expect(evidenceOf(c.expected ?? vector.expected, c), c.name).toBe(c.evidence);
    expect(vector.cases.filter((c: Doc) => c.evidence === "verified").every((c: Doc) => c.probe && c.status)).toBe(true);
  });

  it("publishes a release without deploying it, also with Workspaces mode disabled (D4)", () => {
    // Structured: where the disabled mode refuses, and that only operations reaching a data plane do.
    const mode = Object.fromEntries(v2Ops.filter(({ op }) => op["x-gromesh-workspaces-mode-disabled"]).map(({ op }) => [op.operationId, op["x-gromesh-workspaces-mode-disabled"]]));
    expect(mode).toEqual({ publishRelease: "allowed", createDeployment: "refused", setClusterDeliveryProtocol: "refused-to-v2" });
    const publish = v2Ops.find(({ op }) => op.operationId === "publishRelease")!.op;
    // publishRelease never answers the delivery refusal: its 409 is the generic conflict (lease, expectedActiveVersion).
    expect(publish.responses["409"]).toEqual({ $ref: "#/components/responses/Conflict" });
    expect(publish.requestBody.content["application/json"].schema.properties).not.toHaveProperty("deploy");
    const deploy409 = ajv.compile({ $ref: `${BASE}control-plane-v2.openapi.yaml#/paths/~1deployments/post/responses/409/content/application~1problem+json/schema` });
    expect(deploy409({ type: "https://gromesh.dev/problems/workspaces-mode-disabled", title: "Conflict", status: 409, code: "workspaces-mode-disabled" })).toBe(true);
    const states = v2.components.schemas.DeliveryProtocolState;
    expect(states["x-gromesh-activation-gate"]).toEqual(["workspaces-mode-enabled", "every-expected-node-open-admission", "conclusive-passing-round", "failed-capabilities-empty", "no-v1-node-online", "no-open-pendency", "collector-token-exclusive"]);
    const t = states["x-gromesh-transitions"].transitions as [string, string, string][];
    // Positive and negative transition vectors: only the gate reaches v2; nothing reaches v2 from v1 directly.
    const allowed = new Set(t.map(([from, to]) => `${from}>${to}`));
    for (const ok of ["v1>v2-pending", "v2-pending>v2", "v2-pending>v1", "v2>v1"]) expect(allowed.has(ok), ok).toBe(true);
    for (const no of ["v1>v2", "v2>v2-pending"]) expect(allowed.has(no), no).toBe(false);
    const gate = t.find(([from, to]) => from === "v2-pending" && to === "v2")![2];
    for (const phrase of ["open admission", "conclusive passing round", "failedCapabilities empty", "no node without an open admission", "no pendency is open"]) expect(gate, phrase).toContain(phrase);
  });

  it("never converges an empty set of expected nodes and keeps md5 out of integrity decisions", () => {
    const machine = v2.components.schemas.DeploymentState;
    const t = machine["x-gromesh-transitions"].transitions as [string, string, string][];
    const empty = machine["x-gromesh-empty-revision"] as { neverReaches: string[]; holdsLease: boolean; exits: string[] };
    expect(empty).toEqual({ neverReaches: ["converged"], holdsLease: false, exits: ["converging", "superseded"] });
    // An empty revision recorded as active can only leave by its declared exits, each one a real transition.
    const fromActive = t.filter(([from]) => from === "active").map(([, to]) => to);
    for (const exit of empty.exits) expect(fromActive, exit).toContain(exit);
    expect(t.find(([from, to]) => from === "active" && to === "superseded")![2]).toContain("no expected node");
    for (const [from, , why] of t.filter(([, to]) => empty.neverReaches.includes(to))) expect(why, from).toContain("(at least one)");
    expect(v2.components.schemas.Deployment.description).toContain("without holding the deployment");
    const info = agentV2.info.description.replace(/\s+/g, " ");
    expect(info).toContain("never replaces the SHA-256 identities");
    expect(info).toContain("no decision of integrity, provenance or authorization reads it");
  });

  it("refuses with a typed code and switches the protocol only explicitly", () => {
    const refusal = (code: string) => ({ type: `https://gromesh.dev/problems/${code}`, title: "Conflict", status: 409, code });
    const deploy = v2Ops.find(({ op }) => op.operationId === "createDeployment")!.op;
    // Implemented by N3-C3: the planned mark is the handler coverage test's concern.
    expect([deploy["x-scope"], deploy["x-required-permission"]]).toEqual(["instance", "release.publish"]);
    expect(v2Ops.find(({ op }) => op.operationId === "publishRelease")!.op.description).toContain("Creating a release deploys nothing");
    for (const code of ["workspaces-mode-disabled", "delivery-protocol-v1", "delivery-protocol-v2", "delivery-protocol-switching", "epoch-outdated", "revision-regression", "unknown-deployment"]) {
      expect(validAgent("DeliveryProblem", refusal(code)), code).toBe(true);
    }
    expect(validAgent("DeliveryProblem", refusal("timeout"))).toBe(false);
    const deploy409 = ajv.compile({ $ref: `${BASE}control-plane-v2.openapi.yaml#/paths/~1deployments/post/responses/409/content/application~1problem+json/schema` });
    expect(deploy409(refusal("workspaces-mode-disabled"))).toBe(true);
    expect(deploy409({ type: "https://gromesh.dev/problems/409", title: "Conflict", status: 409 })).toBe(true);
    expect(validAgent("DeliveryProblem", { ...refusal("epoch-outdated"), status: 422 })).toBe(false);
    expect(valid("DeliveryProblem", refusal("no-v1-snapshot"))).toBe(true);
    for (const path of ["/agent/v2/deployments/current", "/agent/v2/status"]) {
      const op = agentV2.paths[path].get ?? agentV2.paths[path].post;
      expect(op.responses["409"].$ref, path).toBe("#/components/responses/DeliveryRefused");
    }
    expect(Object.keys(docs["agent-protocol.openapi.yaml"].paths["/agent/v1/snapshots/current"].get.responses)).toContain("409");
    const set = v2Ops.find(({ op }) => op.operationId === "setClusterDeliveryProtocol")!;
    // Implemented by N3-C4: the planned mark is the handler coverage test's concern.
    expect(set.op.security).toEqual([{ cookieAuth: [], csrfToken: [] }]);
    const body = bodyOf("/clusters/{clusterId}/delivery-protocol", "put");
    expect(body({ protocol: "v2", reason: "lab N2 activation" })).toBe(true);
    for (const bad of [{ protocol: "v2" }, { protocol: "v3", reason: "lab N2 activation" }, { protocol: "v2", reason: "lab N2 activation", force: true }]) expect(body(bad), JSON.stringify(bad)).toBe(false);
    // Only the activation gate turns a cluster v2, and every switch back is explicit.
    const t = v2.components.schemas.DeliveryProtocolState["x-gromesh-transitions"].transitions as [string, string, string][];
    expect(t.filter(([, to]) => to === "v2").map(([from, , why]) => [from, why.startsWith("activation gate")])).toEqual([["v2-pending", true]]);
    for (const [from, to, why] of t) if (to === "v1" || to === "v2-pending") expect(why, `${from} -> ${to}`).toContain("setClusterDeliveryProtocol");
    expect(valid("InstanceCluster", { id: u, name: "edge", status: "no-nodes", nodes: [], createdAt: "2026-10-27T00:00:00Z" })).toBe(false);
    expect(valid("InstanceCluster", { id: u, name: "edge", status: "no-nodes", nodes: [], createdAt: "2026-10-27T00:00:00Z", deliveryProtocol: "v2-pending", environmentId: null })).toBe(true);
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
    expect(JSON.parse(Buffer.from(vector.signedPackage.protected, "base64url").toString("utf8"))).toEqual({ alg: "EdDSA", kid: createHash("sha256").update(`{"crv":"Ed25519","kty":"OKP","x":"${vector.publicKeyJwk.x}"}`).digest("base64url"), typ: "gromesh-package+json", pkgVersion: 1 });
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

describe("isolation signatures vector (N4-D3)", () => {
  const vector = JSON.parse(read("examples/isolation-signatures.example.json"));
  type Jws = { protected: string; payload: string; signature: string };
  const text = (b64: string) => Buffer.from(b64, "base64url").toString("utf8");
  const thumbprint = (x: string) => createHash("sha256").update(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`).digest("base64url");
  // The reference reading of "Signatures": a flat header with exactly the members of its kind, each once, the key from
  // the verifier's own trust, the signature over the received bytes before the payload is parsed.
  const exactly = (json: string, names: string[]) => {
    const seen = [...json.matchAll(/"((?:[^"\\]|\\.)*)"\s*:/g)].map((m) => m[1]);
    const value = JSON.parse(json);
    return new Set(seen).size === seen.length && seen.length === names.length && names.every((n) => typeof value[n] === "string") ? value : null;
  };
  const trustSetValid = (set: { keys: { kid: string; publicKey: string }[] }) =>
    validAgent("InstanceTrustSet", set) === true &&
    set.keys.every((k) => Buffer.from(k.publicKey, "base64url").length === 32 && k.kid === thumbprint(k.publicKey)) &&
    new Set(set.keys.map((k) => k.kid)).size === set.keys.length;
  const accept = (jws: Jws, typ: string, keyOf: (header: Record<string, string>) => string | undefined, claims: string, context?: Record<string, string>) => {
    const header = exactly(text(jws.protected), typ === "gromesh-probe-report+json" ? ["alg", "typ"] : ["alg", "kid", "typ"]);
    if (!header || header.alg !== "EdDSA" || header.typ !== typ) return false;
    const x = keyOf(header);
    if (!x) return false;
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
    if (!verify(null, Buffer.from(`${jws.protected}.${jws.payload}`, "ascii"), key, Buffer.from(jws.signature, "base64url"))) return false;
    const payload = JSON.parse(text(jws.payload));
    return validAgent(claims, payload) === true && Object.entries(context ?? {}).every(([k, v]) => payload[k] === v);
  };
  const admitted = (jws: Jws) => trustSetValid(vector.trustSet) && accept(jws, "gromesh-admission+json", trusted, "AdmissionClaims", vector.expectedContext);
  const trusted = (header: Record<string, string>) => vector.trustSet.keys.find((k: { kid: string }) => k.kid === header.kid)?.publicKey;

  it("derives every kid of the trust set from its public key (RFC 7638)", () => {
    expect(validAgent("InstanceTrustSet", vector.trustSet)).toBe(true);
    for (const k of vector.trustSet.keys) expect(k.kid).toBe(thumbprint(k.publicKey));
    expect(vector.kidIsThumbprintOf).toBe(`{"crv":"Ed25519","kty":"OKP","x":"${vector.trustSet.keys[0].publicKey}"}`);
    expect(valid("InstanceSigningKey", { ...vector.trustSet.keys[0], status: "active", validFrom: "2026-10-26T00:00:00Z", validUntil: "2027-10-26T00:00:00Z", retiredAt: null, revokedAt: null, createdAt: "2026-10-26T00:00:00Z" })).toBe(true);
  });

  it("accepts the admission and the release with the instance key, the report with the probe key of the admission", () => {
    expect(admitted(vector.admission)).toBe(true);
    expect(JSON.parse(text(vector.admission.payload))).toEqual(vector.admissionClaims);
    expect(accept(vector.release, "gromesh-isolation-release+json", trusted, "IsolationReleaseClaims")).toBe(true);
    expect(accept(vector.report, "gromesh-probe-report+json", () => vector.admissionClaims.probePublicKey, "ProbeReport")).toBe(true);
    // The report key is the admission's, never an instance key, and an instance-signed document is not a report.
    expect(accept(vector.report, "gromesh-probe-report+json", () => vector.trustSet.keys[0].publicKey, "ProbeReport")).toBe(false);
    expect(accept(vector.admission, "gromesh-probe-report+json", () => vector.admissionClaims.probePublicKey, "ProbeReport")).toBe(false);
  });

  it("refuses every case of mustRefuse, the identity replays among them with a valid instance signature", () => {
    expect(vector.mustRefuse.length).toBeGreaterThanOrEqual(15);
    for (const { reason, jws } of vector.mustRefuse) {
      expect(validAgent("Jws", jws), reason).toBe(true);
      expect(admitted(jws), reason).toBe(false);
    }
    // The replays carry a valid signature: only the comparison with the probe's own context refuses them.
    const replays = vector.mustRefuse.filter((c: { reason: string }) => c.reason.endsWith("(valid signature)"));
    expect(replays).toHaveLength(4);
    for (const { reason, jws } of replays) expect(accept(jws, "gromesh-admission+json", trusted, "AdmissionClaims"), reason).toBe(true);
  });

  it("refuses every trust set of invalidTrustSets as a whole", () => {
    expect(trustSetValid(vector.trustSet)).toBe(true);
    for (const { reason, set } of vector.invalidTrustSets) expect(trustSetValid(set), reason).toBe(false);
  });
});

describe("analytics guarantees (N3-A1)", () => {
  const vector = JSON.parse(read("examples/analytics-v2.example.json"));
  const info = agentV2.info.description.replace(/\s+/g, " ");
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  // The reference readings of agent-protocol-v2 "Analytics guarantees", written from the contract's text.
  const eventIdOf = (c: Doc): string | null => {
    if (typeof c.requestId !== "string" || !/^[0-9a-f]{32}$/.test(c.requestId)) return null;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    if (!uuid.test(c.clusterId ?? "") || !uuid.test(c.podUid ?? "")) return null;
    const h = sha(`${c.clusterId}|${c.podUid}|${c.requestId}`);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
  };
  const attributionOf = (a: Doc, e: Doc, copies: Doc[] = [e]): { workspace: string | null; reason: string | null } => {
    // Every stored row of the id: any difference between them is a conflict, attributed to nobody in any order.
    const canonical = (r: Doc) => JSON.stringify(Object.keys(r).sort().map((k) => [k, r[k]]));
    if (new Set(copies.map(canonical)).size > 1) return { workspace: null, reason: "conflicting-copies" };
    if (e.environmentId !== a.instanceId) return { workspace: null, reason: "foreign-instance" };
    if (!a.clusters.includes(e.clusterId)) return { workspace: null, reason: "unknown-cluster" };
    if (e.routeId === null) return { workspace: null, reason: "no-route" };
    const ordered = [...a.revisions].sort((x: Doc, y: Doc) => x.epoch - y.epoch || x.revision - y.revision);
    const window = ordered.filter((r: Doc) => Date.parse(r.recordedAt) <= Date.parse(e.ts)).slice(-2);
    if (window.length === 0) return { workspace: null, reason: "before-first-revision" };
    const owners = new Set(window.flatMap((r: Doc) => Object.entries(r.routes as Record<string, string[]>).filter(([, routes]) => routes.includes(e.routeId)).map(([w]) => w)));
    if (owners.size !== 1) return { workspace: null, reason: owners.size === 0 ? "route-not-deployed" : "ambiguous-route" };
    return { workspace: [...owners][0] as string, reason: null };
  };
  const healthOf = (h: Doc) => {
    const reasons: string[] = [];
    if (!h.collectorReachable) reasons.push("collector-unreachable");
    else {
      if (h.received !== null && h.delivered !== null && h.received > 0 && (h.delivered * 2 < h.received || (h.deliveryErrors > 0 && h.delivered < h.received))) reasons.push("delivery-failing");
      if (h.buffered !== null && h.bufferCapacity !== null && h.buffered * 2 >= h.bufferCapacity) reasons.push("backlog");
      if (h.kongRequests !== null && h.received !== null && h.kongRequests >= 20 && h.received * 2 < h.kongRequests) reasons.push("events-missing");
      if (h.authRefusals > 0) reasons.push("auth-refusals");
    }
    const unread = ["kongRequests", "received", "delivered", "deliveryErrors", "authRefusals", "buffered", "bufferCapacity"].some((k) => h[k] === null);
    const state = reasons.length > 0 ? "degraded"
      : !h.windowComplete || unread ? "unknown"
      : h.kongRequests === 0 && h.received === 0 ? "idle"
      : h.received === 0 || h.delivered === 0 ? "unknown"
      : "healthy";
    return { state, reasons, analytics: state === "healthy" || state === "idle" ? "analytics-healthy" : "analytics-degraded" };
  };
  const fingerprintOf = (token: string) => `sha256:${sha(`gromesh-collector-token/v1\n${token}`)}`;
  type Node = { online: boolean; fingerprints: { current: string; previous: string | null } | null };
  const shareOf = (clusters: Record<string, Node[]>, id: string) => {
    // Only online nodes count; one without fingerprints leaves its cluster unverified.
    const counted = (nodes: Node[]) => nodes.filter((n) => n.online && n.fingerprints).map((n) => n.fingerprints!);
    const mine = counted(clusters[id]!);
    const others = Object.entries(clusters).filter(([k]) => k !== id).flatMap(([, nodes]) => counted(nodes));
    const shared = mine.some((m) => others.some((t) => m.current === t.current));
    const touched = mine.some((m) => others.some((t) => [t.current, t.previous].includes(m.current) || (m.previous !== null && [t.current, t.previous].includes(m.previous))));
    return { collectorTokenShared: shared, collectorTokenUnverified: clusters[id]!.some((n) => n.online && !n.fingerprints), collectorTokenRotating: touched && !shared };
  };

  it("derives the event id the Vector sidecar already derives, per cluster, pod and Kong request id", () => {
    const sidecar = read("../deploy/observability/vector/sidecar.tests.yaml");
    const [first] = vector.eventIdOf.cases;
    expect(sidecar).toContain(`assert_eq!(.id, "${first.id}")`);
    for (const c of vector.eventIdOf.cases) expect(eventIdOf(c), c.name).toBe(c.id);
    const ids = vector.eventIdOf.cases.map((c: Doc) => c.id).filter(Boolean);
    expect(new Set(ids).size).toBe(3);
  });

  it("promises no end-to-end delivery, reads each stored id once, never a merge or the dedup cache as a guarantee", () => {
    for (const phrase of ["none of them can hold \"|\", so the concatenation is unambiguous", "Any other value is never normalised: the event is dropped", "Delivery is not guaranteed end to end: neither at least once nor exactly once is promised", "each stored id counts once", "A conflicted id is never attributed to any workspace", "no row of it is chosen", "truncated to its first 128 bits", "every read the control plane serves counts DISTINCT ids", "never relies on a merge having run", "load reduction only (lost on restart)", "Loss stays possible"]) expect(info).toContain(phrase);
    for (const op of ["getAnalyticsSummary", "getTopRoutes", "listRequests"]) {
      const [, path] = Object.entries(v2.paths).find(([, item]: [string, Doc]) => item.get?.operationId === op)!;
      expect((path as Doc).get.description.replace(/\s+/g, " "), op).toContain("Rows: distinct request ids attributed to this workspace");
    }
  });

  it("attributes a row only by route_id against the deployment revisions, through rollout and rollback", () => {
    for (const c of vector.attributionOf.cases) expect(attributionOf(vector.attributionOf.attribution, c.event, c.copies), c.name).toEqual(c.expected);
    // Order never changes the answer, and a conflict is never resolved for a workspace.
    for (const c of vector.attributionOf.cases.filter((x: Doc) => x.copies)) {
      expect(attributionOf(vector.attributionOf.attribution, c.event, [...c.copies].reverse()), `${c.name} (reversed)`).toEqual(c.expected);
    }
    expect(vector.attributionOf.cases.filter((x: Doc) => x.expected.reason === "conflicting-copies").length).toBeGreaterThanOrEqual(4);
    const reasons = new Set(vector.attributionOf.cases.map((c: Doc) => c.expected.reason).filter(Boolean));
    expect([...reasons].sort()).toEqual(Object.keys(v2.components.schemas.UnattributedAnalytics.properties.byReason.properties).sort());
    expect(info).toContain("The path, its prefix or any field of the event never attribute a row");
  });

  it("counts every id once, leaves conflicted ids to the unattributed totals, and survives merges only on the content key", () => {
    const canonical = (r: Doc) => JSON.stringify(Object.keys(r).sort().map((k) => [k, r[k]]));
    const readsOf = (a: Doc, rows: Doc[], routeFilter: string | null) => {
      const byId = new Map<string, Doc[]>();
      for (const r of rows) byId.set(r.id, [...(byId.get(r.id) ?? []), r]);
      const byWorkspace: Record<string, number> = {}, unattributed: Record<string, number> = {};
      for (const copies of byId.values()) {
        const strip = ({ id: _, ...e }: Doc) => e;
        const res = attributionOf(a, strip(copies[0]), copies.map(strip));
        if (res.workspace === null) unattributed[res.reason!] = (unattributed[res.reason!] ?? 0) + 1;
        else if (routeFilter === null || copies[0].routeId === routeFilter) byWorkspace[res.workspace] = (byWorkspace[res.workspace] ?? 0) + 1;
      }
      return { distinctIds: byId.size, byWorkspace, unattributed };
    };
    for (const c of vector.readsOf.cases) expect(readsOf(vector.attributionOf.attribution, c.rows, c.routeFilter), c.name).toEqual(c.expected);
    const [all] = vector.readsOf.cases;
    expect(all.expected.unattributed["conflicting-copies"]).toBe(2);
    // A merge on (environment_id, ts, id, content digest) only drops identical copies: every read is unchanged.
    const mergeOn = (rows: Doc[], key: (r: Doc) => string) => [...new Map(rows.map((r) => [key(r), r])).values()];
    const contentKey = (r: Doc) => `${r.environmentId}|${r.ts}|${r.id}|${canonical(r)}`;
    expect(readsOf(vector.attributionOf.attribution, mergeOn(all.rows, contentKey), null)).toEqual(all.expected);
    // Negative control: on (environment_id, ts, id) alone a merge keeps one copy of a conflict and attributes it.
    const oldKey = (r: Doc) => `${r.environmentId}|${r.ts}|${r.id}`;
    expect(readsOf(vector.attributionOf.attribution, mergeOn(all.rows, oldKey), null)).not.toEqual(all.expected);
    expect(info).toContain("sorted by (environment_id, ts, id, content digest)");
    expect(info).toContain("rows of one id that differ never do, so a conflict survives merges for the whole retention");
  });

  it("reads the collector's health from Kong's traffic and the collector's own counters, idle being no failure", () => {
    for (const c of vector.healthOf.cases) expect(healthOf(c.input), c.name).toEqual(c.expected);
    const states = new Set(vector.healthOf.cases.map((c: Doc) => c.expected.state));
    expect([...states].sort()).toEqual([...agentV2.components.schemas.AnalyticsHealth.properties.state.enum].sort());
    const reasons = new Set(vector.healthOf.cases.flatMap((c: Doc) => c.expected.reasons));
    expect([...reasons].sort()).toEqual([...agentV2.components.schemas.AnalyticsHealth.properties.reasons.items.enum].sort());
    expect(v2.components.schemas.ClusterAnalytics.properties.state.enum).toEqual(agentV2.components.schemas.AnalyticsHealth.properties.state.enum);
    expect(info).toContain("Missing evidence is never health, and a running container is never health by itself");
    expect(info).not.toContain("never hidden");
  });

  it("compares collector tokens by fingerprint only, blocking a current token on two clusters and not a rotation", () => {
    for (const c of vector.fingerprintOf.cases) expect(fingerprintOf(c.token)).toBe(c.fingerprint);
    for (const c of vector.collectorTokenShare.cases) {
      for (const id of Object.keys(c.clusters)) expect(shareOf(c.clusters, id), `${c.name} (${id})`).toEqual(c.expected[id]);
    }
    const gate = v2.components.schemas.DeliveryProtocolState["x-gromesh-transitions"].transitions.find(([from, to]: string[]) => from === "v2-pending" && to === "v2");
    expect(gate[2]).toContain("every online node reports its fingerprints and no current one is shared with another cluster");
    expect(v2.components.schemas.DeliveryProtocolState["x-gromesh-activation-gate"]).toContain("collector-token-exclusive");
    expect(info).toContain("a completed rotation clears the share");
  });

  it("validates the status report's analytics members and refuses a token in place of a fingerprint", () => {
    expect(validAgent("StatusReport", vector.statusReport.valid), JSON.stringify(validator("agent-protocol-v2.openapi.yaml", "StatusReport").errors)).toBe(true);
    for (const { reason, patch } of vector.statusReport.invalid) expect(validAgent("StatusReport", { ...vector.statusReport.valid, ...patch }), reason).toBe(false);
    expect(healthOf(vector.statusReport.valid.analyticsHealth).analytics).toBe(vector.statusReport.valid.analytics);
  });

  it("plans the platform admin's unattributed totals as an instance operation without detail", () => {
    const op = v2.paths["/instance/analytics/unattributed"].get;
    expect(op).toMatchObject({ operationId: "getUnattributedAnalytics", "x-scope": "instance", "x-required-permission": "platform.admin", "x-gromesh-planned": true });
    expect(Object.keys(v2.components.schemas.UnattributedAnalytics.properties).sort()).toEqual(["byReason", "from", "to", "total"]);
  });
});
