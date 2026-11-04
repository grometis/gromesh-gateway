import { useState, type FormEvent } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { useWorkspaceId } from "../navigation/context";
import { Button } from "../components/Button";
import { PageHeader } from "../components/PageHeader";
import { Table } from "../components/Table";
import { EmptyState } from "../components/EmptyState";
import { ConfirmDialog, Modal } from "../components/Modal";
import { Field, FormErrorList } from "../components/Field";
import { Badge } from "../components/Badge";
import type { FormErrors } from "../api/errors";
import { ALGORITHMS, healthSummary, UpstreamForm } from "./Upstreams";
import { canWriteWorkspaceGateway, fieldText, useWorkspaceGatewayAccess } from "./workspace-gateway";
import {
  upstreamPageQuery, upstreamServicesQuery, targetPageQuery, saveWorkspaceUpstream, deleteWorkspaceUpstream,
  saveWorkspaceTarget, deleteWorkspaceTarget, invalidateWorkspaceUpstreams, upstreamErrorMessage, upstreamFormErrors,
  type Upstream, type Target,
} from "./workspace-upstreams";

export function WorkspaceUpstreamsPage() {
  const workspaceId = useWorkspaceId();
  return <WorkspaceUpstreams key={workspaceId} workspaceId={workspaceId} />;
}

