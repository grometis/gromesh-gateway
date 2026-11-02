// Pure checks of the N2 lab runner, kept apart so each protection can be exercised without a cluster.
import { N2Lab } from "../../../scripts/kind-stack-guard.mjs";
import { verdict } from "./fixtures.mjs";

export function assertLabKubeconfig(path, home) {
  new N2Lab({ env: { LAB_KUBECONFIG: path, HOME: home } }).pathProof();
}

const sameSet = (a = [], b = []) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

// A target matches a scenario only on conclusive evidence: after the expected resolution, open = every attempt got
// the expected server's echo (or the handshake), closed = every attempt refused, timed out or was unreachable.
// A DNS failure, a stale answer or a local error matches neither.
export function conclusive(target, result, open) {
  if (!result.results) return false;
  if (target.expectAddresses && !sameSet(result.resolved, target.expectAddresses)) return false;
  return verdict({ ...target, expect: open ? "reach" : "blocked" }, result.results) === "pass";
}

// Kubernetes label selector semantics (matchLabels AND matchExpressions); an empty selector selects every pod.
export function selects(selector, labels) {
  const has = (key) => Object.hasOwn(labels, key);
  return Object.entries(selector?.matchLabels ?? {}).every(([key, value]) => labels[key] === value)
    && (selector?.matchExpressions ?? []).every(({ key, operator, values = [] }) => {
      switch (operator) {
        case "In": return has(key) && values.includes(labels[key]);
        case "NotIn": return !has(key) || !values.includes(labels[key]);
        case "Exists": return has(key);
        case "DoesNotExist": return !has(key);
        default: return false;
      }
    });
}
