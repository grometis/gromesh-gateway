import { describe, expect, it } from "vitest";
import { gatewayDestinations } from "./gateway-destinations";
import type { NavigationContext } from "./context";

const workspace = { id: "W", key: "W", name: "Pedidos", slug: "pedidos", status: "active" as const, activeRelease: null };
const v2: NavigationContext = { route: { kind: "workspace-v2", id: "W" }, state: "authorized", workspace };
const v1: NavigationContext = { route: { kind: "legacy-v1", id: "E" }, state: "legacy", environment: { id: "E", name: "Legado" } as NonNullable<NavigationContext["environment"]> };
describe("Gateway destinations", () => {
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
