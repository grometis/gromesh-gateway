import { useState, type FormEvent } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, unwrap, type Schemas } from "../api/client";
import { statusMessage, toFormErrors, type FormErrors } from "../api/errors";
import { useCanEdit } from "../auth";
import { Field, FormErrorList } from "../components/Field";
import { ConfirmDialog, Modal } from "../components/Modal";
import { useEnvId } from "../components/Shell";
import { splitList, useInvalidateDraft } from "./Services";

type Upstream = Schemas["Upstream"];
type UpstreamWrite = Schemas["UpstreamWrite"];
type Target = Schemas["Target"];
type HashOn = Schemas["HashOn"];
type Algorithm = NonNullable<UpstreamWrite["algorithm"]>;

const ALGORITHMS: Record<Algorithm, string> = {
  "round-robin": "Round-robin",
  "least-connections": "Menos conexões",
  "consistent-hashing": "Hash consistente",
  latency: "Menor latência",
};
const HASH_ON: Record<HashOn, string> = { none: "Nenhum", consumer: "Consumer", ip: "IP do cliente", header: "Header", cookie: "Cookie" };
const FIELDS = ["name", "algorithm", "hashOn", "hashFallback", "hashOnHeader", "hashFallbackHeader", "hashOnCookie", "hashOnCookiePath", "healthchecks", "tags"] as const;

