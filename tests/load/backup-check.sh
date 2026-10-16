#!/usr/bin/env bash
# From repo root: tests/load/backup-check.sh
# Extra backup-specific rendering/rejection checks without changing chart CI files.
set -euo pipefail
cd "$(dirname "$0")/../.."
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
chart=deploy/helm/control-plane
values="$chart/ci/values-full.yaml"
helm template cp "$chart" -f "$values" > "$work/full.yaml"
helm template cp "$chart" -f "$values" --set backup.enabled=false > "$work/off.yaml"
if grep -q 'kind: CronJob\|kind: PersistentVolumeClaim' "$work/off.yaml"; then echo 'Disabled backup rendered resources' >&2; exit 1; fi
for required in 'kind: CronJob' 'kind: PersistentVolumeClaim' 'concurrencyPolicy: Forbid' 'runAsUser: 70' 'fsGroup: 70' 'readOnlyRootFilesystem: true' 'name: ci-database' 'key: url' 'postgres:16-alpine' 'helm.sh/resource-policy: keep'; do
  grep -Fq "$required" "$work/full.yaml"
done
for invalid in 0 -1 1.5 invalid; do
  if helm template cp "$chart" -f "$values" --set "backup.retentionDays=$invalid" > /dev/null 2> "$work/error"; then echo "Accepted invalid retention: $invalid" >&2; exit 1; fi
  grep -Fq 'backup.retentionDays' "$work/error"
done
echo 'Backup enable/disable, security, Secret and retention checks passed'
