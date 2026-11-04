import { useWorkspaceId, useIsWorkspaceRoute } from "../navigation/context";
import { useId, useState } from "react";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, unwrap } from "../api/client";
import { apiV2, problemCode, type Release } from "../api/client-v2";
import { useAuth } from "../auth";
import { Button } from "../components/Button";
import { Field } from "../components/Field";
import { InstanceContext } from "../components/InstanceContext";
import { Modal } from "../components/Modal";
import { PageHeader } from "../components/PageHeader";
import { useLegacyEnvironment } from "../components/Shell";
import { Table } from "../components/Table";
import { useWorkspace, useWorkspaceGatewayAccess } from "./workspace-gateway";

export const releasesQuery = (workspaceId: string) => ({
  queryKey: ["ws-releases", workspaceId] as const,
  queryFn: () => unwrap(apiV2.GET("/workspaces/{workspaceId}/releases", { params: { path: { workspaceId } } })),
});

export function publishReleaseMutation(client: QueryClient, workspaceId: string, expectedActiveVersion: number | null, onPublished: (release: Release) => void) {
  return {
    mutationFn: (message: string) => unwrap(apiV2.POST("/workspaces/{workspaceId}/releases", {
      params: { path: { workspaceId } }, body: { expectedActiveVersion, ...(message.trim() ? { message: message.trim() } : {}) },
    })),
    onSuccess: (release: Release) => {
      client.setQueryData<Release[]>(releasesQuery(workspaceId).queryKey, (items = []) => [release, ...items.filter((r) => r.version !== release.version)]);
      void client.invalidateQueries({ queryKey: releasesQuery(workspaceId).queryKey });
      void client.invalidateQueries({ queryKey: ["workspace", workspaceId] });
      // Publishing v2 leaves v1's draft flags and snapshots untouched.
      onPublished(release);
    },
  };
}

/** Never echo server values: validation may concern variables whose values must stay on the instance. */
export function releaseErrors(error: unknown): string[] {
  if (!(error instanceof ApiError)) return ["Não foi possível falar com o servidor. Tente novamente."];
  if (error.status === 403) return ["Você não tem permissão para publicar (release.publish), ou a instância não permite publicação local. Somente dev permite publicar; hml e prd recebem promoções."];
  if (error.status === 404) return ["Workspace não encontrado ou sem acesso."];
  const message = (detail: string): string => {
    if (problemCode(error) === "workspace-archived") return "Workspace arquivado: publicação não permitida.";
    if (/nothing to publish|draft.*empty|empty draft/i.test(detail)) return "Sem alterações para publicar: o rascunho está vazio ou é igual à release ativa.";
    if (/active release|expected.*version/i.test(detail)) return "A release ativa mudou. Atualize a página e revise antes de publicar novamente.";
    if (/lease/i.test(detail)) return "Um deployment está em andamento. Aguarde a liberação antes de publicar.";
    if (/instance stage/i.test(detail)) return "O estágio da instância diverge da configuração. Verifique com a administração.";
    if (/variable|VarRef|\$var/i.test(detail)) return /not declared|undeclared/i.test(detail)
      ? "A variável referenciada não está declarada neste Workspace."
      : "A variável está sem valor ou tem valor inválido nesta instância. Revise a referência e sua configuração.";
    if (/slug/i.test(detail)) return "Defina um slug válido para o Workspace antes de publicar.";
    if (/forbidden destination/i.test(detail)) return "Destino recusado pela política da plataforma.";
    return error.status === 409 ? "Conflito com o estado atual. Atualize a página e revise antes de tentar novamente."
      : error.status === 422 ? "O servidor recusou este conteúdo. Revise o rascunho antes de publicar."
      : `Não foi possível publicar (HTTP ${error.status}).`;
  };
  const items = error.problem?.errors ?? [];
  return items.length ? items.map(({ path, message: detail }) => `${path}: ${message(detail)}`) : [message(error.problem?.detail ?? "")];
}

export function ReleasesPage() {
  const workspaceId = useWorkspaceId();
  return <WorkspaceReleases key={workspaceId} workspaceId={workspaceId} />;
}

