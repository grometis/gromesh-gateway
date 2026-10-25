import { randomUUID } from "node:crypto";
import { basicAuthPasswordHash, hashIssues, validate, type ImportIdentity, type ConfigDocument, type Consumer, type ConsumerRef, type GatewayState, type Plugin, type Service, type Route, type Upstream, type Target, type Certificate } from "@gromesh/compiler";
import { type FieldError, ProblemException } from "../common/problem.js";
import { destinationIssues, type DestinationPolicy } from "../common/destinations.js";
import { checkCertificate } from "../certificates/certificates.js";
import { checkJwt } from "../consumers/credentials.js";
import { consumerValues } from "../consumers/consumers.js";
import { routeErrors, routeValues, serviceValues } from "../gateway/gateway.js";
import { upstreamValues, targetValues } from "../upstreams/upstreams.js";
import type { PluginCatalog } from "../plugin-catalog/catalog.js";
import type { PluginsService } from "../plugins/plugins.js";
import { anonymousOf, namesConsumer } from "../workspaces/anonymous.js";
import type { UniqueKind } from "../workspaces/instance-uniqueness.js";

/** Resolves a complete proposed domain state without writing. Every diagnostic uses a document path. */
/** The values of a kind (key-auth keys in clear) another workspace of the instance already holds. */
export type InstanceTaken = (kind: UniqueKind, values: string[]) => Promise<Set<string>>;

