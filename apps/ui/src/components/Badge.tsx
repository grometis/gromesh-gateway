import type { ReactNode } from "react";

/** NOVO / ALTERADO mark unpublished entities; the other tones mirror the cluster and diff states. */
export type BadgeTone = "new" | "changed" | "added" | "removed" | "modified" | "converged" | "converging" | "degraded" | "no-nodes" | "warning" | "danger";

export function Badge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

/** The draft state of one entity, from the publish preview. */
export function DraftBadge({ change }: { change: "added" | "modified" | undefined }) {
  if (change === "added") return <Badge tone="new">Novo</Badge>;
  if (change === "modified") return <Badge tone="changed">Alterado</Badge>;
  return null;
}
