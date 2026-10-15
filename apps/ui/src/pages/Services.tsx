import { useDeferredValue, useState, type FormEvent } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, unwrap, type Service, type ServiceWrite } from "../api/client";
import { statusMessage, toFormErrors, type FormErrors } from "../api/errors";
import { useCanEdit } from "../auth";
import { Field, FormErrorList } from "../components/Field";
import { ConfirmDialog, Modal } from "../components/Modal";
import { useEnvId } from "../components/Shell";
import { ScopedPlugins } from "./Plugins";

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

export function ServicesPage() {
  const envId = useEnvId();
  const canEdit = useCanEdit();
  const [search, setSearch] = useState("");
  const q = useDeferredValue(search.trim());
  const services = useServices(envId, q);
  const [editing, setEditing] = useState<Service | "new" | null>(null);
  const [deleting, setDeleting] = useState<Service | null>(null);
  const [plugins, setPlugins] = useState<Service | null>(null);
  const items = services.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <section>
      <div className="page-head">
        <h1>Services</h1>
        {canEdit && (
          <button type="button" className="primary" onClick={() => setEditing("new")}>
            Novo service
          </button>
        )}
      </div>
      <input type="search" className="search" placeholder="Buscar por nome" aria-label="Buscar services" value={search} onChange={(e) => setSearch(e.target.value)} />
      {services.isPending && <p className="muted">Carregando…</p>}
      {services.isError && <p className="error">{statusMessage(services.error)}</p>}
      {services.isSuccess && items.length === 0 && <p className="muted">{q ? "Nenhum service encontrado." : "Nenhum service ainda."}</p>}
      {items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Nome</th>
              <th>Destino</th>
              <th>Ativo</th>
              <th aria-label="Ações" />
            </tr>
          </thead>
          <tbody>
            {items.map((s) => (
              <tr key={s.id}>
                <td>{s.name}</td>
                <td className="mono">
                  {s.protocol}://{s.host}:{s.port}
                  {s.path ?? ""}
                </td>
                <td>{s.enabled === false ? "Não" : "Sim"}</td>
                <td className="actions">
                  <button type="button" onClick={() => setPlugins(s)}>
                    Plugins
                  </button>
                  {canEdit && (
                    <>
                      <button type="button" onClick={() => setEditing(s)}>
                        Editar
                      </button>
                      <button type="button" className="danger" onClick={() => setDeleting(s)}>
                        Excluir
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {services.hasNextPage && (
        <button type="button" onClick={() => void services.fetchNextPage()} disabled={services.isFetchingNextPage}>
          Carregar mais
        </button>
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
          <Field label="Host" errors={errors.fields.host}>
            {(id, invalid) => <input id={id} aria-invalid={invalid} value={form.host} onChange={(e) => set("host", e.target.value)} placeholder="orders.internal" />}
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
