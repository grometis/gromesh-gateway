import { describe, expect, it } from "vitest";
import { gatewayDestinations } from "./gateway-destinations";
import type { NavigationContext } from "./context";
import { destinations, type Destination } from "./destinations";

const workspace = { id: "W", key: "W", name: "Pedidos", slug: "pedidos", status: "active" as const, activeRelease: null };
const v2: NavigationContext = { route: { kind: "workspace-v2", id: "W" }, state: "authorized", workspace };
const v1: NavigationContext = { route: { kind: "legacy-v1", id: "E" }, state: "legacy", environment: { id: "E", name: "Legado" } as NonNullable<NavigationContext["environment"]> };
describe("Gateway destinations", () => {
  it.each([
    ["overview", "Visão geral"], ["consumers", "Consumidores"],
    ["upstreams", "Upstreams"], ["certificates", "Certificados"],
  ])("activates %s from a registered v2 destination regardless of its id", (section, label) => {
    const catalog: readonly Destination[] = [...destinations, {
      id: `workspace-${section}`, label, path: `/workspaces/:workspaceId/${section}`, scope: "workspace-v2",
    }];
    for (const context of [v2, { ...v2, state: "archived" as const }]) {
      const item = gatewayDestinations(context, `/workspaces/W/${section}?x=1#y`, catalog).find((item) => item.label === label);
      expect(item).toEqual({ id: `workspace-${section}`, label, shortLabel: section === "overview" ? "Geral" : label,
        href: `/workspaces/W/${section}`, active: true });
      expect(gatewayDestinations({ ...context, route: { kind: "workspace-v2", id: "a/b?#" }, workspace: { ...workspace, id: "a/b?#" } }, "", catalog)
        .find((item) => item.label === label)?.href).toBe(`/workspaces/a%2Fb%3F%23/${section}`);
    }
    expect(gatewayDestinations(v2, `/workspaces/W/${section}`).find((item) => item.label === label))
      .toMatchObject({ requirement: "Disponível no ambiente legado", active: false });
    expect(gatewayDestinations(v1, `/e/E/${section}`, catalog).find((item) => item.label === label)?.href).toBe(`/e/E/${section}`);
  });
  it("selects the registered v2 consumer list as the detail's active parent", () => {
    const catalog: readonly Destination[] = [...destinations,
      { id: "workspace-consumers", label: "Consumidores", path: "/workspaces/:workspaceId/consumers", scope: "workspace-v2" },
      { id: "workspace-consumer", label: "Consumidor", path: "/workspaces/:workspaceId/consumers/:consumerId", scope: "workspace-v2", parentId: "workspace-consumers" },
    ];
    expect(gatewayDestinations(v2, "/workspaces/W/consumers/C", catalog).filter((item) => item.active))
      .toEqual([{ id: "workspace-consumers", label: "Consumidores", shortLabel: "Consumidores", href: "/workspaces/W/consumers", active: true }]);
  });
  it("does not activate a missing v2 list from a detail, another scope, or a reused legacy id", () => {
    const catalog: readonly Destination[] = [...destinations,
      { id: "v2-N05", label: "Consumidores", path: "/e/:envId/consumers", scope: "legacy-v1" },
      { id: "workspace-consumer", label: "Consumidor", path: "/workspaces/:workspaceId/consumers/:consumerId", scope: "workspace-v2", parentId: "v2-N05" },
    ];
    const item = gatewayDestinations(v2, "/workspaces/W/consumers/C", catalog).find((item) => item.label === "Consumidores");
    expect(item?.href).toBeUndefined();
    expect(item?.requirement).toBe("Disponível no ambiente legado");
    expect(item?.active).toBe(false);
  });
  it("exposes only real v2 routes with explicit unavailable legacy destinations", () => {
    const items = gatewayDestinations(v2, "/workspaces/W/services/S");
    expect(items.map((i) => i.label)).toEqual(["Visão geral", "Serviços", "Rotas", "Consumidores", "Plugins", "Upstreams", "Certificados", "Variáveis"]);
    expect(items.filter((i) => i.href).map((i) => i.href)).toEqual(["/workspaces/W/services", "/workspaces/W/routes", "/workspaces/W/plugins", "/workspaces/W/variables"]);
    expect(items.filter((i) => !i.href).every((i) => i.requirement === "Disponível no ambiente legado")).toBe(true);
    expect(items.filter((i) => i.active).map((i) => i.label)).toEqual(["Serviços"]);
  });
  it("keeps eight real legacy links and the consumer detail ancestor", () => {
    const items = gatewayDestinations(v1, "/e/E/consumers/C?x=1#y");
    expect(items).toHaveLength(8);
    expect(items.every((i) => i.href?.startsWith("/e/E/"))).toBe(true);
    expect(items[0]?.href).toBe("/e/E/overview");
    expect(items.filter((i) => i.active).map((i) => i.label)).toEqual(["Consumidores"]);
    expect(gatewayDestinations(v1, "/e/E/services/S").filter((i) => i.active).map((i) => i.label)).toEqual(["Serviços"]);
  });
  it.each(["loading", "forbidden", "not-found", "error", "expired"] as const)("discards stale data in %s state", (state) => {
    expect(gatewayDestinations({ ...v2, state }, "/workspaces/W/services")).toEqual([]);
  });
  it("keeps archived reading, without selecting Gateway on Releases", () => {
    expect(gatewayDestinations({ ...v2, state: "archived" }, "/workspaces/W/releases").filter((i) => i.active)).toEqual([]);
    expect(gatewayDestinations({ ...v2, state: "archived" }, "/workspaces/W/services").filter((i) => i.href)).toHaveLength(4);
  });
  it.each(["global", "admin", "account", "unknown"] as const)("has no sidebar destinations for %s", (kind) => {
    expect(gatewayDestinations({ route: { kind }, state: "none" }, "/tokens")).toEqual([]);
  });
  it("does not authorize a mismatched context id", () => {
    expect(gatewayDestinations({ ...v2, route: { kind: "workspace-v2", id: "other" } }, "/workspaces/other/services")).toEqual([]);
  });
});
