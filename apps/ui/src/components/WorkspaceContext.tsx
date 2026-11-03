import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ApiError, unwrap } from "../api/client";
import { apiV2, workspacesQuery, type Workspace } from "../api/client-v2";

export function WorkspaceSelector({ id, workspace, onSelect }: { id?: string; workspace?: Workspace; onSelect: (id: string) => void }) {
  const workspaces = useInfiniteQuery({ ...workspacesQuery, retry: false });
  const listed = workspaces.data?.pages.flatMap((page) => page.items) ?? [];
  const items = workspace && workspace.id === id ? [workspace, ...listed.filter((w) => w.id !== id)] : listed;
  const selected = (workspace?.id === id || workspaces.isSuccess) && items.some((w) => w.id === id) ? id : "";
  const message = workspaces.isPending ? "Carregando Workspaces…"
    : workspaces.isError ? workspaces.error instanceof ApiError && workspaces.error.status === 403
      ? "Sem permissão para listar Workspaces." : "Não foi possível carregar os Workspaces."
    : items.length === 0 ? "Nenhum Workspace disponível."
    : id && !selected ? "Workspace indisponível nesta lista." : null;
  return (
    <div className="env">
      <label htmlFor="workspace-select">Workspace v2</label>
      <select id="workspace-select" value={selected} disabled={!workspaces.isSuccess || items.length === 0} aria-describedby={message ? "workspace-context-message" : undefined} onChange={(event) => {
        if (workspaces.isSuccess && items.some((w) => w.id === event.target.value)) onSelect(event.target.value);
      }}>
        {!selected && <option value="" disabled>Selecione um Workspace</option>}
        {items.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
      </select>
      {message && <p id="workspace-context-message" role={workspaces.isError ? "alert" : "status"}>{message}</p>}
      {workspaces.hasNextPage && <button type="button" disabled={workspaces.isFetchingNextPage} onClick={() => void workspaces.fetchNextPage()}>Carregar mais Workspaces</button>}
    </div>
  );
}

/** The backend joins v1/v2 by local id; a v1 name alone never proves a v2 Workspace exists. */
export function WorkspaceContext({ id }: { id: string }) {
  const workspace = useQuery({
    queryKey: ["workspace", id],
    queryFn: () => unwrap(apiV2.GET("/workspaces/{workspaceId}", { params: { path: { workspaceId: id } } })),
    retry: false,
  });
  let text = "Workspace v2: verificando…";
  if (workspace.isError) text = workspace.error instanceof ApiError && workspace.error.status === 403
    ? "Workspace v2: sem permissão de leitura."
    : workspace.error instanceof ApiError && workspace.error.status === 404
      ? "Workspace v2: não disponível neste contexto."
      : "Workspace v2: não foi possível carregar.";
  else if (workspace.isSuccess && workspace.fetchStatus === "idle" && workspace.data.id === id) {
    const w = workspace.data;
    text = `Workspace v2: ${w.name} · /${w.slug} · ${w.status === "archived" ? "arquivado" : "ativo"}`;
  }
  return <p className="workspace-context" role="status">{text}</p>;
}
