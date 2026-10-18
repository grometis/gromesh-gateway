import { useMutation, useQuery } from "@tanstack/react-query";
import { Navigate, NavLink, Outlet, useLocation, useNavigate, useParams } from "react-router";
import { api, unwrap } from "../api/client";
import { statusMessage } from "../api/errors";
import { effectiveRole, useAuth } from "../auth";
import { Brand } from "./Brand";
import { PublishStrip } from "./PublishStrip";

export const environmentsQuery = { queryKey: ["environments"], queryFn: () => unwrap(api.GET("/environments")) };

/** The API lists only the environments the user may see; the UI also leaves out any its session marks as none. */
export function useVisibleEnvironments() {
  const { user } = useAuth();
  return useQuery({ ...environmentsQuery, select: (data) => data.items.filter((e) => effectiveRole(user, e.id) !== "none") });
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

export function RequireAuth() {
  const { user, loading, error } = useAuth();
  const location = useLocation();
  if (loading) return <p className="center muted">Carregando…</p>;
  if (error) return <p className="center error" role="alert">{error}</p>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
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

const GATEWAY = [
  ["services", "Services"],
  ["routes", "Routes"],
  ["consumers", "Consumers"],
  ["plugins", "Plugins"],
  ["upstreams", "Upstreams"],
  ["certificates", "Certificados"],
] as const;
const OPERATION = [
  ["overview", "Visão geral"],
  ["publications", "Publicações"],
  ["clusters", "Clusters"],
  ["metrics", "Métricas"],
  ["requests", "Requisições"],
] as const;

export function Shell() {
  const { envId: routeEnvId } = useParams();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const envs = useVisibleEnvironments();
  const envId = routeEnvId ?? envs.data?.[0]?.id ?? "";
  const signOut = useMutation({ mutationFn: logout });

  const switchEnv = (id: string) => {
    // Keep the current section when switching environments.
    const section = routeEnvId ? location.pathname.split("/")[3] ?? "services" : "services";
    navigate(`/e/${id}/${section}`);
  };

  return (
    <div className="app">
      <aside className="menu">
        <Brand />
        <div className="env">
          <label htmlFor="env-select">Environment</label>
          <select id="env-select" value={envId} onChange={(e) => switchEnv(e.target.value)}>
            {envs.data?.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </div>
        <nav aria-label="Menu principal">
          {envId && (
            <>
              <MenuGroup title="Gateway" items={GATEWAY.map(([path, label]) => [`/e/${envId}/${path}`, label])} />
              <MenuGroup title="Operação" items={OPERATION.map(([path, label]) => [`/e/${envId}/${path}`, label])} />
            </>
          )}
          <MenuGroup
            title="Conta"
            items={[["/tokens", "Tokens de API"], ...(user?.role === "admin" ? ([["/users", "Usuários"], ["/audit", "Auditoria"]] as const) : [])]}
          />
        </nav>
        <div className="account">
          <span className="who">
            {user?.name} · {effectiveRole(user, routeEnvId)}
          </span>
          <button type="button" disabled={signOut.isPending} onClick={() => signOut.mutate()}>
            {signOut.isPending ? "Saindo…" : "Sair"}
          </button>
          {signOut.isError && <p className="error" role="alert">{statusMessage(signOut.error)}</p>}
        </div>
      </aside>
      <main className="content">
        {routeEnvId && <PublishStrip envId={routeEnvId} />}
        <Outlet />
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
