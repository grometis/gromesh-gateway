import { useState, type ChangeEvent, type FormEvent } from "react";
import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { api, unwrap, type Schemas } from "../api/client";
import { statusMessage, toFormErrors, type FormErrors } from "../api/errors";
import { useCanEdit } from "../auth";
import { Field, FormErrorList } from "../components/Field";
import { ConfirmDialog, Modal } from "../components/Modal";
import { useEnvId } from "../components/Shell";
import { splitList, useInvalidateDraft } from "./Services";

type Certificate = Schemas["Certificate"];
type CertificateWrite = Schemas["CertificateWrite"];

const FIELDS = ["cert", "key", "snis", "tags"] as const;
const DAY_MS = 86_400_000;
const WARN_DAYS = 30;
const when = (iso: string) => new Date(iso).toLocaleDateString("pt-BR");

/** Days until the leaf expires (negative once expired). */
export function daysLeft(notAfter: string, now = Date.now()): number {
  return Math.floor((Date.parse(notAfter) - now) / DAY_MS);
}

function Expiry({ notAfter }: { notAfter: string }) {
  const days = daysLeft(notAfter);
  if (days < 0) return <span className="badge danger">Expirado em {when(notAfter)}</span>;
  if (days < WARN_DAYS) return <span className="badge warning">Expira em {days} dia(s) ({when(notAfter)})</span>;
  return <span>{when(notAfter)}</span>;
}

