import { copyReadNotReady } from "./bounded-copy-queries.js";

type Row = Readonly<Record<string, unknown>>;
export interface CopyStorageAuthorityPolicy {
  readonly databaseName: string;
  readonly writerId: string;
  readonly readerId: string;
  readonly auditorId: string;
  readonly administratorIds: readonly string[];
}
export interface CopyStorageAuthorityCatalog {
  readonly observer: string;
  readonly users: readonly Row[];
  readonly grants: readonly Row[];
  readonly roleGrants: readonly Row[];
  readonly tables: readonly Row[];
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const metadataTables = new Set(["users", "roles", "grants", "role_grants", "tables", "databases", "parts"]);
const show = new Set(["SHOW USERS", "SHOW ROLES", "SHOW TABLES", "SHOW COLUMNS", "SHOW DATABASES"]);
function text(value: unknown): string {
  if (typeof value !== "string" || !value.length || value.length > 1024) throw copyReadNotReady();
  return value;
}
function flag(value: unknown): number {
  if (value !== 0 && value !== 1) throw copyReadNotReady();
  return value;
}
function scope(value: unknown, target: string): boolean {
  if (value === null) return true;
  const name = text(value);
  // Only the documented trailing-prefix wildcard is supported; never interpret arbitrary patterns.
  if (name.includes("*")) {
    if (!/^[a-zA-Z0-9_]*\*$/.test(name)) throw copyReadNotReady();
    return target.startsWith(name.slice(0, -1));
  }
  return name === target;
}
function bounded(catalog: CopyStorageAuthorityCatalog) {
  for (const rows of [catalog.users, catalog.grants, catalog.roleGrants, catalog.tables]) {
    if (!Array.isArray(rows) || rows.length > 1000 || rows.some(row => !row || typeof row !== "object" || Array.isArray(row))) throw copyReadNotReady();
  }
}

/** Supported profile: local password identities, direct grants and plain MergeTree data tables.
 * Administrative exceptions are explicit trust assumptions, not an assertion that root cannot bypass storage. */
function evaluate(policy: CopyStorageAuthorityPolicy, catalog: CopyStorageAuthorityCatalog, existing: boolean) {
  bounded(catalog);
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(policy.databaseName) || policy.administratorIds.length < 1 || policy.administratorIds.length > 8) throw copyReadNotReady();
  const dedicated = [policy.writerId, policy.readerId, policy.auditorId];
  const identities = [...dedicated, ...policy.administratorIds];
  if (identities.some(id => !uuid.test(id)) || new Set(identities).size !== identities.length) throw copyReadNotReady();
  const users = new Map<string, Row>(), names = new Map<string, string>();
  for (const row of catalog.users) {
    const id = text(row.id), name = text(row.name);
    if (!uuid.test(id) || users.has(id) || names.has(name)) throw copyReadNotReady();
    users.set(id, row); names.set(name, id);
  }
  if (identities.some(id => !users.has(id))) throw copyReadNotReady();
  const [writer, reader, auditor] = dedicated.map(id => text(users.get(id)!.name));
  if (catalog.observer !== auditor) throw copyReadNotReady();
  for (const id of dedicated) {
    const auth = users.get(id)!.auth_type;
    if (!Array.isArray(auth) || auth.length !== 1 || !["sha256_password", "scram_sha256_password"].includes(String(auth[0]))) throw copyReadNotReady();
  }
  // No transitive or non-default role interpretation is silently approximated.
  if (catalog.roleGrants.length) throw copyReadNotReady();
  const administrators = new Set(policy.administratorIds), powerful = new Set<string>();
  const visible = new Set<string>(); let writes = 0, reads = 0;
  const relevant: Row[] = [];
  for (const row of catalog.grants) {
    if (row.role_name !== null || typeof row.user_name !== "string" || !names.has(row.user_name)) throw copyReadNotReady();
    const identity = names.get(row.user_name)!, access = text(row.access_type);
    const revoked = flag(row.is_partial_revoke), grantOption = flag(row.grant_option);
    const reaches = scope(row.database, policy.databaseName) && scope(row.table, "requests_v2_copies");
    if (administrators.has(identity)) {
      if (!revoked && grantOption && row.database === null && row.table === null && ["INSERT", "WRITE", "ALL"].includes(access)) powerful.add(identity);
      relevant.push(row); continue;
    }
    if (grantOption || (dedicated.includes(identity) && revoked)) throw copyReadNotReady();
    if (revoked) continue; // Revocation never creates a capability; positive grants remain conservatively considered.
    if (show.has(access)) {
      if (identity === policy.auditorId && row.database === null && row.table === null) visible.add(access);
      if (dedicated.includes(identity)) relevant.push(row);
      continue;
    }
    if (access === "NONE") continue;
    if (access !== "SELECT" && access !== "INSERT") throw copyReadNotReady();
    if (reaches) {
      if (row.database !== policy.databaseName || row.table !== "requests_v2_copies" || row.column !== null) throw copyReadNotReady();
      if (access === "INSERT" && identity === policy.writerId) writes++;
      else if (access === "SELECT" && identity === policy.readerId) reads++;
      else throw copyReadNotReady();
      relevant.push(row);
    } else if (dedicated.includes(identity)) {
      if (access !== "SELECT" || row.database !== "system" || typeof row.table !== "string" || !metadataTables.has(row.table)) throw copyReadNotReady();
      relevant.push(row);
    }
  }
  if (writes !== 1 || reads !== 1 || powerful.size !== administrators.size || !["SHOW USERS", "SHOW ROLES", "SHOW TABLES"].every(right => visible.has(right))) throw copyReadNotReady();
  let target = false;
  for (const row of catalog.tables) {
    if (text(row.engine) !== "MergeTree") throw copyReadNotReady();
    if (row.database === policy.databaseName && row.name === "requests_v2_copies") target = true;
  }
  if (existing ? !target : catalog.tables.some(row => row.database === policy.databaseName)) throw copyReadNotReady();
  return { writer: writer!, reader: reader!, auditor: auditor!,
    principals: identities.map(id => ({ id, name: text(users.get(id)!.name) })),
    grants: relevant, administrativeResidual: [...administrators] };
}

export function evaluateCopyStorageAuthority(policy: CopyStorageAuthorityPolicy, catalog: CopyStorageAuthorityCatalog) {
  return evaluate(policy, catalog, true);
}
/** Pre-creation ACL check only. It is never evidence that a table or admitted prefix exists. */
export function evaluateCopyStorageGenesisAccess(policy: CopyStorageAuthorityPolicy, catalog: CopyStorageAuthorityCatalog) {
  return evaluate(policy, catalog, false);
}
