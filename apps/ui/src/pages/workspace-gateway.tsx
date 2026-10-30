import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { type Environment, unwrap } from "../api/client";
import { apiV2, type Workspace, type WorkspaceService } from "../api/client-v2";
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

/**
 * The path the gateway sends upstream (path_handling v0, its default): the service path and what is left of the
 * request (all of it, or what follows the matched path when stripped) joined with one slash, the request's trailing
 * slash kept. The control plane's kongUpstreamPath, checked against the same recorded samples.
 */
export function upstreamPath(servicePath: string | null | undefined, requestPath: string, stripped: string): string {
  const base = servicePath || "/";
  const postfix = requestPath.slice(stripped.length);
  if (base === "/") return postfix.startsWith("/") ? postfix : `/${postfix}`;
  // The root request leaves the service path as it is; a request stripped whole ends as the request does.
  if (requestPath === "/") return base;
  if (postfix === "") return `${base.replace(/\/+$/, "")}${requestPath.endsWith("/") ? "/" : ""}`;
  if (postfix.startsWith("/")) return base.endsWith("/") ? base + postfix.slice(1) : base + postfix;
  return base.endsWith("/") ? base + postfix : `${base}/${postfix}`;
}

/** What the upstream receives for a request under the route's first path, the service's path included (decision D1). */
export function upstreamEffect(slug: string, path: string, stripPath: boolean, servicePath?: string | null): string {
  const sp = servicePath && servicePath !== "/" ? servicePath : null;
  if (path.startsWith("~")) {
    if (stripPath) return sp ? `O upstream recebe ${sp} seguido do que vier depois do trecho que a expressão casar.` : "O upstream recebe só o que vier depois do trecho que a expressão casar.";
    return sp ? `O upstream recebe ${sp} seguido do path completo, com o prefixo do Workspace.` : "O upstream recebe o path completo, com o prefixo do Workspace.";
  }
  const matched = publicPath(slug, path);
  const request = matched.endsWith("/") ? `${matched}x` : `${matched}/x`;
  return `Uma requisição a ${request} chega ao upstream como ${upstreamPath(servicePath, request, stripPath ? matched : "")}.`;
}

export function useWorkspace(workspaceId: string) {
  return useQuery({
    queryKey: ["workspace", workspaceId],
    queryFn: () => unwrap(apiV2.GET("/workspaces/{workspaceId}", { params: { path: { workspaceId } } })),
  });
}

/** v2 has status; publishMode remains on the v1 environment with the same id. Unknown data forbids writes. */
export function workspaceGatewayAccess(workspace: Pick<Workspace, "status"> | undefined, environment: Pick<Environment, "publishMode"> | undefined) {
  if (workspace?.status === "archived") return {
    canWrite: false,
    reason: "Somente leitura: este Workspace está arquivado. Não é possível criar, editar ou excluir itens do gateway.",
  };
  if (environment?.publishMode === "auto") return {
    canWrite: false,
    reason: "Somente leitura: este Workspace usa publicação automática. Mude o ambiente para publicação manual antes de criar, editar ou excluir itens nesta tela, para evitar publicação automática de exclusões.",
  };
  const canWrite = workspace?.status === "active" && environment?.publishMode === "manual";
  return { canWrite, reason: canWrite ? null : "Somente leitura enquanto verificamos o estado e o modo de publicação do Workspace." };
}

/** Shared with the v2 Routes screen. Cached access cannot authorize writes while its current state is unconfirmed. */
export function useWorkspaceGatewayAccess(workspaceId: string) {
  const workspace = useWorkspace(workspaceId);
  const env = useEnvironment(workspaceId);
  if (workspace.isError || env.isError) return {
    canWrite: false,
    isRevalidating: false,
    reason: "Somente leitura: não foi possível verificar o estado ou o modo de publicação do Workspace. Tente novamente antes de alterar o gateway.",
  };
  const access = workspaceGatewayAccess(workspace.data, env.data);
  if (workspace.fetchStatus !== "idle" || env.fetchStatus !== "idle" || !workspace.data || !env.data) return {
    canWrite: false,
    // Cached permission keeps an open form editable, but cannot authorize its submission.
    isRevalidating: access.canWrite,
    reason: access.reason ?? "Somente leitura enquanto verificamos o estado e o modo de publicação do Workspace.",
  };
  return { ...access, isRevalidating: false };
}

export function useWorkspaceServices(workspaceId: string, q = "") {
  return useInfiniteQuery({
    queryKey: workspaceServicesKey(workspaceId, q),
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

// Two shapes of the same list, under different keys: a page cache ({ pages }) and the whole list (an array).
export const workspaceServicesKey = (workspaceId: string, q: string) => ["ws-services", workspaceId, q] as const;
export const allWorkspaceServicesKey = (workspaceId: string) => ["ws-services-all", workspaceId] as const;

export function useAllWorkspaceServices(workspaceId: string) {
  return useQuery({
    queryKey: allWorkspaceServicesKey(workspaceId),
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
    for (const key of ["ws-services", "ws-services-all", "ws-service", "ws-routes", "ws-route", "services", "routes", "environment", "preview"]) {
      void queryClient.invalidateQueries({ queryKey: [key, workspaceId] });
    }
  };
}

/** The workspace's prefix, its active release, the unpublished draft and why nothing here deploys (N2 gates). */
export function WorkspaceGatewayNote({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspace(workspaceId);
  const env = useEnvironment(workspaceId);
  const access = useWorkspaceGatewayAccess(workspaceId);
  if (workspace.isError) return <p className="error" role="alert">{access.reason} {statusMessage(workspace.error)}</p>;
  if (!workspace.data) return <p className="muted" role="status">{access.reason}</p>;
  const w = workspace.data;
  return (
    <div className="note" role="note" aria-label="Estado do Workspace">
      <p>
        Prefixo público <span className="mono">/{w.slug}</span> · {w.activeRelease == null ? "nenhuma release ativa" : `release ativa v${w.activeRelease}`}
        {env.data && (env.data.hasUnpublishedChanges ? " · há alterações no rascunho ainda não publicadas" : " · rascunho sem alterações pendentes")}.
      </p>
      {access.reason ? <p role="status">{access.reason}</p> : <p>Deployment de Workspaces indisponível nesta fase: o que for criado ou editado aqui fica só no rascunho e não é implantado.</p>}
    </div>
  );
}
