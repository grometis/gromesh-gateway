import type { NavigationContext } from "./context";
import { destinationHref, destinations, resolveDestination } from "./destinations";

const GATEWAY = [
  ["N01", "Visão geral", "Geral"], ["N02", "Serviços", "Serviços"],
  ["N04", "Rotas", "Rotas"], ["N05", "Consumidores", "Consumidores"],
  ["N07", "Plugins", "Plugins"], ["N08", "Upstreams", "Upstreams"],
  ["N09", "Certificados", "Certificados"], ["N10", "Variáveis", "Variáveis"],
] as const;
export interface GatewayDestination {
  id: string;
  label: string;
  shortLabel: string;
  href?: string;
  requirement?: string;
  active: boolean;
}

export function gatewayDestinations(context: NavigationContext | null, pathname: string): GatewayDestination[] {
  if (!context || !("id" in context.route)) return [];
  const { route, state } = context;
  const v2 = route.kind === "workspace-v2";
  if (v2 ? !["authorized", "archived"].includes(state) || context.workspace?.id !== route.id
    : state !== "legacy" || context.environment?.id !== route.id) return [];
  const activeId = resolveDestination(pathname)?.activeId;
  return GATEWAY.map(([baseId, label, shortLabel]) => {
    const id = v2 ? `v2-${baseId}` : baseId;
    const destination = destinations.find((item) => item.id === id);
    return { id, label, shortLabel, active: id === activeId,
      ...(destination ? { href: destinationHref(destination, route.id) } : { requirement: "Disponível no ambiente legado" }) };
  });
}
