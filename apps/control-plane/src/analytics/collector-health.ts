import type { Executor } from "../db/db.js";
import { clusterNodes, type ClusterNodeRow } from "../db/schema.js";

export type HealthState = "healthy" | "idle" | "degraded" | "unknown";
export interface AnalyticsHealth {
  state: HealthState;
  reasons: string[];
  observedAt: string;
  windowSeconds: number;
  windowComplete: boolean;
  collectorReachable: boolean;
  collectorStartedAt?: string | null;
  kongRequests: number | null;
  received: number | null;
  delivered: number | null;
  deliveryErrors: number | null;
  authRefusals: number | null;
  buffered: number | null;
  bufferCapacity: number | null;
  lastReceivedAt?: string | null;
  lastDeliveredAt?: string | null;
}
export interface CollectorTokenFingerprints { current: string; previous: string | null }

/** The normative healthOf reading. Schema validation alone cannot enforce the counter-dependent reasons. */
export function healthOf(h: AnalyticsHealth): { state: HealthState; reasons: string[] } {
  const reasons: string[] = [];
  if (!h.collectorReachable) reasons.push("collector-unreachable");
  else {
    if (h.received !== null && h.delivered !== null && h.received > 0
      && (h.delivered < h.received / 2 || ((h.deliveryErrors ?? 0) > 0 && h.delivered < h.received))) reasons.push("delivery-failing");
    if (h.buffered !== null && h.bufferCapacity !== null && h.buffered >= h.bufferCapacity / 2) reasons.push("backlog");
    if (h.kongRequests !== null && h.received !== null && h.kongRequests >= 20 && h.received < h.kongRequests / 2) reasons.push("events-missing");
    if ((h.authRefusals ?? 0) > 0) reasons.push("auth-refusals");
  }
  const unread = [h.kongRequests, h.received, h.delivered, h.deliveryErrors, h.authRefusals, h.buffered, h.bufferCapacity].some((n) => n === null);
  const state: HealthState = reasons.length ? "degraded"
    : !h.windowComplete || unread ? "unknown"
    : h.kongRequests === 0 && h.received === 0 ? "idle"
    : h.received === 0 || h.delivered === 0 ? "unknown" : "healthy";
  return { state, reasons };
}

export function clusterHealth(nodes: ClusterNodeRow[], now: Date) {
  const items = nodes.map((n) => {
    const h = n.analyticsHealth;
    const fresh = h !== null && n.analyticsReceivedAt !== null && now.getTime() - n.analyticsReceivedAt.getTime() <= 60_000;
    return {
      nodeId: n.nodeId,
      state: fresh ? h.state : "unknown" as HealthState,
      reasons: fresh ? h.reasons : [],
      observedAt: h?.observedAt ?? null,
      collectorTokenKeyHint: n.collectorTokenFingerprints?.current.slice(7, 15) ?? null,
    };
  });
  const state: HealthState = items.some((n) => n.state === "degraded") ? "degraded"
    : !items.length || items.some((n) => n.state === "unknown") ? "unknown"
    : items.every((n) => n.state === "idle") ? "idle" : "healthy";
  return { state, nodes: items };
}

/** Fingerprint display is independent of health; only reports received in the last 45s count, across clusters. */
export async function clusterAnalytics(tx: Executor, clusterId: string, now: Date) {
  const all = await tx.select().from(clusterNodes);
  const online = all.filter((n) => n.reportedAt !== null && now.getTime() - n.reportedAt.getTime() <= 45_000);
  const own = online.filter((n) => n.clusterId === clusterId);
  const foreign = online.filter((n) => n.clusterId !== clusterId && n.collectorTokenFingerprints !== null);
  let shared = false;
  let rotating = false;
  for (const n of own) for (const other of foreign) {
    const a = n.collectorTokenFingerprints;
    const b = other.collectorTokenFingerprints!;
    if (!a) continue;
    if (a.current === b.current) shared = true;
    if (a.current === b.previous || a.previous === b.current || (a.previous !== null && a.previous === b.previous)) rotating = true;
  }
  return {
    ...clusterHealth(all.filter((n) => n.clusterId === clusterId), now),
    collectorTokenShared: shared,
    collectorTokenUnverified: own.some((n) => !n.collectorTokenFingerprints),
    collectorTokenRotating: !shared && rotating,
  };
}
