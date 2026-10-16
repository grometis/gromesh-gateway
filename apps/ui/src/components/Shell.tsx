import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Navigate, NavLink, Outlet, useLocation, useNavigate, useParams } from "react-router";
import { api, unwrap } from "../api/client";
import { statusMessage } from "../api/errors";
import { useAuth, useCanEdit } from "../auth";
import { PublishModal } from "./PublishModal";

export const environmentsQuery = { queryKey: ["environments"], queryFn: () => unwrap(api.GET("/environments")) };

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
  const envs = useQuery(environmentsQuery);
  if (envs.isPending) return <p className="center muted">Carregando environments…</p>;
  if (envs.isError) return <p className="center error">{statusMessage(envs.error)}</p>;
  const first = envs.data.items[0];
  if (!first) return user?.role === "admin"
    ? <Navigate to="/users" replace />
    : <p className="center muted">Nenhum environment cadastrado. Peça a um administrador para criar um.</p>;
  return <Navigate to={`/e/${first.id}/services`} replace />;
}

const MENU = [
  ["services", "Services"],
  ["routes", "Routes"],
  ["consumers", "Consumers"],
  ["plugins", "Plugins"],
  ["publications", "Publicações"],
  ["clusters", "Clusters"],
  ["analytics", "Dashboard"],
  ["requests", "Requisições"],
] as const;

export function Shell() {
  const { envId: routeEnvId } = useParams();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const envs = useQuery(environmentsQuery);
  const envId = routeEnvId ?? envs.data?.items[0]?.id ?? "";
  const signOut = useMutation({ mutationFn: logout });

  const switchEnv = (id: string) => {
    // Keep the current section when switching environments.
    const section = routeEnvId ? location.pathname.split("/")[3] ?? "services" : "services";
    navigate(`/e/${id}/${section}`);
  };

  return (
    <div className="app">
      <header className="topbar">
        <strong className="brand">Gromesh Gateway</strong>
        <label className="env-select">
          <span>Environment</span>
          <select value={envId} onChange={(e) => switchEnv(e.target.value)} aria-label="Environment">
            {envs.data?.items.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </label>
        <span className="spacer" />
        <span className="muted">
          {user?.name} ({user?.role})
        </span>
        <button type="button" disabled={signOut.isPending} onClick={() => signOut.mutate()}>
          {signOut.isPending ? "Saindo…" : "Sair"}
        </button>
        {signOut.isError && <p className="error" role="alert">{statusMessage(signOut.error)}</p>}
      </header>
      <nav className="sidebar" aria-label="Menu principal">
        {envId && MENU.map(([path, label]) => (
          <NavLink key={path} to={`/e/${envId}/${path}`}>
            {label}
          </NavLink>
        ))}
        {user?.role === "admin" && (
          <>
            <NavLink to="/users">Usuários</NavLink>
            <NavLink to="/audit">Auditoria</NavLink>
          </>
        )}
      </nav>
      <main className="content">
        {routeEnvId && <UnpublishedBar envId={routeEnvId} />}
        <Outlet />
      </main>
    </div>
  );
}

function UnpublishedBar({ envId }: { envId: string }) {
  const env = useEnvironment(envId);
  const canEdit = useCanEdit();
  const [open, setOpen] = useState(false);
  const pending = env.data?.hasUnpublishedChanges ?? false;
  const preview = useQuery({
    queryKey: ["preview", envId],
    queryFn: () => unwrap(api.GET("/environments/{envId}/publish-preview", { params: { path: { envId } } })),
    enabled: pending,
  });
  if (!pending) return null;
  const count = preview.data?.changes.length;
  return (
    <div className="unpublished" role="status">
      <span>
        {count === undefined ? "Há alterações não publicadas" : `${count} ${count === 1 ? "alteração não publicada" : "alterações não publicadas"}`}
        {env.data?.currentVersion ? ` (versão publicada: ${env.data.currentVersion})` : ""}
      </span>
      {canEdit && (
        <button type="button" className="primary" onClick={() => setOpen(true)}>
          Publicar
        </button>
      )}
      {open && env.data && <PublishModal env={env.data} onClose={() => setOpen(false)} />}
    </div>
  );
}
