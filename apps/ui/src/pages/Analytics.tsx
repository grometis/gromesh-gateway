import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError, unwrap, type Schemas } from "../api/client";
import { statusMessage } from "../api/errors";
import { useRouteList } from "../api/lists";
import { LineChart } from "../components/Chart";
import { Field } from "../components/Field";
import { useEnvId } from "../components/Shell";
import { useServices } from "./Services";

type Interval = Schemas["AnalyticsSummary"]["interval"];
type TopBy = Schemas["TopRoutes"]["by"];

const TOP_BY: Record<TopBy, string> = { requests: "Requisições", errors: "Erros (4xx + 5xx)", p95: "Latência p95" };

/** Preset periods; the bucket size keeps every preset under a few hundred points. */
export const PERIODS = {
  "1h": { label: "Última hora", ms: 3_600_000, interval: "1m" as Interval },
  "6h": { label: "Últimas 6 horas", ms: 6 * 3_600_000, interval: "5m" as Interval },
  "24h": { label: "Últimas 24 horas", ms: 24 * 3_600_000, interval: "15m" as Interval },
  "7d": { label: "Últimos 7 dias", ms: 7 * 86_400_000, interval: "1h" as Interval },
} as const;
export type PeriodKey = keyof typeof PERIODS;

/** `to` is the end of the current minute: the latest traffic counts, and the query key stays stable within a minute. */
export function periodRange(key: PeriodKey, now = Date.now()): { from: string; to: string } {
  const to = Math.ceil((now + 1) / 60_000) * 60_000;
  return { from: new Date(to - PERIODS[key].ms).toISOString(), to: new Date(to).toISOString() };
}

