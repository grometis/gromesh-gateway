import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap } from "../api/client";
import { apiV2, type WorkspaceService } from "../api/client-v2";
import { statusMessage } from "../api/errors";
import { useEnvironment } from "../components/Shell";

/** A v2 field may hold a variable reference; shown as `${NAME}`, never resolved here (the value lives per instance). */
export type Plain<T> = T | { $var: string };
export const fieldText = (v: Plain<string | number | null> | undefined): string =>
  v === null || v === undefined ? "" : typeof v === "object" ? `\${${v.$var}}` : String(v);

export function serviceTargetV2(s: WorkspaceService): string {
  return `${fieldText(s.protocol)}://${fieldText(s.host)}:${fieldText(s.port)}${fieldText(s.path)}`;
}

/** The public path of a route path in its workspace: the compiler prefixes it with /<slug> (a regex stays a regex). */
export function publicPath(slug: string, path: string): string {
  return path.startsWith("~") ? `~/${slug}(?:${path.slice(1)})` : `/${slug}${path}`;
}

/** What the upstream receives for a request under the route's first path, in words (decision D1). */
export function upstreamEffect(slug: string, path: string, stripPath: boolean): string {
  if (path.startsWith("~")) {
    return stripPath ? "O upstream recebe só o que vier depois do trecho que a expressão casar." : "O upstream recebe o path completo, com o prefixo do Workspace.";
  }
  const base = publicPath(slug, path).replace(/\/$/, "");
  return stripPath ? `Uma requisição a ${base}/x chega ao upstream como /x.` : `Uma requisição a ${base}/x chega ao upstream como ${base}/x.`;
}

export function useWorkspace(workspaceId: string) {
  return useQuery({
    queryKey: ["workspace", workspaceId],
    queryFn: () => unwrap(apiV2.GET("/workspaces/{workspaceId}", { params: { path: { workspaceId } } })),
  });
}

export function useWorkspaceServices(workspaceId: string, q = "") {
  return useInfiniteQuery({
    queryKey: ["ws-services", workspaceId, q],
    queryFn: ({ pageParam }) => unwrap(apiV2.GET("/workspaces/{workspaceId}/services", {
      params: { path: { workspaceId }, query: { ...(q ? { q } : {}), ...(pageParam ? { cursor: pageParam } : {}) } },
    })),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

/** Every page: a select must offer all of them. */
async function allPages<T>(read: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor?: string | null }>): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await read(cursor);
    out.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return out;
}

export function useAllWorkspaceServices(workspaceId: string) {
  return useQuery({
    queryKey: ["ws-services", workspaceId, "all"],
    queryFn: () => allPages((cursor) => unwrap(apiV2.GET("/workspaces/{workspaceId}/services", {
      params: { path: { workspaceId }, query: { limit: 200, ...(cursor ? { cursor } : {}) } },
    }))),
  });
}

export function useWorkspaceUpstreams(workspaceId: string) {
  return useQuery({
    queryKey: ["ws-upstreams", workspaceId],
    queryFn: () => allPages((cursor) => unwrap(apiV2.GET("/workspaces/{workspaceId}/upstreams", {
      params: { path: { workspaceId }, query: { limit: 200, ...(cursor ? { cursor } : {}) } },
    }))),
  });
}

/** A v2 write changes the draft both APIs read: refresh the v2 lists, the v1 ones (plugins, analytics) and the strip. */
export function useInvalidateWorkspaceGateway(workspaceId: string) {
  const queryClient = useQueryClient();
  return () => {
    for (const key of ["ws-services", "ws-service", "ws-routes", "ws-route", "services", "routes", "environment", "preview"]) {
      void queryClient.invalidateQueries({ queryKey: [key, workspaceId] });
    }
  };
}

/** The workspace's prefix, its active release, the unpublished draft and why nothing here deploys (N2 gates). */
export function WorkspaceGatewayNote({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspace(workspaceId);
  const env = useEnvironment(workspaceId);
  if (workspace.isError) return <p className="error" role="alert">Não foi possível ler o Workspace: {statusMessage(workspace.error)}</p>;
  if (!workspace.data) return null;
  const w = workspace.data;
  return (
    <div className="note" role="note" aria-label="Estado do Workspace">
      <p>
        Prefixo público <span className="mono">/{w.slug}</span> · {w.activeRelease == null ? "nenhuma release ativa" : `release ativa v${w.activeRelease}`}
        {env.data && (env.data.hasUnpublishedChanges ? " · há alterações no rascunho ainda não publicadas" : " · rascunho sem alterações pendentes")}.
      </p>
      <p>Deployment de Workspaces indisponível nesta fase: o que for criado ou editado aqui fica só no rascunho e não é implantado.</p>
    </div>
  );
}
