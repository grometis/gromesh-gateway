import { useMutation, useQuery } from "@tanstack/react-query";
import { Navigate, NavLink, Outlet, useLocation, useMatch, useNavigate, useParams } from "react-router";
import { api, ApiError, unwrap } from "../api/client";
import { statusMessage } from "../api/errors";
import { effectiveRole, useAuth } from "../auth";
import { NavigationContextBoundary, useOptionalNavigationContext, useIsWorkspaceRoute } from "../navigation/context";
import { workspaceSections } from "../navigation/destinations";
import { Brand } from "./Brand";
import { PublishStrip } from "./PublishStrip";
import { InstanceContext } from "./InstanceContext";
import { WorkspaceContext, WorkspaceSelector } from "./WorkspaceContext";

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

const ROLE_LABELS = { viewer: "Leitor", editor: "Editor", admin: "Administrador", none: "Sem acesso" } as const;

const GATEWAY = [
  ["services", "Services"],
  ["routes", "Routes"],
  ["variables", "Variáveis"],
  ["consumers", "Consumers"],
  ["plugins", "Plugins"],
  ["upstreams", "Upstreams"],
  ["certificates", "Certificados"],
  ["releases", "Releases"],
] as const;
const OPERATION = [
  ["overview", "Visão geral"],
  ["publications", "Publicações"],
  ["clusters", "Clusters"],
  ["metrics", "Métricas"],
  ["requests", "Requisições"],
] as const;

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
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const envs = useVisibleEnvironments(!workspaceId);
  const validRoute = envs.isSuccess && envs.data.some((e) => e.id === routeEnvId);
  const envId = validRoute ? routeEnvId! : "";
  const contextMessage = envs.isPending ? "Carregando ambientes legados…"
    : envs.isError ? envs.error instanceof ApiError && envs.error.status === 403
      ? "Sem permissão para listar ambientes legados."
      : "Não foi possível carregar os ambientes legados."
    : envs.data.length === 0 ? "Nenhum ambiente legado disponível."
    : !validRoute ? "Ambiente legado indisponível para esta URL." : null;
  const legacyRole = effectiveRole(user, routeEnvId);
  const signOut = useMutation({ mutationFn: logout });

  const switchEnv = (id: string) => {
    if (!envs.isSuccess || !envs.data.some((e) => e.id === id)) return;
    // Keep the current section when switching environments.
    const section = routeEnvId ? location.pathname.split("/")[3] ?? "services" : "services";
    navigate(`/e/${id}/${section}`);
  };

  return (
    <div className="app">
      <aside className="menu">
        <Brand />
        <InstanceContext />
        {hasWorkspaceSelector && <WorkspaceSelector id={workspaceId ?? routeEnvId} workspace={workspace} onSelect={(id) => navigate(routeEnvId ? `/e/${id}/${workspaceSection ?? "services"}` : `/workspaces/${encodeURIComponent(id)}/${workspaceSections.some((s) => s === v2Section) ? v2Section : "services"}`)} />}
        {workspace && <p className="workspace-context" role="status">Workspace v2: {workspace.name} · /{workspace.slug} · {workspace.status === "archived" ? "arquivado · somente leitura" : "ativo"}</p>}
        {routeEnvId ? (
          <div className="env">
            <label htmlFor="env-select">Ambiente (legado)</label>
            <select id="env-select" value={validRoute ? routeEnvId : ""} disabled={!envs.isSuccess || envs.data.length === 0} aria-describedby={contextMessage ? "env-context-message" : undefined} onChange={(e) => switchEnv(e.target.value)}>
              {!validRoute && <option value="" disabled>Selecione um ambiente legado</option>}
              {envs.isSuccess && envs.data.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
            {contextMessage && <p id="env-context-message" role={envs.isError ? "alert" : "status"}>{contextMessage}</p>}
            {validRoute && <WorkspaceContext key={routeEnvId} id={routeEnvId} />}
          </div>
        ) : !workspaceId && (
          <div className="global-context">
            <p>{isAccountRoute ? "Escopo: minha conta nesta instância" : "Escopo: esta instância"}</p>
          </div>
        )}
        <nav aria-label="Menu principal">
          {workspace && <MenuGroup title="Gateway" items={GATEWAY.filter(([path]) => workspaceSections.some((s) => s === path)).map(([path, label]) => [`/workspaces/${encodeURIComponent(workspace.id)}/${path}`, label])} />}
          {envId && (
            <>
              <MenuGroup title="Gateway" items={GATEWAY.map(([path, label]) => [`/e/${envId}/${path}`, label])} />
              <MenuGroup title="Operação" items={OPERATION.map(([path, label]) => [`/e/${envId}/${path}`, label])} />
            </>
          )}
          <MenuGroup title="Instância" items={[["/workspaces", "Workspaces"]]} />
          <MenuGroup
            title="Conta"
            items={[["/tokens", "Tokens de API"], ...(user?.role === "admin" ? ([["/users", "Usuários"], ["/audit", "Auditoria"]] as const) : [])]}
          />
        </nav>
        <div className="account">
          <span className="who">
            {user?.name} · Papel legado: {legacyRole ? ROLE_LABELS[legacyRole] : "Não informado"}
          </span>
          <button type="button" disabled={signOut.isPending} onClick={() => signOut.mutate()}>
            {signOut.isPending ? "Saindo…" : "Sair"}
          </button>
          {signOut.isError && <p className="error" role="alert">{statusMessage(signOut.error)}</p>}
        </div>
      </aside>
      <main className="content">
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

function MenuGroup({ title, items }: { title: string; items: readonly (readonly [string, string])[] }) {
  return (
    <div className="menu-group">
      <h2>{title}</h2>
      {items.map(([to, label]) => (
        <NavLink key={to} to={to}>
          {label}
        </NavLink>
      ))}
    </div>
  );
}
