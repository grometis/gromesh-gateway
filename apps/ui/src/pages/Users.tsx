import { useRef, useState, type FormEvent } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, unwrap, type EnvironmentRole, type EnvironmentRoles, type User, type UserCreate, type UserUpdate } from "../api/client";
import { statusMessage, toFormErrors, type FormErrors } from "../api/errors";
import { Field, FormErrorList } from "../components/Field";
import { ConfirmDialog, Modal } from "../components/Modal";
import { environmentsQuery } from "../components/Shell";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { RowMenu } from "../components/RowMenu";
import { Table } from "../components/Table";

const ROLES: Record<User["role"], string> = { viewer: "Leitor", editor: "Editor", admin: "Administrador" };
const FIELDS = ["email", "name", "role", "active", "password"] as const;
const ENV_ROLES: Record<EnvironmentRole, string> = { ...ROLES, none: "Sem acesso" };
const GLOBAL = "global";
const ROW_MESSAGES: Record<string, string> = { "is not an environment": "não é mais um environment", "is repeated": "aparece mais de uma vez" };

export function UsersPage() {
  const users = useInfiniteQuery({
    queryKey: ["users"],
    queryFn: ({ pageParam }) => unwrap(api.GET("/users", { params: { query: pageParam ? { cursor: pageParam } : {} } })),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const [editing, setEditing] = useState<User | "new" | null>(null);
  const [deleting, setDeleting] = useState<User | null>(null);
  const [scoping, setScoping] = useState<User | null>(null);
  const items = users.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section className="final-page identity-page">
      <PageHeader
        title="Usuários"
        description="Gerencie os papéis globais e o acesso de cada usuário aos environments."
        actions={<Button variant="primary" onClick={() => setEditing("new")}>Novo usuário</Button>}
      />
      {users.isPending && <p className="muted">Carregando…</p>}
      {users.isError && <p className="error" role="alert">{statusMessage(users.error)}</p>}
      {users.isSuccess && items.length === 0 && <EmptyState title="Nenhum usuário encontrado." text="Cadastre um usuário para conceder acesso ao gateway." />}
      {items.length > 0 && (
        <Table label="Usuários" cards>
          <thead>
            <tr>
              <th>Nome → e-mail</th>
              <th>Papel</th>
              <th>Ativo</th>
              <th aria-label="Ações" />
            </tr>
          </thead>
          <tbody>
            {items.map((user) => (
              <tr key={user.id} className={user.active ? undefined : "row-off"}>
                <td className="row-main">
                  <div className="service-route">
                    <strong>{user.name}</strong>
                    <span className="arrow" aria-hidden="true">→</span>
                    <span className="target mono">{user.email}</span>
                  </div>
                </td>
                <td><Badge tone="off">{ROLES[user.role]}</Badge></td>
                <td>
                  <Badge tone={user.active ? "converged" : "off"}>{user.active ? "Ativo" : "Inativo"}</Badge>
                  <span className="visually-hidden">{user.active ? "Sim" : "Não"}</span>
                </td>
                <td className="actions">
                  <div className="identity-actions">
                    <Button variant="quiet" onClick={() => setEditing(user)}>
                      Editar
                    </Button>
                    <button type="button" aria-label={`Papéis de ${user.name} por environment`} onClick={() => setScoping(user)}>
                      Environments
                    </button>
                    <button type="button" className="danger" onClick={() => setDeleting(user)}>
                      Excluir
                    </button>
                    <RowMenu label={`Mais ações para ${user.name}`} items={[
                      { label: "Editar", onSelect: () => setEditing(user) },
                      { label: "Environments", onSelect: () => setScoping(user) },
                      { label: "Excluir", danger: true, onSelect: () => setDeleting(user) },
                    ]} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {users.hasNextPage && (
        <Button disabled={users.isFetchingNextPage} onClick={() => void users.fetchNextPage()}>
          Carregar mais
        </Button>
      )}
      {editing && <UserForm user={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {deleting && <DeleteUser user={deleting} onClose={() => setDeleting(null)} />}
      {scoping && <EnvironmentRolesForm user={scoping} onClose={() => setScoping(null)} />}
    </section>
  );
}

function UserForm({ user, onClose }: { user: User | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<User["role"]>(user?.role ?? "viewer");
  const [active, setActive] = useState(user?.active ?? true);
  const [password, setPassword] = useState("");
  const [confirmDeactivation, setConfirmDeactivation] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({ fields: {}, form: [] });
  const save = useMutation({
    mutationFn: () => {
      if (user) {
        const body: UserUpdate = { name: name.trim(), role, active, ...(password ? { password } : {}) };
        return unwrap(api.PATCH("/users/{userId}", { params: { path: { userId: user.id } }, body }));
      }
      const body: UserCreate = { email: email.trim(), name: name.trim(), role, password };
      return unwrap(api.POST("/users", { body }));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["users"] });
      onClose();
    },
    onError: (err) => setErrors(toFormErrors(err, FIELDS)),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setErrors({ fields: {}, form: [] });
    if (user?.active && !active) setConfirmDeactivation(true);
    else save.mutate();
  };

  if (confirmDeactivation && user) {
    return (
      <ConfirmDialog
        title="Desativar usuário"
        message={<>Desativar <strong>{user.name}</strong> ({user.email})? As sessões dele serão encerradas.</>}
        confirmLabel="Desativar"
        busy={save.isPending}
        error={save.isError ? statusMessage(save.error) : null}
        onConfirm={() => save.mutate()}
        onClose={() => setConfirmDeactivation(false)}
      />
    );
  }

  return (
    <Modal title={user ? `Editar ${user.name}` : "Novo usuário"} onClose={onClose}>
      <form onSubmit={submit} className="form" noValidate>
        <Field label="Nome" errors={errors.fields.name}>
          {(id, invalid) => (
            <input id={id} aria-invalid={invalid} autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} />
          )}
        </Field>
        {user ? <p className="muted mono">{user.email}</p> : (
          <Field label="E-mail" errors={errors.fields.email}>
            {(id, invalid) => (
              <input id={id} type="email" aria-invalid={invalid} autoComplete="off" value={email} onChange={(event) => setEmail(event.target.value)} />
            )}
          </Field>
        )}
        <Field label="Papel" errors={errors.fields.role}>
          {(id, invalid) => (
            <select id={id} aria-invalid={invalid} value={role} onChange={(event) => setRole(event.target.value as User["role"])}>
              {(Object.keys(ROLES) as User["role"][]).map((value) => (
                <option key={value} value={value}>{ROLES[value]}</option>
              ))}
            </select>
          )}
        </Field>
        {user && (
          <Field label="Ativo" errors={errors.fields.active}>
            {(id, invalid) => (
              <input id={id} className="identity-active" type="checkbox" aria-invalid={invalid} checked={active} onChange={(event) => setActive(event.target.checked)} />
            )}
          </Field>
        )}
        <Field label={user ? "Nova senha" : "Senha"} errors={errors.fields.password} hint={user ? "Deixe em branco para manter a senha atual. Mínimo de 12 caracteres." : "Mínimo de 12 caracteres."}>
          {(id, invalid) => (
            <input id={id} type="password" aria-invalid={invalid} autoComplete="new-password" minLength={12} value={password} onChange={(event) => setPassword(event.target.value)} />
          )}
        </Field>
        {user && <p className="muted">Alterar o papel ou desativar o usuário encerra as sessões dele.</p>}
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

/** One row per environment: the global role applies unless a role replaces it there ("Sem acesso" hides it). */
function EnvironmentRolesForm({ user, onClose }: { user: User; onClose: () => void }) {
  const queryClient = useQueryClient();
  const envs = useQuery(environmentsQuery);
  const roles = useQuery({
    queryKey: ["environment-roles", user.id],
    queryFn: () => unwrap(api.GET("/users/{userId}/environment-roles", { params: { path: { userId: user.id } } })),
    enabled: user.role !== "admin",
    refetchOnMount: "always",
  });
  const [draft, setDraft] = useState<Record<string, EnvironmentRole | typeof GLOBAL>>({});
  const [errors, setErrors] = useState<string[]>([]);
  const valueOf = (envId: string) => draft[envId] ?? roles.data?.items.find((r) => r.environmentId === envId)?.role ?? GLOBAL;
  // The names of the rows sent, so an error at items.N names the environment instead of an index.
  const sent = useRef<string[]>([]);
  const save = useMutation({
    mutationFn: () => {
      const rows = (envs.data?.items ?? []).flatMap((e) => {
        const role = valueOf(e.id);
        return role === GLOBAL ? [] : [{ name: e.name, item: { environmentId: e.id, role } }];
      });
      sent.current = rows.map((r) => r.name);
      const body: EnvironmentRoles = { items: rows.map((r) => r.item) };
      return unwrap(api.PUT("/users/{userId}/environment-roles", { params: { path: { userId: user.id } }, body }));
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["environment-roles", user.id], data);
      onClose();
    },
    onError: (err) => {
      const rows = err instanceof ApiError ? (err.problem?.errors ?? []).flatMap(({ path, message }) => {
        const name = sent.current[Number(/^items\.(\d+)\./.exec(path)?.[1] ?? NaN)];
        return name ? [`${name}: ${ROW_MESSAGES[message] ?? message}`] : [];
      }) : [];
      setErrors(rows.length > 0 ? rows : toFormErrors(err, []).form);
    },
  });
  // The PUT replaces the whole set: only a fresh, successful read may be the base of it, never a stale cache.
  const ready = envs.isSuccess && roles.isSuccess && !envs.isFetching && !roles.isFetching;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setErrors([]);
    save.mutate();
  };

  if (user.role === "admin") {
    return (
      <Modal title={`Environments de ${user.name}`} onClose={onClose}>
        <p>Administradores globais são administradores em todos os environments. Para limitar o acesso, mude o papel global primeiro.</p>
        <div className="form-actions">
          <button type="button" onClick={onClose}>Fechar</button>
        </div>
      </Modal>
    );
  }
  const failed = envs.error ?? roles.error;
  return (
    <Modal title={`Environments de ${user.name}`} onClose={onClose} wide>
      <form onSubmit={submit} className="form" noValidate>
        <p className="muted">
          Papel global: <strong>{ROLES[user.role]}</strong>. Um papel escolhido aqui substitui o global só naquele environment; “Sem acesso” esconde o environment.
        </p>
        {(envs.isPending || roles.isPending) && <p className="muted">Carregando…</p>}
        {failed && <p className="error" role="alert">{statusMessage(failed)}</p>}
        {envs.data && roles.data && (envs.data.items.length === 0 ? <EmptyState title="Nenhum environment cadastrado." /> : (
          <Table label="Papéis por environment" cards>
            <thead>
              <tr>
                <th>Environment</th>
                <th>Papel</th>
              </tr>
            </thead>
            <tbody>
              {envs.data.items.map((env) => (
                <tr key={env.id}>
                  <td>{env.name}</td>
                  <td>
                    <select
                      aria-label={`Papel em ${env.name}`}
                      value={valueOf(env.id)}
                      onChange={(event) => setDraft({ ...draft, [env.id]: event.target.value as EnvironmentRole | typeof GLOBAL })}
                    >
                      <option value={GLOBAL}>Usa o global ({ROLES[user.role]})</option>
                      {(Object.keys(ENV_ROLES) as EnvironmentRole[]).map((value) => (
                        <option key={value} value={value}>{ENV_ROLES[value]}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        ))}
        <FormErrorList messages={errors} />
        <div className="form-actions">
          <button type="button" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="primary" disabled={save.isPending || !ready}>
            {save.isPending ? "Salvando…" : "Salvar"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteUser({ user, onClose }: { user: User; onClose: () => void }) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE("/users/{userId}", { params: { path: { userId: user.id } } })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["users"] });
      onClose();
    },
  });
  return (
    <ConfirmDialog
      title="Excluir usuário"
      message={<>Excluir <strong>{user.name}</strong> ({user.email})?</>}
      confirmLabel="Excluir"
      busy={remove.isPending}
      error={remove.isError ? statusMessage(remove.error) : null}
      onConfirm={() => remove.mutate()}
      onClose={onClose}
    />
  );
}
