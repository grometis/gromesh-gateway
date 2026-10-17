import { useState, type FormEvent } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, unwrap, type Schemas } from "../api/client";
import { statusMessage, toFormErrors, type FormErrors } from "../api/errors";
import { useAuth } from "../auth";
import { Field, FormErrorList } from "../components/Field";
import { Modal } from "../components/Modal";

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
    <section>
      <div className="page-head">
        <h1>Tokens de API</h1>
        <button type="button" className="primary" onClick={() => setCreating(true)}>
          Novo token
        </button>
      </div>
      <p className="muted">
        Um token autentica chamadas à API com <code>Authorization: Bearer</code>, sem cookie nem CSRF, com no máximo o seu papel atual. Ele não cria nem revoga tokens e não gerencia usuários.
      </p>
      {admin && (
        <Field label="Mostrar">
          {(id) => (
            <select id={id} value={scope} onChange={(e) => setScope(e.target.value as "mine" | "all")}>
              <option value="mine">Meus tokens</option>
              <option value="all">Todos os usuários</option>
            </select>
          )}
        </Field>
      )}
      {tokens.isPending && <p className="muted">Carregando…</p>}
      {tokens.isError && <p className="error" role="alert">{statusMessage(tokens.error)}</p>}
      {tokens.isSuccess && items.length === 0 && <p className="muted">Nenhum token.</p>}
      {items.length > 0 && (
        <div className="scroll-x">
          <table aria-label="Tokens de API">
            <thead>
              <tr>
                <th>Nome</th>
                <th>Token</th>
                <th>Papel</th>
                {scope === "all" && <th>Dono</th>}
                <th>Criado em</th>
                <th>Expira em</th>
                <th>Último uso</th>
                <th>Estado</th>
                <th aria-label="Ações" />
              </tr>
            </thead>
            <tbody>
              {items.map((token) => {
                const expired = Date.parse(token.expiresAt) <= Date.now();
                const state = token.revokedAt ? "Revogado" : expired ? "Expirado" : "Ativo";
                return (
                  <tr key={token.id} className={state === "Ativo" ? undefined : "muted"}>
                    <td>{token.name}</td>
                    <td>
                      <code>{token.tokenHint}</code>
                    </td>
                    <td>{ROLES[token.role]}</td>
                    {scope === "all" && <td>{token.owner.name}</td>}
                    <td>{when(token.createdAt)}</td>
                    <td>{when(token.expiresAt)}</td>
                    <td>{when(token.lastUsedAt)}</td>
                    <td>{state}</td>
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
          </table>
        </div>
      )}
      {tokens.hasNextPage && (
        <button type="button" onClick={() => tokens.fetchNextPage()} disabled={tokens.isFetchingNextPage}>
          Carregar mais
        </button>
      )}
      {creating && user && (
        <CreateTokenModal
          maxRole={user.role}
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
        <Modal
          title="Revogar token"
          onClose={() => setRevoking(null)}
          footer={
            <>
              <button type="button" onClick={() => setRevoking(null)}>
                Cancelar
              </button>
              <button type="button" className="danger" disabled={revoke.isPending} onClick={() => revoke.mutate(revoking)}>
                {revoke.isPending ? "Revogando…" : "Revogar"}
              </button>
            </>
          }
        >
          <p>
            O token <strong>{revoking.name}</strong> ({revoking.tokenHint}) deixa de funcionar imediatamente. Esta ação não pode ser desfeita.
          </p>
          {revoke.isError && <p className="error" role="alert">{statusMessage(revoke.error)}</p>}
        </Modal>
      )}
    </section>
  );
}

function CreateTokenModal({ maxRole, onClose, onCreated }: { maxRole: Role; onClose: () => void; onCreated: (token: ApiTokenCreated) => void }) {
  const [form, setForm] = useState({ name: "", role: "viewer" as Role, expiresInDays: 90 });
  const [errors, setErrors] = useState<FormErrors>({ fields: {}, form: [] });
  const create = useMutation({
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
      <form id="create-token" onSubmit={submit}>
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
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token.token);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <Modal
      title="Token criado"
      onClose={onClose}
      footer={
        <button type="button" className="primary" onClick={onClose}>
          Entendi, já copiei
        </button>
      }
    >
      <p>
        Copie o token agora: ele <strong>não será exibido novamente</strong>. Expira em {when(token.expiresAt)}.
      </p>
      <p>
        <code aria-label="Token">{token.token}</code>
      </p>
      <button type="button" onClick={copy}>
        {copied ? "Copiado" : "Copiar"}
      </button>
    </Modal>
  );
}
