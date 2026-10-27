import { createHash } from "node:crypto";
import { CANARY_PATH, composeWorkspaces, PLATFORM_TAG, ROUTE_GUARD_PLUGIN, WORKSPACE_PLUGIN, WORKSPACE_TAG_PREFIX, type WorkspaceMember } from "./compose.js";
import { CompileError, type CompileIssue } from "./errors.js";
import { canonicalJson, hashConfig } from "./hash.js";
import type { CompileOptions, KongDeclarativeConfig } from "./model.js";

/** An entity of a release content in the Gromesh model (contract: Package* in control-plane-v2). */
export interface ContentEntity {
  id: string;
  [field: string]: unknown;
}

/** contracts/control-plane-v2.openapi.yaml#/components/schemas/WorkspaceContent; the contract validates its shape. */
export interface WorkspaceContent {
  services: ContentEntity[];
  routes: ContentEntity[];
  consumers: ContentEntity[];
  /** Always empty: consumer credentials are environment values, never part of a release. */
  credentials: [];
  plugins: ContentEntity[];
  upstreams: ContentEntity[];
  targets: ContentEntity[];
  certificates: ContentEntity[];
  variables: { name: string; [field: string]: unknown }[];
}

/** A Workspace in a deployment: what composeWorkspaces needs plus its active release. */
export interface DeploymentMember extends WorkspaceMember {
  releaseVersion: number;
  content: WorkspaceContent;
}

export type DeploymentReason = "publish" | "promotion" | "rollback" | "reconcile" | "mandatory-plugins" | "values" | "migration";

export interface DeploymentMeta {
  instanceId: string;
  epoch: number;
  revision: number;
  createdAt?: string;
  reason?: DeploymentReason;
  mandatoryPluginsVersion?: number | null;
  valuesDigest?: string | null;
}

