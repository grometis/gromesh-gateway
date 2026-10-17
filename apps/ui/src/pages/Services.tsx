import { useDeferredValue, useState, type FormEvent } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrap, type Service, type ServiceWrite } from "../api/client";
import { statusMessage, toFormErrors, type FormErrors } from "../api/errors";
import { useCanEdit } from "../auth";
import { Field, FormErrorList } from "../components/Field";
import { ConfirmDialog, Modal } from "../components/Modal";
import { useEnvId, useEnvironment } from "../components/Shell";
import { DraftBadge } from "../components/Badge";
import { Button } from "../components/Button";
import { Table } from "../components/Table";
import { ScopedPlugins } from "./Plugins";
import { useUpstreams } from "./Upstreams";

const PROTOCOLS: ServiceWrite["protocol"][] = ["http", "https", "grpc", "grpcs", "tcp", "tls"];
const FIELDS = ["name", "protocol", "host", "port", "path", "enabled", "tags"] as const;

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

/** Which services the draft adds or changes, from the publish preview (the strip loads the same query). */
function useServiceDraft(envId: string): Map<string, "added" | "modified"> {
  const env = useEnvironment(envId);
  const pending = env.data?.hasUnpublishedChanges ?? false;
  const preview = useQuery({
    queryKey: ["preview", envId],
    queryFn: () => unwrap(api.GET("/environments/{envId}/publish-preview", { params: { path: { envId } } })),
    enabled: pending,
  });
  const draft = new Map<string, "added" | "modified">();
  if (!pending) return draft;
  for (const c of preview.data?.changes ?? []) if (c.kind === "services" && c.change !== "removed") draft.set(c.id, c.change);
  return draft;
}

