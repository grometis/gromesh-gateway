import { useState, type FormEvent } from "react";
import { useInfiniteQuery, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api, unwrap, type Plugin } from "../api/client";
import { apiV2 } from "../api/client-v2";
import type { components } from "../api/schema-v2";
import { statusMessage, type FormErrors } from "../api/errors";
import { CheckboxField, Field, FormErrorList } from "../components/Field";
import { Button } from "../components/Button";
import { PageHeader } from "../components/PageHeader";
import { EmptyState } from "../components/EmptyState";
import { Badge, DraftBadge } from "../components/Badge";
import { RowMenu } from "../components/RowMenu";
import { CatalogPicker } from "../components/PluginCatalog";
import { useEntityDraft } from "./Services";
import { Table } from "../components/Table";
import { ConfirmDialog, Modal } from "../components/Modal";
import { SchemaFields } from "../schema-form/SchemaForm";
import { configToSubmit, fieldPaths, initialConfig, isObject, parsePluginSchema, placeErrors, SECRET_PLACEHOLDER, validateConfig, type Config, type NamedField, type PluginSchema } from "../schema-form/schema";
import { gatewayErrorMessage, gatewayMessage } from "./gateway-errors";
import { useWorkspaceGatewayAccess, WorkspaceGatewayNote } from "./workspace-gateway";

type ContractPluginWrite = components["schemas"]["WorkspacePluginWrite"];
// The generated bare OpenAPI object is Record<string, never>; its shape comes from the catalog.
type PluginWrite = Omit<ContractPluginWrite, "config"> & { config: Config };
const NO_ERRORS: FormErrors = { fields: {}, form: [] };

/** Secrets live in the open form only: no mutation variables or optimistic data are put in QueryClient. */
export async function saveWorkspacePlugin(workspaceId: string, current: Plugin | null, body: PluginWrite) {
  return current
    ? unwrap(apiV2.PUT("/workspaces/{workspaceId}/plugins/{pluginId}", { params: { path: { workspaceId, pluginId: current.id } }, body: body as ContractPluginWrite }))
    : unwrap(apiV2.POST("/workspaces/{workspaceId}/plugins", { params: { path: { workspaceId } }, body: body as ContractPluginWrite }));
}

/** A saved encrypted slot is represented only by its write-only placeholder; schema defaults never fill secrets. */
export function workspacePluginConfig(schema: PluginSchema, saved: Config | undefined): Config {
  const scrub = (fields: NamedField[], value: Config, stored: Config): Config => {
    const out = { ...value };
    for (const { name, field } of fields) {
      if (field.encrypted) {
        if (stored[name] !== undefined && stored[name] !== null) out[name] = SECRET_PLACEHOLDER;
        else delete out[name];
      } else if (field.type === "record" && isObject(out[name])) {
        out[name] = scrub(field.fields ?? [], out[name] as Config, isObject(stored[name]) ? stored[name] as Config : {});
      }
    }
    return out;
  };
  return scrub(schema.config, initialConfig(schema.config, saved), saved ?? {});
}

export function workspacePluginErrors(error: unknown, schema?: PluginSchema): FormErrors {
  if (error instanceof ApiError && error.status === 422) {
    if (!error.problem?.errors?.length) return { fields: {}, form: [statusMessage(error)] };
    const known = new Set(["name", "scope", "scope.serviceId", "scope.routeId", "scope.consumerId", "enabled", "protocols", "tags", ...(schema ? fieldPaths(schema.config) : [])]);
    return placeErrors((error.problem?.errors ?? []).map(item => ({ ...item, message: gatewayMessage(item.path, item.message) })), known);
  }
  if (error instanceof ApiError && error.status === 409 && !(error.problem && "code" in error.problem)) {
    return { fields: {}, form: ["Já existe um plugin com este nome e escopo neste Workspace."] };
  }
  return { fields: {}, form: [gatewayErrorMessage(error)] };
}

async function allPages<T>(read: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string | null }>) {
  const items: T[] = [];
  let cursor: string | undefined;
  do { const page = await read(cursor); items.push(...page.items); cursor = page.nextCursor ?? undefined; } while (cursor);
  return items;
}

