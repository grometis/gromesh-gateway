#!/usr/bin/env bash
set -euo pipefail
chart=deploy/helm/control-plane
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
required=(--set-string database.existingSecret=ci-database --set-string bootstrapAdmin.existingSecret=ci-admin --set-string encryption.existingSecret=ci-encryption)
helm lint "$chart" --strict "${required[@]}"
helm template cp "$chart" "${required[@]}" > "$work/default.yaml"
helm lint "$chart" --strict -f "$chart/ci/values-full.yaml"
helm template cp "$chart" -f "$chart/ci/values-full.yaml" > "$work/full.yaml"
helm lint "$chart" --strict -f "$chart/ci/values-kind.yaml"
helm template cp "$chart" -f "$chart/ci/values-kind.yaml" > "$work/kind.yaml"
# The inline alternative must render a Secret, including on first installation.
helm template cp "$chart" --set-string database.existingSecret=ci-database --set-string encryption.existingSecret=ci-encryption \
  --set-string bootstrapAdmin.email=admin@example.test --set-string bootstrapAdmin.password=synthetic-ci-password > "$work/inline.yaml"
expect_failure() {
  local expected="$1"
  shift
  if helm template cp "$chart" "$@" > /dev/null 2> "$work/error"; then
    echo "Unexpected render success: $expected" >&2
    exit 1
  fi
  grep -Fq "$expected" "$work/error"
}
expect_failure 'database.existingSecret' --set-string bootstrapAdmin.existingSecret=ci-admin --set-string encryption.existingSecret=ci-encryption
expect_failure 'bootstrapAdmin' --set-string database.existingSecret=ci-database --set-string encryption.existingSecret=ci-encryption
expect_failure 'bootstrapAdmin' --set-string database.existingSecret=ci-database --set-string encryption.existingSecret=ci-encryption --set-string bootstrapAdmin.email=admin@example.test
expect_failure 'encryption.existingSecret' --set-string database.existingSecret=ci-database --set-string bootstrapAdmin.existingSecret=ci-admin
expect_failure 'trustProxy' "${required[@]}" --set ingress.enabled=true
for trust in uniquelocal true false loopback linklocal 0.0.0.0/0; do
  expect_failure 'trustProxy' "${required[@]}" --set ingress.enabled=true --set-string "trustProxy=$trust"
done
expect_failure 'proxy-read-timeout' -f "$chart/ci/values-full.yaml" \
  --set-string 'ingress.annotations.nginx\.ingress\.kubernetes\.io/proxy-read-timeout=15'
expect_failure 'proxy-buffering' -f "$chart/ci/values-full.yaml" \
  --set-string 'ingress.annotations.nginx\.ingress\.kubernetes\.io/proxy-buffering=on'
# Upgrades of an already bootstrapped database can omit bootstrap credentials.
helm template cp "$chart" --is-upgrade --set-string database.existingSecret=ci-database --set-string encryption.existingSecret=ci-encryption > /dev/null
echo 'Chart lint/render and rejection checks passed'
if [[ "${KUBECONFORM:-false}" == true ]]; then
  for variant in default full kind inline; do
    docker run --rm -i ghcr.io/yannh/kubeconform:v0.6.7 \
      -strict -summary -kubernetes-version 1.32.2 < "$work/$variant.yaml"
  done
fi
