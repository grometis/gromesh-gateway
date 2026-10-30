import { useDeferredValue, useState, type FormEvent } from "react";
import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { apiV2, type WorkspaceRoute, type WorkspaceRouteWrite } from "../api/client-v2";
import { api, unwrap, type Route, type RouteWrite } from "../api/client";
import { statusMessage, type FormErrors } from "../api/errors";
import { Field, FormErrorList } from "../components/Field";
import { ConfirmDialog, Modal } from "../components/Modal";
import { useEnvId } from "../components/Shell";
import { ScopedPlugins } from "./Plugins";
import { splitList, useEntityDraft } from "./Services";
import { PageHeader } from "../components/PageHeader";
import { EmptyState } from "../components/EmptyState";
import { Table } from "../components/Table";
import { Badge, DraftBadge } from "../components/Badge";
import { Button } from "../components/Button";
import { RowMenu } from "../components/RowMenu";
import { gatewayErrorMessage, gatewayFormErrors } from "./gateway-errors";
import { fieldText, publicPath, upstreamEffect, useAllWorkspaceServices, useInvalidateWorkspaceGateway, useWorkspace, WorkspaceGatewayNote } from "./workspace-gateway";

// Routes of the selected workspace through API v2 (WS-S1): every path is public under /<slug>; a migrated route
// (legacy-preserved) keeps its stripPath, and converting it is a separate, explicit operation this screen never does.
const PROTOCOLS = ["http", "https", "grpc", "grpcs"] as const;
type Protocol = (typeof PROTOCOLS)[number];
const NO_ERRORS: FormErrors = { fields: {}, form: [] };
const OVER_V1 = "Sem paths, ela é editada pela API v1 até ganhar um (a v2 exige paths); o stripPath atual é mantido.";
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

export function ScopedRoutes({ envId, service }: { envId: string; service: { id: string; name: string } }) {
  return (
    <section aria-label="Routes do service">
      <RouteList key={envId} workspaceId={envId} serviceId={service.id} service={service} />
    </section>
  );
}

function RouteList({ workspaceId, serviceId, service, onServiceChange }: { workspaceId: string; serviceId: string; service?: { id: string; name: string }; onServiceChange?: (id: string) => void }) {
  const draft = useEntityDraft(workspaceId, "routes");
  const workspace = useWorkspace(workspaceId);
  const slug = workspace.data?.slug;
  const [search, setSearch] = useState("");
  const q = useDeferredValue(search.trim());
  const services = useAllWorkspaceServices(workspaceId);
  const serviceList = services.data ?? [];
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
  const [deleting, setDeleting] = useState<WorkspaceRoute | null>(null);
  const [plugins, setPlugins] = useState<WorkspaceRoute | null>(null);
  const items = routes.data?.pages.flatMap((p) => p.items) ?? [];
  // No contract operation tells the caller's v2 permissions (a binding may grant gateway.write): every signed-in user
  // is offered the actions and the server decides (its 403 is shown in Portuguese).
  const createAction = (
    <Button variant="primary" onClick={() => setEditing("new")} disabled={serviceList.length === 0 || !slug} title={serviceList.length === 0 ? "Crie um service primeiro" : undefined}>
      Nova route
    </Button>
  );

  return (
    <div className="gateway-list">
      {service ? <div className="page-head"><h2>Routes do service</h2>{createAction}</div> : (
        <>
          <PageHeader title="Routes" description="As regras que levam cada requisição ao seu service, sob o prefixo do Workspace." actions={createAction} />
          <WorkspaceGatewayNote workspaceId={workspaceId} />
        </>
      )}
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
              <th>Route → paths públicos / service</th>
              <th className="actions" aria-label="Ações" />
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
                    <span className="target mono">{r.paths?.map((p) => (slug ? publicPath(slug, p) : p)).join(", ") || "—"}</span>
                    <span className="muted">Service <span className="mono">{serviceName(r.serviceId)}</span></span>
                  </div>
                  <div className="route-matches">
                    <span className="muted">Métodos</span>
                    {r.methods === undefined ? <span className="match-chip mono">todos</span> : r.methods.map((m) => <span className="match-chip mono" key={m}>{m}</span>)}
                    <span className="muted">Hosts</span>
                    {r.hosts?.length ? r.hosts.map((h) => <span className="match-chip mono" key={h}>{h}</span>) : <span className="mono">—</span>}
                  </div>
                  {r.pathCompatibility === "legacy-preserved" && <p className="muted"><small>{LEGACY}{editedOverV1(r) ? ` ${OVER_V1}` : ""}</small></p>}
                </td>
                <td className="actions">
                  <Button variant="quiet" onClick={() => setPlugins(r)}>
                    Plugins
                  </Button>
                  <Button variant="quiet" onClick={() => setEditing(r)}>
                    Editar
                  </Button>
                  <RowMenu label={`Mais ações para ${r.name}`} items={[{ label: "Excluir", danger: true, onSelect: () => setDeleting(r) }]} />
                </td>
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
      {editing && slug && (
        <RouteForm
          workspaceId={workspaceId}
          slug={slug}
          route={editing === "new" ? null : editing}
          services={serviceList.map((s) => ({ id: s.id, name: s.name, path: fieldText(s.path) || null }))}
          defaultServiceId={serviceId}
          onClose={() => setEditing(null)}
        />
      )}
      {deleting && <DeleteRoute workspaceId={workspaceId} route={deleting} onClose={() => setDeleting(null)} />}
      {plugins && (
        <Modal title={`Plugins de ${plugins.name}`} onClose={() => setPlugins(null)} wide>
          <ScopedPlugins envId={workspaceId} scope={{ kind: "route", id: plugins.id }} title="Plugins aplicados" />
        </Modal>
      )}
    </div>
  );
}

