import { useEffect, useId, useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { ApiError } from "../api/client";
import { workspacesQuery, type Workspace } from "../api/client-v2";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { Table } from "../components/Table";
import "./InstanceOverview.css";

type Order = "name" | "name-desc" | "status";
const normalizeSearch = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("pt-BR");
const releaseText = (workspace: Workspace) => workspace.activeRelease === undefined ? "Estado da Release não informado"
  : workspace.activeRelease === null ? "Nenhuma Release selecionada informada" : `Release selecionada ${workspace.activeRelease}`;

export function InstanceOverviewPage() {
  const queryClient = useQueryClient();
  const [ready, setReady] = useState(false);
  const workspaces = useInfiniteQuery({ ...workspacesQuery, enabled: ready, retry: false, refetchOnMount: false, refetchOnWindowFocus: false });
  useEffect(() => {
    // Reset before enabling: returning must start one new cursor chain, not refetch every cached page.
    void queryClient.resetQueries({ queryKey: workspacesQuery.queryKey, exact: true });
    setReady(true);
  }, [queryClient]);
  useEffect(() => {
    if (workspaces.error instanceof ApiError && [401, 403].includes(workspaces.error.status)) {
      queryClient.removeQueries({ queryKey: workspacesQuery.queryKey });
      queryClient.removeQueries({ queryKey: ["workspace"] });
    }
  }, [queryClient, workspaces.error]);
  const [search, setSearch] = useState("");
  const [order, setOrder] = useState<Order>("name");
  const id = useId();
  const denied = workspaces.isError && workspaces.error instanceof ApiError && [401, 403].includes(workspaces.error.status);
  const forbidden = denied && workspaces.error instanceof ApiError && workspaces.error.status === 403;
  // A failed next page can retain authorized pages; a denied list or failed revalidation cannot.
  const available = ready && !!workspaces.data && !denied && (!workspaces.isError || workspaces.isFetchNextPageError);
  const items = available ? [...new Map(workspaces.data!.pages.flatMap((page) => page.items).map((w) => [w.id, w])).values()] : [];
  const term = normalizeSearch(search.trim());
  const visible = items.filter((w) => normalizeSearch(w.name).includes(term) || normalizeSearch(w.slug).includes(term)).sort((a, b) =>
    (order === "status" ? a.status.localeCompare(b.status) : 0)
    || (order === "name-desc" ? -1 : 1) * a.name.localeCompare(b.name, "pt-BR") || a.id.localeCompare(b.id));
  const nextError = available && workspaces.isFetchNextPageError;
  const resetList = () => {
    queryClient.removeQueries({ queryKey: workspacesQuery.queryKey, exact: true });
    void workspaces.refetch();
  };
  const counts = [
    ["Workspaces carregados", items.length],
    ["Ativos carregados", items.filter((w) => w.status === "active").length],
    ["Arquivados carregados", items.filter((w) => w.status === "archived").length],
  ] as const;

  return (
    <section className="final-page instance-overview">
      <p className="instance-overview-scope">Instância · escopo global</p>
      <PageHeader title="Visão geral da instância"
        description="Somente Workspaces acessíveis nesta instância. Selecione um Workspace para abrir seu Gateway."
        actions={<div className="instance-overview-actions">
          <Button disabled={workspaces.isFetching} onClick={resetList}>Atualizar lista</Button>
          <Link to="/workspaces" className="button primary">Gerenciar Workspaces</Link>
        </div>} />
      <dl className="instance-overview-counts" aria-label="Resumo dos Workspaces carregados">
        {counts.map(([label, count]) => <div key={label}><dt>{label}</dt><dd>{available ? count : "—"}</dd></div>)}
      </dl>
      <p className="muted instance-overview-caption">Somente itens carregados. As contagens não são totais da instância.</p>
      <section className="instance-overview-panel" aria-labelledby={`${id}-title`} aria-busy={workspaces.isFetching}>
        <h2 id={`${id}-title`}>Workspaces acessíveis</h2>
        <p className="muted">Estado cadastral e Release selecionada não comprovam saúde ou implantação.</p>
        {workspaces.isPending && <p role="status">Carregando Workspaces…</p>}
        {workspaces.isError && !available && <div>
          <p className="error" role="alert">{forbidden ? "Sem permissão para listar Workspaces nesta instância."
            : "Não foi possível carregar os Workspaces. Tente novamente."}</p>
          <div className="instance-overview-actions">
            <Button disabled={workspaces.isFetching} onClick={resetList}>Tentar novamente</Button>
            {forbidden && <Link to="/tokens">Ir para minha conta</Link>}
          </div>
        </div>}
        {available && <>
          <div className="instance-overview-filters">
            <div className="field">
              <label htmlFor={`${id}-search`}>Buscar nos Workspaces carregados</label>
              <input id={`${id}-search`} type="search" placeholder="Nome ou slug" value={search}
                aria-describedby={`${id}-coverage`} onChange={(event) => setSearch(event.target.value)} />
            </div>
            <div className="field">
              <label htmlFor={`${id}-order`}>Ordenar carregados</label>
              <select id={`${id}-order`} value={order} aria-describedby={`${id}-coverage`} onChange={(event) => setOrder(event.target.value as Order)}>
                <option value="name">Nome A–Z</option><option value="name-desc">Nome Z–A</option><option value="status">Estado cadastral</option>
              </select>
            </div>
          </div>
          <p className="muted" id={`${id}-coverage`}>Busca e ordenação nos {items.length} Workspaces carregados{workspaces.hasNextPage ? "; há mais Workspaces." : ". Fim da lista consultada."}</p>
          {items.length === 0 && !workspaces.hasNextPage ? <EmptyState title="Nenhum Workspace disponível para sua conta nesta instância"
            text="A lista acessível está vazia. Isso não descreve todos os Workspaces da instalação." />
            : visible.length === 0 ? <EmptyState title="Nenhum resultado nos Workspaces carregados"
              text="A busca local cobre somente os itens carregados."
              action={search && <Button onClick={() => setSearch("")}>Limpar busca</Button>} /> : <Table label="Workspaces acessíveis" cards>
              <thead><tr><th>Workspace / slug</th><th>Estado</th><th>Descrição</th><th>Release selecionada</th><th>Acessar</th></tr></thead>
              <tbody>{visible.map((w) => <tr key={w.id}>
                <td><strong>{w.name}</strong><code>{w.slug}</code></td>
                <td data-label="Estado"><Badge tone={w.status === "archived" ? "off" : "converged"}>{w.status === "archived" ? "Arquivado · somente leitura" : "Ativo · cadastral"}</Badge></td>
                <td data-label="Descrição">{w.description || "Sem descrição"}</td>
                <td data-label="Release selecionada">{releaseText(w)}</td>
                <td><Link className="button" to={`/workspaces/${encodeURIComponent(w.id)}`} aria-label={`Abrir Workspace ${w.name}`}>Abrir</Link></td>
              </tr>)}</tbody>
            </Table>}
          <div className="instance-overview-footer">
            <p id={`${id}-progress`} role="status">{visible.length} exibidos · {items.length} carregados{workspaces.hasNextPage || nextError ? " · Lista parcial" : " · Fim da lista consultada"}{workspaces.isFetchingNextPage ? " · Carregando mais Workspaces…" : ""}</p>
            {(workspaces.hasNextPage || workspaces.data!.pages.length > 1) && <Button
              aria-disabled={workspaces.isFetching || !workspaces.hasNextPage} aria-describedby={`${id}-progress`}
              onClick={() => { if (workspaces.hasNextPage && !workspaces.isFetching) void workspaces.fetchNextPage(); }}>
              {nextError ? "Tentar novamente" : "Carregar mais"}
            </Button>}
          </div>
          {nextError && <div>
            <p role="alert" className="error">Não foi possível carregar mais Workspaces. Os itens já carregados foram mantidos; a lista continua parcial.</p>
          </div>}
        </>}
      </section>
      <section className="instance-overview-limits" aria-labelledby={`${id}-limits`}>
        <h2 id={`${id}-limits`}>Limites dos indicadores globais</h2>
        <p className="muted">A lista não fornece agregados operacionais da instância.</p>
        <div className="instance-overview-limit-cards">
          {[["Inventário global", "Serviços, Rotas, Consumidores e Plugins exigem um resumo autorizado próprio."],
            ["Tráfego global", "Sem soma de tráfego ou média de percentis entre Workspaces."],
            ["Saúde e convergência", "Sem informação operacional global de implantações ou atividade."]].map(([title, detail]) => <article key={title}>
              <h3>{title}</h3><p>Não disponível — requer contrato</p><p className="muted">{detail}</p>
            </article>)}
        </div>
      </section>
    </section>
  );
}
