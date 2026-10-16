#!/usr/bin/env bash
set -uo pipefail
namespace="${1:-gromesh-helm}"
kubectl get nodes -o wide || true
kubectl -n "$namespace" get pods,deployments,jobs,services,endpointslices -o wide || true
kubectl -n "$namespace" get events --sort-by=.lastTimestamp || true
kubectl -n "$namespace" describe pods || true
kubectl -n "$namespace" describe jobs || true
for pod in $(kubectl -n "$namespace" get pods -o name); do
  kubectl -n "$namespace" logs "$pod" --all-containers --prefix --tail=150 || true
  kubectl -n "$namespace" logs "$pod" --all-containers --prefix --previous --tail=100 2>/dev/null || true
done
