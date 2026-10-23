import { useDeferredValue, useState, type FormEvent } from "react";
import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { api, unwrap, type Route, type RouteWrite, type Service } from "../api/client";
import { statusMessage, toFormErrors, type FormErrors } from "../api/errors";
import { useCanEdit } from "../auth";
import { Field, FormErrorList } from "../components/Field";
import { ConfirmDialog, Modal } from "../components/Modal";
import { useEnvId } from "../components/Shell";
import { ScopedPlugins } from "./Plugins";
import { splitList, useEntityDraft, useInvalidateDraft, useServices } from "./Services";
import { PageHeader } from "../components/PageHeader";
import { EmptyState } from "../components/EmptyState";
import { Table } from "../components/Table";
import { DraftBadge } from "../components/Badge";
import { Button } from "../components/Button";
import { RowMenu } from "../components/RowMenu";

const FIELDS = ["name", "serviceId", "paths", "hosts", "methods", "protocols", "stripPath", "preserveHost", "tags"] as const;
const PROTOCOLS: NonNullable<RouteWrite["protocols"]>[number][] = ["http", "https", "grpc", "grpcs"];

export function RoutesPage() {
  const envId = useEnvId();
  // The service filter lives in the URL so it can be linked from a service.
  const [params, setParams] = useSearchParams();
  const serviceId = params.get("serviceId") ?? "";
  return (
    <section className="final-page">
      <RouteList envId={envId} serviceId={serviceId} onServiceChange={(id) => setParams(id ? { serviceId: id } : {})} />
    </section>
  );
}

export function ScopedRoutes({ envId, service }: { envId: string; service: Service }) {
  return (
    <section aria-label="Routes do service">
      <RouteList envId={envId} serviceId={service.id} service={service} />
    </section>
  );
}

