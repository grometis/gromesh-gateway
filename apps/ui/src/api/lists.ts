import { useInfiniteQuery } from "@tanstack/react-query";
import { api, unwrap } from "./client";

export function useConsumers(envId: string, q = "") {
  return useInfiniteQuery({
    queryKey: ["consumers", envId, q],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/environments/{envId}/consumers", {
          params: { path: { envId }, query: { ...(q ? { q } : {}), ...(pageParam ? { cursor: pageParam } : {}) } },
        }),
      ),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

export function useRouteList(envId: string) {
  return useInfiniteQuery({
    queryKey: ["routes", envId, "", ""],
    queryFn: ({ pageParam }) =>
      unwrap(api.GET("/environments/{envId}/routes", { params: { path: { envId }, query: pageParam ? { cursor: pageParam } : {} } })),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

export function consumerName(c: { username?: string | null; customId?: string | null; id: string }): string {
  return c.username || c.customId || c.id.slice(0, 8);
}