function WorkspaceUpstreams({ workspaceId }: { workspaceId: string }) {
  const client = useQueryClient();
  const access = useWorkspaceGatewayAccess(workspaceId);
  const upstreams = useInfiniteQuery({
    queryKey: upstreamPageQuery(workspaceId).queryKey,
    queryFn: ({ pageParam, signal }) => upstreamPageQuery(workspaceId, pageParam).queryFn({ signal }),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const services = useQuery(upstreamServicesQuery(workspaceId));
  const [editing, setEditing] = useState<Upstream | "new" | null>(null);
  const [deleting, setDeleting] = useState<Upstream | null>(null);
  const [targets, setTargets] = useState<Upstream | null>(null);
  const items = upstreams.data?.pages.flatMap((p) => p.items) ?? [];
  const canWrite = access.canWrite && upstreams.isSuccess;
  const keepDialogs = canWrite || access.isRevalidating;
  const refresh = () => invalidateWorkspaceUpstreams(client, workspaceId);
  const guard = () => {
    if (!canWriteWorkspaceGateway(client, workspaceId, true)) throw new Error("Workspace write access is unavailable");
  };
  const remove = useMutation({
    mutationFn: async (upstreamId: string) => { guard(); return deleteWorkspaceUpstream(workspaceId, upstreamId); },
    onSuccess: () => { refresh(); setDeleting(null); },
  });
  return <section className="final-page gateway-list upstreams-page workspace-upstreams-page">
    <PageHeader title="Upstreams"
      description="Um Upstream reúne destinos e distribui o tráfego dos Serviços vinculados conforme o algoritmo e os pesos configurados."
      actions={canWrite && <Button variant="primary" onClick={() => setEditing("new")}>Novo upstream</Button>} />
    <div className="note" role="note" aria-label="Configuração de Upstreams">
      <p>Selecione o Upstream no Serviço para criar o vínculo. O nome do Upstream não deve ser usado como host do Serviço.</p>
      <p>Alterações ficam no rascunho. A configuração de verificações de saúde não informa a saúde atual dos destinos.</p>
      {access.reason && <p role="status">{access.reason}</p>}
    </div>
    {upstreams.isPending && <p role="status">Carregando Upstreams…</p>}
    {upstreams.isError && <p className="error" role="alert">{upstreamErrorMessage(upstreams.error)}</p>}
    {upstreams.isSuccess && items.length === 0 && <EmptyState title="Nenhum upstream ainda." text="Crie um Upstream, adicione destinos e selecione o vínculo em um Serviço para distribuir o tráfego." />}
    {services.isPending && <p role="status">Carregando vínculos com Serviços…</p>}
    {services.isError && <p className="error" role="alert">Não foi possível consultar os Serviços vinculados. {upstreamErrorMessage(services.error)}</p>}
    {services.isSuccess && services.data.nextCursor && <p role="status">Lista parcial de Serviços: exibindo os vínculos encontrados nos primeiros 200 resultados.</p>}
    {upstreams.isSuccess && items.length > 0 && <Table label="Upstreams" cards>
      <thead><tr><th>Upstream → algoritmo e Serviços</th><th className="actions" aria-label="Ações" /></tr></thead>
      <tbody>{items.map((u) => {
        const linked = services.isSuccess ? services.data.items.filter((s) => s.upstreamId === u.id) : [];
        return <tr key={u.id}>
          <td className="row-main">
            <div className="service-route"><span className="service-name mono">{u.name}</span><span className="arrow" aria-hidden="true">→</span><span>{ALGORITHMS[u.algorithm]}</span></div>
            <div className="route-matches"><span className="muted">Verificações configuradas:</span> <span>{healthSummary(u)}</span></div>
            {services.isSuccess && <div className="route-matches">
              <span>Serviços vinculados: </span>
              {linked.length ? linked.map((s) => <Link key={s.id} to={`/workspaces/${encodeURIComponent(workspaceId)}/services/${encodeURIComponent(s.id)}`}>{s.name}</Link>)
                : <span>{services.data.nextCursor ? "nenhum encontrado nesta lista parcial." : "nenhum."}</span>}
            </div>}
          </td>
          <td className="actions">
            <Button variant="quiet" onClick={() => setTargets(u)}>Destinos de {u.name}</Button>
            {canWrite && <><Button variant="quiet" onClick={() => setEditing(u)}>Editar {u.name}</Button>
              <Button variant="danger" onClick={() => { remove.reset(); setDeleting(u); }}>Excluir {u.name}</Button></>}
          </td>
        </tr>;
      })}</tbody>
    </Table>}
    {upstreams.hasNextPage && <Button onClick={() => void upstreams.fetchNextPage()} disabled={upstreams.isFetchingNextPage}>Carregar mais Upstreams</Button>}
    {keepDialogs && editing && <UpstreamForm envId={workspaceId} upstream={editing === "new" ? null : editing} onClose={() => setEditing(null)} workspace={{
      canSubmit: canWrite,
      errors: upstreamFormErrors,
      save: async (body) => { guard(); await saveWorkspaceUpstream(workspaceId, editing === "new" ? null : editing.id, body); refresh(); },
    }} />}
    {keepDialogs && deleting && <ConfirmDialog title="Excluir upstream" message={<>Excluir <strong>{deleting.name}</strong> e seus destinos? Serviços vinculados podem impedir a exclusão. A alteração fica no rascunho.</>}
      confirmLabel="Excluir" busy={remove.isPending} confirmDisabled={!canWrite} error={remove.isError ? upstreamErrorMessage(remove.error) : null}
      onConfirm={() => remove.mutate(deleting.id)} onClose={() => setDeleting(null)} />}
    {targets && <Modal title={`Destinos de ${targets.name}`} onClose={() => setTargets(null)} wide>
      <WorkspaceTargets key={targets.id} workspaceId={workspaceId} upstreamId={targets.id} />
    </Modal>}
  </section>;
}

function WorkspaceTargets({ workspaceId, upstreamId }: { workspaceId: string; upstreamId: string }) {
  const client = useQueryClient();
  const access = useWorkspaceGatewayAccess(workspaceId);
  const targets = useInfiniteQuery({
    queryKey: targetPageQuery(workspaceId, upstreamId).queryKey,
    queryFn: ({ pageParam, signal }) => targetPageQuery(workspaceId, upstreamId, pageParam).queryFn({ signal }),
    initialPageParam: "", getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const canWrite = access.canWrite && targets.isSuccess;
  const [editing, setEditing] = useState<Target | null>(null);
  const [deleting, setDeleting] = useState<Target | null>(null);
  const [form, setForm] = useState({ target: "", weight: "100" });
  const [errors, setErrors] = useState<FormErrors>({ fields: {}, form: [] });
  const refresh = () => invalidateWorkspaceUpstreams(client, workspaceId);
  const guard = () => {
    if (!canWriteWorkspaceGateway(client, workspaceId, true)) throw new Error("Workspace write access is unavailable");
  };
  const save = useMutation({
    mutationFn: async () => {
      guard();
      return saveWorkspaceTarget(workspaceId, upstreamId, editing?.id ?? null, {
        target: editing ? editing.target : form.target.trim(), weight: Number(form.weight), ...(editing ? { tags: editing.tags } : {}),
      });
    },
    onSuccess: () => { setEditing(null); setForm({ target: "", weight: "100" }); setErrors({ fields: {}, form: [] }); refresh(); },
    onError: (err) => setErrors(upstreamFormErrors(err)),
  });
  const remove = useMutation({
    mutationFn: async (id: string) => { guard(); return deleteWorkspaceTarget(workspaceId, upstreamId, id); },
    onSuccess: (_data, id) => {
      if (editing?.id === id) { setEditing(null); setForm({ target: "", weight: "100" }); setErrors({ fields: {}, form: [] }); }
      setDeleting(null); refresh();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canWrite) return;
    const weight = Number(form.weight);
    if (!form.weight.trim() || !Number.isInteger(weight) || weight < 0 || weight > 65535) {
      setErrors({ fields: { weight: ["Peso: informe um inteiro de 0 a 65535."] }, form: [] }); return;
    }
    setErrors({ fields: {}, form: [] }); save.mutate();
  };
  const items = targets.data?.pages.flatMap((p) => p.items) ?? [];
  return <div className="stack">
    <p>Destinos são endereços host:porta. O peso controla a participação no balanceamento; 0 retira o destino do balanceamento. Não há informação de saúde atual nesta tela.</p>
    {access.reason && <p role="status">{access.reason}</p>}
    {targets.isPending && <p role="status">Carregando destinos…</p>}
    {targets.isError && <p role="alert" className="error">{upstreamErrorMessage(targets.error)}</p>}
    {targets.isSuccess && items.length === 0 && <EmptyState title="Nenhum destino: o tráfego deste Upstream não tem destino." />}
    {targets.isSuccess && items.length > 0 && <Table label="Destinos" cards>
      <thead><tr><th>Destino → peso</th><th className="actions" aria-label="Ações" /></tr></thead>
      <tbody>{items.map((t) => <tr key={t.id}><td className="row-main"><div className="service-route">
        <span className="service-name mono">{fieldText(t.target)}</span><span>Peso: {t.weight}</span>
        {t.weight === 0 && <Badge tone="off">fora do balanceamento</Badge>}
      </div></td><td className="actions">{canWrite && <>
        <Button variant="quiet" disabled={save.isPending} onClick={() => { setErrors({ fields: {}, form: [] }); setEditing(t); setForm({ target: fieldText(t.target), weight: String(t.weight) }); }}>Editar peso de {fieldText(t.target)}</Button>
        <Button variant="danger" onClick={() => { remove.reset(); setDeleting(t); }}>Remover {fieldText(t.target)}</Button>
      </>}</td></tr>)}</tbody>
    </Table>}
    {targets.hasNextPage && <Button onClick={() => void targets.fetchNextPage()} disabled={targets.isFetchingNextPage}>Carregar mais destinos</Button>}
    {canWrite && <form className="form" onSubmit={submit} noValidate>
      <h3>{editing ? "Editar peso" : "Adicionar destino"}</h3>
      <div className="row">
        <Field label={editing ? "Destino" : "Novo destino"} errors={errors.fields.target} hint="Destino literal host:porta; IPv6 entre colchetes. Variáveis ainda não são aceitas.">
          {(id, invalid) => <input id={id} aria-invalid={invalid} disabled={!!editing || save.isPending} value={form.target} onChange={(e) => setForm((f) => ({ ...f, target: e.target.value }))} placeholder="backend.internal:8080" />}
        </Field>
        <Field label="Peso" errors={errors.fields.weight} hint="Inteiro de 0 a 65535">
          {(id, invalid) => <input id={id} aria-invalid={invalid} disabled={save.isPending} inputMode="numeric" value={form.weight} onChange={(e) => setForm((f) => ({ ...f, weight: e.target.value }))} />}
        </Field>
      </div>
      <FormErrorList messages={errors.form} />
      <div className="form-actions">
        {editing && <Button disabled={save.isPending} onClick={() => { setEditing(null); setForm({ target: "", weight: "100" }); setErrors({ fields: {}, form: [] }); }}>Cancelar edição</Button>}
        <button type="submit" className="primary" disabled={save.isPending}>{save.isPending ? "Salvando…" : editing ? "Salvar peso" : "Adicionar destino"}</button>
      </div>
    </form>}
    {(canWrite || access.isRevalidating) && deleting && <ConfirmDialog title="Remover destino" message={<>Remover <strong>{fieldText(deleting.target)}</strong>? A alteração fica no rascunho.</>}
      confirmLabel="Remover" busy={remove.isPending} confirmDisabled={!canWrite} error={remove.isError ? upstreamErrorMessage(remove.error) : null}
      onConfirm={() => remove.mutate(deleting.id)} onClose={() => setDeleting(null)} />}
  </div>;
}