function RouteList({ envId, serviceId, service, onServiceChange }: { envId: string; serviceId: string; service?: Service; onServiceChange?: (id: string) => void }) {
  const canEdit = useCanEdit();
  const draft = useEntityDraft(envId, "routes");
  const [search, setSearch] = useState("");
  const q = useDeferredValue(search.trim());
  const services = useServices(envId);
  const serviceList = services.data?.pages.flatMap((p) => p.items) ?? [];
  const serviceName = (id: string) => (id === service?.id ? service.name : serviceList.find((s) => s.id === id)?.name) ?? id.slice(0, 8);

  const routes = useInfiniteQuery({
    queryKey: ["routes", envId, q, serviceId],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/environments/{envId}/routes", {
          params: {
            path: { envId },
            query: { ...(q ? { q } : {}), ...(serviceId ? { serviceId } : {}), ...(pageParam ? { cursor: pageParam } : {}) },
          },
        }),
      ),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const [editing, setEditing] = useState<Route | "new" | null>(null);
  const [deleting, setDeleting] = useState<Route | null>(null);
  const [plugins, setPlugins] = useState<Route | null>(null);
  const items = routes.data?.pages.flatMap((p) => p.items) ?? [];
  const createAction = canEdit && (
    <Button variant="primary" onClick={() => setEditing("new")} disabled={serviceList.length === 0} title={serviceList.length === 0 ? "Crie um service primeiro" : undefined}>
      Nova route
    </Button>
  );

  return (
    <div className="gateway-list">
      {service ? <div className="page-head"><h2>Routes do service</h2>{createAction}</div> : (
        <PageHeader title="Routes" description="As regras que levam cada requisição ao seu service." actions={createAction} />
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
              <th>Route → paths / service</th>
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
                    <span className="arrow" aria-hidden="true">→</span>
                    <span className="target mono">{r.paths?.join(", ") || "—"}</span>
                    <span className="muted">Service <span className="mono">{serviceName(r.serviceId)}</span></span>
                  </div>
                  <div className="route-matches">
                    <span className="muted">Métodos</span>
                    {r.methods === undefined ? <span className="match-chip mono">todos</span> : r.methods.map((m) => <span className="match-chip mono" key={m}>{m}</span>)}
                    <span className="muted">Hosts</span>
                    {r.hosts?.length ? r.hosts.map((h) => <span className="match-chip mono" key={h}>{h}</span>) : <span className="mono">—</span>}
                  </div>
                </td>
                <td className="actions">
                  <Button variant="quiet" onClick={() => setPlugins(r)}>
                    Plugins
                  </Button>
                  {canEdit && (
                    <>
                      <Button variant="quiet" onClick={() => setEditing(r)}>
                        Editar
                      </Button>
                      <RowMenu label={`Mais ações para ${r.name}`} items={[{ label: "Excluir", danger: true, onSelect: () => setDeleting(r) }]} />
                    </>
                  )}
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
      {editing && (
        <RouteForm
          envId={envId}
          route={editing === "new" ? null : editing}
          services={serviceList.map((s) => ({ id: s.id, name: s.name }))}
          defaultServiceId={serviceId}
          onClose={() => setEditing(null)}
        />
      )}
      {deleting && <DeleteRoute envId={envId} route={deleting} onClose={() => setDeleting(null)} />}
      {plugins && (
        <Modal title={`Plugins de ${plugins.name}`} onClose={() => setPlugins(null)} wide>
          <ScopedPlugins envId={envId} scope={{ kind: "route", id: plugins.id }} title="Plugins aplicados" />
        </Modal>
      )}
    </div>
  );
}

function RouteForm(props: { envId: string; route: Route | null; services: { id: string; name: string }[]; defaultServiceId: string; onClose: () => void }) {
  const { envId, route, services, onClose } = props;
  const invalidate = useInvalidateDraft(envId);
  const [form, setForm] = useState({
    name: route?.name ?? "",
    serviceId: route?.serviceId ?? (props.defaultServiceId || services[0]?.id || ""),
    paths: (route?.paths ?? []).join("\n"),
    hosts: (route?.hosts ?? []).join("\n"),
    methods: (route?.methods ?? []).join(", "),
    protocols: route?.protocols ?? ["http", "https"],
    stripPath: route?.stripPath ?? true,
    preserveHost: route?.preserveHost ?? false,
    tags: (route?.tags ?? []).join(", "),
  });
  const [errors, setErrors] = useState<FormErrors>({ fields: {}, form: [] });

  const save = useMutation({
    mutationFn: () => {
      const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = route ?? ({} as Partial<Route>);
      const body: RouteWrite = {
        ...rest,
        name: form.name.trim(),
        serviceId: form.serviceId,
        paths: splitList(form.paths),
        hosts: splitList(form.hosts),
        methods: splitList(form.methods).map((m) => m.toUpperCase()),
        protocols: form.protocols,
        stripPath: form.stripPath,
        preserveHost: form.preserveHost,
        tags: splitList(form.tags),
      };
      return route
        ? unwrap(api.PUT("/environments/{envId}/routes/{routeId}", { params: { path: { envId, routeId: route.id } }, body }))
        : unwrap(api.POST("/environments/{envId}/routes", { params: { path: { envId } }, body }));
    },
    onSuccess: () => {
      invalidate("routes");
      onClose();
    },
    onError: (err) => setErrors(toFormErrors(err, FIELDS)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setErrors({ fields: {}, form: [] });
    save.mutate();
  };
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const toggleProtocol = (p: (typeof PROTOCOLS)[number], on: boolean) =>
    set("protocols", on ? [...form.protocols, p] : form.protocols.filter((x) => x !== p));

  return (
    <Modal title={route ? `Editar ${route.name}` : "Nova route"} onClose={onClose}>
      <form onSubmit={submit} className="form" noValidate>
        <Field label="Nome" errors={errors.fields.name}>
          {(id, invalid) => <input id={id} aria-invalid={invalid} value={form.name} onChange={(e) => set("name", e.target.value)} />}
        </Field>
        <Field label="Service" errors={errors.fields.serviceId}>
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
        <Field label="Paths" errors={errors.fields.paths} hint="Um por linha, ex.: /orders">
          {(id, invalid) => <textarea id={id} aria-invalid={invalid} rows={2} value={form.paths} onChange={(e) => set("paths", e.target.value)} />}
        </Field>
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
        <label className="check">
          <input type="checkbox" checked={form.stripPath} onChange={(e) => set("stripPath", e.target.checked)} /> Remover o path da route ao encaminhar
        </label>
        <label className="check">
          <input type="checkbox" checked={form.preserveHost} onChange={(e) => set("preserveHost", e.target.checked)} /> Preservar o host original
        </label>
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

function DeleteRoute({ envId, route, onClose }: { envId: string; route: Route; onClose: () => void }) {
  const invalidate = useInvalidateDraft(envId);
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE("/environments/{envId}/routes/{routeId}", { params: { path: { envId, routeId: route.id } } })),
    onSuccess: () => {
      invalidate("routes");
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
      error={remove.isError ? statusMessage(remove.error) : null}
      onConfirm={() => remove.mutate()}
      onClose={onClose}
    />
  );
}
