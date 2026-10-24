import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "../api/client";
import { useCanEdit } from "../auth";
import { Link, useNavigate } from "react-router";
import { useEnvironment } from "./Shell";

/**
 * Draft → publish → live, always visible on the environment's screens: what is pending, the action that ships it,
 * and how many online nodes already run the live version.
 */
export function PublishStrip({ envId }: { envId: string }) {
  const env = useEnvironment(envId);
  const canEdit = useCanEdit();
  const navigate = useNavigate();
  const review = () => navigate(`/e/${envId}/publish`);
  const pending = env.data?.hasUnpublishedChanges ?? false;
  const preview = useQuery({
    queryKey: ["preview", envId],
    queryFn: () => unwrap(api.GET("/environments/{envId}/publish-preview", { params: { path: { envId } } })),
    enabled: pending,
  });
  const clusters = useQuery({
    queryKey: ["clusters", envId],
    queryFn: () => unwrap(api.GET("/environments/{envId}/clusters", { params: { path: { envId } } })),
    staleTime: 10_000,
    // Follows a rollout while it happens; otherwise the cache (shared with the Clusters screen) is enough.
    refetchInterval: (query) => (query.state.data?.items.some((c) => c.status === "converging") ? 10_000 : false),
  });
  if (!env.data) return null;

  const current = env.data.currentVersion;
  const count = preview.data?.changes.length;
  const nodes = (clusters.data?.items ?? []).flatMap((c) => c.nodes).filter((n) => n.online);
  const synced = nodes.filter((n) => current !== null && n.appliedVersion === current).length;
  // The dot's colour and, when not every node is there, the same state in words.
  const live: "ok" | "converging" | "degraded" | "none" =
    nodes.length === 0 ? "none" : synced === nodes.length ? "ok" : (clusters.data?.items ?? []).some((c) => c.status === "degraded") ? "degraded" : "converging";
  const state = live === "degraded" ? "degradado" : live === "converging" ? "convergindo" : null;

  return (
    <section className={canEdit ? "publish-strip" : "publish-strip read-only"} aria-label="Publicação">
      <div className={pending ? "strip-draft" : "strip-draft clean"} aria-live="polite">
        <strong>Rascunho</strong>
        <span className="sep" aria-hidden="true">·</span>
        <span>{!pending ? "sem alterações" : count === undefined ? "alterações não publicadas" : `${count} ${count === 1 ? "alteração" : "alterações"}`}</span>
        {pending && (
          <>
            <span className="sep" aria-hidden="true">·</span>
            <Link to={`/e/${envId}/publish`} className="strip-link">
              Ver diff
            </Link>
          </>
        )}
      </div>
      {canEdit && (
        <button type="button" className="publish" disabled={!pending} onClick={review}>
          {pending ? (
            <>
              Publicar v{(current ?? 0) + 1}
              <span aria-hidden="true">→</span>
            </>
          ) : (
            "Nada para publicar"
          )}
        </button>
      )}
      <div className="strip-live">
        <span className={`dot ${live}`} data-state={live} aria-hidden="true" />
        <strong>No ar</strong>
        <span className="sep" aria-hidden="true">·</span>
        {current === null ? (
          <span>nada publicado</span>
        ) : (
          <>
            <span className="mono">v{current}</span>
            <span className="sep" aria-hidden="true">·</span>
            {nodes.length === 0 ? (
              <span>nenhum nó online</span>
            ) : (
              <span>
                <span className="mono">
                  {synced}/{nodes.length}
                </span>{" "}
                {nodes.length === 1 ? "nó" : "nós"}
              </span>
            )}
            {state && (
              <>
                <span className="sep" aria-hidden="true">·</span>
                <strong className={`strip-state ${state === "degradado" ? "bad" : ""}`}>{state}</strong>
              </>
            )}
          </>
        )}
      </div>
      {env.data.autoPublishPausedReason === "import" && (
        <p className="strip-notice" role="note">
          Publicação automática pausada após importação — publique para retomar.
        </p>
      )}
      {env.data.autoPublishPausedReason === "privileged" && (
        <p className="strip-notice" role="note">
          Publicação automática pausada: há plugin que executa código no gateway — só o administrador da plataforma publica.
        </p>
      )}
    </section>
  );
}
