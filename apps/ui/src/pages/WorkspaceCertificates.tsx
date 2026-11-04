import { useEffect, useRef, useState, type FormEvent } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../api/client";
import type { FormErrors } from "../api/errors";
import { useWorkspaceId } from "../navigation/context";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { Field, FormErrorList } from "../components/Field";
import { ConfirmDialog, Modal } from "../components/Modal";
import { PageHeader } from "../components/PageHeader";
import { RowMenu } from "../components/RowMenu";
import { Table } from "../components/Table";
import { canWriteWorkspaceGateway, useWorkspaceGatewayAccess } from "./workspace-gateway";
import { certificateErrorMessage, certificateErrors, deleteWorkspaceCertificate, listWorkspaceCertificates, saveWorkspaceCertificate, type CertificateFormValue, type WorkspaceCertificate } from "./workspace-certificates";

const NO_ERRORS: FormErrors = { fields: {}, form: [] };
const nameOf = (certificate: WorkspaceCertificate) => certificate.subject || certificate.snis[0] || certificate.id;
const dateText = (value: string | null | undefined) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString("pt-BR") : "Indisponível";

function Expiry({ certificate }: { certificate: WorkspaceCertificate }) {
  const value = certificate.notAfter;
  if (typeof certificate.cert !== "string" || !value || !Number.isFinite(Date.parse(value))) return <span className="muted">Validade indisponível</span>;
  const remaining = Date.parse(value) - Date.now();
  if (remaining <= 0) return <Badge tone="danger">Expirado em {dateText(value)}</Badge>;
  const days = Math.ceil(remaining / 86_400_000);
  if (days < 30) return <Badge tone="warning">Expira em {days} dia(s) ({dateText(value)})</Badge>;
  return <span className="mono">{dateText(value)}</span>;
}

export function WorkspaceCertificatesPage() {
  const workspaceId = useWorkspaceId();
  return <WorkspaceCertificates key={workspaceId} workspaceId={workspaceId} />;
}

