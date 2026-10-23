import { useState, type FormEvent } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, unwrap, type Schemas } from "../api/client";
import { statusMessage, toFormErrors, type FormErrors } from "../api/errors";
import { highestRole, useAuth } from "../auth";
import { Field, FormErrorList } from "../components/Field";
import { ConfirmDialog, Modal } from "../components/Modal";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { SecretOnce } from "../components/Credentials";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { Table } from "../components/Table";

type ApiToken = Schemas["ApiToken"];
type ApiTokenCreated = Schemas["ApiTokenCreated"];
type Role = Schemas["Role"];

const ROLES: Record<Role, string> = { viewer: "Leitor", editor: "Editor", admin: "Administrador" };
const RANK: Record<Role, number> = { viewer: 1, editor: 2, admin: 3 };
const FIELDS = ["name", "role", "expiresInDays", "(body)"] as const;
const when = (iso: string | null) => (iso === null ? "—" : new Date(iso).toLocaleString("pt-BR", { hour12: false }));

/** Own tokens for everyone; admins also see every user's tokens and can revoke them. */
export function TokensPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const admin = user?.role === "admin";
  const path = scope === "all" && admin ? "/tokens" : "/users/me/tokens";
  const tokens = useInfiniteQuery({
    queryKey: ["tokens", path],
    queryFn: ({ pageParam }) => unwrap(api.GET(path, { params: { query: pageParam ? { cursor: pageParam } : {} } })),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<ApiTokenCreated | null>(null);
  const [revoking, setRevoking] = useState<ApiToken | null>(null);
  const items = tokens.data?.pages.flatMap((page) => page.items) ?? [];
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["tokens"] });

  const revoke = useMutation({
    mutationFn: (token: ApiToken) =>
      token.owner.id === user?.id || !admin
        ? unwrap(api.DELETE("/users/me/tokens/{tokenId}", { params: { path: { tokenId: token.id } } }))
        : unwrap(api.DELETE("/tokens/{tokenId}", { params: { path: { tokenId: token.id } } })),
    onSuccess: () => {
      setRevoking(null);
      void invalidate();
    },
  });

  return (
    <section className="final-page identity-page">
      <PageHeader
        title="Tokens de API"
        description={<>Um token autentica chamadas à API com <code>Authorization: Bearer</code>, sem cookie nem CSRF, com no máximo o seu maior papel (global ou de algum environment); em cada environment ele age com o menor entre o papel do token e o seu papel ali. Ele não cria nem revoga tokens e não gerencia usuários.</>}
        actions={<Button variant="primary" onClick={() => setCreating(true)}>Novo token</Button>}
      />
      {admin && (
        <div className="identity-filters">
          <Field label="Mostrar">
            {(id) => (
              <select id={id} value={scope} onChange={(e) => setScope(e.target.value as "mine" | "all")}>
                <option value="mine">Meus tokens</option>
                <option value="all">Todos os usuários</option>
              </select>
            )}
          </Field>
        </div>
      )}
      {tokens.isPending && <p className="muted">Carregando…</p>}
      {tokens.isError && <p className="error" role="alert">{statusMessage(tokens.error)}</p>}
      {tokens.isSuccess && items.length === 0 && <EmptyState title="Nenhum token." text="Crie um token para autenticar suas chamadas à API." />}
      {items.length > 0 && (
        <Table label="Tokens de API" cards>
          <thead>
            <tr>
              <th>Nome → token</th>
              <th>Papel</th>
              {scope === "all" && <th>Dono</th>}
              <th>Validade e uso</th>
              <th>Estado</th>
              <th aria-label="Ações" />
            </tr>
          </thead>
          <tbody>
            {items.map((token) => {
              const expired = Date.parse(token.expiresAt) <= Date.now();
              const state = token.revokedAt ? "Revogado" : expired ? "Expirado" : "Ativo";
              return (
                <tr key={token.id} className={state === "Ativo" ? undefined : "row-off"}>
                  <td className="row-main">
                    <div className="service-route">
                      <strong>{token.name}</strong>
                      <span className="arrow" aria-hidden="true">→</span>
                      <code className="target">{token.tokenHint}</code>
                    </div>
                  </td>
                  <td><Badge tone="off">{ROLES[token.role]}</Badge></td>
                  {scope === "all" && <td>{token.owner.name}</td>}
                  <td>
                    <dl className="identity-meta">
                      <div><dt>Criado em</dt><dd className="mono">{when(token.createdAt)}</dd></div>
                      <div><dt>Expira em</dt><dd className="mono">{when(token.expiresAt)}</dd></div>
                      <div><dt>Último uso</dt><dd className="mono">{when(token.lastUsedAt)}</dd></div>
                    </dl>
                  </td>
                  <td><Badge tone={state === "Ativo" ? "converged" : "off"}>{state}</Badge></td>
                  <td className="actions">
                    {state === "Ativo" && (
                      <button type="button" className="danger" onClick={() => setRevoking(token)}>
                        Revogar
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      {tokens.hasNextPage && (
        <Button onClick={() => void tokens.fetchNextPage()} disabled={tokens.isFetchingNextPage}>
          Carregar mais
        </Button>
      )}
      {creating && user && (
        <CreateTokenModal
          maxRole={highestRole(user)}
          onClose={() => setCreating(false)}
          onCreated={(token) => {
            setCreating(false);
            setCreated(token);
            void invalidate();
          }}
        />
      )}
      {created && <CreatedTokenModal token={created} onClose={() => setCreated(null)} />}
      {revoking && (
        <ConfirmDialog
          title="Revogar token"
          message={<>O token <strong>{revoking.name}</strong> ({revoking.tokenHint}) deixa de funcionar imediatamente. Esta ação não pode ser desfeita.</>}
          confirmLabel={revoke.isPending ? "Revogando…" : "Revogar"}
          busy={revoke.isPending}
          error={revoke.isError ? statusMessage(revoke.error) : null}
          onConfirm={() => revoke.mutate(revoking)}
          onClose={() => setRevoking(null)}
        />
      )}
    </section>
  );
}

function CreateTokenModal({ maxRole, onClose, onCreated }: { maxRole: Role; onClose: () => void; onCreated: (token: ApiTokenCreated) => void }) {
  const [form, setForm] = useState({ name: "", role: "viewer" as Role, expiresInDays: 90 });
  const [errors, setErrors] = useState<FormErrors>({ fields: {}, form: [] });
  const create = useMutation({
    // The response contains a secret; evict it when this form unmounts after creation.
    gcTime: 0,
    mutationFn: () => unwrap(api.POST("/users/me/tokens", { body: form })),
    onSuccess: onCreated,
    onError: (error) => setErrors(toFormErrors(error, FIELDS)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <Modal
      title="Novo token"
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" form="create-token" className="primary" disabled={create.isPending}>
            {create.isPending ? "Criando…" : "Criar token"}
          </button>
        </>
      }
    >
      <form id="create-token" className="form" onSubmit={submit}>
        <Field label="Nome" errors={errors.fields.name}>
          {(id) => <input id={id} value={form.name} maxLength={64} required onChange={(e) => setForm({ ...form, name: e.target.value })} />}
        </Field>
        <Field label="Papel" errors={errors.fields.role}>
          {(id) => (
            <select id={id} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
              {(Object.keys(ROLES) as Role[])
                .filter((role) => RANK[role] <= RANK[maxRole])
                .map((role) => (
                  <option key={role} value={role}>
                    {ROLES[role]}
                  </option>
                ))}
            </select>
          )}
        </Field>
        <Field label="Validade (dias)" errors={errors.fields.expiresInDays}>
          {(id) => <input id={id} type="number" min={1} max={365} value={form.expiresInDays} required onChange={(e) => setForm({ ...form, expiresInDays: Number(e.target.value) })} />}
        </Field>
        <FormErrorList messages={[...errors.form, ...(errors.fields["(body)"] ?? [])]} />
      </form>
    </Modal>
  );
}

/** Shown once: the value is never available again after this dialog closes. */
function CreatedTokenModal({ token, onClose }: { token: ApiTokenCreated; onClose: () => void }) {
  return (
    <SecretOnce
      title="Token criado"
      label="Token"
      secret={token.token}
      closeLabel="Entendi, já copiei"
      note={<>Copie o token agora: ele <strong>não será exibido novamente</strong>. Expira em {when(token.expiresAt)}.</>}
      onClose={onClose}
    />
  );
}
