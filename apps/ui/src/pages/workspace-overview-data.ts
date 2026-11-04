import { apiV2 } from "../api/client-v2";
import { unwrap } from "../api/client";

export const inventoryResources = [
  { section: "services", label: "Serviços", path: "/workspaces/{workspaceId}/services" },
  { section: "routes", label: "Rotas", path: "/workspaces/{workspaceId}/routes" },
  { section: "consumers", label: "Consumidores", path: "/workspaces/{workspaceId}/consumers" },
  { section: "plugins", label: "Plugins", path: "/workspaces/{workspaceId}/plugins" },
  { section: "upstreams", label: "Upstreams", path: "/workspaces/{workspaceId}/upstreams" },
  { section: "certificates", label: "Certificados", path: "/workspaces/{workspaceId}/certificates" },
  { section: "variables", label: "Variáveis", path: "/workspaces/{workspaceId}/variables" },
] as const;

export function inventoryQuery(workspaceId: string, resource: typeof inventoryResources[number]) {
  return {
    // This projection must not collide with full lists or infinite-page caches.
    queryKey: ["ws-overview-inventory", workspaceId, resource.section] as const,
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      if (resource.section === "variables") {
        const items = await unwrap(apiV2.GET(resource.path, { params: { path: { workspaceId } }, signal }));
        return { count: items.length, partial: false };
      }
      const page = await unwrap(apiV2.GET(resource.path, { params: { path: { workspaceId }, query: { limit: 200 } }, signal }));
      // Discard entity payloads before they reach the query cache (including secret-bearing fields).
      return { count: page.items.length, partial: Boolean(page.nextCursor) };
    },
    retry: false,
    refetchOnWindowFocus: false,
  };
}