function WorkspaceCertificates({ workspaceId }: { workspaceId: string }) {
  const access = useWorkspaceGatewayAccess(workspaceId);
  const client = useQueryClient();
  const certificates = useInfiniteQuery({
    queryKey: ["ws-certificates", workspaceId],
    queryFn: ({ pageParam, signal }) => listWorkspaceCertificates(workspaceId, pageParam, signal),
    initialPageParam: "", getNextPageParam: page => page.nextCursor ?? undefined,
  });
  const [editing, setEditing] = useState<WorkspaceCertificate | "new" | null>(null);
  const [deleting, setDeleting] = useState<WorkspaceCertificate | null>(null);
  const [viewing, setViewing] = useState<WorkspaceCertificate | null>(null);
  const [writeDenied, setWriteDenied] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const deletingRef = useRef<{ pending: boolean } | null>(null);
  const canWrite = access.canWrite && !writeDenied && certificates.isSuccess;
  const keepForm = access.canWrite || access.isRevalidating;
  // A definitive context denial discards any draft, including an entered private key.
  useEffect(() => { if (!keepForm) { setEditing(null); deletingRef.current = null; setDeleting(null); setBusy(false); } }, [keepForm]);
  const invalidate = () => {
    for (const key of ["ws-certificates", "certificates", "environment", "preview"]) void client.invalidateQueries({ queryKey: [key, workspaceId] });
  };
  const revalidate = () => { void client.invalidateQueries({ queryKey: ["workspace", workspaceId] }); };
  const openEdit = (current: WorkspaceCertificate | "new") => {
    if (!canWriteWorkspaceGateway(client, workspaceId, true) || writeDenied || !certificates.isSuccess) return;
    setEditing(current); revalidate();
  };
  const openDelete = (current: WorkspaceCertificate) => {
    if (!canWriteWorkspaceGateway(client, workspaceId, true) || writeDenied) return;
    deletingRef.current = { pending: false };
    setBusy(false); setDeleteError(null); setDeleting(current); revalidate();
  };
  const closeDelete = () => {
    deletingRef.current = null;
    setDeleting(null); setBusy(false);
  };
  const remove = async () => {
    const operation = deletingRef.current;
    if (!deleting || !operation || operation.pending || writeDenied || !canWriteWorkspaceGateway(client, workspaceId, true)) return;
    operation.pending = true; setBusy(true); setDeleteError(null);
    try {
      await deleteWorkspaceCertificate(workspaceId, deleting.id);
      // A committed deletion refreshes the list even after its confirmation was closed.
      invalidate();
      if (deletingRef.current === operation) closeDelete();
    } catch (error) {
      if (deletingRef.current === operation) { setDeleteError(certificateErrorMessage(error)); if (error instanceof ApiError && error.status === 403) setWriteDenied(true); }
    } finally {
      operation.pending = false;
      if (deletingRef.current === operation) setBusy(false);
    }
  };
  const items = certificates.isError ? [] : certificates.data?.pages.flatMap(page => page.items) ?? [];
  return <section className="final-page gateway-list certificates-page workspace-certificates-page">
    <PageHeader title="Certificados" description="Certificados e SNIs deste Workspace. A chave privada nunca é exibida depois de salva."
      actions={canWrite && <Button variant="primary" onClick={() => openEdit("new")}>Novo certificado</Button>} />
    <p className="note">As alterações ficam no rascunho do Workspace.</p>
    {access.reason && <p role="status">{access.reason}</p>}
    {writeDenied && <p role="status">Somente leitura: você não tem permissão para alterar certificados deste Workspace.</p>}
    {certificates.isPending && <p role="status">Carregando certificados…</p>}
    {certificates.isError && <div role="alert" className="error"><p>{certificateErrorMessage(certificates.error)}</p><Button onClick={() => void certificates.refetch()}>Tentar novamente</Button></div>}
    {certificates.isSuccess && !items.length && <EmptyState title="Nenhum certificado neste Workspace." text="Adicione um certificado PEM e sua chave privada para configurar os SNIs." />}
    {!!items.length && <Table label="Certificados" cards>
      <thead><tr><th>Assunto → SNIs / validade</th><th className="actions" aria-label="Ações" /></tr></thead>
      <tbody>{items.map(certificate => <tr key={certificate.id}>
        <td className="row-main">
          <div className="service-route"><span className="service-name mono">{nameOf(certificate)}</span><span className="arrow" aria-hidden="true">→</span><span className="target mono">{certificate.snis.length ? certificate.snis.join(", ") : "Nenhum SNI"}</span></div>
          <div className="route-matches"><span className="muted">Emissor</span><span className="mono">{certificate.issuer || "Indisponível"}</span><span className="muted">Validade</span><Expiry certificate={certificate} /></div>
        </td>
        <td className="actions"><Button variant="quiet" onClick={() => setViewing(certificate)}>Ver metadados</Button>
          {canWrite && <><Button variant="quiet" onClick={() => openEdit(certificate)}>Editar</Button><RowMenu label={`Mais ações para ${nameOf(certificate)}`} items={[{ label: "Excluir", danger: true, onSelect: () => openDelete(certificate) }]} /></>}
        </td>
      </tr>)}</tbody>
    </Table>}
    {certificates.hasNextPage && <Button disabled={certificates.isFetchingNextPage} onClick={() => void certificates.fetchNextPage()}>Carregar mais</Button>}
    {viewing && <Modal title="Metadados do certificado" onClose={() => setViewing(null)}>
      <dl className="certificate-metadata">
        {([
          ["Assunto", viewing.subject || "Indisponível"], ["Emissor", viewing.issuer || "Indisponível"],
          ["SNIs", viewing.snis.join(", ") || "Nenhum SNI"],
          ["Válido a partir de", typeof viewing.cert === "string" ? dateText(viewing.notBefore) : "Indisponível"],
          ["Válido até", typeof viewing.cert === "string" ? dateText(viewing.notAfter) : "Indisponível"],
          ["Impressão digital SHA-256", viewing.fingerprintSha256 || "Indisponível"], ["Tags", viewing.tags?.join(", ") || "Nenhuma"],
        ] as const).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>
    </Modal>}
    {editing && keepForm && <CertificateEditor workspaceId={workspaceId} certificate={editing === "new" ? null : editing} denied={writeDenied} onForbidden={() => setWriteDenied(true)} onClose={() => setEditing(null)} onCommitted={invalidate} />}
    {deleting && keepForm && <ConfirmDialog title="Excluir certificado" message={<>Excluir o certificado de <strong>{deleting.snis.join(", ") || nameOf(deleting)}</strong> e seus SNIs do rascunho deste Workspace?</>} confirmLabel="Excluir" busy={busy} confirmDisabled={!canWrite} error={deleteError} onConfirm={() => void remove()} onClose={closeDelete} />}
  </section>;
}

function CertificateEditor({ workspaceId, certificate, denied, onForbidden, onClose, onCommitted }: {
  workspaceId: string; certificate: WorkspaceCertificate | null; denied: boolean; onForbidden: () => void; onClose: () => void; onCommitted: () => void;
}) {
  const access = useWorkspaceGatewayAccess(workspaceId);
  const client = useQueryClient();
  const [form, setForm] = useState<CertificateFormValue>({ cert: typeof certificate?.cert === "string" ? certificate.cert : "", key: "", snis: certificate?.snis.join(", ") ?? "", tags: certificate?.tags?.join(", ") ?? "" });
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const set = (key: keyof CertificateFormValue, value: string) => setForm(current => ({ ...current, [key]: value }));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending.current || denied || !canWriteWorkspaceGateway(client, workspaceId, true)) return;
    pending.current = true; setBusy(true); setErrors(NO_ERRORS);
    try {
      await saveWorkspaceCertificate(workspaceId, certificate?.id ?? null, form);
      onCommitted();
      if (mounted.current) { setForm({ cert: "", key: "", snis: "", tags: "" }); onClose(); }
    } catch (error) {
      if (mounted.current) { setForm(current => ({ ...current, key: "" })); setErrors(certificateErrors(error)); if (error instanceof ApiError && error.status === 403) onForbidden(); }
    } finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  return <Modal title={certificate ? "Editar certificado" : "Novo certificado"} onClose={onClose} wide>
    <form className="form" noValidate onSubmit={event => void submit(event)}>
      <p>Envie o certificado e a chave em formato PEM. Referências a variáveis ainda não estão disponíveis.</p>
      {access.reason && <p role="status">{access.reason}</p>}
      <fieldset disabled={busy || denied || (!access.canWrite && !access.isRevalidating)}>
        <legend>Certificado e chave privada</legend>
        <Field label="Certificado (PEM)" errors={errors.fields.cert} hint="Certificado do servidor primeiro, depois os intermediários.">{(id, invalid) => <textarea id={id} aria-invalid={invalid} className="mono" rows={6} value={form.cert} onChange={event => set("cert", event.target.value)} spellCheck={false} />}</Field>
        <Field label="Chave privada (PEM)" errors={errors.fields.key} hint={certificate ? "Deixe em branco para manter a chave atual. Ela nunca é exibida." : "Obrigatória na criação. A chave nunca é exibida depois de salva."}>{(id, invalid) => <textarea id={id} aria-invalid={invalid} className="mono" rows={4} value={form.key} onChange={event => set("key", event.target.value)} autoComplete="off" spellCheck={false} />}</Field>
        <Field label="SNIs" errors={errors.fields.snis} hint="Separados por vírgula; únicos na instância. Curinga somente como prefixo *.exemplo.com.">{(id, invalid) => <input id={id} aria-invalid={invalid} value={form.snis} onChange={event => set("snis", event.target.value)} />}</Field>
        <Field label="Tags" errors={errors.fields.tags} hint="Separadas por vírgula.">{(id, invalid) => <input id={id} aria-invalid={invalid} value={form.tags} onChange={event => set("tags", event.target.value)} />}</Field>
      </fieldset>
      <FormErrorList messages={errors.form} />
      <div className="form-actions"><Button onClick={onClose}>Cancelar</Button><Button type="submit" variant="primary" disabled={busy || denied || !access.canWrite}>{busy ? "Salvando…" : "Salvar no rascunho"}</Button></div>
    </form>
  </Modal>;
}
