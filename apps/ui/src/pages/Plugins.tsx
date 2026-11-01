import { CatalogPicker } from "../components/PluginCatalog";
import { WorkspacePlugins } from "./WorkspacePlugins";
import { useMemo, useState, type FormEvent } from "react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { ApiError, api, unwrap, type Plugin, type PluginScope, type PluginWrite } from "../api/client";
import { consumerName, useConsumers, useRouteList } from "../api/lists";
import { statusMessage } from "../api/errors";
import { useCanEdit } from "../auth";
import { Field, FormErrorList } from "../components/Field";
import { ConfirmDialog, Modal } from "../components/Modal";
import { useEnvId } from "../components/Shell";
import { SchemaFields } from "../schema-form/SchemaForm";
import { configToSubmit, fieldPaths, initialConfig, isObject, parsePluginSchema, placeErrors, validateConfig, type Config, type FieldErrors, type PluginSchema } from "../schema-form/schema";
import { splitList, useEntityDraft, useInvalidateDraft, useServices } from "./Services";
import { PageHeader } from "../components/PageHeader";
import { EmptyState } from "../components/EmptyState";
import { Table } from "../components/Table";
import { Badge, DraftBadge } from "../components/Badge";
import { Button } from "../components/Button";
import { RowMenu } from "../components/RowMenu";

type ScopeKind = "global" | "service" | "route" | "consumer";
export interface ScopeChoice {
  kind: ScopeKind;
  id: string;
}

const SCOPE_LABEL: Record<ScopeKind, string> = { global: "Global", service: "Service", route: "Route", consumer: "Consumer" };

export function scopeOf(p: Pick<Plugin, "scope">): ScopeChoice {
  const s = p.scope ?? {};
  if (s.routeId) return { kind: "route", id: s.routeId };
  if (s.serviceId) return { kind: "service", id: s.serviceId };
  if (s.consumerId) return { kind: "consumer", id: s.consumerId };
  return { kind: "global", id: "" };
}

function scopeBody(scope: ScopeChoice): PluginScope {
  if (scope.kind === "service") return { serviceId: scope.id };
  if (scope.kind === "route") return { routeId: scope.id };
  if (scope.kind === "consumer") return { consumerId: scope.id };
  return {};
}


function usePluginSchema(name: string | null) {
  return useQuery({
    queryKey: ["plugin-schema", name],
    queryFn: async () => parsePluginSchema(await unwrap(api.GET("/plugin-schemas/{pluginName}", { params: { path: { pluginName: name! } } }))),
    enabled: name !== null,
    staleTime: Infinity,
  });
}

/** Names for scope ids, from the first pages of each list (ids that are not loaded fall back to a short id). */
function useScopeNames(envId: string) {
  const services = useServices(envId);
  const routes = useRouteList(envId);
  const consumers = useConsumers(envId);
  return useMemo(() => {
    const names = new Map<string, string>();
    for (const s of services.data?.pages.flatMap((p) => p.items) ?? []) names.set(s.id, s.name);
    for (const r of routes.data?.pages.flatMap((p) => p.items) ?? []) names.set(r.id, r.name);
    for (const c of consumers.data?.pages.flatMap((p) => p.items) ?? []) names.set(c.id, consumerName(c));
    return {
      services: services.data?.pages.flatMap((p) => p.items).map((s) => ({ id: s.id, name: s.name })) ?? [],
      routes: routes.data?.pages.flatMap((p) => p.items).map((r) => ({ id: r.id, name: r.name })) ?? [],
      consumers: consumers.data?.pages.flatMap((p) => p.items).map((c) => ({ id: c.id, name: consumerName(c) })) ?? [],
      label: (scope: ScopeChoice) => (scope.kind === "global" ? "Global" : `${SCOPE_LABEL[scope.kind]} ${names.get(scope.id) ?? scope.id.slice(0, 8)}`),
    };
  }, [services.data, routes.data, consumers.data]);
}

type PluginFilter = { global: true } | { serviceId: string } | { routeId: string } | { consumerId: string } | Record<string, never>;

function filterFor(scope: ScopeChoice | null): PluginFilter {
  if (!scope) return {};
  if (scope.kind === "global") return { global: true };
  return { [`${scope.kind}Id`]: scope.id } as PluginFilter;
}

