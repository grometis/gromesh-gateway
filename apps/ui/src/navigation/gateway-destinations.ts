import type { NavigationContext } from "./context";
import { destinationHref, destinations, gatewaySections, resolveDestination, type Destination } from "./destinations";
export interface GatewayDestination {
  id: string;
  label: string;
  shortLabel: string;
  href?: string;
  requirement?: string;
  active: boolean;
}

export function gatewayDestinations(context: NavigationContext | null, pathname: string, catalog: readonly Destination[] = destinations): GatewayDestination[] {
  if (!context || !("id" in context.route)) return [];
  const { route, state } = context;
  const v2 = route.kind === "workspace-v2";
  if (v2 ? !["authorized", "archived"].includes(state) || context.workspace?.id !== route.id
    : state !== "legacy" || context.environment?.id !== route.id) return [];
  const activeId = resolveDestination(pathname, catalog)?.activeId;
  return gatewaySections.map(([section, baseId, label, shortLabel]) => {
    const path = v2 ? `/workspaces/:workspaceId/${section}` : `/e/:envId/${section}`;
    const destination = catalog.find((item) => item.scope === route.kind && item.path === path);
    const id = destination?.id ?? (v2 ? `v2-${baseId}` : baseId);
    return { id, label, shortLabel, active: !!destination && id === activeId,
      ...(destination ? { href: destinationHref(destination, route.id) } : { requirement: "Disponível no ambiente legado" }) };
  });
}