function WorkspaceReleases({ workspaceId }: { workspaceId: string }) {
  const { user } = useAuth();
  const v2 = useIsWorkspaceRoute();
  const workspace = useWorkspace(workspaceId);
  const environment = useLegacyEnvironment(workspaceId);
  const access = useWorkspaceGatewayAccess(workspaceId, "release");
  // /me cannot describe v2 bindings: offer publication to readers and let the server enforce release.publish.
  const [confirm, setConfirm] = useState<{ expectedVersion: number | null } | null>(null);
  const [published, setPublished] = useState<number | null>(null);
  const activeVersion = workspace.data?.activeRelease ?? null;
  const open = () => {
    if (!access.canWrite) return;
    setConfirm({ expectedVersion: activeVersion });
    if (!v2) { void workspace.refetch(); void environment.refetch(); }
  };
  return <section className="final-page releases-page stack">
    <PageHeader title="Releases" description={`Releases do Workspace ${workspace.data?.name ?? "selecionado"}. Publicar uma release não implanta seu conteúdo.`}
      actions={access.canWrite && <Button variant="publish" onClick={open}>Publicar release</Button>} />
    {access.reason && <p role="status" className="note">{access.reason}</p>}
    {published !== null && <div role="status" className="stack">
      <p>Release v{published} publicada. Nenhum deployment foi criado.</p>
      <a href="#release-history">Ver histórico de Releases</a>
      {user?.role === "admin" && <p>Consulte a auditoria para verificar os efeitos nos valores locais deste Workspace.</p>}
    </div>}
    {!v2 && <section className="stack" aria-label="Rascunho">
      <h2>Rascunho</h2>
      <p>{environment.isError ? "Não foi possível consultar o indicador de alterações pendentes."
        : !environment.data ? "Verificando alterações pendentes…"
        : environment.data.hasUnpublishedChanges ? "Há alterações pendentes no rascunho (indicador v1)." : "Sem alterações pendentes pelo indicador v1."}</p>
      <p className="muted">Este indicador é compartilhado com o fluxo v1 e não é limpo ao publicar uma release v2. O contrato v2 não expõe a comparação do rascunho com a release ativa; o servidor verifica se há conteúdo novo ao publicar.</p>
      {environment.data?.publishMode === "auto" && <p className="note">A publicação automática pertence ao fluxo v1. Publicar uma release v2 é permitido nesse modo e não dispara implantação nem publicação v1.</p>}
    </section>
    }
    <section id="release-history" className="stack" aria-label="Releases publicadas">
      <h2>Releases publicadas</h2>
      <p>Histórico imutável: releases publicadas não podem ser editadas ou excluídas.</p>
      <p>{workspace.isError ? "Não foi possível consultar a release ativa."
        : !workspace.data ? "Consultando release ativa…"
        : activeVersion === null ? "Nenhuma release ativa informada." : `Release ativa: v${activeVersion}. É o conteúdo selecionado para um futuro deployment, sem comprovação de implantação.`}</p>
      <ReleasesList workspaceId={workspaceId} activeVersion={activeVersion} />
    </section>
    <section className="stack" aria-label="Deployment">
      <h2>Deployment</h2>
      <p>Deployment de Workspaces indisponível nesta fase</p>
      <p className="muted">A consulta do deployment atual ainda está planejada no contrato. Não é possível informar qual release está implantada a partir de activeRelease.</p>
    </section>
    <section className="stack" aria-label="Convergência">
      <h2>Convergência</h2>
      <p>Convergência indisponível nesta fase: depende da consulta do deployment atual, ainda planejada. Uma release publicada não comprova aplicação nos nós.</p>
    </section>
    {confirm && <PublishRelease workspaceId={workspaceId} expectedVersion={confirm.expectedVersion}
      onClose={() => setConfirm(null)} onPublished={(r) => { setPublished(r.version); setConfirm(null); }} />}
  </section>;
}

