#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/common.sh"
require_disposable_worker || exit 78
case "${SCAN_PLATFORM:-}:$(uname -m)" in linux/amd64:x86_64|linux/arm64:aarch64) ;; *) exit 78 ;; esac
[[ "${GROMESH_BASE_SHA:-}" =~ ^[a-f0-9]{40}$ ]] || exit 78
node scripts/scan-changed-images.mjs "$GROMESH_BASE_SHA"
node /opt/gromesh/jenkins/image-pipeline.mjs candidate kong
