import type { GatewayState } from "@gromesh/compiler";
import type { FieldError } from "./problem.js";

/**
 * Kong resolves `{vault://...}` in the data plane, where `env` references read the gateway's own environment (the
 * collector token among them). Only platform plugins, compiled by the control plane, may carry references
 * (contract: Vault references), so no user configuration reaches the data plane with one.
 */
export function vaultReferenceIssues(value: unknown, path: string): FieldError[] {
  if (typeof value === "string") {
    return value.includes("{vault://") ? [{ path, message: "must not contain a vault reference" }] : [];
  }
  if (Array.isArray(value)) return value.flatMap((item, i) => vaultReferenceIssues(item, `${path}.${i}`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => vaultReferenceIssues(item, `${path}.${key}`));
  }
  return [];
}

/**
 * Every user entity of a whole state, with the compiler's path style (`plugins[0].config...`): Kong also resolves
 * references in fields of other entities (certificate keys, for one).
 */
export function stateVaultReferenceIssues(state: GatewayState): FieldError[] {
  return Object.entries(state).flatMap(([kind, list]) =>
    Array.isArray(list) ? list.flatMap((entity, i) => vaultReferenceIssues(entity, `${kind}[${i}]`)) : [],
  );
}
