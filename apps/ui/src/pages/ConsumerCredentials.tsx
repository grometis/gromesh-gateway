import { useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, unwrap, type BasicAuthCredential, type Consumer, type JwtCredential } from "../api/client";
import { statusMessage, toFormErrors, type FormErrors } from "../api/errors";
import { Field, FormErrorList } from "../components/Field";
import { createdAt, CredentialCard, SecretOnce } from "../components/Credentials";
import { ConfirmDialog, Modal } from "../components/Modal";
import { splitList, useInvalidateDraft } from "./Services";

const GROUP_RE = /^[a-z0-9_-]{1,64}$/;
const noErrors: FormErrors = { fields: {}, form: [] };

/* ---------------- JWT ---------------- */

export function JwtCredentials({ envId, consumer, canEdit }: { envId: string; consumer: Consumer; canEdit: boolean }) {
  const invalidate = useInvalidateDraft(envId);
  const path = { envId, consumerId: consumer.id };
  const credentials = useQuery({
    queryKey: ["jwt", envId, consumer.id],
    queryFn: () => unwrap(api.GET("/environments/{envId}/consumers/{consumerId}/jwt", { params: { path } })),
  });
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<JwtCredential | null>(null);
  const items = credentials.data?.items ?? [];

  return (
    <section aria-label="Credenciais JWT" className="cred-section">
      <div className="cred-head">
        <h2>JWT</h2>
        {canEdit && (
          <button type="button" className="primary" onClick={() => setCreating(true)}>
            Nova credencial JWT
          </button>
        )}
      </div>
      {credentials.isPending && <p className="muted">Carregando…</p>}
      {credentials.isError && <p className="error">{statusMessage(credentials.error)}</p>}
      {credentials.isSuccess && items.length === 0 && <p className="muted">Nenhuma credencial JWT.</p>}
      {items.length > 0 && (
        <ul className="cred-list" aria-label="Credenciais JWT">
          {items.map((j) => (
            <CredentialCard
              key={j.id}
              hint={
                <>
                  <span className="mono">{j.key}</span> <span className="badge no-nodes">{j.algorithm}</span>
                </>
              }
              meta={createdAt(j.createdAt)}
              deleteLabel={`Mais ações para a credencial JWT ${j.key}`}
              onDelete={canEdit ? () => setDeleting(j) : undefined}
            />
          ))}
        </ul>
      )}
      {creating && (
        <NewJwt
          envId={envId}
          consumerId={consumer.id}
          onDone={() => {
            invalidate("jwt");
            setCreating(false);
          }}
        />
      )}
      {deleting && (
        <DeleteCredential
          title="Excluir credencial JWT"
          what={<>a credencial JWT <span className="mono">{deleting.key}</span></>}
          remove={() =>
            unwrap(api.DELETE("/environments/{envId}/consumers/{consumerId}/jwt/{credentialId}", { params: { path: { ...path, credentialId: deleting.id } } }))
          }
          onClose={() => setDeleting(null)}
          onDeleted={() => invalidate("jwt")}
        />
      )}
    </section>
  );
}

/**
 * Like the key-auth key, an HS256 secret exists only in this component's state: shown once after the 201, dropped
 * when the dialog closes (never in the query or mutation cache, nor in storage).
 */
