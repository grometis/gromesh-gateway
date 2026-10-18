import type { BasicAuthCredential, Certificate, Consumer, GatewayState, JwtCredential, KeyAuthCredential, Plugin, Route, Service, Target, Upstream } from "./model.js";

export type ConsumerRef = Pick<Consumer, "username" | "customId">;
export interface ConfigConsumer extends Omit<Consumer, "id"> {
  aclGroups: string[];
  keyAuthCredentials: (Omit<KeyAuthCredential, "id" | "consumerId" | "key"> & { id?: string; key?: string; keyHint?: string })[];
  jwtCredentials: (Omit<JwtCredential, "id" | "consumerId" | "secret" | "rsaPublicKey"> & { id?: string; secret?: string; rsaPublicKey?: string })[];
  basicAuthCredentials: (Omit<BasicAuthCredential, "id" | "consumerId" | "passwordHash"> & { id?: string; password?: string })[];
}
export interface ConfigPlugin extends Omit<Plugin, "id" | "scope" | "config"> {
  scope?: { service?: string; route?: string; consumer?: ConsumerRef };
  config: Record<string, unknown>;
}
export interface ConfigDocument {
  apiVersion: "gromesh/v1";
  services: Omit<Service, "id">[];
  routes: (Omit<Route, "id" | "serviceId"> & { service: string })[];
  consumers: ConfigConsumer[];
  plugins: ConfigPlugin[];
  upstreams: (Omit<Upstream, "id"> & { targets: Omit<Target, "id" | "upstreamId">[] })[];
  certificates: (Omit<Certificate, "id" | "key"> & { id?: string; key?: string })[];
}

/** A hint must never reveal an entire legacy key shorter than the current creation policy. */
export const credentialKeyHint = (key: string): string => key.length > 4 ? `…${key.slice(-4)}` : "…";

/** Domain-only transfer format; never includes environment settings or injected platform plugins. */
export function exportConfig(state: GatewayState, redact: (name: string, config: Record<string, unknown>) => Record<string, unknown>): ConfigDocument {
  const consumerRef = (id: string): ConsumerRef => {
    const c = state.consumers.find(c => c.id === id)!;
    return { ...(c.username ? { username: c.username } : {}), ...(c.customId ? { customId: c.customId } : {}) };
  };
  return {
    apiVersion: "gromesh/v1",
    services: state.services.map(({ id: _id, ...s }) => s),
    routes: state.routes.map(({ id: _id, serviceId, ...r }) => ({ ...r, service: state.services.find(s => s.id === serviceId)!.name })),
    consumers: state.consumers.map(c => ({
      ...consumerRef(c.id), tags: c.tags ?? [], aclGroups: c.aclGroups ?? [],
      keyAuthCredentials: state.keyAuthCredentials.filter(k => k.consumerId === c.id).map(k => ({ id: k.id, keyHint: credentialKeyHint(k.key), tags: k.tags ?? [] })),
      jwtCredentials: (state.jwtCredentials ?? []).filter(j => j.consumerId === c.id).map(j => ({
        id: j.id, key: j.key, algorithm: j.algorithm, tags: j.tags ?? [],
        ...(j.algorithm === "HS256" ? { secret: "REDACTED" } : { rsaPublicKey: j.rsaPublicKey! }),
      })),
      basicAuthCredentials: (state.basicAuthCredentials ?? []).filter(b => b.consumerId === c.id).map(b => ({ id: b.id, username: b.username, tags: b.tags ?? [] })),
    })),
    plugins: state.plugins.map(p => ({
      name: p.name, enabled: p.enabled ?? true, config: redact(p.name, p.config ?? {}), tags: p.tags ?? [],
      ...(p.protocols ? { protocols: p.protocols } : {}),
      scope: {
        ...(p.scope?.serviceId ? { service: state.services.find(s => s.id === p.scope!.serviceId)!.name } : {}),
        ...(p.scope?.routeId ? { route: state.routes.find(r => r.id === p.scope!.routeId)!.name } : {}),
        ...(p.scope?.consumerId ? { consumer: consumerRef(p.scope.consumerId) } : {}),
      },
    })),
    upstreams: (state.upstreams ?? []).map(({ id, ...u }) => ({ ...u, targets: (state.targets ?? []).filter(t => t.upstreamId === id).map(({ id: _id, upstreamId: _upstreamId, ...t }) => t) })),
    certificates: (state.certificates ?? []).map(c => ({ ...c, key: "REDACTED" })),
  };
}