export async function planImport(document: ConfigDocument, current: GatewayState, mode: "merge" | "replace", catalog: PluginCatalog, plugins: PluginsService, destinations: DestinationPolicy, preservation?: { identity: ImportIdentity; consumerIdExists: (id: string) => Promise<boolean> }, workspaceDefaultRoutes: ReadonlySet<string> = new Set(), instanceTaken?: InstanceTaken) {
  const errors: FieldError[] = [];
  const paths = new Map<string, string>();
  const add = (path: string, message: string) => errors.push({ path, message });
  const capture = async (path: string, work: () => unknown) => {
    try { return await work(); } catch (error) {
      if (!(error instanceof ProblemException) || error.getStatus() !== 422) throw error;
      const problem = error.getResponse() as { errors?: FieldError[] };
      for (const e of problem.errors ?? []) add(`${path}${e.path === "(body)" ? "" : `.${e.path}`}`, e.message);
    }
  };
  const result: GatewayState = { services: [], routes: [], consumers: [], keyAuthCredentials: [], jwtCredentials: [], basicAuthCredentials: [], plugins: [], upstreams: [], targets: [], certificates: [] };
  function upsert<T extends { id: string }>(list: T[], value: T, path: string) {
    if (paths.has(value.id)) add(path, "duplicate entity in document");
    paths.set(value.id, path);
    list.push(value);
  }
  function retain<T extends { id: string }>(list: T[], old: T[]) {
    if (mode === "merge") list.push(...old.filter(o => !list.some(n => n.id === o.id)));
  }
  function matchConsumer(ref: ConsumerRef, list: Consumer[], path: string): Consumer | undefined {
    const byUsername = ref.username ? list.find(c => c.username === ref.username) : undefined;
    const byCustomId = ref.customId ? list.find(c => c.customId === ref.customId) : undefined;
    if (byUsername && byCustomId && byUsername.id !== byCustomId.id) add(path, "consumer identifiers resolve to different consumers");
    return byUsername ?? byCustomId;
  }
  function reference<T extends { id: string; name: string }>(list: T[], name: string | undefined, path: string) {
    const value = list.find(v => v.name === name);
    if (!value) add(path, "unknown reference in the resulting draft");
    return value?.id;
  }
  function secret(value: string | undefined, stored: string | null | undefined, path: string) {
    if (value !== undefined && value !== "REDACTED") return value;
    if (stored && stored !== "REDACTED") return stored;
    add(path, "a real secret is required for a new secret slot");
    return "";
  }
  for (const [i, s] of document.services.entries()) {
    const old = current.services.find(c => c.name === s.name);
    const values = serviceValues(s);
    const value: Service = { ...s, ...values, id: old?.id ?? randomUUID(), retries: values.retries ?? undefined, connectTimeoutMs: values.connectTimeoutMs ?? undefined, readTimeoutMs: values.readTimeoutMs ?? undefined, writeTimeoutMs: values.writeTimeoutMs ?? undefined };
    upsert(result.services, value, `document.services.${i}`);
  }
  retain(result.services, current.services);
  for (const [i, r] of document.routes.entries()) {
    const path = `document.routes.${i}`;
    const serviceId = reference(result.services, r.service, `${path}.service`) ?? randomUUID();
    const { service: _service, ...attributes } = r;
    const body = { ...attributes, serviceId };
    errors.push(...routeErrors(body).map(e => ({ ...e, path: `${path}${e.path === "(body)" ? "" : `.${e.path}`}` })));
    const normalized = routeValues(body);
    const value: Route = { ...body, ...normalized, id: current.routes.find(c => c.name === r.name)?.id ?? randomUUID(), methods: normalized.methods ?? undefined, hosts: normalized.hosts ?? undefined, paths: normalized.paths ?? undefined, headers: normalized.headers ?? undefined };
    // A workspace-default route keeps that classification through an import (same id), so it keeps a path.
    if (workspaceDefaultRoutes.has(value.id) && !(value.paths && value.paths.length > 0)) add(`${path}.paths`, "required for a workspace-default route");
    upsert(result.routes, value, path);
  }
  retain(result.routes, current.routes);
  let preservationConflict = false;
  for (const [i, c] of document.consumers.entries()) {
    const path = `document.consumers.${i}`;
    const requestedId = preservation?.identity.consumerIds.get(i);
    const old = requestedId ? current.consumers.find(v => v.id === requestedId) : matchConsumer(c, current.consumers, path);
    if (requestedId && preservation) {
      let conflict = false;
      if (!old && await preservation.consumerIdExists(requestedId)) {
        add(`${path}.id`, "consumer id cannot be preserved because it is already in use");
        conflict = true;
      }
      if (!conflict) for (const field of ["username", "customId"] as const) {
        if (c[field] && current.consumers.some(v => v.id !== requestedId && v[field] === c[field])) {
          add(`${path}.${field}`, "consumer identifier conflicts with the consumer id to preserve");
          conflict = true;
        }
      }
      if (conflict) {
        preservationConflict = true;
        c.basicAuthCredentials.forEach((_k, j) => {
          const passwordPath = `${path}.basicAuthCredentials.${j}.password`;
          if (preservation.identity.prehashedPasswords.has(passwordPath)) add(passwordPath, "Kong's hash is salted with the consumer id; the source consumer UUID cannot be preserved");
        });
        continue;
      }
    }
    const value: Consumer = { id: requestedId ?? old?.id ?? randomUUID(), ...consumerValues(c), aclGroups: mode === "merge" ? [...new Set([...(old?.aclGroups ?? []), ...c.aclGroups])] : c.aclGroups };
    upsert(result.consumers, value, path);
    function credentialMatch<T extends { id: string; consumerId: string }>(list: T[], id: string | undefined, natural: (v: T) => boolean, p: string): T | undefined {
      const byId = id ? list.find(v => v.id === id) : undefined;
      const byKey = list.find(natural);
      if ((byId && byId.consumerId !== value.id) || (byKey && byKey.consumerId !== value.id)) add(p, "credential belongs to another consumer");
      if (byId && byKey && byId.id !== byKey.id) add(`${p}.id`, "credential id disagrees with its natural key");
      return (byId?.consumerId === value.id ? byId : undefined) ?? (byKey?.consumerId === value.id ? byKey : undefined);
    }
    for (const [j, k] of c.keyAuthCredentials.entries()) {
      const p = `${path}.keyAuthCredentials.${j}`;
      const old = credentialMatch(current.keyAuthCredentials, k.id, v => k.key !== undefined && k.key !== "REDACTED" && v.key === k.key, p);
      upsert(result.keyAuthCredentials, { id: old?.id ?? randomUUID(), consumerId: value.id, key: secret(k.key, old?.key, `${p}.key`), tags: k.tags ?? [] }, p);
    }
    for (const [j, k] of c.jwtCredentials.entries()) {
      const p = `${path}.jwtCredentials.${j}`;
      const old = credentialMatch(current.jwtCredentials ?? [], k.id, v => v.key === k.key, p);
      const body = { ...k, ...(k.algorithm === "HS256" ? { secret: secret(k.secret, old?.secret, `${p}.secret`) } : {}) };
      await capture(p, () => checkJwt(body));
      upsert(result.jwtCredentials!, { ...body, id: old?.id ?? randomUUID(), consumerId: value.id, tags: k.tags ?? [] }, p);
    }
    for (const [j, k] of c.basicAuthCredentials.entries()) {
      const p = `${path}.basicAuthCredentials.${j}`;
      const old = credentialMatch(current.basicAuthCredentials ?? [], k.id, v => v.username === k.username, p);
      const passwordHash = k.password === undefined || k.password === "REDACTED" ? secret(undefined, old?.passwordHash, `${p}.password`) : preservation?.identity.prehashedPasswords.has(`${p}.password`) ? k.password : basicAuthPasswordHash(value.id, k.password);
      if (!passwordHash) continue;
      upsert(result.basicAuthCredentials!, { id: old?.id ?? randomUUID(), consumerId: value.id, username: k.username, passwordHash, tags: k.tags ?? [] }, p);
    }
  }
  retain(result.consumers, current.consumers);
  retain(result.keyAuthCredentials, current.keyAuthCredentials);
  retain(result.jwtCredentials!, current.jwtCredentials ?? []);
  retain(result.basicAuthCredentials!, current.basicAuthCredentials ?? []);
  if (preservationConflict) return { state: result, errors, instanceConflict: false };
  for (const [i, u] of document.upstreams.entries()) {
    const path = `document.upstreams.${i}`;
    const { targets, ...body } = u;
    errors.push(...hashIssues(body, path));
    const value: Upstream = { ...body, ...upstreamValues({ ...body, id: "" }), id: current.upstreams?.find(c => c.name === u.name)?.id ?? randomUUID() };
    upsert(result.upstreams!, value, path);
    for (const [j, t] of targets.entries()) {
      const old = current.targets?.find(c => c.upstreamId === value.id && c.target === t.target);
      const target: Target = { ...targetValues(t), id: old?.id ?? randomUUID(), upstreamId: value.id };
      upsert(result.targets!, target, `${path}.targets.${j}`);
    }
  }
  retain(result.upstreams!, current.upstreams ?? []);
  retain(result.targets!, current.targets ?? []);
  for (const [i, c] of document.certificates.entries()) {
    const path = `document.certificates.${i}`;
    const byId = c.id ? current.certificates?.find(v => v.id === c.id) : undefined;
    const set = [...c.snis].sort().join("\0");
    const bySnis = c.snis.length ? current.certificates?.find(v => [...v.snis].sort().join("\0") === set) : undefined;
    if (byId && bySnis && byId.id !== bySnis.id) add(path, "certificate id and SNI set resolve to different certificates");
    const old = byId ?? bySnis;
    const key = secret(c.key, old?.key, `${path}.key`);
    await capture(path, () => checkCertificate({ ...c, key }, old?.key ?? null, old?.cert !== c.cert));
    const value: Certificate = { ...c, key, id: old?.id ?? randomUUID(), tags: c.tags ?? [] };
    upsert(result.certificates!, value, path);
  }
  retain(result.certificates!, current.certificates ?? []);
  for (const c of result.certificates!) {
    const path = paths.get(c.id);
    if (!path) continue;
    c.snis.forEach((name, i) => {
      if (result.certificates!.some(other => other.id !== c.id && other.snis.includes(name))) add(`${path}.snis.${i}`, "SNI overlaps another certificate in the resulting draft");
    });
  }
  for (const [i, p] of document.plugins.entries()) {
    const path = `document.plugins.${i}`;
    const scope: Plugin["scope"] = {};
    if (p.scope?.service) scope.serviceId = reference(result.services, p.scope.service, `${path}.scope.service`);
    if (p.scope?.route) scope.routeId = reference(result.routes, p.scope.route, `${path}.scope.route`);
    if (p.scope?.consumer) { scope.consumerId = matchConsumer(p.scope.consumer, result.consumers, `${path}.scope.consumer`)?.id; if (!scope.consumerId) add(`${path}.scope.consumer`, "unknown consumer reference"); }
    const old = current.plugins.find(c => c.name === p.name && ["serviceId", "routeId", "consumerId"].every(k => (c.scope?.[k as keyof typeof scope] ?? null) === (scope[k as keyof typeof scope] ?? null)));
    const entry = catalog.find(p.name);
    if (!entry) { add(`${path}.name`, "unknown plugin"); continue; }
    const unknown = catalog.importConfigErrors(p.name, p.config);
    errors.push(...unknown.map(e => ({ ...e, path: `${path}.${e.path}` })));
    const merged = catalog.preserveImportSecrets(p.name, p.config, old?.config ?? null);
    errors.push(...merged.missing.map(e => ({ path: `${path}.${e}`, message: "a real secret is required for a new secret slot" })));
    const defaults = catalog.defaultProtocols(p.name);
    const value: Plugin = { id: old?.id ?? randomUUID(), name: p.name, scope, config: merged.config, enabled: p.enabled ?? true, protocols: p.protocols?.length ? p.protocols : defaults, tags: p.tags ?? [] };
    if (!unknown.length && !merged.missing.length) await capture(path, () => plugins.validate(value.id, { ...value, config: value.config! }));
    upsert(result.plugins, value, path);
  }
  retain(result.plugins, current.plugins);
  // Credentials and server names are unique in the instance (decision H-5): each one of the resulting draft that
  // another workspace holds is an errors[] entry at its path (one kept from the draft: at "document"), with the same
  // generic message as a single write's 409. The caller learns of it from `instanceConflict`, not from the message.
  let instanceConflict = false;
  if (instanceTaken) {
    const check = async <T extends { id: string }>(kind: UniqueKind, items: T[], value: (item: T) => string[], field: (i: number) => string) => {
      const taken = await instanceTaken(kind, items.flatMap(value));
      for (const item of items) value(item).forEach((v, i) => {
        if (!taken.has(v)) return;
        instanceConflict = true;
        const path = paths.get(item.id);
        if (path) add(`${path}.${field(i)}`, "already in use in this instance");
        else add("document", "an entity kept from the draft holds a value already in use in this instance");
      });
    };
    await check("key-auth-key", result.keyAuthCredentials, k => [k.key], () => "key");
    await check("jwt-key", result.jwtCredentials!, j => [j.key], () => "key");
    await check("basic-auth-username", result.basicAuthCredentials!, b => [b.username], () => "username");
    await check("sni", result.certificates!, c => c.snis, i => `snis.${i}`);
  }
  // `anonymous` names a consumer of the resulting draft, never another workspace's (decision H-1).
  for (const plugin of result.plugins) {
    const anonymous = anonymousOf(plugin.config);
    if (anonymous === null || result.consumers.some(c => namesConsumer(anonymous, c))) continue;
    const path = paths.get(plugin.id);
    if (path) add(`${path}.config.anonymous`, "unknown consumer in the resulting draft");
    else add("document.consumers", `a plugin outside the document uses as anonymous a consumer the import removes or renames (${plugin.name})`);
  }
  // Compiler validation covers the resulting draft, including cross-entity uniqueness and ACL/hash rules.
  for (const issue of [...validate(result), ...destinationIssues(result, destinations)]) {
    const normalized = issue.path.replace(/\[(\d+)\]/g, ".$1");
    const [kind, index, ...rest] = normalized.split(".");
    const list = result[kind as keyof GatewayState];
    const entity = Array.isArray(list) ? list[Number(index)] : undefined;
    const base = entity && paths.get(entity.id);
    add(base ? `${base}${rest.length ? `.${rest.join(".")}` : ""}` : "document", issue.message.replace(/"[^"]*"/g, '"[value]"'));
  }
  return { state: result, errors, instanceConflict };
}
