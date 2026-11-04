import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, type Plugin } from "../api/client";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { ConfirmDialog } from "../components/Modal";
import { Table } from "../components/Table";
import { RowMenu } from "../components/RowMenu";
import { canWriteWorkspaceGateway, useWorkspaceGatewayAccess } from "./workspace-gateway";
import { PluginEditor, workspacePluginErrors } from "./WorkspacePlugins";
import { consumerPluginAllowed, consumerPluginConfigErrors, consumerPluginMessage, listConsumerPlugins, removeConsumerPlugin } from "./consumer-plugins";

export function ConsumerPlugins({ workspaceId, consumerId, consumerName }: { workspaceId: string; consumerId: string; consumerName: string }) {
  // Parent detail is keyed by both ids; a context change discards dialogs and secret form state.
  const access = useWorkspaceGatewayAccess(workspaceId);
  const client = useQueryClient();
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const plugins = useInfiniteQuery({ queryKey: ["ws-plugins", workspaceId, { consumerId }],
    queryFn: ({ pageParam, signal }) => listConsumerPlugins(workspaceId, consumerId, pageParam, signal),
    initialPageParam: "", getNextPageParam: page => page.nextCursor ?? undefined });
  const [editing, setEditing] = useState<Plugin | "new" | null>(null);
  const [deleting, setDeleting] = useState<Plugin | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invalidate = () => {
    for (const family of ["ws-plugins", "ws-plugin", "plugins", "environment", "preview"]) void client.invalidateQueries({ queryKey: [family, workspaceId] });
  };
  const remove = async () => {
    if (!deleting || busy || !canWriteWorkspaceGateway(client, workspaceId, true)) return;
    setBusy(true); setError(null);
    try { await removeConsumerPlugin(workspaceId, consumerId, deleting.id, () => { if (!canWriteWorkspaceGateway(client, workspaceId, true)) throw new ApiError(403, undefined); }); invalidate(); if (mounted.current) setDeleting(null); }
    catch (err) { if (mounted.current) { const errors = workspacePluginErrors(err); setError([...errors.form, ...Object.values(errors.fields).flat()].join(" ")); } }
    finally { if (mounted.current) setBusy(false); }
  };
  const items = plugins.data?.pages.flatMap(p => p.items) ?? [];
  return <section aria-label="Plugins do consumidor" className="gateway-list">
    <div className="cred-head"><h2>Plugins do consumidor</h2>{access.canWrite && plugins.isSuccess && <Button variant="primary" onClick={() => setEditing("new")}>Associar plugin</Button>}</div>
    <p>As alterações afetam somente o rascunho deste Workspace.</p>
    {access.reason && <p role="status">{access.reason}</p>}
    {plugins.isPending && <p role="status">Carregando plugins…</p>}
    {plugins.isError && <p role="alert" className="error">{consumerPluginMessage(plugins.error)}</p>}
    {plugins.isSuccess && !items.length && <EmptyState title="Nenhum plugin neste consumidor." text="Associe um plugin compatível para configurar o comportamento deste consumidor." />}
    {!!items.length && <Table label="Plugins do consumidor" cards><thead><tr><th>Plugin</th><th>Ativo</th>{access.canWrite && <th aria-label="Ações" />}</tr></thead><tbody>{items.map(p => {
      const allowed = consumerPluginAllowed({ name: p.name, category: "other", source: "bundled", supportedInDbless: true }) && !p.tags?.some(t => t.startsWith("gromesh-")) && !Object.keys(consumerPluginConfigErrors(p.name, p.config ?? {})).length;
      return <tr key={p.id}><td className="row-main"><span className="mono">{p.name}</span>{(p.scope?.serviceId || p.scope?.routeId) && <small className="muted"> · Escopo combinado (preservado)</small>}{!allowed && <small className="muted"> · Gerenciado pela plataforma (somente leitura)</small>}</td><td><Badge tone={p.enabled === false ? "off" : "converged"}>{p.enabled === false ? "Não" : "Sim"}</Badge></td>{access.canWrite && <td className="actions">{allowed && <><Button variant="quiet" aria-label={`Editar ${p.name}`} onClick={() => setEditing(p)}>Editar</Button><RowMenu label={`Mais ações para ${p.name}`} items={[{ label: "Excluir", danger: true, onSelect: () => { setError(null); setDeleting(p); } }]} /></>}</td>}</tr>;
    })}</tbody></Table>}
    {plugins.hasNextPage && <Button disabled={plugins.isFetchingNextPage} onClick={() => void plugins.fetchNextPage()}>Carregar mais</Button>}
    {editing && <PluginEditor workspaceId={workspaceId} current={editing === "new" ? null : editing} fixedConsumer={{ id: consumerId, name: consumerName }} onClose={() => setEditing(null)} onSaved={active => { invalidate(); if (active && mounted.current) setEditing(null); }} />}
    {deleting && <ConfirmDialog title="Excluir plugin" message={<>Excluir <strong>{deleting.name}</strong> do rascunho deste consumidor?</>} confirmLabel="Excluir" confirmDisabled={!access.canWrite} busy={busy} error={error} onClose={() => setDeleting(null)} onConfirm={() => void remove()} />}
  </section>;
}
