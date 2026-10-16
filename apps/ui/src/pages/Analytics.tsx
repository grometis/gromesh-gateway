import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError, unwrap, type Schemas } from "../api/client";
import { statusMessage } from "../api/errors";
import { useRouteList } from "../api/lists";
import { LineChart } from "../components/Chart";
import { Field } from "../components/Field";
import { useEnvId } from "../components/Shell";
import { useServices } from "./Services";

type Interval = Schemas["AnalyticsSummary"]["interval"];

/** Preset periods; the bucket size keeps every preset under a few hundred points. */
export const PERIODS = {
  "1h": { label: "Última hora", ms: 3_600_000, interval: "1m" as Interval },
  "6h": { label: "Últimas 6 horas", ms: 6 * 3_600_000, interval: "5m" as Interval },
  "24h": { label: "Últimas 24 horas", ms: 24 * 3_600_000, interval: "15m" as Interval },
  "7d": { label: "Últimos 7 dias", ms: 7 * 86_400_000, interval: "1h" as Interval },
} as const;
export type PeriodKey = keyof typeof PERIODS;

/** `to` is rounded down to the minute so the query key is stable between refreshes within the same minute. */
export function periodRange(key: PeriodKey, now = Date.now()): { from: string; to: string } {
  const to = Math.floor(now / 60_000) * 60_000;
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
