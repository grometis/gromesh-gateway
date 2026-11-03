import type { NavigationContext } from "./context";
import { destinationHref, destinations, resolveDestination } from "./destinations";

export type GlobalSection = "operations" | "instance" | "account";
export interface GlobalDestination {
  id: string;
  label: string;
  href?: string;
  requirement?: string;
  active: boolean;
  legacy?: boolean;
}

// PR-C can add "instance" here once / renders the instance overview instead of redirecting.
const INSTANCE_IDS = ["N18", "N20", "N21"];
const OPERATIONS = ["N17", "N16", "N12", "N13", "N15"];

export function globalDestinations(section: GlobalSection, context: NavigationContext | null, role: string | undefined, pathname: string): GlobalDestination[] {
  const releasesId = context?.route.kind === "legacy-v1" ? "N11" : "v2-N11";
  const ids = section === "operations" ? [releasesId, ...OPERATIONS] : section === "instance" ? INSTANCE_IDS : ["N19"];
  const activeId = resolveDestination(pathname)?.activeId;
  return ids.flatMap((id) => {
    const item = destinations.find((destination) => destination.id === id)!;
    if (item.adminOnly && role !== "admin") return [];
    const v2 = item.scope === "workspace-v2";
    const v1 = item.scope === "legacy-v1";
    const confirmedId = v2 && context?.route.kind === "workspace-v2" && (context.state === "authorized" || context.state === "archived")
      ? context.workspace?.id
      : v1 && context?.route.kind === "legacy-v1" && context.state === "legacy" ? context.environment?.id : undefined;
    const requirement = (v1 || v2) && !confirmedId
      ? id === releasesId && context?.route.kind !== "legacy-v1" && context?.route.kind !== "workspace-v2"
        ? "Requer Workspace ou ambiente legado" : v2 ? "Requer Workspace" : "Requer ambiente legado"
      : undefined;
    return [{ id, label: id === "N12" ? "Revisar snapshot" : id === "N13" ? "Publicações" : item.label,
      href: requirement ? undefined : confirmedId ? destinationHref(item, confirmedId) : item.path,
      requirement, active: id === activeId, legacy: ["N12", "N13", "N15"].includes(id) }];
  });
}
