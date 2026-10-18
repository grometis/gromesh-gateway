import type { GatewayState } from "./model.js";
import { exportConfig } from "./document.js";
import type { ConfigDocument } from "./document.js";
import type { CompileIssue } from "./errors.js";

type Obj = Record<string, unknown>;
const record = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** Conversion retains a path map so later domain/schema diagnostics point to the original source. */
export function convertKongConfig(input: unknown, existing?: GatewayState): { document: ConfigDocument; errors: CompileIssue[]; sourcePath: (path: string) => string } {
  const errors: CompileIssue[] = [];
  const paths = new Map<string, string>();
  const error = (path: string, message = "is not supported by the Gromesh model") => errors.push({ path, message });
  const obj = (v: unknown, p: string): Obj => { if (record(v)) return v; error(p, "must be an object"); return {}; };
  const array = (v: unknown, p: string): Obj[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) { error(p, "must be an array"); return []; }
    return v.map((e, i) => obj(e, `${p}.${i}`));
  };
  const only = (o: Obj, allowed: string[], p: string) => Object.keys(o).forEach(k => { if (!allowed.includes(k)) error(`${p}.${k}`); });
  const root = obj(input, "document");
  only(root, ["_format_version", "_transform", "services", "routes", "consumers", "keyauth_credentials", "jwt_secrets", "basicauth_credentials", "acls", "plugins", "upstreams", "targets", "certificates", "snis"], "document");
  if (root._format_version !== "3.0") error("document._format_version", 'must be the string "3.0"');
  if (root._transform !== undefined && typeof root._transform !== "boolean") error("document._transform", "must be a boolean");
  const doc: Obj = { apiVersion: "gromesh/v1", services: [], routes: [], consumers: [], plugins: [], upstreams: [], certificates: [] };
  const collection = (kind: string) => doc[kind] as Obj[];
  const sources: Record<string, { raw: Obj; out: Obj; path: string }[]> = {};
  const nested: { kind: string; raw: Obj; path: string; parentKind: string; parent: Obj }[] = [];
  const identities: Record<string, { raw: Obj; out: Obj }[]> = {};
  const fields: Record<string, string[]> = {
    services: ["name", "protocol", "host", "port", "path", "retries", "connect_timeout", "read_timeout", "write_timeout", "enabled", "tags"],
    routes: ["name", "protocols", "methods", "hosts", "paths", "headers", "strip_path", "preserve_host", "tags"],
    consumers: ["username", "custom_id", "tags"],
    plugins: ["name", "enabled", "config", "protocols", "tags"],
    upstreams: ["name", "algorithm", "hash_on", "hash_fallback", "hash_on_header", "hash_fallback_header", "hash_on_cookie", "hash_on_cookie_path", "healthchecks", "tags"],
    certificates: ["id", "cert", "key", "tags"],
    keyauth_credentials: ["id", "key", "tags"], jwt_secrets: ["id", "key", "algorithm", "secret", "rsa_public_key", "tags"],
    basicauth_credentials: ["id", "username", "password", "tags"], acls: ["group"], targets: ["target", "weight", "tags"], snis: ["name"],
  };
  const names: Record<string, string> = { connect_timeout: "connectTimeoutMs", read_timeout: "readTimeoutMs", write_timeout: "writeTimeoutMs", strip_path: "stripPath", preserve_host: "preserveHost", custom_id: "customId", rsa_public_key: "rsaPublicKey", hash_on: "hashOn", hash_fallback: "hashFallback", hash_on_header: "hashOnHeader", hash_fallback_header: "hashFallbackHeader", hash_on_cookie: "hashOnCookie", hash_on_cookie_path: "hashOnCookiePath" };
  const children: Record<string, string[]> = { services: ["routes", "plugins"], routes: ["plugins"], consumers: ["keyauth_credentials", "jwt_secrets", "basicauth_credentials", "acls", "plugins"], upstreams: ["targets"], certificates: ["snis"] };
  const relations: Record<string, string[]> = { routes: ["service"], plugins: ["service", "route", "consumer"], keyauth_credentials: ["consumer"], jwt_secrets: ["consumer"], basicauth_credentials: ["consumer"], acls: ["consumer"], targets: ["upstream"], snis: ["certificate"] };
  function mapped(kind: string, raw: Obj, p: string, dest: string): Obj {
    only(raw, [...fields[kind]!, "id", ...(kind === "acls" || kind === "snis" ? ["tags"] : []), ...(children[kind] ?? []), ...(relations[kind] ?? [])], p);
    paths.set(dest, p);
    const out: Obj = {};
    for (const f of fields[kind]!) if (raw[f] !== undefined) { const name = names[f] ?? f; out[name] = raw[f]; paths.set(`${dest}.${name}`, `${p}.${f}`); }
    return out;
  }
  function entity(kind: string, raw: Obj, p: string): Obj {
    const dest = `document.${kind}.${collection(kind).length}`;
    const out = mapped(kind, raw, p, dest);
    collection(kind).push(out);
    (sources[kind] ??= []).push({ raw, out, path: p });
    (identities[kind] ??= []).push({ raw, out });
    if (kind === "services") { out.protocol ??= "http"; out.port ??= 80; }
    for (const child of children[kind] ?? []) for (const [i, value] of array(raw[child], `${p}.${child}`).entries()) {
      if (child === "routes" || child === "plugins") { const c = entity(child, value, `${p}.${child}.${i}`); nested.push({ kind: child, raw: value, path: `${p}.${child}.${i}`, parentKind: kind, parent: out }); }
      else nested.push({ kind: child, raw: value, path: `${p}.${child}.${i}`, parentKind: kind, parent: out });
    }
    if (kind === "consumers") Object.assign(out, { aclGroups: [], keyAuthCredentials: [], jwtCredentials: [], basicAuthCredentials: [] });
    if (kind === "upstreams") out.targets = [];
    if (kind === "certificates") out.snis = [];
    if (kind === "upstreams" && raw.healthchecks !== undefined) out.healthchecks = healthchecks(raw.healthchecks, `${p}.healthchecks`, `${dest}.healthchecks`);
    return out;
  }
  function ref(kind: string, value: unknown, p: string): Obj | undefined {
    let field: string | undefined;
    if (record(value)) {
      only(value, ["id", "name", "username", "custom_id"], p);
      const keys = Object.keys(value);
      if (keys.length !== 1) error(p, "must contain exactly one source reference");
      field = keys[0]; value = field ? value[field] : undefined;
    }
    const matches = typeof value === "string" ? (identities[kind] ?? []).filter(e => field ? e.raw[field] === value : [e.raw.id, e.raw.name, e.raw.username, e.raw.custom_id].includes(value)) : [];
    const targets = [...new Set(matches.map(m => m.out))];
    if (targets.length !== 1) { error(p, targets.length > 1 ? "ambiguous source reference" : "unknown source reference"); return; }
    return targets[0];
  }
  const consumerRef = (c: Obj) => ({ ...(c.username ? { username: c.username } : {}), ...(c.customId ? { customId: c.customId } : {}) });
  for (const kind of ["services", "routes", "consumers", "upstreams", "certificates", "plugins"]) for (const [i, value] of array(root[kind], `document.${kind}`).entries()) entity(kind, value, `document.${kind}.${i}`);
  if (existing) {
    const exported = exportConfig(existing, (_name, config) => config);
    for (const kind of ["services", "routes", "consumers", "upstreams", "certificates"] as const) {
      const old = existing[kind] ?? [];
      const docs = exported[kind];
      old.forEach((entity, i) => {
        const source = sources[kind]?.find(e => kind === "consumers" ?
          (("username" in entity && entity.username && entity.username === e.out.username) || ("customId" in entity && entity.customId && entity.customId === e.out.customId)) :
          ("name" in entity ? entity.name === e.out.name : entity.id === e.out.id));
        const out = source?.out ?? structuredClone(docs[i]) as unknown as Obj;
        if (!source) {
          if (kind === "consumers") Object.assign(out, { aclGroups: [], keyAuthCredentials: [], jwtCredentials: [], basicAuthCredentials: [] });
          if (kind === "upstreams") out.targets = [];
        }
        const raw: Obj = { ...entity, custom_id: "customId" in entity ? entity.customId : undefined };
        (identities[kind] ??= []).push({ raw, out });
      });
    }
  }
  for (const kind of ["routes", "plugins"]) for (const { raw, out, path } of sources[kind] ?? []) {
    const parent = nested.find(n => n.kind === kind && n.raw === raw);
    const resolve = (field: string, plural: string) => {
      const implicit = parent?.parentKind === plural ? parent.parent : undefined;
      const explicit = raw[field] == null ? undefined : ref(plural, raw[field], `${path}.${field}`);
      if (implicit && explicit && implicit !== explicit) error(`${path}.${field}`, "disagrees with the nesting scope");
      return explicit ?? implicit;
    };
    if (kind === "routes") { const s = resolve("service", "services"); if (s) out.service = s.name; else error(`${path}.service`, "is required"); }
    else {
      const s = resolve("service", "services"), r = resolve("route", "routes"), c = resolve("consumer", "consumers");
      const dest = `document.plugins.${collection("plugins").indexOf(out)}.scope`;
      for (const field of ["service", "route", "consumer"]) paths.set(`${dest}.${field}`, `${path}.${field}`);
      out.scope = { ...(s ? { service: s.name } : {}), ...(r ? { route: r.name } : {}), ...(c ? { consumer: consumerRef(c) } : {}) };
    }
  }
  const leafKinds = ["keyauth_credentials", "jwt_secrets", "basicauth_credentials", "acls", "targets", "snis"];
  for (const kind of leafKinds) {
    const relation = relations[kind]![0]!;
    const parentKind = { consumer: "consumers", upstream: "upstreams", certificate: "certificates" }[relation]!;
    const entries = [...array(root[kind], `document.${kind}`).map((raw, i) => ({ raw, path: `document.${kind}.${i}`, parent: undefined as Obj | undefined })), ...nested.filter(n => n.kind === kind)];
    for (const { raw, path, parent: implicit } of entries) {
      const explicit = raw[relation] == null ? undefined : ref(parentKind, raw[relation], `${path}.${relation}`);
      if (implicit && explicit && implicit !== explicit) error(`${path}.${relation}`, "disagrees with nesting");
      const parent = explicit ?? implicit;
      if (!parent) { error(`${path}.${relation}`, "is required"); continue; }
      const field = { keyauth_credentials: "keyAuthCredentials", jwt_secrets: "jwtCredentials", basicauth_credentials: "basicAuthCredentials", acls: "aclGroups", targets: "targets", snis: "snis" }[kind]!;
      if (!collection(parentKind).includes(parent)) collection(parentKind).push(parent);
      const list = parent[field] as unknown[];
      const pi = collection(parentKind).indexOf(parent);
      const dest = `document.${parentKind}.${pi}.${field}.${list.length}`;
      // SNI and ACL identities/tags have no independent domain slot; nontrivial tags cannot be discarded.
      const out = mapped(kind, raw, path, dest);
      if (kind === "jwt_secrets") out.algorithm ??= "HS256";
      if ((kind === "acls" || kind === "snis") && raw.tags !== undefined &&
        (!Array.isArray(raw.tags) || raw.tags.some(tag => !(parent.tags as unknown[] | undefined)?.includes(tag)))) error(`${path}.tags`, "independent membership tags cannot be represented");
      if (kind === "acls" || kind === "snis") paths.set(dest, `${path}.${kind === "acls" ? "group" : "name"}`);
      if (kind === "basicauth_credentials" && root._transform === false) error("document._transform", "prehashed basic-auth credentials cannot be imported");
      list.push(kind === "acls" ? out.group : kind === "snis" ? out.name : out);
    }
  }
  function healthchecks(value: unknown, p: string, dest: string): Obj {
    const h = obj(value, p), out: Obj = {};
    only(h, ["active", "passive"], p);
    if (h.active != null) {
      const a = obj(h.active, `${p}.active`); only(a, ["type", "http_path", "timeout", "healthy", "unhealthy"], `${p}.active`);
      const healthy = obj(a.healthy ?? {}, `${p}.active.healthy`), unhealthy = obj(a.unhealthy ?? {}, `${p}.active.unhealthy`);
      only(healthy, ["interval", "successes"], `${p}.active.healthy`); only(unhealthy, ["interval", "http_failures", "tcp_failures", "timeouts"], `${p}.active.unhealthy`);
      const interval = healthy.interval ?? unhealthy.interval ?? 0;
      if ((healthy.interval ?? 0) !== (unhealthy.interval ?? 0)) error(`${p}.active.${healthy.interval !== undefined ? "healthy" : "unhealthy"}.interval`, "healthy and unhealthy intervals must match");
      const thresholdFields = a.type === "tcp" ? ["tcp_failures", "timeouts"] : ["http_failures", "tcp_failures", "timeouts"];
      const thresholds = thresholdFields.map(field => unhealthy[field] ?? 0);
      if (new Set(thresholds).size > 1) error(`${p}.active.unhealthy`, "thresholds cannot be represented independently, including omitted zero defaults");
      if (a.type === "tcp" && unhealthy.http_failures !== undefined) error(`${p}.active.unhealthy.http_failures`, "HTTP thresholds are not represented for TCP checks");
      out.active = {};
      const fields: [string, unknown, string][] = [["type", a.type ?? "http", "type"], ["httpPath", a.http_path ?? "/", "http_path"], ["timeoutSeconds", a.timeout ?? 1, "timeout"], ["intervalSeconds", interval, healthy.interval !== undefined ? "healthy.interval" : "unhealthy.interval"], ["healthyThreshold", healthy.successes ?? 0, "healthy.successes"], ["unhealthyThreshold", thresholds[0], `unhealthy.${Object.keys(unhealthy).find(k => ["http_failures", "tcp_failures", "timeouts"].includes(k)) ?? "http_failures"}`]];
      for (const [key, val, source] of fields) if (val !== undefined) { (out.active as Obj)[key] = val; paths.set(`${dest}.active.${key}`, `${p}.active.${source}`); }
    }
    if (h.passive != null) {
      const passive = obj(h.passive, `${p}.passive`); only(passive, ["unhealthy"], `${p}.passive`);
      const u = obj(passive.unhealthy ?? {}, `${p}.passive.unhealthy`); only(u, ["http_failures", "timeouts"], `${p}.passive.unhealthy`);
      out.passive = { unhealthyHttpFailures: u.http_failures ?? 0, unhealthyTimeouts: u.timeouts ?? 0 };
      paths.set(`${dest}.passive.unhealthyHttpFailures`, `${p}.passive.unhealthy.http_failures`); paths.set(`${dest}.passive.unhealthyTimeouts`, `${p}.passive.unhealthy.timeouts`);
    }
    return out;
  }
  const sourcePath = (path: string): string => {
    let prefix = path;
    while (prefix) { const source = paths.get(prefix); if (source) return source + path.slice(prefix.length); prefix = prefix.slice(0, prefix.lastIndexOf(".")); }
    return path;
  };
  return { document: doc as unknown as ConfigDocument, errors, sourcePath };
}