export function ReleasesList({ workspaceId, activeVersion }: { workspaceId: string; activeVersion: number | null }) {
  const releases = useQuery(releasesQuery(workspaceId));
  if (releases.isPending) return <p className="muted" role="status">Carregando releases…</p>;
  if (releases.isError) return <p className="error" role="alert">Não foi possível carregar as releases. {releases.error instanceof ApiError && releases.error.status === 403 ? "Você não tem permissão para consultar este Workspace." : "Tente atualizar a página."}</p>;
  if (!releases.data.length) return <p>Nenhuma release publicada neste Workspace.</p>;
  return <Table label="Releases publicadas">
    <thead><tr><th>Versão</th><th>Autor</th><th>Data</th><th>Resumo e digest</th></tr></thead>
    <tbody>{releases.data.map((r) => <tr key={r.version}>
      <td className="mono">v{r.version}{r.version === activeVersion && " · ativa"}</td>
      <td>{releaseAuthor(r.createdBy)}</td>
      <td><time dateTime={r.createdAt}>{new Date(r.createdAt).toLocaleString("pt-BR")}</time></td>
      <td><p>{r.message || "Sem resumo informado"}</p><span className="mono wrap">{r.contentDigest}</span>{r.contentRevoked && <p>Conteúdo revogado</p>}</td>
    </tr>)}</tbody>
  </Table>;
}

function releaseAuthor(actor: unknown): string {
  if (typeof actor !== "object" || actor === null) return "Não informado";
  // createdBy is an open object in the contract; render only recognized public labels.
  const record = actor as Record<string, unknown>;
  return typeof record.name === "string" ? record.name : typeof record.id === "string" ? record.id : "Não informado";
}

function PublishRelease({ workspaceId, expectedVersion, onClose, onPublished }: { workspaceId: string; expectedVersion: number | null; onClose: () => void; onPublished: (r: Release) => void }) {
  const client = useQueryClient();
  const workspace = useWorkspace(workspaceId);
  const access = useWorkspaceGatewayAccess(workspaceId, "release");
  const [message, setMessage] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const acknowledgementId = useId();
  const impactId = useId();
  const publish = useMutation(publishReleaseMutation(client, workspaceId, expectedVersion, onPublished));
  const allowed = access.canWrite && acknowledged && !publish.isPending;
  return <Modal title="Publicar release" bodyLabel="Confirmação de publicação" onClose={() => { if (!publish.isPending) onClose(); }} footer={<>
    <Button disabled={publish.isPending} onClick={onClose}>Cancelar</Button>
    <Button variant="publish" disabled={!allowed} onClick={() => { if (allowed) publish.mutate(message); }}>{publish.isPending ? "Publicando…" : "Confirmar publicação"}</Button>
  </>}>
    <div className="note stack">
      <p className="wrap">Workspace: <strong>{workspace.data?.name ?? "Nome indisponível"}</strong> · slug: <span className="mono">{workspace.data?.slug || "Não informado"}</span></p>
      <InstanceContext label="Instância da publicação" />
      <p>Publicar nova Release: congela o rascunho atual; não implanta em nós.</p>
    </div>
    <p>Publicar congela o rascunho em uma release imutável e a torna ativa para um futuro deployment. Publicar não implanta, não cria deployment e não altera os snapshots nem a publicação v1.</p>
    <div className="note stack" id={impactId}>
      <h3>Impacto nos valores locais</h3>
      <p>Valores locais de variáveis cujas declarações foram removidas do rascunho serão apagados ao publicar. Esta tela não consegue listar quais; consulte a auditoria depois.</p>
    </div>
    <Field label="Resumo (opcional)">{(id) => <input id={id} value={message} disabled={publish.isPending} onChange={(e) => setMessage(e.target.value)} />}</Field>
    <label className="check" htmlFor={acknowledgementId}>
      <input id={acknowledgementId} type="checkbox" checked={acknowledged} disabled={publish.isPending} aria-describedby={impactId} onChange={(e) => setAcknowledged(e.target.checked)} />
      Entendi que publicar apaga os valores locais das declarações removidas.
    </label>
    {access.reason && <p role="status">{access.reason}</p>}
    {publish.isError && <div className="error" role="alert">{releaseErrors(publish.error).map((text, i) => <p key={i}>{text}</p>)}</div>}
  </Modal>;
}