function usePluginChoices(workspaceId: string) {
  const path = { workspaceId };
  // A slow or unavailable scope must not hide names and filters from the others.
  const [services, routes, consumers] = useQueries({
    queries: [
      {
        queryKey: ["ws-plugin-choices", workspaceId, "services"],
        queryFn: async () => (await allPages(cursor => unwrap(apiV2.GET("/workspaces/{workspaceId}/services", { params: { path, query: { limit: 200, cursor } } })))).map(s => ({ id: s.id, name: s.name })),
      },
      {
        queryKey: ["ws-plugin-choices", workspaceId, "routes"],
        queryFn: async () => (await allPages(cursor => unwrap(apiV2.GET("/workspaces/{workspaceId}/routes", { params: { path, query: { limit: 200, cursor } } })))).map(r => ({ id: r.id, name: r.name })),
      },
      {
        queryKey: ["ws-plugin-choices", workspaceId, "consumers"],
        queryFn: async () => (await allPages(cursor => unwrap(apiV2.GET("/workspaces/{workspaceId}/consumers", { params: { path, query: { limit: 200, cursor } } })))).map(c => ({ id: c.id, name: c.username ?? c.customId ?? c.id })),
      },
    ],
  });
  const queries = [services, routes, consumers];
  return {
    data: { serviceId: services.data ?? [], routeId: routes.data ?? [], consumerId: consumers.data ?? [] },
    isSuccess: queries.every(query => query.isSuccess),
    isError: queries.some(query => query.isError),
    error: queries.find(query => query.isError)?.error,
  };
}

