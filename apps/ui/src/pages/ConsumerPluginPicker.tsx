import { useQueries } from "@tanstack/react-query";
import { api, unwrap } from "../api/client";
import { CatalogPicker, usePluginCatalog } from "../components/PluginCatalog";
import { Modal } from "../components/Modal";
import { parsePluginSchema } from "../schema-form/schema";
import { consumerPluginAllowed, consumerPluginMessage } from "./consumer-plugins";

export function ConsumerPluginPicker({ workspaceId, consumerId, onPick, onClose }: { workspaceId: string; consumerId: string; onPick: (name: string) => void; onClose: () => void }) {
  const catalog = usePluginCatalog();
  const candidates = catalog.data?.items.filter(p => consumerPluginAllowed(p)) ?? [];
  const schemas = useQueries({ queries: candidates.map(p => ({
    queryKey: ["ws-consumer-plugin-schema", workspaceId, consumerId, p.name],
    queryFn: async ({ signal }: { signal: AbortSignal }) => parsePluginSchema(await unwrap(api.GET("/plugin-schemas/{pluginName}", { params: { path: { pluginName: p.name } }, signal }))), staleTime: Infinity,
  })) });
  const error = catalog.error ?? schemas.find(s => s.isError)?.error;
  if (catalog.isPending || schemas.some(s => s.isPending) || error) return <Modal title="Escolha um plugin" onClose={onClose} wide>{error ? <p role="alert" className="error">{consumerPluginMessage(error)}</p> : <p role="status">Carregando plugins compatíveis…</p>}</Modal>;
  const allowed = new Set(candidates.filter((p, i) => schemas[i]?.isSuccess && consumerPluginAllowed(p, schemas[i]!.data)).map(p => p.name));
  return <CatalogPicker filter={entry => allowed.has(entry.name)} onPick={name => { if (allowed.has(name)) onPick(name); }} onClose={onClose} />;
}