/** What the agent downloads and applies in Workspaces mode. See contracts/snapshot-v2.schema.json. */
export interface SnapshotEnvelopeV2 {
  schemaVersion: 2;
  instanceId: string;
  epoch: number;
  revision: number;
  hash: string;
  createdAt: string;
  reason?: DeploymentReason;
  members: { workspaceId: string; slug: string; releaseVersion: number; contentDigest: string }[];
  mandatoryPluginsVersion?: number | null;
  valuesDigest?: string | null;
  config: KongDeclarativeConfig;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const ENTITY_ARRAYS = ["services", "routes", "consumers", "plugins", "upstreams", "targets", "certificates"] as const;

/**
 * contentDigest of a release (contract: WorkspaceContent): SHA-256 of the RFC 8785 (JCS) form, every array ordered by
 * id and variables by name. canonicalJson is JCS for JSON values: ECMAScript serialization of strings and numbers,
 * object keys sorted by UTF-16 code units.
 */
export function contentDigest(content: WorkspaceContent): string {
  if (content.credentials.length > 0) throw new RangeError("content.credentials must be empty");
  const ordered = <T>(items: T[], key: (item: T) => string, what: string): T[] => {
    const sorted = [...items].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    // A repeated key would leave the order, and so the digest, to the input.
    sorted.forEach((item, i) => { if (i > 0 && key(sorted[i - 1]!) === key(item)) throw new RangeError(`content.${what} has a repeated key ${key(item)}`); });
    return sorted;
  };
  const normalized: Record<string, unknown> = { ...content, credentials: [], variables: ordered(content.variables, (v) => v.name, "variables") };
  for (const name of ENTITY_ARRAYS) normalized[name] = ordered(content[name], (e) => e.id, name);
  return "sha256:" + createHash("sha256").update(canonicalJson(normalized), "utf8").digest("hex");
}

/**
 * Builds the deployment snapshot of an instance (contract: snapshot-v2). `hash` covers only `config`, so the same
 * members give the same hash in any epoch or revision. The composed config is checked against the contract's
 * invariants before it is returned; a violation is a compiler bug and throws CompileError (paths `config.*`).
 */
export function buildSnapshotV2(members: DeploymentMember[], meta: DeploymentMeta, options?: CompileOptions): SnapshotEnvelopeV2 {
  if (!UUID_RE.test(meta.instanceId)) throw new RangeError("instanceId must be a UUID");
  for (const field of ["epoch", "revision"] as const) {
    if (!Number.isInteger(meta[field]) || meta[field] < 1) throw new RangeError(`${field} must be a positive integer`);
  }
  if (meta.mandatoryPluginsVersion != null && (!Number.isInteger(meta.mandatoryPluginsVersion) || meta.mandatoryPluginsVersion < 1)) {
    throw new RangeError("mandatoryPluginsVersion must be a positive integer or null");
  }
  if (meta.valuesDigest != null && !DIGEST_RE.test(meta.valuesDigest)) throw new RangeError("valuesDigest must be sha256:<64 hex> or null");
  members.forEach((m, i) => {
    if (!Number.isInteger(m.releaseVersion) || m.releaseVersion < 1) throw new RangeError(`members[${i}].releaseVersion must be a positive integer`);
  });

  const config = composeWorkspaces(members, options);
  const issues = workspaceConfigIssues(config, members);
  if (issues.length > 0) throw new CompileError(issues);

  // The tag carries the lowercase id; members repeat it so the agent and the probe can match one to the other.
  const summary = members
    .map((m) => ({ workspaceId: m.id.toLowerCase(), slug: m.slug, releaseVersion: m.releaseVersion, contentDigest: contentDigest(m.content) }))
    .sort((a, b) => (a.workspaceId < b.workspaceId ? -1 : 1));
  return {
    schemaVersion: 2,
    instanceId: meta.instanceId.toLowerCase(),
    epoch: meta.epoch,
    revision: meta.revision,
    hash: hashConfig(config),
    createdAt: meta.createdAt ?? new Date().toISOString(),
    ...(meta.reason === undefined ? {} : { reason: meta.reason }),
    members: summary,
    ...(meta.mandatoryPluginsVersion === undefined ? {} : { mandatoryPluginsVersion: meta.mandatoryPluginsVersion }),
    ...(meta.valuesDigest === undefined ? {} : { valuesDigest: meta.valuesDigest }),
    config,
  };
}

/**
 * The guarantees snapshot-v2 states about `config`: one ownership tag per route, service, consumer and plugin (a
 * member's or the platform's); Workspace names and paths under the member's slug; a route guard on every Workspace
 * route; gromesh-workspace global; the platform canary behind the guard.
 */
export function workspaceConfigIssues(config: KongDeclarativeConfig, members: Pick<WorkspaceMember, "id" | "slug">[]): CompileIssue[] {
  const issues: CompileIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path: `config.${path}`, message });
  const slugOf = new Map(members.map((m) => [`${WORKSPACE_TAG_PREFIX}${m.id.toLowerCase()}`, m.slug]));
  const owner = (path: string, tags: string[] | undefined): string | null => {
    const own = (tags ?? []).filter((t) => t === PLATFORM_TAG || t.startsWith(WORKSPACE_TAG_PREFIX));
    if (own.length !== 1) add(`${path}.tags`, "must carry exactly one of gromesh-platform or a member's Workspace tag");
    else if (own[0] !== PLATFORM_TAG && !slugOf.has(own[0]!)) add(`${path}.tags`, "carries the tag of a Workspace that is not a member");
    return own.length === 1 && own[0] !== PLATFORM_TAG ? (slugOf.get(own[0]!) ?? null) : null;
  };
  const guards = (routeId: string) => config.plugins.filter((p) => p.name === ROUTE_GUARD_PLUGIN && p.route === routeId);

  config.services.forEach((s, i) => {
    const slug = owner(`services[${i}]`, s.tags);
    if (slug !== null && !s.name.startsWith(`${slug}~`)) add(`services[${i}].name`, "must be <slug>~<name>");
  });
  config.consumers.forEach((c, i) => {
    const slug = owner(`consumers[${i}]`, c.tags);
    if (slug !== null && c.username !== undefined && !c.username.startsWith(`${slug}~`)) add(`consumers[${i}].username`, "must be <slug>~<username>");
  });
  config.plugins.forEach((p, i) => owner(`plugins[${i}]`, p.tags));
  config.routes.forEach((r, i) => {
    const slug = owner(`routes[${i}]`, r.tags);
    if (slug === null) return;
    if (!r.name.startsWith(`${slug}~`)) add(`routes[${i}].name`, "must be <slug>~<name>");
    (r.paths ?? []).forEach((path, j) => {
      const inside = path.startsWith("~") ? path.startsWith(`~/${slug}(?:`) && path.endsWith(")") : path.startsWith(`/${slug}/`);
      if (!inside) add(`routes[${i}].paths[${j}]`, "must be under the Workspace prefix");
    });
    if ((r.paths ?? []).length === 0) add(`routes[${i}].paths`, "a Workspace route must have a path under its prefix");
    if (guards(r.id).length !== 1) add(`routes[${i}]`, `must run ${ROUTE_GUARD_PLUGIN} exactly once`);
  });

  const workspacePlugin = config.plugins.filter((p) => p.name === WORKSPACE_PLUGIN);
  if (workspacePlugin.length !== 1 || workspacePlugin[0]!.route || workspacePlugin[0]!.service || workspacePlugin[0]!.consumer || !workspacePlugin[0]!.tags?.includes(PLATFORM_TAG)) {
    add("plugins", `${WORKSPACE_PLUGIN} must exist once, global, tagged ${PLATFORM_TAG}`);
  }
  const canary = config.routes.filter((r) => r.paths?.includes(CANARY_PATH));
  if (canary.length !== 1 || !canary[0]!.tags?.includes(PLATFORM_TAG) || guards(canary[0]!.id).length !== 1) {
    add("routes", `the platform canary ${CANARY_PATH} must exist once, tagged ${PLATFORM_TAG}, behind ${ROUTE_GUARD_PLUGIN}`);
  }
  return issues;
}
