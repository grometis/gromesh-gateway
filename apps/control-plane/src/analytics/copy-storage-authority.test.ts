import { expect, it } from "vitest";
import { evaluateCopyStorageAuthority, evaluateCopyStorageGenesisAccess } from "./copy-storage-authority.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
// Synthetic catalog only: these objects never enter operational availability decisions.
function fixture() {
  const policy = { databaseName: "trusted_copies", writerId: id(1), readerId: id(2), auditorId: id(3), administratorIds: [id(4)] };
  const users = ["writer", "reader", "auditor", "administrator", "legacy"].map((name, i) => ({ name, id: id(i + 1), auth_type: ["sha256_password"] }));
  const grant = (user_name: string, access_type: string, database: string | null, table: string | null, grant_option = 0) => ({ user_name, role_name: null, access_type, database, table, column: null, is_partial_revoke: 0, grant_option });
  const grants = [grant("writer", "INSERT", "trusted_copies", "requests_v2_copies"), grant("reader", "SELECT", "trusted_copies", "requests_v2_copies"),
    grant("auditor", "SHOW USERS", null, null), grant("auditor", "SHOW ROLES", null, null), grant("auditor", "SHOW TABLES", null, null),
    grant("auditor", "SELECT", "system", "grants"), grant("administrator", "INSERT", null, null, 1), grant("legacy", "INSERT", "legacy", null)];
  const catalog = { observer: "auditor", users, grants, roleGrants: [] as Record<string, unknown>[], tables: [{ database: "trusted_copies", name: "requests_v2_copies", engine: "MergeTree" }] };
  return { policy, catalog, grant };
}
it("accepts only a complete observed direct-grant profile with separate principals", () => {
  const f = fixture();
  expect(evaluateCopyStorageAuthority(f.policy, f.catalog)).toMatchObject({ writer: "writer", reader: "reader", auditor: "auditor" });
});
it("distinguishes pre-creation access from authority over an existing resource", () => {
  const f = fixture(); f.catalog.tables = [];
  expect(evaluateCopyStorageGenesisAccess(f.policy, f.catalog)).toMatchObject({ writer: "writer" });
  expect(() => evaluateCopyStorageAuthority(f.policy, f.catalog)).toThrow();
  const existing = fixture();
  expect(() => evaluateCopyStorageGenesisAccess(existing.policy, existing.catalog)).toThrow();
});
it.each([
  ["INSERT", "trusted_copies", "requests_v2_copies"],
  ["INSERT", null, null],
  ["INSERT", "trusted*", "requests_v2_*"],
  ["ALTER", "trusted_copies", null],
  ["TRUNCATE", "trusted_copies", "requests_v2_copies"],
  ["ALTER USER", null, null],
] as const)("refuses a bypass grant %s on %s.%s", (access, database, table) => {
  const f = fixture(); f.catalog.grants.push(f.grant("legacy", access, database, table));
  expect(() => evaluateCopyStorageAuthority(f.policy, f.catalog)).toThrow();
});
it.each(["writer", "auditor"])("does not allow payload SELECT through %s", principal => {
  const f = fixture(); f.catalog.grants.push(f.grant(principal, "SELECT", "trusted_copies", "requests_v2_copies"));
  expect(() => evaluateCopyStorageAuthority(f.policy, f.catalog)).toThrow();
});
it("does not infer complete visibility from a catalog returned by a weaker observer", () => {
  const f = fixture(); f.catalog.grants = f.catalog.grants.filter(g => g.access_type !== "SHOW USERS");
  expect(() => evaluateCopyStorageAuthority(f.policy, f.catalog)).toThrow();
});
it("rejects roles instead of pretending to resolve inherited access", () => {
  const f = fixture(); f.catalog.roleGrants.push({ user_name: "writer", granted_role_name: "hidden_writer", with_admin_option: 0 });
  expect(() => evaluateCopyStorageAuthority(f.policy, f.catalog)).toThrow();
});
it("does not turn a runtime data identity into an administrative exception", () => {
  const f = fixture(); f.policy.administratorIds.push(f.policy.writerId);
  expect(() => evaluateCopyStorageAuthority(f.policy, f.catalog)).toThrow();
});
it("requires the real observer identity and an explicit powerful administrative residual", () => {
  const f = fixture(); f.catalog.observer = "reader";
  expect(() => evaluateCopyStorageAuthority(f.policy, f.catalog)).toThrow();
  f.catalog.observer = "auditor"; f.catalog.grants = f.catalog.grants.filter(g => g.user_name !== "administrator");
  expect(() => evaluateCopyStorageAuthority(f.policy, f.catalog)).toThrow();
});
it("rejects grant options and partial-revoke profiles on the dedicated writer", () => {
  const f = fixture(); f.catalog.grants[0]!.grant_option = 1;
  expect(() => evaluateCopyStorageAuthority(f.policy, f.catalog)).toThrow();
  f.catalog.grants[0]!.grant_option = 0; f.catalog.grants[0]!.is_partial_revoke = 1;
  expect(() => evaluateCopyStorageAuthority(f.policy, f.catalog)).toThrow();
});
it("refuses an indirect background writer engine even without a direct INSERT grant", () => {
  const f = fixture(); f.catalog.tables.push({ database: "legacy", name: "bridge", engine: "MaterializedView" });
  expect(() => evaluateCopyStorageAuthority(f.policy, f.catalog)).toThrow();
});
it("bounds catalog processing and does not accept incomplete principal identity", () => {
  const f = fixture(); f.catalog.users[0]!.id = id(99);
  expect(() => evaluateCopyStorageAuthority(f.policy, f.catalog)).toThrow();
  const large = fixture(); large.catalog.grants = Array.from({ length: 1001 }, () => large.catalog.grants[0]!);
  expect(() => evaluateCopyStorageAuthority(large.policy, large.catalog)).toThrow();
});
