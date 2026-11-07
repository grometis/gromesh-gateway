import { useQuery } from "@tanstack/react-query";
import { creationPolicyQuery } from "../api/client-v2";
import { useAuth } from "../auth";

const STAGES = { dev: "DEV", hml: "HML", prd: "PRD" } as const;

/** The origin is navigational identity only; it never supplies a stage. */
export function InstanceOrigin() {
  return <span className="instance-origin">{typeof window === "undefined" ? "Origem indisponível" : window.location.origin}</span>;
}

export function InstanceContext({ label: regionLabel = "Identidade da instância", compact = false }: { label?: string; compact?: boolean }) {
  const { user } = useAuth();
  const policy = useQuery({ ...creationPolicyQuery, enabled: !!user, retry: false });
  // A cached response must not keep claiming a stage during a failed or pending revalidation.
  const stage = user && policy.isSuccess && policy.fetchStatus === "idle" ? policy.data.stage : null;
  const label = stage === "dev" || stage === "hml" || stage === "prd" ? `Instância ${STAGES[stage]}` : "Instância não identificada";
  return (
    <div className={`instance-context${compact ? " is-compact" : ""}`} title={compact ? label : undefined} role="region" aria-label={regionLabel}>
      <strong>{compact ? <><span className="visually-hidden">Instância </span>{label.slice("Instância ".length)}</> : label}</strong>
      <InstanceOrigin />
    </div>
  );
}