export function WorkspacePlugins({ workspaceId }: { workspaceId: string }) {
  const access = useWorkspaceGatewayAccess(workspaceId);
  const client = useQueryClient();
  const names = usePluginChoices(workspaceId);
  const draft = useEntityDraft(workspaceId, "plugins");
  const [scopeFilter, setScopeFilter] = useState("");
  const filter = scopeFilter === "global" ? { global: true } : scopeFilter ? { [scopeFilter.split(":")[0]!]: scopeFilter.split(":")[1]! } : {};
  const scopeLabel = (plugin: Plugin) => {
    const parts = ([ ["serviceId", "Service"], ["routeId", "Route"], ["consumerId", "Consumer"] ] as const)
      .flatMap(([kind, label]) => {
        const id = plugin.scope?.[kind];
        return id ? [`${label} ${names.data?.[kind].find(item => item.id === id)?.name ?? id}`] : [];
      });
    return parts.length ? parts.join(" · ") : "Global legado (somente leitura)";
  };
  const plugins = useInfiniteQuery({
    queryKey: ["ws-plugins", workspaceId, filter],
    queryFn: ({ pageParam }) => unwrap(apiV2.GET("/workspaces/{workspaceId}/plugins", { params: { path: { workspaceId }, query: { ...filter, cursor: pageParam || undefined } } })),
    initialPageParam: "", getNextPageParam: page => page.nextCursor ?? undefined,
  });
  const [editing, setEditing] = useState<Plugin | "new" | null>(null);
  const [deleting, setDeleting] = useState<Plugin | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invalidate = () => {
    for (const key of ["ws-plugins", "plugins", "environment", "preview"]) void client.invalidateQueries({ queryKey: [key, workspaceId] });
  };
  const remove = async () => {
    if (!access.canWrite || !deleting || busy) return;
    setBusy(true); setError(null);
    try {
      await unwrap(apiV2.DELETE("/workspaces/{workspaceId}/plugins/{pluginId}", { params: { path: { workspaceId, pluginId: deleting.id } } }));
      invalidate(); setDeleting(null);
    } catch (err) {
      const errors = workspacePluginErrors(err);
      setError([...errors.form, ...Object.values(errors.fields).flat()].join(" "));
    }
    finally { setBusy(false); }
  };
  const items = plugins.data?.pages.flatMap(page => page.items) ?? [];
  return <section className="final-page gateway-list">
    <PageHeader title="Plugins" description="Plugins com escopo neste Workspace. As alterações ficam no rascunho." actions={access.canWrite && <Button variant="primary" onClick={() => setEditing("new")}>Novo plugin</Button>} />
    <WorkspaceGatewayNote workspaceId={workspaceId} />
    <p className="muted">Escolha ao menos um service, route ou consumer. Plugins globais do Workspace ainda não estão disponíveis; os obrigatórios da plataforma são protegidos pelo servidor.</p>
    <div className="gateway-filters">
      <select aria-label="Filtrar por escopo" value={scopeFilter} onChange={event => setScopeFilter(event.target.value)}>
        <option value="">Todos os escopos</option>
        <option value="global">Só globais</option>
        {([ ["serviceId", "Service"], ["routeId", "Route"], ["consumerId", "Consumer"] ] as const).map(([kind, label]) =>
          names.data?.[kind].map(item => <option key={`${kind}:${item.id}`} value={`${kind}:${item.id}`}>{label} {item.name}</option>))}
      </select>
    </div>
    {plugins.isPending && <p role="status">Carregando…</p>}
    {plugins.isError && <p className="error" role="alert">{statusMessage(plugins.error)}</p>}
    {plugins.isSuccess && !items.length && <EmptyState title={scopeFilter ? "Nenhum plugin encontrado." : "Nenhum plugin neste Workspace."} />}
    {!!items.length && <Table label="Plugins" cards><thead><tr><th>Plugin → escopo</th><th className="plugin-state">Ativo</th>{access.canWrite && <th className="actions" aria-label="Ações" />}</tr></thead><tbody>
      {items.map(p => {
        const scoped = Object.values(p.scope ?? {}).some(Boolean);
        const label = scopeLabel(p);
        return <tr key={p.id}>
          <td className="row-main"><div className="service-route">
            <span className="service-name mono">{p.name}</span><DraftBadge change={draft.get(p.id)} />
            <span className="arrow" aria-hidden="true">→</span><span className="target mono">{label}</span>
          </div></td>
          <td className="plugin-state"><span className="visually-hidden">Ativo: </span><Badge tone={p.enabled === false ? "off" : "converged"}>{p.enabled === false ? "Não" : "Sim"}</Badge></td>
          {access.canWrite && <td className="actions">
            {scoped && <><Button variant="quiet" aria-label={`Editar ${p.name}`} onClick={() => setEditing(p)}>Editar</Button><RowMenu label={`Mais ações para ${p.name} (${label})`} items={[{ label: "Excluir", danger: true, onSelect: () => { setError(null); setDeleting(p); } }]} /></>}
          </td>}
        </tr>;
      })}
    </tbody></Table>}
    {plugins.hasNextPage && <Button disabled={plugins.isFetchingNextPage} onClick={() => void plugins.fetchNextPage()}>Carregar mais</Button>}
    {editing && <PluginEditor workspaceId={workspaceId} current={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { invalidate(); setEditing(null); }} />}
    {deleting && <ConfirmDialog title="Excluir plugin" message={<>Excluir <strong>{deleting.name}</strong> ({scopeLabel(deleting)}) do rascunho deste Workspace?</>} confirmLabel="Excluir" busy={busy} confirmDisabled={!access.canWrite} error={error} onConfirm={() => void remove()} onClose={() => setDeleting(null)} />}
  </section>;
}

