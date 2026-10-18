import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "../api/client";
import { useCanEdit } from "../auth";
import { PublishModal } from "./PublishModal";
import { useEnvironment } from "./Shell";

/**
 * Draft → publish → live, always visible on the environment's screens: what is pending, the action that ships it,
 * and how many online nodes already run the live version.
 */
export function PublishStrip({ envId }: { envId: string }) {
  const env = useEnvironment(envId);
  const canEdit = useCanEdit();
  const [open, setOpen] = useState(false);
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
  const dot = nodes.length === 0 ? "none" : synced === nodes.length ? "" : "partial";
  // Not only the dot's colour: a rollout that has not reached every node says so in words.
  const lagging = nodes.length > 0 && synced < nodes.length;
  const state = !lagging ? null : (clusters.data?.items ?? []).some((c) => c.status === "degraded") ? "degradado" : "convergindo";

  return (
    <section className={canEdit ? "publish-strip" : "publish-strip read-only"} aria-label="Publicação">
      <div className={pending ? "strip-draft" : "strip-draft clean"} aria-live="polite">
        <strong>Rascunho</strong>
        <span className="sep" aria-hidden="true">·</span>
        <span>{!pending ? "sem alterações" : count === undefined ? "alterações não publicadas" : `${count} ${count === 1 ? "alteração" : "alterações"}`}</span>
        {pending && (
          <>
            <span className="sep" aria-hidden="true">·</span>
            <button type="button" className="link" onClick={() => setOpen(true)}>
              Ver diff
            </button>
          </>
        )}
      </div>
      {canEdit && (
        <button type="button" className="publish" disabled={!pending} onClick={() => setOpen(true)}>
          Publicar v{(current ?? 0) + 1}
          <span aria-hidden="true">→</span>
        </button>
      )}
      <div className="strip-live">
        <span className={`dot ${dot}`} aria-hidden="true" />
        <strong>No ar</strong>
        <span className="sep" aria-hidden="true">·</span>
        {current === null ? (
          <span>nada publicado</span>
        ) : (
          <>
            <span className="mono">v{current}</span>
            <span className="sep" aria-hidden="true">·</span>
            <span>
              <span className="mono">
                {synced}/{nodes.length}
              </span>{" "}
              {nodes.length === 1 ? "nó" : "nós"}
            </span>
            {state && (
              <>
                <span className="sep" aria-hidden="true">·</span>
                <strong className={`strip-state ${state === "degradado" ? "bad" : ""}`}>{state}</strong>
              </>
            )}
          </>
        )}
      </div>
      {open && <PublishModal env={env.data} readOnly={!canEdit} onClose={() => setOpen(false)} />}
    </section>
  );
}
