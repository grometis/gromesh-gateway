import type { NavigationContext } from "./context";
import { destinationHref, destinations, resolveDestination } from "./destinations";

export interface Breadcrumb { label: string; href?: string }
const labelOf = (destination: (typeof destinations)[number]) => destination.breadcrumbLabel ?? destination.label;

function breadcrumbRouteContext(url: string, context: NavigationContext | null) {
  const match = resolveDestination(url);
  if (!match || !context || !("id" in context.route) || match.destination.scope !== context.route.kind) return undefined;
  const v2 = context.route.kind === "workspace-v2";
  const rawId = match.params[v2 ? "workspaceId" : "envId"];
  let id: string;
  try { id = decodeURIComponent(rawId ?? ""); } catch { return undefined; }
  if (id !== context.route.id) return undefined;
  return { id, v2 };
}

export function confirmedBreadcrumbContext(url: string, context: NavigationContext | null) {
  const route = breadcrumbRouteContext(url, context);
  if (!route || !context) return undefined;
  const { id, v2 } = route;
  const entity = v2 && ["authorized", "archived"].includes(context.state) ? context.workspace
    : !v2 && context.state === "legacy" ? context.environment : undefined;
  return entity?.id === id ? { id, name: entity.name, v2 } : undefined;
}

export function buildBreadcrumbs(url: string, context: NavigationContext | null, detailName?: string): Breadcrumb[] {
  const match = resolveDestination(url);
  if (!match) return [{ label: "Página não encontrada" }];
  const { destination } = match;
  if (!["workspace-v2", "legacy-v1"].includes(destination.scope)) return [{ label: labelOf(destination) }];
  const confirmed = confirmedBreadcrumbContext(url, context);
  const instance = destinations.find((d) => d.id === "instance")!;
  const items: Breadcrumb[] = [{ label: labelOf(instance), href: instance.path }];
  const entryId = destination.scope === "workspace-v2" ? "workspace-entry" : "legacy-entry";
  if (confirmed) {
    const entry = destinations.find((d) => d.id === entryId)!;
    items.push({ label: confirmed.v2 ? confirmed.name : `Ambiente (legado) ${confirmed.name}`, href: destinationHref(entry, confirmed.id) });
  }
  if (destination.id !== entryId) {
    const parent = destination.parentId && destinations.find((d) => d.id === destination.parentId);
    if (parent) items.push({ label: labelOf(parent), ...(confirmed ? { href: destinationHref(parent, confirmed.id) } : {}) });
    items.push({ label: confirmed && detailName ? detailName : labelOf(destination) });
  } else if (!confirmed) items.push({ label: destination.scope === "workspace-v2" ? "Workspace" : "Ambiente (legado)" });
  // The current item is always text, including registered context entry routes.
  delete items.at(-1)!.href;
  return items;
}

export function breadcrumbDetail(url: string, context: NavigationContext | null) {
  const match = resolveDestination(url);
  const confirmed = breadcrumbRouteContext(url, context);
  if (!confirmed || !match?.destination.detailKind) return undefined;
  const kind = match.destination.detailKind;
  const id = match.params[kind === "service" ? "serviceId" : kind === "consumer" ? "consumerId" : "version"]!;
  const queryKey = kind === "service" ? ["ws-service", confirmed.id, id]
    : kind === "consumer" ? [confirmed.v2 ? "ws-consumers" : "consumers", confirmed.id, "detail", id] : ["snapshot", confirmed.id, Number(id)];
  return { kind, id, contextId: confirmed.id, queryKey };
}

export function breadcrumbDetailName(detail: NonNullable<ReturnType<typeof breadcrumbDetail>>, data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const entity = data as Record<string, unknown>;
  if (detail.kind === "snapshot") return entity.version === Number(detail.id) ? `Snapshot v${entity.version}` : undefined;
  if (entity.id !== detail.id || (entity.workspaceId !== undefined && entity.workspaceId !== detail.contextId)) return undefined;
  const name = detail.kind === "service" ? entity.name : entity.username || entity.customId;
  return typeof name === "string" && name.trim() ? name : undefined;
}
