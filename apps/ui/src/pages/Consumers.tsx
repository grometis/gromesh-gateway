import { useDeferredValue, useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router";
import { api, unwrap, type Consumer, type ConsumerWrite, type KeyAuthCredential } from "../api/client";
import { consumerName, useConsumers } from "../api/lists";
import { statusMessage, toFormErrors, type FormErrors } from "../api/errors";
import { useCanEdit } from "../auth";
import { Field, FormErrorList } from "../components/Field";
import { ConfirmDialog, Modal } from "../components/Modal";
import { useEnvId } from "../components/Shell";
import { AclGroupsPanel, BasicAuthCredentials, JwtCredentials } from "./ConsumerCredentials";
import { ScopedPlugins } from "./Plugins";
import { splitList, useInvalidateDraft } from "./Services";

const FIELDS = ["username", "customId", "tags"] as const;

export function ConsumersPage() {
  const envId = useEnvId();
  const canEdit = useCanEdit();
  const [search, setSearch] = useState("");
  const q = useDeferredValue(search.trim());
  const consumers = useConsumers(envId, q);
  const [editing, setEditing] = useState<Consumer | "new" | null>(null);
  const [deleting, setDeleting] = useState<Consumer | null>(null);
  const navigate = useNavigate();
  const items = consumers.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <section>
      <div className="page-head">
        <h1>Consumers</h1>
        {canEdit && (
          <button type="button" className="primary" onClick={() => setEditing("new")}>
            Novo consumer
          </button>
        )}
      </div>
      <input type="search" className="search" placeholder="Buscar por username ou custom id" aria-label="Buscar consumers" value={search} onChange={(e) => setSearch(e.target.value)} />
      {consumers.isPending && <p className="muted">Carregando…</p>}
      {consumers.isError && <p className="error">{statusMessage(consumers.error)}</p>}
      {consumers.isSuccess && items.length === 0 && <p className="muted">{q ? "Nenhum consumer encontrado." : "Nenhum consumer ainda."}</p>}
      {items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Username</th>
              <th>Custom id</th>
              <th>Tags</th>
              <th aria-label="Ações" />
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr key={c.id}>
                <td>
                  <Link to={c.id}>{consumerName(c)}</Link>
                </td>
                <td className="mono">{c.customId ?? "—"}</td>
                <td>{c.tags?.join(", ") || "—"}</td>
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
      {consumers.hasNextPage && (
        <button type="button" onClick={() => void consumers.fetchNextPage()} disabled={consumers.isFetchingNextPage}>
          Carregar mais
        </button>
      )}
      {editing && (
        <ConsumerForm
          envId={envId}
          consumer={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          // A new consumer usually needs a credential next: open its screen.
          onCreated={(c) => navigate(c.id)}
        />
      )}
      {deleting && <DeleteConsumer envId={envId} consumer={deleting} onClose={() => setDeleting(null)} />}
    </section>
  );
}

export function ConsumerDetailPage() {
  const envId = useEnvId();
  const { consumerId } = useParams();
  const canEdit = useCanEdit();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const consumer = useQuery({
    queryKey: ["consumers", envId, "detail", consumerId],
    queryFn: () => unwrap(api.GET("/environments/{envId}/consumers/{consumerId}", { params: { path: { envId, consumerId: consumerId! } } })),
  });

  if (consumer.isPending) return <p className="muted">Carregando…</p>;
  if (consumer.isError) return <p className="error">{statusMessage(consumer.error)}</p>;
  const c = consumer.data;
  return (
    <section className="stack">
      <p>
        <Link to="..">← Consumers</Link>
      </p>
      <div className="page-head">
        <h1>Consumer {consumerName(c)}</h1>
        {canEdit && (
          <div className="form-actions">
            <button type="button" onClick={() => setEditing(true)}>
              Editar
            </button>
            <button type="button" className="danger" onClick={() => setDeleting(true)}>
              Excluir
            </button>
          </div>
        )}
      </div>
      <dl className="props">
        <dt>Username</dt>
        <dd>{c.username ?? "—"}</dd>
        <dt>Custom id</dt>
        <dd className="mono">{c.customId ?? "—"}</dd>
        <dt>Tags</dt>
        <dd>{c.tags?.join(", ") || "—"}</dd>
      </dl>
      <CredentialTabs envId={envId} consumer={c} canEdit={canEdit} />
      <ScopedPlugins envId={envId} scope={{ kind: "consumer", id: c.id }} title="Plugins do consumer" />
      {editing && <ConsumerForm envId={envId} consumer={c} onClose={() => setEditing(false)} />}
      {deleting && <DeleteConsumer envId={envId} consumer={c} onClose={() => setDeleting(false)} onDeleted={() => navigate("..")} />}
    </section>
  );
}

const TABS = [
  { id: "key-auth", label: "Key-auth", Panel: KeyAuthCredentials },
  { id: "jwt", label: "JWT", Panel: JwtCredentials },
  { id: "basic-auth", label: "Basic-auth", Panel: BasicAuthCredentials },
  { id: "groups", label: "Grupos", Panel: AclGroupsPanel },
] as const;

/** Credentials and ACL groups of the consumer, one panel at a time (WAI-ARIA tabs, arrow keys move between them). */
function CredentialTabs({ envId, consumer, canEdit }: { envId: string; consumer: Consumer; canEdit: boolean }) {
  const [active, setActive] = useState<(typeof TABS)[number]["id"]>("key-auth");
  const { Panel } = TABS.find((t) => t.id === active)!;
  const move = (from: number, delta: number) => {
    const next = TABS[(from + delta + TABS.length) % TABS.length]!;
    setActive(next.id);
    document.getElementById(`consumer-tab-${next.id}`)?.focus();
  };
  return (
    <div>
      <div role="tablist" aria-label="Credenciais do consumer" className="tabs">
        {TABS.map((t, i) => (
          <button
            key={t.id}
            id={`consumer-tab-${t.id}`}
            type="button"
            role="tab"
            aria-selected={t.id === active}
            aria-controls={`consumer-panel-${t.id}`}
            tabIndex={t.id === active ? 0 : -1}
            onClick={() => setActive(t.id)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight") move(i, 1);
              if (e.key === "ArrowLeft") move(i, -1);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`consumer-panel-${active}`} aria-labelledby={`consumer-tab-${active}`}>
        <Panel envId={envId} consumer={consumer} canEdit={canEdit} />
      </div>
    </div>
  );
}

function ConsumerForm({ envId, consumer, onClose, onCreated }: { envId: string; consumer: Consumer | null; onClose: () => void; onCreated?: (c: Consumer) => void }) {
  const invalidate = useInvalidateDraft(envId);
  const [form, setForm] = useState({ username: consumer?.username ?? "", customId: consumer?.customId ?? "", tags: (consumer?.tags ?? []).join(", ") });
  const [errors, setErrors] = useState<FormErrors>({ fields: {}, form: [] });

  const save = useMutation({
    mutationFn: () => {
      const body: ConsumerWrite = { username: form.username.trim() || null, customId: form.customId.trim() || null, tags: splitList(form.tags) };
      return consumer
        ? unwrap(api.PUT("/environments/{envId}/consumers/{consumerId}", { params: { path: { envId, consumerId: consumer.id } }, body }))
        : unwrap(api.POST("/environments/{envId}/consumers", { params: { path: { envId } }, body }));
    },
    onSuccess: (saved) => {
      invalidate("consumers");
      onClose();
      if (!consumer) onCreated?.(saved);
    },
    onError: (err) => setErrors(toFormErrors(err, FIELDS)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!form.username.trim() && !form.customId.trim()) {
      setErrors({ fields: { username: ["Informe o username ou o custom id."] }, form: [] });
      return;
    }
    setErrors({ fields: {}, form: [] });
    save.mutate();
  };
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <Modal title={consumer ? `Editar ${consumerName(consumer)}` : "Novo consumer"} onClose={onClose}>
      <form onSubmit={submit} className="form" noValidate>
        <Field label="Username" errors={errors.fields.username}>
          {(id, invalid) => <input id={id} aria-invalid={invalid} value={form.username} onChange={(e) => set("username", e.target.value)} />}
        </Field>
        <Field label="Custom id" errors={errors.fields.customId} hint="Identificador do consumer no seu sistema (opcional se houver username)">
          {(id, invalid) => <input id={id} aria-invalid={invalid} value={form.customId} onChange={(e) => set("customId", e.target.value)} />}
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

function DeleteConsumer({ envId, consumer, onClose, onDeleted }: { envId: string; consumer: Consumer; onClose: () => void; onDeleted?: () => void }) {
  const invalidate = useInvalidateDraft(envId);
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE("/environments/{envId}/consumers/{consumerId}", { params: { path: { envId, consumerId: consumer.id } } })),
    onSuccess: () => {
      invalidate("consumers", "plugins");
      onClose();
      onDeleted?.();
    },
  });
  return (
    <ConfirmDialog
      title="Excluir consumer"
      message={
        <>
          Excluir <strong>{consumerName(consumer)}</strong>? As credenciais e os plugins dele também são excluídos. A exclusão só afeta o tráfego depois de publicar.
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

/* ---------------- key-auth ---------------- */

function KeyAuthCredentials({ envId, consumer, canEdit }: { envId: string; consumer: Consumer; canEdit: boolean }) {
  const invalidate = useInvalidateDraft(envId);
  const path = { envId, consumerId: consumer.id };
  const credentials = useQuery({
    queryKey: ["keyauth", envId, consumer.id],
    queryFn: () => unwrap(api.GET("/environments/{envId}/consumers/{consumerId}/key-auth", { params: { path } })),
  });
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<KeyAuthCredential | null>(null);
  const items = credentials.data?.items ?? [];

  return (
    <section aria-label="Credenciais key-auth">
      <div className="page-head">
        <h2>Credenciais key-auth</h2>
        {canEdit && (
          <button type="button" className="primary" onClick={() => setCreating(true)}>
            Gerar chave
          </button>
        )}
      </div>
      {credentials.isPending && <p className="muted">Carregando…</p>}
      {credentials.isError && <p className="error">{statusMessage(credentials.error)}</p>}
      {credentials.isSuccess && items.length === 0 && <p className="muted">Nenhuma chave.</p>}
      {items.length > 0 && (
        <table aria-label="Chaves">
          <thead>
            <tr>
              <th>Chave</th>
              <th>Criada em</th>
              {canEdit && <th aria-label="Ações" />}
            </tr>
          </thead>
          <tbody>
            {items.map((k) => (
              <tr key={k.id}>
                <td className="mono">{k.keyHint}</td>
                <td>{new Date(k.createdAt).toLocaleString("pt-BR")}</td>
                {canEdit && (
                  <td className="actions">
                    <button type="button" className="danger" onClick={() => setDeleting(k)}>
                      Excluir
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {creating && (
        <NewKey
          envId={envId}
          consumerId={consumer.id}
          onDone={() => {
            invalidate("keyauth");
            setCreating(false);
          }}
        />
      )}
      {deleting && (
        <DeleteKey
          envId={envId}
          consumerId={consumer.id}
          credential={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => invalidate("keyauth")}
        />
      )}
    </section>
  );
}

/**
 * The full key exists only in this component's state: it is shown once after the 201, and closing the dialog
 * drops it (nothing goes to the query cache or to storage). From then on only `keyHint` is visible.
 */
function NewKey({ envId, consumerId, onDone }: { envId: string; consumerId: string; onDone: () => void }) {
  const [custom, setCustom] = useState("");
  const [errors, setErrors] = useState<FormErrors>({ fields: {}, form: [] });
  const [copied, setCopied] = useState(false);
  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/environments/{envId}/consumers/{consumerId}/key-auth", {
          params: { path: { envId, consumerId } },
          body: custom.trim() ? { key: custom.trim() } : {},
        }),
      ),
    onSuccess: () => setCustom(""),
    onError: (err) => setErrors(toFormErrors(err, ["key"])),
  });
  const close = () => {
    create.reset();
    onDone();
  };

  if (create.data) {
    const key = create.data.key;
    return (
      <Modal
        title="Chave criada"
        onClose={close}
        footer={
          <button type="button" className="primary" onClick={close}>
            Concluído
          </button>
        }
      >
        <p className="warn" role="note">
          Copie a chave agora. Ela não será mostrada de novo: depois só aparecem os últimos caracteres.
        </p>
        <div className="secret">
          <code className="mono" aria-label="Chave">
            {key}
          </code>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(key).then(() => setCopied(true));
            }}
          >
            {copied ? "Copiada" : "Copiar"}
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Gerar chave" onClose={close}>
      <form
        className="form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (custom.trim() && custom.trim().length < 16) {
            setErrors({ fields: { key: ["Use pelo menos 16 caracteres."] }, form: [] });
            return;
          }
          setErrors({ fields: {}, form: [] });
          create.mutate();
        }}
      >
        <Field label="Chave personalizada" errors={errors.fields.key} hint="Opcional. Vazio = uma chave aleatória forte é gerada.">
          {(id, invalid) => <input id={id} type="password" autoComplete="off" aria-invalid={invalid} value={custom} onChange={(e) => setCustom(e.target.value)} />}
        </Field>
        <FormErrorList messages={errors.form} />
        <div className="form-actions">
          <button type="button" onClick={close}>
            Cancelar
          </button>
          <button type="submit" className="primary" disabled={create.isPending}>
            {create.isPending ? "Gerando…" : "Gerar"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteKey(props: { envId: string; consumerId: string; credential: KeyAuthCredential; onClose: () => void; onDeleted: () => void }) {
  const { envId, consumerId, credential, onClose } = props;
  const remove = useMutation({
    mutationFn: () =>
      unwrap(api.DELETE("/environments/{envId}/consumers/{consumerId}/key-auth/{credentialId}", { params: { path: { envId, consumerId, credentialId: credential.id } } })),
    onSuccess: () => {
      props.onDeleted();
      onClose();
    },
  });
  return (
    <ConfirmDialog
      title="Excluir chave"
      message={
        <>
          Excluir a chave <span className="mono">{credential.keyHint}</span>? Quem a usa deixa de ter acesso depois de publicar.
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
