import { useId, useState, type FormEvent } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { unwrap } from "../api/client";
import { apiV2, type Workspace, type WorkspaceCreationPolicy, type WorkspaceWrite } from "../api/client-v2";
import { statusMessage } from "../api/errors";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { Field, FormErrorList } from "../components/Field";
import { ConfirmDialog, Modal } from "../components/Modal";
import { PageHeader } from "../components/PageHeader";
import { RowMenu } from "../components/RowMenu";
import { Table } from "../components/Table";
import { FORBIDDEN, workspaceErrorMessage, workspaceFormErrors, type WorkspaceFormErrors } from "./workspace-errors";
import { normalizeSlug, slugProblem } from "./workspace-slug";

const NO_ERRORS: WorkspaceFormErrors = { fields: {}, form: [], suggestedSlug: null };
const STAGES = { dev: "DEV", hml: "HML", prd: "PRD" } as const;
// "kong" is reserved too (the slug check refuses it), but the product's UI never names the data plane.
export const SLUG_RULE = "Começa com letra minúscula; depois letras minúsculas, números e hífens, de 2 a 40 caracteres, sem hífen no fim nem dois seguidos. Reservados: api, admin, agent, status, metrics, health, healthz, ready, gromesh, gromesh-*, well-known, static, assets e outros nomes da plataforma.";

export const creationPolicyQuery = {
  queryKey: ["workspace-creation-policy"],
  queryFn: () => unwrap(apiV2.GET("/workspace-creation-policy")),
};

/** The Workspaces page, the selector (v1 environments: the same ids) and every open detail read the change. */
export function invalidateWorkspaceQueries(queryClient: QueryClient) {
  for (const queryKey of [["workspaces"], ["workspace"], ["environments"], ["environment"]]) void queryClient.invalidateQueries({ queryKey });
}

export function createWorkspaceMutation(queryClient: QueryClient, onCreated: (workspace: Workspace) => void) {
  return {
    mutationFn: (body: WorkspaceWrite) => unwrap(apiV2.POST("/workspaces", { body })),
    onSuccess: (workspace: Workspace) => {
      invalidateWorkspaceQueries(queryClient);
      onCreated(workspace);
    },
  };
}

export function updateWorkspaceMutation(queryClient: QueryClient, workspace: Workspace, onSaved: (workspace: Workspace) => void) {
  return {
    mutationFn: (body: { name: string; description?: string }) =>
      unwrap(apiV2.PATCH("/workspaces/{workspaceId}", { params: { path: { workspaceId: workspace.id } }, body })),
    onSuccess: (saved: Workspace) => {
      invalidateWorkspaceQueries(queryClient);
      onSaved(saved);
    },
  };
}

export function archiveWorkspaceMutation(queryClient: QueryClient, workspace: Workspace, onArchived: () => void) {
  return {
    mutationFn: () => unwrap(apiV2.POST("/workspaces/{workspaceId}/archive", { params: { path: { workspaceId: workspace.id } } })),
    onSuccess: () => {
      invalidateWorkspaceQueries(queryClient);
      onArchived();
    },
  };
}

