import { useDeferredValue, useState, type FormEvent } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrap } from "../api/client";
import { apiV2, type WorkspaceService, type WorkspaceServiceWrite } from "../api/client-v2";
import { statusMessage, type FormErrors } from "../api/errors";
import { CheckboxField, Field, FormErrorList } from "../components/Field";
import { ConfirmDialog, Modal } from "../components/Modal";
import { Link, useNavigate, useParams } from "react-router";
import { useEnvId, useEnvironment } from "../components/Shell";
import { Badge, DraftBadge } from "../components/Badge";
import { RowMenu } from "../components/RowMenu";
import { Button } from "../components/Button";
import { Table } from "../components/Table";
import { PageHeader } from "../components/PageHeader";
import { EmptyState } from "../components/EmptyState";
import { ScopedPlugins } from "./Plugins";
import { ScopedRoutes } from "./Routes";
import { gatewayErrorMessage, gatewayFormErrors } from "./gateway-errors";
import {
  fieldText, serviceTargetV2, useInvalidateWorkspaceGateway, useWorkspaceServices, useWorkspaceUpstreams, useWorkspaceGatewayAccess, WorkspaceGatewayNote,
} from "./workspace-gateway";

// Services of the selected workspace through API v2 (WS-S1); the v1 hooks below stay for the screens still on v1
// (plugins, analytics), which read the same rows: the workspace is the environment with the same id.
const PROTOCOLS = ["http", "https", "grpc", "grpcs", "tcp", "tls"] as const;
type Protocol = (typeof PROTOCOLS)[number];
const NO_ERRORS: FormErrors = { fields: {}, form: [] };
const KEPT = ["retries", "connectTimeoutMs", "readTimeoutMs", "writeTimeoutMs"] as const;

/** Every edit changes the draft: refresh the lists and the "unpublished changes" bar. */
export function useInvalidateDraft(envId: string) {
  const queryClient = useQueryClient();
  return (...keys: string[]) => {
    for (const k of keys) void queryClient.invalidateQueries({ queryKey: [k, envId] });
    void queryClient.invalidateQueries({ queryKey: ["environment", envId] });
    void queryClient.invalidateQueries({ queryKey: ["preview", envId] });
  };
}

export function useServices(envId: string, q = "") {
  return useInfiniteQuery({
    queryKey: ["services", envId, q],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/environments/{envId}/services", {
          params: { path: { envId }, query: { ...(q ? { q } : {}), ...(pageParam ? { cursor: pageParam } : {}) } },
        }),
      ),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

/** Which entities the draft adds or changes, from the publish preview (the strip loads the same query). */
export function useEntityDraft(envId: string, kind: "services" | "routes" | "plugins"): Map<string, "added" | "modified"> {
  const env = useEnvironment(envId);
  const pending = env.data?.hasUnpublishedChanges ?? false;
  const preview = useQuery({
    queryKey: ["preview", envId],
    queryFn: () => unwrap(api.GET("/environments/{envId}/publish-preview", { params: { path: { envId } } })),
    enabled: pending,
  });
  const draft = new Map<string, "added" | "modified">();
  if (!pending) return draft;
  for (const c of preview.data?.changes ?? []) if (c.kind === kind && c.change !== "removed") draft.set(c.id, c.change);
  return draft;
}

/** Keyed by the workspace: switching it remounts the screen, so no modal or form keeps the previous one's entity. */
export function ServicesPage() {
  const envId = useEnvId();
  return <WorkspaceServices key={envId} workspaceId={envId} />;
}

export function ServiceDetailPage() {
  const envId = useEnvId();
  const { serviceId } = useParams();
  return <WorkspaceServiceDetail key={`${envId}/${serviceId}`} workspaceId={envId} serviceId={serviceId!} />;
}

