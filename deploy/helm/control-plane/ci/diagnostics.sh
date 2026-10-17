#!/usr/bin/env bash
set -uo pipefail
namespace="${1:-gromesh-helm}"
output_dir="${2:-${RUNNER_TEMP:-/tmp}/kind-diagnostics}"
mkdir -p "$output_dir"

capture() {
  local file="$1"
  shift
  "$@" 2>&1 | tee "$output_dir/$file" || true
}

capture nodes.txt kubectl get nodes -o wide
capture pods.txt kubectl get pods -A -o wide
capture events.txt kubectl get events -A --sort-by=.lastTimestamp
capture resources.txt kubectl -n "$namespace" get pods,deployments,jobs,services,endpointslices -o wide
capture namespace-events.txt kubectl -n "$namespace" get events --sort-by=.lastTimestamp
capture pods-describe.txt kubectl -n "$namespace" describe pods
capture jobs-describe.txt kubectl -n "$namespace" describe jobs

# Select only names and restart status; never persist full pod specs or Secret contents.
kubectl get pods -A -o jsonpath='{range .items[*]}{.metadata.namespace}{"\t"}{.metadata.name}{"\t"}{range .status.initContainerStatuses[?(@.restartCount>0)]}{.name}{" "}{end}{range .status.containerStatuses[?(@.restartCount>0)]}{.name}{" "}{end}{range .status.ephemeralContainerStatuses[?(@.restartCount>0)]}{.name}{" "}{end}{"\n"}{end}' \
  > "$output_dir/pods-index.tsv" 2> "$output_dir/pods-index-errors.log" || true
cat "$output_dir/pods-index-errors.log"
while IFS=$'\t' read -r pod_namespace pod restarted_containers; do
  [[ -n "$pod_namespace" && -n "$pod" ]] || continue
  mkdir -p "$output_dir/logs/$pod_namespace"
  capture "logs/$pod_namespace/$pod.log" kubectl -n "$pod_namespace" logs "$pod" --all-containers --prefix
  # Query restarted containers individually: --previous for all containers can stop at one that never restarted.
  for container in $restarted_containers; do
    capture "logs/$pod_namespace/$pod.$container.previous.log" kubectl -n "$pod_namespace" logs "$pod" -c "$container" --prefix --previous
  done
done < "$output_dir/pods-index.tsv"