export function ServicesPage() {
  const envId = useEnvId();
  const canEdit = useCanEdit();
  const [search, setSearch] = useState("");
  const [onlyChanged, setOnlyChanged] = useState(false);
  const q = useDeferredValue(search.trim());
  const services = useServices(envId, q);
  const draft = useServiceDraft(envId);
  const [editing, setEditing] = useState<Service | "new" | null>(null);
  const [deleting, setDeleting] = useState<Service | null>(null);
  const [plugins, setPlugins] = useState<Service | null>(null);
  const all = services.data?.pages.flatMap((p) => p.items) ?? [];
  const changed = all.filter((s) => draft.has(s.id));
  const items = onlyChanged ? changed : all;

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Services</h1>
          <p className="lede">Os destinos para onde o gateway encaminha as requisições.</p>
        </div>
        {canEdit && (
          <Button variant="primary" onClick={() => setEditing("new")}>
            Novo service
          </Button>
        )}
      </div>
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
        <p className="muted">{onlyChanged ? "Nenhum service com alterações não publicadas." : q ? "Nenhum service encontrado." : "Nenhum service ainda. Crie o primeiro para começar a rotear tráfego."}</p>
      )}
      {items.length > 0 && (
        <Table label="Services" cards>
          <thead>
            <tr>
              <th>Service → destino</th>
              <th>
                <span className="visually-hidden">Situação</span>
              </th>
              <th>
                <span className="visually-hidden">Ações</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((s) => (
              <tr key={s.id}>
                <td>
                  <div className="service-route">
                    <span className="service-name">{s.name}</span>
                    <DraftBadge change={draft.get(s.id)} />
                    <span className="arrow" aria-hidden="true">
                      →
                    </span>
                    <span className="visually-hidden">destino</span>
                    <span className="target mono">
                      {s.protocol}://{s.host}:{s.port}
                      {s.path ?? ""}
                    </span>
                  </div>
                </td>
                <td>{s.enabled === false && <span className="service-off">Desativado</span>}</td>
                <td className="actions">
                  <Button onClick={() => setPlugins(s)}>Plugins</Button>
                  {canEdit && (
                    <>
                      <Button onClick={() => setEditing(s)}>Editar</Button>
                      <Button variant="danger" onClick={() => setDeleting(s)}>
                        Excluir
                      </Button>
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
      {editing && <ServiceForm envId={envId} service={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {deleting && <DeleteService envId={envId} service={deleting} onClose={() => setDeleting(null)} />}
      {plugins && (
        <Modal title={`Plugins de ${plugins.name}`} onClose={() => setPlugins(null)} wide>
          <ScopedPlugins envId={envId} scope={{ kind: "service", id: plugins.id }} title="Plugins aplicados" />
        </Modal>
      )}
    </section>
  );
}

function ServiceForm({ envId, service, onClose }: { envId: string; service: Service | null; onClose: () => void }) {
  const invalidate = useInvalidateDraft(envId);
  const upstreams = useUpstreams(envId);
  const upstreamNames = upstreams.data?.pages.flatMap((p) => p.items.map((u) => u.name)) ?? [];
  const [form, setForm] = useState({
    name: service?.name ?? "",
    protocol: service?.protocol ?? "http",
    host: service?.host ?? "",
    port: String(service?.port ?? 80),
    path: service?.path ?? "",
    enabled: service?.enabled ?? true,
    tags: (service?.tags ?? []).join(", "),
  });
  const [errors, setErrors] = useState<FormErrors>({ fields: {}, form: [] });

  const save = useMutation({
    mutationFn: () => {
      // PUT replaces the whole service: keep fields this form does not edit (retries, timeouts).
      const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = service ?? ({} as Partial<Service>);
      const body: ServiceWrite = {
        ...rest,
        name: form.name.trim(),
        protocol: form.protocol,
        host: form.host.trim(),
        port: Number(form.port),
        path: form.path.trim() || null,
        enabled: form.enabled,
        tags: splitList(form.tags),
      };
      return service
        ? unwrap(api.PUT("/environments/{envId}/services/{serviceId}", { params: { path: { envId, serviceId: service.id } }, body }))
        : unwrap(api.POST("/environments/{envId}/services", { params: { path: { envId } }, body }));
    },
    onSuccess: () => {
      invalidate("services");
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

  return (
    <Modal title={service ? `Editar ${service.name}` : "Novo service"} onClose={onClose}>
      <form onSubmit={submit} className="form" noValidate>
        <Field label="Nome" errors={errors.fields.name}>
          {(id, invalid) => <input id={id} aria-invalid={invalid} value={form.name} onChange={(e) => set("name", e.target.value)} />}
        </Field>
        <div className="row">
          <Field label="Protocolo" errors={errors.fields.protocol}>
            {(id) => (
              <select id={id} value={form.protocol} onChange={(e) => set("protocol", e.target.value as ServiceWrite["protocol"])}>
                {PROTOCOLS.map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Host" errors={errors.fields.host} hint={upstreamNames.includes(form.host.trim()) ? "Balanceado pelo upstream de mesmo nome" : undefined}>
            {(id, invalid) => (
              <>
                <input id={id} aria-invalid={invalid} list="upstream-names" value={form.host} onChange={(e) => set("host", e.target.value)} placeholder="orders.internal" />
                {/* Upstreams of the environment as suggestions; any other host is resolved by DNS. */}
                <datalist id="upstream-names">
                  {upstreamNames.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
              </>
            )}
          </Field>
          <Field label="Porta" errors={errors.fields.port}>
            {(id, invalid) => <input id={id} aria-invalid={invalid} inputMode="numeric" value={form.port} onChange={(e) => set("port", e.target.value)} />}
          </Field>
        </div>
        <Field label="Path no destino" errors={errors.fields.path} hint="Opcional, ex.: /v1">
          {(id, invalid) => <input id={id} aria-invalid={invalid} value={form.path} onChange={(e) => set("path", e.target.value)} />}
        </Field>
        <Field label="Tags" errors={errors.fields.tags} hint="Separadas por vírgula">
          {(id, invalid) => <input id={id} aria-invalid={invalid} value={form.tags} onChange={(e) => set("tags", e.target.value)} />}
        </Field>
        <label className="check">
          <input type="checkbox" checked={form.enabled} onChange={(e) => set("enabled", e.target.checked)} /> Ativo
        </label>
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

function DeleteService({ envId, service, onClose }: { envId: string; service: Service; onClose: () => void }) {
  const invalidate = useInvalidateDraft(envId);
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE("/environments/{envId}/services/{serviceId}", { params: { path: { envId, serviceId: service.id } } })),
    onSuccess: () => {
      invalidate("services");
      onClose();
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
      error={remove.isError ? statusMessage(remove.error) : null}
      onConfirm={() => remove.mutate()}
      onClose={onClose}
    />
  );
}

export function splitList(v: string): string[] {
  return v
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}
