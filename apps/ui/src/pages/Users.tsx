import { useState, type FormEvent } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, unwrap, type User, type UserCreate, type UserUpdate } from "../api/client";
import { statusMessage, toFormErrors, type FormErrors } from "../api/errors";
import { Field, FormErrorList } from "../components/Field";
import { ConfirmDialog, Modal } from "../components/Modal";

const ROLES: Record<User["role"], string> = { viewer: "Leitor", editor: "Editor", admin: "Administrador" };
const FIELDS = ["email", "name", "role", "active", "password"] as const;

export function UsersPage() {
  const users = useInfiniteQuery({
    queryKey: ["users"],
    queryFn: ({ pageParam }) => unwrap(api.GET("/users", { params: { query: pageParam ? { cursor: pageParam } : {} } })),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const [editing, setEditing] = useState<User | "new" | null>(null);
  const [deleting, setDeleting] = useState<User | null>(null);
  const items = users.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section>
      <div className="page-head">
        <h1>Usuários</h1>
        <button type="button" className="primary" onClick={() => setEditing("new")}>
          Novo usuário
        </button>
      </div>
      {users.isPending && <p className="muted">Carregando…</p>}
      {users.isError && <p className="error" role="alert">{statusMessage(users.error)}</p>}
      {users.isSuccess && items.length === 0 && <p className="muted">Nenhum usuário encontrado.</p>}
      {items.length > 0 && (
        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th>Nome</th>
                <th>E-mail</th>
                <th>Papel</th>
                <th>Ativo</th>
                <th aria-label="Ações" />
              </tr>
            </thead>
            <tbody>
              {items.map((user) => (
                <tr key={user.id}>
                  <td>{user.name}</td>
                  <td>{user.email}</td>
                  <td>{ROLES[user.role]}</td>
                  <td>{user.active ? "Sim" : "Não"}</td>
                  <td className="actions">
                    <button type="button" onClick={() => setEditing(user)}>
                      Editar
                    </button>
                    <button type="button" className="danger" onClick={() => setDeleting(user)}>
                      Excluir
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {users.hasNextPage && (
        <button type="button" disabled={users.isFetchingNextPage} onClick={() => void users.fetchNextPage()}>
          Carregar mais
        </button>
      )}
      {editing && <UserForm user={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {deleting && <DeleteUser user={deleting} onClose={() => setDeleting(null)} />}
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
    save.mutate();
  };

  return (
    <Modal title={user ? `Editar ${user.name}` : "Novo usuário"} onClose={onClose}>
      <form onSubmit={submit} className="form" noValidate>
        <Field label="Nome" errors={errors.fields.name}>
          {(id, invalid) => (
            <input id={id} aria-invalid={invalid} autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} />
          )}
        </Field>
        {user ? <p className="muted">{user.email}</p> : (
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
              <input id={id} className="user-active" type="checkbox" aria-invalid={invalid} checked={active} onChange={(event) => setActive(event.target.checked)} />
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