/** A migrated route without paths: WorkspaceRouteWrite requires paths, so it is edited through v1 until it has one (WS-R0). */
export const editedOverV1 = (route: WorkspaceRoute | null): boolean =>
  route?.pathCompatibility === "legacy-preserved" && (route.paths?.length ?? 0) === 0;

/** Create (no route) or replace; the caller sees success only through `onSaved`, after the server's 201 or 200. */
export function saveRouteMutation(workspaceId: string, route: WorkspaceRoute | null, invalidate: () => void, onSaved: (saved: WorkspaceRoute | Route) => void) {
  return {
    mutationFn: (body: WorkspaceRouteWrite | RouteWrite): Promise<WorkspaceRoute | Route> => {
      if (route && editedOverV1(route)) return unwrap(api.PUT("/environments/{envId}/routes/{routeId}", { params: { path: { envId: workspaceId, routeId: route.id } }, body: body as RouteWrite }));
      return route
        ? unwrap(apiV2.PUT("/workspaces/{workspaceId}/routes/{routeId}", { params: { path: { workspaceId, routeId: route.id } }, body: body as WorkspaceRouteWrite }))
        : unwrap(apiV2.POST("/workspaces/{workspaceId}/routes", { params: { path: { workspaceId } }, body: body as WorkspaceRouteWrite }));
    },
    onSuccess: (saved: WorkspaceRoute | Route) => {
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

// What this form does not edit but a PUT must keep; both RouteWrite (v1) and WorkspaceRouteWrite declare them.
const KEPT = ["headers", "analyticsRetentionDays"] as const;

/**
 * The body of a save, with only the fields the write schema declares (a response carries more). A legacy-preserved
 * route never sends stripPath through v2 (the server keeps the stored one; another value would be a 409
 * path-compatibility); through v1 (no paths) it sends the stored one, since v1 would otherwise default it to true.
 * A workspace-default route sends the user's choice (false unless chosen).
 */
export function routeBody(route: WorkspaceRoute | null, form: RouteFormValues): WorkspaceRouteWrite | RouteWrite {
  const kept = Object.fromEntries(KEPT.flatMap((k) => (route?.[k] === undefined ? [] : [[k, route[k]]])));
  const { stripPath, ...fields } = form;
  if (route && editedOverV1(route)) return { ...kept, ...fields, stripPath: route.stripPath };
  return route?.pathCompatibility === "legacy-preserved" ? { ...kept, ...fields } : { ...kept, ...fields, stripPath };
}

function RouteForm(props: { workspaceId: string; slug: string; route: WorkspaceRoute | null; services: { id: string; name: string; path: string | null }[]; defaultServiceId: string; onClose: () => void }) {
  const { workspaceId, slug, route, services, onClose } = props;
  const legacy = route?.pathCompatibility === "legacy-preserved";
  const overV1 = editedOverV1(route);
  const invalidate = useInvalidateWorkspaceGateway(workspaceId);
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
  const paths = splitList(form.paths);
  const stripPath = legacy ? route.stripPath ?? false : form.stripPath;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.reset();
    const fields: Record<string, string[]> = {
      ...(form.name.trim() ? {} : { name: ["Nome: campo obrigatório."] }),
      ...(services.some((s) => s.id === form.serviceId) ? {} : { serviceId: ["Escolha um service deste Workspace."] }),
      ...(paths.length > 0 || (overV1 && (splitList(form.hosts).length > 0 || splitList(form.methods).length > 0 || Object.keys(route?.headers ?? {}).length > 0))
        ? {} : { paths: [overV1 ? "Informe ao menos um path, host ou método." : "Informe ao menos um path."] }),
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
        <Field label="Paths" errors={errors.fields.paths} hint={`Um por linha, ex.: /orders (ou ~/regex). O prefixo /${slug} do Workspace é acrescentado.`}>
          {(id, invalid) => <textarea id={id} aria-invalid={invalid} rows={2} value={form.paths} onChange={(e) => set("paths", e.target.value)} />}
        </Field>
        <div className="note" aria-label="Path público" role="group">
          <p>Prefixo do Workspace: <span className="mono">/{slug}</span></p>
          {paths.length > 0 && <p>Path público: <span className="mono">{paths.map((p) => publicPath(slug, p)).join(", ")}</span></p>}
          {paths[0] && <p>{upstreamEffect(slug, paths[0], stripPath, services.find((x) => x.id === form.serviceId)?.path)}</p>}
          {paths.length === 0 && overV1 && <p>Sem paths: a route casa por host, método ou cabeçalho. {OVER_V1}</p>}
        </div>
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
        <label className="check">
          <input type="checkbox" checked={form.preserveHost} onChange={(e) => set("preserveHost", e.target.checked)} /> Preservar o host original
        </label>
        <Field label="Tags" errors={errors.fields.tags} hint="Separadas por vírgula">
          {(id, invalid) => <input id={id} aria-invalid={invalid} value={form.tags} onChange={(e) => set("tags", e.target.value)} />}
        </Field>
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

function DeleteRoute({ workspaceId, route, onClose }: { workspaceId: string; route: WorkspaceRoute; onClose: () => void }) {
  const invalidate = useInvalidateWorkspaceGateway(workspaceId);
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
      busy={remove.isPending}
      error={remove.isError ? gatewayErrorMessage(remove.error) : null}
      onConfirm={() => remove.mutate()}
      onClose={onClose}
    />
  );
}
