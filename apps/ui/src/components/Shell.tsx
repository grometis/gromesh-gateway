import { useCallback, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Navigate, Outlet, useLocation, useMatch, useNavigate, useParams } from "react-router";
import { api, ApiError, unwrap } from "../api/client";
import { statusMessage } from "../api/errors";
import { effectiveRole, useAuth } from "../auth";
import { NavigationContextBoundary, useOptionalNavigationContext, useIsWorkspaceRoute } from "../navigation/context";
import { workspaceSections } from "../navigation/destinations";
import { GatewaySidebar } from "./GatewaySidebar";
import { GlobalHeader } from "./GlobalHeader";
import { PublishStrip } from "./PublishStrip";
import { WorkspaceSelector } from "./WorkspaceContext";

export const environmentsQuery = { queryKey: ["environments"], queryFn: () => unwrap(api.GET("/environments")) };

/** The API lists only the environments the user may see; the UI also leaves out any its session marks as none. */
export function useVisibleEnvironments(enabled = true) {
  const { user } = useAuth();
  return useQuery({ ...environmentsQuery, enabled, select: (data) => data.items.filter((e) => effectiveRole(user, e.id) !== "none") });
}

export function useEnvId(): string {
  const { envId } = useParams();
  return envId!;
}

export function useEnvironment(envId: string) {
  return useQuery({
    queryKey: ["environment", envId],
    queryFn: () => unwrap(api.GET("/environments/{envId}", { params: { path: { envId } } })),
  });
}

export function useLegacyEnvironment(envId: string) {
  const v2 = useIsWorkspaceRoute();
  const query = useQuery({
    queryKey: ["environment", envId],
    queryFn: () => unwrap(api.GET("/environments/{envId}", { params: { path: { envId } } })),
    enabled: !v2,
  });
  return { ...query, data: v2 ? undefined : query.data, isSuccess: !v2 && query.isSuccess, isError: !v2 && query.isError };
}

export function RequireAuth() {
  const { user, loading, error } = useAuth();
  const location = useLocation();
  if (loading) return <p className="center muted">Carregando…</p>;
  if (error) return <p className="center error" role="alert">{error}</p>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search + location.hash }} />;
  return <Outlet />;
}

export function RequireAdmin() {
  const { user } = useAuth();
  if (user?.role !== "admin") return <p className="error" role="alert">Você não tem permissão para acessar esta página.</p>;
  return <Outlet />;
}

export function FirstEnvironment() {
  const { user } = useAuth();
  const envs = useVisibleEnvironments();
  if (envs.isPending) return <p className="center muted">Carregando environments…</p>;
  if (envs.isError) return <p className="center error">{statusMessage(envs.error)}</p>;
  const first = envs.data[0];
  if (!first) return user?.role === "admin"
    ? <Navigate to="/users" replace />
    : <p className="center muted">Nenhum environment cadastrado. Peça a um administrador para criar um.</p>;
  return <Navigate to={`/e/${first.id}/services`} replace />;
}

export function Shell() {
  const { envId: routeEnvId, workspaceId } = useParams();
  const context = useOptionalNavigationContext();
  const workspace = context?.workspace;
  const v2Section = useMatch("/workspaces/:workspaceId/:section/*")?.params.section;
  const isReleasesRoute = useMatch("/e/:envId/releases");
  const isAccountRoute = useMatch("/tokens");
  const isWorkspacesRoute = useMatch("/workspaces");
  const workspaceRoute = useMatch("/e/:envId/:section/*");
  const workspaceSection = workspaceRoute?.params.section?.toLowerCase();
  const hasWorkspaceSelector = !!workspaceId || !!isWorkspacesRoute || ["services", "routes", "variables", "plugins", "releases"].includes(workspaceSection ?? "");
  const navigate = useNavigate();
  const location = useLocation();
  const envs = useVisibleEnvironments(!!routeEnvId);
  const validRoute = envs.isSuccess && envs.data.some((e) => e.id === routeEnvId);
  const contextMessage = envs.isPending ? "Carregando ambientes legados…"
    : envs.isError ? envs.error instanceof ApiError && envs.error.status === 403
      ? "Sem permissão para listar ambientes legados."
      : "Não foi possível carregar os ambientes legados."
    : envs.data.length === 0 ? "Nenhum ambiente legado disponível."
    : !validRoute ? "Ambiente legado indisponível para esta URL." : null;
  const main = useRef<HTMLElement>(null);
  const focusContent = useCallback(() => { main.current?.focus(); }, []);
  useEffect(focusContent, [location, focusContent]);

  const switchEnv = (id: string) => {
    if (!envs.isSuccess || !envs.data.some((e) => e.id === id)) return;
    // Keep the current section when switching environments.
    const section = routeEnvId ? location.pathname.split("/")[3] ?? "services" : "services";
    navigate(`/e/${id}/${section}`);
  };

  const selectors = <>
    {hasWorkspaceSelector && <WorkspaceSelector id={workspaceId} workspace={workspace} onSelect={(id) => navigate(`/workspaces/${encodeURIComponent(id)}/${workspaceSections.some((s) => s === (v2Section ?? workspaceSection)) ? v2Section ?? workspaceSection : "services"}`)} />}
    {routeEnvId && <div className="env">
      <label htmlFor="env-select">Ambiente (legado)</label>
      <select id="env-select" value={validRoute ? routeEnvId : ""} disabled={!envs.isSuccess || envs.data.length === 0} aria-describedby={contextMessage ? "env-context-message" : undefined} onChange={(e) => switchEnv(e.target.value)}>
        {!validRoute && <option value="" disabled>Selecione um ambiente legado</option>}
        {envs.isSuccess && envs.data.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
      </select>
      {contextMessage && <p id="env-context-message" role={envs.isError ? "alert" : "status"}>{contextMessage}</p>}
    </div>}
  </>;
  const hasGateway = context?.workspace && ["authorized", "archived"].includes(context.state) || context?.state === "legacy" && context.environment;

  return (
    <div className="app">
      <a className="skip-link" href="#main-content">Pular para o conteúdo</a>
      <GlobalHeader />
      {hasGateway && context && <GatewaySidebar key={`${context.route.kind}/${"id" in context.route ? context.route.id : ""}`} context={context} selectors={selectors} focusContent={focusContent} />}
      <main className="content" id="main-content" tabIndex={-1} ref={main}>
        {!hasGateway && (workspaceId || routeEnvId || isWorkspacesRoute) && <div className="context-selection">{selectors}</div>}
        {!workspaceId && !routeEnvId && <p className="global-context">{isAccountRoute ? "Escopo: minha conta nesta instância" : "Escopo: esta instância"}</p>}
        {context ? <NavigationContextBoundary>
          {routeEnvId && !isReleasesRoute && <PublishStrip envId={routeEnvId} />}
          <Outlet key={"id" in context.route ? `${context.route.kind}/${context.route.id}` : context.route.kind} />
        </NavigationContextBoundary> : <>
          {routeEnvId && !isReleasesRoute && <PublishStrip envId={routeEnvId} />}
          <Outlet />
        </>}
      </main>
    </div>
  );
}

