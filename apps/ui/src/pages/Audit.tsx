import { useState, type FormEvent } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { operations } from "../api/schema";
import { api, unwrap } from "../api/client";
import { toFormErrors } from "../api/errors";
import { BeforeAfter } from "../components/Diff";
import { Field, FormErrorList } from "../components/Field";

const FIELDS = ["environmentId", "actorId", "entityType", "from", "to", "limit"] as const;
const ACTOR_LABEL = { user: "Usuário", system: "Sistema", agent: "Agente" } as const;
const EMPTY_FILTERS = { environmentId: "", actorId: "", entityType: "", from: "", to: "", limit: "50" };
type AuditQuery = NonNullable<operations["listAuditEvents"]["parameters"]["query"]>;

export function AuditPage() {
  const [form, setForm] = useState(EMPTY_FILTERS);
  const [query, setQuery] = useState<AuditQuery>({ limit: 50 });
  const [rangeError, setRangeError] = useState<string | null>(null);
  const events = useInfiniteQuery({
    queryKey: ["audit-events", query],
    queryFn: ({ pageParam }) => unwrap(api.GET("/audit-events", { params: { query: { ...query, ...(pageParam ? { cursor: pageParam } : {}) } } })),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const errors = events.isError ? toFormErrors(events.error, FIELDS) : { fields: {}, form: [] };
  const items = events.data?.pages.flatMap((page) => page.items) ?? [];
  const set = (field: keyof typeof form, value: string) => setForm((previous) => ({ ...previous, [field]: value }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const from = form.from ? new Date(form.from) : null;
    const to = form.to ? new Date(form.to) : null;
    if ((from && !Number.isFinite(from.getTime())) || (to && !Number.isFinite(to.getTime())) || (from && to && from > to)) {
      setRangeError("Informe um período válido, com a data final igual ou posterior à inicial.");
      return;
    }
    setRangeError(null);
    setQuery({
      limit: Number(form.limit),
      ...(form.environmentId.trim() ? { environmentId: form.environmentId.trim() } : {}),
      ...(form.actorId.trim() ? { actorId: form.actorId.trim() } : {}),
      ...(form.entityType.trim() ? { entityType: form.entityType.trim() } : {}),
      ...(from ? { from: from.toISOString() } : {}),
      ...(to ? { to: to.toISOString() } : {}),
    });
  };
  const clear = () => {
    setForm(EMPTY_FILTERS);
    setQuery({ limit: 50 });
    setRangeError(null);
  };

  return (
    <section className="stack">
      <div className="page-head">
        <h1>Auditoria</h1>
      </div>
      <form onSubmit={submit} className="audit-filters" aria-label="Filtros de auditoria">
        <Field label="ID do environment" errors={errors.fields.environmentId}>
          {(id, invalid) => (
            <input id={id} aria-invalid={invalid} value={form.environmentId} onChange={(event) => set("environmentId", event.target.value)} />
          )}
        </Field>
        <Field label="ID do autor" errors={errors.fields.actorId}>
          {(id, invalid) => (
            <input id={id} aria-invalid={invalid} value={form.actorId} onChange={(event) => set("actorId", event.target.value)} />
          )}
        </Field>
        <Field label="Tipo de entidade" errors={errors.fields.entityType}>
          {(id, invalid) => (
            <input id={id} aria-invalid={invalid} value={form.entityType} onChange={(event) => set("entityType", event.target.value)} placeholder="snapshot, service, user…" />
          )}
        </Field>
        <Field label="De" errors={errors.fields.from} hint="Horário local">
          {(id, invalid) => (
            <input id={id} type="datetime-local" aria-invalid={invalid} value={form.from} onChange={(event) => set("from", event.target.value)} />
          )}
        </Field>
        <Field label="Até" errors={errors.fields.to} hint="Horário local">
          {(id, invalid) => (
            <input id={id} type="datetime-local" aria-invalid={invalid} value={form.to} onChange={(event) => set("to", event.target.value)} />
          )}
        </Field>
        <Field label="Eventos por página" errors={errors.fields.limit}>
          {(id, invalid) => (
            <select id={id} aria-invalid={invalid} value={form.limit} onChange={(event) => set("limit", event.target.value)}>
              {[25, 50, 100, 200].map((limit) => (
                <option key={limit} value={limit}>{limit}</option>
              ))}
            </select>
          )}
        </Field>
        <div className="form-actions audit-filter-actions">
          <button type="button" onClick={clear}>
            Limpar filtros
          </button>
          <button type="submit" className="primary">
            Filtrar
          </button>
        </div>
      </form>
      {rangeError && <p className="error" role="alert">{rangeError}</p>}
      <FormErrorList messages={errors.form} />
      {events.isPending && <p className="muted">Carregando…</p>}
      {events.isSuccess && items.length === 0 && <p className="muted">Nenhum evento encontrado.</p>}
      {items.map((event) => (
        <article className="audit-event stack" key={event.id} aria-label={`${event.action} por ${event.actor.name ?? event.actor.id}`}>
          <header className="audit-event-head">
            <h2>{event.action}</h2>
            <time dateTime={event.at}>{new Date(event.at).toLocaleString("pt-BR")}</time>
          </header>
          <dl className="props">
            <dt>Autor</dt>
            <dd className="wrap">{event.actor.name ?? event.actor.id} ({ACTOR_LABEL[event.actor.type]}) · {event.actor.id}</dd>
            <dt>Entidade</dt>
            <dd className="wrap">{event.entityType} · {event.entityId ?? "—"}</dd>
            <dt>Environment</dt>
            <dd className="wrap">{event.environmentId ?? "—"}</dd>
            <dt>IP</dt>
            <dd>{event.ip ?? "—"}</dd>
          </dl>
          <BeforeAfter before={event.before} after={event.after} />
        </article>
      ))}
      {events.hasNextPage && (
        <button type="button" disabled={events.isFetchingNextPage} onClick={() => void events.fetchNextPage()}>
          Carregar mais
        </button>
      )}
    </section>
  );
}