export function useVisibleTab() {
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

/** Route and service selectors shared by the dashboard and the explorer. */
export function ScopeFilters({
  envId,
  routeId,
  serviceId,
  onRoute,
  onService,
}: {
  envId: string;
  routeId: string;
  serviceId: string;
  onRoute: (id: string) => void;
  onService: (id: string) => void;
}) {
  const routes = useRouteList(envId);
  const services = useServices(envId);
  return (
    <>
      <Field label="Service">
        {(id) => (
          <select id={id} value={serviceId} onChange={(e) => onService(e.target.value)}>
            <option value="">Todos</option>
            {(services.data?.pages.flatMap((p) => p.items) ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="Route">
        {(id) => (
          <select id={id} value={routeId} onChange={(e) => onRoute(e.target.value)}>
            <option value="">Todas</option>
            {(routes.data?.pages.flatMap((p) => p.items) ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        )}
      </Field>
    </>
  );
}

export function PeriodSelect({ value, onChange }: { value: PeriodKey; onChange: (v: PeriodKey) => void }) {
  return (
    <Field label="Período">
      {(id) => (
        <select id={id} value={value} onChange={(e) => onChange(e.target.value as PeriodKey)}>
          {(Object.keys(PERIODS) as PeriodKey[]).map((k) => (
            <option key={k} value={k}>
              {PERIODS[k].label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

const number = (v: number) => v.toLocaleString("pt-BR");
const percent = (v: number) => `${(v * 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`;
const ms = (v: number | null) => (v === null ? "—" : `${v.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} ms`);

export function AnalyticsPage() {
  const envId = useEnvId();
  return <Dashboard key={envId} envId={envId} />;
}

function Dashboard({ envId }: { envId: string }) {
  const visible = useVisibleTab();
  const [period, setPeriod] = useState<PeriodKey>("6h");
  const [routeId, setRouteId] = useState("");
  const [serviceId, setServiceId] = useState("");
  // Re-evaluated on every refetch, so the window slides with the clock.
  const [tick, setTick] = useState(0);
  const range = periodRange(period);
  const summary = useQuery({
    queryKey: ["analytics", envId, period, routeId, serviceId, range.to, tick],
    queryFn: () =>
      unwrap(
        api.GET("/environments/{envId}/analytics/summary", {
          params: {
            path: { envId },
            query: { ...range, interval: PERIODS[period].interval, ...(routeId ? { routeId } : {}), ...(serviceId ? { serviceId } : {}) },
          },
        }),
      ),
    refetchInterval: visible ? 60_000 : false,
  });
  const data = summary.data;

  return (
    <section>
      <div className="page-head">
        <h1>Dashboard</h1>
        <button type="button" onClick={() => setTick((t) => t + 1)} disabled={summary.isFetching}>
          {summary.isFetching ? "Atualizando…" : "Atualizar"}
        </button>
      </div>
      <div className="analytics-filters">
        <PeriodSelect value={period} onChange={setPeriod} />
        <ScopeFilters envId={envId} routeId={routeId} serviceId={serviceId} onRoute={setRouteId} onService={setServiceId} />
      </div>
      {summary.isPending && <p className="muted">Carregando…</p>}
      {summary.isError && (
        <p className="error" role="alert">
          {summary.error instanceof ApiError && summary.error.status === 502 ? "Os dados de tráfego não estão disponíveis no momento (coletor fora do ar ou não configurado)." : statusMessage(summary.error)}
        </p>
      )}
      {data && (
        <>
          <dl className="stat-cards" aria-label="Totais do período">
            <div className="stat-card">
              <dt>Requisições</dt>
              <dd>{number(data.totals.requests)}</dd>
            </div>
            <div className="stat-card">
              <dt>Taxa de erro</dt>
              <dd>{percent(data.totals.errorRate)}</dd>
            </div>
            <div className="stat-card">
              <dt>Erros 4xx</dt>
              <dd>{number(data.totals.errors4xx)}</dd>
            </div>
            <div className="stat-card">
              <dt>Erros 5xx</dt>
              <dd>{number(data.totals.errors5xx)}</dd>
            </div>
            <div className="stat-card">
              <dt>Latência p95</dt>
              <dd>{ms(data.totals.p95Ms)}</dd>
            </div>
            <div className="stat-card">
              <dt>Latência p99</dt>
              <dd>{ms(data.totals.p99Ms)}</dd>
            </div>
          </dl>
          <TopRoutes envId={envId} range={range} tick={tick} visible={visible} />
          <div className="charts">
            <LineChart title="Requisições por intervalo" points={data.series} lines={[{ key: "requests", label: "Requisições", color: "var(--primary)" }]} />
            <LineChart
              title="Erros por intervalo"
              points={data.series}
              lines={[
                { key: "errors4xx", label: "4xx", color: "var(--modified)" },
                { key: "errors5xx", label: "5xx", color: "var(--removed)" },
              ]}
            />
            <LineChart
              title="Latência total"
              points={data.series}
              unit="ms"
              lines={[
                { key: "p50Ms", label: "p50", color: "var(--added)" },
                { key: "p95Ms", label: "p95", color: "var(--modified)" },
                { key: "p99Ms", label: "p99", color: "var(--removed)" },
              ]}
            />
          </div>
        </>
      )}
    </section>
  );
}

/** The routes with the most traffic, errors or latency of the period; a row opens the explorer filtered by the route. */
function TopRoutes({ envId, range, tick, visible }: { envId: string; range: { from: string; to: string }; tick: number; visible: boolean }) {
  const [by, setBy] = useState<TopBy>("requests");
  const top = useQuery({
    queryKey: ["top-routes", envId, by, range.to, tick],
    queryFn: () => unwrap(api.GET("/environments/{envId}/analytics/top-routes", { params: { path: { envId }, query: { ...range, by, limit: 10 } } })),
    refetchInterval: visible ? 60_000 : false,
  });
  return (
    <section className="top-routes" aria-labelledby="top-routes-title">
      <div className="page-head">
        <h2 id="top-routes-title">Top rotas</h2>
        <Field label="Critério">
          {(id) => (
            <select id={id} value={by} onChange={(e) => setBy(e.target.value as TopBy)}>
              {(Object.keys(TOP_BY) as TopBy[]).map((k) => (
                <option key={k} value={k}>
                  {TOP_BY[k]}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      {top.isError && (
        <p className="error" role="alert">
          {statusMessage(top.error)}
        </p>
      )}
      {top.data && top.data.items.length === 0 && <p className="muted">Sem tráfego no período.</p>}
      {top.data && top.data.items.length > 0 && (
        <table aria-label="Top rotas">
          <thead>
            <tr>
              <th scope="col">Route</th>
              <th scope="col">Requisições</th>
              <th scope="col">Erros</th>
              <th scope="col">Taxa de erro</th>
              <th scope="col">p95</th>
            </tr>
          </thead>
          <tbody>
            {top.data.items.map((item) => (
              <tr key={item.routeId ?? "none"}>
                <td>
                  {item.routeId === null ? (
                    <span className="muted">Sem rota</span>
                  ) : (
                    <Link to={`/e/${envId}/requests?routeId=${item.routeId}`} title={item.routeName === null ? "Rota removida; abre o explorador filtrado pelo id" : "Abre o explorador filtrado por esta rota"}>
                      {item.routeName ?? `${item.routeId.slice(0, 8)}… (removida)`}
                    </Link>
                  )}
                </td>
                <td>{number(item.requests)}</td>
                <td>{number(item.errors4xx + item.errors5xx)}</td>
                <td>{percent(item.errorRate)}</td>
                <td>{ms(item.p95Ms)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
