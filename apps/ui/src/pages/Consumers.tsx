import { useDeferredValue, useEffect, useRef, useState, type FormEvent } from "react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router";
import type { Consumer, ConsumerWrite, KeyAuthCredential } from "../api/client";
import { consumerName } from "../api/lists";
import { statusMessage, toFormErrors, type FormErrors } from "../api/errors";
import { useConsumerScope } from "./consumer-scope";
import { useWorkspaceId, useIsWorkspaceRoute } from "../navigation/context";
import { Field, FormErrorList } from "../components/Field";
import { ConfirmDialog, Modal } from "../components/Modal";
import { Tabs } from "../components/Tabs";
import { Button } from "../components/Button";
import { RowMenu } from "../components/RowMenu";
import { createdAt, CredentialCard, PendingBadge, SecretOnce } from "../components/Credentials";
import { Table } from "../components/Table";
import { PageHeader } from "../components/PageHeader";
import { EmptyState } from "../components/EmptyState";
import { AclGroupsPanel, BasicAuthCredentials, JwtCredentials, RotateCredential } from "./ConsumerCredentials";
import { ScopedPlugins } from "./Plugins";
import { splitList } from "./Services";

const FIELDS = ["username", "customId", "tags"] as const;

/** A completed write still invalidates its Workspace, but cannot navigate a page the user has left. */
function useMounted() {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  return mounted;
}

export function ConsumersPage() {
  const id = useWorkspaceId();
  const v2 = useIsWorkspaceRoute();
  return <Consumers key={`${v2}/${id}`} envId={id} />;
}