function PluginEditor({ workspaceId, current, onClose, onSaved }: { workspaceId: string; current: Plugin | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(current?.name ?? "");
  const catalog = useQuery({ queryKey: ["plugin-catalog"], queryFn: () => unwrap(api.GET("/plugin-schemas")), staleTime: Infinity });
  const schema = useQuery({ queryKey: ["plugin-schema", name], queryFn: async () => parsePluginSchema(await unwrap(api.GET("/plugin-schemas/{pluginName}", { params: { path: { pluginName: name } } }))), enabled: !!name, staleTime: Infinity });
  if (!name) return <CatalogPicker onPick={setName} onClose={onClose} />;
  return <Modal title={current ? `Editar plugin ${current.name}` : "Novo plugin"} onClose={onClose} wide>
    <Field label="Plugin">{id => <select id={id} value={name} disabled={!!current} onChange={e => setName(e.target.value)}><option value="">Escolha um plugin</option>{catalog.data?.items.map(p => <option key={p.name} value={p.name} disabled={!p.supportedInDbless}>{p.name}{!p.supportedInDbless ? " (indisponível)" : ""}</option>)}</select>}</Field>
    {(catalog.isError || schema.isError) && <p className="error" role="alert">{statusMessage(catalog.error ?? schema.error)}</p>}
    {schema.isFetching && <p role="status">Carregando schema…</p>}
    {name && schema.data && <PluginForm key={name} workspaceId={workspaceId} name={name} schema={schema.data} current={current} onSaved={onSaved} />}
  </Modal>;
}

function PluginForm({ workspaceId, name, schema, current, onSaved }: { workspaceId: string; name: string; schema: PluginSchema; current: Plugin | null; onSaved: () => void }) {
  const access = useWorkspaceGatewayAccess(workspaceId);
  const choices = usePluginChoices(workspaceId);
  const [scope, setScope] = useState({ serviceId: current?.scope?.serviceId ?? "", routeId: current?.scope?.routeId ?? "", consumerId: current?.scope?.consumerId ?? "" });
  const [enabled, setEnabled] = useState(current?.enabled ?? true);
  const [config, setConfig] = useState(() => workspacePluginConfig(schema, isObject(current?.config) ? current.config : undefined));
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);
  const [invalidJson, setInvalidJson] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!access.canWrite || busy) return;
    const fields = validateConfig(schema.config, config);
    if (!Object.values(scope).some(Boolean)) fields.scope = ["Escolha ao menos um escopo deste Workspace."];
    if (Object.keys(fields).length || invalidJson.size) { setErrors({ fields, form: invalidJson.size ? ["Corrija os campos JSON inválidos."] : [] }); return; }
    setBusy(true); setErrors(NO_ERRORS);
    try {
      await saveWorkspacePlugin(workspaceId, current, {
        name, enabled, scope: Object.fromEntries(Object.entries(scope).filter(([, id]) => id)), config: configToSubmit(schema.config, config),
        ...(current?.protocols ? { protocols: current.protocols } : {}), tags: current?.tags ?? [],
      });
      setConfig({}); onSaved();
    } catch (err) { setErrors(workspacePluginErrors(err, schema)); }
    finally { setBusy(false); }
  };
  return <form onSubmit={event => void submit(event)}>
    <FormErrorList messages={errors.form} />
    {choices.isError && <p className="error" role="alert">{statusMessage(choices.error)}</p>}
    <fieldset disabled={busy || (!access.canWrite && !access.isRevalidating)}>
      <legend>Escopo e configuração</legend>
      {([ ["serviceId", "Service", schema.scopes.service], ["routeId", "Route", schema.scopes.route], ["consumerId", "Consumer", schema.scopes.consumer] ] as const).map(([key, label, allowed]) => allowed && <Field key={key} label={label} errors={errors.fields[`scope.${key}`]}>{(id, invalid) => <select id={id} aria-invalid={invalid} value={scope[key]} onChange={e => setScope(s => ({ ...s, [key]: e.target.value }))}><option value="">(nenhum)</option>{scope[key] && !choices.data?.[key].some(item => item.id === scope[key]) && <option value={scope[key]}>{scope[key]}</option>}{choices.data?.[key].map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}</Field>)}
      {errors.fields.scope?.map(message => <p key={message} className="error" role="alert">{message}</p>)}
      <CheckboxField label="Ativo" checked={enabled} onChange={setEnabled} errors={errors.fields.enabled} />
      <SchemaFields fields={schema.config} value={config} onChange={setConfig} errors={errors.fields} onJsonError={(path, invalid) => setInvalidJson(old => { const next = new Set(old); if (invalid) next.add(path); else next.delete(path); return next; })} />
    </fieldset>
    <Button type="submit" variant="primary" disabled={busy || !access.canWrite || !choices.isSuccess}>{busy ? "Salvando…" : "Salvar no rascunho"}</Button>
  </form>;
}
