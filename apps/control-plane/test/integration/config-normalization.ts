import { basicAuthPasswordHash, canonicalJson, hashConfig, type KongDeclarativeConfig } from "@gromesh/compiler";

/** Independent oracle: compare emitted entities, preserving every attribute except identities and platform environment. */
export function normalizedConfig(input: KongDeclarativeConfig, basicPassword?: string) {
  const config = structuredClone(input);
  const ids = new Map<string, string>();
  config.services.forEach(s => ids.set(s.id, `service:${s.name}`));
  config.routes.forEach(r => ids.set(r.id, `route:${r.name}`));
  config.consumers.forEach(c => ids.set(c.id, `consumer:${c.username ?? c.custom_id}`));
  config.upstreams?.forEach(u => ids.set(u.id, `upstream:${u.name}`));
  config.certificates?.forEach(c => ids.set(c.id, `certificate:${config.snis?.filter(s => s.certificate === c.id).map(s => s.name).sort().join(",") ?? c.cert}`));
  config.keyauth_credentials.forEach(k => ids.set(k.id, `key:${ids.get(k.consumer)}:${k.key}`));
  config.jwt_secrets?.forEach(j => ids.set(j.id, `jwt:${j.key}`));
  config.basicauth_credentials?.forEach(b => {
    if (basicPassword) {
      if (b.password !== basicAuthPasswordHash(b.consumer, basicPassword)) throw new Error("basic-auth hash is not salted with its real consumer id");
      b.password = basicAuthPasswordHash(ids.get(b.consumer)!, basicPassword);
    }
    ids.set(b.id, `basic:${b.username}`);
  });
  config.acls?.forEach(a => ids.set(a.id, `acl:${ids.get(a.consumer)}:${a.group}`));
  config.targets?.forEach(t => ids.set(t.id, `target:${ids.get(t.upstream)}:${t.target}`));
  config.snis?.forEach(s => ids.set(s.id, `sni:${ids.get(s.certificate)}:${s.name}`));
  config.plugins.forEach(p => {
    ids.set(p.id, `plugin:${p.name}:${ids.get(p.service ?? "") ?? ""}:${ids.get(p.route ?? "") ?? ""}:${ids.get(p.consumer ?? "") ?? ""}`);
    if (p.id === "14f9de7e-3701-4c69-b7f7-b8b5622c0102") (p.config.custom_fields_by_lua as Record<string, string>).environment_id = "[environment]";
  });
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return ids.get(value) ?? value;
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    return value;
  };
  const normalized = walk(config) as KongDeclarativeConfig;
  for (const value of Object.values(normalized)) if (Array.isArray(value)) value.sort((a: unknown, b: unknown) => canonicalJson(a).localeCompare(canonicalJson(b)));
  return normalized;
}
export const normalizedHash = (config: KongDeclarativeConfig) => hashConfig(config);