function NewJwt({ envId, consumerId, onDone }: { envId: string; consumerId: string; onDone: () => void }) {
  const [form, setForm] = useState({ key: "", algorithm: "HS256" as JwtCredential["algorithm"], secret: "", rsaPublicKey: "" });
  const [errors, setErrors] = useState<FormErrors>(noErrors);
  const hs = form.algorithm === "HS256";
  const create = useMutation({
    // The response carries the secret: evict it from the mutation cache as soon as the dialog lets go of it.
    gcTime: 0,
    mutationFn: () =>
      unwrap(
        api.POST("/environments/{envId}/consumers/{consumerId}/jwt", {
          params: { path: { envId, consumerId } },
          body: {
            algorithm: form.algorithm,
            ...(form.key.trim() ? { key: form.key.trim() } : {}),
            ...(hs ? (form.secret ? { secret: form.secret } : {}) : { rsaPublicKey: form.rsaPublicKey.trim() + "\n" }),
          },
        }),
      ),
    onSuccess: (created) => {
      setForm((f) => ({ ...f, secret: "" }));
      if (!created.secret) close();
    },
    onError: (err) => setErrors(toFormErrors(err, ["key", "algorithm", "secret", "rsaPublicKey"])),
  });
  const close = () => {
    create.reset();
    onDone();
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const fields: Record<string, string[]> = {};
    if (hs && form.secret && form.secret.length < 32) fields.secret = ["Use pelo menos 32 caracteres."];
    if (!hs && !form.rsaPublicKey.includes("PUBLIC KEY")) fields.rsaPublicKey = ["Cole a chave pública em PEM."];
    setErrors({ fields, form: [] });
    if (Object.keys(fields).length === 0) create.mutate();
  };

  if (create.data?.secret) {
    return (
      <SecretOnce
        title="Credencial JWT criada"
        label="Segredo"
        secret={create.data.secret}
        note={
          <>
            Copie o segredo agora. Ele não será mostrado de novo. Os tokens devem ter <span className="mono">iss</span> = <span className="mono">{create.data.key}</span>.
          </>
        }
        onClose={close}
      />
    );
  }

  return (
    <Modal title="Nova credencial JWT" onClose={close}>
      <form className="form" noValidate onSubmit={submit}>
        <Field label="Key (iss)" errors={errors.fields.key} hint="Opcional. Vazio = uma key aleatória é gerada.">
          {(id, invalid) => <input id={id} aria-invalid={invalid} value={form.key} onChange={(e) => setForm((f) => ({ ...f, key: e.target.value }))} />}
        </Field>
        <Field label="Algoritmo" errors={errors.fields.algorithm}>
          {(id) => (
            <select id={id} value={form.algorithm} onChange={(e) => setForm((f) => ({ ...f, algorithm: e.target.value as JwtCredential["algorithm"] }))}>
              <option value="HS256">HS256 (segredo compartilhado)</option>
              <option value="RS256">RS256 (chave pública RSA)</option>
              <option value="ES256">ES256 (chave pública EC P-256)</option>
            </select>
          )}
        </Field>
        {hs ? (
          <Field label="Segredo" errors={errors.fields.secret} hint="Opcional. Vazio = um segredo forte é gerado e mostrado uma única vez.">
            {(id, invalid) => <input id={id} type="password" autoComplete="off" aria-invalid={invalid} value={form.secret} onChange={(e) => setForm((f) => ({ ...f, secret: e.target.value }))} />}
          </Field>
        ) : (
          <Field label="Chave pública (PEM)" errors={errors.fields.rsaPublicKey}>
            {(id, invalid) => (
              <textarea id={id} rows={6} className="mono" aria-invalid={invalid} value={form.rsaPublicKey} onChange={(e) => setForm((f) => ({ ...f, rsaPublicKey: e.target.value }))} />
            )}
          </Field>
        )}
        <FormErrorList messages={errors.form} />
        <div className="form-actions">
          <button type="button" onClick={close}>
            Cancelar
          </button>
          <button type="submit" className="primary" disabled={create.isPending}>
            {create.isPending ? "Criando…" : "Criar"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ---------------- basic-auth ---------------- */

export function BasicAuthCredentials({ envId, consumer, canEdit }: { envId: string; consumer: Consumer; canEdit: boolean }) {
  const invalidate = useInvalidateDraft(envId);
  const path = { envId, consumerId: consumer.id };
  const credentials = useQuery({
    queryKey: ["basicauth", envId, consumer.id],
    queryFn: () => unwrap(api.GET("/environments/{envId}/consumers/{consumerId}/basic-auth", { params: { path } })),
  });
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<BasicAuthCredential | null>(null);
  const items = credentials.data?.items ?? [];

  return (
    <section aria-label="Credenciais basic-auth" className="cred-section">
      <div className="cred-head">
        <h2>Basic-auth</h2>
        {canEdit && (
          <button type="button" className="primary" onClick={() => setCreating(true)}>
            Nova credencial basic-auth
          </button>
        )}
      </div>
      {credentials.isPending && <p className="muted">Carregando…</p>}
      {credentials.isError && <p className="error">{statusMessage(credentials.error)}</p>}
      {credentials.isSuccess && items.length === 0 && <p className="muted">Nenhuma credencial basic-auth.</p>}
      {items.length > 0 && (
        <ul className="cred-list" aria-label="Credenciais basic-auth">
          {items.map((b) => (
            <CredentialCard
              key={b.id}
              hint={<span className="mono">{b.username}</span>}
              meta={createdAt(b.createdAt)}
              deleteLabel={`Mais ações para o usuário ${b.username}`}
              onDelete={canEdit ? () => setDeleting(b) : undefined}
            />
          ))}
        </ul>
      )}
      {creating && (
        <NewBasicAuth
          envId={envId}
          consumerId={consumer.id}
          onDone={() => {
            invalidate("basicauth");
            setCreating(false);
          }}
        />
      )}
      {deleting && (
        <DeleteCredential
          title="Excluir credencial basic-auth"
          what={<>a credencial do usuário <span className="mono">{deleting.username}</span></>}
          remove={() =>
            unwrap(api.DELETE("/environments/{envId}/consumers/{consumerId}/basic-auth/{credentialId}", { params: { path: { ...path, credentialId: deleting.id } } }))
          }
          onClose={() => setDeleting(null)}
          onDeleted={() => invalidate("basicauth")}
        />
      )}
    </section>
  );
}

/** The password goes to the API once and is cleared from state right after: it is never shown or read back. */
function NewBasicAuth({ envId, consumerId, onDone }: { envId: string; consumerId: string; onDone: () => void }) {
  const [form, setForm] = useState({ username: "", password: "" });
  const [errors, setErrors] = useState<FormErrors>(noErrors);
  const create = useMutation({
    mutationFn: () =>
      unwrap(api.POST("/environments/{envId}/consumers/{consumerId}/basic-auth", { params: { path: { envId, consumerId } }, body: { username: form.username.trim(), password: form.password } })),
    onSuccess: () => {
      setForm({ username: "", password: "" });
      onDone();
    },
    onError: (err) => setErrors(toFormErrors(err, ["username", "password"])),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const fields: Record<string, string[]> = {};
    if (!form.username.trim()) fields.username = ["Informe o usuário."];
    if (form.password.length < 8) fields.password = ["Use pelo menos 8 caracteres."];
    setErrors({ fields, form: [] });
    if (Object.keys(fields).length === 0) create.mutate();
  };
  return (
    <Modal title="Nova credencial basic-auth" onClose={onDone}>
      <form className="form" noValidate onSubmit={submit}>
        <Field label="Usuário" errors={errors.fields.username} hint="Único no ambiente">
          {(id, invalid) => <input id={id} autoComplete="off" aria-invalid={invalid} value={form.username} onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))} />}
        </Field>
        <Field label="Senha" errors={errors.fields.password} hint="Não é mostrada nem guardada: o gateway recebe só um hash dela.">
          {(id, invalid) => <input id={id} type="password" autoComplete="new-password" aria-invalid={invalid} value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} />}
        </Field>
        <FormErrorList messages={errors.form} />
        <div className="form-actions">
          <button type="button" onClick={onDone}>
            Cancelar
          </button>
          <button type="submit" className="primary" disabled={create.isPending}>
            {create.isPending ? "Criando…" : "Criar"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ---------------- ACL groups ---------------- */

export function AclGroupsPanel({ envId, consumer, canEdit }: { envId: string; consumer: Consumer; canEdit: boolean }) {
  const invalidate = useInvalidateDraft(envId);
  const path = { envId, consumerId: consumer.id };
  const groups = useQuery({
    queryKey: ["aclgroups", envId, consumer.id],
    queryFn: () => unwrap(api.GET("/environments/{envId}/consumers/{consumerId}/acl-groups", { params: { path } })),
  });
  const [draft, setDraft] = useState<string | null>(null);
  const [errors, setErrors] = useState<FormErrors>(noErrors);
  const save = useMutation({
    mutationFn: (list: string[]) => unwrap(api.PUT("/environments/{envId}/consumers/{consumerId}/acl-groups", { params: { path }, body: { groups: list } })),
    onSuccess: () => {
      invalidate("aclgroups");
      setDraft(null);
    },
    onError: (err) => setErrors(toFormErrors(err, ["groups"])),
  });
  const current = groups.data?.groups ?? [];
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const list = [...new Set(splitList(draft ?? ""))];
    const bad = list.filter((g) => !GROUP_RE.test(g));
    if (bad.length > 0) {
      setErrors({ fields: { groups: [`Nomes inválidos: ${bad.join(", ")}. Use letras minúsculas, dígitos, "_" ou "-" (até 64).`] }, form: [] });
      return;
    }
    setErrors(noErrors);
    save.mutate(list);
  };

  return (
    <section aria-label="Grupos ACL">
      <div className="page-head">
        <h2>Grupos ACL</h2>
        {canEdit && draft === null && (
          <button type="button" className="primary" onClick={() => setDraft(current.join(", "))}>
            Editar grupos
          </button>
        )}
      </div>
      <p className="muted">O plugin acl libera ou bloqueia o consumer pelos nomes destes grupos (allow/deny).</p>
      {groups.isPending && <p className="muted">Carregando…</p>}
      {groups.isError && <p className="error">{statusMessage(groups.error)}</p>}
      {groups.isSuccess && draft === null && (current.length === 0 ? <p className="muted">Nenhum grupo.</p> : (
        <ul className="tags" aria-label="Grupos">
          {current.map((g) => (
            <li key={g} className="mono">
              {g}
            </li>
          ))}
        </ul>
      ))}
      {draft !== null && (
        <form className="form" noValidate onSubmit={submit}>
          <Field label="Grupos" errors={errors.fields.groups} hint="Separados por vírgula. Salvar substitui o conjunto inteiro.">
            {(id, invalid) => <input id={id} aria-invalid={invalid} value={draft} onChange={(e) => setDraft(e.target.value)} />}
          </Field>
          <FormErrorList messages={errors.form} />
          <div className="form-actions">
            <button type="button" onClick={() => setDraft(null)}>
              Cancelar
            </button>
            <button type="submit" className="primary" disabled={save.isPending}>
              {save.isPending ? "Salvando…" : "Salvar grupos"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

/* ---------------- shared ---------------- */

function DeleteCredential(props: { title: string; what: ReactNode; remove: () => Promise<unknown>; onClose: () => void; onDeleted: () => void }) {
  const remove = useMutation({
    mutationFn: props.remove,
    onSuccess: () => {
      props.onDeleted();
      props.onClose();
    },
  });
  return (
    <ConfirmDialog
      title={props.title}
      message={<>Excluir {props.what}? Quem a usa deixa de ter acesso depois de publicar.</>}
      confirmLabel="Excluir"
      busy={remove.isPending}
      error={remove.isError ? statusMessage(remove.error) : null}
      onConfirm={() => remove.mutate()}
      onClose={props.onClose}
    />
  );
}