function WorkspaceServices({ workspaceId }: { workspaceId: string }) {
  const { canWrite } = useWorkspaceGatewayAccess(workspaceId);
  const [search, setSearch] = useState("");
  const [onlyChanged, setOnlyChanged] = useState(false);
  const q = useDeferredValue(search.trim());
  const services = useWorkspaceServices(workspaceId, q);
  const draft = useEntityDraft(workspaceId, "services");
  const [editing, setEditing] = useState<WorkspaceService | "new" | null>(null);
  const [deleting, setDeleting] = useState<WorkspaceService | null>(null);
  const all = services.data?.pages.flatMap((p) => p.items) ?? [];
  const changed = all.filter((s) => draft.has(s.id));
  const items = onlyChanged ? changed : all;

  return (
    <section className="final-page">
      <PageHeader
        title="Services"
        description="Os destinos para onde o gateway encaminha as requisições deste Workspace."
        // No contract operation tells the caller's v2 permissions (a binding may grant gateway.write): every signed-in
        // user is offered the actions and the server decides (its 403 is shown in Portuguese).
        actions={canWrite && (
          <Button variant="primary" onClick={() => setEditing("new")}>
            Novo service
          </Button>
        )}
      />
      <WorkspaceGatewayNote workspaceId={workspaceId} />
      <div className="pills" role="group" aria-label="Filtrar services">
        <button type="button" aria-pressed={!onlyChanged} onClick={() => setOnlyChanged(false)}>
          Todos <span className="count">{all.length}</span>
        </button>
        <button type="button" aria-pressed={onlyChanged} onClick={() => setOnlyChanged(true)}>
          Com alterações <span className="count">{changed.length}</span>
        </button>
      </div>
      <input type="search" className="search" placeholder="Buscar por nome" aria-label="Buscar services" value={search} onChange={(e) => setSearch(e.target.value)} />
      {services.isPending && <p className="muted">Carregando…</p>}
      {services.isError && <p className="error">{statusMessage(services.error)}</p>}
      {services.isSuccess && items.length === 0 && (
        <EmptyState
          title={onlyChanged ? "Nenhum service com alterações não publicadas." : q ? "Nenhum service encontrado." : "Nenhum service ainda."}
          text={canWrite && !onlyChanged && !q ? "Crie o primeiro para começar a rotear tráfego." : undefined}
        />
      )}
      {items.length > 0 && (
        <Table label="Services" cards>
          <thead>
            <tr>
              <th>Service → destino</th>
              <th>
                <span className="visually-hidden">Ações</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((s) => (
              <tr key={s.id} className={s.enabled === false ? "row-off" : undefined}>
                <td className="row-main">
                  <div className="service-route">
                    {/* The whole row opens the service: this link covers it, the actions sit above it. */}
                    <Link to={s.id} className="row-open service-name">
                      {s.name}
                    </Link>
                    <DraftBadge change={draft.get(s.id)} />
                    {s.enabled === false && <Badge tone="off">Desativado</Badge>}
                    {s.upstreamId && <Badge tone="converged">Upstream</Badge>}
                    <span className="arrow" aria-hidden="true">
                      →
                    </span>
                    <span className="visually-hidden">destino</span>
                    <span className="target mono">{serviceTargetV2(s)}</span>
                  </div>
                </td>
                <td className="actions">
                  {canWrite && (
                    <>
                      <Button variant="quiet" onClick={() => setEditing(s)}>
                        Editar
                      </Button>
                      <RowMenu label={`Mais ações para ${s.name}`} items={[{ label: "Excluir", danger: true, onSelect: () => setDeleting(s) }]} />
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {services.hasNextPage && !onlyChanged && (
        <Button onClick={() => void services.fetchNextPage()} disabled={services.isFetchingNextPage}>
          Carregar mais
        </Button>
      )}
      {canWrite && editing && <ServiceForm workspaceId={workspaceId} service={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {canWrite && deleting && <DeleteService workspaceId={workspaceId} service={deleting} onClose={() => setDeleting(null)} />}
    </section>
  );
}

function WorkspaceServiceDetail({ workspaceId, serviceId }: { workspaceId: string; serviceId: string }) {
  const navigate = useNavigate();
  const { canWrite } = useWorkspaceGatewayAccess(workspaceId);
  const draft = useEntityDraft(workspaceId, "services");
  const upstreams = useWorkspaceUpstreams(workspaceId);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const service = useQuery({
    queryKey: ["ws-service", workspaceId, serviceId],
    queryFn: () => unwrap(apiV2.GET("/workspaces/{workspaceId}/services/{serviceId}", { params: { path: { workspaceId, serviceId } } })),
  });

  if (service.isPending) return <p className="muted">Carregando…</p>;
  if (service.isError) return <p className="error">{statusMessage(service.error)}</p>;
  const s = service.data;
  const upstream = upstreams.data?.find((u) => u.id === s.upstreamId);
  return (
    <section className="stack final-page service-detail">
      <p>
        <Link to=".." className="back-link">← Services</Link>
      </p>
      <PageHeader
        title={
          <span className="title-with-badges">
            {s.name} <DraftBadge change={draft.get(s.id)} />
            {s.enabled === false && <Badge tone="off">Desativado</Badge>}
          </span>
        }
        description={<span className="mono">{serviceTargetV2(s)}</span>}
        actions={canWrite && (
          <div className="form-actions">
            <Button variant="primary" onClick={() => setEditing(true)}>
              Editar
            </Button>
            <RowMenu label={`Mais ações para ${s.name}`} items={[{ label: "Excluir", danger: true, onSelect: () => setDeleting(true) }]} />
          </div>
        )}
      />
      <WorkspaceGatewayNote workspaceId={workspaceId} />
      <dl className="service-properties" aria-label="Propriedades do service">
        <dt>Destino</dt>
        <dd>{s.upstreamId ? <>Upstream do Workspace <span className="mono">{upstream?.name ?? fieldText(s.host)}</span></> : "Destino direto (DNS)"}</dd>
        <dt>Protocolo</dt>
        <dd className="mono">{fieldText(s.protocol)}</dd>
        <dt>Host</dt>
        <dd className="mono">{fieldText(s.host)}</dd>
        <dt>Porta</dt>
        <dd className="mono">{fieldText(s.port)}</dd>
        <dt>Path no destino</dt>
        <dd className="mono">{fieldText(s.path) || "—"}</dd>
        <dt>Tags</dt>
        <dd>{s.tags?.join(", ") || "—"}</dd>
      </dl>
      <p className="muted">Gerencie as routes na tela de <Link className="strip-link" to={`/e/${workspaceId}/routes?serviceId=${s.id}`}>Routes do Workspace</Link>.</p>
      <ScopedRoutes envId={workspaceId} service={s} readOnly />
      <p className="muted">Plugins por Workspace ainda não são editáveis aqui.</p>
      <ScopedPlugins envId={workspaceId} scope={{ kind: "service", id: s.id }} title="Plugins do service" readOnly />
      {canWrite && editing && <ServiceForm workspaceId={workspaceId} service={s} onClose={() => setEditing(false)} />}
      {canWrite && deleting && <DeleteService workspaceId={workspaceId} service={s} onClose={() => setDeleting(false)} onDeleted={() => navigate("..")} />}
    </section>
  );
}

/** Create (no service) or replace; the caller sees success only through `onSaved`, after the server's 201 or 200. */
export function saveServiceMutation(workspaceId: string, service: WorkspaceService | null, invalidate: () => void, onSaved: (saved: WorkspaceService) => void) {
  return {
    mutationFn: (body: WorkspaceServiceWrite) => service
      ? unwrap(apiV2.PUT("/workspaces/{workspaceId}/services/{serviceId}", { params: { path: { workspaceId, serviceId: service.id } }, body }))
      : unwrap(apiV2.POST("/workspaces/{workspaceId}/services", { params: { path: { workspaceId } }, body })),
    onSuccess: (saved: WorkspaceService) => {
      invalidate();
      onSaved(saved);
    },
  };
}

/** Keeps a field this form shows as text when the user left it as it was (a VarRef stays a VarRef). */
function keep<T>(original: T | undefined, shown: string, typed: string, parse: (v: string) => T): T {
  return original !== undefined && typed === shown ? original : parse(typed);
}

export function initialServiceForm(service: WorkspaceService | null) {
  return {
    name: service?.name ?? "",
    target: service?.upstreamId ? "upstream" : "dns",
    upstreamId: service?.upstreamId ?? "",
    protocol: fieldText(service?.protocol) || "http",
    host: service?.upstreamId ? "" : fieldText(service?.host),
    port: fieldText(service?.port) || "80",
    path: fieldText(service?.path),
    enabled: service?.enabled ?? true,
    tags: (service?.tags ?? []).join(", "),
  };
}

export function serviceBody(service: WorkspaceService | null, form: ReturnType<typeof initialServiceForm>, chosen: { id: string; name: string } | undefined): WorkspaceServiceWrite {
  // PUT replaces the whole service: keep what this form does not edit (retries, timeouts), and send only the
  // fields WorkspaceServiceWrite declares (the response carries more: id, workspaceId, timestamps).
  const kept = Object.fromEntries(KEPT.flatMap((k) => (service?.[k] === undefined ? [] : [[k, service[k]]])));
  return {
    ...kept,
    name: form.name.trim(),
    protocol: keep(service?.protocol, fieldText(service?.protocol), form.protocol, (v) => v as Protocol),
    // The upstream's name is the host the compiler resolves (and what the server checks against upstreamId).
    host: chosen && form.target === "upstream"
      ? service?.upstreamId === chosen.id && typeof service.host === "object" ? service.host : chosen.name
      : keep(service?.host, fieldText(service?.host), form.host.trim(), (v) => v),
    port: keep(service?.port, fieldText(service?.port), form.port.trim(), Number),
    path: keep(service?.path, fieldText(service?.path), form.path.trim(), (v) => v || null),
    upstreamId: form.target === "upstream" ? chosen?.id ?? null : null,
    enabled: form.enabled,
    tags: splitList(form.tags),
  };
}

export function ServiceForm({ workspaceId, service, onClose }: { workspaceId: string; service: WorkspaceService | null; onClose: () => void }) {
  const invalidate = useInvalidateWorkspaceGateway(workspaceId);
  const access = useWorkspaceGatewayAccess(workspaceId);
  const upstreams = useWorkspaceUpstreams(workspaceId);
  const upstreamList = upstreams.data ?? [];
  const [form, setForm] = useState(() => initialServiceForm(service));
  const [local, setLocal] = useState<FormErrors>(NO_ERRORS);
  const save = useMutation(saveServiceMutation(workspaceId, service, invalidate, onClose));
  const errors = save.isError ? gatewayFormErrors(save.error, "service") : local;
  const chosen = upstreamList.find((u) => u.id === form.upstreamId);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!access.canWrite) return;
    save.reset();
    const fields: Record<string, string[]> = {
      ...(form.name.trim() ? {} : { name: ["Nome: campo obrigatório."] }),
      ...(form.target === "upstream" && !chosen ? { upstreamId: ["Escolha um upstream do Workspace."] } : {}),
      ...(form.target === "dns" && !form.host.trim() ? { host: ["Host: campo obrigatório."] } : {}),
    };
    setLocal({ fields, form: [] });
    if (Object.keys(fields).length > 0) return;
    const body = serviceBody(service, form, chosen);
    save.mutate(body);
  };
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const title = service ? `Editar ${service.name}` : "Novo service";
  if (!access.canWrite) return <Modal title={title} onClose={onClose}><p role="status">{access.reason}</p></Modal>;
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit} className="form" noValidate>
        <Field label="Nome" errors={errors.fields.name}>
          {(id, invalid) => <input id={id} aria-invalid={invalid} value={form.name} onChange={(e) => set("name", e.target.value)} />}
        </Field>
        <Field label="Destino" hint={upstreams.isSuccess && upstreamList.length === 0 ? "Este Workspace ainda não tem upstreams: use um destino direto." : undefined}>
          {(id) => (
            <select id={id} value={form.target} onChange={(e) => set("target", e.target.value)}>
              <option value="upstream" disabled={upstreamList.length === 0}>Upstream do Workspace</option>
              <option value="dns">Destino direto (DNS)</option>
            </select>
          )}
        </Field>
        {form.target === "upstream" ? (
          <Field label="Upstream" errors={errors.fields.upstreamId ?? errors.fields.host} hint={chosen ? `O host do service passa a ser ${chosen.name}, balanceado pelos targets do upstream.` : undefined}>
            {(id, invalid) => (
              <select id={id} aria-invalid={invalid} value={form.upstreamId} onChange={(e) => set("upstreamId", e.target.value)}>
                <option value="">Escolha um upstream</option>
                {upstreamList.map((u) => (
                  <option key={u.id} value={u.id}>{u.name}</option>
                ))}
              </select>
            )}
          </Field>
        ) : (
          <Field label="Host" errors={errors.fields.host ?? errors.fields.upstreamId} hint="Resolvido por DNS. O nome de um upstream do Workspace não vale aqui.">
            {(id, invalid) => <input id={id} aria-invalid={invalid} value={form.host} onChange={(e) => set("host", e.target.value)} placeholder="orders.internal" />}
          </Field>
        )}
        <div className="row">
          <Field label="Protocolo" errors={errors.fields.protocol}>
            {(id, invalid) => (
              <select id={id} aria-invalid={invalid} value={form.protocol} onChange={(e) => set("protocol", e.target.value)}>
                {typeof service?.protocol === "object" && <option value={fieldText(service.protocol)}>{fieldText(service.protocol)}</option>}
                {PROTOCOLS.map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Path no destino" errors={errors.fields.path} hint="Opcional, ex.: /v1">
            {(id, invalid) => <input id={id} aria-invalid={invalid} value={form.path} onChange={(e) => set("path", e.target.value)} />}
          </Field>
          <Field label="Porta" errors={errors.fields.port}>
            {(id, invalid) => <input id={id} aria-invalid={invalid} inputMode="numeric" value={form.port} onChange={(e) => set("port", e.target.value)} />}
          </Field>
        </div>
        <Field label="Tags" errors={errors.fields.tags} hint="Separadas por vírgula">
          {(id, invalid) => <input id={id} aria-invalid={invalid} value={form.tags} onChange={(e) => set("tags", e.target.value)} />}
        </Field>
        <CheckboxField label="Ativo" checked={form.enabled} onChange={(checked) => set("enabled", checked)} errors={errors.fields.enabled} />
        <p className="muted">A alteração entra no rascunho do Workspace; nada é implantado.</p>
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

function DeleteService({ workspaceId, service, onClose, onDeleted }: { workspaceId: string; service: WorkspaceService; onClose: () => void; onDeleted?: () => void }) {
  const invalidate = useInvalidateWorkspaceGateway(workspaceId);
  const remove = useMutation({
    mutationFn: () => unwrap(apiV2.DELETE("/workspaces/{workspaceId}/services/{serviceId}", { params: { path: { workspaceId, serviceId: service.id } } })),
    onSuccess: () => {
      invalidate();
      onClose();
      onDeleted?.();
    },
  });
  return (
    <ConfirmDialog
      title="Excluir service"
      message={
        <>
          Excluir <strong>{service.name}</strong>? A exclusão entra no rascunho e só afeta o tráfego depois de publicar.
        </>
      }
      confirmLabel="Excluir"
      busy={remove.isPending}
      error={remove.isError ? gatewayErrorMessage(remove.error) : null}
      onConfirm={() => remove.mutate()}
      onClose={onClose}
    />
  );
}

/** Comma/newline entry for arrays of tags, hosts and methods; path patterns need splitPaths instead. */
export function splitList(v: string): string[] {
  return v
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Paths can contain commas (including regex quantifiers); only line breaks separate them. */
export function splitPaths(v: string): string[] {
  return v.split(/\r\n|[\r\n]/).map((s) => s.trim()).filter(Boolean);
}
