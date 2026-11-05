#!/usr/bin/env bash
set -euo pipefail
KUBECONFORM=true bash deploy/helm/control-plane/ci/check.sh
bash deploy/helm/data-plane/ci/check.sh
