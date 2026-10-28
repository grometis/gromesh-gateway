/** ConvergenceEvidence (control-plane-v2): only verified counts as applied. */
export type Evidence = "verified" | "awaiting-status" | "awaiting-probe-report" | "revision-mismatch" | "served-config-divergence" | "kong-hash-divergence" | "revision-regression";

/** What the deployment expects of one node (agent protocol v2, "Applied revision and convergence evidence"). */
export interface ExpectedOfNode {
  clusterId: string;
  nodeId: string;
  /** The open admission the control plane recorded for the node, if any. */
  podUid: string | null;
  admissionId: string | null;
  epoch: number;
  revision: number;
  configHash: string;
  /** Derived by the control plane from the JCS bytes it serves, never learned from a node. */
  kongConfigHash: string;
  lastVerifiedRevision: number;
  revisionRecordedAt: Date;
  now: Date;
}

export interface NodeStatus {
  nodeId: string;
  epoch: number | null;
  appliedRevision: number | null;
  appliedHash: string | null;
  kongConfigHash: string | null;
}

/** The members of a signed probe report this reading needs (verified and stored by the isolation module). */
export interface ProbeEvidence {
  clusterId: string;
  podUid: string;
  admissionId: string;
  state: string;
  servedKongConfigHash?: string | null;
  appliedEpoch?: number | null;
  appliedRevision?: number | null;
  appliedHash?: string | null;
  appliedKongConfigHash?: string | null;
}

export const FRESH_REPORT_MS = 60_000;

/**
 * The reading of the contract's normative vector (contracts/examples/delivery-v2.example.json, evidenceOf of the
 * contract test): the agent's status and a fresh signed report of the node's own admission, both agreeing with the
 * deployment and with the Kong hash the control plane derived.
 */
export function evidenceOf(e: ExpectedOfNode, status: NodeStatus | null, probe: ProbeEvidence | null, receivedAt: Date | null): Evidence {
  if (!status || status.nodeId !== e.nodeId) return "awaiting-status";
  if (status.epoch === e.epoch && status.appliedRevision !== null && status.appliedRevision < e.lastVerifiedRevision) return "revision-regression";
  if (status.epoch !== e.epoch || status.appliedRevision !== e.revision || status.appliedHash !== e.configHash || !status.kongConfigHash) return "awaiting-status";
  const own = !!probe && !!receivedAt && probe.clusterId === e.clusterId && probe.podUid === e.podUid && probe.admissionId === e.admissionId;
  if (!own || receivedAt!.getTime() < e.revisionRecordedAt.getTime() || e.now.getTime() - receivedAt!.getTime() > FRESH_REPORT_MS) return "awaiting-probe-report";
  if (probe.state !== "ok" || probe.appliedEpoch == null) {
    return probe.servedKongConfigHash && probe.servedKongConfigHash !== status.kongConfigHash ? "served-config-divergence" : "awaiting-probe-report";
  }
  const same =
    probe.appliedEpoch === e.epoch &&
    probe.appliedRevision === e.revision &&
    probe.appliedHash === e.configHash &&
    probe.appliedKongConfigHash === status.kongConfigHash &&
    probe.servedKongConfigHash === probe.appliedKongConfigHash;
  if (!same) return "revision-mismatch";
  if (status.kongConfigHash !== e.kongConfigHash) return "kong-hash-divergence";
  return "verified";
}
