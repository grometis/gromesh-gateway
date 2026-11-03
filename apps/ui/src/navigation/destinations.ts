import { matchPath } from "react-router";

type DestinationId = `N${string}`;
export type NavGroupId = "platform" | "workspace" | "gateway" | "operations" | "administration" | "account";
export interface Destination {
  id: DestinationId;
  label: string;
  shortLabel: string;
  path: string;
  scope: "workspace" | "instance" | "account" | "public";
  group?: NavGroupId;
  parentId?: DestinationId;
  adminOnly?: boolean;
  legacy?: boolean;
}

// N01–N22 refer to the approved C tree. Paths remain the router's existing URLs.
export const destinations: readonly Destination[] = [
  { id: "N01", label: "Visão geral", shortLabel: "Geral", path: "/e/:envId/overview", scope: "workspace", group: "workspace" },
  { id: "N02", label: "Serviços", shortLabel: "Serviços", path: "/e/:envId/services", scope: "workspace", group: "gateway" },
  { id: "N03", label: "Serviço", shortLabel: "Serviço", path: "/e/:envId/services/:serviceId", scope: "workspace", parentId: "N02" },
  { id: "N04", label: "Rotas", shortLabel: "Rotas", path: "/e/:envId/routes", scope: "workspace", group: "gateway" },
  { id: "N05", label: "Consumidores", shortLabel: "Consumidores", path: "/e/:envId/consumers", scope: "workspace", group: "gateway" },
  { id: "N06", label: "Consumidor", shortLabel: "Consumidor", path: "/e/:envId/consumers/:consumerId", scope: "workspace", parentId: "N05" },
  { id: "N07", label: "Plugins", shortLabel: "Plugins", path: "/e/:envId/plugins", scope: "workspace", group: "gateway" },
  { id: "N08", label: "Upstreams", shortLabel: "Upstreams", path: "/e/:envId/upstreams", scope: "workspace", group: "gateway" },
  { id: "N09", label: "Certificados", shortLabel: "Certificados", path: "/e/:envId/certificates", scope: "workspace", group: "gateway" },
  { id: "N10", label: "Variáveis", shortLabel: "Variáveis", path: "/e/:envId/variables", scope: "workspace", group: "gateway" },
  { id: "N11", label: "Releases", shortLabel: "Releases", path: "/e/:envId/releases", scope: "workspace", group: "operations" },
  { id: "N12", label: "Revisar snapshot (legado)", shortLabel: "Revisar snapshot", path: "/e/:envId/publish", scope: "workspace", group: "operations", legacy: true },
  { id: "N13", label: "Snapshots publicados (legado)", shortLabel: "Snapshots publicados", path: "/e/:envId/publications", scope: "workspace", group: "operations", legacy: true },
  { id: "N14", label: "Snapshot", shortLabel: "Snapshot", path: "/e/:envId/publications/:version", scope: "workspace", parentId: "N13", legacy: true },
  { id: "N15", label: "Clusters (legado)", shortLabel: "Clusters", path: "/e/:envId/clusters", scope: "workspace", group: "operations", legacy: true },
  { id: "N16", label: "Métricas", shortLabel: "Métricas", path: "/e/:envId/metrics", scope: "workspace", group: "operations" },
  { id: "N17", label: "Requisições", shortLabel: "Requisições", path: "/e/:envId/requests", scope: "workspace", group: "operations" },
  { id: "N18", label: "Workspaces", shortLabel: "Workspaces", path: "/workspaces", scope: "instance", group: "platform" },
  { id: "N19", label: "Tokens", shortLabel: "Tokens", path: "/tokens", scope: "account", group: "account" },
  { id: "N20", label: "Usuários", shortLabel: "Usuários", path: "/users", scope: "instance", group: "administration", adminOnly: true },
  { id: "N21", label: "Auditoria", shortLabel: "Auditoria", path: "/audit", scope: "instance", group: "administration", adminOnly: true },
  { id: "N22", label: "Entrar", shortLabel: "Entrar", path: "/login", scope: "public" },
];

// Documentation of existing router entries only; this metadata performs no redirects.
export const auxiliaryRoutes = [
  { path: "/", destinationId: undefined },
  { path: "/e/:envId", destinationId: "N02" },
  { path: "/e/:envId/analytics", destinationId: "N16" },
  { path: "*", destinationId: undefined },
] as const;

export function resolveDestination(path: string) {
  const pathname = path.split(/[?#]/, 1)[0]!;
  const direct = destinations.find((item) => matchPath({ path: item.path, end: true }, pathname));
  const alias = direct ? undefined : auxiliaryRoutes.find((item) => item.destinationId && matchPath({ path: item.path, end: true }, pathname));
  const destination = direct ?? destinations.find((item) => item.id === alias?.destinationId);
  if (!destination) return undefined;
  return { destination, activeId: destination.parentId ?? (destination.group ? destination.id : undefined) };
}

export function destinationHref(destination: Destination, envId: string) {
  return destination.path.replace(":envId", encodeURIComponent(envId));
}

/** Presentation preserves the existing global-admin predicate; the server authorizes every request. */
export function visibleDestinations(role: string | undefined, envId: string) {
  return destinations.filter((item) => item.group && (!item.adminOnly || role === "admin") && (item.scope !== "workspace" || !!envId));
}
