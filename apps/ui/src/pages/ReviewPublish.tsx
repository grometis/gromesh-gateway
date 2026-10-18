import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router";
import { api, unwrap, type Schemas } from "../api/client";
import { statusMessage, toFormErrors } from "../api/errors";
import { useCanEdit } from "../auth";
import { DraftBadge, Badge } from "../components/Badge";
import { changeTitle } from "../components/Diff";
import { useEnvId, useEnvironment } from "../components/Shell";

type EntityChange = Schemas["EntityChange"];

/** Nested objects become dotted fields, so a change inside `config` shows up as its own row. */
function flatten(value: unknown, prefix = "", out: Record<string, string> = {}): Record<string, string> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (prefix) {
    out[prefix] = JSON.stringify(value);
  }
  return out;
}

/** Field by field, live version × draft: changed fields stand out, equal ones stay grey. */
function FieldDiff({ change, current }: { change: EntityChange; current: number | null }) {
  const before = flatten(change.before ?? {});
  const after = flatten(change.after ?? {});
  // The id is the same on both sides by definition: it only adds noise.
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((f) => f !== "id").sort();
  const changed = fields.filter((f) => before[f] !== after[f]).length;
  return (
    <section className="field-diff" aria-label={`Diff de ${changeTitle(change)}`}>
      <h2 className="title-with-badges">
        {changeTitle(change)} <ChangeBadge change={change.change} />
      </h2>
      <p className="muted">
        {change.change === "added"
          ? "Não existe na versão no ar."
          : change.change === "removed"
            ? "Sai do gateway quando você publicar."
            : `${changed} ${changed === 1 ? "campo alterado" : "campos alterados"}`}
      </p>
      <div className="table-scroll diff-wide">
        <table className="diff-fields">
          <thead>
            <tr>
              <th scope="col">Campo</th>
              <th scope="col">{current === null ? "No ar" : `v${current} (no ar)`}</th>
              <th scope="col">Rascunho</th>
            </tr>
          </thead>
          <tbody>
            {fields.map((f) => {
              const differs = before[f] !== after[f];
              return (
                <tr key={f} className={differs ? "changed" : "same"} data-field-changed={differs || undefined}>
                  <th scope="row" className="mono">
                    {f}
                  </th>
                  <td className="mono before">{differs && before[f] !== undefined ? <del>{before[f]}</del> : (before[f] ?? "—")}</td>
                  <td className="mono after">{differs && after[f] !== undefined ? <ins>{after[f]}</ins> : (after[f] ?? "—")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {/* Phones: only the changed fields, as "campo: antes → depois". */}
      <ul className="diff-narrow" aria-label="Campos alterados">
        {fields
          .filter((f) => before[f] !== after[f])
          .map((f) => (
            <li key={f}>
              <span className="mono field">{f}:</span>{" "}
              {before[f] !== undefined && (
                <del className="mono">{before[f]}</del>
              )}
              {before[f] !== undefined && after[f] !== undefined && <span aria-hidden="true"> → </span>}
              {after[f] !== undefined && <ins className="mono">{after[f]}</ins>}
            </li>
          ))}
      </ul>
    </section>
  );
}

function ChangeBadge({ change }: { change: EntityChange["change"] }) {
  return change === "removed" ? <Badge tone="removed">Removido</Badge> : <DraftBadge change={change} />;
}

/** What the next version changes, entity by entity, and the action that publishes it. */
export function ReviewPublishPage() {
  const envId = useEnvId();
  const env = useEnvironment(envId);
  const canEdit = useCanEdit();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState(0);
  const [message, setMessage] = useState("");
  const preview = useQuery({
    queryKey: ["preview", envId],
    queryFn: () => unwrap(api.GET("/environments/{envId}/publish-preview", { params: { path: { envId } } })),
  });
  const current = env.data?.currentVersion ?? null;
  const publish = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/environments/{envId}/snapshots", {
          params: { path: { envId } },
          body: { ...(message.trim() ? { message: message.trim() } : {}), expectedCurrentVersion: current },
        }),
      ),
    onSuccess: () => {
      for (const key of ["environment", "preview", "clusters", "snapshots"]) void queryClient.invalidateQueries({ queryKey: [key, envId] });
      navigate(`/e/${envId}/publications`);
    },
  });
  const changes = preview.data?.changes ?? [];
  const active = changes[Math.min(selected, changes.length - 1)];
  const issues = preview.isError ? toFormErrors(preview.error, []) : null;

  return (
    <section aria-label="Revisar e publicar">
      <div className="page-head">
        <div>
          <h1>Revisar e publicar</h1>
          <p className="lede">
            O que muda quando o rascunho virar <span className="mono">v{(current ?? 0) + 1}</span>
            {current !== null && (
              <>
                , comparado com a versão no ar <span className="mono">v{current}</span>
              </>
            )}
            .
          </p>
        </div>
      </div>
      {preview.isPending && <p className="muted">Calculando as alterações…</p>}
      {issues && (
        <div className="error" role="alert">
          <p>O rascunho não pode ser publicado:</p>
          <ul>
            {issues.form.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}
      {preview.data && !preview.data.hasChanges && <p className="muted">Nada a publicar: o rascunho é igual à versão no ar.</p>}
      {changes.length > 0 && (
        <div className="review">
          <ul className="review-list" aria-label="Alterações">
            {changes.map((c, i) => (
              <li key={`${c.kind}:${c.id}`} data-change={c.change}>
                <button type="button" aria-current={c === active ? "true" : undefined} onClick={() => setSelected(i)}>
                  <ChangeBadge change={c.change} />
                  <span>
                    <strong>{changeTitle(c)}</strong>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="review-detail">{active && <FieldDiff change={active} current={current} />}</div>
        </div>
      )}
      {changes.length > 0 && (
        <p className="note">
          Segredos aparecem como <span className="mono">REDACTED</span>: o valor real nunca sai do control plane, a não ser para o gateway.
        </p>
      )}
      {canEdit && preview.data?.hasChanges && (
        <div className="publish-box">
          <label className="field">
            <span>Mensagem (opcional)</span>
            <input value={message} maxLength={500} onChange={(e) => setMessage(e.target.value)} placeholder="O que muda nesta versão?" />
          </label>
          <button type="button" className="publish" disabled={publish.isPending} onClick={() => publish.mutate()}>
            {publish.isPending ? "Publicando…" : `Publicar v${(current ?? 0) + 1}`}
          </button>
          <p className="muted">
            Se algo der errado, restaure uma versão anterior em <Link to={`/e/${envId}/publications`}>Publicações</Link>: o rollback publica uma
            nova versão com o conteúdo antigo.
          </p>
          {publish.isError && (
            <p className="error" role="alert">
              {statusMessage(publish.error)}
            </p>
          )}
        </div>
      )}
      {!canEdit && preview.data?.hasChanges && <p className="muted">Só quem edita este environment pode publicar.</p>}
    </section>
  );
}
