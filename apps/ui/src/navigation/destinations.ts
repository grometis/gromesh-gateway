import { matchPath } from "react-router";

export type NavigationScope = "global" | "admin" | "account" | "workspace-v2" | "legacy-v1";
export interface Destination {
  id: string;
  label: string;
  path: string;
  scope: NavigationScope;
  parentId?: string;
  adminOnly?: boolean;
}

// Keep the #270 destination identities and detail ancestors, with explicit v1/v2 scopes.
const legacy = [
  ["N01", "overview", "Visão geral"], ["N02", "services", "Services"],
  ["N03", "services/:serviceId", "Service", "N02"], ["N04", "routes", "Routes"],
  ["N05", "consumers", "Consumers"], ["N06", "consumers/:consumerId", "Consumer", "N05"],
  ["N07", "plugins", "Plugins"], ["N08", "upstreams", "Upstreams"],
  ["N09", "certificates", "Certificados"], ["N10", "variables", "Variáveis"],
  ["N11", "releases", "Releases"], ["N12", "publish", "Revisar snapshot (legado)"],
  ["N13", "publications", "Publicações"], ["N14", "publications/:version", "Snapshot", "N13"],
  ["N15", "clusters", "Clusters"], ["N16", "metrics", "Métricas"], ["N17", "requests", "Requisições"],
] as const;
export const workspaceSections = ["services", "routes", "releases", "variables", "plugins", "upstreams"] as const;
export const destinations: readonly Destination[] = [
  { id: "instance", label: "Instância", path: "/", scope: "global" },
  { id: "N18", label: "Workspaces", path: "/workspaces", scope: "global" },
  { id: "N19", label: "Tokens de API", path: "/tokens", scope: "account" },
  { id: "N20", label: "Usuários", path: "/users", scope: "admin", adminOnly: true },
  { id: "N21", label: "Auditoria", path: "/audit", scope: "admin", adminOnly: true },
  ...legacy.map(([id, path, label, ...parent]) => ({ id, path: `/e/:envId/${path}`, label, scope: "legacy-v1" as const, ...(parent[0] ? { parentId: parent[0] } : {}) })),
  { id: "legacy-entry", label: "Services", path: "/e/:envId", scope: "legacy-v1", parentId: "N02" },
  { id: "legacy-analytics", label: "Métricas", path: "/e/:envId/analytics", scope: "legacy-v1", parentId: "N16" },
  { id: "workspace-entry", label: "Services", path: "/workspaces/:workspaceId", scope: "workspace-v2", parentId: "v2-N02" },
  ...legacy.filter(([, path]) => workspaceSections.some((section) => path === section || path === `${section}/:serviceId`))
    .map(([id, path, label, ...parent]) => ({ id: `v2-${id}`, path: `/workspaces/:workspaceId/${path}`, label, scope: "workspace-v2" as const, ...(parent[0] ? { parentId: `v2-${parent[0]}` } : {}) })),
];

export function resolveDestination(url: string) {
  const pathname = url.split(/[?#]/, 1)[0]!;
  for (const destination of destinations) {
    const match = matchPath({ path: destination.path, end: true }, pathname);
    if (match) return { destination, params: match.params, activeId: destination.parentId ?? destination.id };
  }
  return undefined;
}

export function destinationHref(destination: Destination, id: string) {
  return destination.path.replace(/:(?:envId|workspaceId)\b/, encodeURIComponent(id));
}
