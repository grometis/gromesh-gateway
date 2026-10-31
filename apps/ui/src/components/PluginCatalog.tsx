import { useDeferredValue, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, unwrap, type PluginCatalogEntry } from "../api/client";
import { statusMessage } from "../api/errors";
import { Modal } from "./Modal";
import { EmptyState } from "./EmptyState";
import { Button } from "./Button";

const CATEGORY_LABEL: Record<PluginCatalogEntry["category"], string> = {
  authentication: "Autenticação",
  security: "Segurança",
  "traffic-control": "Controle de tráfego",
  transformation: "Transformação",
  logging: "Logs",
  observability: "Observabilidade",
  serverless: "Serverless",
  ai: "IA",
  other: "Outros",
};
const NOT_IN_DBLESS = "Indisponível: depende de banco de dados no data plane, que roda sem banco.";

export function usePluginCatalog() {
  return useQuery({ queryKey: ["plugin-catalog"], queryFn: () => unwrap(api.GET("/plugin-schemas")), staleTime: Infinity });
}

export function CatalogPicker({ onPick, onClose }: { onPick: (name: string) => void; onClose: () => void }) {
  const catalog = usePluginCatalog();
  const [search, setSearch] = useState("");
  const q = useDeferredValue(search.trim().toLowerCase());
  const groups = useMemo(() => {
    const out = new Map<PluginCatalogEntry["category"], PluginCatalogEntry[]>();
    for (const p of catalog.data?.items ?? []) if (!q || p.name.includes(q)) out.set(p.category, [...(out.get(p.category) ?? []), p]);
    return [...out.entries()].sort(([a], [b]) => CATEGORY_LABEL[a].localeCompare(CATEGORY_LABEL[b], "pt-BR"));
  }, [catalog.data, q]);
  return (
    <Modal title="Escolha um plugin" onClose={onClose} wide>
      <input type="search" className="search" placeholder="Buscar plugin" aria-label="Buscar plugin" value={search} onChange={(e) => setSearch(e.target.value)} />
      {catalog.isPending && <p className="muted">Carregando catálogo…</p>}
      {catalog.isError && <p className="error">{statusMessage(catalog.error)}</p>}
      {catalog.isSuccess && groups.length === 0 && <EmptyState title="Nenhum plugin encontrado." />}
      {groups.map(([category, items]) => (
        <section key={category} className="catalog-group" aria-label={CATEGORY_LABEL[category]}>
          <h3>{CATEGORY_LABEL[category]}</h3>
          <div className="catalog">
            {items.map((p) => {
              const unsupported = p.supportedInDbless === false;
              return (
                <Button key={p.name} className="catalog-card" disabled={unsupported} title={unsupported ? NOT_IN_DBLESS : undefined} onClick={() => onPick(p.name)}>
                  <span className="mono">{p.name}</span>
                  {p.source === "custom" && <small className="muted"> (customizado)</small>}
                  {unsupported && <small className="muted unsupported">{NOT_IN_DBLESS}</small>}
                </Button>
              );
            })}
          </div>
        </section>
      ))}
    </Modal>
  );
}
