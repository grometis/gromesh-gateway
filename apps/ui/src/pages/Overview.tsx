import { useQuery } from "@tanstack/react-query";
import { api, ApiError, retryNetworkErrorsOnly, unwrap } from "../api/client";
import { statusMessage } from "../api/errors";
import { HourlyBars } from "../components/HourlyBars";
import { PageHeader } from "../components/PageHeader";
import { useEnvId, useEnvironment } from "../components/Shell";
import { periodRange, TopRoutes, useVisibleTab } from "./Analytics";

const number = (v: number) => v.toLocaleString("pt-BR");
const percent = (v: number) => `${(v * 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`;
const ms = (v: number | null) => (v === null ? "—" : `${v.toLocaleString("pt-BR", { maximumFractionDigits: 0 })} ms`);

export function OverviewPage() {
  const envId = useEnvId();
  return <Overview key={envId} envId={envId} />;
}

/** The environment at a glance over the last 24 hours: traffic, errors, latency, and where the live version runs. */
function Overview({ envId }: { envId: string }) {
  const visible = useVisibleTab();
  const range = periodRange("24h");
  const env = useEnvironment(envId);
  const summary = useQuery({
    queryKey: ["analytics", envId, "overview", range.to],
    queryFn: () => unwrap(api.GET("/environments/{envId}/analytics/summary", { params: { path: { envId }, query: { ...range, interval: "1h" } } })),
    retry: retryNetworkErrorsOnly,
    refetchInterval: visible ? 60_000 : false,
  });
  // Shared with the publish strip and the Clusters screen.
  const clusters = useQuery({
    queryKey: ["clusters", envId],
    queryFn: () => unwrap(api.GET("/environments/{envId}/clusters", { params: { path: { envId } } })),
    staleTime: 10_000,
  });
  const current = env.data?.currentVersion ?? null;
  const nodes = (clusters.data?.items ?? []).flatMap((c) => c.nodes).filter((n) => n.online);
  const synced = nodes.filter((n) => current !== null && n.appliedVersion === current).length;
  const totals = summary.data?.totals;
  const unavailable = summary.isError && summary.error instanceof ApiError && summary.error.status === 502;

  return (
    <section className="final-page">
      <PageHeader title="Visão geral" description="Últimas 24 horas deste environment." />
      <dl className="tiles" aria-label="Indicadores das últimas 24 horas">
        <div className="tile">
          <dt>Requisições</dt>
          <dd>
            <span className="value mono">{totals ? number(totals.requests) : "—"}</span>
          </dd>
        </div>
        <div className="tile">
          <dt>Taxa de erro</dt>
          <dd>
            <span className="value mono">{totals ? percent(totals.errorRate) : "—"}</span>
            {totals && totals.requests > 0 && (
              <small>
                <span className="mono">{number(totals.errors4xx)}</span> 4xx · <span className="mono">{number(totals.errors5xx)}</span> 5xx
              </small>
            )}
          </dd>
        </div>
        <div className="tile">
          <dt>Latência p95</dt>
          <dd>
            <span className="value mono">{totals ? ms(totals.p95Ms) : "—"}</span>
          </dd>
        </div>
        <div className="tile">
          <dt>Nós na versão no ar</dt>
          <dd>
            <span className="value mono">{nodes.length === 0 ? "—" : `${synced}/${nodes.length}`}</span>
            <small>{current === null ? "nada publicado" : nodes.length === 0 ? "nenhum nó online" : <span className="mono">v{current}</span>}</small>
          </dd>
        </div>
      </dl>
      {summary.isPending && <p className="muted">Carregando o tráfego…</p>}
      {summary.isError && (
        <p className="error" role="alert">
          {unavailable ? "Os dados de tráfego não estão disponíveis no momento (coletor fora do ar ou não configurado)." : statusMessage(summary.error)}
        </p>
      )}
      {summary.data && (
        <HourlyBars
          title="Requisições por hora"
          buckets={summary.data.series.map((p) => ({ ts: p.ts, ok: p.requests - p.errors4xx - p.errors5xx, errors: p.errors4xx + p.errors5xx }))}
        />
      )}
      <div className="block">
        <TopRoutes envId={envId} range={range} tick={0} visible={visible} />
      </div>
    </section>
  );
}
