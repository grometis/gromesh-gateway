import { useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { ApiError } from "../api/client";
import type { Workspace } from "../api/client-v2";
import { effectiveRole, useAuth } from "../auth";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { PageHeader } from "../components/PageHeader";
import { useNavigationContext } from "../navigation/context";
import { destinationHref, destinations } from "../navigation/destinations";
import { releasesQuery } from "./Releases";
import { inventoryQuery, inventoryResources } from "./workspace-overview-data";
import { useWorkspace } from "./workspace-gateway";

function resourceHref(workspaceId: string, section: string) {
  const destination = destinations.find(item => item.scope === "workspace-v2" && item.path === `/workspaces/:workspaceId/${section}`);
  return destination ? destinationHref(destination, workspaceId) : undefined;
}

export function WorkspaceOverviewPage() {
  const { workspace } = useNavigationContext();
  return workspace ? <WorkspaceOverview key={workspace.id} workspace={workspace} /> : null;
}

function WorkspaceOverview({ workspace }: { workspace: Workspace }) {
  const { state } = useNavigationContext();
  const { user } = useAuth();
  const workspaceId = workspace.id;
  const queries = useQueries({ queries: inventoryResources.map(resource => inventoryQuery(workspaceId, resource)) });
  const contextQuery = useWorkspace(workspaceId);
  const [showReleases, setShowReleases] = useState(false);
  const role = effectiveRole(user, workspaceId);
  const knownWritePermission = role === "editor" || role === "admin";
  // Known legacy grants are a lower bound; /me does not expose additional effective v2 bindings.
  const canOfferWrite = state === "authorized" && contextQuery.isSuccess && contextQuery.fetchStatus === "idle"
    && knownWritePermission;
  const servicesHref = resourceHref(workspaceId, "services");
  const routesHref = resourceHref(workspaceId, "routes");
  const releasesHref = resourceHref(workspaceId, "releases");
  const release = workspace.activeRelease;
  const releaseText = release === null ? "Nenhuma Release selecionada"
    : typeof release === "number" ? `Release selecionada v${release}` : "Estado da Release não informado";
  const attention = [
    ...(workspace.status === "archived" ? ["Workspace arquivado. Somente leitura."] : []),
    ...(release === null ? ["Nenhuma Release selecionada. Consulte as Releases para revisar o conteúdo disponível."] : []),
    ...(contextQuery.isError ? ["Não foi possível atualizar os dados do Workspace. Os dados exibidos são da última consulta válida."] : []),
    ...queries.flatMap((query, index) => query.isError ? [`Não foi possível consultar ${inventoryResources[index]!.label}. Tente novamente no indicador.`] : []),
  ];
  return <section className="final-page stack workspace-overview">
    <PageHeader title="Visão geral do Workspace" description="Inventário do rascunho e Release selecionada."
      actions={canOfferWrite && <div className="workspace-overview-actions">
        {servicesHref && <Link className="button" to={servicesHref}>Novo serviço</Link>}
        {routesHref && <Link className="button" to={routesHref}>Nova rota</Link>}
        {releasesHref && <Link className="button publish" to={releasesHref}>Publicar release</Link>}
      </div>} />
    <section className="workspace-overview-panel stack" aria-label="Identidade do Workspace">
      <div className="workspace-overview-identity"><h2>{workspace.name}</h2><Badge tone={workspace.status === "archived" ? "off" : "converged"}>{workspace.status === "archived" ? "Arquivado" : "Ativo"}</Badge></div>
      <p className="mono wrap">/{workspace.slug}</p>
      <p>{workspace.description || "Sem descrição informada."}</p>
      <p>{releaseText}</p>
      {!knownWritePermission && workspace.status === "active" && <p className="muted" role="status">Somente leitura nesta visão geral. Atalhos de escrita indisponíveis para sua permissão.</p>}
    </section>
    {attention.length > 0 && <section className="workspace-overview-panel" aria-label="Requer atenção">
      <h2>Requer atenção</h2><ul>{attention.map(text => <li key={text}>{text}</li>)}</ul>
      {contextQuery.isError && <Button onClick={() => contextQuery.refetch()}>Atualizar Workspace</Button>}
    </section>}
    <section className="stack" aria-label="Inventário no rascunho">
      <div><h2>Inventário no rascunho</h2><p className="muted">Quantidades consultadas neste Workspace. Não comprovam publicação ou tráfego.</p></div>
      <div className="workspace-overview-grid">
        {inventoryResources.map((resource, index) => {
          const query = queries[index]!;
          const href = resourceHref(workspaceId, resource.section);
          const content = <><h3>{resource.label}</h3>
            <p className="workspace-overview-count mono">{query.isSuccess ? `${query.data.count}${query.data.partial ? "+" : ""}` : "—"}</p>
            {query.isSuccess && <p className="muted small">{query.data.partial ? "Primeira página · total não consultado" : "Quantidade consultada"}</p>}
            {!href && <p className="muted small">Página v2 em breve</p>}</>;
          return <article key={resource.section} className="workspace-overview-panel" aria-label={`Indicador: ${resource.label}`} aria-busy={query.isPending}>
            {href ? <Link className="workspace-overview-card-link" to={href}>{content}</Link> : content}
            {query.isPending && <p role="status" className="muted">Carregando {resource.label}…</p>}
            {query.isError && <div><p role="alert">Não foi possível consultar {resource.label}.{query.error instanceof ApiError && query.error.status === 403 ? " Sem permissão de leitura." : ""}</p>
              <Button onClick={() => query.refetch()}>Tentar novamente: {resource.label}</Button></div>}
          </article>;
        })}
      </div>
    </section>
    <div className="workspace-overview-columns">
      <section className="workspace-overview-panel stack" aria-label="Release selecionada">
        <h2>Release selecionada</h2><p className="workspace-overview-release">{releaseText}</p>
        <p className="muted">Seleção para um futuro deployment. Não comprova implantação ou versão aplicada.</p>
        {releasesHref && <Link to={releasesHref}>Ver Releases</Link>}
      </section>
      <section className="workspace-overview-panel stack" aria-label="Releases recentes">
        <h2>Releases recentes</h2>
        {showReleases ? <RecentReleases workspaceId={workspaceId} /> : <>
          <p className="muted">Consulte o histórico quando precisar. A consulta carrega a lista de Releases do Workspace.</p>
          <div><Button onClick={() => setShowReleases(true)}>Consultar Releases recentes</Button></div>
        </>}
      </section>
    </div>
  </section>;
}

function RecentReleases({ workspaceId }: { workspaceId: string }) {
  const query = useQuery({ ...releasesQuery(workspaceId), retry: false, refetchOnWindowFocus: false });
  return <div aria-busy={query.isPending}>
    {query.isPending && <p role="status">Carregando Releases recentes…</p>}
    {query.isError && <><p role="alert">Não foi possível consultar as Releases recentes.</p><Button onClick={() => query.refetch()}>Tentar novamente: Releases</Button></>}
    {query.isSuccess && (query.data.length === 0 ? <p>Nenhuma Release publicada neste Workspace.</p> : <>
      <p className="muted small">Até cinco Releases mais recentes.</p>
      <ol className="workspace-overview-releases">{query.data.toSorted((a, b) => b.version - a.version).slice(0, 5).map(release => <li key={release.version}>
        <strong className="mono">v{release.version}</strong><time dateTime={release.createdAt}>{new Date(release.createdAt).toLocaleString("pt-BR")}</time>
        <p>{release.message || "Sem resumo informado"}</p>
      </li>)}</ol>
    </>)}
  </div>;
}