function Consumers({ envId }: { envId: string }) {
  const { v2, canEdit, reason, key, transport } = useConsumerScope(envId);
  const [search, setSearch] = useState("");
  const q = useDeferredValue(search.trim());
  const consumers = useInfiniteQuery({
    queryKey: key("consumers", q),
    queryFn: ({ pageParam }) => transport.list(q, pageParam),
    initialPageParam: "",
    getNextPageParam: page => page.nextCursor ?? undefined,
  });
  const [editing, setEditing] = useState<Consumer | "new" | null>(null);
  const [deleting, setDeleting] = useState<Consumer | null>(null);
  const navigate = useNavigate();
  const items = consumers.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <section className={v2 ? "final-page workspace-consumers" : "final-page"}>
      <PageHeader
        title={v2 ? "Consumidores" : "Consumers"}
        description={v2 ? "Identidades e credenciais de acesso. As alterações ficam no rascunho deste Workspace." : undefined}
        actions={canEdit && (
          <button type="button" className="primary" onClick={() => setEditing("new")}>
            {v2 ? "Novo consumidor" : "Novo consumer"}
          </button>
        )}
      />
      {reason && <p role="status">{reason}</p>}
      <input type="search" className="search" placeholder="Buscar por username ou custom id" aria-label={v2 ? "Buscar consumidores" : "Buscar consumers"} value={search} onChange={(e) => setSearch(e.target.value)} />
      {consumers.isPending && <p className="muted">Carregando…</p>}
      {consumers.isError && <p className="error">{statusMessage(consumers.error)}</p>}
      {consumers.isSuccess && items.length === 0 && <EmptyState title={v2 ? (q ? "Nenhum consumidor encontrado." : "Nenhum consumidor ainda.") : q ? "Nenhum consumer encontrado." : "Nenhum consumer ainda."} text={v2 && !q ? "Crie um consumidor para configurar suas credenciais de acesso." : undefined} />}
      {items.length > 0 && (
        <Table label={v2 ? "Consumidores" : "Consumers"} cards>
          <thead>
            <tr>
              <th>{v2 ? "Consumidor" : "Consumer"}</th>
              <th>Custom id</th>
              <th>
                <span className="visually-hidden">Ações</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr key={c.id}>
                <td className="row-main">
                  {/* The whole row opens the consumer: this link covers it, the actions sit above it. */}
                  <Link to={c.id} className="row-open service-name">
                    {consumerName(c)}
                  </Link>
                  {c.tags && c.tags.length > 0 && <span className="muted"> · {c.tags.join(", ")}</span>}
                </td>
                <td className="mono">{c.customId ?? "—"}</td>
                <td className="actions">
                  {canEdit && (
                    <>
                      <Button variant="quiet" onClick={() => setEditing(c)}>
                        Editar
                      </Button>
                      <RowMenu label={`Mais ações para ${consumerName(c)}`} items={[{ label: "Excluir", danger: true, onSelect: () => setDeleting(c) }]} />
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
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
  const envId = useWorkspaceId();
  const { consumerId } = useParams();
  const v2 = useIsWorkspaceRoute();
  return <ConsumerDetail key={`${v2}/${envId}/${consumerId}`} envId={envId} consumerId={consumerId!} />;
}

function ConsumerDetail({ envId, consumerId }: { envId: string; consumerId: string }) {
  const { v2, canEdit, reason, key, transport } = useConsumerScope(envId);
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const consumer = useQuery({
    queryKey: key("consumers", "detail", consumerId),
    queryFn: () => transport.get(consumerId),
  });

  if (consumer.isPending) return <p className="muted">Carregando…</p>;
  if (consumer.isError) return <p className="error">{statusMessage(consumer.error)}</p>;
  const c = consumer.data;
  return (
    <section className={v2 ? "stack final-page workspace-consumers" : "stack final-page"}>
      <p>
        <Link to={v2 ? `/workspaces/${envId}/consumers` : ".."} className="back-link">← {v2 ? "Consumidores" : "Consumers"}</Link>
      </p>
      <PageHeader
        title={<>{v2 ? "Consumidor" : "Consumer"} {consumerName(c)}</>}
        actions={canEdit && (
          <div className="form-actions">
            <Button variant="primary" onClick={() => setEditing(true)}>
              Editar
            </Button>
            <RowMenu label={`Mais ações para ${consumerName(c)}`} items={[{ label: "Excluir", danger: true, onSelect: () => setDeleting(true) }]} />
          </div>
        )}
      />
      {reason && <p role="status">{reason}</p>}
      <dl className="props">
        <dt>Username</dt>
        <dd>{c.username ?? "—"}</dd>
        <dt>Custom id</dt>
        <dd className="mono">{c.customId ?? "—"}</dd>
        <dt>Tags</dt>
        <dd>{c.tags?.join(", ") || "—"}</dd>
      </dl>
      <CredentialTabs envId={envId} consumer={c} canEdit={canEdit} />
      {editing && <ConsumerForm envId={envId} consumer={c} onClose={() => setEditing(false)} />}
      {deleting && <DeleteConsumer envId={envId} consumer={c} onClose={() => setDeleting(false)} onDeleted={() => navigate(v2 ? `/workspaces/${envId}/consumers` : "..")} />}
    </section>
  );
}

/** The three credential kinds side by side: each card shows only hints, never a secret. */
function CredentialsPanel(props: { envId: string; consumer: Consumer; canEdit: boolean }) {
  return (
    <div className="cred-columns">
      <KeyAuthCredentials {...props} />
      <JwtCredentials {...props} />
      <BasicAuthCredentials {...props} />
    </div>
  );
}

function PluginsPanel({ envId, consumer }: { envId: string; consumer: Consumer; canEdit: boolean }) {
  const v2 = useIsWorkspaceRoute();
  if (v2) return <section aria-label="Plugins do consumidor"><h2>Plugins do consumidor</h2><p>Plugins por consumidor ainda não estão disponíveis no Workspace v2.</p></section>;
  return <ScopedPlugins envId={envId} scope={{ kind: "consumer", id: consumer.id }} title="Plugins do consumer" />;
}

const TABS = [
  { id: "credentials", label: "Credenciais", Panel: CredentialsPanel },
  { id: "groups", label: "Grupos ACL", Panel: AclGroupsPanel },
  { id: "plugins", label: "Plugins", Panel: PluginsPanel },
] as const;

/** Credentials and ACL groups of the consumer, one panel at a time. */
function CredentialTabs({ envId, consumer, canEdit }: { envId: string; consumer: Consumer; canEdit: boolean }) {
  const v2 = useIsWorkspaceRoute();
  const [active, setActive] = useState<(typeof TABS)[number]["id"]>("credentials");
  const { Panel } = TABS.find((t) => t.id === active)!;
  return (
    <Tabs label={v2 ? "Seções do consumidor" : "Seções do consumer"} tabs={TABS} active={active} onChange={setActive}>
      <Panel envId={envId} consumer={consumer} canEdit={canEdit} />
    </Tabs>
  );
}

function ConsumerForm({ envId, consumer, onClose, onCreated }: { envId: string; consumer: Consumer | null; onClose: () => void; onCreated?: (c: Consumer) => void }) {
  const { v2, canEdit: writable, reason, transport, invalidate } = useConsumerScope(envId);
  const mounted = useMounted();
  const [form, setForm] = useState({ username: consumer?.username ?? "", customId: consumer?.customId ?? "", tags: (consumer?.tags ?? []).join(", ") });
  const [errors, setErrors] = useState<FormErrors>({ fields: {}, form: [] });

  const save = useMutation({
    mutationFn: () => {
      const body: ConsumerWrite = { username: form.username.trim() || null, customId: form.customId.trim() || null, tags: splitList(form.tags) };
      return transport.save(consumer?.id ?? null, body);
    },
    onSuccess: (saved) => {
      if (v2 && !mounted.current) return;
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
    <Modal title={consumer ? `Editar ${consumerName(consumer)}` : v2 ? "Novo consumidor" : "Novo consumer"} onClose={onClose}>
      {reason && <p role="status">{reason}</p>}
      <form onSubmit={submit} className="form" noValidate>
        <Field label="Username" errors={errors.fields.username}>
          {(id, invalid) => <input id={id} aria-invalid={invalid} value={form.username} onChange={(e) => set("username", e.target.value)} />}
        </Field>
        <Field label="Custom id" errors={errors.fields.customId} hint={v2 ? "Identificador do consumidor no seu sistema (opcional se houver username)" : "Identificador do consumer no seu sistema (opcional se houver username)"}>
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
          <button type="submit" className="primary" disabled={save.isPending || (v2 && !writable)}>
            {save.isPending ? "Salvando…" : "Salvar"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteConsumer({ envId, consumer, onClose, onDeleted }: { envId: string; consumer: Consumer; onClose: () => void; onDeleted?: () => void }) {
  const { v2, canEdit: writable, reason, transport, invalidate } = useConsumerScope(envId);
  const mounted = useMounted();
  const remove = useMutation({
    mutationFn: () => transport.remove(consumer.id),
    onSuccess: () => {
      if (v2 && !mounted.current) return;
      invalidate("consumers", "plugins");
      onClose();
      onDeleted?.();
    },
  });
  return (
    <ConfirmDialog
      title={v2 ? "Excluir consumidor" : "Excluir consumer"}
      message={
        <>
          Excluir <strong>{consumerName(consumer)}</strong>? As credenciais e os plugins dele também são excluídos. A exclusão só afeta o tráfego depois de publicar.
        </>
      }
      children={reason && <p role="status">{reason}</p>}
      confirmLabel="Excluir"
      busy={remove.isPending || (v2 && !writable)}
      error={remove.isError ? statusMessage(remove.error) : null}
      onConfirm={() => remove.mutate()}
      onClose={onClose}
    />
  );
}

/* ---------------- key-auth ---------------- */

function KeyAuthCredentials({ envId, consumer, canEdit }: { envId: string; consumer: Consumer; canEdit: boolean }) {
  const { v2, canEdit: writable, reason, key, transport, invalidate } = useConsumerScope(envId);
  const credentials = useQuery({
    queryKey: key("keyauth", consumer.id),
    queryFn: () => transport.listKeys(consumer.id),
  });
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<KeyAuthCredential | null>(null);
  const [rotating, setRotating] = useState<KeyAuthCredential | null>(null);
  const items = credentials.data?.items ?? [];
  const label = (k: KeyAuthCredential) => k.keyHint ?? "pendente";

  return (
    <section aria-label="Credenciais key-auth" className="cred-section">
      <div className="cred-head">
        <h2>Key-auth</h2>
        {canEdit && (
          <button type="button" className="primary" onClick={() => setCreating(true)}>
            Gerar chave
          </button>
        )}
      </div>
      {credentials.isPending && <p className="muted">Carregando…</p>}
      {credentials.isError && <p className="error">{statusMessage(credentials.error)}</p>}
      {credentials.isSuccess && items.length === 0 && <EmptyState title="Nenhuma chave." />}
      {items.length > 0 && (
        <ul className="cred-list" aria-label="Chaves">
          {items.map((k) => (
            <CredentialCard
              key={k.id}
              hint={k.status === "pending-reprovision" ? <PendingBadge /> : <span className="mono">{k.keyHint}</span>}
              meta={createdAt(k.createdAt)}
              deleteLabel={`Mais ações para a chave ${label(k)}`}
              onDelete={canEdit ? () => setDeleting(k) : undefined}
              rotateLabel="Gerar nova chave"
              onRotate={canEdit ? () => setRotating(k) : undefined}
            />
          ))}
        </ul>
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
      {rotating && (
        <RotateCredential
          title="Gerar nova chave"
          blocked={v2 && !writable}
          blockedReason={reason}
          what={rotating.status === "pending-reprovision" ? <>a chave desta credencial</> : <>uma nova chave no lugar de <span className="mono">{rotating.keyHint}</span></>}
          pending={rotating.status === "pending-reprovision"}
          label="Chave"
          field="key"
          rotate={() => transport.rotateKey(consumer.id, rotating.id)}
          note="Copie a chave agora. Ela não será mostrada de novo: depois só aparecem os últimos caracteres. A nova chave vale depois de publicar."
          onRotated={() => invalidate("keyauth")}
          onClose={() => setRotating(null)}
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
 * drops it (nothing stays in the query or mutation cache, nor in storage). From then on only `keyHint` is visible.
 * Only the server generates it (decision H-14): there is no field for a key of one's own.
 */
function NewKey({ envId, consumerId, onDone }: { envId: string; consumerId: string; onDone: () => void }) {
  const { v2, canEdit: writable, reason, transport } = useConsumerScope(envId);
  const create = useMutation({
    // The response carries the secret: evict it from the mutation cache as soon as the dialog lets go of it.
    gcTime: 0,
    mutationFn: () => transport.createKey(consumerId),
  });
  const close = () => {
    create.reset();
    onDone();
  };

  if (create.data) {
    return (
      <SecretOnce
        title="Chave criada"
        label="Chave"
        secret={create.data.key}
        note="Copie a chave agora. Ela não será mostrada de novo: depois só aparecem os últimos caracteres."
        onClose={close}
      />
    );
  }

  return (
    <Modal title="Gerar chave" onClose={close}>
      {reason && <p role="status">{reason}</p>}
      <form
        className="form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <p className="muted">O servidor gera uma chave aleatória forte e a mostra uma única vez.</p>
        <FormErrorList messages={create.isError ? [statusMessage(create.error)] : []} />
        <div className="form-actions">
          <button type="button" onClick={close}>
            Cancelar
          </button>
          <button type="submit" className="primary" disabled={create.isPending || (v2 && !writable)}>
            {create.isPending ? "Gerando…" : "Gerar"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteKey(props: { envId: string; consumerId: string; credential: KeyAuthCredential; onClose: () => void; onDeleted: () => void }) {
  const { envId, consumerId, credential, onClose } = props;
  const { v2, canEdit: writable, reason, transport } = useConsumerScope(envId);
  const remove = useMutation({
    mutationFn: () =>
      transport.removeKey(consumerId, credential.id),
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
          Excluir a chave <span className="mono">{credential.keyHint ?? "pendente"}</span>? Quem a usa deixa de ter acesso depois de publicar.
        </>
      }
      children={reason && <p role="status">{reason}</p>}
      confirmLabel="Excluir"
      busy={remove.isPending || (v2 && !writable)}
      error={remove.isError ? statusMessage(remove.error) : null}
      onConfirm={() => remove.mutate()}
      onClose={onClose}
    />
  );
}
