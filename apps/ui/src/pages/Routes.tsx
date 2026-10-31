import { useDeferredValue, useState, type FormEvent } from "react";
import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { apiV2, type WorkspaceRoute, type WorkspaceRouteWrite } from "../api/client-v2";
import { unwrap } from "../api/client";
import { statusMessage, type FormErrors } from "../api/errors";
import { CheckboxField, Field, FormErrorList } from "../components/Field";
import { ConfirmDialog, Modal } from "../components/Modal";
import { useEnvId } from "../components/Shell";
import { ScopedPlugins } from "./Plugins";
import { splitPaths, splitList, useEntityDraft } from "./Services";
import { PageHeader } from "../components/PageHeader";
import { EmptyState } from "../components/EmptyState";
import { Table } from "../components/Table";
import { Badge, DraftBadge } from "../components/Badge";
import { Button } from "../components/Button";
import { RowMenu } from "../components/RowMenu";
import { RoutePaths, useRoutePublication } from "./route-publication";
import { gatewayErrorMessage, gatewayFormErrors } from "./gateway-errors";
import { fieldText, useAllWorkspaceServices, useInvalidateWorkspaceGateway, useWorkspace, useWorkspaceGatewayAccess, WorkspaceGatewayNote } from "./workspace-gateway";

// CRUD v2 does not select the delivery protocol. A legacy route retains stripPath without implicit conversion.
const PROTOCOLS = ["http", "https", "grpc", "grpcs"] as const;
type Protocol = (typeof PROTOCOLS)[number];
const NO_ERRORS: FormErrors = { fields: {}, form: [] };
const PATHLESS_LEGACY = "Esta route legada sem paths é somente leitura. Ela exige o fluxo legado apropriado ou uma conversão explícita e auditada; a tela v2 não a edita.";
const LEGACY = "Route migrada de um environment: mantém o stripPath que tinha. A conversão para o padrão do Workspace é uma ação separada e nunca acontece ao salvar.";

/** Keyed by the workspace: switching it remounts the screen, so no modal or form keeps the previous one's route. */
export function RoutesPage() {
  const envId = useEnvId();
  // The service filter lives in the URL so it can be linked from a service.
  const [params, setParams] = useSearchParams();
  const serviceId = params.get("serviceId") ?? "";
  return (
    <section className="final-page">
      <RouteList key={envId} workspaceId={envId} serviceId={serviceId} onServiceChange={(id) => setParams(id ? { serviceId: id } : {})} />
    </section>
  );
}

export function ScopedRoutes({ envId, service, readOnly = false }: { envId: string; service: { id: string; name: string }; readOnly?: boolean }) {
  return (
    <section aria-label="Routes do service">
      <RouteList key={envId} workspaceId={envId} serviceId={service.id} service={service} readOnly={readOnly} />
    </section>
  );
}