function usePlugins(envId: string, scope: ScopeChoice | null) {
  const filter = filterFor(scope);
  return useInfiniteQuery({
    queryKey: ["plugins", envId, filter],
    queryFn: ({ pageParam }) =>
      unwrap(api.GET("/environments/{envId}/plugins", { params: { path: { envId }, query: { ...filter, ...(pageParam ? { cursor: pageParam } : {}) } } })),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

export function PluginsPage() {
  const envId = useEnvId();
  return <WorkspacePlugins key={envId} workspaceId={envId} />;
}

/** Plugins of one service, route or consumer, shown inside that entity's screen. */
export function ScopedPlugins({ envId, scope, title, readOnly = false }: { envId: string; scope: ScopeChoice; title: string; readOnly?: boolean }) {
  const canEdit = useCanEdit();
  return <PluginList envId={envId} scope={scope} title={title} canEdit={canEdit && !readOnly} />;
}

function PluginList({ envId, scope, title, page, onlyGlobal, onGlobalChange, canEdit }: { envId: string; scope: ScopeChoice | null; title: string; page?: boolean; onlyGlobal?: boolean; onGlobalChange?: (on: boolean) => void; canEdit: boolean }) {
  const plugins = usePlugins(envId, scope);
  const draft = useEntityDraft(envId, "plugins");
  const names = useScopeNames(envId);
  const [editing, setEditing] = useState<Plugin | "new" | null>(null);
  const [deleting, setDeleting] = useState<Plugin | null>(null);
  const items = plugins.data?.pages.flatMap((p) => p.items) ?? [];
  const createAction = canEdit && (
    <Button variant="primary" onClick={() => setEditing("new")}>
      {scope && scope.kind !== "global" ? "Adicionar plugin" : "Novo plugin"}
    </Button>
  );
  return (
    <div className="gateway-list">
      {page ? <PageHeader title={title} description="Os plugins aplicados ao gateway e a cada escopo." actions={createAction} /> : (
        <div className="page-head"><h2>{title}</h2>{createAction}</div>
      )}
      {onGlobalChange && (
        <div className="gateway-filters">
          <select aria-label="Filtrar por escopo" value={onlyGlobal ? "global" : ""} onChange={(e) => onGlobalChange(e.target.value === "global")}>
            <option value="">Todos os escopos</option>
            <option value="global">Só globais</option>
          </select>
        </div>
      )}
      {plugins.isPending && <p className="muted">Carregando…</p>}
      {plugins.isError && <p className="error">{statusMessage(plugins.error)}</p>}
      {plugins.isSuccess && items.length === 0 && <EmptyState title="Nenhum plugin." />}
      {items.length > 0 && (
        <Table label="Plugins" cards>
          <thead>
            <tr>
              <th>Plugin → escopo</th>
              <th className="plugin-state">Ativo</th>
              {canEdit && <th className="actions" aria-label="Ações" />}
            </tr>
          </thead>
          <tbody>
            {items.map((p) => (
              <tr key={p.id}>
                <td className="row-main">
                  <div className="service-route">
                    <span className="service-name mono">{p.name}</span>
                    <DraftBadge change={draft.get(p.id)} />
                    <span className="arrow" aria-hidden="true">→</span>
                    <span className="target mono">{names.label(scopeOf(p))}</span>
                  </div>
                </td>
                <td className="plugin-state"><span className="visually-hidden">Ativo: </span><Badge tone={p.enabled === false ? "off" : "converged"}>{p.enabled === false ? "Não" : "Sim"}</Badge></td>
                {canEdit && (
                  <td className="actions">
                    <Button variant="quiet" onClick={() => setEditing(p)}>
                      Editar
                    </Button>
                    <RowMenu label={`Mais ações para ${p.name} (${names.label(scopeOf(p))})`} items={[{ label: "Excluir", danger: true, onSelect: () => setDeleting(p) }]} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {plugins.hasNextPage && (
        <button type="button" onClick={() => void plugins.fetchNextPage()} disabled={plugins.isFetchingNextPage}>
          Carregar mais
        </button>
      )}
      {canEdit && editing && <PluginEditor envId={envId} plugin={editing === "new" ? null : editing} preset={scope} onClose={() => setEditing(null)} />}
      {canEdit && deleting && <DeletePlugin envId={envId} plugin={deleting} label={names.label(scopeOf(deleting))} onClose={() => setDeleting(null)} />}
    </div>
  );
}

/* ---------------- editor ---------------- */

function PluginEditor({ envId, plugin, preset, onClose }: { envId: string; plugin: Plugin | null; preset: ScopeChoice | null; onClose: () => void }) {
  const [name, setName] = useState<string | null>(plugin?.name ?? null);
  const schema = usePluginSchema(name);
  if (name === null) return <CatalogPicker onPick={setName} onClose={onClose} />;
  return (
    <Modal title={plugin ? `Editar plugin ${name}` : `Novo plugin ${name}`} onClose={onClose} wide>
      {schema.isPending && <p className="muted">Carregando schema…</p>}
      {schema.isError && <p className="error">{statusMessage(schema.error)}</p>}
      {schema.isSuccess && <PluginForm envId={envId} name={name} schema={schema.data} plugin={plugin} preset={preset} onBack={plugin ? null : () => setName(null)} onClose={onClose} />}
    </Modal>
  );
}


const STATIC_PATHS = ["name", "enabled", "protocols", "tags", "scope", "scope.serviceId", "scope.routeId", "scope.consumerId"];

function PluginForm(props: { envId: string; name: string; schema: PluginSchema; plugin: Plugin | null; preset: ScopeChoice | null; onBack: (() => void) | null; onClose: () => void }) {
  const { envId, name, schema, plugin, onClose } = props;
  const invalidate = useInvalidateDraft(envId);
  const names = useScopeNames(envId);
  const [scope, setScope] = useState<ScopeChoice>(() => (plugin ? scopeOf(plugin) : (props.preset ?? { kind: "global", id: "" })));
  const [enabled, setEnabled] = useState(plugin?.enabled ?? true);
  const [protocols, setProtocols] = useState<string[]>(() => plugin?.protocols ?? schema.protocols?.default ?? []);
  const [tags, setTags] = useState((plugin?.tags ?? []).join(", "));
  const [config, setConfig] = useState<Config>(() => initialConfig(schema.config, isObject(plugin?.config) ? plugin.config : undefined));
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState("");
  const [jsonErrors, setJsonErrors] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<{ fields: FieldErrors; form: string[] }>({ fields: {}, form: [] });
  const known = useMemo(() => new Set([...STATIC_PATHS, ...fieldPaths(schema.config)]), [schema]);

  const onJsonError = (path: string, invalid: boolean) =>
    setJsonErrors((s) => {
      const next = new Set(s);
      if (invalid) next.add(path);
      else next.delete(path);
      return next;
    });

  const save = useMutation({
    mutationFn: (body: PluginWrite) =>
      plugin
        ? unwrap(api.PUT("/environments/{envId}/plugins/{pluginId}", { params: { path: { envId, pluginId: plugin.id } }, body }))
        : unwrap(api.POST("/environments/{envId}/plugins", { params: { path: { envId } }, body })),
    onSuccess: () => {
      invalidate("plugins");
      onClose();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 422 && err.problem?.errors?.length) setErrors(placeErrors(err.problem.errors, known));
      else setErrors({ fields: {}, form: [statusMessage(err)] });
    },
  });

  const toggleJson = () => {
    if (!jsonMode) {
      setJsonText(JSON.stringify(configToSubmit(schema.config, config), null, 2));
      setJsonMode(true);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(jsonText);
      if (!isObject(parsed)) throw new Error("not an object");
      setConfig(initialConfig(schema.config, parsed));
      setJsonMode(false);
      setErrors({ fields: {}, form: [] });
    } catch {
      setErrors({ fields: { config: ["JSON inválido: corrija antes de voltar ao formulário."] }, form: [] });
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    let submitted: Config;
    const local: FieldErrors = {};
    if (jsonMode) {
      try {
        const parsed: unknown = JSON.parse(jsonText);
        if (!isObject(parsed)) throw new Error("not an object");
        submitted = parsed;
      } catch {
        setErrors({ fields: { config: ["JSON inválido."] }, form: [] });
        return;
      }
    } else {
      if (jsonErrors.size > 0) {
        setErrors({ fields: {}, form: ["Corrija os campos JSON inválidos."] });
        return;
      }
      Object.assign(local, validateConfig(schema.config, config));
      submitted = configToSubmit(schema.config, config);
    }
    if (scope.kind !== "global" && !scope.id) local.scope = [`Escolha o ${SCOPE_LABEL[scope.kind].toLowerCase()}.`];
    if (Object.keys(local).length > 0) {
      setErrors({ fields: local, form: [] });
      return;
    }
    setErrors({ fields: {}, form: [] });
    save.mutate({
      name,
      enabled,
      scope: scopeBody(scope),
      // The contract types `config` as a bare object; its shape is the plugin schema, checked by the API.
      config: submitted as PluginWrite["config"],
      ...(schema.protocols ? { protocols } : {}),
      tags: splitList(tags),
    });
  };

  const scopeErrors = [...(errors.fields.scope ?? []), ...(errors.fields["scope.serviceId"] ?? []), ...(errors.fields["scope.routeId"] ?? []), ...(errors.fields["scope.consumerId"] ?? [])];
  const options = scope.kind === "service" ? names.services : scope.kind === "route" ? names.routes : scope.kind === "consumer" ? names.consumers : [];
  const allowed: Record<ScopeKind, boolean> = { global: true, ...schema.scopes };

  return (
    <form onSubmit={submit} className="form" noValidate>
      <fieldset className="checks">
        <legend>Escopo</legend>
        {(Object.keys(SCOPE_LABEL) as ScopeKind[]).map((k) => (
          <label key={k} className="check" title={allowed[k] ? undefined : "Este plugin não pode ser aplicado neste escopo."}>
            <input type="radio" name="scope" checked={scope.kind === k} disabled={!allowed[k]} onChange={() => setScope({ kind: k, id: props.preset?.kind === k ? props.preset.id : "" })} /> {SCOPE_LABEL[k]}
          </label>
        ))}
      </fieldset>
      {scope.kind !== "global" && (
        <Field label={SCOPE_LABEL[scope.kind]} errors={scopeErrors}>
          {(id, invalid) => (
            <select id={id} aria-invalid={invalid} value={scope.id} onChange={(e) => setScope({ kind: scope.kind, id: e.target.value })}>
              <option value="">Escolha…</option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          )}
        </Field>
      )}
      {scope.kind === "global" && scopeErrors.length > 0 && <FormErrorList messages={scopeErrors} />}
      <label className="check">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Ativo
      </label>
      {schema.protocols && (
        <fieldset className="checks">
          <legend>Protocolos</legend>
          {schema.protocols.options.map((p) => (
            <label key={p} className="check">
              <input type="checkbox" checked={protocols.includes(p)} onChange={(e) => setProtocols(e.target.checked ? [...protocols, p] : protocols.filter((x) => x !== p))} /> {p}
            </label>
          ))}
          {errors.fields.protocols?.map((m) => (
            <small key={m} className="error" role="alert">
              {m}
            </small>
          ))}
        </fieldset>
      )}
      <div className="page-head">
        <h3>Configuração</h3>
        <button type="button" onClick={toggleJson}>
          {jsonMode ? "Voltar ao formulário" : "JSON avançado"}
        </button>
      </div>
      {errors.fields.config?.map((m) => (
        <small key={m} className="error" role="alert">
          {m}
        </small>
      ))}
      {jsonMode ? (
        <Field label="Configuração (JSON)">
          {(id) => <textarea id={id} className="mono" rows={16} value={jsonText} onChange={(e) => setJsonText(e.target.value)} />}
        </Field>
      ) : (
        <SchemaFields fields={schema.config} value={config} onChange={setConfig} errors={errors.fields} onJsonError={onJsonError} />
      )}
      <Field label="Tags" errors={errors.fields.tags} hint="Separadas por vírgula">
        {(id, invalid) => <input id={id} aria-invalid={invalid} value={tags} onChange={(e) => setTags(e.target.value)} />}
      </Field>
      <FormErrorList messages={errors.form} />
      <div className="form-actions">
        {props.onBack && (
          <button type="button" onClick={props.onBack}>
            Trocar plugin
          </button>
        )}
        <button type="button" onClick={onClose}>
          Cancelar
        </button>
        <button type="submit" className="primary" disabled={save.isPending}>
          {save.isPending ? "Salvando…" : "Salvar"}
        </button>
      </div>
    </form>
  );
}

function DeletePlugin({ envId, plugin, label, onClose }: { envId: string; plugin: Plugin; label: string; onClose: () => void }) {
  const invalidate = useInvalidateDraft(envId);
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE("/environments/{envId}/plugins/{pluginId}", { params: { path: { envId, pluginId: plugin.id } } })),
    onSuccess: () => {
      invalidate("plugins");
      onClose();
    },
  });
  return (
    <ConfirmDialog
      title="Excluir plugin"
      message={
        <>
          Excluir o plugin <strong>{plugin.name}</strong> ({label})? A exclusão entra no rascunho e só afeta o tráfego depois de publicar.
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
