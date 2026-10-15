import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
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
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <p className="center muted">Carregando…</p>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}

export function FirstEnvironment() {
  const envs = useQuery(environmentsQuery);
  if (envs.isPending) return <p className="center muted">Carregando environments…</p>;
  if (envs.isError) return <p className="center error">{statusMessage(envs.error)}</p>;
  const first = envs.data.items[0];
  if (!first) return <p className="center muted">Nenhum environment cadastrado. Peça a um administrador para criar um.</p>;
  return <Navigate to={`/e/${first.id}/services`} replace />;
}

const MENU = [
  ["services", "Services"],
  ["routes", "Routes"],
  ["consumers", "Consumers"],
  ["plugins", "Plugins"],
  ["publications", "Publicações"],
  ["clusters", "Clusters"],
] as const;

export function Shell() {
  const envId = useEnvId();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const envs = useQuery(environmentsQuery);

  const switchEnv = (id: string) => {
    // Keep the current section when switching environments.
    const section = location.pathname.split("/")[3] ?? "services";
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
        <button type="button" onClick={logout}>
          Sair
        </button>
      </header>
      <nav className="sidebar" aria-label="Menu principal">
        {MENU.map(([path, label]) => (
          <NavLink key={path} to={path}>
            {label}
          </NavLink>
        ))}
      </nav>
      <main className="content">
        <UnpublishedBar envId={envId} />
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