function RouteList({ workspaceId, serviceId, service, onServiceChange, readOnly = false }: { workspaceId: string; serviceId: string; service?: { id: string; name: string }; onServiceChange?: (id: string) => void; readOnly?: boolean }) {
  const draft = useEntityDraft(workspaceId, "routes");
  const publication = useRoutePublication(workspaceId);
  const workspace = useWorkspace(workspaceId);
  const access = useWorkspaceGatewayAccess(workspaceId);
  const canWrite = !readOnly && access.canWrite;
  // A newly mounted dialog revalidates stale access; keep it mounted while submission stays blocked.
  const keepDialogs = !readOnly && (access.canWrite || access.isRevalidating);
  const slug = workspace.data?.slug;
  const [search, setSearch] = useState("");
  const q = useDeferredValue(search.trim());
  const services = useAllWorkspaceServices(workspaceId);
  const serviceList = services.data ?? [];
  const servicePath = (id: string) => {
    const stored = serviceList.find((s) => s.id === id);
    return stored ? fieldText(stored.path) || null : undefined;
  };
  const serviceName = (id: string) => (id === service?.id ? service.name : serviceList.find((s) => s.id === id)?.name) ?? id.slice(0, 8);

  const routes = useInfiniteQuery({
    queryKey: ["ws-routes", workspaceId, q, serviceId],
    queryFn: ({ pageParam }) => unwrap(apiV2.GET("/workspaces/{workspaceId}/routes", {
      params: { path: { workspaceId }, query: { ...(q ? { q } : {}), ...(serviceId ? { serviceId } : {}), ...(pageParam ? { cursor: pageParam } : {}) } },
    })),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const [editing, setEditing] = useState<WorkspaceRoute | "new" | null>(null);
  const [details, setDetails] = useState<WorkspaceRoute | null>(null);
  const [deleting, setDeleting] = useState<WorkspaceRoute | null>(null);
  const [plugins, setPlugins] = useState<WorkspaceRoute | null>(null);
  const items = routes.data?.pages.flatMap((p) => p.items) ?? [];
  // No contract operation tells the caller's v2 permissions (a binding may grant gateway.write): every signed-in user
  // is offered actions when this workspace allows writes and the server decides (its 403 is shown in Portuguese).
  const createAction = canWrite && (
    <Button variant="primary" onClick={() => setEditing("new")} disabled={serviceList.length === 0 || !slug} title={serviceList.length === 0 ? "Crie um service primeiro" : undefined}>
      Nova route
    </Button>
  );

  return (
    <div className="gateway-list">
      {service ? <div className="page-head"><h2>Routes do service</h2>{createAction}</div> : (
        <>
          <PageHeader title="Routes" description="Paths configurados, publicação no fluxo v1 e previsão para a configuração v2." actions={createAction} />
          <WorkspaceGatewayNote workspaceId={workspaceId} />
        </>
      )}
      {service && !readOnly && access.reason && <p role="status">{access.reason}</p>}
      <div className="gateway-filters">
        <input type="search" className="search" placeholder="Buscar por nome, path ou host" aria-label="Buscar routes" value={search} onChange={(e) => setSearch(e.target.value)} />
        {onServiceChange && <select aria-label="Filtrar por service" value={serviceId} onChange={(e) => onServiceChange(e.target.value)}>
          <option value="">Todos os services</option>
          {serviceList.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>}
      </div>
      {routes.isPending && <p className="muted">Carregando…</p>}
      {routes.isError && <p className="error">{statusMessage(routes.error)}</p>}
      {routes.isSuccess && items.length === 0 && <EmptyState title="Nenhuma route encontrada." />}
      {items.length > 0 && (
        <Table label={service ? "Routes do service" : "Routes"} cards>
          <thead>
            <tr>
              <th>Route → configuração e publicação / service</th>
              {!readOnly && <th className="actions" aria-label="Ações" />}
            </tr>
          </thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.id}>
                <td className="row-main">
                  <div className="service-route">
                    <span className="service-name">{r.name}</span>
                    <DraftBadge change={draft.get(r.id)} />
                    {r.pathCompatibility === "legacy-preserved" && <Badge tone="warning">Legada</Badge>}
                    <span className="arrow" aria-hidden="true">→</span>
                    <span className="muted">Service <span className="mono">{serviceName(r.serviceId)}</span></span>
                  </div>
                  <RoutePaths route={r} slug={slug} servicePath={servicePath(r.serviceId)} publication={publication} />
                  <div className="route-matches">
                    <span className="muted">Métodos</span>
                    {r.methods === undefined ? <span className="match-chip mono">todos</span> : r.methods.map((m) => <span className="match-chip mono" key={m}>{m}</span>)}
                    <span className="muted">Hosts</span>
                    {r.hosts?.length ? r.hosts.map((h) => <span className="match-chip mono" key={h}>{h}</span>) : <span className="mono">—</span>}
                  </div>
                  {r.pathCompatibility === "legacy-preserved" && <p className="muted"><small>{isPathlessLegacy(r) ? PATHLESS_LEGACY : LEGACY}</small></p>}
                </td>
                {!readOnly && <td className="actions">
                  <div className="route-actions">
                    {isPathlessLegacy(r) ? (
                      <Button variant="quiet" onClick={() => setDetails(r)}>Ver detalhes</Button>
                    ) : (
                      <>
                        <Button variant="quiet" onClick={() => setDetails(r)}>Ver detalhes</Button>
                        <Button variant="quiet" onClick={() => setPlugins(r)}>Plugins</Button>
                        {canWrite && <>
                          <Button variant="quiet" onClick={() => setEditing(r)}>Editar</Button>
                          <RowMenu label={`Mais ações para ${r.name}`} items={[{ label: "Excluir", danger: true, onSelect: () => setDeleting(r) }]} />
                        </>}
                      </>
                    )}
                  </div>
                </td>}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {routes.hasNextPage && (
        <button type="button" onClick={() => void routes.fetchNextPage()} disabled={routes.isFetchingNextPage}>
          Carregar mais
        </button>
      )}
      {keepDialogs && editing && slug && (
        <RouteForm
          workspaceId={workspaceId}
          publication={publication}
          slug={slug}
          route={editing === "new" ? null : editing}
          services={serviceList.map((s) => ({ id: s.id, name: s.name, path: fieldText(s.path) || null }))}
          defaultServiceId={serviceId}
          onClose={() => setEditing(null)}
        />
      )}
      {!readOnly && details && <RouteDetails route={details} slug={slug} publication={publication} servicePath={servicePath(details.serviceId)} serviceName={serviceName(details.serviceId)} onClose={() => setDetails(null)} />}
      {keepDialogs && deleting && <DeleteRoute workspaceId={workspaceId} route={deleting} onClose={() => setDeleting(null)} />}
      {!readOnly && plugins && (
        <Modal title={`Plugins de ${plugins.name}`} onClose={() => setPlugins(null)} wide>
          <p className="note">Plugins por Workspace ainda não são editáveis aqui.</p>
          <ScopedPlugins envId={workspaceId} scope={{ kind: "route", id: plugins.id }} title="Plugins aplicados" readOnly />
        </Modal>
      )}
    </div>
  );
}

const isPathlessLegacy = (route: WorkspaceRoute | null): boolean =>
  route?.pathCompatibility === "legacy-preserved" && (route.paths?.length ?? 0) === 0;

function RouteDetails({ route, serviceName, onClose, ...paths }: { route: WorkspaceRoute; serviceName: string; onClose: () => void; slug?: string; servicePath?: string | null; publication: ReturnType<typeof useRoutePublication> }) {
  const fields = [
    ["Nome", route.name],
    ["Service", serviceName],
    ["Paths", route.paths?.join(", ") || "—"],
    ["Hosts", route.hosts?.join(", ") || "—"],
    ["Métodos", route.methods?.join(", ") || "todos"],
    ["Cabeçalhos", JSON.stringify(route.headers ?? {})],
    ["Protocolos", route.protocols.join(", ")],
    ["stripPath atual", route.stripPath ? "sim" : "não"],
    ["Preservar o host original", route.preserveHost ? "sim" : "não"],
    ["Retenção de análises", `${route.analyticsRetentionDays ?? 7} dias`],
    ["Tags", route.tags?.join(", ") || "—"],
  ];
  return (
    <Modal title={`Detalhes de ${route.name}`} onClose={onClose} footer={<Button onClick={onClose}>Fechar</Button>}>
      {route.pathCompatibility === "legacy-preserved" && <p className="warn"><Badge tone="warning">Legada</Badge> {isPathlessLegacy(route) ? PATHLESS_LEGACY : LEGACY}</p>}
      <RoutePaths route={route} {...paths} />
      <dl>
        {fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd className="mono">{value}</dd></div>)}
      </dl>
    </Modal>
  );
}

/** Create (no route) or replace; the caller sees success only through `onSaved`, after the server's 201 or 200. */
export function saveRouteMutation(workspaceId: string, route: WorkspaceRoute | null, invalidate: () => void, onSaved: (saved: WorkspaceRoute) => void) {
  return {
    mutationFn: (body: WorkspaceRouteWrite): Promise<WorkspaceRoute> => {
      if (isPathlessLegacy(route)) throw new Error("Pathless legacy routes are read-only.");
      return route
        ? unwrap(apiV2.PUT("/workspaces/{workspaceId}/routes/{routeId}", { params: { path: { workspaceId, routeId: route.id } }, body }))
        : unwrap(apiV2.POST("/workspaces/{workspaceId}/routes", { params: { path: { workspaceId } }, body }));
    },
    onSuccess: (saved: WorkspaceRoute) => {
      invalidate();
      onSaved(saved);
    },
  };
}

export interface RouteFormValues {
  name: string;
  serviceId: string;
  paths: string[];
  hosts: string[];
  methods: string[];
  protocols: Protocol[];
  stripPath: boolean;
  preserveHost: boolean;
  tags: string[];
}

// What this form does not edit but a v2 PUT must keep.
const KEPT = ["headers", "analyticsRetentionDays"] as const;

/** A legacy route keeps its stored stripPath; conversion is a separate, explicit operation. */
export function routeBody(route: WorkspaceRoute | null, form: RouteFormValues): WorkspaceRouteWrite {
  const kept = Object.fromEntries(KEPT.flatMap((k) => (route?.[k] === undefined ? [] : [[k, route[k]]])));
  return { ...kept, ...form, stripPath: route?.pathCompatibility === "legacy-preserved" ? route.stripPath : form.stripPath };
}

function RouteForm(props: { publication: ReturnType<typeof useRoutePublication>; workspaceId: string; slug: string; route: WorkspaceRoute | null; services: { id: string; name: string; path: string | null }[]; defaultServiceId: string; onClose: () => void }) {
  const { workspaceId, slug, route, services, onClose } = props;
  const legacy = route?.pathCompatibility === "legacy-preserved";
  const invalidate = useInvalidateWorkspaceGateway(workspaceId);
  const access = useWorkspaceGatewayAccess(workspaceId);
  const [form, setForm] = useState({
    name: route?.name ?? "",
    serviceId: route?.serviceId ?? (props.defaultServiceId || services[0]?.id || ""),
    paths: (route?.paths ?? []).join("\n"),
    hosts: (route?.hosts ?? []).join("\n"),
    methods: (route?.methods ?? []).join(", "),
    protocols: (route?.protocols ?? ["http", "https"]) as Protocol[],
    stripPath: route?.stripPath ?? false,
    preserveHost: route?.preserveHost ?? false,
    tags: (route?.tags ?? []).join(", "),
  });
  const [local, setLocal] = useState<FormErrors>(NO_ERRORS);
  const save = useMutation(saveRouteMutation(workspaceId, route, invalidate, onClose));
  const errors = save.isError ? gatewayFormErrors(save.error, "route") : local;
  const paths = splitPaths(form.paths);
  const stripPath = legacy ? route.stripPath ?? false : form.stripPath;

  const unsaved = route !== null && (
    JSON.stringify(paths) !== JSON.stringify(route.paths ?? []) || stripPath !== route.stripPath ||
    form.serviceId !== route.serviceId || form.name !== route.name ||
    form.hosts !== (route.hosts ?? []).join("\n") || form.methods !== (route.methods ?? []).join(", ") ||
    JSON.stringify(form.protocols) !== JSON.stringify(route.protocols) || form.preserveHost !== route.preserveHost ||
    form.tags !== (route.tags ?? []).join(", ")
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!access.canWrite || isPathlessLegacy(route)) return;
    save.reset();
    const fields: Record<string, string[]> = {
      ...(form.name.trim() ? {} : { name: ["Nome: campo obrigatório."] }),
      ...(services.some((s) => s.id === form.serviceId) ? {} : { serviceId: ["Escolha um service deste Workspace."] }),
      ...(paths.length > 0 ? {} : { paths: ["Informe ao menos um path."] }),
    };
    setLocal({ fields, form: [] });
    if (Object.keys(fields).length > 0) return;
    save.mutate(routeBody(route, {
      name: form.name.trim(),
      serviceId: form.serviceId,
      paths,
      hosts: splitList(form.hosts),
      methods: splitList(form.methods).map((m) => m.toUpperCase()),
      protocols: form.protocols,
      stripPath: form.stripPath,
      preserveHost: form.preserveHost,
      tags: splitList(form.tags),
    }));
  };
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const toggleProtocol = (p: Protocol, on: boolean) => set("protocols", on ? [...form.protocols, p] : form.protocols.filter((x) => x !== p));

  return (
    <Modal title={route ? `Editar ${route.name}` : "Nova route"} onClose={onClose}>
      <form onSubmit={submit} className="form" noValidate>
        <Field label="Nome" errors={errors.fields.name}>
          {(id, invalid) => <input id={id} aria-invalid={invalid} value={form.name} onChange={(e) => set("name", e.target.value)} />}
        </Field>
        <Field label="Service" errors={errors.fields.serviceId} hint="Só os services deste Workspace.">
          {(id, invalid) => (
            <select id={id} aria-invalid={invalid} value={form.serviceId} onChange={(e) => set("serviceId", e.target.value)}>
              {services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Paths" errors={errors.fields.paths} hint="Um por linha, literal ou expressão iniciada por ~. O fluxo v1 mantém o path configurado; o prefixo do Workspace é apenas previsto na configuração v2.">
          {(id, invalid) => <textarea id={id} aria-invalid={invalid} rows={2} value={form.paths} onChange={(e) => set("paths", e.target.value)} />}
        </Field>
        <RoutePaths
          route={route}
          config={{ paths, stripPath, serviceId: form.serviceId }}
          slug={slug}
          servicePath={services.find((s) => s.id === form.serviceId)?.path}
          publication={props.publication}
          unsaved={unsaved}
        />
        <Field label="Hosts" errors={errors.fields.hosts} hint="Um por linha (opcional)">
          {(id, invalid) => <textarea id={id} aria-invalid={invalid} rows={2} value={form.hosts} onChange={(e) => set("hosts", e.target.value)} />}
        </Field>
        <Field label="Métodos" errors={errors.fields.methods} hint="Separados por vírgula; vazio = todos">
          {(id, invalid) => <input id={id} aria-invalid={invalid} value={form.methods} onChange={(e) => set("methods", e.target.value)} placeholder="GET, POST" />}
        </Field>
        <fieldset className="checks">
          <legend>Protocolos</legend>
          {PROTOCOLS.map((p) => (
            <label key={p} className="check">
              <input type="checkbox" checked={form.protocols.includes(p)} onChange={(e) => toggleProtocol(p, e.target.checked)} /> {p}
            </label>
          ))}
          {errors.fields.protocols?.map((m) => (
            <small key={m} className="error" role="alert">
              {m}
            </small>
          ))}
        </fieldset>
        {legacy ? (
          <p className="warn"><Badge tone="warning">Legada</Badge> {LEGACY} stripPath atual: {route.stripPath ? "sim" : "não"}.</p>
        ) : (
          <label className="check">
            <input type="checkbox" checked={form.stripPath} onChange={(e) => set("stripPath", e.target.checked)} /> Remover o path da route ao encaminhar (stripPath)
          </label>
        )}
        {errors.fields.stripPath?.map((m) => (
          <p key={m} className="error" role="alert">{m}</p>
        ))}
        <CheckboxField label="Preservar o host original" errors={errors.fields.preserveHost} checked={form.preserveHost} onChange={(checked) => set("preserveHost", checked)} />
        <Field label="Tags" errors={errors.fields.tags} hint="Separadas por vírgula">
          {(id, invalid) => <input id={id} aria-invalid={invalid} value={form.tags} onChange={(e) => set("tags", e.target.value)} />}
        </Field>
        <p className="muted">A alteração entra no rascunho do Workspace; nada é implantado.</p>
        {access.reason && <p role="status">{access.reason}</p>}
        <FormErrorList messages={errors.form} />
        <div className="form-actions">
          <button type="button" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="primary" disabled={save.isPending || !access.canWrite}>
            {save.isPending ? "Salvando…" : "Salvar"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteRoute({ workspaceId, route, onClose }: { workspaceId: string; route: WorkspaceRoute; onClose: () => void }) {
  const invalidate = useInvalidateWorkspaceGateway(workspaceId);
  const access = useWorkspaceGatewayAccess(workspaceId);
  const remove = useMutation({
    mutationFn: () => unwrap(apiV2.DELETE("/workspaces/{workspaceId}/routes/{routeId}", { params: { path: { workspaceId, routeId: route.id } } })),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });
  return (
    <ConfirmDialog
      title="Excluir route"
      message={
        <>
          Excluir <strong>{route.name}</strong>? A exclusão entra no rascunho e só afeta o tráfego depois de publicar.
        </>
      }
      confirmLabel="Excluir"
      confirmDisabled={!access.canWrite}
      busy={remove.isPending}
      error={remove.isError ? gatewayErrorMessage(remove.error) : null}
      onConfirm={() => { if (access.canWrite && !isPathlessLegacy(route)) remove.mutate(); }}
      onClose={onClose}
    >
      {access.reason && <p role="status">{access.reason}</p>}
    </ConfirmDialog>
  );
}