export function CertificatesPage() {
  const envId = useEnvId();
  const canEdit = useCanEdit();
  const certs = useInfiniteQuery({
    queryKey: ["certificates", envId],
    queryFn: ({ pageParam }) =>
      unwrap(api.GET("/environments/{envId}/certificates", { params: { path: { envId }, query: pageParam ? { cursor: pageParam } : {} } })),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const [editing, setEditing] = useState<Certificate | "new" | null>(null);
  const [deleting, setDeleting] = useState<Certificate | null>(null);
  const items = certs.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <section>
      <div className="page-head">
        <h1>Certificados</h1>
        {canEdit && (
          <button type="button" className="primary" onClick={() => setEditing("new")}>
            Novo certificado
          </button>
        )}
      </div>
      <p className="muted">A chave privada só é enviada; depois de salva, nunca é exibida de novo.</p>
      {certs.isPending && <p className="muted">Carregando…</p>}
      {certs.isError && <p className="error">{statusMessage(certs.error)}</p>}
      {certs.isSuccess && items.length === 0 && <p className="muted">Nenhum certificado ainda.</p>}
      {items.length > 0 && (
        <table aria-label="Certificados">
          <thead>
            <tr>
              <th>SNIs</th>
              <th>Assunto</th>
              <th>Emissor</th>
              <th>Validade</th>
              <th aria-label="Ações" />
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr key={c.id}>
                <td className="mono">{c.snis.length > 0 ? c.snis.join(", ") : <span className="muted">nenhum</span>}</td>
                <td>{c.subject}</td>
                <td>{c.issuer}</td>
                <td>
                  <Expiry notAfter={c.notAfter} />
                </td>
                <td className="actions">
                  {canEdit && (
                    <>
                      <button type="button" onClick={() => setEditing(c)}>
                        Editar
                      </button>
                      <button type="button" className="danger" onClick={() => setDeleting(c)}>
                        Excluir
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {certs.hasNextPage && (
        <button type="button" onClick={() => void certs.fetchNextPage()} disabled={certs.isFetchingNextPage}>
          Carregar mais
        </button>
      )}
      {editing && <CertificateForm envId={envId} certificate={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {deleting && <DeleteCertificate envId={envId} certificate={deleting} onClose={() => setDeleting(null)} />}
    </section>
  );
}

/** Reads a dropped/selected PEM file into a form field. */
function readFile(e: ChangeEvent<HTMLInputElement>, onText: (text: string) => void) {
  const file = e.target.files?.[0];
  if (file) void file.text().then(onText);
}

function CertificateForm({ envId, certificate, onClose }: { envId: string; certificate: Certificate | null; onClose: () => void }) {
  const invalidate = useInvalidateDraft(envId);
  const [form, setForm] = useState({
    cert: certificate?.cert ?? "",
    // Never prefilled: the stored key is write-only. Empty on an edit keeps it ("REDACTED").
    key: "",
    snis: (certificate?.snis ?? []).join(", "),
    tags: (certificate?.tags ?? []).join(", "),
  });
  const [errors, setErrors] = useState<FormErrors>({ fields: {}, form: [] });
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const save = useMutation({
    mutationFn: () => {
      const body: CertificateWrite = {
        cert: form.cert,
        key: certificate && !form.key.trim() ? "REDACTED" : form.key,
        snis: splitList(form.snis).map((s) => s.toLowerCase()),
        tags: splitList(form.tags),
      };
      return certificate
        ? unwrap(api.PUT("/environments/{envId}/certificates/{certificateId}", { params: { path: { envId, certificateId: certificate.id } }, body }))
        : unwrap(api.POST("/environments/{envId}/certificates", { params: { path: { envId } }, body }));
    },
    onSuccess: () => {
      invalidate("certificates");
      onClose();
    },
    onError: (err) => setErrors(toFormErrors(err, FIELDS)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setErrors({ fields: {}, form: [] });
    save.mutate();
  };

  return (
    <Modal title={certificate ? "Editar certificado" : "Novo certificado"} onClose={onClose} wide>
      <form onSubmit={submit} className="form" noValidate>
        <Field label="Certificado (PEM)" errors={errors.fields.cert} hint="O certificado do servidor primeiro, depois os intermediários">
          {(id, invalid) => <textarea id={id} aria-invalid={invalid} rows={6} className="mono" value={form.cert} onChange={(e) => set("cert", e.target.value)} />}
        </Field>
        <label className="file">
          Carregar arquivo do certificado <input type="file" accept=".pem,.crt,.cer" aria-label="Arquivo do certificado" onChange={(e) => readFile(e, (t) => set("cert", t))} />
        </label>
        <Field
          label="Chave privada (PEM)"
          errors={errors.fields.key}
          hint={certificate ? "Deixe em branco para manter a chave atual; ela nunca é exibida" : "Enviada uma vez; nunca é exibida de novo"}
        >
          {(id, invalid) => (
            <textarea
              id={id}
              aria-invalid={invalid}
              rows={4}
              className="mono"
              autoComplete="off"
              spellCheck={false}
              placeholder={certificate ? "•••••• (chave atual mantida)" : ""}
              value={form.key}
              onChange={(e) => set("key", e.target.value)}
            />
          )}
        </Field>
        <label className="file">
          Carregar arquivo da chave <input type="file" accept=".pem,.key" aria-label="Arquivo da chave" onChange={(e) => readFile(e, (t) => set("key", t))} />
        </label>
        <Field label="SNIs" errors={errors.fields.snis} hint="Nomes separados por vírgula; curinga só como prefixo, ex.: *.exemplo.com">
          {(id, invalid) => <input id={id} aria-invalid={invalid} value={form.snis} onChange={(e) => set("snis", e.target.value)} />}
        </Field>
        <Field label="Tags" errors={errors.fields.tags} hint="Separadas por vírgula">
          {(id, invalid) => <input id={id} aria-invalid={invalid} value={form.tags} onChange={(e) => set("tags", e.target.value)} />}
        </Field>
        <FormErrorList messages={errors.form} />
        <div className="form-actions">
          <button type="button" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="primary" disabled={save.isPending}>
            {save.isPending ? "Salvando…" : "Salvar"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteCertificate({ envId, certificate, onClose }: { envId: string; certificate: Certificate; onClose: () => void }) {
  const invalidate = useInvalidateDraft(envId);
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE("/environments/{envId}/certificates/{certificateId}", { params: { path: { envId, certificateId: certificate.id } } })),
    onSuccess: () => {
      invalidate("certificates");
      onClose();
    },
  });
  return (
    <ConfirmDialog
      title="Excluir certificado"
      message={
        <>
          Excluir o certificado de <strong>{certificate.snis.join(", ") || certificate.subject}</strong> e seus SNIs? A exclusão só afeta o tráfego depois de publicar.
        </>
      }
      confirmLabel="Excluir"
      busy={remove.isPending}
      error={remove.isError ? statusMessage(remove.error) : null}
      onConfirm={() => remove.mutate()}
      onClose={onClose}
    />
  );
}