/** Upstream names, also used as suggestions for a service's host. */
export function useUpstreams(envId: string) {
  return useInfiniteQuery({
    queryKey: ["upstreams", envId],
    queryFn: ({ pageParam }) =>
      unwrap(api.GET("/environments/{envId}/upstreams", { params: { path: { envId }, query: pageParam ? { cursor: pageParam } : {} } })),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

function healthSummary(u: Upstream): string {
  const parts = [];
  if (u.healthchecks?.active) parts.push(`ativa (${u.healthchecks.active.type})`);
  if (u.healthchecks?.passive) parts.push("passiva");
  return parts.length > 0 ? parts.join(" + ") : "desligada";
}

export function UpstreamsPage() {
  const envId = useEnvId();
  const canEdit = useCanEdit();
  const upstreams = useUpstreams(envId);
  const [editing, setEditing] = useState<Upstream | "new" | null>(null);
  const [deleting, setDeleting] = useState<Upstream | null>(null);
  const [targets, setTargets] = useState<Upstream | null>(null);
  const items = upstreams.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <section>
      <div className="page-head">
        <h1>Upstreams</h1>
        {canEdit && (
          <button type="button" className="primary" onClick={() => setEditing("new")}>
            Novo upstream
          </button>
        )}
      </div>
      <p className="muted">Um service cujo host é o nome de um upstream balanceia entre os targets dele.</p>
      {upstreams.isPending && <p className="muted">Carregando…</p>}
      {upstreams.isError && <p className="error">{statusMessage(upstreams.error)}</p>}
      {upstreams.isSuccess && items.length === 0 && <p className="muted">Nenhum upstream ainda.</p>}
      {items.length > 0 && (
        <table aria-label="Upstreams">
          <thead>
            <tr>
              <th>Nome</th>
              <th>Algoritmo</th>
              <th>Saúde</th>
              <th aria-label="Ações" />
            </tr>
          </thead>
          <tbody>
            {items.map((u) => (
              <tr key={u.id}>
                <td className="mono">{u.name}</td>
                <td>{ALGORITHMS[u.algorithm]}</td>
                <td>{healthSummary(u)}</td>
                <td className="actions">
                  <button type="button" onClick={() => setTargets(u)}>
                    Targets
                  </button>
                  {canEdit && (
                    <>
                      <button type="button" onClick={() => setEditing(u)}>
                        Editar
                      </button>
                      <button type="button" className="danger" onClick={() => setDeleting(u)}>
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
      {upstreams.hasNextPage && (
        <button type="button" onClick={() => void upstreams.fetchNextPage()} disabled={upstreams.isFetchingNextPage}>
          Carregar mais
        </button>
      )}
      {editing && <UpstreamForm envId={envId} upstream={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {deleting && <DeleteUpstream envId={envId} upstream={deleting} onClose={() => setDeleting(null)} />}
      {targets && (
        <Modal title={`Targets de ${targets.name}`} onClose={() => setTargets(null)} wide>
          <Targets envId={envId} upstream={targets} canEdit={canEdit} />
        </Modal>
      )}
    </section>
  );
}

function UpstreamForm({ envId, upstream, onClose }: { envId: string; upstream: Upstream | null; onClose: () => void }) {
  const invalidate = useInvalidateDraft(envId);
  const active = upstream?.healthchecks?.active;
  const passive = upstream?.healthchecks?.passive;
  const [form, setForm] = useState({
    name: upstream?.name ?? "",
    algorithm: (upstream?.algorithm ?? "round-robin") as Algorithm,
    hashOn: (upstream?.hashOn ?? "none") as HashOn,
    hashFallback: (upstream?.hashFallback ?? "none") as HashOn,
    hashOnHeader: upstream?.hashOnHeader ?? "",
    hashFallbackHeader: upstream?.hashFallbackHeader ?? "",
    hashOnCookie: upstream?.hashOnCookie ?? "",
    hashOnCookiePath: upstream?.hashOnCookiePath ?? "/",
    activeOn: Boolean(active),
    activeType: (active?.type ?? "http") as "http" | "https" | "tcp",
    httpPath: active?.httpPath ?? "/",
    intervalSeconds: String(active?.intervalSeconds ?? 10),
    healthyThreshold: String(active?.healthyThreshold ?? 2),
    unhealthyThreshold: String(active?.unhealthyThreshold ?? 3),
    timeoutSeconds: String(active?.timeoutSeconds ?? 1),
    passiveOn: Boolean(passive),
    unhealthyHttpFailures: String(passive?.unhealthyHttpFailures ?? 5),
    unhealthyTimeouts: String(passive?.unhealthyTimeouts ?? 3),
    tags: (upstream?.tags ?? []).join(", "),
  });
  const [errors, setErrors] = useState<FormErrors>({ fields: {}, form: [] });
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const hashing = form.algorithm === "consistent-hashing";

  const save = useMutation({
    mutationFn: () => {
      const body: UpstreamWrite = {
        name: form.name.trim(),
        algorithm: form.algorithm,
        // Defaults of the contract are sent explicitly; the server ignores hashing unless consistent-hashing.
        hashOn: hashing ? form.hashOn : "none",
        hashFallback: hashing && form.hashOn !== "cookie" ? form.hashFallback : "none",
        hashOnCookiePath: form.hashOnCookiePath.trim() || "/",
        ...(hashing && form.hashOn === "header" ? { hashOnHeader: form.hashOnHeader.trim() } : {}),
        ...(hashing && form.hashOn !== "cookie" && form.hashFallback === "header" ? { hashFallbackHeader: form.hashFallbackHeader.trim() } : {}),
        ...(hashing && form.hashOn === "cookie" ? { hashOnCookie: form.hashOnCookie.trim() } : {}),
        healthchecks: {
          active: form.activeOn
            ? {
                type: form.activeType,
                // Ignored by tcp checks.
                httpPath: form.httpPath.trim() || "/",
                intervalSeconds: Number(form.intervalSeconds),
                healthyThreshold: Number(form.healthyThreshold),
                unhealthyThreshold: Number(form.unhealthyThreshold),
                timeoutSeconds: Number(form.timeoutSeconds),
              }
            : null,
          passive: form.passiveOn ? { unhealthyHttpFailures: Number(form.unhealthyHttpFailures), unhealthyTimeouts: Number(form.unhealthyTimeouts) } : null,
        },
        tags: splitList(form.tags),
      };
      return upstream
        ? unwrap(api.PUT("/environments/{envId}/upstreams/{upstreamId}", { params: { path: { envId, upstreamId: upstream.id } }, body }))
        : unwrap(api.POST("/environments/{envId}/upstreams", { params: { path: { envId } }, body }));
    },
    onSuccess: () => {
      invalidate("upstreams");
      onClose();
    },
    onError: (err) => setErrors(toFormErrors(err, FIELDS)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setErrors({ fields: {}, form: [] });
    save.mutate();
  };
  const hashSelect = (label: string, key: "hashOn" | "hashFallback", options: HashOn[]) => (
    <Field label={label} errors={errors.fields[key]}>
      {(id) => (
        <select id={id} value={form[key]} onChange={(e) => set(key, e.target.value as HashOn)}>
          {options.map((h) => (
            <option key={h} value={h}>
              {HASH_ON[h]}
            </option>
          ))}
        </select>
      )}
    </Field>
  );

  return (
    <Modal title={upstream ? `Editar ${upstream.name}` : "Novo upstream"} onClose={onClose} wide>
      <form onSubmit={submit} className="form" noValidate>
        <Field label="Nome" errors={errors.fields.name} hint="Hostname em minúsculas; use este nome como host dos services">
          {(id, invalid) => <input id={id} aria-invalid={invalid} value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="orders.upstream" />}
        </Field>
        <Field label="Algoritmo" errors={errors.fields.algorithm}>
          {(id) => (
            <select id={id} value={form.algorithm} onChange={(e) => set("algorithm", e.target.value as Algorithm)}>
              {(Object.keys(ALGORITHMS) as Algorithm[]).map((a) => (
                <option key={a} value={a}>
                  {ALGORITHMS[a]}
                </option>
              ))}
            </select>
          )}
        </Field>
        {hashing && (
          <fieldset>
            <legend>Hash</legend>
            <div className="row">
              {hashSelect("Hash por", "hashOn", ["none", "consumer", "ip", "header", "cookie"])}
              {form.hashOn !== "cookie" && hashSelect("Alternativa", "hashFallback", ["none", "consumer", "ip", "header"])}
            </div>
            {form.hashOn === "header" && (
              <Field label="Header do hash" errors={errors.fields.hashOnHeader}>
                {(id, invalid) => <input id={id} aria-invalid={invalid} value={form.hashOnHeader} onChange={(e) => set("hashOnHeader", e.target.value)} />}
              </Field>
            )}
            {form.hashOn !== "cookie" && form.hashFallback === "header" && (
              <Field label="Header da alternativa" errors={errors.fields.hashFallbackHeader}>
                {(id, invalid) => <input id={id} aria-invalid={invalid} value={form.hashFallbackHeader} onChange={(e) => set("hashFallbackHeader", e.target.value)} />}
              </Field>
            )}
            {form.hashOn === "cookie" && (
              <div className="row">
                <Field label="Cookie" errors={errors.fields.hashOnCookie}>
                  {(id, invalid) => <input id={id} aria-invalid={invalid} value={form.hashOnCookie} onChange={(e) => set("hashOnCookie", e.target.value)} />}
                </Field>
                <Field label="Path do cookie" errors={errors.fields.hashOnCookiePath}>
                  {(id, invalid) => <input id={id} aria-invalid={invalid} value={form.hashOnCookiePath} onChange={(e) => set("hashOnCookiePath", e.target.value)} />}
                </Field>
              </div>
            )}
          </fieldset>
        )}
        <fieldset>
          <legend>Saúde dos targets</legend>
          <label className="check">
            <input type="checkbox" checked={form.activeOn} onChange={(e) => set("activeOn", e.target.checked)} /> Verificação ativa
          </label>
          {form.activeOn && (
            <>
              <div className="row">
                <Field label="Tipo">
                  {(id) => (
                    <select id={id} value={form.activeType} onChange={(e) => set("activeType", e.target.value as "http" | "https" | "tcp")}>
                      <option value="http">http</option>
                      <option value="https">https</option>
                      <option value="tcp">tcp</option>
                    </select>
                  )}
                </Field>
                {form.activeType !== "tcp" && (
                  <Field label="Path verificado">
                    {(id) => <input id={id} value={form.httpPath} onChange={(e) => set("httpPath", e.target.value)} />}
                  </Field>
                )}
                <Field label="Intervalo (s)">
                  {(id) => <input id={id} inputMode="numeric" value={form.intervalSeconds} onChange={(e) => set("intervalSeconds", e.target.value)} />}
                </Field>
              </div>
              <div className="row">
                <Field label="Sucessos para saudável">
                  {(id) => <input id={id} inputMode="numeric" value={form.healthyThreshold} onChange={(e) => set("healthyThreshold", e.target.value)} />}
                </Field>
                <Field label="Falhas para não saudável">
                  {(id) => <input id={id} inputMode="numeric" value={form.unhealthyThreshold} onChange={(e) => set("unhealthyThreshold", e.target.value)} />}
                </Field>
                <Field label="Timeout (s)">
                  {(id) => <input id={id} inputMode="decimal" value={form.timeoutSeconds} onChange={(e) => set("timeoutSeconds", e.target.value)} />}
                </Field>
              </div>
            </>
          )}
          <label className="check">
            <input type="checkbox" checked={form.passiveOn} onChange={(e) => set("passiveOn", e.target.checked)} /> Verificação passiva (pelo tráfego)
          </label>
          {form.passiveOn && (
            <div className="row">
              <Field label="Respostas 5xx para não saudável">
                {(id) => <input id={id} inputMode="numeric" value={form.unhealthyHttpFailures} onChange={(e) => set("unhealthyHttpFailures", e.target.value)} />}
              </Field>
              <Field label="Timeouts para não saudável">
                {(id) => <input id={id} inputMode="numeric" value={form.unhealthyTimeouts} onChange={(e) => set("unhealthyTimeouts", e.target.value)} />}
              </Field>
            </div>
          )}
          {errors.fields.healthchecks && <FormErrorList messages={errors.fields.healthchecks} />}
        </fieldset>
        <Field label="Tags" errors={errors.fields.tags} hint="Separadas por vírgula">
          {(id, invalid) => <input id={id} aria-invalid={invalid} value={form.tags} onChange={(e) => set("tags", e.target.value)} />}
        </Field>
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

function DeleteUpstream({ envId, upstream, onClose }: { envId: string; upstream: Upstream; onClose: () => void }) {
  const invalidate = useInvalidateDraft(envId);
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE("/environments/{envId}/upstreams/{upstreamId}", { params: { path: { envId, upstreamId: upstream.id } } })),
    onSuccess: () => {
      invalidate("upstreams");
      onClose();
    },
  });
  return (
    <ConfirmDialog
      title="Excluir upstream"
      message={
        <>
          Excluir <strong>{upstream.name}</strong> e seus targets? Não é possível enquanto algum service usa este nome como host.
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

function Targets({ envId, upstream, canEdit }: { envId: string; upstream: Upstream; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateDraft(envId);
  const key = ["targets", envId, upstream.id];
  const targets = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/environments/{envId}/upstreams/{upstreamId}/targets", {
          params: { path: { envId, upstreamId: upstream.id }, query: pageParam ? { cursor: pageParam } : {} },
        }),
      ),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const items = targets.data?.pages.flatMap((p) => p.items) ?? [];
  const [form, setForm] = useState({ target: "", weight: "100" });
  const [errors, setErrors] = useState<FormErrors>({ fields: {}, form: [] });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: key });
    invalidate();
  };

  const add = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/environments/{envId}/upstreams/{upstreamId}/targets", {
          params: { path: { envId, upstreamId: upstream.id } },
          body: { target: form.target.trim(), weight: Number(form.weight) },
        }),
      ),
    onSuccess: () => {
      setForm({ target: "", weight: "100" });
      setErrors({ fields: {}, form: [] });
      refresh();
    },
    onError: (err) => setErrors(toFormErrors(err, ["target", "weight"])),
  });
  const reweigh = useMutation({
    mutationFn: ({ t, weight }: { t: Target; weight: number }) =>
      unwrap(
        api.PUT("/environments/{envId}/upstreams/{upstreamId}/targets/{targetId}", {
          params: { path: { envId, upstreamId: upstream.id, targetId: t.id } },
          body: { target: t.target, weight, tags: t.tags },
        }),
      ),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (t: Target) =>
      unwrap(api.DELETE("/environments/{envId}/upstreams/{upstreamId}/targets/{targetId}", { params: { path: { envId, upstreamId: upstream.id, targetId: t.id } } })),
    onSuccess: refresh,
  });

  return (
    <div>
      {targets.isPending && <p className="muted">Carregando…</p>}
      {targets.isError && <p className="error">{statusMessage(targets.error)}</p>}
      {targets.isSuccess && items.length === 0 && <p className="muted">Nenhum target: o tráfego deste upstream não tem destino.</p>}
      {items.length > 0 && (
        <table aria-label="Targets">
          <thead>
            <tr>
              <th>Target</th>
              <th>Peso</th>
              <th aria-label="Ações" />
            </tr>
          </thead>
          <tbody>
            {items.map((t) => (
              <tr key={t.id}>
                <td className="mono">{t.target}</td>
                <td>
                  {canEdit ? (
                    <input
                      aria-label={`Peso de ${t.target}`}
                      inputMode="numeric"
                      defaultValue={t.weight}
                      onBlur={(e) => {
                        const weight = Number(e.target.value);
                        if (weight !== t.weight && Number.isInteger(weight)) reweigh.mutate({ t, weight });
                      }}
                    />
                  ) : (
                    t.weight
                  )}
                  {t.weight === 0 && <span className="muted"> fora do balanceamento</span>}
                </td>
                <td className="actions">
                  {canEdit && (
                    <button type="button" className="danger" onClick={() => remove.mutate(t)}>
                      Remover
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {(reweigh.isError || remove.isError) && <p className="error">{statusMessage(reweigh.error ?? remove.error)}</p>}
      {canEdit && (
        <form
          className="form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <div className="row">
            <Field label="Novo target" errors={errors.fields.target} hint="host:porta, IPv6 entre colchetes">
              {(id, invalid) => <input id={id} aria-invalid={invalid} value={form.target} onChange={(e) => setForm((f) => ({ ...f, target: e.target.value }))} placeholder="10.0.0.11:8080" />}
            </Field>
            <Field label="Peso" errors={errors.fields.weight} hint="0 a 65535; 0 tira do balanceamento">
              {(id, invalid) => <input id={id} aria-invalid={invalid} inputMode="numeric" value={form.weight} onChange={(e) => setForm((f) => ({ ...f, weight: e.target.value }))} />}
            </Field>
          </div>
          <FormErrorList messages={errors.form} />
          <div className="form-actions">
            <button type="submit" className="primary" disabled={add.isPending}>
              {add.isPending ? "Adicionando…" : "Adicionar target"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
