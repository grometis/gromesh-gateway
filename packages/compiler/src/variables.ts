import { isIP } from "node:net";
import type { GatewayState, Service, VarField } from "./model.js";
import { CompileError, type CompileIssue as Issue } from "./errors.js";

const PROTOCOLS = new Set(["http", "https", "grpc", "grpcs", "tcp", "tls"]);
const HOSTNAME = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?$/;

/** A host name or an IP address (IPv6 bare or in brackets): the one rule for a host value, wherever it is checked. */
export function isHostValue(value: string): boolean {
  const bracketed = /^\[(.*)\]$/.exec(value)?.[1];
  if (bracketed !== undefined) return isIP(bracketed) === 6;
  return isIP(value) !== 0 || (value.length <= 253 && HOSTNAME.test(value));
}

/** What a field accepts from a variable's value (the field's own rules apply again to the value, contract). */
function fieldValue(field: VarField, value: string): { ok: true; value: string | number } | { ok: false; message: string } {
  switch (field) {
    case "port": {
      const n = Number(value);
      return /^[0-9]{1,5}$/.test(value) && n >= 1 && n <= 65535 ? { ok: true, value: n } : { ok: false, message: "the variable's value is not a port" };
    }
    case "protocol":
      return PROTOCOLS.has(value) ? { ok: true, value } : { ok: false, message: "the variable's value is not a service protocol" };
    case "path":
      return value.startsWith("/") ? { ok: true, value } : { ok: false, message: "the variable's value is not a path (it must start with /)" };
    case "host":
      return isHostValue(value) ? { ok: true, value } : { ok: false, message: "the variable's value is not a host name or an IP address" };
  }
}

/** A value of the right shape for each field, to check a draft's structure before any instance's value is known. */
// In capitals: an upstream's name is always lowercase, so the placeholder host can never name (or be captured by) one.
const PLACEHOLDER: Record<VarField, string | number> = { protocol: "http", host: "VARIABLE.INVALID", port: 1, path: "/" };

/** The state with every VarRef replaced by a placeholder of the field's shape (publishRelease's composition check). */
export function placeholderVariables(state: GatewayState): GatewayState {
  return { ...state, services: state.services.map(({ varRefs, ...s }) => (varRefs ? ({ ...s, ...Object.fromEntries(Object.keys(varRefs).map((f) => [f, PLACEHOLDER[f as VarField]])) } as Service) : s)) };
}

export interface InstanceValue {
  value: string;
  version: number;
}

/**
 * The state of one workspace with every VarRef resolved from this instance's values (WS-V2): a variable the release
 * does not declare, one without a value here, or a value the field refuses is an issue at the field's path, and the
 * whole state is refused (CompileError) before anything reaches a data plane. Returns the variables it used.
 */
export function resolveVariables(state: GatewayState, declared: ReadonlySet<string>, values: ReadonlyMap<string, InstanceValue>): { state: GatewayState; used: Map<string, InstanceValue> } {
  const issues: Issue[] = [];
  const used = new Map<string, InstanceValue>();
  const services = state.services.map(({ varRefs, ...s }, i) => {
    if (!varRefs) return s;
    const out: Record<string, unknown> = { ...s };
    for (const [field, name] of Object.entries(varRefs) as [VarField, string][]) {
      const path = `services[${i}].${field}`;
      if (!declared.has(name)) { issues.push({ path, message: `variable ${name} is not declared in this release` }); continue; }
      const v = values.get(name);
      if (!v) { issues.push({ path, message: `variable ${name} has no value on this instance` }); continue; }
      const r = fieldValue(field, v.value);
      if (!r.ok) { issues.push({ path, message: `${r.message} (variable ${name})` }); continue; }
      out[field] = r.value;
      used.set(name, v);
    }
    return out as unknown as Service;
  });
  if (issues.length > 0) throw new CompileError(issues);
  return { state: { ...state, services }, used };
}
