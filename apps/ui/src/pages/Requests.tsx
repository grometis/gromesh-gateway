import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { api, ApiError, unwrap, type Schemas } from "../api/client";
import { statusMessage, toFormErrors } from "../api/errors";
import { useConsumers, consumerName } from "../api/lists";
import { Field, FormErrorList } from "../components/Field";
import { Modal } from "../components/Modal";
import { useEnvId } from "../components/Shell";
import { PeriodSelect, ScopeFilters, periodRange, type PeriodKey } from "./Analytics";

type RequestRecord = Schemas["RequestRecord"];
type StatusClass = "" | "2xx" | "3xx" | "4xx" | "5xx";

const FIELDS = ["from", "to", "status", "statusClass", "routeId", "serviceId", "consumerId"] as const;
const EMPTY = { period: "6h" as PeriodKey, status: "", statusClass: "" as StatusClass, routeId: "", serviceId: "", consumerId: "" };
type Filters = typeof EMPTY;

const statusClassOf = (status: number) => `status-${Math.floor(status / 100)}xx`;
const when = (iso: string) => new Date(iso).toLocaleString("pt-BR", { hour12: false, fractionalSecondDigits: 3 } as Intl.DateTimeFormatOptions);

export function RequestsPage() {
  const envId = useEnvId();
  return <Explorer key={envId} envId={envId} />;
}

function Explorer({ envId }: { envId: string }) {
  // The dashboard links here with ?routeId=…: the filter starts applied.
  const [params] = useSearchParams();
  const initial = { ...EMPTY, routeId: params.get("routeId") ?? "" };
  const [form, setForm] = useState<Filters>(initial);
  const [applied, setApplied] = useState<Filters & { range: { from: string; to: string } }>({ ...initial, range: periodRange(initial.period) });
  const [selected, setSelected] = useState<RequestRecord | null>(null);
  const consumers = useConsumers(envId);
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setForm((f) => ({ ...f, [k]: v }));

  const query = {
    ...applied.range,
    ...(applied.status ? { status: Number(applied.status) } : {}),
    ...(applied.statusClass ? { statusClass: applied.statusClass } : {}),
    ...(applied.routeId ? { routeId: applied.routeId } : {}),
    ...(applied.serviceId ? { serviceId: applied.serviceId } : {}),
    ...(applied.consumerId ? { consumerId: applied.consumerId } : {}),
  };
  const requests = useInfiniteQuery({
    queryKey: ["requests", envId, query],
    queryFn: ({ pageParam }) =>
      unwrap(api.GET("/environments/{envId}/requests", { params: { path: { envId }, query: { ...query, ...(pageParam ? { cursor: pageParam } : {}) } } })),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const items = requests.data?.pages.flatMap((p) => p.items) ?? [];
  const failure = requests.error instanceof ApiError ? requests.error.status : null;
  const errors = failure === 422 ? toFormErrors(requests.error, FIELDS) : { fields: {}, form: [] };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setApplied({ ...form, range: periodRange(form.period) });
  };

  return (
    <section>
      <div className="page-head">
        <h1>Requisições</h1>
      </div>
      <form className="analytics-filters" onSubmit={submit} noValidate aria-label="Filtros de requisições">
        <PeriodSelect value={form.period} onChange={(v) => set("period", v)} />
        <Field label="Classe de status" errors={errors.fields.statusClass}>
          {(id, invalid) => (
            <select id={id} aria-invalid={invalid} value={form.statusClass} onChange={(e) => set("statusClass", e.target.value as StatusClass)}>
              <option value="">Todas</option>
              {["2xx", "3xx", "4xx", "5xx"].map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Status exato" errors={errors.fields.status} hint="Ignora a classe">
          {(id, invalid) => <input id={id} inputMode="numeric" aria-invalid={invalid} value={form.status} onChange={(e) => set("status", e.target.value)} placeholder="ex.: 404" />}
        </Field>
        <ScopeFilters envId={envId} routeId={form.routeId} serviceId={form.serviceId} onRoute={(v) => set("routeId", v)} onService={(v) => set("serviceId", v)} />
        <Field label="Consumer" errors={errors.fields.consumerId}>
          {(id) => (
            <select id={id} value={form.consumerId} onChange={(e) => set("consumerId", e.target.value)}>
              <option value="">Todos</option>
              {(consumers.data?.pages.flatMap((p) => p.items) ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {consumerName(c)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <div className="form-actions">
          <button type="submit" className="primary">
            Filtrar
          </button>
        </div>
      </form>
      <FormErrorList messages={errors.form} />
      {requests.isPending && <p className="muted">Carregando…</p>}
      {requests.isError && failure !== 422 && (
        <p className="error" role="alert">
          {failure === 502 ? "Os dados de tráfego não estão disponíveis no momento (coletor fora do ar ou não configurado)." : statusMessage(requests.error)}
        </p>
      )}
      {requests.isSuccess && items.length === 0 && <p className="muted">Nenhuma requisição no período.</p>}
      {items.length > 0 && (
        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th>Quando</th>
                <th>Método</th>
                <th>Path</th>
                <th>Status</th>
                <th>Latência</th>
                <th>Cliente</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id} className="row-link" onClick={() => setSelected(r)}>
                  <td>
                    <time dateTime={r.ts}>{when(r.ts)}</time>
                  </td>
                  <td className="mono">{r.method}</td>
                  <td className="mono wrap">{r.path}</td>
                  <td className={statusClassOf(r.status)}>{r.status}</td>
                  <td>{r.latencyTotalMs} ms</td>
                  <td className="mono">{r.clientIp}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {requests.hasNextPage && (
        <button type="button" disabled={requests.isFetchingNextPage} onClick={() => void requests.fetchNextPage()}>
          Carregar mais
        </button>
      )}
      {selected && <RequestDetail record={selected} onClose={() => setSelected(null)} />}
    </section>
  );
}

function RequestDetail({ record, onClose }: { record: RequestRecord; onClose: () => void }) {
  const rows: [string, string][] = [
    ["Quando", when(record.ts)],
    ["Método", record.method],
    ["Path", record.path],
    ["Status", String(record.status)],
    ["Latência total", `${record.latencyTotalMs} ms`],
    ["Latência no gateway", `${record.latencyKongMs} ms`],
    ["Latência no upstream", record.latencyUpstreamMs === null ? "— (não chegou ao upstream)" : `${record.latencyUpstreamMs} ms`],
    ["Cliente", record.clientIp],
    ["Tamanho da requisição", `${record.requestSize} bytes`],
    ["Tamanho da resposta", `${record.responseSize} bytes`],
    ["Service", record.serviceId ?? "—"],
    ["Route", record.routeId ?? "—"],
    ["Consumer", record.consumerId ?? "—"],
    ["Cluster", record.clusterId],
    ["Id", record.id],
  ];
  return (
    <Modal title={`${record.method} ${record.path}`} onClose={onClose}>
      <dl className="props">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt>{k}</dt>
            <dd className="wrap">{v}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  );
}