export function WorkspacesPage() {
  const workspaces = useInfiniteQuery({
    queryKey: ["workspaces"],
    queryFn: ({ pageParam }) => unwrap(apiV2.GET("/workspaces", { params: { query: pageParam ? { cursor: pageParam } : {} } })),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const policy = useQuery(creationPolicyQuery);
  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState<Workspace | null>(null);
  const [editing, setEditing] = useState<Workspace | null>(null);
  const [archiving, setArchiving] = useState<Workspace | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const items = workspaces.data?.pages.flatMap((page) => page.items) ?? [];
  // No contract operation tells the caller's v2 permissions (a workspace-admin binding, platform.admin): every active
  // workspace offers both actions and the server's 403 says who may (workspace.admin edits, platform.admin archives).
  const active = (w: Workspace) => w.status === "active";

  return (
    <section className="final-page identity-page">
      <PageHeader
        title="Workspaces"
        description="Cada Workspace isola services, routes, consumers e plugins de um time nesta instância."
        actions={policy.data?.caller.canCreate && (
          <Button variant="primary" onClick={() => { setNotice(null); setCreating(true); }}>Criar Workspace</Button>
        )}
      />
      {policy.data && <Availability policy={policy.data} />}
      {policy.isError && <p className="error" role="alert">Não foi possível ler a política de criação: {statusMessage(policy.error)}</p>}
      {notice && <p className="note" role="status">{notice}</p>}
      {workspaces.isPending && <p className="muted">Carregando…</p>}
      {workspaces.isError && <p className="error" role="alert">{statusMessage(workspaces.error)}</p>}
      {workspaces.isSuccess && items.length === 0 && <EmptyState title="Nenhum Workspace visível." text="Você só vê os Workspaces em que tem acesso de leitura." />}
      {items.length > 0 && (
        <Table label="Workspaces" cards>
          <thead>
            <tr>
              <th>Nome → slug</th>
              <th>Status</th>
              <th>Descrição</th>
              <th aria-label="Ações" />
            </tr>
          </thead>
          <tbody>
            {items.map((w) => (
              <tr key={w.id} className={w.status === "archived" ? "row-off" : undefined}>
                <td className="row-main">
                  <div className="service-route">
                    <strong>{w.name}</strong>
                    <span className="arrow" aria-hidden="true">→</span>
                    <span className="target mono">{w.slug}</span>
                  </div>
                </td>
                <td><StatusBadge workspace={w} /></td>
                <td>{w.description || <span className="muted">Sem descrição</span>}</td>
                <td className="actions">
                  <div className="identity-actions">
                    <Button variant="quiet" aria-label={`Detalhes de ${w.name}`} onClick={() => setViewing(w)}>Detalhes</Button>
                    {active(w) && <Button variant="quiet" aria-label={`Editar ${w.name}`} onClick={() => { setNotice(null); setEditing(w); }}>Editar</Button>}
                    {active(w) && (
                      <RowMenu label={`Mais ações para ${w.name}`} items={[{ label: "Arquivar", danger: true, onSelect: () => { setNotice(null); setArchiving(w); } }]} />
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {workspaces.hasNextPage && (
        <Button disabled={workspaces.isFetchingNextPage} onClick={() => void workspaces.fetchNextPage()}>
          Carregar mais
        </Button>
      )}
      {creating && <CreateWorkspace onClose={() => setCreating(false)} onCreated={(w) => { setCreating(false); setNotice(`Workspace “${w.name}” criado com o slug ${w.slug}.`); }} />}
      {viewing && <WorkspaceDetail workspace={viewing} onClose={() => setViewing(null)} />}
      {editing && <EditWorkspace workspace={editing} onClose={() => setEditing(null)} onSaved={(w) => { setEditing(null); setNotice(`Workspace “${w.name}” atualizado.`); }} />}
      {archiving && <ArchiveWorkspace workspace={archiving} onClose={() => setArchiving(null)} onArchived={() => { setArchiving(null); setNotice(`Workspace “${archiving.name}” arquivado.`); }} />}
    </section>
  );
}

function StatusBadge({ workspace }: { workspace: Workspace }) {
  return workspace.status === "active" ? <Badge tone="converged">Ativo</Badge> : <Badge tone="off">Arquivado</Badge>;
}

/** What this instance allows, from the creation policy; no action here leads around it. */
export function Availability({ policy }: { policy: WorkspaceCreationPolicy }) {
  const lines: string[] = [];
  if (policy.workspacesMode === "disabled") {
    lines.push("Workspaces em modo desativado nesta instância: a criação de Workspaces só existe no laboratório isolado autorizado. Deployment e ativação operacional de Workspaces estão indisponíveis.");
  }
  if (policy.stage === "hml" || policy.stage === "prd") {
    lines.push(`Esta instância é ${STAGES[policy.stage]}. HML e PRD recebem Workspaces só por promoção; aqui não se cria Workspace.`);
  } else if (policy.stage === null) {
    lines.push("O stage desta instância não está configurado, então a criação de Workspaces fica bloqueada.");
  }
  if (lines.length > 0) {
    return (
      <div className="warn" role="note" aria-label="Disponibilidade">
        {lines.map((line) => <p key={line}>{line}</p>)}
      </div>
    );
  }
  return (
    <div className="note" role="note" aria-label="Disponibilidade">
      <p>Laboratório isolado: um Workspace criado aqui não chega a nenhum data plane sem um deployment.</p>
      {policy.caller.canRequest && !policy.caller.canCreate && <p>A solicitação de Workspaces ainda não está disponível nesta interface.</p>}
    </div>
  );
}

export function CreateWorkspace({ onClose, onCreated }: { onClose: () => void; onCreated: (workspace: Workspace) => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  // null: follows the name; a string once the user edits it or accepts a suggestion.
  const [ownSlug, setOwnSlug] = useState<string | null>(null);
  const [local, setLocal] = useState<WorkspaceFormErrors>(NO_ERRORS);
  const create = useMutation(createWorkspaceMutation(queryClient, onCreated));
  const slug = ownSlug ?? normalizeSlug(name);
  const ruleId = useId();
  const errors = create.isError ? workspaceFormErrors(create.error) : local;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.reset();
    const problem = slugProblem(slug);
    const fields: Record<string, string[]> = {
      ...(name.trim() ? {} : { name: ["Informe o nome."] }),
      ...(problem === "reserved" ? { slug: ["Slug reservado pela plataforma. Escolha outro."] }
        : problem === "invalid" ? { slug: [slug ? "Slug inválido: confira a regra abaixo." : "O nome não gera um slug válido: informe um."] } : {}),
    };
    setLocal({ fields, form: [], suggestedSlug: null });
    if (Object.keys(fields).length === 0) create.mutate({ name: name.trim(), slug, ...(description.trim() ? { description: description.trim() } : {}) });
  };

  return (
    <Modal title="Criar Workspace" onClose={onClose}>
      <form onSubmit={submit} className="form" noValidate>
        <Field label="Nome" errors={errors.fields.name}>
          {(id, invalid) => <input id={id} aria-invalid={invalid} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label="Descrição" errors={errors.fields.description}>
          {(id, invalid) => <textarea id={id} aria-invalid={invalid} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />}
        </Field>
        <Field label="Slug" errors={errors.fields.slug}>
          {(id, invalid) => (
            <input id={id} className="mono" aria-invalid={invalid} aria-describedby={ruleId} autoComplete="off" spellCheck={false} value={slug} onChange={(e) => setOwnSlug(e.target.value)} />
          )}
        </Field>
        <p className="muted" id={ruleId}><small>{SLUG_RULE} O slug é o prefixo público do Workspace e não muda depois da primeira release.</small></p>
        {errors.suggestedSlug && errors.suggestedSlug !== slug && (
          <p>
            <Button onClick={() => { setOwnSlug(errors.suggestedSlug); create.reset(); setLocal(NO_ERRORS); }}>
              Usar {errors.suggestedSlug}
            </Button>
          </p>
        )}
        <FormErrorList messages={errors.form} />
        <div className="form-actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button type="submit" className="primary" disabled={create.isPending}>
            {create.isPending ? "Criando…" : "Criar"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function EditWorkspace({ workspace, onClose, onSaved }: { workspace: Workspace; onClose: () => void; onSaved: (workspace: Workspace) => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(workspace.name);
  const [description, setDescription] = useState(workspace.description ?? "");
  const [local, setLocal] = useState<string[]>([]);
  const save = useMutation(updateWorkspaceMutation(queryClient, workspace, onSaved));
  const errors = save.isError ? workspaceFormErrors(save.error, FORBIDDEN.edit) : { fields: local.length ? { name: local } : {}, form: [], suggestedSlug: null };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.reset();
    setLocal(name.trim() ? [] : ["Informe o nome."]);
    if (name.trim()) save.mutate({ name: name.trim(), ...(description !== (workspace.description ?? "") ? { description } : {}) });
  };

  return (
    <Modal title={`Editar ${workspace.name}`} onClose={onClose}>
      <form onSubmit={submit} className="form" noValidate>
        <Field label="Nome" errors={errors.fields.name}>
          {(id, invalid) => <input id={id} aria-invalid={invalid} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label="Descrição" errors={errors.fields.description}>
          {(id, invalid) => <textarea id={id} aria-invalid={invalid} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />}
        </Field>
        <dl className="props">
          <dt>Slug</dt>
          <dd className="mono">{workspace.slug}</dd>
        </dl>
        <p className="muted">O slug não muda por aqui.</p>
        <FormErrorList messages={errors.form} />
        <div className="form-actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button type="submit" className="primary" disabled={save.isPending}>
            {save.isPending ? "Salvando…" : "Salvar"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function WorkspaceDetail({ workspace, onClose }: { workspace: Workspace; onClose: () => void }) {
  const detail = useQuery({
    queryKey: ["workspace", workspace.id],
    queryFn: () => unwrap(apiV2.GET("/workspaces/{workspaceId}", { params: { path: { workspaceId: workspace.id } } })),
  });
  const w = detail.data ?? workspace;
  return (
    <Modal title={w.name} onClose={onClose}>
      {detail.isError && <p className="error" role="alert">{statusMessage(detail.error)}</p>}
      <dl className="props">
        <dt>Status</dt>
        <dd><StatusBadge workspace={w} /></dd>
        <dt>Slug</dt>
        <dd className="mono">{w.slug}</dd>
        <dt>ID</dt>
        <dd className="mono">{w.id}</dd>
        <dt>Key</dt>
        <dd className="mono">{w.key}</dd>
        <dt>Release ativa</dt>
        <dd>{w.activeRelease == null ? "Nenhuma" : `v${w.activeRelease}`}</dd>
        {w.provisionedByPromotion && (
          <>
            <dt>Provisionado pela promoção</dt>
            <dd className="mono">{w.provisionedByPromotion}</dd>
          </>
        )}
        <dt>Descrição</dt>
        <dd>{w.description || "Sem descrição"}</dd>
      </dl>
      <div className="form-actions">
        <button type="button" onClick={onClose}>Fechar</button>
      </div>
    </Modal>
  );
}

function ArchiveWorkspace({ workspace, onClose, onArchived }: { workspace: Workspace; onClose: () => void; onArchived: () => void }) {
  const queryClient = useQueryClient();
  const archive = useMutation(archiveWorkspaceMutation(queryClient, workspace, onArchived));
  return (
    <ConfirmDialog
      title="Arquivar Workspace"
      message={<>Arquivar <strong>{workspace.name}</strong> (<span className="mono">{workspace.slug}</span>)? Nada é apagado, mas o Workspace passa a ser somente leitura e o slug continua reservado.</>}
      confirmLabel="Arquivar"
      busy={archive.isPending}
      error={archive.isError ? workspaceErrorMessage(archive.error, FORBIDDEN.archive) : null}
      onConfirm={() => archive.mutate()}
      onClose={onClose}
    />
  );
}
