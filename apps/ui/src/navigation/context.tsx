import { createContext, useContext, useRef, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useLocation, useParams } from "react-router";
import { api, ApiError, unwrap, type Environment } from "../api/client";
import { apiV2, type Workspace } from "../api/client-v2";
import { resolveDestination } from "./destinations";

export type RouteContext = { kind: "unknown" | "global" | "admin" | "account" }
  | { kind: "workspace-v2" | "legacy-v1"; id: string };

/** Classifies only registered paths. Query/hash are never rewritten or used as authority. */
export function classifyRoute(url: string): RouteContext {
  const match = resolveDestination(url);
  if (!match) return { kind: "unknown" };
  const kind = match.destination.scope;
  if (kind !== "workspace-v2" && kind !== "legacy-v1") return { kind };
  const raw = match.params[kind === "workspace-v2" ? "workspaceId" : "envId"]!;
  try { return { kind, id: decodeURIComponent(raw) }; } catch { return { kind: "unknown" }; }
}

export const workspaceQuery = (workspaceId: string) => ({
  queryKey: ["workspace", workspaceId],
  queryFn: ({ signal }: { signal: AbortSignal }) => unwrap(apiV2.GET("/workspaces/{workspaceId}", { params: { path: { workspaceId } }, signal })),
});

export type NavigationContext = {
  route: RouteContext;
  state: "none" | "loading" | "authorized" | "archived" | "legacy" | "not-found" | "forbidden" | "error" | "expired" | "unknown";
  workspace?: Workspace;
  environment?: Environment;
  /** Legacy pages already handle unavailable metadata and gate every write independently. */
  legacyReadAvailable?: boolean;
  retry?: () => void;
};
const Context = createContext<NavigationContext | null>(null);
export const useOptionalNavigationContext = () => useContext(Context);
export function useNavigationContext() {
  const context = useOptionalNavigationContext();
  if (!context) throw new Error("useNavigationContext outside NavigationContextProvider");
  return context;
}

/** Parameter adapter only: a legacy environment ID never establishes a v2 navigation context. */
export function useWorkspaceId(): string {
  const { workspaceId, envId } = useParams();
  return (workspaceId ?? envId)!;
}
export function useIsWorkspaceRoute() { return !!useParams().workspaceId; }

function ResolveContext({ route, children }: { route: Extract<RouteContext, { id: string }>; children: ReactNode }) {
  const v2 = route.kind === "workspace-v2";
  const authorizedWorkspace = useRef<Workspace | undefined>(undefined);
  const accessRefused = useRef(false);
  const query = useQuery({
    queryKey: v2 ? workspaceQuery(route.id).queryKey : ["environment", route.id],
    queryFn: ({ signal }): Promise<Workspace | Environment> => v2
      ? workspaceQuery(route.id).queryFn({ signal })
      : unwrap(api.GET("/environments/{envId}", { params: { path: { envId: route.id } }, signal })),
    retry: false,
    // Each entry, including back/forward to a cached ID, must establish access again.
    refetchOnMount: "always",
    staleTime: Infinity,
  });
  let value: NavigationContext = { route, state: "loading", legacyReadAvailable: !v2 && !accessRefused.current, retry: () => { void query.refetch(); } };
  // Authorization belongs to this mounted ID, not to a cached result from a previous visit.
  // Background refreshes preserve the page; write gates still inspect the live query state.
  if (v2 && authorizedWorkspace.current) value = { ...value,
    state: authorizedWorkspace.current.status === "archived" ? "archived" : "authorized", workspace: authorizedWorkspace.current };
  if (query.isError) {
    const status = query.error instanceof ApiError ? query.error.status : undefined;
    const transient = query.error instanceof TypeError || (status !== undefined && status >= 500);
    if (!transient) {
      authorizedWorkspace.current = undefined;
      accessRefused.current = true;
    }
    if (!v2 || !transient || !authorizedWorkspace.current) value = { ...value,
      state: status === 401 ? "expired" : status === 403 ? "forbidden" : status === 404 ? "not-found" : "error",
      workspace: undefined, legacyReadAvailable: !v2 && transient && !accessRefused.current };
  } else if (query.isFetchedAfterMount && !query.isFetching && query.isSuccess) {
    if (query.data?.id !== route.id || (v2 && !["active", "archived"].includes((query.data as Workspace).status))) {
      authorizedWorkspace.current = undefined;
      accessRefused.current = true;
      return <Context.Provider value={{ ...value, workspace: undefined, state: "error", legacyReadAvailable: false }}>{children}</Context.Provider>;
    }
    accessRefused.current = false;
    if (v2) authorizedWorkspace.current = query.data as Workspace;
    value = v2
      ? { ...value, state: (query.data as Workspace).status === "archived" ? "archived" : "authorized", workspace: query.data as Workspace }
      : { ...value, state: "legacy", environment: query.data as Environment };
  }
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function NavigationContextProvider({ children }: { children?: ReactNode }) {
  const { pathname } = useLocation();
  const route = classifyRoute(pathname);
  const content = children ?? <Outlet />;
  if ("id" in route) return <ResolveContext key={`${route.kind}/${route.id}`} route={route}>{content}</ResolveContext>;
  return <Context.Provider value={{ route, state: route.kind === "unknown" ? "unknown" : "none" }}>{content}</Context.Provider>;
}

const messages: Partial<Record<NavigationContext["state"], string>> = {
  loading: "Verificando contexto…", "not-found": "Não encontrado ou indisponível para sua conta.",
  forbidden: "Você não tem permissão para acessar este contexto.", error: "Não foi possível verificar o contexto. Tente novamente.",
  expired: "Sua sessão expirou. Entre novamente.", unknown: "Rota não encontrada.",
};
export function NavigationContextBoundary({ children, fallbackNavigation }: { children?: ReactNode; fallbackNavigation?: ReactNode }) {
  const context = useNavigationContext();
  if (context.legacyReadAvailable) return children ?? <Outlet />;
  const message = messages[context.state];
  if (message) return <>{fallbackNavigation}<section className="stack" aria-label="Contexto de navegação">
    <h1>{context.route.kind === "workspace-v2" ? "Workspace" : context.route.kind === "legacy-v1" ? "Ambiente legado" : "Navegação"}</h1>
    <p role={context.state === "loading" ? "status" : "alert"}>{message}</p>
    {context.state === "error" && <button type="button" onClick={context.retry}>Tentar novamente</button>}
    <Link className="back-link" to="/workspaces">Ver Workspaces</Link>
  </section></>;
  return children ?? <Outlet />;
}

